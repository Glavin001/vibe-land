// Minimal vector/quaternion helpers for the city modules (kept free of
// three.js so the codec layer stays testable in plain vitest).

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export const EPSILON = 1.0e-6;

export const vZero = (): Vec3 => [0, 0, 0];
export const vClone = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const vAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vLength = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vDistance = (a: Vec3, b: Vec3): number => vLength(vSub(a, b));
export const vLerp = (a: Vec3, b: Vec3, u: number): Vec3 => [
  a[0] + (b[0] - a[0]) * u,
  a[1] + (b[1] - a[1]) * u,
  a[2] + (b[2] - a[2]) * u,
];

export const qIdentity = (): Quat => [0, 0, 0, 1];

export function qNormalize(q: Quat): Quat {
  const lengthSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (!Number.isFinite(lengthSq) || lengthSq <= EPSILON) {
    return qIdentity();
  }
  const inv = 1 / Math.sqrt(lengthSq);
  return [q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv];
}

export const qDot = (a: Quat, b: Quat): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export const qNeg = (q: Quat): Quat => [-q[0], -q[1], -q[2], -q[3]];

export const qConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate vector v by quaternion q. */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  // v + qw * t + cross(q.xyz, t)
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function qSlerp(start: Quat, end: Quat, amount: number): Quat {
  let b = end;
  let dot = qDot(start, b);
  if (dot < 0) {
    b = qNeg(b);
    dot = -dot;
  }
  if (dot > 0.9995) {
    return qNormalize([
      start[0] + (b[0] - start[0]) * amount,
      start[1] + (b[1] - start[1]) * amount,
      start[2] + (b[2] - start[2]) * amount,
      start[3] + (b[3] - start[3]) * amount,
    ]);
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const theta = theta0 * amount;
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;
  return qNormalize([
    start[0] * s0 + b[0] * s1,
    start[1] * s0 + b[1] * s1,
    start[2] * s0 + b[2] * s1,
    start[3] * s0 + b[3] * s1,
  ]);
}

/** Quat from a scaled-axis rotation vector (angle = |v|). */
export function qFromScaledAxis(v: Vec3): Quat {
  const angle = vLength(v);
  if (angle <= EPSILON) {
    return [v[0] * 0.5, v[1] * 0.5, v[2] * 0.5, 1];
  }
  const half = angle * 0.5;
  const s = Math.sin(half) / angle;
  return qNormalize([v[0] * s, v[1] * s, v[2] * s, Math.cos(half)]);
}

/** Scaled-axis rotation vector of q (inverse of qFromScaledAxis). */
export function qToRotationVector(q: Quat): Vec3 {
  let r = qNormalize(q);
  if (r[3] < 0) {
    r = qNeg(r);
  }
  const vector: Vec3 = [r[0], r[1], r[2]];
  const sinHalf = vLength(vector);
  if (sinHalf <= EPSILON) {
    return vScale(vector, 2);
  }
  const angle = 2 * Math.atan2(sinHalf, Math.min(1, Math.max(-1, r[3])));
  return vScale(vector, angle / sinHalf);
}

/** Angle between two quaternions in radians. */
export function qAngle(a: Quat, b: Quat): number {
  const na = qNormalize(a);
  const nb = qNormalize(b);
  const dot = Math.min(1, Math.abs(qDot(na, nb)));
  return 2 * Math.acos(dot);
}

/** Compose a rigid transform: world = bodyPose ∘ local. */
export function composePose(
  bodyPosition: Vec3,
  bodyRotation: Quat,
  localPosition: Vec3,
  localRotation: Quat,
): { position: Vec3; rotation: Quat } {
  return {
    position: vAdd(bodyPosition, qRotate(bodyRotation, localPosition)),
    rotation: qNormalize(qMul(bodyRotation, localRotation)),
  };
}

/** local = inverse(bodyPose) ∘ world. */
export function relativePose(
  bodyPosition: Vec3,
  bodyRotation: Quat,
  worldPosition: Vec3,
  worldRotation: Quat,
): { position: Vec3; rotation: Quat } {
  const inverseRotation = qConjugate(qNormalize(bodyRotation));
  return {
    position: qRotate(inverseRotation, vSub(worldPosition, bodyPosition)),
    rotation: qNormalize(qMul(inverseRotation, worldRotation)),
  };
}
