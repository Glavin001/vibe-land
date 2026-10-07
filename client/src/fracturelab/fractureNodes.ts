// The fracture-face shader: what the INSIDE of a material looks like where it
// broke, as a solid texture in rest space.
//
// Evaluated in the structure's rest frame, so the two pieces of one crack see
// the same stones, the same pores, the same grain. Relief is mirrored by the
// piece's `side` (the sign of its outward normal against the canonical
// direction; canonical.ts): a stone pulled out of one piece stands proud on
// that piece and leaves its socket in the other.
//
// Bump uses ANALYTIC gradients (value noise with derivatives, cell-distance
// vectors) because this runs inside a per-fragment branch, where WGSL
// derivatives are undefined (three r182 disables the uniformity check, so a
// dpdx there compiles and silently returns garbage).
//
// Only imported behind __WEBGPU__.

import { wgsl, wgslFn } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const library: Node = wgsl(`
fn frHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
// Value noise in [-1, 1] with its gradient: (v, dv/dx, dv/dy, dv/dz).
fn frNoiseD(p: vec3f) -> vec4f {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let a = frHash(i);
  let b = frHash(i + vec3f(1.0, 0.0, 0.0));
  let c = frHash(i + vec3f(0.0, 1.0, 0.0));
  let d = frHash(i + vec3f(1.0, 1.0, 0.0));
  let e = frHash(i + vec3f(0.0, 0.0, 1.0));
  let g = frHash(i + vec3f(1.0, 0.0, 1.0));
  let h = frHash(i + vec3f(0.0, 1.0, 1.0));
  let k = frHash(i + vec3f(1.0, 1.0, 1.0));
  let k1 = b - a; let k2 = c - a; let k3 = e - a;
  let k4 = a - b - c + d; let k5 = a - c - e + h; let k6 = a - b - e + g;
  let k7 = -a + b + c - d + e - g - h + k;
  let v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  let gr = du * vec3f(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4f(v * 2.0 - 1.0, gr * 2.0);
}
fn frFbmD(p: vec3f, octaves: i32) -> vec4f {
  var sum = vec4f(0.0);
  var amp = 0.5;
  var f = 1.0;
  for (var o = 0; o < octaves; o++) {
    let n = frNoiseD(p * f + vec3f(f32(o) * 17.13));
    sum += vec4f(n.x * amp, n.yzw * amp * f);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}
// Cellular noise: col0 = (f1, f2, id, 0); col1 = p minus nearest feature point.
fn frCell(p: vec3f) -> mat2x4f {
  let i = floor(p);
  var f1 = 9.0;
  var f2 = 9.0;
  var id = 0.0;
  var toNearest = vec3f(0.0);
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let c = i + vec3f(f32(x), f32(y), f32(z));
        let jitter = vec3f(frHash(c), frHash(c + 19.7), frHash(c + 41.3));
        let d = p - (c + jitter);
        let dist = length(d);
        if (dist < f1) {
          f2 = f1;
          f1 = dist;
          id = frHash(c + 7.7);
          toNearest = d;
        } else if (dist < f2) {
          f2 = dist;
        }
      }
    }
  }
  return mat2x4f(vec4f(f1, f2, id, 0.0), vec4f(toNearest, 0.0));
}
`);

/**
 * The broken surface. Inputs, all rest space:
 *   p, n      position and outward normal of this piece's face
 *   cls       FractureClass
 *   relief    geometric crack relief / amplitude (valleys darken)
 *   fp        pixel footprint in metres (fades sub-pixel detail)
 *   base      fresh-break colour; accent: stones / latewood / grog
 *   a         (accentFill, accentSize, bumpSize, bumpDepth)
 *   b         (pores, roughness, metalness, cavity)
 *   grain     wood grain direction (zero when none)
 *   side      +1 / -1: which piece of the crack this is (canonical.ts)
 * Returns mat4x4f: [0] = (albedo, roughness), [1] = (normal, ao), [2] = (metalness, height, 0, 0).
 */
export const fractureSurface: Node = wgslFn(`
fn fractureSurface(p: vec3f, n: vec3f, cls: f32, relief: f32, fp: f32, base: vec3f, accent: vec3f,
                   a: vec4f, b: vec4f, grain: vec3f, side: f32) -> mat4x4f {
  let ic = i32(cls + 0.5);
  var color = base;
  var rough = b.y;
  var metal = b.z;
  // Canonical height (metres) and its gradient; mirrored by side at the end.
  var h = 0.0;
  var grad = vec3f(0.0);
  let bump = max(a.z, 0.0005);
  let fine = 1.0 - smoothstep(bump * 0.3, bump * 1.6, fp);

  // Grit: every broken surface is granular at the scale of its grain.
  let grit = frFbmD(p / bump, 3);
  color *= 0.86 + 0.28 * (grit.x * 0.5 + 0.5) * fine + 0.14 * (1.0 - fine);
  h += grit.x * bump * 0.3 * fine;
  grad += grit.yzw * 0.3 * fine;

  if (ic <= 1 || ic == 3) {
    // Fresh cement paste is full of sand: grains a few millimetres across,
    // lighter and darker than the paste around them.
    let sandCell = frCell(p / 0.0032);
    let sandHash = frHash(vec3f(sandCell[0].z * 11.0, 2.0, 5.0));
    let sand = step(sandHash, 0.6) * (1.0 - smoothstep(0.3, 0.48, sandCell[0].x)) * fine;
    color = mix(color, color * (0.7 + 0.6 * frHash(vec3f(sandCell[0].z * 19.0, 1.0, 3.0))), sand);
    // Crushed-stone aggregate: ANGULAR grains (Voronoi cells shrunk by a seam
    // of paste), at two sizes. Most broke through and sit flush on both
    // pieces; some pulled out of one piece, standing proud on it and leaving
    // a socket in the other.
    let cs = max(a.y, 0.002);
    for (var layer = 0; layer < 2; layer++) {
      let size = select(cs * 0.42, cs, layer == 0);
      let cell = frCell(p / size + vec3f(f32(layer) * 13.7));
      let f1 = cell[0].x;
      let id = cell[0].z + f32(layer) * 0.37;
      let fill = select(a.x * 0.75, a.x, layer == 0);
      let isStone = step(frHash(vec3f(id * 91.0, 1.0, 7.0)), fill);
      let seam = 0.08 + 0.16 * frHash(vec3f(id * 53.0, 2.0, 3.0));
      let border = cell[0].y - f1;
      let inside = smoothstep(seam, seam + 0.04, border) * isStone;
      // Mixed aggregate: grey gravel, warm sandstone, dark basalt, pale quartz.
      let pick = frHash(vec3f(id * 29.0, 4.0, 9.0));
      var hue = accent;
      if (pick > 0.86) { hue = vec3f(0.58, 0.55, 0.5); }
      else if (pick > 0.6) { hue = accent * vec3f(1.3, 1.08, 0.82); }
      else if (pick < 0.28) { hue = accent * vec3f(0.48, 0.48, 0.5); }
      let speck = frFbmD(p / (size * 0.2), 2).x;
      let stone = hue * (0.82 + 0.36 * frHash(vec3f(id * 17.0, 3.0, 1.0))) * (0.9 + 0.2 * speck * fine);
      // Height: a low dome over the grain, steepest at its seam.
      let r = 0.75;
      let dome = clamp((r * r - f1 * f1) / (r * r), 0.0, 1.0) * inside;
      let domeGrad = -2.0 * cell[1].xyz / (size * r * r) * inside;
      let pulled = layer == 0 && frHash(vec3f(id * 37.0, 5.0, 2.0)) < 0.22;
      let towards = select(-1.0, 1.0, frHash(vec3f(id * 41.0, 6.0, 4.0)) > 0.5);
      if (pulled) {
        let lift = size * 0.4 * towards;
        h += dome * lift;
        grad += domeGrad * lift;
        let proud = towards * side > 0.0;
        color = mix(color, select(color * 0.7, stone, proud), inside);
      } else {
        h += dome * size * 0.06;
        grad += domeGrad * size * 0.06;
        color = mix(color, stone, inside);
        rough = mix(rough, rough * 0.72, inside);
      }
      // The seam between grain and paste holds a little shadow.
      let seamDark = (1.0 - smoothstep(0.0, seam, border)) * isStone;
      color *= 1.0 - 0.18 * seamDark * fine;
    }
  } else if (ic == 2 || ic == 10) {
    // Brick body: fired clay with lighter grog speckle, crossed by the grey
    // mortar beds between courses (rest-space y, every a.y metres).
    let cs = 0.006;
    let cell = frCell(p / cs);
    let speck = (1.0 - smoothstep(0.18, 0.3, cell[0].x)) * step(frHash(vec3f(cell[0].z * 13.0, 1.0, 1.0)), 0.3);
    color = mix(color, color * vec3f(1.45, 1.3, 1.15), speck * 0.6 * fine);
    let blotch = frFbmD(p / 0.04, 2);
    color *= 0.85 + 0.3 * (blotch.x * 0.5 + 0.5);
    let course = max(a.y, 0.02);
    let inCourse = fract(p.y / course);
    let joint = 0.011 / course;
    let wobble = frFbmD(p / 0.01, 2).x * 0.12;
    let bed = 1.0 - smoothstep(joint * 0.6, joint * (1.0 + wobble), min(inCourse, 1.0 - inCourse) * 2.0);
    let mortar = accent * (0.85 + 0.3 * frFbmD(p / 0.003, 2).x);
    color = mix(color, mortar, bed);
    rough = mix(rough, 1.0, bed);
    h -= bed * 0.002;
  } else if (ic == 4) {
    // Wood: fibres along the grain, torn into ridges; latewood bands.
    let g = select(vec3f(0.0, 1.0, 0.0), normalize(grain), length(grain) > 0.5);
    let along = dot(p, g);
    let across = p - g * along;
    let q = across / max(a.y, 0.0005) + g * along / max(a.y * 25.0, 0.001);
    let fib = frFbmD(q, 3);
    let band = smoothstep(-0.15, 0.25, fib.x);
    color = mix(color, accent, band * a.x * 2.0);
    let gq = (fib.yzw - g * dot(fib.yzw, g)) / max(a.y, 0.0005);
    h += fib.x * bump * 1.5;
    grad += gq * bump * 1.5;
  } else if (ic == 5 || ic == 6) {
    // Gypsum: chalk, a little yellowed, crumbly.
    let blot = frFbmD(p / 0.02, 2);
    color *= 0.92 + 0.12 * blot.x;
  } else if (ic == 8) {
    metal = 1.0;
  }

  // Pores and voids.
  if (b.x > 0.0) {
    let pc = frCell(p / 0.0035);
    let pore = (1.0 - smoothstep(0.08, 0.2, pc[0].x)) * step(frHash(vec3f(pc[0].z * 71.0, 9.0, 9.0)), b.x * 4.0) * fine;
    color *= 1.0 - 0.5 * pore;
    h -= pore * 0.0012;
  }

  // Geometric relief valleys hold shadow and dust.
  let ao = clamp(1.0 - b.w * max(-relief, 0.0) * 0.7, 0.35, 1.0) * clamp(1.0 + h / bump * 0.15, 0.7, 1.0);
  let g2 = grad * side;
  let tangential = g2 - n * dot(g2, n);
  let bent = normalize(n - tangential * a.w);
  return mat4x4f(
    vec4f(clamp(color, vec3f(0.005), vec3f(0.95)), clamp(rough, 0.03, 1.0)),
    vec4f(bent, ao),
    vec4f(metal, h * side, 0.0, 0.0),
    vec4f(0.0));
}
`, [library]);

/**
 * Rebar steel: dark mill scale blotched with orange rust, and the rolled ribs
 * every ~11 mm along the bar (`along` = distance down the bar, metres).
 * Returns (albedo, roughness).
 */
export const rebarSurface: Node = wgslFn(`
fn rebarSurface(p: vec3f, along: f32) -> vec4f {
  let rust = frFbmD(p / 0.015, 3).x * 0.5 + 0.5;
  let fleck = frFbmD(p / 0.003, 2).x * 0.5 + 0.5;
  let scale = vec3f(0.075, 0.07, 0.068);
  let orange = vec3f(0.30, 0.13, 0.045);
  let rib = 0.5 + 0.5 * sin(along * 571.2);
  var color = mix(scale, orange, smoothstep(0.5, 0.85, rust)) * (0.8 + 0.4 * fleck);
  color *= 0.7 + 0.3 * rib;
  return vec4f(color, 0.5 + 0.3 * rust - 0.15 * rib);
}
`, [library]);
