// Measured optics the Matter materials read: oak's fiber response (a LUT from
// data/fiber-lut.json) and brushed steel's anisotropic environment light.
//
// Only imported behind __WEBGPU__.
import {
  DataTexture,
  DataUtils,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
} from 'three/webgpu';
import {
  vec3,
  float,
  normalWorld,
  cameraPosition,
  positionWorld,
  pmremTexture,
} from 'three/tsl';
import * as TSL from 'three/tsl';
import fiberData from './data/fiber-lut.json';
import grooveData from './data/groove-fit.json';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
export const GROOVE_RMS = grooveData.rms_slope;
export function createFiberLUT() {
  const arr = new Uint16Array(128 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 128; x++) {
      const i = (y * 128 + x) * 4;
      arr[i] = DataUtils.toHalfFloat(fiberData.values[y][x]);
      arr[i + 3] = DataUtils.toHalfFloat(1);
    }
  const t = new DataTexture(arr, 128, 32, RGBAFormat, HalfFloatType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}
// Five-point quadrature along the major axis; minor width is evaluated by PMREM.
// Inspired by the 2024 major-axis environment-lighting paper. This bounded quadrature is our implementation,
// not a claim to reproduce their complete reference code or every BRDF configuration.
export function majorAxisRadiance(builder: Node, field: Node, toWorld: (direction: Node) => Node) {
  const source = builder.environmentNode?.value;
  if (!source) return null;
  const N = normalWorld;
  const V = cameraPosition.sub(positionWorld).normalize();
  const R = V.negate().reflect(N).normalize();
  const F = toWorld(field.element(2).xyz).normalize();
  const axis = N.cross(F)
    .add(vec3(0.00001, 0, 0.00001))
    .normalize();
  const r = field.element(0).w;
  const alpha = r.mul(r);
  const aniso = field.element(1).w;
  const width = alpha
    .mul(alpha)
    .add(float(1).sub(alpha.mul(alpha)).mul(aniso.mul(aniso)))
    .sqrt()
    .mul(0.35);
  const sum = pmremTexture(source, R, r).mul(0.38774).toVar();
  for (const [offset, weight] of [
    [-0.4, 0.24477],
    [0.4, 0.24477],
    [-0.8, 0.06136],
    [0.8, 0.06136],
  ])
    sum.addAssign(
      pmremTexture(
        source,
        R.add(axis.mul(width.mul(offset))).normalize(),
        r,
      ).mul(weight),
    );
  // Not in @types/three 0.170; present in the r182 runtime.
  return sum.mul((TSL as unknown as { materialEnvIntensity: Node }).materialEnvIntensity);
}
