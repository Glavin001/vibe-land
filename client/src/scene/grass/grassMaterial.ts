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

`;

const BLADE = /* glsl */ `
float t = position.y;
vec3 root = vec3(grassRoot.x, 0.006, grassRoot.y);
vec3 worldRoot = (modelMatrix * vec4(root, 1.0)).xyz;
float distanceToEye = distance(cameraPosition, worldRoot);
float density = (1.0 - 0.55 * smoothstep(grassLod.x * 0.5, grassLod.x, distanceToEye))
  * (1.0 - 0.65 * smoothstep(grassLod.y * 0.65, grassLod.y, distanceToEye));
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
vec2 bend = forward * grassShape.y + windDir * min(windSpeed * 0.055, 0.8)
  * (0.3 + gust * 0.85 + ripple * 0.1)
  * mix(1.0, 0.6, smoothstep(1.25, 2.5, grassRoot.z));
vec2 away = worldRoot.xz - grassViewer.xz;
float push = (1.0 - smoothstep(0.2, 1.15, length(away)))
  * (1.0 - smoothstep(2.0, 3.5, abs(grassViewer.y - worldRoot.y)));
bend += away / max(length(away), 0.01) * push * 1.5;
vec2 contactUv = (worldRoot.xz - grassContactBounds.xy) / grassContactBounds.zw;
vec3 contact = texture2D(grassContacts, clamp(contactUv, 0.0, 1.0)).rgb;
float contactEdge = smoothstep(0.0, 0.04, min(min(contactUv.x, contactUv.y), min(1.0-contactUv.x, 1.0-contactUv.y)));
contact.r *= contactEdge;
vec2 contactDirection = (contact.gb * 255.0 - 128.0) / 127.0 * contactEdge;
bend = bend * (1.0-contact.r*0.65) + contactDirection * 1.6;
push = max(push, contact.r * 1.48);
// Cubic Bezier centreline, with a derivative for the actual bent leaf normal.
vec3 p1 = vec3(0, h * 0.38, 0);
vec3 p2 = vec3(bend.x * h * 0.45, h * (0.8 - push * 0.25), bend.y * h * 0.45);
vec3 p3 = vec3(bend.x * h, h * (0.86 - push * 0.55), bend.y * h);
float u = 1.0 - t;
vec3 centre = 3.0*u*u*t*p1 + 3.0*u*t*t*p2 + t*t*t*p3;
vec3 tangent = 3.0*u*u*p1 + 6.0*u*t*(p2-p1) + 3.0*t*t*(p3-p2);
centre.y *= 1.0 - contact.r * 0.92;
tangent.y *= 1.0 - contact.r * 0.92;
float width = grassShape.x * (1.0 - t * t) * growth;
// Broaden sparse far blades slightly to preserve meadow coverage.
width *= mix(1.0, 1.65, smoothstep(grassLod.x, grassLod.y, distanceToEye));
vec3 grassPosition = root + centre + side * position.x * width;
vec3 objectNormal = normalize(cross(side, tangent + vec3(0, 0.00001, 0)));
// A rounded leaf catches skylight without a billboard's dark edge-on stripes.
objectNormal = normalize(objectNormal + side * position.x * 0.5 + vec3(0, 0.35, 0));
vGrassWorld = (modelMatrix * vec4(grassPosition, 1.0)).xyz;
vGrassHeight = t;
vec3 base = grassTint * mix(0.22, 0.38, grassShape.z);
vec3 tip = grassTint * mix(0.85, 1.25, grassShape.z);
vGrassColor = mix(base, tip, pow(t, 0.75));
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
          outgoingLight += vGrassColor * grassSunColor * transmission * 0.42
            * smoothstep(0.05, 0.85, vGrassHeight) * getShadowMask();
        }
        outgoingLight *= mix(0.72, 1.0, smoothstep(0.0, 0.65, vGrassHeight));
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => 'city-grass-v3-tall';
  return { material, uniforms };
}
