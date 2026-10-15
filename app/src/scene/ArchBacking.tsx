import { useEffect, useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { DoubleSide, Mesh } from "three";
import { useSimStore } from "../state";
import { buildArchBackingGeometry, DUAL_32X8_SLOTTED } from "../mapping/ledLayout";

/**
 * Inner face of the two arches. The sensor hemispheres sit on the outer
 * face; this strip is the back, and light does not pass through it.
 * `includeCloud` matches the simulator, which also swings the arches with
 * the cloud. The mapping view only follows the mesh transform.
 */
export function ArchBacking({
  includeCloud = false,
  pickable = false,
  onPointerDown,
  onClick,
  onPointerMove,
  onPointerOut,
}: {
  includeCloud?: boolean;
  /** When set, the strip receives pointer hits so domes can be placed on it. */
  pickable?: boolean;
  onPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const layout = useSimStore((s) => s.mapping.layout);
  const pitch = useSimStore((s) => s.mapping.layoutPitch);
  const archPlacements = useSimStore((s) => s.mapping.archPlacements);
  const flipUpDown = useSimStore((s) => s.mapping.flipUpDown);
  const flipLeftRight = useSimStore((s) => s.mapping.flipLeftRight);
  const mesh = useSimStore((s) => s.mesh);
  const cloud = useSimStore((s) => s.cloud);
  const geometry = useMemo(
    () =>
      layout === DUAL_32X8_SLOTTED
        ? buildArchBackingGeometry(pitch, archPlacements)
        : null,
    [layout, pitch, archPlacements],
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  const strip = (
    <group
      position={[0, mesh.offsetY, 0]}
      rotation={[
        (mesh.tiltDeg * Math.PI) / 180,
        (mesh.yawDeg * Math.PI) / 180,
        0,
      ]}
      scale={mesh.scale}
    >
      <group scale={[flipLeftRight ? -1 : 1, flipUpDown ? -1 : 1, 1]}>
        <mesh
          geometry={geometry}
          userData={{ archSurface: true }}
          raycast={pickable ? Mesh.prototype.raycast : () => null}
          onPointerDown={pickable ? onPointerDown : undefined}
          onClick={pickable ? onClick : undefined}
          onPointerMove={pickable ? onPointerMove : undefined}
          onPointerOut={pickable ? onPointerOut : undefined}
        >
          <meshStandardMaterial
            color="#14161c"
            roughness={0.9}
            metalness={0}
            side={DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
  if (!includeCloud) return strip;
  return (
    <group
      position={[cloud.offsetX, cloud.offsetY, cloud.offsetZ]}
      rotation={[
        (cloud.rotationXDeg * Math.PI) / 180,
        (cloud.rotationYDeg * Math.PI) / 180,
        0,
      ]}
    >
      {strip}
    </group>
  );
}
