// The fluid brick's passes: Ember's single-brick stable-fluids solver
// (lib/vfx/volume.js) on a 2D slice atlas.
//
// Semi-Lagrangian advection, procedural curl forcing, a settling force for
// dust, wind relaxation, drag, a radial blast impulse per source, Jacobi
// pressure projection with solid-neighbour conditions, and dye advection
// with spherical emission. One fullscreen quad per pass; every fragment is
// one cell. The appearance pass folds density, noise detail and a four-tap
// self-shadow into one premultiplied texel so the raymarch fetches once per
// step.
//
// All GLSL ES 3.0; `atlasGlsl` supplies the addressing and grid constants.

export const FLUID_MAX_SOURCES = 12;

export const FLUID_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform float uDt;
uniform float uTime;
uniform vec3 uCell;      // metres per cell, per axis
uniform vec3 uOrigin;    // world position of the brick's min corner
uniform sampler2D tOccupancy;

bool solid(ivec3 c) { return cellFetch(tOccupancy, c).r > 0.5; }
bool solidAt(vec3 uvw) { return solid(ivec3(floor(uvw))); }
vec3 worldOf(vec3 uvw) { return uOrigin + uvw * uCell; }
`;

/** Velocity: advect, force, damp, kick. Reads velocity, dye; writes velocity. */
export const VELOCITY_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
${COMMON}
uniform sampler2D tVelocity;
uniform sampler2D tDye;
uniform float uTurbulence;
uniform float uWindX;
uniform float uWindZ;
uniform int uSourceCount;
uniform vec4 uSourcePos[${FLUID_MAX_SOURCES}];   // uvw (cells), radius (cells)
uniform vec4 uSourceRate[${FLUID_MAX_SOURCES}];  // rate, heat, pulse, 0
out vec4 outColor;

// Solid-aware backtrace: never trace through a wall or into it.
vec3 backtrace(vec3 uvw, vec3 v) {
  vec3 candidate = uvw - v * uDt / uCell;
  if (solidAt(candidate) || solidAt(mix(uvw, candidate, 0.5))) return uvw;
  return candidate;
}

void main() {
  ivec3 c = cellOfFrag(gl_FragCoord.xy);
  vec3 uvw = vec3(c) + 0.5;
  vec3 old = cellFetch(tVelocity, c).xyz;
  vec3 v = atlasSample(tVelocity, backtrace(uvw, old)).xyz;
  vec4 dye = cellFetch(tDye, c);
  vec3 world = worldOf(uvw);
  float t = uTime;
  vec3 curl = vec3(
    sin(world.y * 2.4 + t) - cos(world.z * 2.2 - t * 0.7),
    sin(world.z * 2.6 + t * 0.9) - cos(world.x * 2.3 + t),
    sin(world.x * 2.5 - t * 0.8) - cos(world.y * 2.2 + t * 0.5));
  v += curl * uTurbulence * (min(dye.r, 1.0) * 0.5 + dye.g * 0.25) * uDt;
  // Dust settles; heat lifts.
  v.y += (dye.g * 3.5 - dye.r * 0.18) * uDt;
  v.x += (uWindX - v.x) * uDt * 0.55;
  v.z += (uWindZ - v.z) * uDt * 0.55;
  v *= 0.997;
  for (int i = 0; i < ${FLUID_MAX_SOURCES}; i++) {
    if (i >= uSourceCount) break;
    vec3 d = (uvw - uSourcePos[i].xyz) * uCell;
    float len = length(d);
    v += d / max(len, 0.01) * uSourceRate[i].z * exp(-len / 3.0) * 3.0;
  }
  v = clamp(v, vec3(-5.0), vec3(5.0));
  if (solid(c)) v = vec3(0.0);
  outColor = vec4(v, 0.0);
}
`;

/** Divergence of the velocity, with solid neighbours contributing nothing. */
export const DIVERGENCE_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
${COMMON}
uniform sampler2D tVelocity;
out vec4 outColor;
float face(ivec3 c, ivec3 d, int axis) {
  ivec3 n = c + d;
  if (!inGrid(n) || solid(n)) return 0.0;
  vec3 v = cellFetch(tVelocity, n).xyz;
  return axis == 0 ? v.x : (axis == 1 ? v.y : v.z);
}
void main() {
  ivec3 c = cellOfFrag(gl_FragCoord.xy);
  if (solid(c)) { outColor = vec4(0.0); return; }
  float div = 0.5 * (
    face(c, ivec3(1, 0, 0), 0) - face(c, ivec3(-1, 0, 0), 0)
    + face(c, ivec3(0, 1, 0), 1) - face(c, ivec3(0, -1, 0), 1)
    + face(c, ivec3(0, 0, 1), 2) - face(c, ivec3(0, 0, -1), 2));
  outColor = vec4(div, 0.0, 0.0, 0.0);
}
`;

/** One Jacobi iteration. Solid and out-of-grid neighbours take the centre's pressure. */
export const PRESSURE_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
${COMMON}
uniform sampler2D tPressure;
uniform sampler2D tDivergence;
out vec4 outColor;
float neighbour(ivec3 c, ivec3 d, float centre) {
  ivec3 n = c + d;
  if (!inGrid(n) || solid(n)) return centre;
  return cellFetch(tPressure, n).r;
}
void main() {
  ivec3 c = cellOfFrag(gl_FragCoord.xy);
  if (solid(c)) { outColor = vec4(0.0); return; }
  float centre = cellFetch(tPressure, c).r;
  float div = cellFetch(tDivergence, c).r;
  float p = (
    neighbour(c, ivec3(1, 0, 0), centre) + neighbour(c, ivec3(-1, 0, 0), centre)
    + neighbour(c, ivec3(0, 1, 0), centre) + neighbour(c, ivec3(0, -1, 0), centre)
    + neighbour(c, ivec3(0, 0, 1), centre) + neighbour(c, ivec3(0, 0, -1), centre)
    - div) / 6.0;
  outColor = vec4(p, 0.0, 0.0, 0.0);
}
`;

/** Subtract the pressure gradient; clamp the normal component at solid faces. */
export const PROJECT_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
${COMMON}
uniform sampler2D tVelocity;
uniform sampler2D tPressure;
out vec4 outColor;
float pAt(ivec3 c, ivec3 d, float centre) {
  ivec3 n = c + d;
  if (!inGrid(n) || solid(n)) return centre;
  return cellFetch(tPressure, n).r;
}
void main() {
  ivec3 c = cellOfFrag(gl_FragCoord.xy);
  if (solid(c)) { outColor = vec4(0.0); return; }
  vec3 v = cellFetch(tVelocity, c).xyz;
  float centre = cellFetch(tPressure, c).r;
  v -= 0.5 * vec3(
    pAt(c, ivec3(1, 0, 0), centre) - pAt(c, ivec3(-1, 0, 0), centre),
    pAt(c, ivec3(0, 1, 0), centre) - pAt(c, ivec3(0, -1, 0), centre),
    pAt(c, ivec3(0, 0, 1), centre) - pAt(c, ivec3(0, 0, -1), centre));
  // No flow into a wall.
  if (v.x > 0.0 && (!inGrid(c + ivec3(1, 0, 0)) || solid(c + ivec3(1, 0, 0)))) v.x = 0.0;
  if (v.x < 0.0 && (!inGrid(c - ivec3(1, 0, 0)) || solid(c - ivec3(1, 0, 0)))) v.x = 0.0;
  if (v.y > 0.0 && (!inGrid(c + ivec3(0, 1, 0)) || solid(c + ivec3(0, 1, 0)))) v.y = 0.0;
  if (v.y < 0.0 && (!inGrid(c - ivec3(0, 1, 0)) || solid(c - ivec3(0, 1, 0)))) v.y = 0.0;
  if (v.z > 0.0 && (!inGrid(c + ivec3(0, 0, 1)) || solid(c + ivec3(0, 0, 1)))) v.z = 0.0;
  if (v.z < 0.0 && (!inGrid(c - ivec3(0, 0, 1)) || solid(c - ivec3(0, 0, 1)))) v.z = 0.0;
  outColor = vec4(v, 0.0);
}
`;

/** Dye: advect, dissipate, emit, fade at the open edges, clear in solids. */
export const DYE_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
${COMMON}
uniform sampler2D tDye;
uniform sampler2D tVelocity;
uniform sampler3D tNoise;
uniform float uDissipation;
uniform float uCooling;
uniform int uSourceCount;
uniform vec4 uSourcePos[${FLUID_MAX_SOURCES}];
uniform vec4 uSourceRate[${FLUID_MAX_SOURCES}];
out vec4 outColor;

vec3 backtrace(vec3 uvw, vec3 v) {
  vec3 candidate = uvw - v * uDt / uCell;
  if (solidAt(candidate) || solidAt(mix(uvw, candidate, 0.5))) return uvw;
  return candidate;
}

void main() {
  ivec3 c = cellOfFrag(gl_FragCoord.xy);
  vec3 uvw = vec3(c) + 0.5;
  vec3 v = cellFetch(tVelocity, c).xyz;
  vec4 adv = atlasSample(tDye, backtrace(uvw, v));
  float density = adv.r * exp(-uDissipation * uDt);
  float heat = adv.g * exp(-uCooling * uDt);
  vec3 p = uvw / GRIDF;
  float n = texture(tNoise, p * 3.0 + vec3(0.0, uTime * -0.09, 0.0)).r * 0.8 + 0.5;
  for (int i = 0; i < ${FLUID_MAX_SOURCES}; i++) {
    if (i >= uSourceCount) break;
    float dist = length((uvw - uSourcePos[i].xyz) * uCell);
    float source = pow(max(1.0 - dist / uSourcePos[i].w, 0.0), 1.5);
    float rate = uSourceRate[i].x * (1.0 + uSourceRate[i].z * 6.0);
    float emission = source * n * rate * uDt * 5.0;
    density += emission;
    heat += emission * uSourceRate[i].y;
  }
  vec3 edge = min(p, vec3(1.0) - p);
  float fade = clamp(min(edge.x, min(edge.y + 0.05, edge.z)) / 0.04, 0.0, 1.0);
  density *= fade;
  heat *= fade;
  if (solid(c)) { density = 0.0; heat = 0.0; }
  outColor = vec4(min(density, 6.0), min(heat, 5.0), 0.0, 1.0);
}
`;

/**
 * Appearance: what the raymarch fetches. rgb = lit colour × density,
 * a = density, with noise detail and a four-tap self-shadow toward the sun.
 * Ember volume.js:635-690.
 */
export const APPEARANCE_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
${COMMON}
uniform sampler2D tDye;
uniform sampler3D tNoise;
uniform vec3 uLightDir;      // world, toward the sun
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uAlbedo;
out vec4 outColor;

void main() {
  ivec3 c = cellOfFrag(gl_FragCoord.xy);
  vec3 uvw = vec3(c) + 0.5;
  vec4 sample_ = cellFetch(tDye, c);
  if (sample_.r <= 0.0035 || solid(c)) { outColor = vec4(0.0); return; }
  vec3 p = uvw / GRIDF;
  vec3 np = p * 3.4 - vec3(0.0, uTime * 0.06, 0.0);
  float detail = texture(tNoise, np).r * 0.62
    + texture(tNoise, np * 2.1).r * 0.26
    + texture(tNoise, np * 4.3).r * 0.12;
  float density = max(0.0, sample_.r * max(0.0, detail * 2.5 - 0.25) - (1.0 - detail) * 0.22);
  if (density <= 0.008) { outColor = vec4(0.0); return; }
  float shadow = 0.0;
  vec3 stepUvw = uLightDir / uCell * 0.45;
  for (int j = 1; j <= 4; j++) {
    shadow += atlasSample(tDye, uvw + stepUvw * float(j)).r * 0.25;
  }
  float lighting = exp(-shadow * 0.6) * 0.85 + 0.15;
  vec3 ambient = mix(uGroundColor, uSkyColor, p.y);
  vec3 col = uAlbedo * (uSunColor * lighting * 0.45 + ambient * (0.5 + 0.5 * lighting));
  outColor = vec4(col * density, density);
}
`;

// ---------------------------------------------------------------------------
// The brick's raymarch. Same conventions as the parcel volume: BackSide box,
// camera-relative, depth-terminated, premultiplied out.
// ---------------------------------------------------------------------------

export const BRICK_VERTEX = /* glsl */ `
uniform vec3 uBrickMin;
uniform vec3 uBrickSize;
out vec3 vRay;
void main() {
  vec3 world = uBrickMin + (position + 0.5) * uBrickSize;
  vRay = world - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const BRICK_FRAGMENT = (atlas: string) => /* glsl */ `
${atlas}
precision highp float;
uniform sampler2D tAppearance;
uniform sampler2D tDepth;
uniform float uDepthScale;
uniform float uNear;
uniform float uFar;
uniform vec3 uCamForward;
uniform vec3 uBrickMin;
uniform vec3 uBrickSize;
uniform float uSteps;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uOpacity;
in vec3 vRay;
out vec4 outColor;

float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
float viewZFromDepth(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

void main() {
  vec3 ray = normalize(vRay);
  vec3 safe = vec3(
    abs(ray.x) < 1e-6 ? 1e-6 : ray.x,
    abs(ray.y) < 1e-6 ? 1e-6 : ray.y,
    abs(ray.z) < 1e-6 ? 1e-6 : ray.z);
  vec3 inv = 1.0 / safe;
  vec3 minRel = uBrickMin - cameraPosition;
  vec3 t0 = minRel * inv;
  vec3 t1 = (minRel + uBrickSize) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float enter = max(0.0, max(tmin.x, max(tmin.y, tmin.z)));
  float exitT = min(tmax.x, min(tmax.y, tmax.z));
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy * uDepthScale), 0).r;
  float rayZ = max(dot(ray, uCamForward), 1e-4);
  exitT = min(exitT, -viewZFromDepth(d) / rayZ);
  if (exitT <= enter) discard;
  float stride = (exitT - enter) / uSteps;
  float jitter = ign(gl_FragCoord.xy);
  vec3 rgb = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 96; i++) {
    if (float(i) >= uSteps || alpha > 0.985) break;
    float t = enter + (float(i) + jitter) * stride;
    vec3 uvw = (ray * t - minRel) / uBrickSize * GRIDF;
    vec4 medium = atlasSample(tAppearance, uvw);
    if (medium.a < 0.003) continue;
    float a = 1.0 - exp(-medium.a * stride * 0.8 * uOpacity);
    vec3 col = medium.rgb / max(medium.a, 0.0001);
    float viewDepth = t * rayZ;
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * viewDepth * viewDepth);
    col = mix(col, uFogColor, fog);
    rgb += col * a * (1.0 - alpha);
    alpha += a * (1.0 - alpha);
  }
  outColor = vec4(rgb, alpha);
}
`;
