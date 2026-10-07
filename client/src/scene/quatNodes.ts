// Quaternion helpers in TSL, shared by the city's slot meshes and the
// Fracture Lab. Only imported behind __WEBGPU__.

import { cross, dot, vec4 } from 'three/tsl';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const quatMul = (a: Node, b: Node): Node =>
  vec4(
    a.w.mul(b.xyz).add(b.w.mul(a.xyz)).add(cross(a.xyz, b.xyz)),
    a.w.mul(b.w).sub(dot(a.xyz, b.xyz)),
  );

export const quatRotate = (q: Node, v: Node): Node =>
  v.add(cross(q.xyz, cross(q.xyz, v).add(q.w.mul(v))).mul(2.0));
