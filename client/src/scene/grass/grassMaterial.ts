import * as THREE from 'three';
import { sunDirection, skyGradient, sunIntensityFor } from '../../graphics/sunSky';
import { GRASS_PROFILES, type GrassQuality } from './grassPlacement';
import { cityMacroNoise } from '../cityTextures';
import type { GrassInteraction } from './GrassInteraction';

// Original implementation. Technique references are documented in docs/city-grass.md.
const VERTEX_PARS = /* glsl */ `
attribute vec4 grassRoot;
attribute vec4 grassShape;
attribute float grassBirth;
attribute vec3 grassTint;
attribute vec4 grassTraits;
uniform float grassTime;
uniform vec2 grassWind;
uniform vec3 grassLod;
uniform vec3 grassViewer;
uniform sampler2D grassWindNoise;
uniform sampler2D grassContacts;
uniform vec4 grassContactBounds;
varying vec3 vGrassColor;
varying float vGrassHeight;
varying vec3 vGrassWorld;
varying float vGrassDryness;
vec3 grassArc(float t, float h, float base, float curve, vec2 axis) {
  float a = base + curve*t;
  vec2 arc = vec2(cos(base)-cos(a), sin(a)-sin(base))/curve;
  return vec3(axis.x*arc.x, arc.y, axis.y*arc.x)*h;
}

`;

const BLADE = /* glsl */ `
float t = position.y;
float species = floor(grassTraits.w*255.0+0.5);
float health = grassTraits.x, dryness = grassTraits.y, stiffness = grassTraits.z;
float part = position.z;
bool broadLeaf = species >= 3.0 && part > 0.5;
bool seedHead = species > 0.5 && species < 2.5 && part > 0.5;
if (seedHead) t = 0.85+position.y*0.15;
if (broadLeaf) t = species > 3.5 ? 0.12 : 0.16+part*0.105;
vec3 root = vec3(grassRoot.x, 0.006, grassRoot.y);
vec3 worldRoot = (modelMatrix * vec4(root, 1.0)).xyz;
float distanceToEye = distance(cameraPosition, worldRoot);
float density = (1.0 - 0.55 * smoothstep(grassLod.x * 0.5, grassLod.x, distanceToEye))
  * (1.0 - 0.65 * smoothstep(grassLod.y * 0.65, grassLod.y, distanceToEye));
density = max(density, species >= 3.0 ? 0.65 : grassRoot.z > 1.5 ? 0.32 : 0.0);
float growth = (1.0 - smoothstep(density - 0.065, density, grassShape.w))
  * (1.0 - smoothstep(grassLod.z * 0.8, grassLod.z, distanceToEye))
  * smoothstep(grassBirth, grassBirth + 0.35, grassTime);
float h = grassRoot.z * growth;
vec2 forward = vec2(sin(grassRoot.w), cos(grassRoot.w));
vec3 side = vec3(forward.y, 0.0, -forward.x);
float windSpeed = length(grassWind);
vec2 windDir = grassWind / max(windSpeed, 0.001);
// Reuse the city's tiny procedural noise texture: one cached tap instead of
// recomputing lattice hashes at every vertex of every blade.
float gust = texture2D(grassWindNoise, worldRoot.xz * 0.018 - grassWind * grassTime * 0.003).r;
float ripple = sin(dot(worldRoot.xz, windDir) * 1.7 - grassTime * (2.0 + windSpeed * 0.22)
  + grassShape.z * 6.28);
vec2 bend = forward * (grassShape.y + dryness*0.18) + windDir * min(windSpeed * 0.055, 0.8)
  * (0.3 + gust * 0.85 + ripple * 0.1) * (1.2-stiffness*0.65)
  * mix(1.0, 0.6, smoothstep(1.25, 2.5, grassRoot.z));
vec2 away = worldRoot.xz - grassViewer.xz;
float push = (1.0 - smoothstep(0.2, 1.15, length(away)))
  * (1.0 - smoothstep(2.0, 3.5, abs(grassViewer.y - worldRoot.y)));
bend += away / max(length(away), 0.01) * push * 1.5;
vec2 contactUv = (worldRoot.xz - grassContactBounds.xy) / grassContactBounds.zw;
vec4 contact = texture2D(grassContacts, clamp(contactUv, 0.0, 1.0));
float contactEdge = smoothstep(0.0, 0.04, min(min(contactUv.x, contactUv.y), min(1.0-contactUv.x, 1.0-contactUv.y)));
contact.r = max(contact.r, contact.a * mix(0.35, 0.95, max(dryness, 1.0-health))) * contactEdge;
vec2 contactDirection = (contact.gb * 255.0 - 128.0) / 127.0 * contactEdge;
bend = bend * (1.0-contact.r*0.65) + contactDirection * 1.6;
push = max(push, contact.r * 1.48);
// Circular centreline: arc length is exactly h*t. Contact rotates the base
// toward the ground rather than scaling the leaf into a stretching accordion.
float compression = max(contact.r, push * 0.55);
float bendLength = length(bend);
vec2 bendAxis = bendLength > 0.001 ? bend/bendLength : forward;
float baseAngle = compression * 1.46;
float curvature = mix(clamp(bendLength, 0.02, 1.5), 0.06, compression);
float angle = baseAngle + curvature*t;
vec3 centre = grassArc(t, h, baseAngle, curvature, bendAxis);
vec3 tangent = vec3(bendAxis.x*sin(angle), cos(angle), bendAxis.y*sin(angle));
// Fold and twist the ribbon without extra vertices or texture fetches.
float twist = (grassShape.z-0.5)*0.65*t;
side = normalize(side + vec3(forward.x, 0.0, forward.y)*twist);
float width = grassShape.x * (1.0 - t * t) * growth;
if (seedHead) {
  float heading = grassRoot.w+part*1.5708;
  side = vec3(cos(heading), 0.0, -sin(heading));
  width = h * (species > 1.5 ? 0.024 : 0.02) * sin(position.y*3.14159)*(0.8+0.2*cos(position.y*50.0));
} else if (broadLeaf) {
  float leafT = position.y;
  float heading = grassRoot.w+part*2.39996;
  vec2 leafAxis = vec2(sin(heading), cos(heading));
  float leafLength = h*(species > 3.5 ? 0.85 : 0.48);
  float flutter = sin(grassTime*(3.0-dryness)+grassShape.z*6.28+part)*windSpeed*0.0015;
  centre += vec3(leafAxis.x*leafT, (sin(leafT*3.14159)*0.32+flutter*leafT)*(1.0-compression), leafAxis.y*leafT)*leafLength;
  side = vec3(leafAxis.y, 0.0, -leafAxis.x);
  tangent = vec3(leafAxis.x, cos(leafT*3.14159)*(1.0-compression), leafAxis.y);
  width = leafLength*(species > 3.5 ? 0.25 : 0.15)*sin(leafT*3.14159);
  if (species > 3.5) width *= 0.65+0.35*abs(sin(leafT*28.0));
} else if (species > 0.5) {
  width *= species > 2.5 ? 0.22 : 0.45;
}
// Broaden sparse far blades slightly to preserve meadow coverage.
width *= mix(1.0, 1.65, smoothstep(grassLod.x, grassLod.y, distanceToEye));
vec3 grassPosition = root + centre + side * position.x * width;
vec3 objectNormal = normalize(cross(side, tangent + vec3(0, 0.00001, 0)));
// A rounded leaf catches skylight without a billboard's dark edge-on stripes.
objectNormal = normalize(objectNormal + side * position.x * 0.5 + vec3(0, 0.35, 0));
vGrassWorld = (modelMatrix * vec4(grassPosition, 1.0)).xyz;
vGrassHeight = t;
vGrassDryness = dryness;
vec3 leafTint = mix(grassTint, vec3(0.46, 0.33, 0.12), dryness*0.28);
leafTint *= mix(0.72, 1.08, health);
vec3 base = leafTint * mix(0.22, 0.38, grassShape.z);
vec3 tip = leafTint * mix(0.85, 1.25, grassShape.z);
vGrassColor = mix(base, tip, pow(t, 0.75));
vGrassColor = mix(vGrassColor, vec3(0.34, 0.22, 0.08), dryness*smoothstep(0.6, 1.0, position.y)*0.55);
if (seedHead) vGrassColor = mix(vGrassColor, vec3(0.52, 0.36, 0.12), species > 1.5 ? 0.65 : 0.8);
`;

export function createGrassMaterial(quality: GrassQuality, interaction: GrassInteraction) {
  const p = GRASS_PROFILES[quality];
  const direction = sunDirection();
  const uniforms = {
    grassTime: { value: 0 },
    grassWind: { value: new THREE.Vector2(5.65, 5.65) },
    grassLod: { value: new THREE.Vector3(p.near, p.middle, p.distance) },
    grassViewer: { value: new THREE.Vector3(0, 1000, 0) },
    grassWindNoise: { value: cityMacroNoise() },
    grassContacts: { value: interaction.texture },
    grassContactBounds: { value: interaction.bounds },
    grassSun: { value: new THREE.Vector3(direction.x, direction.y, direction.z) },
    grassSunColor: { value: new THREE.Color(skyGradient('#c3d2e2').sunColor).multiplyScalar(sunIntensityFor()) },
  };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
  });
  material.name = 'City grass · curved instanced blades';
  material.forceSinglePass = true;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERTEX_PARS)
      .replace('#include <beginnormal_vertex>', BLADE)
      .replace('#include <begin_vertex>', 'vec3 transformed = grassPosition;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGrassColor;
        varying float vGrassHeight;
        varying vec3 vGrassWorld;
        varying float vGrassDryness;
        uniform vec3 grassSun;
        uniform vec3 grassSunColor;
      `)
      .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGrassColor;')
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        // DoubleSide flips the leaf normal, including its upward bias. Restore
        // the canopy's skylight response on BOTH sides instead of black backs.
        vec3 grassUp = (viewMatrix * vec4(0, 1, 0, 0)).xyz;
        normal = normalize(normal + grassUp * (0.45 - min(dot(normal, grassUp), 0.0)));
      `)
      .replace('#include <opaque_fragment>', `
        // Thin leaves transmit sunlight. Respect the same building shadows as the ground.
        vec3 grassView = normalize(cameraPosition - vGrassWorld);
        float transmission = pow(max(dot(-grassView, grassSun), 0.0), 3.0);
        if (transmission > 0.005) {
          outgoingLight += vGrassColor * grassSunColor * transmission * mix(0.42, 0.12, vGrassDryness)
            * smoothstep(0.05, 0.85, vGrassHeight) * getShadowMask();
        }
        outgoingLight *= mix(0.72, 1.0, smoothstep(0.0, 0.65, vGrassHeight));
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => 'city-foliage-v5';
  return { material, uniforms };
}
