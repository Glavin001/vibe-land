// GLSL for the destruction dust: the one-time field bake, the instanced box
// raymarcher, and the half-resolution layer's depth-aware upsample.
//
// Every fragment shader here is GLSL ES 3.0 (`glslVersion: THREE.GLSL3`), so it
// declares its own `out vec4 outColor` and uses `in`/`out`/`flat` directly.
// three still prepends `cameraPosition`, `projectionMatrix` and friends.
//
// The volume math is camera-relative from the first line: a world coordinate
// two kilometres from the origin has ~1 mm of float32 precision, which is fine
// for a position and useless for the reciprocal slab test that follows it.

/** Normaliser for the baked density channel; the bake clamps to it. */
export const DENS_MAX = 4.0;
/** Compile-time bound on the march; the per-instance step count is the runtime bound. */
export const MAX_STEPS = 64;

/** Interleaved gradient noise, the same constants the SSAO pass uses. */
const IGN = /* glsl */ `
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

// ---------------------------------------------------------------------------
// Field bake: one 128x128 quad per z layer, writing RGBA8
//   r  density / DENS_MAX
//   g  self-shadow light term, sun along +X in field space
//   b  erosion noise (independent, high frequency) for the age dissolve
// ---------------------------------------------------------------------------

export const FIELD_BAKE_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FIELD_BAKE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D tNoise;
uniform float uLayer;
uniform float uLayers;
uniform vec3 uLightDir;
in vec2 vUv;
out vec4 outColor;

#define DENS_MAX ${DENS_MAX.toFixed(1)}

// Four octaves of domain-warped noise; tileable because tNoise repeats and
// the frequencies are integral.
float fbm(vec3 c) {
  float a = texture(tNoise, c).r;
  float b = texture(tNoise, c * 3.0 + a * 0.65).r;
  float d = texture(tNoise, c * 7.0 - b * 0.5).r;
  float e = texture(tNoise, c * 13.0).r;
  return a * 0.5 + b * 0.28 + d * 0.15 + e * 0.07;
}

// A noisy ellipsoid that never reaches the box wall. Ember volumes.js:110-124.
float densityAt(vec3 c) {
  vec3 q = c * 2.0 - 1.0;
  vec3 p = vec3(q.x / 0.92, q.y * 0.95, q.z / 0.92);
  float n = fbm(c * 1.7);
  float shape = max(0.0, 1.0 - length(p) + (n - 0.5) * 1.05);
  float edge = clamp((1.0 - max(abs(q.x), max(abs(q.y), abs(q.z)))) * 7.0, 0.0, 1.0);
  return pow(shape, 1.25) * max(0.0, n * 3.4 - 0.9) * edge;
}

void main() {
  vec3 c = vec3(vUv, (uLayer + 0.5) / uLayers);
  float dens = densityAt(c);
  // Optical depth toward the sun: what shades this cell is the dust between
  // it and the light. Six taps, each 6% of the box.
  float od = 0.0;
  for (int k = 1; k <= 6; k++) {
    od += densityAt(c + uLightDir * (float(k) * 0.06));
  }
  float light = exp(-od * 0.35) * 0.85 + 0.15;
  float erosion = texture(tNoise, c * 5.3 + 0.37).r;
  outColor = vec4(min(dens, DENS_MAX) / DENS_MAX, light, erosion, 1.0);
}
`;

// ---------------------------------------------------------------------------
// The volume: an instanced unit box, raymarched from the back face
// ---------------------------------------------------------------------------

export const VOLUME_VERTEX = /* glsl */ `
in vec3 aCenter;
in vec3 aSize;
in vec4 aParams;   // density, yaw, steps, fade
in vec4 aMotion;   // age, erosion, mirrorZ, tint index + per-parcel jitter fraction
out vec3 vRay;
flat out vec3 vCenterRel;
flat out vec3 vHalf;
flat out vec4 vParams;
flat out vec4 vMotion;
void main() {
  vec3 world = aCenter + position * aSize;
  vRay = world - cameraPosition;
  vCenterRel = aCenter - cameraPosition;
  vHalf = aSize * 0.5;
  vParams = aParams;
  vMotion = aMotion;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const VOLUME_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D tField;
uniform sampler2D tDepth;
uniform float uDepthScale;
uniform float uNear;
uniform float uFar;
uniform vec3 uCamForward;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uAlbedo[3];
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uExtinction;
uniform float uPhaseG;
in vec3 vRay;
flat in vec3 vCenterRel;
flat in vec3 vHalf;
flat in vec4 vParams;
flat in vec4 vMotion;
out vec4 outColor;

#define DENS_MAX ${DENS_MAX.toFixed(1)}
#define MAX_STEPS ${MAX_STEPS}
#define PI 3.14159265

${IGN}

// three's perspectiveDepthToViewZ: window depth in [0,1] to view z (negative).
float viewZFromDepth(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

// Henyey-Greenstein, normalised so g = 0 gives 1.
float phaseHG(float mu, float g) {
  float gg = g * g;
  return (1.0 - gg) / pow(1.0 + gg - 2.0 * g * mu, 1.5);
}

void main() {
  vec3 ray = normalize(vRay);
  // Slab test against the parcel's box. A ray component of exactly zero
  // would make the reciprocal infinite and the min/max below NaN.
  vec3 safe = vec3(
    abs(ray.x) < 1e-6 ? 1e-6 : ray.x,
    abs(ray.y) < 1e-6 ? 1e-6 : ray.y,
    abs(ray.z) < 1e-6 ? 1e-6 : ray.z);
  vec3 inv = 1.0 / safe;
  vec3 t0 = (vCenterRel - vHalf) * inv;
  vec3 t1 = (vCenterRel + vHalf) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float enter = max(0.0, max(tmin.x, max(tmin.y, tmin.z)));
  float exitT = min(tmax.x, min(tmax.y, tmax.z));

  // The scene ends the ray. Exact texel: the depth texture is the drawing
  // buffer's size, and the half-res layer scales its coordinate up to it.
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy * uDepthScale), 0).r;
  float rayZ = max(dot(ray, uCamForward), 1e-4);
  exitT = min(exitT, -viewZFromDepth(d) / rayZ);
  if (exitT <= enter) discard;

  float steps = vParams.z;
  float stride = (exitT - enter) / steps;
  // Per-parcel offset decorrelates the dither between overlapping parcels,
  // so where several boxes cover a pixel their grain averages out.
  float jitter = ign(gl_FragCoord.xy + fract(vMotion.w) * vec2(37.0, 91.0));
  float ca = cos(vParams.y);
  float sa = sin(vParams.y);
  float mirror = vMotion.z;
  float erosion = vMotion.y;
  float densK = vParams.x * vParams.w * DENS_MAX * uExtinction;
  int tint = int(floor(vMotion.w));
  vec3 albedo = tint == 1 ? uAlbedo[1] : (tint == 2 ? uAlbedo[2] : uAlbedo[0]);

  float mu = dot(ray, uSunDir);
  vec3 sun = uSunColor * phaseHG(mu, uPhaseG);

  vec3 rgb = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= steps || alpha > 0.985) break;
    float t = enter + (float(i) + jitter) * stride;
    vec3 q = (ray * t - vCenterRel) / vHalf;
    vec3 l = vec3(q.x * ca - q.z * sa, q.y, (q.x * sa + q.z * ca) * mirror);
    if (max(abs(l.x), max(abs(l.y), abs(l.z))) > 1.0) continue;
    vec4 f = texture(tField, l * 0.5 + 0.5);
    float dens = max(0.0, f.r - erosion * f.b);
    if (dens < 0.002) continue;
    float a = 1.0 - exp(-dens * densK * stride);
    float up = l.y * 0.5 + 0.5;
    vec3 ambient = mix(uGroundColor, uSkyColor, up);
    vec3 col = albedo * (sun * f.g + ambient * (0.35 + 0.65 * f.g));
    // Fog on view depth, as three fogs the buildings behind it.
    float viewDepth = t * rayZ;
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * viewDepth * viewDepth);
    col = mix(col, uFogColor, fog);
    rgb += col * a * (1.0 - alpha);
    alpha += a * (1.0 - alpha);
  }
  // Premultiplied by construction; the material blends (One, OneMinusSrcAlpha).
  outColor = vec4(rgb, alpha);
}
`;

// ---------------------------------------------------------------------------
// Half-res layer to full res: a small tent of taps weighted by depth
// similarity, so a distant cloud stays crisp against the building edge in
// front of it. After Ember distant-layer.js:31-62, widened to smooth grain.
// ---------------------------------------------------------------------------

export const UPSAMPLE_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const UPSAMPLE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tHalf;
uniform sampler2D tDepth;
uniform vec2 uHalfSize;
uniform vec2 uFullSize;
uniform float uNear;
uniform float uFar;
in vec2 vUv;
out vec4 outColor;

float viewZFromDepth(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }
float zAt(vec2 uv) { return -viewZFromDepth(texture(tDepth, uv).r); }

void main() {
  float z = zAt(vUv);
  vec2 cell = vUv * uHalfSize - 0.5;
  vec2 base = floor(cell);
  vec2 f = fract(cell);
  vec4 color = vec4(0.0);
  float weight = 0.0;
  // 3x3 around the bilinear footprint: tent-weighted, so the half-res
  // march's grain is smoothed as it is scaled up; depth-weighted, so the
  // smoothing never crosses a building's edge.
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      vec2 p = (base + vec2(float(x) + 0.5, float(y) + 0.5)) / uHalfSize;
      float tx = 1.0 - min(1.0, abs(float(x) - f.x) * 0.6);
      float ty = 1.0 - min(1.0, abs(float(y) - f.y) * 0.6);
      // Floored: with every tap across a depth edge the weights would vanish
      // and the division below would amplify bilinear residue into bright
      // lines along every horizon. With the floor the result is a true
      // weighted average and can never exceed its taps.
      float match = exp(-abs(zAt(p) - z) / (z * 0.002 + 0.2)) + 0.02;
      float w = tx * ty * match;
      color += texture(tHalf, p) * w;
      weight += w;
    }
  }
  // Stays premultiplied: the composite expects it.
  outColor = color / max(weight, 0.0001);
}
`;
