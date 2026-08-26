// Triplanar concrete for the city, projected from each chunk's REST pose.
//
// The problem this solves is not "the buildings have no texture" -- that part
// is easy -- it is that the buildings are already shattered. Every chunk is its
// own instance before anything hits it, geometry is shared between thousands of
// chunks, and the shards arrive as bare point clouds with no UVs at all. So:
//
//   - Object-space mapping would give every shard its own copy of the texture,
//     and an intact wall would read as a mosaic of pre-broken panels.
//   - World-space mapping from the CURRENT pose looks right until something
//     breaks, and then the texture swims across a tumbling shard.
//
// Rest space is the fix. Each instance carries the world position it was BUILT
// at, and the shader reconstructs `anchor + restScale * position`. That
// coordinate never mentions the live pose, so:
//
//   - neighbouring chunks in a standing wall sample one continuous surface,
//     because their rest positions are adjacent;
//   - a chunk that breaks free keeps exactly the texels it had while embedded,
//     because nothing in the mapping moved.
//
// Fracture-invariance falls out of the coordinate system rather than being
// enforced anywhere, which is why there is no code for it below.
//
// Triplanar rather than UV because there are no UVs to use: hulls are
// re-triangulated from point clouds by ConvexGeometry, and `normalizeForBatching`
// only synthesises zeroed ones to keep batched attribute layouts identical.
//
// The Y projection samples a FLOOR layer while X and Z sample a WALL layer, so
// slab tops and rubble stop wearing wall grain. It costs nothing: the blend was
// already three taps, these are just three different array layers.

import * as THREE from 'three';

import { CITY_TEX_LAYERS, CITY_TEX_METRES, LAYER_CODE_RADIX, cityTextures } from './cityTextures';

/**
 * How sharply one projection wins over its neighbours.
 *
 * City geometry is overwhelmingly flat faces meeting at hard edges, so a soft
 * blend only shows up as a smeared band along every edge. High enough to keep
 * faces crisp, low enough that a shard's slanted cut face still cross-fades.
 */
const BLEND_SHARPNESS = 6.0;

/**
 * Live tuning handles, shared by every material this module builds.
 *
 * One object per uniform, referenced (not copied) into each compiled shader --
 * three reads `shader.uniforms[name].value` at upload time, so mutating these
 * retunes the whole city without a recompile. Exposed on `window` because
 * picking a grain size is a look-at-it decision, not a computable one.
 */
const uniforms = {
  cityAlbedo: { value: null as THREE.DataArrayTexture | null },
  citySurface: { value: null as THREE.DataArrayTexture | null },
  cityTexMetres: { value: CITY_TEX_METRES },
  /**
   * Multiplies every layer's authored tile size. 1 = real-world scale.
   *
   * Above 1 deliberately: at true scale a 1 m texture repeats once per metre up
   * a twenty-storey facade, and regular repetition at that frequency reads as a
   * pattern rather than as concrete. Coarser tiles trade a little sharpness for
   * a much weaker periodic signal.
   *
   * 2.0 chosen off the tuning sweep (`city-texture-tuning.spec.ts`): 1.0 still
   * reads as a fine regular weave at building scale, 3.5 goes blobby up close.
   */
  cityTexScale: { value: 2.0 },
  cityNormalScale: { value: 1.0 },
  /**
   * Overall tone, multiplied over every layer.
   *
   * Poly Haven's diffuse maps are captured under flat neutral light and are far
   * brighter than concrete reads in a lit scene -- at 1.0 under this sky the
   * city looks like sandstone. This is the one knob for that, kept in the
   * shader rather than on `material.color` so the per-instance colour channel
   * stays reserved for the settled and body-debug states.
   *
   * 0.88 off the same sweep: enough to pull the lighter layers back from
   * sandstone without crushing the darker ones to black.
   */
  cityTone: { value: new THREE.Color(0.88, 0.88, 0.88) },
};

export function setCityTextureTuning(next: {
  scale?: number;
  normalScale?: number;
  tone?: number | [number, number, number];
}): void {
  if (next.scale !== undefined) uniforms.cityTexScale.value = next.scale;
  if (next.normalScale !== undefined) uniforms.cityNormalScale.value = next.normalScale;
  if (typeof next.tone === 'number') uniforms.cityTone.value.setScalar(next.tone);
  else if (next.tone) uniforms.cityTone.value.setRGB(next.tone[0], next.tone[1], next.tone[2]);
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
 *
 * The two defines are mutually exclusive (WebGLPrograms sets one or the other
 * from the object type), and the final `#else` exists only so the shader still
 * compiles if a plain Mesh ever reaches this material.
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
 * rest-space normal into the space three lights in.
 *
 * `flat` because every vertex of an instance yields the same value; that also
 * keeps them exactly orthonormal, so the third axis is a cross product and the
 * fragment stage needs no renormalise.
 *
 * Guarded against a zero-length axis: `cityChunkWrite` collapses a sunk chunk's
 * scale to zero to hide it, and normalising that would push NaN through the
 * varyings of a primitive that is degenerate but still shaded.
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

function fragmentPars(pbr: boolean): string {
  return `
uniform highp sampler2DArray cityAlbedo;
uniform float cityTexMetres[ ${CITY_TEX_LAYERS} ];
uniform float cityTexScale;
uniform vec3 cityTone;
varying vec3 vCityTexPos;
flat varying float vCityLayer;
${pbr ? `
uniform highp sampler2DArray citySurface;
uniform float cityNormalScale;
flat varying vec3 vCityAxisX;
flat varying vec3 vCityAxisY;
` : ''}
`;
}

/**
 * Replaces `<map_fragment>`, and does the shared setup the later replacements
 * read: blend weights, the two layer indices, and the three projected UVs.
 *
 * The geometric normal comes from screen-space derivatives of the rest-space
 * position rather than a varying. That is exact here -- every face of a box or
 * a convex shard is planar -- and it buys back three interpolators.
 *
 * Weights use `abs`, so the sign of the derivative normal never matters and an
 * up-facing slab and the underside of the same slab both read as floor.
 *
 * The `USE_MAP` guard lives inside the chunk being replaced, so no dummy
 * `material.map` is needed to reach this -- and setting one would be harmful:
 * it would define USE_MAP, pull in a vMapUv varying fed by the zeroed UVs, and
 * get copied onto the shared depth material.
 */
function mapFragment(pbr: boolean): string {
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
${pbr ? `
vec4 citySurfX = texture( citySurface, vec3( cityUvX, cityWallLayer ) );
vec4 citySurfY = texture( citySurface, vec3( cityUvY, cityFloorLayer ) );
vec4 citySurfZ = texture( citySurface, vec3( cityUvZ, cityWallLayer ) );
float cityRoughness = dot( vec3( citySurfX.b, citySurfY.b, citySurfZ.b ), cityBlend );
float cityOcclusion = dot( vec3( citySurfX.a, citySurfY.a, citySurfZ.a ), cityBlend );
` : ''}
`;
}

/**
 * Replaces `<normal_fragment_maps>`: a whiteout triplanar normal blend.
 *
 * Each projection's tangent normal is folded into rest space and the three are
 * summed by the same weights, rather than running one tangent frame over all
 * three -- a shared frame misorients the Y and Z planes.
 *
 * `cityFacing` recovers the sign the derivative normal does not carry, by
 * testing it against the interpolated view-space normal three already computed.
 *
 * `mat3` takes COLUMNS, so `mat3( X, Y, Z )` of the instance's view-space axes
 * is exactly the rest -> view rotation. It is orthonormal because Matrix4's
 * compose builds T*R*S with positive S, so the axes are R's columns scaled.
 */
const NORMAL_FRAGMENT = `
mat3 cityToView = mat3( vCityAxisX, vCityAxisY, cross( vCityAxisX, vCityAxisY ) );
float cityFacing = dot( cityToView * cityGeoN, normal ) < 0.0 ? -1.0 : 1.0;
vec3 cityN = cityGeoN * cityFacing;

vec2 cityNx = ( citySurfX.rg * 2.0 - 1.0 ) * cityNormalScale;
vec2 cityNy = ( citySurfY.rg * 2.0 - 1.0 ) * cityNormalScale;
vec2 cityNz = ( citySurfZ.rg * 2.0 - 1.0 ) * cityNormalScale;
// Blue is not stored -- for a unit tangent normal it is recoverable, and the
// channel it frees is what lets roughness and AO share this fetch.
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
 * Replaces `<aomap_fragment>`.
 *
 * The specular branch is not optional any more. The city used to be lit by a
 * flat ambient plus a hemisphere light, so indirect specular was nothing and
 * occluding it was a no-op; `SkyEnvironment` now binds a PMREM of the sky as
 * `scene.environment`, which defines USE_ENVMAP on this material and makes
 * indirect specular a real term. Leaving it unoccluded lights the inside of
 * every crevice with a clean sky reflection.
 *
 * Clearcoat and sheen are still skipped -- this material has neither.
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
export function applyCityTriplanar(material: THREE.Material, pbr: boolean): void {
  const textures = cityTextures();
  uniforms.cityAlbedo.value = textures.albedo;
  uniforms.citySurface.value = textures.surface;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.cityAlbedo = uniforms.cityAlbedo;
    shader.uniforms.cityTexMetres = uniforms.cityTexMetres;
    shader.uniforms.cityTexScale = uniforms.cityTexScale;
    shader.uniforms.cityTone = uniforms.cityTone;
    if (pbr) {
      shader.uniforms.citySurface = uniforms.citySurface;
      shader.uniforms.cityNormalScale = uniforms.cityNormalScale;
    }

    shader.vertexShader = (VERTEX_PARS + (pbr ? VERTEX_PARS_PBR : '')) + shader.vertexShader;
    // After <begin_vertex>: batchingMatrix and instanceMatrix are both already
    // in scope by then, and the anchor is identical in meshphysical and
    // meshlambert so one injection covers both tiers.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + VERTEX_BODY + (pbr ? VERTEX_BODY_PBR : ''),
    );

    shader.fragmentShader = fragmentPars(pbr) + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      mapFragment(pbr),
    );
    if (pbr) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
        .replace('#include <normal_fragment_maps>', NORMAL_FRAGMENT)
        .replace('#include <aomap_fragment>', AO_FRAGMENT);
    }
  };

  // A constant, because the default key is `onBeforeCompile.toString()` -- which
  // would stringify all of the above on every program lookup. Bump the version
  // when the injected GLSL changes, or a warm cache serves the old program.
  material.customProgramCacheKey = () => (pbr ? 'city-triplanar-pbr-v1' : 'city-triplanar-flat-v1');
}
