// The hero stack (cityMaterialShader.ts HERO_HELPERS + MAP_FRAGMENT_HERO) in
// TSL, for the WebGPU path: hex 3-tap stochastic re-tiling with
// detail-aware weights and variance preservation, cross-faded to one plain
// tap with distance, plus the 3-band macro field. Same constants, same live
// tuning objects (cityShaderUniforms), same texture arrays.
//
// WGSL makes implicit-derivative taps in branches a compile error (GLSL
// only calls them undefined), so every tap here, the macro field's
// included, samples with explicit gradients computed before the branches.
//
// Only imported behind __WEBGPU__ (scene/cityMaterialNodes.ts).

import * as THREE from 'three';
import {
  Fn,
  If,
  cos,
  dot,
  exp2,
  float,
  floor,
  fract,
  inverseSqrt,
  max,
  mix,
  reference,
  sin,
  step,
  struct,
  texture,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { cityShaderUniforms as tuning } from './cityMaterialShader';
import { CITY_TEX_MEANS, CITY_TEX_ROTATION, cityMacroNoise, cityTextures } from './cityTextures';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const t = (name: keyof typeof tuning): Node => reference('value', 'float', tuning[name]);

/** One projection plane's hero sample. */
const PlaneSample = struct({ albedo: 'vec3', nxy: 'vec2', rough: 'float', ao: 'float' }, 'CityPlaneSample');

let shared: {
  means: Node;
  rotations: Node;
} | null = null;
function tables() {
  if (!shared) {
    const means: THREE.Vector3[] = [];
    for (let i = 0; i < CITY_TEX_MEANS.length; i += 3) {
      means.push(new THREE.Vector3(CITY_TEX_MEANS[i], CITY_TEX_MEANS[i + 1], CITY_TEX_MEANS[i + 2]));
    }
    shared = {
      means: uniformArray(means, 'vec3'),
      rotations: uniformArray(Array.from(CITY_TEX_ROTATION), 'float'),
    };
  }
  return shared;
}

/** The layer's mean albedo and rotation allowance (per-layer tables). */
export function layerMean(layer: Node): Node {
  return tables().means.element(layer);
}
export function layerRotation(layer: Node): Node {
  return tables().rotations.element(layer);
}

const hash4 = (p: Node): Node =>
  fract(sin(vec4(
    dot(p, vec2(37, 17)).add(1),
    dot(p, vec2(11, 47)).add(2),
    dot(p, vec2(41, 29)).add(3),
    dot(p, vec2(23, 31)).add(4),
  )).mul(103));

/** Barycentric weights and vertex ids of the lattice triangle holding st. */
function triGrid(stIn: Node): { w: Node; v0: Node; v1: Node; v2: Node } {
  const st = stIn.mul(3.46410161514);
  const skew = vec2(st.x.sub(st.y.mul(0.57735026919)), st.y.mul(1.15470053838));
  const baseId = floor(skew);
  const f = fract(skew);
  const tz = float(1).sub(f.x).sub(f.y);
  const sel = step(0, tz.negate());
  const s2 = sel.mul(2).sub(1);
  const w = vec3(tz.negate().mul(s2), sel.sub(f.y.mul(s2)), sel.sub(f.x.mul(s2)));
  return {
    w,
    v0: baseId.add(vec2(sel, sel)),
    v1: baseId.add(vec2(sel, float(1).sub(sel))),
    v2: baseId.add(vec2(float(1).sub(sel), sel)),
  };
}

/** One lattice vertex's random transform of the uv plane (and its gradients). */
function variant(uv: Node, dx: Node, dy: Node, h: Node, rotAllow: Node) {
  const angle = h.z.mul(2).sub(1).mul(Math.PI).mul(t('cityRotAmount')).mul(rotAllow);
  const c = cos(angle);
  const s = sin(angle);
  const mirror = mix(float(1), float(-1), step(h.w, t('cityMirrorProb')));
  const sc = max(float(0.6), h.x.mul(2).sub(1).mul(t('cityScaleJitter')).add(1));
  const rot = (v: Node) => vec2(c.mul(v.x).sub(s.mul(v.y)), s.mul(v.x).add(c.mul(v.y))).mul(sc);
  const flip = (v: Node) => vec2(v.x.mul(mirror), v.y);
  return {
    uv: rot(flip(uv)).add(h.xy.mul(t('cityPhaseJitter'))),
    dx: rot(flip(dx)),
    dy: rot(flip(dy)),
    tr: vec4(c, s, mirror, sc),
  };
}

/** Undo a variant's transform on a sampled tangent normal. */
function orient(n: Node, tr: Node): Node {
  const q = vec2(tr.x.mul(n.x).add(tr.y.mul(n.y)), tr.y.negate().mul(n.x).add(tr.x.mul(n.y)));
  return vec2(q.x.mul(tr.z), q.y).mul(tr.w);
}

/**
 * One projection plane's full hero sample (citySamplePlane): a struct of
 * albedo, tangent normal xy, roughness and occlusion. `hexFade` 1 = full hex
 * near, 0 = one plain tap far.
 */
export function samplePlane(uv: Node, dx: Node, dy: Node, layer: Node, rotAllow: Node, mean: Node, hexFade: Node): Node {
  const { albedo: albedoSheet, surface: surfaceSheet } = cityTextures();
  const tap = (sheet: THREE.Texture, at: Node, gx: Node, gy: Node): Node => (texture(sheet, at) as Node).grad(gx, gy).depth(layer);
  return Fn(() => {
    const albedo = vec3(0).toVar();
    const nxy = vec2(0).toVar();
    const rough = float(0).toVar();
    const ao = float(0).toVar();
    If(hexFade.greaterThan(0.001), () => {
      const grid = triGrid(uv.mul(float(0.28867513459).div(max(t('cityPatchTiles'), 0.02))));
      const h0 = hash4(grid.v0);
      const h1 = hash4(grid.v1);
      const h2 = hash4(grid.v2);
      const a = variant(uv, dx, dy, h0, rotAllow);
      const b = variant(uv, dx, dy, h1, rotAllow);
      const c = variant(uv, dx, dy, h2, rotAllow);
      const w0 = grid.w.max(vec3(1e-4)).pow(vec3(t('cityBlendExp')));
      const w1 = w0.div(max(w0.x.add(w0.y).add(w0.z), 1e-5));

      const a0 = tap(albedoSheet, a.uv, a.dx, a.dy);
      const a1 = tap(albedoSheet, b.uv, b.dx, b.dy);
      const a2 = tap(albedoSheet, c.uv, c.dx, c.dy);
      // Alpha is height, top-half remapped by the bake: h = (a - 0.5) * 2.
      const hh = vec3(a0.a, a1.a, a2.a).sub(0.5).mul(2);
      const w2 = w1.mul(exp2(hh.sub(0.5).mul(t('cityHeightBias'))));
      const w = w2.div(max(w2.x.add(w2.y).add(w2.z), 1e-5));

      const blended = a0.rgb.mul(w.x).add(a1.rgb.mul(w.y)).add(a2.rgb.mul(w.z))
        .mul(exp2(dot(h0, vec4(0.25)).sub(0.5).mul(2).mul(t('cityCellTint'))));
      const gain = inverseSqrt(max(dot(w, w), 1e-4));
      const preserved = mean.add(blended.sub(mean).mul(mix(float(1), gain, t('cityVariancePreserve'))));

      const s0 = tap(surfaceSheet, a.uv, a.dx, a.dy);
      const s1 = tap(surfaceSheet, b.uv, b.dx, b.dy);
      const s2 = tap(surfaceSheet, c.uv, c.dx, c.dy);
      const n0 = orient(s0.rg.mul(2).sub(1), a.tr);
      const n1 = orient(s1.rg.mul(2).sub(1), b.tr);
      const n2 = orient(s2.rg.mul(2).sub(1), c.tr);

      albedo.assign(preserved);
      nxy.assign(n0.mul(w.x).add(n1.mul(w.y)).add(n2.mul(w.z)));
      rough.assign(dot(vec3(s0.b, s1.b, s2.b), w));
      ao.assign(dot(vec3(s0.a, s1.a, s2.a), w));
      If(hexFade.lessThan(0.999), () => {
        const pa = tap(albedoSheet, uv, dx, dy);
        const ps = tap(surfaceSheet, uv, dx, dy);
        albedo.assign(mix(pa.rgb, albedo, hexFade));
        nxy.assign(mix(ps.rg.mul(2).sub(1), nxy, hexFade));
        rough.assign(mix(ps.b, rough, hexFade));
        ao.assign(mix(ps.a, ao, hexFade));
      });
    }).Else(() => {
      const pa = tap(albedoSheet, uv, dx, dy);
      const ps = tap(surfaceSheet, uv, dx, dy);
      albedo.assign(pa.rgb);
      nxy.assign(ps.rg.mul(2).sub(1));
      rough.assign(ps.b);
      ao.assign(ps.a);
    });
    return PlaneSample(albedo, nxy, rough, ao);
  })();
}

const rot2 = (a: number, v: Node): Node => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  // GLSL mat2(c, s, -s, c) * v: columns (c, s) and (-s, c).
  return vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
};

/**
 * The 3-band macro field at `metres` (cityMacroField), with the gradients of
 * `metres` (`dx`, `dy`) so it can be sampled inside a branch.
 */
export function macroField(metres: Node, dx: Node, dy: Node): Node {
  const macro = cityMacroNoise();
  const size = t('cityMacroSize');
  const band = (scale: Node, angle: number, offset: [number, number]) => {
    const at = rot2(angle, metres.div(scale)).add(vec2(...offset));
    return (texture(macro, at) as Node).grad(rot2(angle, dx.div(scale)), rot2(angle, dy.div(scale))).r;
  };
  const a = band(size, 0, [0, 0]);
  const b = band(size.mul(0.37), 0.71, [0.17, 0.61]);
  const c = band(size.mul(0.145), -0.43, [0.73, 0.29]);
  const mid = t('cityMacroMid');
  const small = t('cityMacroSmall');
  return a.add(b.mul(mid)).add(c.mul(small)).div(max(mid.add(small).add(1), 1e-4));
}
