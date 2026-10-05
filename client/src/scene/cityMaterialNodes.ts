// The city's triplanar concrete on the WebGPU path, in TSL: the same
// projection as cityMaterialShader.ts (rest-space coordinates, wall/floor
// layers, whiteout normal blend), from the same texture arrays and the same
// live tuning objects, so one tuning retunes both renderers.
//
// Only imported behind __WEBGPU__ (scene/citySlotNodes.ts).
//
// Two variants, as on WebGL: plain (mapFragmentPlain) and the hero stack
// (MAP_FRAGMENT_HERO; scene/cityHeroNodes.ts), each with the surface sheet's
// normal, roughness and occlusion on the full tier.

import * as THREE from 'three';
import {
  Fn,
  If,
  abs,
  attribute,
  cross,
  dFdx,
  dFdy,
  dot,
  faceDirection,
  float,
  floor,
  int,
  length,
  max,
  modelViewMatrix,
  normalize,
  normalViewGeometry,
  positionView,
  pow,
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

import { clamp as clampNode, exp2 as exp2Node, mix as mixNode } from 'three/tsl';
import { layerMean, layerRotation, macroField, samplePlane } from './cityHeroNodes';
import {
  BLEND_SHARPNESS,
  PLANE_CUTOFF,
  cityShaderUniforms as tuning,
  type CityTriplanarConfig,
} from './cityMaterialShader';
import { CITY_TEX_METRES, LAYER_CODE_RADIX, cityTextures } from './cityTextures';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface CityTriplanarNodes {
  /** Multiplies the material's base colour. */
  albedo: Node;
  /** View-space normal, roughness and occlusion; null on the albedo tier. */
  normal: Node | null;
  roughness: Node | null;
  occlusion: Node | null;
}

/**
 * The triplanar terms for a slot mesh's material. `restToView` takes a
 * rest-space direction to view space (the chunk's pose, then the view).
 */
export function cityTriplanarNodes(
  config: CityTriplanarConfig,
  restToView: (direction: Node) => Node,
): CityTriplanarNodes {
  const surface = config.pbr && config.detail === 'full';
  const textures = cityTextures();
  const metres = uniformArray(Array.from(CITY_TEX_METRES), 'float');
  const texScale = liveUniform(tuning.cityTexScale, 'float');
  const tone = liveUniform(tuning.cityTone, 'color');
  const normalScale = liveUniform(tuning.cityNormalScale, 'float');

  // Rest-space position and layer code: per vertex on a slot mesh (the
  // anchor carries the absolute rest position; see VERTEX_PARS).
  const anchor: Node = attribute('cityAnchor', 'vec4');
  const restPos: Node = anchor.xyz;
  const layerCode: Node = anchor.w;

  const hero = config.hero && surface;
  const dx: Node = dFdx(restPos);
  const dy: Node = dFdy(restPos);
  const geoN: Node = normalize(cross(dx, dy));
  const sharp: Node = pow(abs(geoN), vec3(BLEND_SHARPNESS));
  // The hero stack skips planes whose weight is cut to zero (PLANE_CUTOFF).
  const cut: Node = hero ? max(sharp.sub(PLANE_CUTOFF), vec3(0)) : sharp;
  const blend: Node = cut.div(max(cut.x.add(cut.y).add(cut.z), 1e-5));

  const floorLayer: Node = floor(layerCode.div(LAYER_CODE_RADIX));
  const wallLayer: Node = layerCode.sub(floorLayer.mul(LAYER_CODE_RADIX));
  const wallIndex: Node = int(wallLayer);
  const floorIndex: Node = int(floorLayer);
  const wallM: Node = metres.element(wallIndex).mul(texScale);
  const floorM: Node = metres.element(floorIndex).mul(texScale);
  const uvX: Node = restPos.zy.div(wallM);
  const uvY: Node = restPos.xz.div(floorM);
  const uvZ: Node = restPos.xy.div(wallM);

  let albedo: Node;
  let roughness: Node;
  let occlusion: Node;
  let nx: Node;
  let ny: Node;
  let nz: Node;
  if (hero) {
    const out = heroPlanes({
      restPos, dx, dy, blend, wallIndex, floorIndex, wallM, floorM, uvX, uvY, uvZ, normalScale,
    });
    albedo = out.get('albedo');
    roughness = out.get('rough');
    occlusion = out.get('ao');
    nx = out.get('nx');
    ny = out.get('ny');
    nz = out.get('nz');
  } else {
    const tap = (sheet: THREE.Texture, uv: Node, layer: Node): Node => texture(sheet, uv).depth(layer);
    albedo = tap(textures.albedo, uvX, wallIndex).rgb.mul(blend.x)
      .add(tap(textures.albedo, uvY, floorIndex).rgb.mul(blend.y))
      .add(tap(textures.albedo, uvZ, wallIndex).rgb.mul(blend.z));
    if (!surface) return { albedo: tone.mul(albedo), normal: null, roughness: null, occlusion: null };
    const sx: Node = tap(textures.surface, uvX, wallIndex);
    const sy: Node = tap(textures.surface, uvY, floorIndex);
    const sz: Node = tap(textures.surface, uvZ, wallIndex);
    roughness = dot(vec3(sx.b, sy.b, sz.b), blend);
    occlusion = dot(vec3(sx.a, sy.a, sz.a), blend);
    nx = sx.rg.mul(2).sub(1).mul(normalScale);
    ny = sy.rg.mul(2).sub(1).mul(normalScale);
    nz = sz.rg.mul(2).sub(1).mul(normalScale);
  }

  // Whiteout blend (NORMAL_FRAGMENT): each plane's tangent normal folded into
  // rest space, summed by the plane weights, then posed into view space.
  const facing: Node = dot(restToView(geoN), normalViewGeometry.mul(faceDirection)).lessThan(0).select(float(-1), float(1));
  const n: Node = geoN.mul(facing);
  const lift = (t: Node): Node => vec3(t, sqrt(max(float(1).sub(dot(t, t)), 0)));
  const tx: Node = lift(nx);
  const ty: Node = lift(ny);
  const tz: Node = lift(nz);
  const wx: Node = vec3(tx.xy.add(n.zy), abs(tx.z).mul(n.x)).zyx;
  const wy: Node = vec3(ty.xy.add(n.xz), abs(ty.z).mul(n.y)).xzy;
  const wz: Node = vec3(tz.xy.add(n.xy), abs(tz.z).mul(n.z));
  const objN: Node = wx.mul(blend.x).add(wy.mul(blend.y)).add(wz.mul(blend.z));

  return {
    albedo: tone.mul(albedo),
    normal: normalize(restToView(normalize(objN))),
    roughness,
    occlusion,
  };
}

/** A rest-space direction rotated by quaternion `q`, then into view space. */
export function restToViewThrough(q: Node, quatRotate: (q: Node, v: Node) => Node): (direction: Node) => Node {
  return (direction: Node) => modelViewMatrix.mul(vec4(quatRotate(q, direction), 0)).xyz;
}

const HeroOut = struct({
  albedo: 'vec3', rough: 'float', ao: 'float', nx: 'vec2', ny: 'vec2', nz: 'vec2',
}, 'CityHeroOut');

/**
 * MAP_FRAGMENT_HERO: each plane with any weight sampled through the hero
 * stack, the macro field over them, and the per-plane tangent normals scaled
 * for the whiteout blend. Evaluated once per shader (colour, normal,
 * roughness and occlusion all read it).
 */
function heroPlanes(p: {
  restPos: Node; dx: Node; dy: Node; blend: Node; wallIndex: Node; floorIndex: Node;
  wallM: Node; floorM: Node; uvX: Node; uvY: Node; uvZ: Node; normalScale: Node;
}): Node {
  const tuningRef = (name: keyof typeof tuning): Node => liveUniform(tuning[name], 'float');
  return (Fn(() => {
    // Derivatives first, outside every branch: TSL emits an expression where
    // it is first used, and dpdx/dpdy inside a per-plane branch are
    // undefined (they collapse to ~0, i.e. mip 0). The GLSL takes them before
    // its first branch for the same reason.
    const dx = vec3(0).toVar('cityRestDx');
    const dy = vec3(0).toVar('cityRestDy');
    dx.assign(p.dx);
    dy.assign(p.dy);
    const hexFade = float(1).sub(smoothstep(tuningRef('cityHexFadeStart'), tuningRef('cityHexFadeEnd'), length(positionView))).toVar('cityHexFade');
    const wallRot = layerRotation(p.wallIndex);
    const floorRot = layerRotation(p.floorIndex);
    const wallMean = layerMean(p.wallIndex);
    const floorMean = layerMean(p.floorIndex);
    const plane = () => ({ albedo: vec3(0).toVar(), nxy: vec2(0).toVar(), rough: float(0).toVar(), ao: float(0).toVar() });
    const px = plane();
    const py = plane();
    const pz = plane();
    const macro = float(0).toVar();
    const take = (into: ReturnType<typeof plane>, sample: Node) => {
      into.albedo.assign(sample.get('albedo'));
      into.nxy.assign(sample.get('nxy'));
      into.rough.assign(sample.get('rough'));
      into.ao.assign(sample.get('ao'));
    };
    If(p.blend.x.greaterThan(0), () => {
      take(px, samplePlane(p.uvX, dx.zy.div(p.wallM), dy.zy.div(p.wallM), p.wallIndex, wallRot, wallMean, hexFade));
      macro.addAssign(macroField(p.restPos.zy, dx.zy, dy.zy).mul(p.blend.x));
    });
    If(p.blend.y.greaterThan(0), () => {
      take(py, samplePlane(p.uvY, dx.xz.div(p.floorM), dy.xz.div(p.floorM), p.floorIndex, floorRot, floorMean, hexFade));
      macro.addAssign(macroField(p.restPos.xz, dx.xz, dy.xz).mul(p.blend.y));
    });
    If(p.blend.z.greaterThan(0), () => {
      take(pz, samplePlane(p.uvZ, dx.xy.div(p.wallM), dy.xy.div(p.wallM), p.wallIndex, wallRot, wallMean, hexFade));
      macro.addAssign(macroField(p.restPos.xy, dx.xy, dy.xy).mul(p.blend.z));
    });
    const signed = macro.mul(2).sub(1);
    const temp = tuningRef('cityMacroTemp');
    const albedo = px.albedo.mul(p.blend.x).add(py.albedo.mul(p.blend.y)).add(pz.albedo.mul(p.blend.z))
      .mul(exp2Node(signed.mul(tuningRef('cityMacroAlbedo'))))
      .mul(mixNode(
        vec3(float(1).sub(temp.mul(0.65)), 1, temp.add(1)),
        vec3(temp.add(1), 1, float(1).sub(temp.mul(0.72))),
        macro,
      ));
    const rough = clampNode(
      dot(vec3(px.rough, py.rough, pz.rough), p.blend).add(signed.mul(tuningRef('cityMacroRough'))), 0.05, 1);
    const ao = dot(vec3(px.ao, py.ao, pz.ao), p.blend);
    const gain = p.normalScale.mul(max(float(0.05), signed.mul(tuningRef('cityMacroNormal')).add(1)));
    return HeroOut(albedo, rough, ao, px.nxy.mul(gain), py.nxy.mul(gain), pz.nxy.mul(gain));
  }) as Node).once()();
}
