// The ground on the WebGPU path, in TSL: groundMapFragment and its normal,
// roughness and occlusion (cityMaterialShader.ts), from the same sheets, the
// same hero helpers (cityHeroNodes.ts) and the same live tuning objects.
// One projection (world XZ), two layers (grass, and dirt keyed by the
// splatmap plus a macro-field mask), the canopy tint from the grass paint.
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import * as THREE from 'three';
import {
  Fn,
  If,
  attribute,
  cameraViewMatrix,
  clamp,
  dFdx,
  dFdy,
  dot,
  exp2,
  faceDirection,
  float,
  length,
  max,
  mix,
  normalViewGeometry,
  normalize,
  positionGeometry,
  positionView,
  smoothstep,
  sqrt,
  struct,
  texture,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { liveUniform } from '../graphics/webgpu/liveUniform';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import { layerMean, macroField, samplePlane } from './cityHeroNodes';
import { cityShaderUniforms as tuning, groundShaderUniforms, type GroundTexturesConfig } from './cityMaterialShader';
import { CITY_TEX_METRES, GROUND_LAYER_COUNT, GROUND_LAYER_START, cityTextures } from './cityTextures';
import { cityGrassPaint } from './grass/GrassPaint';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const t = (name: keyof typeof tuning): Node => liveUniform(tuning[name], 'float');
const GroundOut = struct({ albedo: 'vec3', rough: 'float', ao: 'float', nxy: 'vec2' }, 'GroundOut');

/** The textured terrain material for the WebGPU path (cf. applyGroundTextures). */
export function groundNodeMaterial(source: THREE.Material, config: GroundTexturesConfig): THREE.Material {
  const base = source as THREE.MeshStandardMaterial;
  const material = new MeshStandardNodeMaterial({
    roughness: base.roughness,
    metalness: base.metalness,
    side: base.side,
  });
  const { surface, grassCover } = config;
  const hero = config.hero && surface;
  const textures = cityTextures();
  const ga = GROUND_LAYER_START;
  const gb = GROUND_LAYER_START + (GROUND_LAYER_COUNT > 1 ? 1 : 0);
  const metres = uniformArray(Array.from(CITY_TEX_METRES), 'float');
  const texScale = liveUniform(tuning.cityTexScale, 'float');
  const tone = liveUniform(tuning.cityTone, 'color');
  const normalScale = liveUniform(tuning.cityNormalScale, 'float');
  const dirtStart = liveUniform(groundShaderUniforms.groundDirtStart, 'float');
  const dirtEnd = liveUniform(groundShaderUniforms.groundDirtEnd, 'float');
  const weights: Node = attribute('materialWeights', 'vec4');
  // Terrain tile positions ARE world coordinates (GROUND_VERTEX_BODY).
  const pos: Node = (positionGeometry as Node).xz;

  const out = (Fn(() => {
    // Derivatives before any branch (see cityMaterialNodes.ts heroPlanes).
    const dx = vec2(0).toVar('groundDx');
    const dy = vec2(0).toVar('groundDy');
    dx.assign(dFdx(pos));
    dy.assign(dFdy(pos));
    const aM = metres.element(ga).mul(texScale);
    const bM = metres.element(gb).mul(texScale);
    const cover: Node = grassCover ? texture(cityGrassPaint.cover, pos.add(256).div(512)) : null;

    const albedo = vec3(0).toVar();
    const rough = float(1).toVar();
    const ao = float(1).toVar();
    const nxy = vec2(0).toVar();
    const dirt = float(0).toVar();
    if (hero) {
      const hexFade = float(1).sub(smoothstep(t('cityHexFadeStart'), t('cityHexFadeEnd'), length(positionView))).toVar();
      // A larger read of the macro field drives WHERE the dirt lives.
      const patch = macroField(pos.mul(0.31), dx.mul(0.31), dy.mul(0.31));
      dirt.assign(clamp(weights.y.add(weights.z).add(weights.w).add(smoothstep(dirtStart, dirtEnd, patch)), 0, 1));
      if (cover) dirt.assign(max(dirt, float(1).sub(cover.a)));
      const macro = macroField(pos, dx, dy).toVar();
      const a = { albedo: vec3(0).toVar(), nxy: vec2(0).toVar(), rough: float(0).toVar(), ao: float(0).toVar() };
      const b = { albedo: vec3(0).toVar(), nxy: vec2(0).toVar(), rough: float(0).toVar(), ao: float(0).toVar() };
      const take = (into: typeof a, sample: Node) => {
        into.albedo.assign(sample.get('albedo'));
        into.nxy.assign(sample.get('nxy'));
        into.rough.assign(sample.get('rough'));
        into.ao.assign(sample.get('ao'));
      };
      If(dirt.lessThan(0.98), () => {
        take(a, samplePlane(pos.div(aM), dx.div(aM), dy.div(aM), ga, float(1), layerMean(ga), hexFade));
      });
      If(dirt.greaterThan(0.02), () => {
        take(b, samplePlane(pos.div(bM), dx.div(bM), dy.div(bM), gb, float(1), layerMean(gb), hexFade));
      });
      const signed = macro.mul(2).sub(1);
      const temp = t('cityMacroTemp');
      albedo.assign(mix(a.albedo, b.albedo, dirt)
        .mul(exp2(signed.mul(t('cityMacroAlbedo'))))
        .mul(mix(
          vec3(float(1).sub(temp.mul(0.65)), 1, temp.add(1)),
          vec3(temp.add(1), 1, float(1).sub(temp.mul(0.72))),
          macro,
        )));
      rough.assign(clamp(mix(a.rough, b.rough, dirt).add(signed.mul(t('cityMacroRough'))), 0.05, 1));
      ao.assign(mix(a.ao, b.ao, dirt));
      nxy.assign(mix(a.nxy, b.nxy, dirt).mul(normalScale).mul(max(float(0.05), signed.mul(t('cityMacroNormal')).add(1))));
    } else {
      // Plain: one tap per layer.
      dirt.assign(clamp(weights.y.add(weights.z).add(weights.w), 0, 1));
      if (cover) dirt.assign(max(dirt, float(1).sub(cover.a)));
      const ua = pos.div(aM);
      const ub = pos.div(bM);
      const tapA = (texture(textures.albedo, ua) as Node).grad(dx.div(aM), dy.div(aM)).depth(ga);
      const tapB = (texture(textures.albedo, ub) as Node).grad(dx.div(bM), dy.div(bM)).depth(gb);
      albedo.assign(mix(tapA.rgb, tapB.rgb, dirt));
      if (surface) {
        const sa = (texture(textures.surface, ua) as Node).grad(dx.div(aM), dy.div(aM)).depth(ga);
        const sb = (texture(textures.surface, ub) as Node).grad(dx.div(bM), dy.div(bM)).depth(gb);
        rough.assign(mix(sa.b, sb.b, dirt));
        ao.assign(mix(sa.a, sb.a, dirt));
        nxy.assign(mix(sa.rg, sb.rg, dirt).mul(2).sub(1).mul(normalScale));
      }
    }
    let colour: Node = tone.mul(albedo);
    if (cover) {
      // The photographed leafy_grass sheet is dry ochre: tint it to the
      // living canopy, keeping its detail and the dirt patches.
      const canopy = cover.rgb.mul(0.7).div(vec3(0.3199, 0.236, 0.1062));
      colour = colour.mul(mix(canopy, vec3(1), dirt));
    }
    return GroundOut(colour, rough, ao, nxy);
  }) as Node).once()();

  material.colorNode = out.get('albedo');
  if (surface) {
    material.roughnessNode = out.get('rough');
    material.aoNode = out.get('ao');
    // GROUND_NORMAL_FRAGMENT: perturb along the view-space images of world
    // X and Z, the axes the XZ projection ties the tangent space to.
    const n: Node = out.get('nxy');
    const tangent = normalize(cameraViewMatrix.mul(vec4(1, 0, 0, 0)).xyz);
    const bitangent = normalize(cameraViewMatrix.mul(vec4(0, 0, 1, 0)).xyz);
    const mapN = vec3(n, sqrt(max(float(1).sub(dot(n, n)), 0)));
    const geometryN = (normalViewGeometry as Node).mul(faceDirection);
    material.normalNode = normalize(tangent.mul(mapN.x).add(bitangent.mul(mapN.y)).add(geometryN.mul(mapN.z)));
  }
  return material;
}
