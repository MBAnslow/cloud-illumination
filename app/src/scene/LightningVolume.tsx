import { useEffect, useMemo } from "react";
import { BoxGeometry, EdgesGeometry } from "three";
import { useSimStore } from "../state";

/**
 * Wireframe of the cuboid bolts are generated inside.
 * Nested the same way as the arches: flip, then mesh, then cloud.
 * One combined Euler cocks the box off the LED structure.
 */
export function LightningVolumeGuide() {
  const volume = useSimStore((s) => s.lightning.volume);
  const mesh = useSimStore((s) => s.mesh);
  const cloud = useSimStore((s) => s.cloud);
  const flipUpDown = useSimStore((s) => s.mapping.flipUpDown);
  const flipLeftRight = useSimStore((s) => s.mapping.flipLeftRight);
  const edges = useMemo(() => {
    const solid = new BoxGeometry(volume.size[0], volume.size[1], volume.size[2]);
    const geometry = new EdgesGeometry(solid);
    solid.dispose();
    return geometry;
  }, [volume.size[0], volume.size[1], volume.size[2]]);
  useEffect(() => {
    return () => edges.dispose();
  }, [edges]);

  if (!volume.visible) return null;

  return (
    <group
      position={[cloud.offsetX, cloud.offsetY, cloud.offsetZ]}
      rotation={[
        (cloud.rotationXDeg * Math.PI) / 180,
        (cloud.rotationYDeg * Math.PI) / 180,
        0,
      ]}
    >
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
          <group position={volume.center}>
            <lineSegments geometry={edges}>
              <lineBasicMaterial color="#f5d76e" />
            </lineSegments>
          </group>
        </group>
      </group>
    </group>
  );
}
