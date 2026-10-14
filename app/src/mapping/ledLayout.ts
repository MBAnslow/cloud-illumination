import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
} from "three";
import type { MappedLed, Vec3 } from "../state";

/**
 * Two 32×8 panels on one 512-LED chain. Each panel is a semicircular
 * arch with straight sides leaving the curve. The second arch is flipped
 * the other way up, turned a quarter turn, and lowered by the height of
 * the first so the four sides stand like the walls of a house.
 *
 * Normals point out of each arch, so the sensor hemispheres sit on the
 * outside. A thin strip on the inside blocks light.
 *
 * Each panel is the usual 8×32 matrix chain: columns run across the
 * 8-pixel width, even columns one way and odd columns back, then the
 * next step is along the 32-pixel arch.
 */
export const DUAL_32X8_SLOTTED = "dual-32x8-slotted" as const;
export const DEFAULT_LAYOUT_PITCH = 0.01;

/** Layout-space shift of one arch, in metres, applied after it is shaped. */
export interface ArchPlacement {
  x: number;
  y: number;
  z: number;
}

/**
 * Crown-down arch sits a little below the crown-up arch, so each straight
 * run clears the other arch instead of passing through it.
 */
export const DEFAULT_ARCH_PLACEMENTS: [ArchPlacement, ArchPlacement] = [
  { x: 0, y: -0.03, z: 0 },
  { x: 0, y: 0.03, z: 0 },
];

export function resolveArchPlacements(
  saved: unknown,
): [ArchPlacement, ArchPlacement] {
  const fallback = DEFAULT_ARCH_PLACEMENTS;
  const raw = Array.isArray(saved) ? saved : [];
  return [0, 1].map((panel) => {
    const item = (raw[panel] ?? {}) as Partial<ArchPlacement>;
    const axis = (value: unknown, fallbackValue: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(-0.5, Math.min(0.5, value))
        : fallbackValue;
    return {
      x: axis(item.x, fallback[panel].x),
      y: axis(item.y, fallback[panel].y),
      z: axis(item.z, fallback[panel].z),
    };
  }) as [ArchPlacement, ArchPlacement];
}

export type LedLayoutId = typeof DUAL_32X8_SLOTTED | "manual";

const COLS = 32;
const ROWS = 8;
const PER_PANEL = COLS * ROWS;
/** Rounded crown only. The sides continue straight from its ends. */
const ARCH_CURVE = Math.PI;
/** Share of the strip length in each straight side. */
const SIDE_FRACTION = 0.25;

interface ArchMetrics {
  length: number;
  side: number;
  radius: number;
  alpha: number;
  footY: number;
}

function archMetrics(pitch: number): ArchMetrics {
  const length = (COLS - 1) * pitch;
  const side = length * SIDE_FRACTION;
  const curve = length - 2 * side;
  const radius = curve / ARCH_CURVE;
  const alpha = ARCH_CURVE / 2;
  const footY = radius * (1 - Math.cos(alpha)) + side * Math.sin(alpha);
  return { length, side, radius, alpha, footY };
}

function arcPoint(theta: number, radius: number): { x: number; y: number } {
  return { x: radius * Math.sin(theta), y: radius * (1 - Math.cos(theta)) };
}

/** Unit tangent as the curve's angle increases. */
function arcTravel(theta: number): { x: number; y: number } {
  return { x: Math.cos(theta), y: Math.sin(theta) };
}

/** Outward normal, perpendicular to the direction of travel. */
function outwardOf(tx: number, ty: number): { x: number; y: number } {
  return { x: ty, y: -tx };
}

/**
 * Centreline before the panel is turned. `s` runs from one foot, along a
 * straight side, around the semicircle, and out the other straight side.
 */
function unshifted(
  s: number,
  metrics: ArchMetrics,
): { x: number; y: number; nx: number; ny: number } {
  const { side, radius, alpha, length } = metrics;
  const curveEnd = length - side;
  if (s <= side) {
    const theta = -alpha;
    const end = arcPoint(theta, radius);
    const travel = arcTravel(theta);
    const n = outwardOf(travel.x, travel.y);
    return {
      x: end.x + travel.x * (s - side),
      y: end.y + travel.y * (s - side),
      nx: n.x,
      ny: n.y,
    };
  }
  if (s >= curveEnd) {
    const theta = alpha;
    const end = arcPoint(theta, radius);
    const travel = arcTravel(theta);
    const n = outwardOf(travel.x, travel.y);
    const v = s - curveEnd;
    return {
      x: end.x + travel.x * v,
      y: end.y + travel.y * v,
      nx: n.x,
      ny: n.y,
    };
  }
  const theta = -alpha + (s - side) / radius;
  const pos = arcPoint(theta, radius);
  return { x: pos.x, y: pos.y, nx: Math.sin(theta), ny: -Math.cos(theta) };
}

/** Point and outward normal on one arch. `across` is metres across the strip. */
function archPose(
  panel: 0 | 1,
  s: number,
  across: number,
  metrics: ArchMetrics,
  placements: readonly [ArchPlacement, ArchPlacement],
): { pos: Vec3; normal: Vec3 } {
  const local = unshifted(s, metrics);
  let x = local.x;
  let y = local.y;
  let z = across;
  let nx = local.nx;
  let ny = local.ny;
  let nz = 0;
  if (panel === 0) {
    y -= metrics.footY;
  } else {
    const ox = x;
    x = z;
    z = -ox;
    const onx = nx;
    nx = nz;
    nz = -onx;
    y = -y;
    ny = -ny;
  }
  const place = placements[panel];
  return {
    pos: [x + place.x, y + place.y, z + place.z],
    normal: [nx, ny, nz],
  };
}

/**
 * Electrical index on the 512-LED chain, in the panel's own matrix.
 * `col` runs along the arch (0..31). `row` runs across the 8-pixel width.
 * Even columns step row 0→7, odd columns step back.
 */
export function dual32x8Cell(
  index: number,
): { panel: 0 | 1; col: number; row: number } | null {
  if (index < 0 || index >= PER_PANEL * 2) return null;
  const panel: 0 | 1 = index < PER_PANEL ? 0 : 1;
  const local = index - panel * PER_PANEL;
  const col = Math.floor(local / ROWS);
  const down = local % ROWS;
  const row = col % 2 === 0 ? down : ROWS - 1 - down;
  return { panel, col, row };
}

export function buildDual32x8Slotted(
  pitch: number,
  placements: readonly [ArchPlacement, ArchPlacement] = DEFAULT_ARCH_PLACEMENTS,
): MappedLed[] {
  const ledPitch = Math.max(1e-4, pitch);
  const metrics = archMetrics(ledPitch);
  const leds: MappedLed[] = [];
  for (let index = 0; index < PER_PANEL * 2; index++) {
    const cell = dual32x8Cell(index)!;
    // The second panel's chain starts at the other end of its arch.
    const col = cell.panel === 1 ? COLS - 1 - cell.col : cell.col;
    const s = (col / (COLS - 1)) * metrics.length;
    const across = (cell.row - (ROWS - 1) / 2) * ledPitch;
    const { pos, normal } = archPose(cell.panel, s, across, metrics, placements);
    leds.push({ dir: normal, pos, normal, offset: 0 });
  }
  return leds;
}

function pushQuad(
  indices: number[],
  a: number,
  b: number,
  c: number,
  d: number,
  flip: boolean,
) {
  if (flip) indices.push(a, b, c, c, b, d);
  else indices.push(a, c, b, b, c, d);
}

function faceFaces(
  positions: number[],
  a: number,
  b: number,
  c: number,
  toward: Vec3,
): boolean {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const ux = positions[b * 3] - ax;
  const uy = positions[b * 3 + 1] - ay;
  const uz = positions[b * 3 + 2] - az;
  const vx = positions[c * 3] - ax;
  const vy = positions[c * 3 + 1] - ay;
  const vz = positions[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
}

/** Thin shell on the inner face of both arches. Fully opaque to light. */
export function buildArchBackingGeometry(
  pitch: number,
  placements: readonly [ArchPlacement, ArchPlacement] = DEFAULT_ARCH_PLACEMENTS,
): BufferGeometry {
  const ledPitch = Math.max(1e-4, pitch);
  const metrics = archMetrics(ledPitch);
  const halfWidth = (ROWS * ledPitch) / 2;
  const thickness = Math.max(0.0012, ledPitch * 0.12);
  const steps = 48;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const panel of [0, 1] as const) {
    const base = positions.length / 3;
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * metrics.length;
      for (const side of [-1, 1]) {
        const { pos, normal } = archPose(
          panel,
          s,
          side * halfWidth,
          metrics,
          placements,
        );
        const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
        const nx = normal[0] / len;
        const ny = normal[1] / len;
        const nz = normal[2] / len;
        for (const inward of [0, thickness]) {
          // Sit on the inner face: opposite the outward LED normal.
          positions.push(pos[0] - nx * inward, pos[1] - ny * inward, pos[2] - nz * inward);
          normals.push(nx, ny, nz);
        }
      }
    }
    const stride = 4;
    const mid = base + Math.floor(steps / 2) * stride;
    const outward = archPose(panel, metrics.length / 2, 0, metrics, placements)
      .normal;
    // The second arch is mirrored. Without this, its faces point out
    // through the LEDs instead of sitting on their backs.
    const flip = faceFaces(positions, mid, mid + stride, mid + 2, outward);
    for (let i = 0; i < steps; i++) {
      const a = base + i * stride;
      const b = a + stride;
      pushQuad(indices, a, a + 2, b, b + 2, flip);
      pushQuad(indices, a + 1, b + 1, a + 3, b + 3, flip);
      pushQuad(indices, a, b, a + 1, b + 1, flip);
      pushQuad(indices, a + 2, a + 3, b + 2, b + 3, flip);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

export function archBackingMesh(
  pitch: number,
  placements: readonly [ArchPlacement, ArchPlacement] = DEFAULT_ARCH_PLACEMENTS,
): Mesh {
  return new Mesh(
    buildArchBackingGeometry(pitch, placements),
    new MeshBasicMaterial({ side: DoubleSide }),
  );
}
