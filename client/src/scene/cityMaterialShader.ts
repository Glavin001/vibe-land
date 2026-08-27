// Triplanar concrete for the city, projected from each chunk's REST pose --
// and, on the hero variant, stochastically re-tiled so the projection does not
// read as a grid of repeated stains.
//
// The rest-space part first, because everything else builds on it. Every chunk
// is its own instance before anything hits it, geometry is shared between
// thousands of chunks, and shards arrive as bare point clouds with no UVs. So:
//
//   - Object-space mapping would give every shard its own copy of the texture,
//     and an intact wall would read as a mosaic of pre-broken panels.
//   - World-space mapping from the CURRENT pose looks right until something
//     breaks, and then the texture swims across a tumbling shard.
//
// Each instance carries the world position it was BUILT at, and the shader
// reconstructs `anchor + restScale * position`. That coordinate never mentions
// the live pose: neighbouring chunks in a standing wall sample one continuous
// surface, and a chunk that breaks free keeps exactly the texels it had while
// embedded. Fracture-invariance falls out of the coordinate system rather than
// being enforced anywhere. The Y projection samples a FLOOR layer while X and
// Z sample a WALL layer, so slab tops and rubble stop wearing wall grain.
//
// THE HERO STACK, ported from the Anti-Tiling Lab reference the user supplied,
// fitted to a triplanar array material and a 120 fps budget:
//
//   1. Hex 3-tap stochastic retiling. A triangular lattice over each
//      projection's UV plane gives every lattice cell a random transform --
//      phase offset, rotation (free angle), mirror, scale jitter -- and each
//      pixel blends the three nearest variants. This is what kills "the same
//      stain every two metres in a grid".
//   2. Detail-aware blending. The bake packs each texel's HEIGHT into the
//      albedo alpha; tap weights are biased toward the tap with stronger local
//      relief, so blends resolve crisply instead of ghosting.
//   3. Variance preservation. A linear N-tap blend loses contrast (variance
//      sums as w-squared); contrast is restored around the layer's mean
//      albedo, which the bake computes per layer.
//   4. A 3-band world-space macro field -- three taps of a small tileable
//      noise texture -- modulates albedo, warm/cool tone, roughness and
//      normal response at building scale. This is what kills "this whole
//      facade is one material".
//   5. Distance FADE, not the lab's distance re-tiling. The lab doubles its
//      taps far away; here the hex blend fades to a single plain tap instead,
//      because macro variation, mip blur and fog already hide repetition at
//      range -- so the stack gets CHEAPER exactly where pixels are most
//      numerous.
//
// What makes it affordable: the triplanar weights are pow-6 sharpened and city
// geometry is overwhelmingly flat, so ONE plane dominates almost every pixel.
// Planes whose weight reaches zero (a continuous max(w - cutoff, 0), so there
// is no popping) are skipped entirely -- every derivative is computed before
// any branch and all taps use textureGrad, which is what makes the branching
// legal. A typical near pixel therefore pays 3 albedo + 3 surface taps: the
// SAME budget as the pre-hero shader, which paid 3 + 3 across planes it did
// not need. Directional layers (formwork strata) get their rotation zeroed per
// layer by the bake's `directional` flag, because a 90-degree pour line is not
// variation, it is a mistake.

import * as THREE from 'three';

import {
  CITY_TEX_LAYERS,
  CITY_TEX_MEANS,
  CITY_TEX_METRES,
  CITY_TEX_ROTATION,
  GROUND_LAYER_COUNT,
  GROUND_LAYER_START,
  LAYER_CODE_RADIX,
  cityMacroNoise,
  cityTextures,
} from './cityTextures';

/**
 * How sharply one projection wins over its neighbours.
 *
 * City geometry is overwhelmingly flat faces meeting at hard edges, so a soft
 * blend only shows up as a smeared band along every edge. High enough to keep
 * faces crisp, low enough that a shard's slanted cut face still cross-fades.
 */
const BLEND_SHARPNESS = 6.0;

/**
 * Weight below which a projection is skipped outright.
 *
 * Applied as a continuous `max(w - cutoff, 0)` before renormalising, so the
 * skipped plane's contribution reaches zero BEFORE the branch stops taking it
 * -- no popping at the boundary. This is the whole performance story of the
 * hero stack: it triples the per-plane taps, and this confines "per-plane" to
 * the one plane a flat face actually uses.
 */
const PLANE_CUTOFF = 0.02;

/**
 * Live tuning handles, shared by every material this module builds.
 *
 * One object per uniform, referenced (not copied) into each compiled shader --
 * three reads `shader.uniforms[name].value` at upload time, so mutating these
 * retunes the whole city without a recompile. Exposed on `window` because
 * picking these is a look-at-it decision, not a computable one.
 */
const uniforms = {
  cityAlbedo: { value: null as THREE.DataArrayTexture | null },
  citySurface: { value: null as THREE.DataArrayTexture | null },
  cityMacroTex: { value: null as THREE.DataTexture | null },
  cityTexMetres: { value: CITY_TEX_METRES },
  cityTexMean: { value: CITY_TEX_MEANS },
  cityTexRot: { value: CITY_TEX_ROTATION },
  /**
   * Multiplies every layer's authored tile size. 1 = real-world scale.
   *
   * Above 1 deliberately: at true scale a 1 m texture repeats once per metre up
   * a twenty-storey facade, and regular repetition at that frequency reads as a
   * pattern rather than as concrete. 2.0 chosen off the tuning sweep; with the
   * hero stack hiding repetition the pressure to go coarser is gone.
   */
  cityTexScale: { value: 2.0 },
  cityNormalScale: { value: 1.0 },
  /**
   * Overall tone, multiplied over every layer. Poly Haven diffuse maps are
   * captured under flat neutral light and read as sandstone at 1.0 under this
   * sky; 0.88 off the tuning sweep.
   */
  cityTone: { value: new THREE.Color(0.88, 0.88, 0.88) },

  // --- hero stack ---------------------------------------------------------
  /** Hex lattice pitch, in tiles of the layer being sampled. */
  cityPatchTiles: { value: 1.6 },
  /** How far a variant's phase offset wanders, in tiles. */
  cityPhaseJitter: { value: 1.0 },
  /** Free-angle rotation amount; multiplied by the per-layer directional mask. */
  cityRotAmount: { value: 0.8 },
  cityMirrorProb: { value: 0.5 },
  cityScaleJitter: { value: 0.06 },
  /** Per-lattice-cell brightness wobble, +/- stops. */
  cityCellTint: { value: 0.04 },
  /** Sharpness of the 3-tap blend; higher = tighter borders between variants. */
  cityBlendExp: { value: 2.6 },
  /** Height bias: how strongly the taller tap wins a blend. */
  cityHeightBias: { value: 4.0 },
  cityVariancePreserve: { value: 0.8 },
  /** View distance over which the hex blend fades to one plain tap. */
  cityHexFadeStart: { value: 45.0 },
  cityHexFadeEnd: { value: 75.0 },
  /** Macro field: band size in metres, and how hard it drives each channel. */
  cityMacroSize: { value: 9.0 },
  cityMacroAlbedo: { value: 0.16 },
  cityMacroRough: { value: 0.1 },
  cityMacroNormal: { value: 0.12 },
  cityMacroTemp: { value: 0.03 },
  cityMacroMid: { value: 0.42 },
  cityMacroSmall: { value: 0.2 },
};

export function setCityTextureTuning(next: {
  scale?: number;
  normalScale?: number;
  tone?: number | [number, number, number];
  patchTiles?: number;
  phaseJitter?: number;
  rotAmount?: number;
  mirrorProb?: number;
  scaleJitter?: number;
  cellTint?: number;
  blendExp?: number;
  heightBias?: number;
  variancePreserve?: number;
  hexFadeStart?: number;
  hexFadeEnd?: number;
  macroSize?: number;
  macroAlbedo?: number;
  macroRough?: number;
  macroNormal?: number;
  macroTemp?: number;
  macroMid?: number;
  macroSmall?: number;
}): void {
  if (next.scale !== undefined) uniforms.cityTexScale.value = next.scale;
  if (next.normalScale !== undefined) uniforms.cityNormalScale.value = next.normalScale;
  if (typeof next.tone === 'number') uniforms.cityTone.value.setScalar(next.tone);
  else if (next.tone) uniforms.cityTone.value.setRGB(next.tone[0], next.tone[1], next.tone[2]);
  const scalars: Array<[keyof typeof next, { value: number }]> = [
    ['patchTiles', uniforms.cityPatchTiles],
    ['phaseJitter', uniforms.cityPhaseJitter],
    ['rotAmount', uniforms.cityRotAmount],
    ['mirrorProb', uniforms.cityMirrorProb],
    ['scaleJitter', uniforms.cityScaleJitter],
    ['cellTint', uniforms.cityCellTint],
    ['blendExp', uniforms.cityBlendExp],
    ['heightBias', uniforms.cityHeightBias],
    ['variancePreserve', uniforms.cityVariancePreserve],
    ['hexFadeStart', uniforms.cityHexFadeStart],
    ['hexFadeEnd', uniforms.cityHexFadeEnd],
    ['macroSize', uniforms.cityMacroSize],
    ['macroAlbedo', uniforms.cityMacroAlbedo],
    ['macroRough', uniforms.cityMacroRough],
    ['macroNormal', uniforms.cityMacroNormal],
    ['macroTemp', uniforms.cityMacroTemp],
    ['macroMid', uniforms.cityMacroMid],
    ['macroSmall', uniforms.cityMacroSmall],
  ];
  for (const [key, uniform] of scalars) {
    const value = next[key];
    if (typeof value === 'number' && Number.isFinite(value)) uniform.value = value;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__VIBE_CITY_TEX__ = setCityTextureTuning;
}

/**
 * Where the rest-space coordinate comes from, per render path.
 *
 * An InstancedMesh shares one geometry across its instances, so the anchor has
 * to be a per-instance attribute and the vertex offset is rebuilt from the
 * chunk's rest scale. A BatchedMesh has no per-instance attribute channel at
 * all, so `buildCellHullBatch` bakes the absolute rest position into each
 * instance's own copy of the vertices instead -- which is why the batched
 * branch needs no scale term.
 */
const VERTEX_PARS = `
varying vec3 vCityTexPos;
flat varying float vCityLayer;
#if defined( USE_BATCHING )
  attribute vec4 cityAnchor;
#elif defined( USE_INSTANCING )
  attribute vec4 cityAnchor;
  attribute vec3 cityRestScale;
#endif
`;

const VERTEX_PARS_PBR = `
flat varying vec3 vCityAxisX;
flat varying vec3 vCityAxisY;
`;

const VERTEX_BODY = `
#if defined( USE_BATCHING )
  vCityTexPos = cityAnchor.xyz;
  vCityLayer = cityAnchor.w;
#elif defined( USE_INSTANCING )
  vCityTexPos = cityAnchor.xyz + cityRestScale * position;
  vCityLayer = cityAnchor.w;
#else
  vCityTexPos = position;
  vCityLayer = 0.0;
#endif
`;

/**
 * The instance's own axes, in view space, so the fragment stage can rotate a
 * rest-space normal into the space three lights in. `flat`, guarded against
 * the zero-scale hide path producing NaN.
 */
const VERTEX_BODY_PBR = `
#if defined( USE_BATCHING )
  mat4 cityModel = batchingMatrix;
#elif defined( USE_INSTANCING )
  mat4 cityModel = instanceMatrix;
#else
  mat4 cityModel = mat4( 1.0 );
#endif
vec3 cityAxX = ( modelViewMatrix * cityModel * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz;
vec3 cityAxY = ( modelViewMatrix * cityModel * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
vCityAxisX = cityAxX / max( length( cityAxX ), 1e-8 );
vCityAxisY = cityAxY / max( length( cityAxY ), 1e-8 );
`;

/**
 * The hero stack's GLSL, shared verbatim by the city material and the ground
 * material -- one copy so the two cannot drift. Every function reads the same
 * uniform objects, so one tuning retunes both surfaces.
 */
const HERO_UNIFORM_PARS = `
uniform sampler2D cityMacroTex;
uniform vec3 cityTexMean[ ${CITY_TEX_LAYERS} ];
uniform float cityTexRot[ ${CITY_TEX_LAYERS} ];
uniform float cityPatchTiles;
uniform float cityPhaseJitter;
uniform float cityRotAmount;
uniform float cityMirrorProb;
uniform float cityScaleJitter;
uniform float cityCellTint;
uniform float cityBlendExp;
uniform float cityHeightBias;
uniform float cityVariancePreserve;
uniform float cityHexFadeStart;
uniform float cityHexFadeEnd;
uniform float cityMacroSize;
uniform float cityMacroAlbedo;
uniform float cityMacroRough;
uniform float cityMacroNormal;
uniform float cityMacroTemp;
uniform float cityMacroMid;
uniform float cityMacroSmall;

`;

const HERO_HELPERS = `
vec4 cityHash4( vec2 p ) {
  return fract( sin( vec4(
    1.0 + dot( p, vec2( 37.0, 17.0 ) ),
    2.0 + dot( p, vec2( 11.0, 47.0 ) ),
    3.0 + dot( p, vec2( 41.0, 29.0 ) ),
    4.0 + dot( p, vec2( 23.0, 31.0 ) ) ) ) * 103.0 );
}

// Barycentric weights and vertex ids of the triangle containing st, on a
// triangular lattice -- the hex-tiling foundation, straight from the lab.
void cityTriGrid( vec2 st, out vec3 w, out vec2 v0, out vec2 v1, out vec2 v2 ) {
  st *= 3.46410161514;
  vec2 skew = vec2( st.x - 0.57735026919 * st.y, 1.15470053838 * st.y );
  vec2 baseId = floor( skew );
  vec3 temp = vec3( fract( skew ), 0.0 );
  temp.z = 1.0 - temp.x - temp.y;
  float sel = step( 0.0, -temp.z );
  float s2 = 2.0 * sel - 1.0;
  w = vec3( -temp.z * s2, sel - temp.y * s2, sel - temp.x * s2 );
  v0 = baseId + vec2( sel, sel );
  v1 = baseId + vec2( sel, 1.0 - sel );
  v2 = baseId + vec2( 1.0 - sel, sel );
}

// One lattice vertex's random transform of the uv plane: rotation (scaled by
// the layer's directional mask), mirror, scale jitter, phase offset. tr packs
// (cos, sin, mirror, scale) so normals can be counter-transformed later.
void cityVariant(
  vec2 uv, vec2 dx, vec2 dy, vec4 h, float rotAllow,
  out vec2 suv, out vec2 sdx, out vec2 sdy, out vec4 tr
) {
  float angle = ( h.z * 2.0 - 1.0 ) * 3.14159265359 * cityRotAmount * rotAllow;
  float c = cos( angle );
  float s = sin( angle );
  float mirror = mix( 1.0, -1.0, step( h.w, cityMirrorProb ) );
  float sc = max( 0.6, 1.0 + ( h.x * 2.0 - 1.0 ) * cityScaleJitter );
  vec2 q = vec2( uv.x * mirror, uv.y );
  vec2 qx = vec2( dx.x * mirror, dx.y );
  vec2 qy = vec2( dy.x * mirror, dy.y );
  suv = sc * vec2( c * q.x - s * q.y, s * q.x + c * q.y ) + h.xy * cityPhaseJitter;
  sdx = sc * vec2( c * qx.x - s * qx.y, s * qx.x + c * qx.y );
  sdy = sc * vec2( c * qy.x - s * qy.y, s * qy.x + c * qy.y );
  tr = vec4( c, s, mirror, sc );
}

// Undo a variant's transform on a sampled tangent normal, so rotated variants
// light correctly instead of shading against their own rotation.
vec2 cityOrient( vec2 n, vec4 tr ) {
  vec2 q = vec2( tr.x * n.x + tr.y * n.y, -tr.y * n.x + tr.x * n.y );
  q.x *= tr.z;
  return q * tr.w;
}

struct CityPlane {
  vec3 albedo;
  vec2 nxy;
  float rough;
  float ao;
};

// One projection plane's full hero sample: hex 3-tap albedo + surface with
// detail-aware weights, variance preservation and cell tint, cross-faded to a
// single plain tap by hexFade (1 = full hex near, 0 = one tap far).
CityPlane citySamplePlane(
  vec2 uv, vec2 dx, vec2 dy, float layer, float rotAllow, vec3 mean, float hexFade
) {
  CityPlane o;
  if ( hexFade > 0.001 ) {
    vec3 w;
    vec2 c0, c1, c2;
    cityTriGrid( uv * ( 0.28867513459 / max( cityPatchTiles, 0.02 ) ), w, c0, c1, c2 );
    vec4 h0 = cityHash4( c0 );
    vec4 h1 = cityHash4( c1 );
    vec4 h2 = cityHash4( c2 );
    vec2 uv0, dx0, dy0, uv1, dx1, dy1, uv2, dx2, dy2;
    vec4 tr0, tr1, tr2;
    cityVariant( uv, dx, dy, h0, rotAllow, uv0, dx0, dy0, tr0 );
    cityVariant( uv, dx, dy, h1, rotAllow, uv1, dx1, dy1, tr1 );
    cityVariant( uv, dx, dy, h2, rotAllow, uv2, dx2, dy2, tr2 );
    w = pow( max( w, vec3( 1e-4 ) ), vec3( cityBlendExp ) );
    w /= max( w.x + w.y + w.z, 1e-5 );

    vec4 a0 = textureGrad( cityAlbedo, vec3( uv0, layer ), dx0, dy0 );
    vec4 a1 = textureGrad( cityAlbedo, vec3( uv1, layer ), dx1, dy1 );
    vec4 a2 = textureGrad( cityAlbedo, vec3( uv2, layer ), dx2, dy2 );
    // Alpha is height, top-half remapped by the bake: h = (a - 0.5) * 2.
    vec3 hh = ( vec3( a0.a, a1.a, a2.a ) - 0.5 ) * 2.0;
    w *= exp2( ( hh - 0.5 ) * cityHeightBias );
    w /= max( w.x + w.y + w.z, 1e-5 );

    vec3 albedo = a0.rgb * w.x + a1.rgb * w.y + a2.rgb * w.z;
    albedo *= exp2( ( dot( h0, vec4( 0.25 ) ) - 0.5 ) * 2.0 * cityCellTint );
    float gain = inversesqrt( max( dot( w, w ), 1e-4 ) );
    albedo = mean + ( albedo - mean ) * mix( 1.0, gain, cityVariancePreserve );

    vec4 s0 = textureGrad( citySurface, vec3( uv0, layer ), dx0, dy0 );
    vec4 s1 = textureGrad( citySurface, vec3( uv1, layer ), dx1, dy1 );
    vec4 s2 = textureGrad( citySurface, vec3( uv2, layer ), dx2, dy2 );
    vec2 n0 = cityOrient( s0.rg * 2.0 - 1.0, tr0 );
    vec2 n1 = cityOrient( s1.rg * 2.0 - 1.0, tr1 );
    vec2 n2 = cityOrient( s2.rg * 2.0 - 1.0, tr2 );

    o.albedo = albedo;
    o.nxy = n0 * w.x + n1 * w.y + n2 * w.z;
    o.rough = dot( vec3( s0.b, s1.b, s2.b ), w );
    o.ao = dot( vec3( s0.a, s1.a, s2.a ), w );
    if ( hexFade < 0.999 ) {
      vec4 pa = textureGrad( cityAlbedo, vec3( uv, layer ), dx, dy );
      vec4 ps = textureGrad( citySurface, vec3( uv, layer ), dx, dy );
      o.albedo = mix( pa.rgb, o.albedo, hexFade );
      o.nxy = mix( ps.rg * 2.0 - 1.0, o.nxy, hexFade );
      o.rough = mix( ps.b, o.rough, hexFade );
      o.ao = mix( ps.a, o.ao, hexFade );
    }
  } else {
    vec4 pa = textureGrad( cityAlbedo, vec3( uv, layer ), dx, dy );
    vec4 ps = textureGrad( citySurface, vec3( uv, layer ), dx, dy );
    o.albedo = pa.rgb;
    o.nxy = ps.rg * 2.0 - 1.0;
    o.rough = ps.b;
    o.ao = ps.a;
  }
  return o;
}

mat2 cityRot2( float a ) {
  float c = cos( a );
  float s = sin( a );
  return mat2( c, s, -s, c );
}

// Three octave bands of the tileable noise, in world metres. Low frequency by
// construction, so three taps of a 256^2 texture that lives in cache.
float cityMacroField( vec2 metres ) {
  float a = texture( cityMacroTex, metres / cityMacroSize ).r;
  float b = texture( cityMacroTex, cityRot2( 0.71 ) * metres / ( cityMacroSize * 0.37 ) + vec2( 0.17, 0.61 ) ).r;
  float c = texture( cityMacroTex, cityRot2( -0.43 ) * metres / ( cityMacroSize * 0.145 ) + vec2( 0.73, 0.29 ) ).r;
  return ( a + b * cityMacroMid + c * cityMacroSmall ) / max( 1.0 + cityMacroMid + cityMacroSmall, 1e-4 );
}
`;

function fragmentPars(surface: boolean, hero: boolean): string {
  return `
uniform highp sampler2DArray cityAlbedo;
uniform float cityTexMetres[ ${CITY_TEX_LAYERS} ];
uniform float cityTexScale;
uniform vec3 cityTone;
varying vec3 vCityTexPos;
flat varying float vCityLayer;
${surface ? `
uniform highp sampler2DArray citySurface;
uniform float cityNormalScale;
flat varying vec3 vCityAxisX;
flat varying vec3 vCityAxisY;
` : ''}
${hero ? `
${HERO_UNIFORM_PARS}
${HERO_HELPERS}
` : ''}
`;
}

/**
 * Replaces `<map_fragment>` on the HERO variant: plane-branched hex sampling,
 * plus the macro field.
 *
 * All derivatives (`cityDx/cityDy` and every per-plane gradient derived from
 * them) are computed before the first branch; everything inside the branches
 * samples with `textureGrad`. That is the discipline that makes the plane
 * skipping legal -- implicit-derivative taps in divergent control flow are
 * undefined behaviour.
 */
const MAP_FRAGMENT_HERO = `
vec3 cityDx = dFdx( vCityTexPos );
vec3 cityDy = dFdy( vCityTexPos );
vec3 cityGeoN = cross( cityDx, cityDy );
cityGeoN /= max( length( cityGeoN ), 1e-8 );
vec3 cityBlend = pow( abs( cityGeoN ), vec3( ${BLEND_SHARPNESS.toFixed(1)} ) );
cityBlend = max( cityBlend - ${PLANE_CUTOFF.toFixed(3)}, vec3( 0.0 ) );
cityBlend /= max( cityBlend.x + cityBlend.y + cityBlend.z, 1e-5 );

float cityFloorLayer = floor( vCityLayer / ${LAYER_CODE_RADIX}.0 );
float cityWallLayer = vCityLayer - cityFloorLayer * ${LAYER_CODE_RADIX}.0;
float cityWallM = cityTexMetres[ int( cityWallLayer ) ] * cityTexScale;
float cityFloorM = cityTexMetres[ int( cityFloorLayer ) ] * cityTexScale;
float cityWallRot = cityTexRot[ int( cityWallLayer ) ];
float cityFloorRot = cityTexRot[ int( cityFloorLayer ) ];
vec3 cityWallMean = cityTexMean[ int( cityWallLayer ) ];
vec3 cityFloorMean = cityTexMean[ int( cityFloorLayer ) ];

vec2 cityUvX = vCityTexPos.zy / cityWallM;
vec2 cityUvY = vCityTexPos.xz / cityFloorM;
vec2 cityUvZ = vCityTexPos.xy / cityWallM;

float cityHexFade = 1.0 - smoothstep( cityHexFadeStart, cityHexFadeEnd, length( vViewPosition ) );

CityPlane cityPx = CityPlane( vec3( 0.0 ), vec2( 0.0 ), 0.0, 0.0 );
CityPlane cityPy = cityPx;
CityPlane cityPz = cityPx;
float cityMacro = 0.5;
{
  float macroAcc = 0.0;
  if ( cityBlend.x > 0.0 ) {
    cityPx = citySamplePlane( cityUvX, cityDx.zy / cityWallM, cityDy.zy / cityWallM,
      cityWallLayer, cityWallRot, cityWallMean, cityHexFade );
    macroAcc += cityMacroField( vCityTexPos.zy ) * cityBlend.x;
  }
  if ( cityBlend.y > 0.0 ) {
    cityPy = citySamplePlane( cityUvY, cityDx.xz / cityFloorM, cityDy.xz / cityFloorM,
      cityFloorLayer, cityFloorRot, cityFloorMean, cityHexFade );
    macroAcc += cityMacroField( vCityTexPos.xz ) * cityBlend.y;
  }
  if ( cityBlend.z > 0.0 ) {
    cityPz = citySamplePlane( cityUvZ, cityDx.xy / cityWallM, cityDy.xy / cityWallM,
      cityWallLayer, cityWallRot, cityWallMean, cityHexFade );
    macroAcc += cityMacroField( vCityTexPos.xy ) * cityBlend.z;
  }
  cityMacro = macroAcc;
}
float cityMacroSigned = cityMacro * 2.0 - 1.0;

vec3 cityAlbedoBlend =
    cityPx.albedo * cityBlend.x
  + cityPy.albedo * cityBlend.y
  + cityPz.albedo * cityBlend.z;
cityAlbedoBlend *= exp2( cityMacroSigned * cityMacroAlbedo );
cityAlbedoBlend *= mix(
  vec3( 1.0 - cityMacroTemp * 0.65, 1.0, 1.0 + cityMacroTemp ),
  vec3( 1.0 + cityMacroTemp, 1.0, 1.0 - cityMacroTemp * 0.72 ),
  cityMacro );
diffuseColor.rgb *= cityTone * cityAlbedoBlend;

float cityRoughness = clamp(
  dot( vec3( cityPx.rough, cityPy.rough, cityPz.rough ), cityBlend )
  + cityMacroSigned * cityMacroRough, 0.05, 1.0 );
float cityOcclusion = dot( vec3( cityPx.ao, cityPy.ao, cityPz.ao ), cityBlend );
float cityNormGain = cityNormalScale * max( 0.05, 1.0 + cityMacroSigned * cityMacroNormal );
vec2 cityNx = cityPx.nxy * cityNormGain;
vec2 cityNy = cityPy.nxy * cityNormGain;
vec2 cityNz = cityPz.nxy * cityNormGain;
`;

/** The pre-hero map fragment: kept verbatim as the A/B baseline ("plain"). */
function mapFragmentPlain(surface: boolean): string {
  return `
vec3 cityDx = dFdx( vCityTexPos );
vec3 cityDy = dFdy( vCityTexPos );
vec3 cityGeoN = cross( cityDx, cityDy );
cityGeoN /= max( length( cityGeoN ), 1e-8 );
vec3 cityBlend = pow( abs( cityGeoN ), vec3( ${BLEND_SHARPNESS.toFixed(1)} ) );
cityBlend /= max( cityBlend.x + cityBlend.y + cityBlend.z, 1e-5 );

float cityFloorLayer = floor( vCityLayer / ${LAYER_CODE_RADIX}.0 );
float cityWallLayer = vCityLayer - cityFloorLayer * ${LAYER_CODE_RADIX}.0;
float cityWallM = cityTexMetres[ int( cityWallLayer ) ] * cityTexScale;
float cityFloorM = cityTexMetres[ int( cityFloorLayer ) ] * cityTexScale;

vec2 cityUvX = vCityTexPos.zy / cityWallM;
vec2 cityUvY = vCityTexPos.xz / cityFloorM;
vec2 cityUvZ = vCityTexPos.xy / cityWallM;

diffuseColor.rgb *= cityTone * (
    texture( cityAlbedo, vec3( cityUvX, cityWallLayer ) ).rgb * cityBlend.x
  + texture( cityAlbedo, vec3( cityUvY, cityFloorLayer ) ).rgb * cityBlend.y
  + texture( cityAlbedo, vec3( cityUvZ, cityWallLayer ) ).rgb * cityBlend.z );
${surface ? `
vec4 citySurfX = texture( citySurface, vec3( cityUvX, cityWallLayer ) );
vec4 citySurfY = texture( citySurface, vec3( cityUvY, cityFloorLayer ) );
vec4 citySurfZ = texture( citySurface, vec3( cityUvZ, cityWallLayer ) );
float cityRoughness = dot( vec3( citySurfX.b, citySurfY.b, citySurfZ.b ), cityBlend );
float cityOcclusion = dot( vec3( citySurfX.a, citySurfY.a, citySurfZ.a ), cityBlend );
vec2 cityNx = ( citySurfX.rg * 2.0 - 1.0 ) * cityNormalScale;
vec2 cityNy = ( citySurfY.rg * 2.0 - 1.0 ) * cityNormalScale;
vec2 cityNz = ( citySurfZ.rg * 2.0 - 1.0 ) * cityNormalScale;
` : ''}
`;
}

/**
 * Replaces `<normal_fragment_maps>`: the whiteout triplanar normal blend.
 *
 * Shared by both variants -- each expects `cityNx/cityNy/cityNz` to hold the
 * (already scaled, already variant-oriented on hero) per-plane tangent
 * normals. Each projection's normal is folded into rest space and summed by
 * the plane weights; a shared tangent frame would misorient Y and Z.
 */
const NORMAL_FRAGMENT = `
mat3 cityToView = mat3( vCityAxisX, vCityAxisY, cross( vCityAxisX, vCityAxisY ) );
float cityFacing = dot( cityToView * cityGeoN, normal ) < 0.0 ? -1.0 : 1.0;
vec3 cityN = cityGeoN * cityFacing;

vec3 cityTx = vec3( cityNx, sqrt( max( 1.0 - dot( cityNx, cityNx ), 0.0 ) ) );
vec3 cityTy = vec3( cityNy, sqrt( max( 1.0 - dot( cityNy, cityNy ), 0.0 ) ) );
vec3 cityTz = vec3( cityNz, sqrt( max( 1.0 - dot( cityNz, cityNz ), 0.0 ) ) );

vec3 cityWx = vec3( cityTx.xy + cityN.zy, abs( cityTx.z ) * cityN.x ).zyx;
vec3 cityWy = vec3( cityTy.xy + cityN.xz, abs( cityTy.z ) * cityN.y ).xzy;
vec3 cityWz = vec3( cityTz.xy + cityN.xy, abs( cityTz.z ) * cityN.z ).xyz;
vec3 cityObjN = cityWx * cityBlend.x + cityWy * cityBlend.y + cityWz * cityBlend.z;

normal = normalize( cityToView * normalize( cityObjN ) );
`;

/** Replaces `<roughnessmap_fragment>`; `roughness` is left at 1 by the factory. */
const ROUGHNESS_FRAGMENT = `
float roughnessFactor = roughness * cityRoughness;
`;

/**
 * Replaces `<aomap_fragment>`. The specular branch matters now that
 * `SkyEnvironment` binds a PMREM as scene.environment.
 */
const AO_FRAGMENT = `
reflectedLight.indirectDiffuse *= cityOcclusion;

#if defined( USE_ENVMAP ) && defined( STANDARD )
  float cityDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(
    cityDotNV, cityOcclusion, material.roughness );
#endif
`;

/**
 * Attach the triplanar injection to a city material.
 *
 * Must be applied by whatever CREATES the material. `Material.clone()` copies
 * no function properties, so a cloned city material silently loses this and
 * renders untextured with no error anywhere.
 */
export function applyCityTriplanar(
  material: THREE.Material,
  pbr: boolean,
  detail: 'full' | 'albedo' | 'off' = 'full',
  hero = true,
): void {
  if (detail === 'off') {
    // Nothing injected at all: the point of `off` is to not SAMPLE, so the
    // material has to compile without the taps rather than multiply them away.
    material.customProgramCacheKey = () => 'city-untextured-v1';
    return;
  }
  const surface = pbr && detail === 'full';
  // The hero stack needs the surface array (its detail-aware and normal work
  // lives there), so the FAST/albedo tier keeps the plain path regardless.
  const heroActive = hero && surface;
  const textures = cityTextures();
  uniforms.cityAlbedo.value = textures.albedo;
  uniforms.citySurface.value = textures.surface;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.cityAlbedo = uniforms.cityAlbedo;
    shader.uniforms.cityTexMetres = uniforms.cityTexMetres;
    shader.uniforms.cityTexScale = uniforms.cityTexScale;
    shader.uniforms.cityTone = uniforms.cityTone;
    if (surface) {
      shader.uniforms.citySurface = uniforms.citySurface;
      shader.uniforms.cityNormalScale = uniforms.cityNormalScale;
    }
    if (heroActive) {
      uniforms.cityMacroTex.value = cityMacroNoise();
      shader.uniforms.cityMacroTex = uniforms.cityMacroTex;
      shader.uniforms.cityTexMean = uniforms.cityTexMean;
      shader.uniforms.cityTexRot = uniforms.cityTexRot;
      shader.uniforms.cityPatchTiles = uniforms.cityPatchTiles;
      shader.uniforms.cityPhaseJitter = uniforms.cityPhaseJitter;
      shader.uniforms.cityRotAmount = uniforms.cityRotAmount;
      shader.uniforms.cityMirrorProb = uniforms.cityMirrorProb;
      shader.uniforms.cityScaleJitter = uniforms.cityScaleJitter;
      shader.uniforms.cityCellTint = uniforms.cityCellTint;
      shader.uniforms.cityBlendExp = uniforms.cityBlendExp;
      shader.uniforms.cityHeightBias = uniforms.cityHeightBias;
      shader.uniforms.cityVariancePreserve = uniforms.cityVariancePreserve;
      shader.uniforms.cityHexFadeStart = uniforms.cityHexFadeStart;
      shader.uniforms.cityHexFadeEnd = uniforms.cityHexFadeEnd;
      shader.uniforms.cityMacroSize = uniforms.cityMacroSize;
      shader.uniforms.cityMacroAlbedo = uniforms.cityMacroAlbedo;
      shader.uniforms.cityMacroRough = uniforms.cityMacroRough;
      shader.uniforms.cityMacroNormal = uniforms.cityMacroNormal;
      shader.uniforms.cityMacroTemp = uniforms.cityMacroTemp;
      shader.uniforms.cityMacroMid = uniforms.cityMacroMid;
      shader.uniforms.cityMacroSmall = uniforms.cityMacroSmall;
    }

    shader.vertexShader = (VERTEX_PARS + (surface ? VERTEX_PARS_PBR : '')) + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + VERTEX_BODY + (surface ? VERTEX_BODY_PBR : ''),
    );

    shader.fragmentShader = fragmentPars(surface, heroActive) + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      heroActive ? MAP_FRAGMENT_HERO : mapFragmentPlain(surface),
    );
    if (surface) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
        .replace('#include <normal_fragment_maps>', NORMAL_FRAGMENT)
        .replace('#include <aomap_fragment>', AO_FRAGMENT);
    }
  };

  // A constant, because the default key is `onBeforeCompile.toString()`. Bump
  // the version when the injected GLSL changes, or a warm cache serves stale.
  material.customProgramCacheKey = () => {
    if (heroActive) return 'city-triplanar-hero-v2';
    return surface ? 'city-triplanar-pbr-v2' : 'city-triplanar-flat-v2';
  };
}


// ---------------------------------------------------------------------------
// The ground: the same sheets, the same hero stack, one projection.
// ---------------------------------------------------------------------------

/**
 * Extra knobs for the ground blend, live like everything else.
 *
 * `dirtPatch*` shape the macro-driven dirt mask: on the flat city world the
 * splatmap is pure grass (the auto-splat keys on slope and height, and there
 * is neither), so worn patches have to come from the macro field. Threshold
 * and width are smoothstep edges over that field.
 */
const groundUniforms = {
  groundDirtStart: { value: 0.56 },
  groundDirtEnd: { value: 0.72 },
};

export function setGroundTuning(next: { dirtStart?: number; dirtEnd?: number }): void {
  if (typeof next.dirtStart === 'number') groundUniforms.groundDirtStart.value = next.dirtStart;
  if (typeof next.dirtEnd === 'number') groundUniforms.groundDirtEnd.value = next.dirtEnd;
}

const GROUND_VERTEX_PARS = `
varying vec2 vGroundPos;
varying vec4 vGroundW;
attribute vec4 materialWeights;
`;

/** Terrain tile positions ARE world coordinates -- the builder writes them so. */
const GROUND_VERTEX_BODY = `
vGroundPos = position.xz;
vGroundW = materialWeights;
`;

function groundFragmentPars(surface: boolean, hero: boolean): string {
  return `
uniform highp sampler2DArray cityAlbedo;
uniform float cityTexMetres[ ${CITY_TEX_LAYERS} ];
uniform float cityTexScale;
uniform vec3 cityTone;
uniform float groundDirtStart;
uniform float groundDirtEnd;
varying vec2 vGroundPos;
varying vec4 vGroundW;
${surface ? `
uniform highp sampler2DArray citySurface;
uniform float cityNormalScale;
` : ''}
${hero ? HERO_UNIFORM_PARS + HERO_HELPERS : ''}
`;
}

/**
 * Replaces `<map_fragment>` on the terrain.
 *
 * One projection (world XZ -- the heightfield is gentle, and stretching on
 * the rare steep lip is cheaper than tripling every ground pixel's taps), two
 * layers: grass, and a dirt/leaf-litter layer keyed by the splatmap's
 * non-grass channels PLUS a macro-field mask, because the flat city world's
 * auto-splat is pure grass. Each side of the blend is skipped entirely when
 * its weight is pinned, so a typical pixel pays one layer's taps; the
 * transition bands pay both, and they are exactly the places the money shows.
 */
function groundMapFragment(surface: boolean, hero: boolean): string {
  const ga = GROUND_LAYER_START;
  const gb = GROUND_LAYER_START + (GROUND_LAYER_COUNT > 1 ? 1 : 0);
  const meanA = `cityTexMean[ ${ga} ]`;
  const meanB = `cityTexMean[ ${gb} ]`;
  return `
vec2 groundDx = dFdx( vGroundPos );
vec2 groundDy = dFdy( vGroundPos );
float groundAM = cityTexMetres[ ${ga} ] * cityTexScale;
float groundBM = cityTexMetres[ ${gb} ] * cityTexScale;
${hero ? `
float groundHexFade = 1.0 - smoothstep( cityHexFadeStart, cityHexFadeEnd, length( vViewPosition ) );
// A second, larger read of the macro field drives WHERE the dirt lives; the
// ordinary read still modulates tone within each material.
float groundPatch = cityMacroField( vGroundPos * 0.31 );
float groundDirt = clamp(
  vGroundW.y + vGroundW.z + vGroundW.w
  + smoothstep( groundDirtStart, groundDirtEnd, groundPatch ), 0.0, 1.0 );
float groundMacro = cityMacroField( vGroundPos );

CityPlane groundA = CityPlane( vec3( 0.0 ), vec2( 0.0 ), 0.0, 0.0 );
CityPlane groundB = groundA;
if ( groundDirt < 0.98 ) {
  groundA = citySamplePlane( vGroundPos / groundAM, groundDx / groundAM, groundDy / groundAM,
    float( ${ga} ), 1.0, ${meanA}, groundHexFade );
}
if ( groundDirt > 0.02 ) {
  groundB = citySamplePlane( vGroundPos / groundBM, groundDx / groundBM, groundDy / groundBM,
    float( ${gb} ), 1.0, ${meanB}, groundHexFade );
}
vec3 groundAlbedo = mix( groundA.albedo, groundB.albedo, groundDirt );
float groundMacroSigned = groundMacro * 2.0 - 1.0;
groundAlbedo *= exp2( groundMacroSigned * cityMacroAlbedo );
groundAlbedo *= mix(
  vec3( 1.0 - cityMacroTemp * 0.65, 1.0, 1.0 + cityMacroTemp ),
  vec3( 1.0 + cityMacroTemp, 1.0, 1.0 - cityMacroTemp * 0.72 ),
  groundMacro );
diffuseColor.rgb *= cityTone * groundAlbedo;
${surface ? `
float groundRoughness = clamp(
  mix( groundA.rough, groundB.rough, groundDirt )
  + groundMacroSigned * cityMacroRough, 0.05, 1.0 );
float groundOcclusion = mix( groundA.ao, groundB.ao, groundDirt );
vec2 groundNxy = mix( groundA.nxy, groundB.nxy, groundDirt )
  * cityNormalScale * max( 0.05, 1.0 + groundMacroSigned * cityMacroNormal );
` : ''}
` : `
// Plain variant (hero off, or the albedo tier): one tap per needed layer.
float groundDirt = clamp( vGroundW.y + vGroundW.z + vGroundW.w, 0.0, 1.0 );
vec4 groundTapA = texture( cityAlbedo, vec3( vGroundPos / groundAM, float( ${ga} ) ) );
vec4 groundTapB = texture( cityAlbedo, vec3( vGroundPos / groundBM, float( ${gb} ) ) );
diffuseColor.rgb *= cityTone * mix( groundTapA.rgb, groundTapB.rgb, groundDirt );
${surface ? `
vec4 groundSurfA = texture( citySurface, vec3( vGroundPos / groundAM, float( ${ga} ) ) );
vec4 groundSurfB = texture( citySurface, vec3( vGroundPos / groundBM, float( ${gb} ) ) );
float groundRoughness = mix( groundSurfA.b, groundSurfB.b, groundDirt );
float groundOcclusion = mix( groundSurfA.a, groundSurfB.a, groundDirt );
vec2 groundNxy = ( mix( groundSurfA.rg, groundSurfB.rg, groundDirt ) * 2.0 - 1.0 ) * cityNormalScale;
` : ''}
`}
`;
}

/**
 * Replaces `<normal_fragment_maps>` on the terrain: perturb the vertex normal
 * along the view-space images of world X and Z -- the axes the XZ projection
 * ties the tangent space to. Exact on flat ground, a benign approximation on
 * the mild slopes this heightfield actually has. The tangent-y sign matches
 * the city's own floor (Y) plane, which shares these sheets.
 */
const GROUND_NORMAL_FRAGMENT = `
vec3 groundTangent = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
vec3 groundBitangent = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
vec3 groundMapN = vec3( groundNxy, sqrt( max( 1.0 - dot( groundNxy, groundNxy ), 0.0 ) ) );
normal = normalize(
  groundTangent * groundMapN.x + groundBitangent * groundMapN.y + normal * groundMapN.z );
`;

const GROUND_ROUGHNESS_FRAGMENT = `
float roughnessFactor = roughness * groundRoughness;
`;

const GROUND_AO_FRAGMENT = `
reflectedLight.indirectDiffuse *= groundOcclusion;

#if defined( USE_ENVMAP ) && defined( STANDARD )
  float groundDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(
    groundDotNV, groundOcclusion, material.roughness );
#endif
`;

/**
 * Attach the grass/dirt injection to the terrain material.
 *
 * Same factory discipline as the city: never reachable via Material.clone().
 * The slope-shade the terrain always had is preserved by the caller's own
 * injection; this replaces the map/normal/roughness/ao chunks only.
 */
export function applyGroundTextures(
  material: THREE.Material,
  surface: boolean,
  heroRequested: boolean,
): void {
  // Like the city: the hero stack's detail-aware and normal work needs the
  // surface array, so the albedo tier keeps the plain path.
  const hero = heroRequested && surface;
  const textures = cityTextures();
  uniforms.cityAlbedo.value = textures.albedo;
  uniforms.citySurface.value = textures.surface;

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.cityAlbedo = uniforms.cityAlbedo;
    shader.uniforms.cityTexMetres = uniforms.cityTexMetres;
    shader.uniforms.cityTexScale = uniforms.cityTexScale;
    shader.uniforms.cityTone = uniforms.cityTone;
    shader.uniforms.groundDirtStart = groundUniforms.groundDirtStart;
    shader.uniforms.groundDirtEnd = groundUniforms.groundDirtEnd;
    if (surface) {
      shader.uniforms.citySurface = uniforms.citySurface;
      shader.uniforms.cityNormalScale = uniforms.cityNormalScale;
    }
    if (hero) {
      uniforms.cityMacroTex.value = cityMacroNoise();
      shader.uniforms.cityMacroTex = uniforms.cityMacroTex;
      shader.uniforms.cityTexMean = uniforms.cityTexMean;
      shader.uniforms.cityTexRot = uniforms.cityTexRot;
      shader.uniforms.cityPatchTiles = uniforms.cityPatchTiles;
      shader.uniforms.cityPhaseJitter = uniforms.cityPhaseJitter;
      shader.uniforms.cityRotAmount = uniforms.cityRotAmount;
      shader.uniforms.cityMirrorProb = uniforms.cityMirrorProb;
      shader.uniforms.cityScaleJitter = uniforms.cityScaleJitter;
      shader.uniforms.cityCellTint = uniforms.cityCellTint;
      shader.uniforms.cityBlendExp = uniforms.cityBlendExp;
      shader.uniforms.cityHeightBias = uniforms.cityHeightBias;
      shader.uniforms.cityVariancePreserve = uniforms.cityVariancePreserve;
      shader.uniforms.cityHexFadeStart = uniforms.cityHexFadeStart;
      shader.uniforms.cityHexFadeEnd = uniforms.cityHexFadeEnd;
      shader.uniforms.cityMacroSize = uniforms.cityMacroSize;
      shader.uniforms.cityMacroAlbedo = uniforms.cityMacroAlbedo;
      shader.uniforms.cityMacroRough = uniforms.cityMacroRough;
      shader.uniforms.cityMacroNormal = uniforms.cityMacroNormal;
      shader.uniforms.cityMacroTemp = uniforms.cityMacroTemp;
      shader.uniforms.cityMacroMid = uniforms.cityMacroMid;
      shader.uniforms.cityMacroSmall = uniforms.cityMacroSmall;
    }

    shader.vertexShader = GROUND_VERTEX_PARS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + GROUND_VERTEX_BODY,
    );
    shader.fragmentShader = groundFragmentPars(surface, hero) + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      groundMapFragment(surface, hero),
    );
    if (surface) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <roughnessmap_fragment>', GROUND_ROUGHNESS_FRAGMENT)
        .replace('#include <normal_fragment_maps>', GROUND_NORMAL_FRAGMENT)
        .replace('#include <aomap_fragment>', GROUND_AO_FRAGMENT);
    }
  };
  material.customProgramCacheKey = () =>
    `ground-${surface ? 'pbr' : 'albedo'}-${hero ? 'hero' : 'plain'}-v1`;
}
