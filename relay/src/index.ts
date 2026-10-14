import { createSocket } from "node:dgram";
import { WebSocketServer, type WebSocket } from "ws";

const WS_PORT = Number(process.env.WS_PORT ?? 7890);
/** WLED live input on this controller is E1.31, not DDP. */
const E131_PORT = 5568;
const E131_UNIVERSE_START = 1;
/** 170 RGB LEDs fill 510 channels and keep a pixel inside one universe. */
const LEDS_PER_UNIVERSE = 170;

const udp = createSocket("udp4");
udp.on("error", (err) => {
  console.error("[udp] error", err);
});

const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set<WebSocket>();

interface Session {
  host: string | null;
  seq: number;
}

const E131_CID = Buffer.alloc(16);
E131_CID.write("cloud-illum-001");
const E131_SOURCE = Buffer.alloc(64, 0);
E131_SOURCE.write("cloud-illumination");

/**
 * One E1.31 universe. `slots` is the RGB bytes for this universe only
 * (no start code). WLED reads channel 1 from the byte after the start code,
 * 170 LEDs per universe in Multiple RGB mode.
 */
function encodeE131(universe: number, slots: Buffer, seq: number): Buffer {
  const values = Buffer.concat([Buffer.from([0]), slots]);
  const dmp = Buffer.alloc(10 + values.length);
  dmp.writeUInt16BE(dmp.length, 0);
  dmp.writeUInt8(0x02, 2);
  dmp.writeUInt8(0xa1, 3);
  dmp.writeUInt16BE(0, 4);
  dmp.writeUInt16BE(1, 6);
  dmp.writeUInt16BE(values.length, 8);
  values.copy(dmp, 10);

  const frameBody = Buffer.alloc(75);
  frameBody.writeUInt32BE(0x00000002, 0);
  E131_SOURCE.copy(frameBody, 4);
  frameBody.writeUInt8(100, 68);
  frameBody.writeUInt16BE(0, 69);
  frameBody.writeUInt8(seq, 71);
  frameBody.writeUInt8(0, 72);
  frameBody.writeUInt16BE(universe, 73);

  const frame = Buffer.concat([
    Buffer.alloc(2),
    frameBody,
    dmp,
  ]);
  frame.writeUInt16BE(frame.length, 0);

  const root = Buffer.concat([
    Buffer.alloc(2),
    Buffer.from([0, 0, 0, 4]),
    E131_CID,
    frame,
  ]);
  root.writeUInt16BE(root.length, 0);

  const preamble = Buffer.alloc(16);
  preamble.writeUInt16BE(0x0010, 0);
  preamble.writeUInt16BE(0, 2);
  preamble.write("ASC-E1.17", 4);
  return Buffer.concat([preamble, root]);
}

function isControlMessage(data: unknown): data is {
  type: "target";
  host: string;
  port?: number;
} {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "target" &&
    typeof (data as { host?: unknown }).host === "string"
  );
}

interface LoggedSession extends Session {
  framesForwarded: number;
  framesDropped: number;
  loggedFirstPacket: boolean;
  lastLog: number;
}

wss.on("connection", (ws: WebSocket) => {
  clients.add(ws);
  const session: LoggedSession = {
    host: null,
    seq: 1,
    framesForwarded: 0,
    framesDropped: 0,
    loggedFirstPacket: false,
    lastLog: 0,
  };
  console.log(`[ws] client connected (${clients.size} total)`);
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) {
      try {
        const text =
          raw instanceof Buffer
            ? raw.toString("utf8")
            : Buffer.from(raw as ArrayBuffer).toString("utf8");
        const msg = JSON.parse(text);
        if (isControlMessage(msg)) {
          session.host = msg.host;
          session.loggedFirstPacket = false;
          console.log(`[wled] target -> ${session.host} (E1.31 :${E131_PORT})`);
        }
      } catch (err) {
        console.warn("[ws] bad control message", err);
      }
      return;
    }

    if (!session.host) {
      session.framesDropped++;
      return;
    }
    const payload =
      raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
    const ledCount = Math.floor(payload.length / 3);
    const seq = session.seq;
    session.seq = (session.seq % 255) + 1;
    const universes = Math.max(1, Math.ceil(ledCount / LEDS_PER_UNIVERSE));
    let sendError: Error | null = null;
    for (let u = 0; u < universes; u++) {
      const start = u * LEDS_PER_UNIVERSE * 3;
      const slots = payload.subarray(
        start,
        Math.min(payload.length, start + LEDS_PER_UNIVERSE * 3),
      );
      const pkt = encodeE131(E131_UNIVERSE_START + u, slots, seq);
      udp.send(pkt, 0, pkt.length, E131_PORT, session.host, (err) => {
        if (err && !sendError) {
          sendError = err;
          console.error(
            `[wled] udp send error to ${session.host}:${E131_PORT} — ${err.message}`,
          );
        }
      });
    }
    if (!sendError) {
      session.framesForwarded++;
      if (!session.loggedFirstPacket) {
        session.loggedFirstPacket = true;
        console.log(
          `[wled] first E1.31 frame → ${session.host}:${E131_PORT} (${ledCount} LEDs, ${universes} universes)`,
        );
      }
      const now = Date.now();
      if (now - session.lastLog > 2000) {
        console.log(
          `[wled] ${session.framesForwarded} frames forwarded, ${session.framesDropped} dropped`,
        );
        session.lastLog = now;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected (${clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("[ws] error", err);
  });
});

wss.on("listening", () => {
  console.log(`[ws] relay listening on ws://localhost:${WS_PORT}`);
});

wss.on("error", (err) => {
  console.error("[ws] server error", err);
});

udp.bind(0, () => {
  const addr = udp.address();
  console.log(
    `[wled] outbound E1.31 ready (local udp ${typeof addr === "string" ? addr : addr.port})`,
  );
});

const shutdown = () => {
  console.log("[relay] shutting down");
  wss.close();
  udp.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
