// The SSAO passes, as shaders and helpers, for the frame pipeline.
//
// IBL gives every surface a skylight term, but a skylight is only correct for a
// surface that can actually see the sky. An inside corner, the gap under a
// slab, the seam where a wall meets the ground -- those see a sliver of it, and
// without that cue untextured geometry loses its contact points and objects
// look like they are hovering. SSAO estimates that visibility from the depth
// buffer and darkens the ambient term accordingly.
//
// Three details here are the difference between AO and dirt, and each cost a
// debugging session in the prototype this is ported from:
//   * depth is sampled with NEAREST filtering and snapped to full-res texel
//     centres, because an interpolated depth is a depth that belongs to no
//     surface, and at silhouettes it reads as invented geometry;
//   * the blur is bilateral (weighted by view-depth difference), or AO bleeds
//     across silhouettes and leaves dark halos hugging every edge;
//   * the composite protects bright pixels, because AO belongs on the ambient
//     term only -- multiplied into sunlit concrete it just looks grimy.

import * as THREE from 'three';

export const KERNEL_SIZE = 16;

/**
 * Cosine-weighted hemisphere kernel with a length ramp: many short samples for
 * contact darkening, a few long ones for cavity-scale occlusion.
 *
 * Deterministic (fixed LCG) so the AO pattern is identical between runs, which
 * makes screenshot comparisons meaningful.
 */
export function buildKernel(size = KERNEL_SIZE): THREE.Vector3[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const kernel: THREE.Vector3[] = [];
  for (let i = 0; i < size; i++) {
    const phi = 2 * Math.PI * rnd();
    const r = rnd();
    const sinT = Math.sqrt(r);
    const v = new THREE.Vector3(Math.cos(phi) * sinT, Math.sin(phi) * sinT, Math.sqrt(1 - r));
    v.multiplyScalar(0.1 + 0.9 * ((i + 1) / size) ** 2);
    kernel.push(v);
  }
  return kernel;
}

export function makeTarget(
  width: number,
  height: number,
  withDepth: boolean,
  samples = 0,
): THREE.WebGLRenderTarget {
  // Samples on the BEAUTY target are the scene's antialiasing (see
  // renderQuality.aoMsaaSamplesSetting) -- three resolves both color and depth
  // into the attached textures, so the AO chain reads antialiased inputs. The
  // half-res AO/blur targets stay single-sampled: they are quads.
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    samples,
  });
  if (withDepth) {
    const depth = new THREE.DepthTexture(width, height);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    target.depthTexture = depth;
  }
  return target;
}

export const AO_FRAGMENT = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform vec2 uResolution;
  uniform vec2 uFullResolution;
  uniform vec3 uKernel[${KERNEL_SIZE}];
  uniform float uRadius;
  uniform float uFadeStart;
  uniform float uFadeEnd;

  vec2 snapUv(vec2 uv) { return (floor(uv * uFullResolution) + 0.5) / uFullResolution; }
  float rawDepth(vec2 uv) { return texture2D(tDepth, snapUv(uv)).x; }
  vec3 viewPosFromDepth(vec2 uv, float d) {
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 view = uInvProj * clip;
    return view.xyz / view.w;
  }
  vec3 viewPos(vec2 uv) { return viewPosFromDepth(snapUv(uv), rawDepth(uv)); }

  // Normals from explicit depth taps, picking the smoother side of each axis.
  // dFdx/dFdy break at depth discontinuities, which smears wrong hemisphere
  // orientations along every silhouette.
  vec3 reconstructNormal(vec2 uv, vec3 p) {
    vec2 tx = vec2(2.0 / uFullResolution.x, 0.0);
    vec2 ty = vec2(0.0, 2.0 / uFullResolution.y);
    vec3 pr = viewPos(uv + tx), pl = viewPos(uv - tx);
    vec3 pu = viewPos(uv + ty), pd = viewPos(uv - ty);
    vec3 dx = (abs(pr.z - p.z) < abs(p.z - pl.z)) ? (pr - p) : (p - pl);
    vec3 dy = (abs(pu.z - p.z) < abs(p.z - pd.z)) ? (pu - p) : (p - pd);
    return normalize(cross(dx, dy));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float d = rawDepth(uv);
    if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }
    vec3 p = viewPosFromDepth(snapUv(uv), d);
    vec3 n = reconstructNormal(uv, p);

    // Interleaved gradient noise: an even spatial distribution, so what the
    // blur leaves behind is grain rather than streaks.
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float ang = ign * 6.2831853;
    float ca = cos(ang), sa = sin(ang);

    vec3 helper = abs(n.z) < 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 t = normalize(cross(helper, n));
    vec3 b = cross(n, t);
    mat3 tbn = mat3(t, b, n);

    // Bias grows with distance because depth precision shrinks with it. A
    // constant bias is the classic cause of banded self-occlusion on big flats.
    float bias = 0.02 + 0.002 * abs(p.z);

    float occ = 0.0;
    for (int i = 0; i < ${KERNEL_SIZE}; i++) {
      vec3 k = uKernel[i];
      vec3 kr = vec3(ca * k.x - sa * k.y, sa * k.x + ca * k.y, k.z);
      vec3 sp = p + tbn * kr * uRadius;
      vec4 o = uProj * vec4(sp, 1.0);
      vec2 suv = (o.xy / o.w) * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      float sd = rawDepth(suv);
      if (sd >= 0.9999) continue; // sample hit the sky: definitely unoccluded
      float sz = viewPosFromDepth(snapUv(suv), sd).z;
      float range = smoothstep(0.0, 1.0, uRadius / max(abs(p.z - sz), 1e-4));
      occ += step(sp.z + bias, sz) * range;
    }
    float ao = 1.0 - occ / float(${KERNEL_SIZE});
    // Fade out with distance: half-res AO gets noisy far away, and out there
    // the fog owns the depth cue anyway.
    ao = mix(ao, 1.0, smoothstep(uFadeStart, uFadeEnd, -p.z));
    gl_FragColor = vec4(vec3(ao), 1.0);
  }
`;

export const BLUR_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tAO;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uNear;
  uniform float uFar;
  float viewZ(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }
  void main() {
    float cz = viewZ(texture2D(tDepth, vUv).x);
    float sum = 0.0;
    float wsum = 0.0;
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        vec2 o = vec2(float(x), float(y)) * uTexel;
        float sz = viewZ(texture2D(tDepth, vUv + o).x);
        float w = exp(-abs(sz - cz) * 1.2);
        sum += texture2D(tAO, vUv + o).r * w;
        wsum += w;
      }
    }
    gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
  }
`;

export const COMPOSITE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tAO;
  uniform sampler2D tDust;
  uniform float uPower;
  uniform float uAoOn;
  uniform float uDustOn;
  void main() {
    vec3 col = texture2D(tDiffuse, vUv).rgb;
    if (uAoOn > 0.5) {
      float ao = clamp(texture2D(tAO, vUv).r, 0.0, 1.0);
      float term = pow(ao, uPower);
      // AO should kill ambient light, not sunlight. A post-multiply cannot
      // separate the two terms, so brightness stands in for "this pixel is lit
      // directly" and is protected.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      term = mix(term, 1.0, smoothstep(0.45, 1.0, lum) * 0.65);
      col *= term;
    }
    if (uDustOn > 0.5) {
      // Premultiplied: the dust pass accumulated front-to-back, so this is
      // the over operator with nothing to divide out.
      vec4 dust = texture2D(tDust, vUv);
      col = col * (1.0 - dust.a) + dust.rgb;
    }
    // The scene was rendered into a linear offscreen buffer, so the transfer
    // functions three would normally apply on the way to the canvas have to
    // be applied here instead: tone mapping first (three defines TONE_MAPPING,
    // the toneMapping() function and toneMappingExposure for any toneMapped
    // material drawn to the canvas, so this is the renderer's own operator --
    // ACES on PRETTY, nothing on FAST), then the exact piecewise sRGB curve
    // rather than a 2.2 gamma, so turning the pipeline on cannot shift the
    // overall brightness of the image -- only the occluded parts of it.
    #ifdef TONE_MAPPING
    col = toneMapping(col);
    #endif
    col = max(col, 0.0);
    col = mix(col * 12.92, 1.055 * pow(col, vec3(0.41666)) - 0.055, step(vec3(0.0031308), col));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

