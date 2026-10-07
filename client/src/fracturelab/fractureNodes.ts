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

const commonLibrary = `
fn frHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
// Sparse round dots, 1 per cell at most: a cheap stand-in for cellular noise
// when the dots are small and isolated (pinholes, specks, iron spots). The
// dot is jittered inside the middle half of its cell and smaller than a
// quarter cell, so no neighbour can reach in: 4 hashes instead of 108.
// Returns (coverage 0..1, the dot's random id, distance in cell units, 0).
fn frDot(p: vec3f, size: f32, prob: f32, radius: f32) -> vec4f {
  let q = p / size;
  let c = floor(q);
  let id = frHash(c + 0.37);
  if (id >= prob) { return vec4f(0.0, id, 9.0, 0.0); }
  let centre = c + 0.25 + 0.5 * vec3f(frHash(c + 11.1), frHash(c + 23.3), frHash(c + 35.7));
  let d = length(q - centre);
  return vec4f(1.0 - smoothstep(radius * 0.6, radius, d), id / max(prob, 1e-4), d, 0.0);
}
// d/dp of (1 - smoothstep(e0, e1, f1)) for a cell sampled at p / size.
fn cell1Grad(cell: mat2x4f, size: f32, e0: f32, e1: f32) -> vec3f {
  let f1 = cell[0].x;
  let t = clamp((f1 - e0) / (e1 - e0), 0.0, 1.0);
  let dsdf = 6.0 * t * (1.0 - t) / (e1 - e0);
  return -dsdf * cell[1].xyz / max(f1, 1e-5) / size;
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
`;
const hashNoise = `
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
`;
const textureNoise = `
// Value noise in [-1, 1] with its gradient, from the precomputed periodic
// table (noiseTexture.ts: 128^3 texels over 32 lattice cells, 4 a cell;
// r = value, gba = gradient / 4): one trilinear fetch instead of eight
// hashes and a quintic blend.
fn frNoiseD(nt: texture_3d<f32>, ns: sampler, p: vec3f) -> vec4f {
  let s = textureSampleLevel(nt, ns, p * (1.0 / 32.0) + vec3f(0.5 / 128.0), 0.0);
  return vec4f(s.x * 2.0 - 1.0, (s.yzw * 2.0 - 1.0) * 4.0);
}
fn frFbmD(nt: texture_3d<f32>, ns: sampler, p: vec3f, octaves: i32) -> vec4f {
  var sum = vec4f(0.0);
  var amp = 0.5;
  var f = 1.0;
  for (var o = 0; o < octaves; o++) {
    let n = frNoiseD(nt, ns, p * f + vec3f(f32(o) * 17.13));
    sum += vec4f(n.x * amp, n.yzw * amp * f);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}
`;
const library: Node = wgsl(commonLibrary + hashNoise);
const texturedLibrary: Node = wgsl(commonLibrary + textureNoise);

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
const fractureSource = (name: string, ic: string): string => `
fn ${name}(p: vec3f, n: vec3f, cls: f32, relief: f32, fp: f32, base: vec3f, accent: vec3f,
                   a: vec4f, b: vec4f, grain: vec3f, side: f32) -> mat4x4f {
  let ic = ${ic};
  var color = base;
  var rough = b.y;
  var metal = b.z;
  // Canonical height (metres) and its gradient; mirrored by side at the end.
  var h = 0.0;
  var grad = vec3f(0.0);
  let bump = max(a.z, 0.0005);
  let fine = 1.0 - smoothstep(bump * 0.3, bump * 1.6, fp);

  // Grit: every broken surface is granular at the scale of its grain. Like
  // the skins, detail is branched by pixel footprint: far pixels skip it.
  if (fp < bump * 1.6) {
    let grit = frFbmD(p / bump, 3);
    color *= 0.86 + 0.28 * (grit.x * 0.5 + 0.5) * fine + 0.14 * (1.0 - fine);
    h += grit.x * bump * 0.3 * fine;
    grad += grit.yzw * 0.3 * fine;
  }

  if (ic <= 1 || ic == 3) {
    // Fresh cement paste is full of sand: grains a few millimetres across,
    // lighter and darker than the paste around them.
    if (fp < 0.004) {
      let sand = frDot(p, 0.0032, 0.6, 0.24) * fine;
      color = mix(color, color * (0.7 + 0.6 * sand.y), sand.x);
    }
    // Crushed-stone aggregate: ANGULAR grains (Voronoi cells shrunk by a seam
    // of paste), at two sizes. Most broke through and sit flush on both
    // pieces; some pulled out of one piece, standing proud on it and leaving
    // a socket in the other.
    let cs = max(a.y, 0.002);
    // Grains smaller than a few pixels average out: draw only the layers the
    // footprint can resolve, and blend the rest in as their mean colour.
    let layers = select(select(0, 1, fp < cs * 0.35), 2, fp < cs * 0.15);
    color = mix(color, accent, a.x * 0.45 * (1.0 - f32(min(layers, 1))));
    for (var layer = 0; layer < layers; layer++) {
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
    // Each layer only where the footprint resolves it (a Voronoi grog speck
    // a few millimetres across is 27 cells of work, worthless past a metre or
    // two); beyond, its mean.
    let cs = 0.006;
    if (fp < cs * 0.6) {
      let cell = frCell(p / cs);
      let speck = (1.0 - smoothstep(0.18, 0.3, cell[0].x)) * step(frHash(vec3f(cell[0].z * 13.0, 1.0, 1.0)), 0.3);
      color = mix(color, color * vec3f(1.45, 1.3, 1.15), speck * 0.6 * fine);
    }
    var blotchV = 0.0;
    if (fp < 0.02) { blotchV = frFbmD(p / 0.04, 2).x * (1.0 - smoothstep(0.01, 0.02, fp)); }
    color *= 0.85 + 0.3 * (blotchV * 0.5 + 0.5);
    let course = max(a.y, 0.02);
    let inCourse = fract(p.y / course);
    let joint = 0.011 / course;
    var wobble = 0.0;
    if (fp < 0.005) { wobble = frFbmD(p / 0.01, 2).x * 0.12; }
    // Joint edges blur to coverage once a joint is a pixel or less.
    let blurC = fp / course;
    let bedOnly = 1.0 - smoothstep(joint * 0.6 - blurC, joint * (1.0 + wobble) + blurC, min(inCourse, 1.0 - inCourse) * 2.0);
    // Head joints on the skin's bond grid (skinSurface): a crack that ran up
    // a head joint shows its broken mortar.
    let alongX = abs(n.x) >= abs(n.z);
    let uu = select(p.z, p.x, alongX);
    let len = course * 3.0;
    let kc = floor(p.y / course);
    let off = select(0.0, len * 0.5, (i32(kc) & 1) == 1);
    let fu = fract((uu + off) / len);
    let head = 1.0 - smoothstep(0.004 - fp, 0.0065 * (1.0 + wobble) + fp, min(fu, 1.0 - fu) * len);
    let bed = max(bedOnly, head * step(0.35, max(abs(n.x), abs(n.z))));
    var mortarV = 0.0;
    if (fp < 0.003) { mortarV = frFbmD(p / 0.003, 2).x * fine; }
    let mortar = accent * (0.85 + 0.3 * mortarV);
    color = mix(color, mortar, bed);
    rough = mix(rough, 1.0, bed);
    h -= bed * 0.002;
  } else if (ic == 4) {
    // Wood: fibres along the grain, torn into ridges; latewood bands.
    let g = select(vec3f(0.0, 1.0, 0.0), normalize(grain), length(grain) > 0.5);
    let along = dot(p, g);
    let across = p - g * along;
    let q = across / max(a.y, 0.0005) + g * along / max(a.y * 25.0, 0.001);
    // Fibres a fraction of a millimetre wide: past a few per pixel, their
    // mean (latewood about two fifths of the face).
    if (fp < a.y * 6.0) {
      let fib = frFbmD(q, 3);
      let band = smoothstep(-0.15, 0.25, fib.x);
      let keep = 1.0 - smoothstep(a.y * 3.0, a.y * 6.0, fp);
      color = mix(color, accent, mix(0.4, band, keep) * a.x * 2.0);
      let gq = (fib.yzw - g * dot(fib.yzw, g)) / max(a.y, 0.0005);
      h += fib.x * bump * 1.5 * keep;
      grad += gq * bump * 1.5 * keep;
    } else {
      color = mix(color, accent, 0.4 * a.x * 2.0);
    }
  } else if (ic == 5 || ic == 6) {
    // Gypsum: chalk, a little yellowed, crumbly.
    if (fp < 0.01) {
      let blot = frFbmD(p / 0.02, 2);
      color *= 0.92 + 0.12 * blot.x * (1.0 - smoothstep(0.005, 0.01, fp));
    }
  } else if (ic == 8) {
    metal = 1.0;
  }

  // Pores and voids.
  if (b.x > 0.0 && fp < 0.004) {
    let pore = frDot(p, 0.0035, b.x * 4.0, 0.18).x * fine;
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
`;
export const fractureSurface: Node = wgslFn(fractureSource('fractureSurface', 'i32(cls + 0.5)'), [library]);

/**
 * Rebar steel: dark mill scale blotched with orange rust, and the rolled ribs
 * every ~11 mm along the bar (`along` = distance down the bar, metres).
 * Returns (albedo, roughness).
 */
const rebarSource = (name: string): string => `
fn ${name}(p: vec3f, along: f32) -> vec4f {
  let rust = frFbmD(p / 0.015, 3).x * 0.5 + 0.5;
  let fleck = frFbmD(p / 0.003, 2).x * 0.5 + 0.5;
  let scale = vec3f(0.075, 0.07, 0.068);
  let orange = vec3f(0.30, 0.13, 0.045);
  let rib = 0.5 + 0.5 * sin(along * 571.2);
  var color = mix(scale, orange, smoothstep(0.5, 0.85, rust)) * (0.8 + 0.4 * fleck);
  color *= 0.7 + 0.3 * rib;
  return vec4f(color, 0.5 + 0.3 * rust - 0.15 * rib);
}
`;
export const rebarSurface: Node = wgslFn(rebarSource('rebarSurface'), [library]);

/**
 * The OUTER skin of a material, in the same rest space as its broken
 * interior, so the two agree: brick courses on the face are the courses the
 * crack steps along and whose mortar shows on the cut; a worn concrete arris
 * blends into the very aggregate the break exposes.
 *
 *   color, color2   main and secondary colour (paste/stain, brick/mortar, wood/latewood, paint/scuff)
 *   a               (pattern scale, bump depth, roughness, colour variation)
 *   b               (grime, detail, -, -)
 *   grain           wood grain direction (zero when none)
 *
 * Returns mat4x4f like fractureSurface: [0] (albedo, roughness),
 * [1] (normal, ao), [2] (metalness, height, 0, 0).
 */
const skinSource = (name: string, ic: string): string => `
fn ${name}(p: vec3f, n: vec3f, cls: f32, fp: f32, color: vec3f, color2: vec3f,
               a: vec4f, b: vec4f, grain: vec3f) -> mat4x4f {
  let ic = ${ic};
  var albedo = color;
  var rough = a.z;
  var metal = 0.0;
  var h = 0.0;
  var grad = vec3f(0.0);
  var ao = 1.0;
  // Level of detail by pixel footprint (metres per pixel). Far pixels -- a
  // whole city at once, sub-pixel triangles shaded four at a time -- take the
  // cheap path; patterns and stains from mid range in; grit, pores and specks
  // only up close. Branches, not multiplies: skipped work costs nothing.
  let tierMid = fp < 0.03;
  let tierNear = fp < 0.004;
  let fine = 1.0 - smoothstep(0.0008, 0.004, fp);
  let vertical = 1.0 - abs(n.y);
  // In-plane coordinates on a vertical face: u along the face, v up.
  let uAxis = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) >= abs(n.x));
  let u = dot(p, uAxis);
  let v = p.y;

  // Every skin: a broad mottle; up close, sand-scale grit.
  var mottle = frNoiseD(p / 0.35).x * 0.5;
  if (tierMid) {
    mottle = frFbmD(p / 0.35, 3).x;
    let blotch = frFbmD(p / 0.06, 2).x;
    albedo *= 1.0 + a.w * 0.3 * blotch;
  }
  albedo *= 1.0 + a.w * 0.6 * mottle;
  if (tierNear) {
    let grit = frFbmD(p / 0.0018, 2);
    h += grit.x * 0.00025 * fine * b.y;
    grad += grit.yzw * (0.00025 / 0.0018) * fine * b.y;
  }

  if (ic <= 1 || ic == 3) {
    // Cast concrete, form face. Colour moves at every scale -- pour lifts and
    // patches metres across, cloudy cement in between, sand specks -- and
    // warms and cools a little as it goes. Pinholes everywhere, a few bigger
    // bugholes, lime bloom, the plywood panel joints and tie-rod holes of the
    // formwork, rain streaks, splash grime at the foot, and a gentle
    // undulation where the form panels bowed under the pour.
    let big = frNoiseD(p / 1.6).x;
    let hue = frNoiseD(p / 0.9 + 3.1).x;
    albedo *= 1.0 + a.w * big;
    albedo *= mix(vec3f(0.97, 0.99, 1.03), vec3f(1.05, 1.0, 0.93), hue * 0.5 + 0.5);
    if (tierMid) {
      let mid = frFbmD(p / 0.22, 3).x;
      let cloud = smoothstep(0.05, 0.45, frFbmD(p / 0.45 + 1.7, 3).x);
      albedo *= 1.0 + a.w * 0.7 * mid;
      albedo *= 1.0 - 0.16 * cloud * a.w * 4.0;
      let bug = frDot(p + 9.3, max(a.x, 0.004), 0.08, 0.2 * (0.5 + 0.5 * frHash(floor(p / max(a.x, 0.004)) + 2.2)));
      albedo *= 1.0 - 0.55 * bug.x;
      h -= bug.x * 0.002;
      ao *= 1.0 - 0.5 * bug.x;
      let bloom = smoothstep(0.35, 0.75, frFbmD(p / 0.5 + 7.3, 3).x);
      albedo = mix(albedo, vec3f(0.62, 0.61, 0.58), bloom * 0.18 * b.x);
      let undulate = frFbmD(p / 0.7, 2);
      grad += undulate.yzw * (0.0015 / 0.7);
    }
    if (tierNear) {
      let small = frFbmD(p / 0.035, 2).x;
      albedo *= 1.0 + a.w * 0.35 * small * fine;
      let speck = frDot(p, 0.0025, 0.3, 0.22) * fine;
      albedo *= 1.0 + (speck.y - 0.5) * 0.4 * speck.x;
      let pin = frDot(p + 4.1, 0.004, 0.1, 0.14) * fine;
      albedo *= 1.0 - 0.45 * pin.x;
      ao *= 1.0 - 0.3 * pin.x;
    }
    if (vertical > 0.6) {
      let panel = vec2f(fract(u / 1.22), fract(v / 2.44));
      let panelId = frHash(vec3f(floor(u / 1.22), floor(v / 2.44), 13.0));
      albedo *= 0.95 + 0.1 * panelId;
      let tie = vec2f(fract(u / 0.61 + 0.5), fract(v / 0.61 + 0.5)) - 0.5;
      let tieR = length(tie * 0.61);
      let hole = 1.0 - smoothstep(0.011, 0.014, tieR);
      albedo = mix(albedo, color2 * 0.45, hole);
      let foot = 1.0 - smoothstep(0.0, 0.6, v);
      albedo *= 1.0 - 0.3 * foot * b.x;
      if (tierMid) {
        let seam = min(min(panel.x, 1.0 - panel.x) * 1.22, min(panel.y, 1.0 - panel.y) * 2.44);
        let fin = 1.0 - smoothstep(0.0012, 0.0035, seam);
        h += fin * 0.0012;
        albedo *= 1.0 - 0.1 * fin;
        let ring = (1.0 - smoothstep(0.014, 0.035, tieR)) * (1.0 - hole);
        albedo *= 1.0 - 0.12 * ring;
        h -= hole * 0.006;
        ao *= 1.0 - 0.55 * hole;
        // Rain streaks: long in v, narrow in u, stronger under the tie holes.
        let streakN = frFbmD(vec3f(u * 7.0, v * 0.35, dot(p, vec3f(0.3, 0.0, 0.7)) * 2.0), 3).x;
        let underTie = (1.0 - smoothstep(0.0, 0.03, abs(tie.x * 0.61))) * step(tie.y, 0.0) * 0.6;
        let streak = clamp(smoothstep(0.05, 0.6, streakN) + underTie * smoothstep(-0.2, 0.3, streakN), 0.0, 1.0);
        albedo = mix(albedo, albedo * color2 / max(color, vec3f(0.01)), streak * b.x * 0.55);
      }
    } else if (n.y > 0.5) {
      // A slab top: steel-trowelled, smoother, with fine swirl scratches.
      rough *= 0.85;
      if (tierNear) {
        let swirl = frFbmD(vec3f(p.x * 40.0, 0.0, p.z * 40.0), 2).x;
        albedo *= 1.0 + 0.05 * swirl;
      }
    }
  } else if (ic == 2 || ic == 10) {
    // Running-bond brickwork: courses of a.x high (the course grid the
    // crack steps along), bricks three courses long, half-bond offset. On
    // the wall's top the bricks run along the wall, a.x * 1.5 deep.
    let course = max(a.x, 0.02);
    let len = course * 3.0;
    let joint = 0.010;
    let wAxis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) >= abs(n.x));
    let flat = vertical < 0.5;
    let rowAxis = select(v, dot(p, wAxis), flat);
    let rowSize = select(course, course * 1.5, flat);
    let k = floor(rowAxis / rowSize);
    let offset = select(0.0, len * 0.5, (i32(k) & 1) == 1);
    let j = floor((u + offset) / len);
    let fu = fract((u + offset) / len);
    let fv = fract(rowAxis / rowSize);
    let du = min(fu, 1.0 - fu) * len;
    let dv = min(fv, 1.0 - fv) * rowSize;
    var wobble = 0.0;
    if (tierMid) { wobble = frFbmD(p / 0.05, 2).x * 0.0015; }
    let edge = min(du, dv) - joint * 0.5 + wobble;
    // Which way is "out of the brick" at its nearest edge (rest space).
    let rowDir = select(vec3f(0.0, 1.0, 0.0), wAxis, flat);
    let toEdge = select(rowDir * select(-1.0, 1.0, fv > 0.5), uAxis * select(-1.0, 1.0, fu > 0.5), du < dv);
    let brickId = frHash(vec3f(k, j, 3.0));
    // Far away a joint is a fraction of a pixel: blend it as coverage.
    let jointBlur = max(0.0006, fp * 0.7);
    let mortar = 1.0 - smoothstep(-jointBlur, jointBlur, edge);
    // Colour: most red, some darker flashed, some orange; burnt ends,
    // mottle, iron spots.
    var brick = color * (0.8 + 0.4 * brickId);
    if (brickId > 0.84) { brick = color * vec3f(0.62, 0.55, 0.55); }
    else if (brickId < 0.12) { brick = color * vec3f(1.22, 1.08, 0.9); }
    let burn = (1.0 - smoothstep(0.0, len * 0.25, du)) * step(0.55, frHash(vec3f(k, j, 5.0)));
    brick *= 1.0 - 0.3 * burn;
    var joints = color2;
    var knock = 0.0;
    if (tierMid) {
      let bm = frFbmD(p / 0.025 + vec3f(k, j, 0.0) * 3.7, 3).x;
      brick *= 1.0 + 0.16 * bm;
      // Knocked arrises: some brick corners chipped.
      let cornerD = length(vec2f(du, dv));
      knock = (1.0 - smoothstep(0.004, 0.016, cornerD)) * step(frHash(vec3f(k, j, 17.0)), 0.5) * (1.0 - mortar);
      brick = mix(brick, brick * 1.15, knock * 0.5);
    }
    if (tierNear) {
      let iron = frDot(p, 0.006, 0.07, 0.2) * fine;
      brick *= 1.0 - 0.5 * iron.x;
      let sand = frFbmD(p / 0.0028, 2);
      brick *= 0.9 + 0.2 * (sand.x * 0.5 + 0.5) * fine + 0.1 * (1.0 - fine);
      grad += sand.yzw * (0.00025 / 0.0028) * fine * (1.0 - mortar);
      let sandy = frFbmD(p / 0.0015, 2).x;
      joints = color2 * (0.82 + 0.3 * sandy * fine);
    }
    albedo = mix(brick, joints, mortar);
    // Relief: pillowed faces, struck/raked joints set back 4 mm, with the
    // gradient so the lighting actually catches them.
    let pillowT = clamp(edge / 0.016, 0.0, 1.0);
    let pillowSlope = 6.0 * pillowT * (1.0 - pillowT) / 0.016;
    let stepW = max(0.0024, jointBlur * 2.0);
    let stepT = clamp((edge + stepW * 0.5) / stepW, 0.0, 1.0);
    let stepSlope = 6.0 * stepT * (1.0 - stepT) / stepW;
    h += pillowT * pillowT * (3.0 - 2.0 * pillowT) * 0.0009 - (1.0 - stepT * stepT * (3.0 - 2.0 * stepT)) * 0.004 - knock * 0.003;
    grad += toEdge * -(pillowSlope * 0.0009 + stepSlope * 0.004);
    ao *= 1.0 - 0.5 * mortar;
    rough = mix(0.86, 0.97, mortar);
    // A slight per-brick tilt catches the light differently brick to brick.
    let tilt = vec3f(frHash(vec3f(k, j, 7.0)) - 0.5, frHash(vec3f(k, j, 9.0)) - 0.5, frHash(vec3f(k, j, 11.0)) - 0.5);
    grad += tilt * 0.04 * (1.0 - mortar);
  } else if (ic == 4) {
    // Timber: long grain streaks, darker latewood, the odd knot.
    let g = select(vec3f(0.0, 1.0, 0.0), normalize(grain), length(grain) > 0.5);
    let along = dot(p, g);
    let across = p - g * along;
    let q = across / max(a.x, 0.001) + g * along / max(a.x * 40.0, 0.01);
    if (tierMid) {
      let streak = frFbmD(q, 3);
      albedo = mix(color, color2, smoothstep(-0.1, 0.45, streak.x));
      h += streak.x * 0.0002;
      let endGrain = abs(dot(n, g));
      let ring = fract(length(across - floor(across / 0.25) * 0.25 - vec3f(0.125)) / max(a.x * 1.2, 0.001));
      albedo = mix(albedo, color2 * 0.9, endGrain * smoothstep(0.75, 0.95, ring));
      let knot = frCell(across / 0.09 + g * along / 0.35);
      let isKnot = step(frHash(vec3f(knot[0].z * 31.0, 2.0, 2.0)), 0.06);
      albedo = mix(albedo, color2 * 0.45, (1.0 - smoothstep(0.08, 0.2, knot[0].x)) * isKnot);
    } else {
      albedo = mix(color, color2, 0.35);
    }
  } else if (ic == 5 || ic == 6) {
    // Painted drywall / plaster: orange-peel roller texture, scuffs.
    if (tierNear) {
      let peel = frFbmD(p / 0.0012, 2);
      h += peel.x * 0.00008 * b.y;
      grad += peel.yzw * (0.00008 / 0.0012) * b.y;
    }
    if (tierMid) {
      let scuff = smoothstep(0.35, 0.8, frFbmD(p / 0.15, 3).x);
      albedo = mix(albedo, albedo * color2 / max(color, vec3f(0.01)), scuff * b.x);
    }
  } else if (ic == 8) {
    metal = 1.0;
    rough = a.z;
  }

  let bent = normalize(n - (grad - n * dot(grad, n)) * a.y);
  return mat4x4f(
    vec4f(clamp(albedo, vec3f(0.005), vec3f(0.95)), clamp(rough, 0.03, 1.0)),
    vec4f(bent, clamp(ao, 0.2, 1.0)),
    vec4f(metal, h, 0.0, 0.0),
    vec4f(0.0));
}
`;
export const skinSurface: Node = wgslFn(skinSource('skinSurface', 'i32(cls + 0.5)'), [library]);

/**
 * The surfaces a material draws with:
 *  - `cls` fixes the class at compile time (null: read it per fragment).
 *    Every other class's branch folds away, so a draw of one class runs a
 *    small shader with no divergence. (The uber-shader at scene scale runs
 *    the union of every class in each SIMD group: tiny far triangles of
 *    brick, timber and drywall share one group.)
 *  - `textured` takes value noise from the precomputed table
 *    (noiseTexture.ts), passed as two extra trailing arguments (the texture
 *    and its sampler), instead of hashing it per call.
 */
export interface SurfaceSet {
  fracture: Node;
  skin: Node;
  rebar: Node;
}

const NOISE_PARAMS = 'nt: texture_3d<f32>, ns: sampler';
function withNoiseTexture(source: string): string {
  const threaded = source.replace(/frNoiseD\(/g, 'frNoiseD(nt, ns, ').replace(/frFbmD\(/g, 'frFbmD(nt, ns, ');
  // The function's own signature gains the two parameters.
  return threaded.replace(/\)\s*->/, `, ${NOISE_PARAMS}) ->`);
}

const sets = new Map<string, SurfaceSet>();
export function surfaceSet(cls: number | null, textured: boolean): SurfaceSet {
  const key = `${cls ?? 'any'}:${textured ? 't' : 'h'}`;
  let set = sets.get(key);
  if (!set) {
    const suffix = `${cls === null ? '' : `_c${cls}`}${textured ? '_t' : ''}`;
    const ic = cls === null ? 'i32(cls + 0.5)' : String(cls);
    const build = (source: string) => wgslFn(textured ? withNoiseTexture(source) : source, [textured ? texturedLibrary : library]);
    set = {
      fracture: build(fractureSource(`fractureSurface${suffix}`, ic)),
      skin: build(skinSource(`skinSurface${suffix}`, ic)),
      rebar: build(rebarSource(`rebarSurface${textured ? '_t' : ''}`)),
    };
    sets.set(key, set);
  }
  return set;
}
