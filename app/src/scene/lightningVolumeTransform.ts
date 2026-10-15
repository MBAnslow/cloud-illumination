import { Euler, Matrix4, Quaternion, Vector3 } from "three";

/**
 * Maps a point in the lightning cuboid (origin at the volume centre, axes
 * along width / height / depth, metres before mesh scale) into world space.
 *
 * Order matches the arches and the LEDs: flip, then mesh scale / yaw / tilt
 * / vertical offset, then cloud yaw / tilt / offset. Adding the mesh and
 * cloud Euler angles into one rotation cocks the box off the arches.
 */
export function lightningVolumeWorldMatrix(args: {
  center: [number, number, number];
  meshScale: number;
  meshOffsetY: number;
  meshYawDeg: number;
  meshTiltDeg: number;
  cloudOffsetX: number;
  cloudOffsetY: number;
  cloudOffsetZ: number;
  cloudRotationXDeg: number;
  cloudRotationYDeg: number;
  flipUpDown: boolean;
  flipLeftRight: boolean;
}): Matrix4 {
  const center = new Matrix4().makeTranslation(args.center[0], args.center[1], args.center[2]);
  const flip = new Matrix4().makeScale(
    args.flipLeftRight ? -1 : 1,
    args.flipUpDown ? -1 : 1,
    1,
  );
  const mesh = new Matrix4().compose(
    new Vector3(0, args.meshOffsetY, 0),
    new Quaternion().setFromEuler(
      new Euler(
        (args.meshTiltDeg * Math.PI) / 180,
        (args.meshYawDeg * Math.PI) / 180,
        0,
        "XYZ",
      ),
    ),
    new Vector3(args.meshScale, args.meshScale, args.meshScale),
  );
  const cloud = new Matrix4().compose(
    new Vector3(args.cloudOffsetX, args.cloudOffsetY, args.cloudOffsetZ),
    new Quaternion().setFromEuler(
      new Euler(
        (args.cloudRotationXDeg * Math.PI) / 180,
        (args.cloudRotationYDeg * Math.PI) / 180,
        0,
        "XYZ",
      ),
    ),
    new Vector3(1, 1, 1),
  );
  // Post-multiply so a vector sees centre, then flip, then mesh, then cloud.
  return cloud.multiply(mesh).multiply(flip).multiply(center);
}
