import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import {
  BufferGeometry,
  Color,
  Euler,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Raycaster,
  Vector3,
} from "three";
import { applyMappingOrientationPoint } from "../mapping/geometry";
import {
  archLayoutBounds,
  archBackingMesh,
  DUAL_32X8_SLOTTED,
} from "../mapping/ledLayout";
import {
  displaceLed,
  gaussianRayTransmission,
  orientGaussians,
} from "../mapping/gaussians";
import {
  getMeshHalfExtents,
  loadMeshGeometry,
  sampleMeshSurfacePoint,
} from "../mapping/meshAsset";
import {
  alignMarkerNormal,
  applyMarkerInstanceEmissive,
  MARKER_MATERIAL_DEFAULTS,
  markerRadius,
  markerSphereArgs,
} from "../mapping/markerVisual";
import {
  hexToVec3,
  shadeLeds,
  spreadToSpotAngle,
  type ShadeLight,
} from "../lighting/shade";
import { activeWindowProgress, hourInRange, useSimStore } from "../state";
import { computeSkyLighting } from "../lighting/skyCycle";
import {
  LIGHTNING_REFERENCE_RADIUS,
  sharedLightningController,
} from "../lighting/lightning";
import { WledStreamClient } from "../wled/client";
import { publishFrame, publishLedPositions } from "../stream/frameBuffer";
import {
  encodeLedRgb,
  srgbByteToLinear,
} from "../lighting/ledColor";

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
const STREAM_BYTE_DEADBAND = 1;

function rotateY(v: [number, number, number], radians: number): [number, number, number] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

function rotateX(v: [number, number, number], radians: number): [number, number, number] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

function rotateCloud(
  v: [number, number, number],
  tiltRad: number,
  yawRad: number,
): [number, number, number] {
  // Match three.js default Euler order "XYZ" used by the Ellipsoid mesh
  // (composed matrix Rx * Ry * Rz → yaw applied first, then tilt).
  return rotateX(rotateY(v, yawRad), tiltRad);
}

function offsetXZ(v: [number, number, number], x: number, z: number): [number, number, number] {
  return [v[0] + x, v[1], v[2] + z];
}

export function Leds() {
  const ellipsoid = useSimStore((s) => s.ellipsoid);
  const cloud = useSimStore((s) => s.cloud);
  const cloudTop = useSimStore((s) => s.cloudTop);
  const strand = useSimStore((s) => s.strand);
  const mapping = useSimStore((s) => s.mapping);
  const meshTarget = useSimStore((s) => s.mesh);
  const ambient = useSimStore((s) => s.ambient);
  const sky = useSimStore((s) => s.sky);
  const lightning = useSimStore((s) => s.lightning);
  const ledDisplayMode = useSimStore((s) => s.ledDisplayMode);
  const ledStreamPipeline = useSimStore((s) => s.ledStreamPipeline);
  const ledLocator = useSimStore((s) => s.ledLocator);
  const toggleLocatedLed = useSimStore((s) => s.toggleLocatedLed);
  const wled = useSimStore((s) => s.wled);
  const cloudTiltRad = (cloud.rotationXDeg * Math.PI) / 180;
  const cloudYawRad = (cloud.rotationYDeg * Math.PI) / 180;
  const MANUAL_BLEND_WHEN_SKY = 0.2;

  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tmpColor = useMemo(() => new Color(), []);
  const boltSurfacePoint = useMemo(() => new Vector3(), []);
  const stableBytesRef = useRef<Uint8Array | null>(null);
  const locatedSet = useMemo(
    () => new Set(ledLocator.highlighted),
    [ledLocator.highlighted],
  );

  // LED positions come exclusively from the mapping app.
  const ledCount = mapping.leds.length;

  // Per-LED buffers. Reallocated when the LED count changes.
  const buffers = useMemo(() => {
    const n = ledCount;
    return {
      n,
      positions: new Float32Array(n * 3),
      normals: new Float32Array(n * 3),
      localPositions: new Float32Array(n * 3),
      localNormals: new Float32Array(n * 3),
      sunTransmission: new Float32Array(n),
      moonTransmission: new Float32Array(n),
      validPositions: new Uint8Array(n),
      colorFloats: new Float32Array(n * 3),
      timeColorFloats: new Float32Array(n * 3),
      lightningColorFloats: new Float32Array(n * 3),
      colorBytes: new Uint8Array(n * 3),
    };
  }, [ledCount]);

  const positionsVersionRef = useRef(0);
  // Mesh transform used to convert stored mesh-local LED coords into
  // world coords. Kept identical to the mapping app's mesh transform.
  const meshMatrix = useMemo(() => {
    const q = new Quaternion().setFromEuler(
      new Euler(
        (meshTarget.tiltDeg * Math.PI) / 180,
        (meshTarget.yawDeg * Math.PI) / 180,
        0,
        "XYZ",
      ),
    );
    return new Matrix4().compose(
      new Vector3(0, meshTarget.offsetY, 0),
      q,
      new Vector3(meshTarget.scale, meshTarget.scale, meshTarget.scale),
    );
  }, [meshTarget.scale, meshTarget.offsetY, meshTarget.yawDeg, meshTarget.tiltDeg]);
  const meshNormalMat = useMemo(
    () => new Matrix3().getNormalMatrix(meshMatrix),
    [meshMatrix],
  );
  const orientedGaussians = useMemo(
    () =>
      orientGaussians(
        mapping.gaussians ?? [],
        mapping.flipUpDown,
        mapping.flipLeftRight,
        applyMappingOrientationPoint,
      ),
    [
      mapping.gaussians,
      mapping.flipUpDown,
      mapping.flipLeftRight,
    ],
  );
  const worldToBumpLocal = useMemo(() => {
    const cloudQ = new Quaternion().setFromEuler(
      new Euler(cloudTiltRad, cloudYawRad, 0, "XYZ"),
    );
    const cloudMatrix = new Matrix4().compose(
      new Vector3(cloud.offsetX, cloud.offsetY, cloud.offsetZ),
      cloudQ,
      new Vector3(1, 1, 1),
    );
    return cloudMatrix.multiply(meshMatrix.clone()).invert();
  }, [
    cloudTiltRad,
    cloudYawRad,
    cloud.offsetX,
    cloud.offsetY,
    cloud.offsetZ,
    meshMatrix,
  ]);

  useEffect(() => {
    for (let i = 0; i < buffers.n; i++) {
      // `i` is the logical strand index; map it to the placement index so
      // the reverse toggle flips which physical end is LED #0.
      const physical = mapping.reversed ? buffers.n - 1 - i : i;
      const led = mapping.leds[physical];
      const hasPosition = !!led.pos;
      buffers.validPositions[i] = hasPosition ? 1 : 0;
      // LEDs without a mesh-mode record contribute an origin dummy (0,0,0)
      // so they still count in the strand but have no visible position.
      const rawPos: [number, number, number] = led.pos
        ? [led.pos[0], led.pos[1], led.pos[2]]
        : [0, 0, 0];
      const rawNrm: [number, number, number] = led.normal
        ? [led.normal[0], led.normal[1], led.normal[2]]
        : [0, 1, 0];
      let lp = applyMappingOrientationPoint(
        rawPos,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      const baseLn = applyMappingOrientationPoint(
        rawNrm,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      // Match LED Mapping: orientation first, then dome/per-LED displacement.
      const displaced = displaceLed(
        lp,
        baseLn,
        orientedGaussians,
        led.offset ?? 0,
        mapping.bumpAdditivity,
      );
      lp = displaced.pos;
      let ln = displaced.normal;
      // Keep displaced normals on the same hemisphere as the mapped surface
      // normal rather than inferring "outward" from world origin.
      ln = alignMarkerNormal(ln, baseLn);
      // Transform the stored mesh-local point + normal by the current
      // mesh transform so LEDs stay attached to the surface as the
      // scale/rotation/offset sliders change.
      const wpV = new Vector3(lp[0], lp[1], lp[2]).applyMatrix4(meshMatrix);
      const wnV = new Vector3(ln[0], ln[1], ln[2])
        .applyMatrix3(meshNormalMat)
        .normalize();
      const pos: [number, number, number] = [wpV.x, wpV.y, wpV.z];
      const nrm = [wnV.x, wnV.y, wnV.z] as [number, number, number];
      const rPos = offsetXZ(
        rotateCloud(pos, cloudTiltRad, cloudYawRad),
        cloud.offsetX,
        cloud.offsetZ,
      );
      const rNrm = rotateCloud(nrm, cloudTiltRad, cloudYawRad);
      const i3 = i * 3;
      buffers.localPositions[i3] = lp[0];
      buffers.localPositions[i3 + 1] = lp[1];
      buffers.localPositions[i3 + 2] = lp[2];
      buffers.localNormals[i3] = ln[0];
      buffers.localNormals[i3 + 1] = ln[1];
      buffers.localNormals[i3 + 2] = ln[2];
      buffers.positions[i3] = rPos[0];
      buffers.positions[i3 + 1] = rPos[1] + cloud.offsetY;
      buffers.positions[i3 + 2] = rPos[2];
      buffers.normals[i3] = rNrm[0];
      buffers.normals[i3 + 1] = rNrm[1];
      buffers.normals[i3 + 2] = rNrm[2];
    }

    const mesh = meshRef.current;
    if (mesh) {
      const markerKind = ledDisplayMode === "sensors" ? "sensor" : "led";
      const radius = markerRadius(
        markerKind,
        mapping.ledSize,
        strand.ledSize,
      );
      const yAxis = new Vector3(0, 1, 0);
      const normalVec = new Vector3();
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        if (!buffers.validPositions[i]) {
          dummy.position.set(0, 0, 0);
          dummy.quaternion.identity();
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          continue;
        }
        const nx = buffers.normals[i3];
        const ny = buffers.normals[i3 + 1];
        const nz = buffers.normals[i3 + 2];
        dummy.position.set(
          buffers.positions[i3],
          buffers.positions[i3 + 1],
          buffers.positions[i3 + 2],
        );
        {
          normalVec.set(nx, ny, nz);
          dummy.quaternion.setFromUnitVectors(yAxis, normalVec);
        }
        dummy.scale.setScalar(radius);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = buffers.n;
    }
    positionsVersionRef.current += 1;
    publishLedPositions(
      buffers.positions,
      buffers.normals,
      buffers.n,
      buffers.validPositions,
    );
  }, [
    ellipsoid.rx,
    ellipsoid.ry,
    ellipsoid.rz,
    strand.ledSize,
    mapping.ledSize,
    mapping.leds,
    mapping.gaussians,
    mapping.bumpAdditivity,
    mapping.flipUpDown,
    mapping.flipLeftRight,
    mapping.reversed,
    orientedGaussians,
    cloudTiltRad,
    cloudYawRad,
    cloud.offsetX,
    cloud.offsetY,
    cloud.offsetZ,
    ledDisplayMode,
    meshMatrix,
    meshNormalMat,
    buffers,
    dummy,
  ]);

  // Cached mesh half-extents (bounding-box), used to constrain lightning
  // bolt endpoints to the actual cloud mesh volume rather than the legacy
  // ellipsoid params (which no longer describe the visible cloud once a
  // user mesh is loaded).
  const meshHalfExtentsRef = useRef<{ hx: number; hy: number; hz: number } | null>(null);
  const [meshGeom, setMeshGeom] = useState<BufferGeometry | null>(null);
  useEffect(() => {
    const id = meshTarget.id;
    if (!id) {
      meshHalfExtentsRef.current = null;
      setMeshGeom(null);
      return;
    }
    const cached = getMeshHalfExtents(id);
    if (cached) {
      meshHalfExtentsRef.current = cached;
    }
    let cancelled = false;
    loadMeshGeometry(id).then((g) => {
      if (cancelled) return;
      setMeshGeom(g);
      meshHalfExtentsRef.current = getMeshHalfExtents(id);
    });
    return () => {
      cancelled = true;
    };
  }, [meshTarget.id]);
  const meshOccluder = useMemo(() => (meshGeom ? new Mesh(meshGeom) : null), [meshGeom]);
  // Bolt and sprite volume follows the arches, in the same scaled layout
  // space the LEDs use before the cloud rotation. `fit` shrinks the
  // metre-based glow to that smaller structure.
  const archLightning = useMemo(() => {
    if (mapping.layout !== DUAL_32X8_SLOTTED) return null;
    const bounds = archLayoutBounds(mapping.layoutPitch, mapping.archPlacements);
    const flipped = applyMappingOrientationPoint(
      bounds.center,
      mapping.flipUpDown,
      mapping.flipLeftRight,
    );
    const scale = meshTarget.scale;
    const absScale = Math.abs(scale);
    const rx = Math.max(1e-3, bounds.half[0] * absScale);
    const ry = Math.max(1e-3, bounds.half[1] * absScale);
    const rz = Math.max(1e-3, bounds.half[2] * absScale);
    const mean = (rx + ry + rz) / 3;
    return {
      center: [flipped[0] * scale, flipped[1] * scale, flipped[2] * scale] as [
        number,
        number,
        number,
      ],
      ellipsoid: { rx, ry, rz },
      fit: mean / LIGHTNING_REFERENCE_RADIUS,
    };
  }, [
    mapping.layout,
    mapping.layoutPitch,
    mapping.archPlacements,
    mapping.flipUpDown,
    mapping.flipLeftRight,
    meshTarget.scale,
  ]);
  const archOccluder = useMemo(() => {
    if (mapping.layout !== DUAL_32X8_SLOTTED) return null;
    const mesh = archBackingMesh(mapping.layoutPitch, mapping.archPlacements);
    mesh.scale.set(
      mapping.flipLeftRight ? -1 : 1,
      mapping.flipUpDown ? -1 : 1,
      1,
    );
    mesh.updateMatrixWorld(true);
    return mesh;
  }, [
    mapping.layout,
    mapping.layoutPitch,
    mapping.archPlacements,
    mapping.flipLeftRight,
    mapping.flipUpDown,
  ]);
  useEffect(() => {
    return () => {
      const material = archOccluder?.material;
      archOccluder?.geometry.dispose();
      if (material && !Array.isArray(material)) material.dispose();
    };
  }, [archOccluder]);
  const pyramidRaycaster = useMemo(() => new Raycaster(), []);
  const pyramidRayOrigin = useMemo(() => new Vector3(), []);
  const pyramidRayDir = useMemo(() => new Vector3(), []);
  const pyramidHitsRef = useRef<any[]>([]);

  // Long-lived WLED streaming client. Lightning uses a shared controller
  // so the 3D bolt visualisation sees the same active strikes.
  const lightningCtrl = sharedLightningController;
  const lightningRenderRef = useRef(0);
  const wledClient = useMemo(() => new WledStreamClient(), []);
  useEffect(() => {
    if (wled.enabled) wledClient.start();
    else wledClient.stop();
    return () => wledClient.stop();
  }, [wled.enabled, wledClient]);
  useEffect(() => {
    wledClient.setTarget(wled.host, 4048);
  }, [wled.host, wledClient]);

  // Ensure the instance color attribute exists before the first frame.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (!mesh.instanceColor || mesh.instanceColor.count !== buffers.n) {
      const init = new Float32Array(buffers.n * 3);
      const attr = new InstancedBufferAttribute(init, 3);
      attr.setUsage(DynamicDrawUsage);
      mesh.instanceColor = attr;
    }
  }, [buffers.n]);

  // Per-frame: shade and push colors to GPU + WLED.
  const lastSendRef = useRef(0);
  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const skyLighting = computeSkyLighting(sky);
    if (
      (mapping.bumpLightOpacity > 0 && orientedGaussians.length > 0) ||
      mapping.pyramidLightOpacity > 0 ||
      archOccluder
    ) {
      const orbitRadiusX = Math.max(0, sky.orbitRadiusX ?? sky.orbitRadius ?? 12);
      const orbitRadiusY = Math.max(0, sky.orbitRadiusY ?? sky.orbitRadius ?? 12);
      const orbitRadiusZ = Math.max(0, sky.orbitRadiusZ ?? sky.orbitRadius ?? 12);
      const cloudCenterWorld: [number, number, number] = [
        cloud.offsetX,
        cloud.offsetY + meshTarget.offsetY,
        cloud.offsetZ,
      ];
      const sunWorld: [number, number, number] = [
        cloudCenterWorld[0] + skyLighting.sunDirection[0] * orbitRadiusX,
        cloudCenterWorld[1] + skyLighting.sunDirection[1] * orbitRadiusY,
        cloudCenterWorld[2] + skyLighting.sunDirection[2] * orbitRadiusZ,
      ];
      const moonWorld: [number, number, number] = [
        cloudCenterWorld[0] + skyLighting.moonDirection[0] * orbitRadiusX,
        cloudCenterWorld[1] + skyLighting.moonDirection[1] * orbitRadiusY,
        cloudCenterWorld[2] + skyLighting.moonDirection[2] * orbitRadiusZ,
      ];
      const sunLocalPointV = new Vector3(...sunWorld).applyMatrix4(worldToBumpLocal);
      const moonLocalPointV = new Vector3(...moonWorld).applyMatrix4(worldToBumpLocal);
      const sunLocalPoint: [number, number, number] = [
        sunLocalPointV.x,
        sunLocalPointV.y,
        sunLocalPointV.z,
      ];
      const moonLocalPoint: [number, number, number] = [
        moonLocalPointV.x,
        moonLocalPointV.y,
        moonLocalPointV.z,
      ];
      const pyramidBlocked =
        1 - Math.max(0, Math.min(1, mapping.pyramidLightOpacity));
      for (let i = 0; i < buffers.n; i++) {
        if (!buffers.validPositions[i]) {
          buffers.sunTransmission[i] = 1;
          buffers.moonTransmission[i] = 1;
          continue;
        }
        const i3 = i * 3;
        const origin: [number, number, number] = [
          buffers.localPositions[i3],
          buffers.localPositions[i3 + 1],
          buffers.localPositions[i3 + 2],
        ];
        const originNormal: [number, number, number] = [
          buffers.localNormals[i3],
          buffers.localNormals[i3 + 1],
          buffers.localNormals[i3 + 2],
        ];
        const sunToLight: [number, number, number] = [
          sunLocalPoint[0] - origin[0],
          sunLocalPoint[1] - origin[1],
          sunLocalPoint[2] - origin[2],
        ];
        const moonToLight: [number, number, number] = [
          moonLocalPoint[0] - origin[0],
          moonLocalPoint[1] - origin[1],
          moonLocalPoint[2] - origin[2],
        ];
        let sunPyramidTransmission = 1;
        let moonPyramidTransmission = 1;
        const sunFacing =
          originNormal[0] * sunToLight[0] +
            originNormal[1] * sunToLight[1] +
            originNormal[2] * sunToLight[2] >
          0;
        const moonFacing =
          originNormal[0] * moonToLight[0] +
            originNormal[1] * moonToLight[1] +
            originNormal[2] * moonToLight[2] >
          0;
        if (!sunFacing) sunPyramidTransmission = pyramidBlocked;
        if (!moonFacing) moonPyramidTransmission = pyramidBlocked;
        if (mapping.pyramidLightOpacity > 0 && meshOccluder) {
          const localSensorRadius =
            strand.ledSize / Math.max(1e-6, Math.abs(meshTarget.scale));
          const rayOrigin = pyramidRayOrigin.set(
            origin[0] + originNormal[0] * localSensorRadius,
            origin[1] + originNormal[1] * localSensorRadius,
            origin[2] + originNormal[2] * localSensorRadius,
          );
          const hits = pyramidHitsRef.current;
          pyramidRaycaster.near = 0;
          pyramidRayDir.set(sunToLight[0], sunToLight[1], sunToLight[2]);
          const sunDistance = pyramidRayDir.length();
          pyramidRaycaster.far = Math.max(1e-4, sunDistance - 1e-4);
          pyramidRayDir.normalize();
          pyramidRaycaster.set(rayOrigin, pyramidRayDir);
          hits.length = 0;
          if (pyramidRaycaster.intersectObject(meshOccluder, false, hits).length > 0) {
            sunPyramidTransmission = Math.min(sunPyramidTransmission, pyramidBlocked);
          }
          pyramidRayDir.set(moonToLight[0], moonToLight[1], moonToLight[2]);
          const moonDistance = pyramidRayDir.length();
          pyramidRaycaster.far = Math.max(1e-4, moonDistance - 1e-4);
          pyramidRayDir.normalize();
          pyramidRaycaster.set(rayOrigin, pyramidRayDir);
          hits.length = 0;
          if (pyramidRaycaster.intersectObject(meshOccluder, false, hits).length > 0) {
            moonPyramidTransmission = Math.min(moonPyramidTransmission, pyramidBlocked);
          }
        }
        if (archOccluder) {
          const localSensorRadius =
            strand.ledSize / Math.max(1e-6, Math.abs(meshTarget.scale));
          const rayOrigin = pyramidRayOrigin.set(
            origin[0] + originNormal[0] * localSensorRadius,
            origin[1] + originNormal[1] * localSensorRadius,
            origin[2] + originNormal[2] * localSensorRadius,
          );
          const hits = pyramidHitsRef.current;
          pyramidRaycaster.near = 0;
          pyramidRayDir.set(sunToLight[0], sunToLight[1], sunToLight[2]);
          const sunDistance = pyramidRayDir.length();
          pyramidRaycaster.far = Math.max(1e-4, sunDistance - 1e-4);
          pyramidRayDir.normalize();
          pyramidRaycaster.set(rayOrigin, pyramidRayDir);
          hits.length = 0;
          if (pyramidRaycaster.intersectObject(archOccluder, false, hits).length > 0) {
            sunPyramidTransmission = 0;
          }
          pyramidRayDir.set(moonToLight[0], moonToLight[1], moonToLight[2]);
          const moonDistance = pyramidRayDir.length();
          pyramidRaycaster.far = Math.max(1e-4, moonDistance - 1e-4);
          pyramidRayDir.normalize();
          pyramidRaycaster.set(rayOrigin, pyramidRayDir);
          hits.length = 0;
          if (pyramidRaycaster.intersectObject(archOccluder, false, hits).length > 0) {
            moonPyramidTransmission = 0;
          }
        }
        const sunDomeTransmission =
          mapping.bumpLightOpacity > 0 && orientedGaussians.length > 0
            ? gaussianRayTransmission(
                origin,
                sunToLight,
                Math.hypot(...sunToLight),
                orientedGaussians,
                mapping.bumpLightOpacity,
                originNormal,
              )
            : 1;
        const moonDomeTransmission =
          mapping.bumpLightOpacity > 0 && orientedGaussians.length > 0
            ? gaussianRayTransmission(
                origin,
                moonToLight,
                Math.hypot(...moonToLight),
                orientedGaussians,
                mapping.bumpLightOpacity,
                originNormal,
              )
            : 1;
        buffers.sunTransmission[i] = sunDomeTransmission * sunPyramidTransmission;
        buffers.moonTransmission[i] = moonDomeTransmission * moonPyramidTransmission;
      }
    } else {
      buffers.sunTransmission.fill(1);
      buffers.moonTransmission.fill(1);
    }
    const skyAmount = clamp01(sky.visualizationAmount ?? 1);
    const manualBlend = sky.enabled
      ? 1 - (1 - MANUAL_BLEND_WHEN_SKY) * skyAmount
      : 1;

    const useTimePipeline =
      ledStreamPipeline.timeOfDayStage;

    if (useTimePipeline) {
      // Pipeline A: time-of-day lighting.
      const timeLights: ShadeLight[] = [
        {
          type: "ambient",
          color: hexToVec3(ambient.color),
          intensity: ambient.intensity * manualBlend,
        },
      ];
      if (sky.enabled) {
        const orbitRadiusX = Math.max(0, sky.orbitRadiusX ?? sky.orbitRadius ?? 12);
        const orbitRadiusY = Math.max(0, sky.orbitRadiusY ?? sky.orbitRadius ?? 12);
        const orbitRadiusZ = Math.max(0, sky.orbitRadiusZ ?? sky.orbitRadius ?? 12);
        const cloudCenter: [number, number, number] = [
          cloud.offsetX,
          cloud.offsetY + meshTarget.offsetY,
          cloud.offsetZ,
        ];
        timeLights.push(
          {
            type: "hemisphere",
            skyColor: hexToVec3(skyLighting.skyColor),
            groundColor: hexToVec3(skyLighting.groundColor),
            intensity: skyLighting.hemiIntensity,
          },
          {
            type: "point",
            position: [
              cloudCenter[0] + skyLighting.sunDirection[0] * orbitRadiusX,
              cloudCenter[1] + skyLighting.sunDirection[1] * orbitRadiusY,
              cloudCenter[2] + skyLighting.sunDirection[2] * orbitRadiusZ,
            ],
            color: hexToVec3(skyLighting.sunColor),
            intensity: skyLighting.sunIntensity,
            decay: Math.max(0, sky.lightDecay ?? 1),
            distance: 0,
            spread: clamp01(sky.sunSpread ?? 0.9),
            target: cloudCenter,
            coneAngle: spreadToSpotAngle(sky.sunSpread ?? 0.9),
            penumbra: clamp01(sky.sunBeamFocus ?? 0.65),
            topHighlightBoost: Math.max(0, sky.sunTopHighlightBoost ?? 0),
            topHighlightFactor: clamp01(
              1 - Math.abs(skyLighting.sunDirection[1]) / 0.65,
            ),
            transmission: buffers.sunTransmission,
          },
          {
            type: "point",
            position: [
              cloudCenter[0] + skyLighting.moonDirection[0] * orbitRadiusX,
              cloudCenter[1] + skyLighting.moonDirection[1] * orbitRadiusY,
              cloudCenter[2] + skyLighting.moonDirection[2] * orbitRadiusZ,
            ],
            color: hexToVec3(skyLighting.moonColor),
            intensity: skyLighting.moonIntensity,
            decay: Math.max(0, sky.lightDecay ?? 1),
            distance: 0,
            spread: clamp01(sky.moonSpread ?? 0.9),
            target: cloudCenter,
            coneAngle: spreadToSpotAngle(sky.moonSpread ?? 0.9),
            penumbra: clamp01(sky.moonBeamFocus ?? 0.65),
            transmission: buffers.moonTransmission,
          },
        );
      }
      shadeLeds(
        buffers.positions,
        buffers.normals,
        buffers.n,
        timeLights,
        cloud.opacity,
        buffers.colorBytes,
        buffers.timeColorFloats,
        {
          hemisphereAverage: true,
          hemisphereFocusExponent: Math.max(0, strand.sensorHemisphereFocus),
          ambientDucking: ambient.ducking ?? 0.75,
        },
      );
    } else {
      buffers.timeColorFloats.fill(0);
    }

    // Strike scheduler runs whenever lightning is enabled and in its
    // active hour window — independent of view mode / pipeline stage —
    // so Strikes/min and the 3D bolt viz keep working even when LEDs
    // aren't taking the lightning contribution this frame.
    const lightningActive =
      lightning.enabled &&
      hourInRange(
        sky.timeHours,
        lightning.activeStartHour,
        lightning.activeEndHour,
      );
    const hasActiveLightning =
      lightningCtrl.getStrikes().length > 0 ||
      lightningCtrl.getSprites().length > 0;
    const lightningTick =
      lightningActive ||
      lightningCtrl.hasManualTriggers() ||
      hasActiveLightning;

    if (lightningTick) {
      // Strike spawn rate is always real wall-clock time (strikes per
      // real minute), independent of sky play speed and of simFps.
      // simFps only throttles the LED contribution / strobe look.
      const now = performance.now();
      const meshTiltRad = (meshTarget.tiltDeg * Math.PI) / 180;
      const meshYawRad = (meshTarget.yawDeg * Math.PI) / 180;
      const cloudXform = {
        tiltRad: cloudTiltRad + meshTiltRad,
        yawRad: cloudYawRad + meshYawRad,
        offsetX: cloud.offsetX,
        offsetY: cloud.offsetY + meshTarget.offsetY,
        offsetZ: cloud.offsetZ,
      };
      const half = meshHalfExtentsRef.current;
      const meshEllipsoid = half
        ? {
            rx: Math.max(1e-3, half.hx * meshTarget.scale * 0.9),
            ry: Math.max(1e-3, half.hy * meshTarget.scale * 0.9),
            rz: Math.max(1e-3, half.hz * meshTarget.scale * 0.9),
          }
        : ellipsoid;
      let boltEllipsoid = meshEllipsoid;
      let boltXform = cloudXform;
      let boltLightning = lightning;
      if (archLightning) {
        boltEllipsoid = archLightning.ellipsoid;
        const shifted = rotateCloud(
          archLightning.center,
          cloudXform.tiltRad,
          cloudXform.yawRad,
        );
        boltXform = {
          ...cloudXform,
          offsetX: cloudXform.offsetX + shifted[0],
          offsetY: cloudXform.offsetY + shifted[1],
          offsetZ: cloudXform.offsetZ + shifted[2],
        };
        boltLightning = {
          ...lightning,
          falloffDistance: lightning.falloffDistance * archLightning.fit,
        };
      }
      const keyframeU = activeWindowProgress(
        sky.timeHours,
        lightning.activeStartHour,
        lightning.activeEndHour,
      );
      const sampleBoltSurface =
        archLightning || !meshTarget.id
          ? undefined
          : (): [number, number, number] | null => {
              if (!sampleMeshSurfacePoint(meshTarget.id!, boltSurfacePoint)) {
                return null;
              }
              return [
                boltSurfacePoint.x * meshTarget.scale,
                boltSurfacePoint.y * meshTarget.scale,
                boltSurfacePoint.z * meshTarget.scale,
              ];
            };
      lightningCtrl.update(
        now,
        boltLightning,
        boltEllipsoid,
        boltXform,
        keyframeU,
        sampleBoltSurface,
      );
      const useLightning =
        (lightningActive ||
          lightningCtrl.getStrikes().length > 0 ||
          lightningCtrl.getSprites().length > 0) &&
        ledStreamPipeline.lightningStage;

      const fps = Math.max(1, Math.min(60, Math.round(lightning.simFps || 60)));
      const frameMs = 1000 / fps;
      const lastRender = lightningRenderRef.current;
      if (now - lastRender >= frameMs) {
        lightningRenderRef.current = now;
        if (useLightning) {
          lightningCtrl.contribute(
            buffers.positions,
            buffers.n,
            buffers.lightningColorFloats,
            now,
            boltLightning,
            boltEllipsoid,
            boltXform,
          );
        } else {
          buffers.lightningColorFloats.fill(0);
        }
      }
      // Between refreshes, keep the previous lightningColorFloats so the
      // last-rendered frame stays visible until the next sim tick.
      if (!useLightning) {
        buffers.lightningColorFloats.fill(0);
      }
    } else {
      buffers.lightningColorFloats.fill(0);
      lightningRenderRef.current = 0;
      // Don't accrue a strike backlog while disabled / outside hours.
      lightningCtrl.pauseClock(performance.now());
    }

    for (let i = 0; i < buffers.n; i++) {
      const i3 = i * 3;
      const r = clamp01(buffers.timeColorFloats[i3] + buffers.lightningColorFloats[i3]);
      const g = clamp01(buffers.timeColorFloats[i3 + 1] + buffers.lightningColorFloats[i3 + 1]);
      const b = clamp01(buffers.timeColorFloats[i3 + 2] + buffers.lightningColorFloats[i3 + 2]);
      buffers.colorFloats[i3] = r;
      buffers.colorFloats[i3 + 1] = g;
      buffers.colorFloats[i3 + 2] = b;
      buffers.colorBytes[i3] = (r * 255 + 0.5) | 0;
      buffers.colorBytes[i3 + 1] = (g * 255 + 0.5) | 0;
      buffers.colorBytes[i3 + 2] = (b * 255 + 0.5) | 0;
    }

    const locatorColor = hexToVec3(ledLocator.color);
    for (let i = 0; i < buffers.n; i++) {
      const i3 = i * 3;
      if (
        ledStreamPipeline.locatorOverrideStage &&
        ledLocator.enabled &&
        locatedSet.has(i)
      ) {
        // Hard output override: bypass all prior processing and force this LED
        // to locator yellow both in the 3D view and in streamed byte output.
        buffers.colorFloats[i3] = locatorColor[0];
        buffers.colorFloats[i3 + 1] = locatorColor[1];
        buffers.colorFloats[i3 + 2] = locatorColor[2];
        buffers.colorBytes[i3] = (locatorColor[0] * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 1] = (locatorColor[1] * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 2] = (locatorColor[2] * 255 + 0.5) | 0;
      }
      const [red, green, blue] = encodeLedRgb(
        buffers.colorFloats[i3],
        buffers.colorFloats[i3 + 1],
        buffers.colorFloats[i3 + 2],
        strand.colorProfile,
      );
      tmpColor.setRGB(
        srgbByteToLinear(red),
        srgbByteToLinear(green),
        srgbByteToLinear(blue),
      );
      mesh.setColorAt(i, tmpColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Unmapped strand slots retain their physical indices but must not emit
    // from the origin or contribute to the cloud-top diffuser.
    for (let i = 0; i < buffers.n; i++) {
      if (buffers.validPositions[i]) continue;
      const i3 = i * 3;
      buffers.colorFloats[i3] = 0;
      buffers.colorFloats[i3 + 1] = 0;
      buffers.colorFloats[i3 + 2] = 0;
      buffers.colorBytes[i3] = 0;
      buffers.colorBytes[i3 + 1] = 0;
      buffers.colorBytes[i3 + 2] = 0;
    }

    // Apply one hue-preserving brightness curve to the final LED signal.
    for (let i = 0; i < buffers.n; i++) {
      const i3 = i * 3;
      const [red, green, blue] = encodeLedRgb(
        buffers.colorFloats[i3],
        buffers.colorFloats[i3 + 1],
        buffers.colorFloats[i3 + 2],
        strand.colorProfile,
      );
      buffers.colorBytes[i3] = red;
      buffers.colorBytes[i3 + 1] = green;
      buffers.colorBytes[i3 + 2] = blue;
    }

    // Suppress 1-LSB chatter in streamed bytes. This removes tiny histogram
    // flicker from floating-point noise while preserving meaningful motion.
    const byteCount = buffers.n * 3;
    if (!stableBytesRef.current || stableBytesRef.current.length !== byteCount) {
      stableBytesRef.current = new Uint8Array(buffers.colorBytes);
    } else {
      const stable = stableBytesRef.current;
      for (let i = 0; i < byteCount; i++) {
        const next = buffers.colorBytes[i];
        const prev = stable[i];
        if (Math.abs(next - prev) <= STREAM_BYTE_DEADBAND) {
          buffers.colorBytes[i] = prev;
        } else {
          stable[i] = next;
        }
      }
    }
    for (let i = 0; i < buffers.n; i++) {
      if (buffers.validPositions[i]) continue;
      const i3 = i * 3;
      buffers.colorBytes[i3] = 0;
      buffers.colorBytes[i3 + 1] = 0;
      buffers.colorBytes[i3 + 2] = 0;
      stableBytesRef.current![i3] = 0;
      stableBytesRef.current![i3 + 1] = 0;
      stableBytesRef.current![i3 + 2] = 0;
    }

    publishFrame(buffers.colorBytes, buffers.n);

    if (wled.enabled) {
      const now = performance.now();
      const minDelta = 1000 / Math.max(1, wled.fps);
      if (now - lastSendRef.current >= minDelta) {
        if (wledClient.send(buffers.colorBytes)) {
          lastSendRef.current = now;
        }
      }
    }
  });

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!ledLocator.enabled) return;
    if (e.instanceId === undefined || e.instanceId === null) return;
    e.stopPropagation();
    toggleLocatedLed(e.instanceId);
  };

  // Keep the instanced mesh mounted while the diffuser is shown. Unmounting
  // it loses the mapped instance matrices; remounting would briefly place
  // every default instance at the origin as one large overlapping cap.
  const showDirectLeds = !(cloudTop.id && cloudTop.visible);

  const markerKind = ledDisplayMode === "sensors" ? "sensor" : "led";
  return (
    <instancedMesh
      key={`led-markers-${markerKind}`}
      ref={meshRef}
      args={[undefined, undefined, buffers.n]}
      frustumCulled={false}
      visible={showDirectLeds}
      onPointerDown={onPointerDown}
      renderOrder={5}
    >
      <sphereGeometry args={markerSphereArgs(1, markerKind)} />
      <meshStandardMaterial
        {...MARKER_MATERIAL_DEFAULTS}
        color="#ffffff"
        emissive="#ffffff"
        emissiveIntensity={1}
        opacity={1}
        onBeforeCompile={applyMarkerInstanceEmissive}
        customProgramCacheKey={() => "marker-instance-emissive-v1"}
      />
    </instancedMesh>
  );
}
