import type * as THREE from 'three';

// A bounded displacement in graft-local space. The base stays welded to its
// physical limb; wind never moves collision shapes or creates simulated leaves.
export const OUTDOOR_WIND_MARGIN = 0.24;

export function animateOutdoorMaterial(
  material: THREE.Material,
  clock: {value: number},
  height: number,
  foliage: boolean,
) {
  material.customProgramCacheKey = () => `outdoor-wind-v2-${foliage}-${height.toFixed(6)}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.outdoorTime = clock;
    shader.uniforms.outdoorHeight = {value: Math.max(height, 0.1)};
    shader.vertexShader = `
uniform float outdoorTime;
uniform float outdoorHeight;
vec4 outdoorWind() {
  mat4 placement = modelMatrix * instanceMatrix;
  vec3 origin = placement[3].xyz;
  // Nearby crowns share slow gusts, but never flutter in lockstep.
  float phase = dot(origin.xz, vec2(0.17, 0.11));
  float gust = sin(outdoorTime * 0.85 + phase)
             + 0.35 * sin(outdoorTime * 1.73 + phase * 1.9);
  vec3 direction = normalize(vec3(1.0, 0.0, 0.45));
  vec3 localDirection = vec3(dot(normalize(placement[0].xyz), direction),
                             dot(normalize(placement[1].xyz), direction),
                             dot(normalize(placement[2].xyz), direction));
  return vec4(localDirection, gust * 0.10);
}
` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
#include <begin_vertex>
{
  vec4 wind = outdoorWind();
  float weight = clamp(position.y / outdoorHeight, 0.0, 1.0);
  transformed += wind.xyz * wind.w * weight * weight;
  ${foliage ? `
  float flutter = sin(outdoorTime * 4.7 + dot(position, vec3(3.1, 1.7, 2.3)));
  transformed += normal * flutter * 0.022 * uv.y * weight;
  ` : ''}
}
`);
    // Keep twig and canopy shading aligned with the gentle bend. Depth and
    // distance materials receive the identical position deformation for shadows.
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
#include <beginnormal_vertex>
{
  vec4 wind = outdoorWind();
  float weight = clamp(position.y / outdoorHeight, 0.0, 1.0);
  objectNormal.y -= dot(objectNormal, wind.xyz) * wind.w * 2.0 * weight / outdoorHeight;
  objectNormal = normalize(objectNormal);
}
`);
    if (foliage) shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_pars_fragment>', `
#include <lights_physical_pars_fragment>
void RE_Direct_Leaf(const in IncidentLight light, const in vec3 position,
  const in vec3 normal, const in vec3 viewDir, const in vec3 coatNormal,
  const in PhysicalMaterial material, inout ReflectedLight reflected) {
  RE_Direct_Physical(light, position, normal, viewDir, coatNormal, material, reflected);
  // Thin leaves transmit some backlighting. The input light already includes
  // its shadow factor, so this never glows in darkness or bypasses shadows.
  float throughLeaf = 0.3 * smoothstep(-0.2, 1.0, dot(-normal, light.direction));
  reflected.directDiffuse += throughLeaf * light.color * BRDF_Lambert(material.diffuseColor);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`);
  };
}
