// The distant foliage canopy on the WebGPU path, in TSL: FoliageCanopy.ts's
// card program (three crossed cards and one overhead card per clump, wind
// sway, contact pressure) and its fragment (atlas cut-out, distance
// handoff dither, averaged leaf normal, thin-leaf transmission). Same
// uniforms objects as the GLSL material.
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import * as THREE from 'three';
import {
  Discard,
  Fn,
  If,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cos,
  distance,
  dot,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  texture,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import { liveUniform } from '../../graphics/webgpu/liveUniform';
import { FOLIAGE_SURFACE } from './foliageLighting';
import type { GrassInteraction } from './GrassInteraction';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Holder = { value: any };

export interface CanopyNodeInputs {
  atlas: THREE.Texture;
  uniforms: { foliageTime: Holder; foliageWind: Holder; foliageHandoff: Holder; grassSun: Holder; grassSunColor: Holder };
  contactBlend: Holder;
  interaction: GrassInteraction;
}

export function canopyNodeMaterial({ atlas, uniforms, contactBlend, interaction }: CanopyNodeInputs): THREE.Material {
  const material = new MeshStandardNodeMaterial({ ...FOLIAGE_SURFACE, alphaTest: 0.3 });
  material.name = 'Distant foliage canopy (TSL)';
  const time = liveUniform(uniforms.foliageTime, 'float');
  const wind = liveUniform(uniforms.foliageWind, 'vec2');
  const handoff = liveUniform(uniforms.foliageHandoff, 'vec2');
  const sun = liveUniform(uniforms.grassSun, 'vec3');
  const sunColor = liveUniform(uniforms.grassSunColor, 'color');
  const blend = liveUniform(contactBlend, 'float');
  const bounds = liveUniform({ value: interaction.bounds }, 'vec4');

  const vWorld = varyingProperty('vec3', 'vCanopyWorld');
  const vTint = varyingProperty('vec3', 'vCanopyTint');
  const vUv = varyingProperty('vec2', 'vCanopyUv');
  const vHeight = varyingProperty('float', 'vCanopyHeight');
  const vDryness = varyingProperty('float', 'vCanopyDryness');
  const root: Node = attribute('canopyRoot', 'vec4');
  const style: Node = attribute('canopyStyle', 'vec4');
  const position: Node = positionGeometry;

  material.positionNode = Fn(() => {
    const overhead = position.z.greaterThan(2.5);
    const angle = root.w.add(position.z.mul(1.04719755));
    const card = select(
      overhead,
      vec3(position.x.mul(1.4), root.z.mul(0.76), position.y.sub(0.5).mul(1.4)),
      vec3(cos(angle).mul(position.x).mul(1.4), position.y.mul(root.z), sin(angle).mul(position.x).mul(1.4)),
    ).toVar('canopyCard');
    const sway = wind.mul(0.007).mul(sin(time.mul(1.7).add(root.x.mul(0.6)).add(root.y.mul(0.4))))
      .mul(pow(card.y.div(max(root.z, 0.01)), 2));
    card.xz.addAssign(sway);
    const worldRoot = modelWorldMatrix.mul(vec4(root.x, 0, root.y, 1)).xz;
    const contactUv = worldRoot.sub(bounds.xy).div(bounds.zw);
    const at = clamp(contactUv, 0, 1);
    const contact = mix(
      (texture(interaction.previousTexture, at) as Node).level(0),
      (texture(interaction.texture, at) as Node).level(0),
      blend,
    );
    const edge = smoothstep(0, 0.04, min(min(contactUv.x, contactUv.y), min(float(1).sub(contactUv.x), float(1).sub(contactUv.y))));
    const pressure = max(contact.r, contact.a.mul(0.7)).mul(edge);
    const direction = contact.gb.mul(255).sub(128).div(127);
    card.xz.addAssign(direction.mul(card.y).mul(pressure).mul(0.85));
    card.y.mulAssign(float(1).sub(pressure.mul(0.91)));
    const placed = card.add(vec3(root.x, 0.006, root.y));
    vWorld.assign(modelWorldMatrix.mul(vec4(placed, 1)).xyz);
    const height = select(overhead, float(0.8), position.y);
    vHeight.assign(height);
    const dryness = fract(style.w).div(0.49);
    vDryness.assign(dryness);
    const tint = style.rgb.mul(mix(float(0.3), float(1.05), pow(height, 0.75)));
    vTint.assign(mix(tint, vec3(0.34, 0.22, 0.08), dryness.mul(smoothstep(0.6, 1, height)).mul(0.55)));
    const u: Node = uv();
    vUv.assign(vec2(
      u.x.mul(0.984).add(0.008).add(floor(style.w)).div(5),
      u.y.mul(0.984).add(0.008).add(select(overhead, float(0), float(1))).div(2),
    ));
    return placed;
  })();

  const sample: Node = texture(atlas, vUv);
  // The atlas is a coverage mask: its alpha cuts out, its RGB is not albedo.
  material.opacityNode = sample.a;
  const occlusion = mix(float(0.72), float(1), smoothstep(0, 0.65, vHeight.mul(0.5)));
  material.colorNode = Fn(() => {
    const fade = smoothstep(handoff.x, handoff.y, distance(cameraPosition, vWorld));
    const dither = fract(fract(dot(floor(screenCoordinate.xy), vec2(0.06711056, 0.00583715))).mul(52.9829189));
    If(dither.greaterThanEqual(fade), () => {
      Discard();
    });
    return vTint.mul(occlusion);
  })();
  // The visible leaves' average normal, tilted toward the viewer, not the card's.
  const view = normalize(cameraPosition.sub(vWorld));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(normalize(vec3(view.x.mul(0.5), 1, view.z.mul(0.5))), 0)).xyz);
  // Thin-leaf transmission (foliageLightFragment, height halved as the GLSL).
  const transmission = pow(max(dot(view.negate(), sun), 0), 3);
  material.emissiveNode = vTint.mul(sunColor).mul(transmission)
    .mul(mix(float(0.42), float(0.12), vDryness)).mul(smoothstep(0.05, 0.85, vHeight.mul(0.5))).mul(occlusion);
  return material;
}
