// Drawing a broken structure in the Fracture Lab, the way the city draws its
// chunks: every piece merged into ONE geometry, each vertex tagged with its
// piece, piece poses in a float texture the vertex shader composes. One draw
// per variant however many pieces there are, and moving pieces (explode,
// blast) rewrites a texture, not geometry -- so what the lab measures is what
// the city would pay.
//
// Outer faces wear the city's own rest-space triplanar concrete/brick/timber
// (cityMaterialNodes.ts), so "today" here looks exactly like /city today.
// Fracture faces take fractureNodes.ts.
//
// Only imported behind __WEBGPU__: `three` is three/webgpu in that build.

import * as THREE from 'three';
import {
  Fn,
  If,
  attribute,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  fwidth,
  int,
  ivec2,
  length,
  max,
  mix,
  normalGeometry,
  normalLocal,
  normalView,
  normalize,
  positionGeometry,
  sampler,
  select,
  smoothstep,
  sqrt,
  struct,
  texture,
  textureSize,
  texture3D,
  uniformArray,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';

import type { FracturePiece } from '../city/fracture/contacts';
import { canonicalSign } from '../city/fracture/canonical';
import { FRACTURE_LOOKS } from '../city/fracture/looks';
import { FRACTURE_CLASS_COUNT } from '../city/fracture/materialClass';
import type { PieceMesh } from '../city/fracture/pieceSkin';
import type { RebarFamily } from '../city/fracture/rebar';
import { cityTriplanarNodes, restToViewThrough } from '../scene/cityMaterialNodes';
import type { CityTriplanarConfig } from '../scene/cityMaterialShader';
import { quatRotate } from '../scene/quatNodes';
import { surfaceSet } from './fractureNodes';
import { fractureNoiseTexture } from './noiseTexture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** Piece poses: two texels per piece, [px, py, pz, visible] [qx, qy, qz, qw]. */
export class LabPoses {
  readonly data: Float32Array<ArrayBuffer>;
  readonly texture: THREE.DataTexture;
  constructor(readonly count: number) {
    let side = 4;
    while (side * side < count * 2) side *= 2;
    this.data = new Float32Array(new ArrayBuffer(side * side * 16)) as Float32Array<ArrayBuffer>;
    this.texture = new THREE.DataTexture(this.data, side, side, THREE.RGBAFormat, THREE.FloatType);
    for (let i = 0; i < count; i += 1) this.set(i, [0, 0, 0], [0, 0, 0, 1], 1);
    this.texture.needsUpdate = true;
  }
  set(i: number, p: ArrayLike<number>, q: ArrayLike<number>, visible = 1): void {
    const at = i * 8;
    this.data[at] = p[0];
    this.data[at + 1] = p[1];
    this.data[at + 2] = p[2];
    this.data[at + 3] = visible;
    this.data[at + 4] = q[0];
    this.data[at + 5] = q[1];
    this.data[at + 6] = q[2];
    this.data[at + 7] = q[3];
  }
  upload(): void {
    this.texture.needsUpdate = true;
  }
  dispose(): void {
    this.texture.dispose();
  }
}

export interface LabPieceLook {
  /** City texture layer code for the outer faces (cityTextures.ts). */
  layerCode: number;
}

/**
 * Merge every piece's mesh into one geometry. Positions stay piece-local; the
 * anchor carries the rest position the triplanar and fracture fields read.
 */
export function buildLabGeometry(
  pieces: readonly FracturePiece[], meshes: readonly PieceMesh[], looks: readonly LabPieceLook[],
  include: (piece: FracturePiece) => boolean = () => true,
): THREE.BufferGeometry {
  let vertices = 0;
  let indices = 0;
  meshes.forEach((mesh, p) => {
    if (!include(pieces[p])) return;
    vertices += mesh.positions.length / 3;
    indices += mesh.indices.length;
  });
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const anchor = new Float32Array(vertices * 4);
  const piece = new Float32Array(vertices);
  const face = new Float32Array(vertices * 4);
  const index = new Uint32Array(indices);
  let v = 0;
  let k = 0;
  meshes.forEach((mesh, p) => {
    if (!include(pieces[p])) return;
    const c = pieces[p].centroid;
    const grain = pieces[p].grainAxis ?? 3;
    const start = v;
    const count = mesh.positions.length / 3;
    for (let i = 0; i < count; i += 1, v += 1) {
      const x = mesh.positions[i * 3];
      const y = mesh.positions[i * 3 + 1];
      const z = mesh.positions[i * 3 + 2];
      position.set([x, y, z], v * 3);
      normal.set([mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]], v * 3);
      anchor.set([x + c[0], y + c[1], z + c[2], looks[p].layerCode], v * 4);
      piece[v] = p;
      face.set([mesh.kinds[i] + 8 * grain, pieces[p].cls, mesh.relief[i], mesh.sides[i]], v * 4);
    }
    for (const i of mesh.indices) index[k++] = start + i;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('cityAnchor', new THREE.BufferAttribute(anchor, 4));
  geometry.setAttribute('labPiece', new THREE.BufferAttribute(piece, 1));
  geometry.setAttribute('labFace', new THREE.BufferAttribute(face, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Every collider edge once, for the wireframe overlay. */
export function buildColliderGeometry(pieces: readonly FracturePiece[]): THREE.BufferGeometry {
  const position: number[] = [];
  const piece: number[] = [];
  pieces.forEach((p, index) => {
    const seen = new Set<string>();
    for (const face of p.poly.faces) {
      for (let k = 0; k < face.loop.length; k += 1) {
        const i = face.loop[k];
        const j = face.loop[(k + 1) % face.loop.length];
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        position.push(...p.poly.verts[i], ...p.poly.verts[j]);
        piece.push(index, index);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('labPiece', new THREE.Float32BufferAttribute(piece, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const texel = (tex: Node, index: Node): Node => {
  const size = int(textureSize(tex, int(0)).x);
  return tex.load(ivec2(index.mod(size), index.div(size)));
};

/** Compose a vertex's posed position from its piece's texels; writes the pose varying. */
/**
 * Which pieces a mesh draws, from the pose's fourth component: 0 hidden,
 * 1 drawn by the shading-only mesh, 2 drawn by the detailed pool instead.
 * 'all' draws anything not hidden (a whole specimen built one way).
 */
export type LabTier = 'all' | 'base' | 'skin';

function posedPosition(
  poses: LabPoses, pose: Node | null, tier: LabTier = 'all', instanceStride = 0,
  compact: { info: THREE.DataTexture; rest: Node } | null = null,
): Node {
  const tex = texture(poses.texture);
  tex.updateMatrix = false;
  const infoTex = compact ? texture(compact.info) : null;
  if (infoTex) infoTex.updateMatrix = false;
  return Fn(() => {
    // Instanced copies of one specimen: copy c's piece p is global piece
    // p + c * stride in the pose texture.
    const local = int(attribute('labPiece', 'float'));
    // The copy comes from a per-instance attribute (the culler compacts the
    // visible copies), not from the instance index.
    const p = instanceStride > 0 ? local.add(int(attribute('labCopy', 'float')).mul(instanceStride)) : local;
    const t0 = texel(tex, p.mul(2));
    const q = texel(tex, p.mul(2).add(1));
    if (pose) {
      pose.assign(q);
      // Compact geometry carries no normals: flat shading derives them.
      if (!compact) normalLocal.assign(quatRotate(q, normalGeometry));
    }
    if (compact && infoTex) {
      // Rest position = the piece's rest centre (per-piece texel) + local.
      compact.rest.assign(texel(infoTex, local).xyz.add(positionGeometry));
    }
    const shown = tier === 'base' ? select(t0.w.greaterThan(0.5).and(t0.w.lessThan(1.5)), float(1), float(0))
      : tier === 'skin' ? select(t0.w.greaterThan(1.5), float(1), float(0))
        : select(t0.w.greaterThan(0.5), float(1), float(0));
    return quatRotate(q, positionGeometry).mul(shown).add(t0.xyz);
  })();
}

/**
 * The per-class look as ONE uniform array of vec4 rows the shader indexes by
 * class. One binding, not twelve: WebGPU allows only 12 uniform buffers per
 * shader stage, and the city triplanar and the camera already use some.
 *
 *   class c, rows c*8 + 0..7: shade base, accent, a, b; skin color, color2, a, b
 *   rebar family f, rows 96 + f*4 + 0..3: dir, across, depthAxis, (spacing, phase, depth, radius)
 *   row 112: (rebar family count, -, -, -)
 */
const ROWS_PER_CLASS = 8;
const REBAR_ROW = FRACTURE_CLASS_COUNT * ROWS_PER_CLASS;
const COUNT_ROW = REBAR_ROW + 16;

export class FractureLookUniforms {
  readonly rows = uniformArray(Array.from({ length: COUNT_ROW + 1 }, () => new THREE.Vector4()), 'vec4');

  private set(row: number, x: number, y: number, z: number, w: number): void {
    (this.rows.array[row] as THREE.Vector4).set(x, y, z, w);
  }

  /** Row `k` of class `cls` (a TSL int node). */
  classRow(cls: Node, k: number): Node {
    return this.rows.element(cls.mul(ROWS_PER_CLASS).add(k));
  }

  rebarRow(family: number, k: number): Node {
    return this.rows.element(REBAR_ROW + family * 4 + k);
  }

  get rebarCount(): Node {
    return this.rows.element(COUNT_ROW).x;
  }

  /** Copy the live look table in; cheap, run every frame. */
  refresh(): void {
    FRACTURE_LOOKS.forEach((look, cls) => {
      const r = cls * ROWS_PER_CLASS;
      const s = look.shade;
      this.set(r, s.base[0], s.base[1], s.base[2], 0);
      this.set(r + 1, s.accent[0], s.accent[1], s.accent[2], 0);
      this.set(r + 2, s.accentFill, s.accentSize, s.bumpSize, s.bumpDepth);
      this.set(r + 3, s.pores, s.roughness, s.metalness, s.cavity);
      const k = look.skin;
      this.set(r + 4, k.color[0], k.color[1], k.color[2], 0);
      this.set(r + 5, k.color2[0], k.color2[1], k.color2[2], 0);
      this.set(r + 6, k.scale, k.bump, k.roughness, k.variation);
      this.set(r + 7, k.grime, k.detail, 0, 0);
    });
  }

  setRebar(families: readonly RebarFamily[]): void {
    const n = Math.min(4, families.length);
    this.set(COUNT_ROW, n, 0, 0, 0);
    for (let i = 0; i < n; i += 1) {
      const f = families[i];
      const r = REBAR_ROW + i * 4;
      this.set(r, f.dir[0], f.dir[1], f.dir[2], 0);
      this.set(r + 1, f.across[0], f.across[1], f.across[2], 0);
      this.set(r + 2, f.depthAxis[0], f.depthAxis[1], f.depthAxis[2], 0);
      this.set(r + 3, f.spacing, f.phase, f.depth, f.radius);
    }
  }
}

export interface LabMaterialOptions {
  triplanar: CityTriplanarConfig;
  /** Shade cut faces as broken material (else they wear the outer texture, as today). */
  fracture: boolean;
  /** Colour faces by kind instead (exterior / fracture / joint / rebar). */
  debugKinds: boolean;
  wireframe: boolean;
  /**
   * The outer faces: 'procedural' skins (concrete form face, brickwork,
   * timber, paint) that agree with the broken interior, or the city's
   * photographic texture layers as /city has them.
   */
  skin: 'procedural' | 'city';
  /** Which pieces this mesh draws (see LabTier). */
  tier?: LabTier;
  /** Pieces per instanced copy, when drawn as an InstancedMesh of copies. */
  instanceStride?: number;
  /**
   * Compact vertex layout (buildCompactGeometry): position, piece and one
   * packed code per vertex; rest centres from `info` (PieceInfo), normals
   * from screen derivatives. Procedural skins only.
   */
  compact?: PieceInfo;
  /**
   * Cost probes (bench only): 'unlit' draws the geometry in a constant
   * colour (vertex + raster floor); 'lit' adds PBR lighting and shadows on a
   * constant albedo. The difference to the full material is the surface's.
   */
  probe?: 'unlit' | 'lit';
  /**
   * Draw one class and one face kind only (skin, or cut/joint), with both
   * fixed at compile time: see buildCompactGeometry's groups.
   */
  only?: LabGroup;
  /** Value noise: the precomputed 3D table (default) or hashed per call. */
  noise?: 'texture' | 'hash';
}

const LabOut = struct({ albedo: 'vec3', rough: 'float', metal: 'float', ao: 'float', normal: 'vec3' }, 'FractureLabOut');

export function labMaterial(poses: LabPoses, looks: FractureLookUniforms, options: LabMaterialOptions): THREE.Material {
  if (options.probe) {
    const probe = options.probe === 'unlit'
      ? new MeshBasicNodeMaterial({ color: 0x8a7f72 })
      : new MeshStandardNodeMaterial({ color: 0x8a7f72, roughness: 0.9, metalness: 0 });
    probe.positionNode = posedPosition(
      poses, options.compact ? null : varyingProperty('vec4', 'vCityQuat'), options.tier ?? 'all', options.instanceStride ?? 0,
    );
    if (options.compact && probe instanceof MeshStandardNodeMaterial) probe.flatShading = true;
    return probe;
  }
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  material.wireframe = options.wireframe;
  const pose = varyingProperty('vec4', 'vCityQuat');
  const compact = options.compact ?? null;
  const restVarying = varyingProperty('vec3', 'vLabRest');
  material.positionNode = posedPosition(
    poses, pose, options.tier ?? 'all', options.instanceStride ?? 0,
    compact ? { info: compact.texture, rest: restVarying } : null,
  );
  if (compact) material.flatShading = true;
  const restToView = restToViewThrough(pose, quatRotate);
  // Procedural skins replace the city's texture layers entirely, so they are
  // only sampled when the outer faces actually wear them.
  const procedural = options.fracture && options.skin === 'procedural';
  const tri = procedural || compact ? null : cityTriplanarNodes(options.triplanar, restToView);

  const out = (Fn(() => {
    const albedo = vec3(tri ? tri.albedo : vec3(1)).toVar('labAlbedo');
    const rough = float(tri?.roughness ?? 0.92).toVar('labRough');
    const ao = float(tri?.occlusion ?? 1).toVar('labAo');
    const nView = vec3(tri?.normal ?? normalView).toVar('labNormal');
    const metal = float(0).toVar('labMetal');
    // Per-vertex face data: the full layout's vec4, or decoded from the
    // compact layout's one packed code (kind + 8 grain + 64 class + 1024 side).
    let face: Node;
    let restPos: Node;
    if (compact) {
      // Rounded: interpolating three equal values need not return it exactly.
      const code = floor(attribute('labCode', 'float').add(0.5));
      const sideCode = floor(code.div(1024));
      const clsCode = floor(code.sub(sideCode.mul(1024)).div(64));
      const kindGrain = code.sub(sideCode.mul(1024)).sub(clsCode.mul(64));
      face = vec4(kindGrain, clsCode, float(0), sideCode.sub(1));
      restPos = restVarying;
    } else {
      face = attribute('labFace', 'vec4');
      restPos = attribute('cityAnchor', 'vec4').xyz;
    }
    const grainCode = floor(face.x.div(8));
    const kind = face.x.sub(grainCode.mul(8));
    // Footprint and (compact) flat normal BEFORE any branch: derivatives
    // inside one are undefined.
    const fp = max(length(fwidth(restPos)), float(1e-5)).toVar('labFootprint');
    const restN = (compact
      ? normalize(cross(dFdx(restPos), dFdy(restPos)))
      : normalize(normalGeometry)).toVar('labRestN');

    // A specialised draw fixes the class and the face kind at compile time.
    const only = options.only ?? null;
    const clsF = only ? float(only.cls) : face.y;
    const cls = only ? int(only.cls) : int(face.y);
    // Value noise from the precomputed table (two trailing arguments), or
    // hashed per call.
    const textured = options.noise !== 'hash';
    const set = surfaceSet(only ? only.cls : null, textured);
    const noiseArgs: Node[] = [];
    if (textured) {
      const table = texture3D(fractureNoiseTexture());
      noiseArgs.push(table, sampler(table));
    }
    const skinFn = (...args: Node[]) => set.skin(...args, ...noiseArgs);
    const fractureFn = (...args: Node[]) => set.fracture(...args, ...noiseArgs);
    const rebarFn = (...args: Node[]) => set.rebar(...args, ...noiseArgs);
    const grain = select(grainCode.equal(0), vec3(1, 0, 0),
      select(grainCode.equal(1), vec3(0, 1, 0), select(grainCode.equal(2), vec3(0, 0, 1), vec3(0))));

    // Outer faces: the skin, worn through to the interior at the arrises.
    const skinBranch = () => {
      if (procedural) {
        const sk = skinFn(
          restPos, restN, clsF, fp,
          looks.classRow(cls, 4).xyz, looks.classRow(cls, 5).xyz,
          looks.classRow(cls, 6), looks.classRow(cls, 7), grain,
        ).toVar('labSkin');
        albedo.assign(sk.element(0).xyz);
        rough.assign(sk.element(0).w);
        ao.assign(sk.element(1).w);
        metal.assign(sk.element(2).x);
        nView.assign(normalize(restToView(sk.element(1).xyz)));
      } else {
        // Worn geometry must SHADE round: the interpolated normal, not the
        // triplanar's flat derivative one.
        If(face.z.greaterThan(0.02), () => { nView.assign(normalize(restToView(restN))); });
      }
      // Compact geometry is flat: nothing is worn.
      if (compact) return;
      const worn = smoothstep(0.3, 1.0, face.z).toVar('labWorn');
      If(worn.greaterThan(0.001), () => {
        const inner = fractureFn(
          restPos, restN, clsF, float(-0.2), fp,
          looks.classRow(cls, 0).xyz, looks.classRow(cls, 1).xyz,
          looks.classRow(cls, 2), looks.classRow(cls, 3), grain, face.w,
        ).toVar('labWornInner');
        albedo.assign(mix(albedo, inner.element(0).xyz, worn));
        rough.assign(mix(rough, inner.element(0).w, worn));
        ao.assign(mix(ao, inner.element(1).w, worn));
        nView.assign(normalize(mix(nView, restToView(inner.element(1).xyz), worn)));
      });
    };
    // Cut and joint faces: the broken interior.
    const cutBranch = () => {
      const res = fractureFn(
        restPos, restN, clsF, face.z, fp,
        looks.classRow(cls, 0).xyz, looks.classRow(cls, 1).xyz,
        looks.classRow(cls, 2), looks.classRow(cls, 3), grain, face.w,
      ).toVar('labFracture');
      albedo.assign(res.element(0).xyz);
      rough.assign(res.element(0).w);
      ao.assign(res.element(1).w);
      metal.assign(res.element(2).x);
      // Rebar where the bar grid pierces a reinforced break: steel discs in
      // a halo of rust bled into the concrete.
      const discs = () => {
        for (let f = 0; f < 4; f += 1) {
          const prm = looks.rebarRow(f, 3);
          const active = select(float(f).lessThan(looks.rebarCount), float(1), float(0));
          const s = dot(restPos, looks.rebarRow(f, 1).xyz).sub(prm.y);
          const da = s.sub(floor(s.div(prm.x).add(0.5)).mul(prm.x));
          const dd = dot(restPos, looks.rebarRow(f, 2).xyz).sub(prm.z);
          const dist = sqrt(da.mul(da).add(dd.mul(dd)));
          const steel = float(1).sub(smoothstep(prm.w.mul(0.82), prm.w, dist)).mul(active);
          const stain = float(1).sub(smoothstep(prm.w, prm.w.mul(2.8), dist)).mul(active).mul(0.6);
          albedo.assign(mix(albedo, albedo.mul(vec3(0.62, 0.42, 0.28)), stain));
          albedo.assign(mix(albedo, vec3(0.11, 0.1, 0.095), steel));
          metal.assign(mix(metal, float(0.55), steel));
          rough.assign(mix(rough, float(0.55), steel));
        }
      };
      if (!only) If(cls.equal(1), discs);
      else if (only.cls === 1) discs();
      nView.assign(normalize(restToView(res.element(1).xyz)));
    };
    const rebarBranch = () => {
      const steel = rebarFn(restPos, face.z);
      albedo.assign(steel.xyz);
      rough.assign(steel.w);
      metal.assign(0.55);
      ao.assign(1);
      nView.assign(normalize(restToView(restN)));
    };
    if (options.fracture) {
      if (only && only.cut !== undefined) {
        if (only.cut) cutBranch();
        else skinBranch();
      } else {
        If(kind.lessThan(0.5), skinBranch);
        If(kind.greaterThan(0.5).and(kind.lessThan(2.5)), cutBranch);
        If(kind.greaterThan(2.5), rebarBranch);
      }
    }
    if (options.debugKinds) {
      const palette = select(kind.lessThan(0.5), vec3(0.75, 0.75, 0.75),
        select(kind.lessThan(1.5), vec3(0.95, 0.42, 0.08),
          select(kind.lessThan(2.5), vec3(0.1, 0.65, 0.85), vec3(0.85, 0.05, 0.05))));
      albedo.assign(palette);
      rough.assign(0.8);
      metal.assign(0);
      ao.assign(1);
      nView.assign(normalize(restToView(restN)));
    }
    return LabOut(albedo, rough, metal, ao, nView);
  }) as Node).once()();

  material.colorNode = out.get('albedo');
  material.roughnessNode = out.get('rough');
  material.metalnessNode = out.get('metal');
  material.aoNode = out.get('ao');
  material.normalNode = out.get('normal');
  return material;
}

/**
 * Layer for shadow-only proxies: the sun's shadow camera sees it, the view
 * camera does not.
 */
export const SHADOW_LAYER = 1;

/**
 * What casts the sun's shadows: every piece as its flat collider, in a bare
 * material. three builds the shadow pass from the caster's own material and,
 * given a colorNode, multiplies alpha by colorNode.a -- which drags a whole
 * procedural surface into every shadow-map fragment. A proxy on its own
 * layer casts instead (the drawn meshes do not), and detailed pieces cast
 * their cheap flat shape: a few millimetres of relief do not show in a
 * shadow.
 */
export function shadowProxyMaterial(poses: LabPoses, instanceStride = 0): THREE.Material {
  const material = new MeshBasicNodeMaterial({ color: 0x000000 });
  material.positionNode = posedPosition(poses, null, 'all', instanceStride);
  return material;
}

export function colliderMaterial(poses: LabPoses, color: THREE.ColorRepresentation): THREE.Material {
  const material = new LineBasicNodeMaterial({ color, transparent: true, opacity: 0.9, depthTest: true });
  material.positionNode = posedPosition(poses, null);
  return material;
}

/**
 * Glass: see-through, glossy panes whose broken edges show the green of the
 * glass's own thickness, nearly opaque. Opacity is per fragment, so one
 * material does both. Depth is written, as the city's glass does, so a stack
 * of panes keeps the nearest.
 */
export function glassMaterial(
  poses: LabPoses, options: { fracture: boolean; wireframe: boolean; instanceStride?: number },
): THREE.Material {
  const material = new MeshStandardNodeMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, depthWrite: true,
  });
  material.wireframe = options.wireframe;
  const pose = varyingProperty('vec4', 'vGlassQuat');
  material.positionNode = posedPosition(poses, pose, 'all', options.instanceStride ?? 0);
  const face = attribute('labFace', 'vec4');
  const kind = face.x.sub(floor(face.x.div(8)).mul(8));
  const edge = options.fracture ? kind.greaterThan(0.5).and(kind.lessThan(2.5)) : float(0).greaterThan(1);
  material.colorNode = select(edge, vec3(0.16, 0.34, 0.27), vec3(0.06, 0.09, 0.09));
  material.opacityNode = select(edge, float(0.88), float(0.32));
  material.roughnessNode = select(edge, float(0.18), float(0.04));
  return material;
}

/** Ghosted collider solids: the physics body, see-through. */
export function ghostMaterial(poses: LabPoses): THREE.Material {
  const material = new MeshStandardNodeMaterial({
    color: 0x58c6ff, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false,
  });
  material.positionNode = posedPosition(poses, varyingProperty('vec4', 'vGhostQuat'));
  return material;
}


/**
 * One specialised draw: a class, and outer skin or cut faces (`cut`), or
 * every kind of face of that class (`cut` left out; the kinds still branch).
 */
export interface LabGroup {
  cls: number;
  cut?: boolean;
}

/** The groups buildCompactGeometry split its triangles into, by material index. */
export function labGroups(geometry: THREE.BufferGeometry): LabGroup[] {
  return (geometry.userData.labGroups as LabGroup[] | undefined) ?? [];
}

/**
 * Per-piece rest data for the compact layout: one texel per piece,
 * (rest centre xyz, city layer code). A copy of a specimen shares its rest
 * frame, so instanced copies index it by their local piece.
 */
export class PieceInfo {
  readonly texture: THREE.DataTexture;
  constructor(pieces: readonly FracturePiece[], looks: readonly LabPieceLook[]) {
    let side = 4;
    while (side * side < pieces.length) side *= 2;
    const data = new Float32Array(new ArrayBuffer(side * side * 16)) as Float32Array<ArrayBuffer>;
    pieces.forEach((piece, p) => data.set([piece.centroid[0], piece.centroid[1], piece.centroid[2], looks[p].layerCode], p * 4));
    this.texture = new THREE.DataTexture(data, side, side, THREE.RGBAFormat, THREE.FloatType);
    this.texture.needsUpdate = true;
  }
  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * The shading-only tier's geometry in the compact layout: 20 bytes a vertex
 * (position, piece, packed code) instead of 60, and outer faces SHARE their
 * corners (normals come from screen derivatives, so nothing else differs
 * between them) -- a box is 8 vertices, not 24. Cut and joint faces keep
 * their own corners: they carry which side of the crack they are.
 * At scene scale this tier is geometry-bound, so vertex count and fetch
 * width are the cost.
 */
export function buildCompactGeometry(
  pieces: readonly FracturePiece[], kinds: readonly Uint8Array[], include: (piece: FracturePiece) => boolean = () => true,
): THREE.BufferGeometry {
  const position: number[] = [];
  const piece: number[] = [];
  const code: number[] = [];
  // Triangles bucketed by (class, cut): each bucket is one geometry group,
  // drawn with a shader specialised to it.
  const buckets = new Map<number, number[]>();
  pieces.forEach((pc, p) => {
    if (!include(pc)) return;
    const poly = pc.poly;
    const grain = pc.grainAxis ?? 3;
    const shared = new Map<number, number>();
    const vertex = (i: number, c: number): number => {
      const v = position.length / 3;
      const at = poly.verts[i];
      position.push(at[0], at[1], at[2]);
      piece.push(p);
      code.push(c);
      return v;
    };
    poly.faces.forEach((face, f) => {
      const kind = kinds[p][f];
      const ids: number[] = [];
      if (kind === 0) {
        // Outer faces share corners; side is irrelevant to the skin.
        const c = 0 + 8 * grain + 64 * pc.cls + 1024 * 1;
        for (const i of face.loop) {
          let v = shared.get(i);
          if (v === undefined) {
            v = vertex(i, c);
            shared.set(i, v);
          }
          ids.push(v);
        }
      } else {
        const side = canonicalSign(face.normal);
        const c = kind + 8 * grain + 64 * pc.cls + 1024 * (side + 1);
        for (const i of face.loop) ids.push(vertex(i, c));
      }
      const key = pc.cls * 2 + (kind === 0 ? 0 : 1);
      let index = buckets.get(key);
      if (!index) buckets.set(key, index = []);
      for (let k = 1; k + 1 < ids.length; k += 1) index.push(ids[0], ids[k], ids[k + 1]);
    });
  });
  const index: number[] = [];
  const groups: LabGroup[] = [];
  const geometry = new THREE.BufferGeometry();
  for (const key of [...buckets.keys()].sort((x, y) => x - y)) {
    const tris = buckets.get(key)!;
    geometry.addGroup(index.length, tris.length, groups.length);
    groups.push({ cls: key >> 1, cut: (key & 1) === 1 });
    for (const i of tris) index.push(i);
  }
  geometry.userData.labGroups = groups;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('labPiece', new THREE.Float32BufferAttribute(piece, 1));
  geometry.setAttribute('labCode', new THREE.Float32BufferAttribute(code, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}
