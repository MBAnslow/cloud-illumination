# Cloud Illumination

LED mapping, day/night cycles, and lighting effects for the inside of
clouds. This repo is only that: placing LEDs on a cloud, running a sky
cycle and lightning across them, and streaming the result to the physical
strips. It does not include sound, synth, or breath.

Each LED is a light sensor on an uploaded cloud mesh. It samples the
simulated sky (sun, moon, ambient) and lightning, and those colours are
streamed to a [WLED](https://kno.wled.ge/) controller over E1.31 through a
small local Node relay.

Extracted from [cloudfulness](https://github.com/MBAnslow/cloudfulness).

```
browser app ──WebSocket──▶ relay ──E1.31/UDP──▶ WLED
(sim + mapping)                                (LEDs)
```

## Pages

- **Simulator** (`#/`) shows the cloud and its LEDs in 3D and computes each
  LED's colour from the 24-hour sky cycle plus lightning. Footer panels:
  Cloud, Time of day, Lightning, Stream RGB. The sky timeline at the top
  owns the sun / moon / ambient colour stops and the lightning window.
- **LED mapping** (`#/mapping`) uploads the cloud mesh (`.glb` / `.gltf`)
  and shapes it with Gaussian domes ("bumps"). The strand defaults to two
  separate 32×8 panels (512 LEDs), bent into arches with the feet
  drawn in, one hanging down and the other flipped up so the crowns
  cross. Manual
  placement is still in the layout menu.

All settings autosave to `localStorage` and can be saved to / loaded from a
YAML file. Uploaded meshes and sprite images live in IndexedDB.

`app/cloud-covering.glb` and `app/pyramid-walled.glb` are example meshes.

## Layout

```
app/src/
  mapping/    LED placement, mesh loading, Gaussian bumps, baked surface
  lighting/   per-LED shading, sky cycle, lightning, LED colour encoding
  scene/      R3F scene: cloud, LEDs, lights, sky dome, bolts
  components/ overlay panels
  state.ts    zustand store + snapshot resolve/migrate
  wled/       WebSocket client to the relay
relay/        WebSocket → E1.31 relay (port 7890)
```

## Install & run

Requires Node.js 20+ and a WLED controller on the LAN with E1.31 live input enabled.

```bash
npm install
npm run dev
```

This starts Vite (http://localhost:5173) and the relay
(`ws://localhost:7890`). Toggle **WLED → Stream** in the top bar and set
the controller's host to start streaming.
