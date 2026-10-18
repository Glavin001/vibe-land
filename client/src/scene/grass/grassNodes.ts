// The city grass blades on the WebGPU path, in TSL: grassMaterial.ts's BLADE
// vertex program (curved ribbon, wind, viewer and body push, contact field,
// impulses, LOD thinning, species shapes) and its fragment (canopy handoff
// dither, two-sided leaf normal, thin-leaf transmission, root occlusion).
// Same uniforms object as the GLSL material, so GrassField drives both.
//
// Each material is specialised to one species (and merged or not), as the
// GLSL specialize() does by text substitution: the species branches are
// resolved here in JavaScript.
//
// Not yet ported: the transmission term's shadow mask (backlit grass in a
// building's shadow still glows).
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import * as THREE from 'three';
import {
  Discard,
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cos,
  cross,
  distance,
  dot,
  faceDirection,
  float,
  floor,
  fract,
  length,
  materialColor,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalLocal,
  normalViewGeometry,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { liveUniform } from '../../graphics/webgpu/liveUniform';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import { cityMacroNoise } from '../cityTextures';
import { FOLIAGE_SURFACE } from './foliageLighting';
import { FOLIAGE_SPECIES } from './foliageProfiles';
import type { GrassInteraction } from './GrassInteraction';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Uniforms = Record<string, { value: any }>;

const PI = Math.PI;

/** createGrassMaterial's result on WebGPU (same shape, same uniforms). */
export function grassNodeMaterials(uniforms: Uniforms, interaction: GrassInteraction) {
  const shared = sharedNodes(uniforms, interaction);
  const build = (species: number, merge: boolean) => bladeMaterial(shared, species, merge);
  return {
    material: build(0, false),
    materials: FOLIAGE_SPECIES.map((_, species) => build(species, false)),
    denseMaterial: build(0, true),
  };
}

function sharedNodes(uniforms: Uniforms, interaction: GrassInteraction) {
  const r = (name: string, type: string): Node => liveUniform(uniforms[name], type);
  // The interaction's two body canopies and two impulses, from its arrays.
  const fromArray = (array: Float32Array, offset: number): Node => {
    const value = new THREE.Vector4();
    return (uniform(value) as Node).onRenderUpdate(() => value.fromArray(array, offset));
  };
  return {
    time: r('grassTime', 'float'),
    wind: r('grassWind', 'vec2'),
    lod: r('grassLod', 'vec3'),
    handoff: r('grassCanopyHandoff', 'vec2'),
    canopyDensity: r('grassCanopyDensity', 'vec3'),
    viewer: r('grassViewer', 'vec3'),
    contactBlend: r('grassContactBlend', 'float'),
    contactBounds: r('grassContactBounds', 'vec4'),
    canopyCount: r('grassCanopyCount', 'int'),
    impulseCount: r('grassImpulseCount', 'int'),
    sun: r('grassSun', 'vec3'),
    sunColor: r('grassSunColor', 'color'),
    canopies: [fromArray(interaction.canopies, 0), fromArray(interaction.canopies, 4)],
    impulses: [fromArray(interaction.impulses, 0), fromArray(interaction.impulses, 4)],
    windNoise: cityMacroNoise(),
    contacts: interaction.texture,
    previousContacts: interaction.previousTexture,
  };
}

/** grassArc: a circular centreline, arc length exactly h*t. */
function grassArc(t: Node, h: Node, base: Node, curve: Node, axis: Node): Node {
  const a = base.add(curve.mul(t));
  const arc = vec2(cos(base).sub(cos(a)), sin(a).sub(sin(base))).div(curve);
  return vec3(axis.x.mul(arc.x), arc.y, axis.y.mul(arc.x)).mul(h);
}

function bladeMaterial(s: ReturnType<typeof sharedNodes>, species: number, merge: boolean): THREE.Material {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, ...FOLIAGE_SURFACE });
  material.name = `City foliage ${species}${merge ? ' · merged ribbons' : ''} (TSL)`;

  const vColor = varyingProperty('vec3', 'vGrassColor');
  const vHeight = varyingProperty('float', 'vGrassHeight');
  const vWorld = varyingProperty('vec3', 'vGrassWorld');
  const vDryness = varyingProperty('float', 'vGrassDryness');
  const vCanopy = varyingProperty('float', 'vGrassCanopy');

  const root: Node = attribute('grassRoot', 'vec4');
  const shape: Node = attribute('grassShape', 'vec4');
  // One value per mesh (the GLSL reads it as an attribute shared by every
  // instance, meshPerAttribute = count): WebGPU has no attribute divisor,
  // so here it is a per-object uniform read from that attribute.
  const birthValue = new THREE.Vector2();
  const birth: Node = (uniform(birthValue) as Node).onObjectUpdate(({ object }: { object: THREE.Mesh }) => {
    const attribute = object.geometry?.getAttribute('grassBirth');
    if (attribute) birthValue.set(attribute.getX(0), attribute.getY(0));
    return birthValue;
  });
  const tint: Node = attribute('grassTint', 'vec3');
  const traits: Node = attribute('grassTraits', 'vec4');
  const position: Node = positionGeometry;

  const seedHeadSpecies = species > 0.5 && species < 2.5;
  const broadLeafSpecies = species >= 3;

  material.positionNode = Fn(() => {
    const health = traits.x;
    const dryness = traits.y;
    const stiffness = traits.z;
    const part = position.z;
    const broadLeaf: Node = broadLeafSpecies ? part.greaterThan(0.5) : null;
    const seedHead: Node = seedHeadSpecies ? part.greaterThan(0.5) : null;

    let t: Node = position.y;
    if (species > 3.5) t = select(part.lessThan(0.5), t.mul(0.14), t);
    if (seedHead) t = select(seedHead, position.y.mul(0.15).add(0.85), t);
    if (broadLeaf) t = select(broadLeaf, species > 3.5 ? float(0.12) : part.mul(0.105).add(0.16), t);
    t = t.toVar('grassT');

    const rootPos = vec3(root.x, 0.006, root.y);
    const worldRoot = modelWorldMatrix.mul(vec4(rootPos, 1)).xyz.toVar('grassWorldRoot');
    const distanceToEye = distance(cameraPosition, worldRoot).toVar('grassEyeDistance');
    let density: Node = float(1).sub(smoothstep(s.lod.x.mul(0.5), s.lod.x, distanceToEye).mul(0.55))
      .mul(float(1).sub(smoothstep(s.lod.y.mul(0.65), s.lod.y, distanceToEye).mul(0.65)));
    const canopy: Node = species > 0.5 ? float(1) : select(root.z.greaterThanEqual(0.75), float(1), float(0));
    vCanopy.assign(canopy);
    // GRASS_DENSITY_SHADER, specialised (merged ribbons thin with range).
    density = merge
      ? select(canopy.greaterThan(0.5), mix(float(1), s.canopyDensity.z, smoothstep(s.canopyDensity.x, s.canopyDensity.y, distanceToEye)), density)
      : select(canopy.greaterThan(0.5), float(1), density);
    density = density.toVar('grassDensity');
    const densityBand = merge ? density.mul(0.065) : float(0.065);
    const growth = float(1).sub(smoothstep(density.sub(densityBand), density, shape.w))
      .mul(select(canopy.greaterThan(0.5), float(1), float(1).sub(smoothstep(s.lod.z.mul(0.8), s.lod.z, distanceToEye))))
      .mul(smoothstep(birth.x, birth.x.add(0.35), s.time))
      .toVar('grassGrowth');
    const h = root.z.mul(growth).toVar('grassH');
    const forward = vec2(sin(root.w), cos(root.w));
    const windSpeed = length(s.wind);
    const windDir = s.wind.div(max(windSpeed, 0.001));
    // The city's procedural noise: one cached tap per vertex.
    const gust = (texture(s.windNoise, worldRoot.xz.mul(0.018).sub(s.wind.mul(s.time).mul(0.003))) as Node).level(0).r;
    const ripple = sin(dot(worldRoot.xz, windDir).mul(1.7).sub(s.time.mul(windSpeed.mul(0.22).add(2))).add(shape.z.mul(6.28)));
    const bend = forward.mul(shape.y.add(dryness.mul(0.18)))
      .add(windDir.mul(min(windSpeed.mul(0.055), 0.8))
        .mul(gust.mul(0.85).add(0.3).add(ripple.mul(0.1)))
        .mul(float(1.2).sub(stiffness.mul(0.65)))
        .mul(mix(float(1), float(0.6), smoothstep(1.25, 2.5, root.z))))
      .toVar('grassBend');
    const away = worldRoot.xz.sub(s.viewer.xz);
    const push = float(1).sub(smoothstep(0.2, 1.15, length(away)))
      .mul(float(1).sub(smoothstep(2, 3.5, abs(s.viewer.y.sub(worldRoot.y)))))
      .toVar('grassPush');
    bend.addAssign(away.div(max(length(away), 0.01)).mul(push).mul(1.5));
    for (let i = 0; i < 2; i += 1) {
      const body = s.canopies[i];
      const delta = worldRoot.xz.sub(body.xz);
      const amount = float(1).sub(smoothstep(body.w.mul(0.5), body.w.add(0.5), length(delta)))
        .mul(smoothstep(-0.2, 0.3, worldRoot.y.add(h).sub(body.y.sub(body.w))));
      const active = h.greaterThan(1).and(s.canopyCount.greaterThan(i));
      bend.addAssign(select(active, delta.div(max(length(delta), 0.05)).mul(amount).mul(0.8), vec2(0)));
    }
    for (let i = 0; i < 2; i += 1) {
      const impulse = s.impulses[i];
      const age = clamp(s.time.sub(impulse.z), 0, 1.6);
      const delta = worldRoot.xz.sub(impulse.xy);
      const wave = max(float(0), float(1).sub(abs(length(delta).sub(age.mul(7))).div(1.75)))
        .mul(float(1).sub(age.div(1.6))).mul(impulse.w);
      bend.addAssign(select(s.impulseCount.greaterThan(i), delta.div(max(length(delta), 0.05)).mul(wave).mul(0.65), vec2(0)));
    }
    const contactUv = worldRoot.xz.sub(s.contactBounds.xy).div(s.contactBounds.zw);
    const clampedUv = clamp(contactUv, 0, 1);
    const contact = mix(
      (texture(s.previousContacts, clampedUv) as Node).level(0),
      (texture(s.contacts, clampedUv) as Node).level(0),
      s.contactBlend,
    );
    const contactEdge = smoothstep(0, 0.04, min(min(contactUv.x, contactUv.y), min(float(1).sub(contactUv.x), float(1).sub(contactUv.y))));
    const contactR = max(contact.r, contact.a.mul(mix(float(0.35), float(0.95), max(dryness, float(1).sub(health))))).mul(contactEdge).toVar('grassContactR');
    const contactDirection = contact.gb.mul(255).sub(128).div(127).mul(contactEdge);
    bend.assign(bend.mul(float(1).sub(contactR.mul(0.65))).add(contactDirection.mul(1.6)));
    push.assign(max(push, contactR.mul(1.48)));

    const compression = max(contactR, push.mul(0.55)).toVar('grassCompression');
    const bendLength = length(bend);
    const bendAxis = select(bendLength.greaterThan(0.001), bend.div(bendLength), forward).toVar('grassBendAxis');
    const baseAngle = compression.mul(1.46);
    const curvature = mix(clamp(bendLength, 0.02, 1.5), float(0.06), compression);
    const angle = baseAngle.add(curvature.mul(t));
    let centre: Node = grassArc(t, h, baseAngle, curvature, bendAxis);
    let tangent: Node = vec3(bendAxis.x.mul(sin(angle)), cos(angle), bendAxis.y.mul(sin(angle)));
    const twist = shape.z.sub(0.5).mul(0.65).mul(t);
    let side: Node = normalize(vec3(forward.y, 0, forward.x.negate()).add(vec3(forward.x, 0, forward.y).mul(twist)));
    let width: Node = shape.x.mul(float(1).sub(t.mul(t))).mul(growth);
    if (species > 0.5 && !seedHeadSpecies && !broadLeafSpecies) width = width.mul(species > 2.5 ? 0.22 : 0.45);
    if (seedHead) {
      const heading = root.w.add(part.mul(1.5708));
      const seedWidth = h.mul(species > 1.5 ? 0.024 : 0.02).mul(sin(position.y.mul(PI))).mul(cos(position.y.mul(50)).mul(0.2).add(0.8));
      // Non-head parts of these species keep the reduced blade width.
      width = select(seedHead, seedWidth, width.mul(species > 2.5 ? 0.22 : 0.45));
      side = select(seedHead, vec3(cos(heading), 0, sin(heading).negate()), side);
    }
    if (broadLeaf) {
      const leafT = position.y;
      const heading = root.w.add(part.mul(2.39996));
      const leafAxis = vec2(sin(heading), cos(heading));
      const leafLength = h.mul(species > 3.5 ? 0.85 : 0.48);
      const flutter = sin(s.time.mul(float(3).sub(dryness)).add(shape.z.mul(6.28)).add(part)).mul(windSpeed).mul(0.0015);
      const lift = sin(leafT.mul(PI)).mul(0.32).add(flutter.mul(leafT)).mul(float(1).sub(compression));
      centre = select(broadLeaf, centre.add(vec3(leafAxis.x.mul(leafT), lift, leafAxis.y.mul(leafT)).mul(leafLength)), centre);
      side = select(broadLeaf, vec3(leafAxis.y, 0, leafAxis.x.negate()), side);
      tangent = select(broadLeaf, vec3(leafAxis.x, cos(leafT.mul(PI)).mul(float(1).sub(compression)), leafAxis.y), tangent);
      width = select(broadLeaf, leafLength.mul(species > 3.5 ? 0.25 : 0.15).mul(sin(leafT.mul(PI))), width.mul(species > 2.5 ? 0.22 : 0.45));
    }
    // Broaden sparse far blades slightly to preserve meadow coverage.
    width = width.mul(mix(float(1), select(canopy.greaterThan(0.5), float(1), float(1.65)), smoothstep(s.lod.x, s.lod.y, distanceToEye)));
    // GRASS_WIDTH_SHADER: merged ribbons conserve projected area as they thin.
    if (merge) width = width.div(density);

    const bladePosition = rootPos.add(centre).add(side.mul(position.x).mul(width));
    const objectNormal = normalize(cross(side, tangent.add(vec3(0, 0.00001, 0))));
    normalLocal.assign(normalize(objectNormal.add(side.mul(position.x).mul(0.5)).add(vec3(0, 0.35, 0))));

    vWorld.assign(modelWorldMatrix.mul(vec4(bladePosition, 1)).xyz);
    const height: Node = broadLeaf ? select(broadLeaf, max(t, position.y.mul(0.85)), t) : t;
    vHeight.assign(height);
    vDryness.assign(dryness);
    const leafTint = mix(tint, vec3(0.46, 0.33, 0.12), dryness.mul(0.28)).mul(mix(float(0.72), float(1.08), health));
    const base = leafTint.mul(mix(float(0.22), float(0.38), shape.z));
    const tip = leafTint.mul(mix(float(0.85), float(1.25), shape.z));
    let colour: Node = mix(base, tip, pow(height, 0.75));
    colour = mix(colour, vec3(0.34, 0.22, 0.08), dryness.mul(smoothstep(0.6, 1, position.y)).mul(0.55));
    if (seedHead) colour = select(seedHead, mix(colour, vec3(0.52, 0.36, 0.12), species > 1.5 ? 0.65 : 0.8), colour);
    vColor.assign(colour);
    return bladePosition;
  })();

  // Fragment: canopy handoff dither, then the leaf colour with root occlusion.
  const occlusion = mix(float(0.72), float(1), smoothstep(0, 0.65, vHeight));
  material.colorNode = Fn(() => {
    If(vCanopy.greaterThan(0.5), () => {
      const handoff = smoothstep(s.handoff.x, s.handoff.y, distance(cameraPosition, vWorld));
      const dither = fract(fract(dot(floor(screenCoordinate.xy), vec2(0.06711056, 0.00583715))).mul(52.9829189));
      If(dither.lessThan(handoff), () => {
        Discard();
      });
    });
    return materialColor.mul(vColor).mul(occlusion);
  })();
  // Two-sided leaves keep the canopy's upward bias on both faces.
  const nv: Node = (normalViewGeometry as Node).mul(faceDirection);
  const up: Node = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  material.normalNode = normalize(nv.add(up.mul(float(0.45).sub(min(dot(nv, up), 0)))));
  // Thin-leaf transmission toward the sun (foliageLightFragment).
  const view = normalize(cameraPosition.sub(vWorld));
  const transmission = pow(max(dot(view.negate(), s.sun), 0), 3);
  material.emissiveNode = vColor.mul(s.sunColor).mul(transmission)
    .mul(mix(float(0.42), float(0.12), vDryness)).mul(smoothstep(0.05, 0.85, vHeight)).mul(occlusion);
  return material;
}
