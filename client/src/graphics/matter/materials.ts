// Matter materials: MeshPhysicalNodeMaterials whose colour, roughness, relief
// and lighting come from the procedural fields in fields.ts.
//
// createMaterial(recipe) reproduces the material lab exactly (object-space
// coordinates, the model matrix). Game geometry passes a MatterSpace instead:
// where the field is evaluated, and how its directions reach the world -- the
// city's chunks evaluate it in their rest frame, posed by their own transform
// (scene/cityMatterNodes.ts).
//
// Only imported behind __WEBGPU__: `three/webgpu` and `three/tsl` are
// three-webgpu there.

import {
  Color,
  MeshPhysicalNodeMaterial,
  PhysicalLightingModel,
  Vector3,
  Vector4,
  type Texture,
} from 'three/webgpu';
import {
  cameraPosition,
  cameraViewMatrix,
  dFdx,
  dFdy,
  float,
  materialReference,
  max,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalGeometry,
  normalView,
  normalViewGeometry,
  positionGeometry,
  positionView,
  positionViewDirection,
  property,
  texture,
  uniform,
  varying,
  vec2,
  vec4,
} from 'three/tsl';

import { matterField, physicalBump } from './fields';
import { GROOVE_RMS, createFiberLUT, majorAxisRadiance } from './optics';
import { type MaterialRecipe, validateRecipe } from './recipes';
import { type EonViewTerms, eonDirect, eonIndirectScale, eonViewTerms } from './roughDiffuse';

export * from './recipes';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/**
 * Where a material's field lives. Positions are metres; directions are unit
 * vectors. The lab default is the mesh's object space.
 */
export interface MatterSpace {
  /** The material-space position the field is evaluated at. */
  position: Node;
  /** The material-space surface normal. */
  normal: Node;
  /** A material-space direction, in world space. */
  toWorld: (direction: Node) => Node;
  /** The direction from the surface to the camera, in material space (any length). */
  viewDirection: Node;
}

export interface MatterOptions {
  space?: MatterSpace;
  /**
   * Concrete's coarse relief as real vertex displacement (lab only, default
   * on). A custom space turns it off: game meshes are placed by positionNodes
   * of their own and have split normals at hard edges, where it opens cracks.
   */
  displacement?: boolean;
  /**
   * Glass without three's transmission pass (no backdrop copy, no
   * refraction): a transparent physical surface with the recipe's IOR and
   * roughness. What a city full of windows can afford.
   */
  glassLite?: boolean;
}

/** The lab's space: the mesh's own geometry and model matrix. */
function objectSpace(): MatterSpace {
  return {
    position: positionGeometry,
    normal: normalGeometry,
    toWorld: (direction: Node) => modelWorldMatrix.mul(vec4(direction, 0)).xyz,
    viewDirection: modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.sub(positionGeometry),
  };
}

// @types/three 0.170 describes an older lighting-model API than the r182
// runtime (start/indirect/direct take the builder; indirectDiffuse exists).
interface LightingModelBase {
  start(builder: Node): void;
  indirect(builder: Node): void;
  indirectDiffuse(builder: Node): void;
  direct(data: Node, builder: Node): void;
}
const PhysicalModel = PhysicalLightingModel as unknown as new (
  clearcoat: boolean,
  sheen: boolean,
  iridescence: boolean,
  anisotropy: boolean,
  transmission: boolean,
  dispersion: boolean,
) => LightingModelBase;

// The diffuse colour after three's energy partition between the specular and
// diffuse lobes: what the custom diffuse terms below scale.
const body: Node = property('vec3', 'DiffuseContribution');

class MatterLighting extends PhysicalModel {
  private eon: EonViewTerms | null = null;
  private muO: Node = null;
  private readonly kind: MaterialRecipe['kind'];
  private readonly field: Node;
  private readonly a: Node;
  private readonly b: Node;
  private readonly fiber: Texture | null;
  private readonly optics: Node;
  private readonly space: MatterSpace;

  constructor(
    kind: MaterialRecipe['kind'],
    field: Node,
    a: Node,
    b: Node,
    fiber: Texture | null,
    optics: Node,
    space: MatterSpace,
    transmission: boolean,
  ) {
    // clearcoat, sheen, iridescence, anisotropy, transmission, dispersion
    super(kind === 'oak', false, false, kind === 'steel', transmission, transmission);
    this.kind = kind;
    this.field = field;
    this.a = a;
    this.b = b;
    this.fiber = fiber;
    this.optics = optics;
    this.space = space;
  }

  start(builder: Node) {
    // EON's view-side terms once per pixel, before any light reads them.
    if (this.kind === 'concrete') {
      this.muO = max(normalView.dot(positionViewDirection), 1e-4).toVar('eonMuO');
      this.eon = eonViewTerms(body, this.field.element(0).w, this.muO);
    }
    super.start(builder);
  }

  indirect(builder: Node) {
    if (this.kind === 'steel') {
      const radiance = majorAxisRadiance(builder, this.field, this.space.toWorld);
      if (radiance) builder.context.radiance.assign(this.optics.mix(builder.context.radiance, radiance));
    }
    super.indirect(builder);
  }

  indirectDiffuse(builder: Node) {
    if (this.kind !== 'concrete' || !this.eon) {
      super.indirectDiffuse(builder);
      return;
    }
    // A uniform sky reflects EON's directional albedo, not Lambert's.
    const { irradiance, reflectedLight } = builder.context;
    const lambert = irradiance.mul(body).mul(1 / Math.PI);
    reflectedLight.indirectDiffuse.addAssign(
      lambert.mul(mix(float(1), eonIndirectScale(body, this.eon), this.optics)),
    );
  }

  direct(data: Node, builder: Node) {
    if (this.kind === 'concrete') {
      // Cavity horizon: a low light is shadowed inside the pores it grazes.
      const horizon = this.b.y.div(this.a.x.mul(0.1)).clamp(0, 0.7).mul(this.field.element(1).y.sqrt());
      const visibility = normalView
        .dot(data.lightDirection)
        .smoothstep(horizon.sub(0.03), horizon.add(0.08))
        .mul(0.75)
        .add(0.25);
      data = { ...data, lightColor: data.lightColor.mul(this.optics.mix(1, visibility)) };
    }
    super.direct(data, builder);
    const { lightDirection: L, lightColor: C, reflectedLight: R } = data;
    const nl = normalView.dot(L).clamp();
    if (this.kind === 'concrete' && this.eon) {
      // Replace three's Lambert lobe with EON's.
      const eon = eonDirect(body, this.field.element(0).w, L, positionViewDirection, normalView, this.muO, this.eon);
      R.directDiffuse.addAssign(C.mul(nl).mul(eon.sub(body.div(Math.PI))).mul(this.optics));
    }
    if (this.kind === 'marble') {
      // Light through the slab from behind, attenuated over its thickness.
      const thickness = float(materialReference('userData.physicalThickness', 'float'));
      const distance = this.b.x.mul(0.001).mul(this.field.element(1).y.mul(-0.75).add(1));
      const trans = thickness
        .div(distance.max(0.00001))
        .negate()
        .exp()
        .mul(0.22)
        .mul(this.b.w)
        .mul(this.optics);
      R.directDiffuse.addAssign(C.mul(normalView.dot(L).negate().clamp()).mul(this.field.element(0).xyz).mul(trans));
    }
    if (this.kind === 'oak' && this.fiber) {
      // The fiber layer under the finish: a measured response around the grain.
      const f = cameraViewMatrix.mul(vec4(this.space.toWorld(this.field.element(2).xyz), 0)).xyz.normalize();
      const weight = this.a.w.mul(-0.6).add(1).mul(0.15).mul(this.b.w).mul(this.optics);
      const direction = L.dot(f).add(positionViewDirection.dot(f)).mul(0.5).add(0.5).clamp();
      const response = texture(this.fiber, vec2(direction, this.b.y.mul(0.5).add(0.1))).r.mul(1 / (2 * Math.PI));
      R.directDiffuse.addAssign(C.mul(nl).mul(body).mul(response.sub(1 / Math.PI)).mul(weight));
    }
  }
}

export type MaterialHandle = {
  recipe: MaterialRecipe;
  material: MeshPhysicalNodeMaterial;
  uniforms: {
    a: Node;
    b: Node;
    seed: Node;
    scale: Node;
    offset: Node;
    knot: Node;
    tint: Node;
    optics: Node;
  };
  dispose: () => void;
};

const DEFAULT_KNOT: [number, number, number] = [0.09, 0, 0.055];

export function createMaterial(input: MaterialRecipe, options: MatterOptions = {}): MaterialHandle {
  const recipe = validateRecipe(input);
  const space = options.space ?? objectSpace();
  const optics = uniform(1);
  const a = uniform(new Vector4(...recipe.structure));
  const b = uniform(new Vector4(...recipe.finish));
  const seed = uniform(recipe.seed);
  const scale = uniform(recipe.scale);
  const offset = uniform(new Vector3());
  const knot = uniform(new Vector3(...(recipe.knot ?? DEFAULT_KNOT)));
  const tint = uniform(new Color(...(recipe.tint ?? [1, 1, 1])));
  const fieldFn = matterField(recipe.kind);

  const p = space.position.mul(scale).add(offset);
  const footprint = max(dFdx(p).length(), dFdy(p).length());
  let field = fieldFn(p, space.normal, a, b, seed, footprint, knot).toVar();

  let coarseRelief: Node = null;
  if (recipe.kind === 'concrete') {
    // The coarse cavity relief, as geometry (displacement) and as parallax:
    // two steps of re-evaluating the field where the eye ray meets it.
    coarseRelief = fieldFn(p, space.normal, a, b, seed, float(0.0025), knot).element(1).x;
    const view = space.viewDirection.normalize();
    const cosine = view.dot(space.normal).abs().max(0.22);
    const tangent = view.sub(space.normal.mul(view.dot(space.normal)));
    for (let step = 0; step < 2; step++) {
      const residual = field.element(1).x.sub(varying(coarseRelief));
      const parallaxPosition = p.add(tangent.mul(residual.div(cosine)));
      field = fieldFn(parallaxPosition, space.normal, a, b, seed, footprint, knot).toVar();
    }
  }

  const fiber = recipe.kind === 'oak' ? createFiberLUT() : null;
  const material = new MeshPhysicalNodeMaterial();
  material.name = `Matter / ${recipe.kind}`;
  if (coarseRelief && !options.space && options.displacement !== false)
    material.positionNode = positionGeometry.add(normalGeometry.mul(coarseRelief));
  material.colorNode = field.element(0).xyz.mul(tint);
  material.roughnessNode = field.element(0).w;
  material.normalNode = physicalBump(positionView, normalViewGeometry, field.element(1).x);
  material.metalness = recipe.kind === 'steel' ? 1 : 0;
  material.ior = 1.5;
  if (recipe.kind === 'oak') {
    material.clearcoatNode = field.element(1).z;
    material.clearcoatRoughnessNode = b.y.mul(-0.15).add(0.24);
  }
  if (recipe.kind === 'steel') {
    // Resolved grooves are in the bump; unresolved ones widen the lobe by
    // their measured RMS slope (groove-fit.json).
    material.anisotropyNode = vec2(field.element(1).w, 0);
    const resolved = field.element(1).y;
    const slope = a.y.div(0.000008).mul(float(0.00012).div(a.x)).mul(GROOVE_RMS[0]);
    material.roughnessNode = field
      .element(0)
      .w.pow(4)
      .add(slope.pow(2).mul(resolved.oneMinus()))
      .pow(0.25)
      .clamp(0.06, 0.8);
  }
  const transmission = recipe.kind === 'glass' && !options.glassLite;
  if (recipe.kind === 'glass' && options.glassLite) {
    material.iorNode = b.x;
    material.transparent = true;
  }
  if (transmission) {
    material.transmission = 1;
    material.iorNode = b.x;
    material.thicknessNode = a.x;
    material.dispersionNode = b.y;
    material.attenuationColor = new Color(0.73, 0.96, 0.83);
    material.attenuationDistance = 0.35;
  }
  material.userData.recipe = recipe;
  material.userData.physicalThickness = 0.18;
  material.setupLightingModel = (() => new MatterLighting(recipe.kind, field, a, b, fiber, optics, space, transmission)) as never;

  return {
    recipe,
    material,
    uniforms: { a, b, seed, scale, offset, knot, tint, optics },
    dispose: () => {
      material.dispose();
      fiber?.dispose();
    },
  };
}

/** Retune a material in place: uniforms only, no shader rebuild. */
export function updateMaterial(handle: MaterialHandle, changes: Partial<MaterialRecipe>) {
  const next = validateRecipe({ ...handle.recipe, ...changes });
  if (next.kind !== handle.recipe.kind) throw new Error('Create a new handle to change material identity.');
  handle.recipe = next;
  handle.material.userData.recipe = next;
  handle.uniforms.a.value.fromArray(next.structure);
  handle.uniforms.b.value.fromArray(next.finish);
  handle.uniforms.seed.value = next.seed;
  handle.uniforms.scale.value = next.scale;
  handle.uniforms.knot.value.fromArray(next.knot ?? DEFAULT_KNOT);
  handle.uniforms.tint.value.setRGB(...(next.tint ?? [1, 1, 1]));
  if (next.kind === 'glass') {
    handle.material.attenuationColor.setRGB(1 - next.structure[1] * 0.5, 0.99, 1 - next.structure[1] * 0.3);
    handle.material.attenuationDistance = 0.22 / next.finish[2];
  }
}

export function disposeMaterial(handle: MaterialHandle) {
  handle.dispose();
}
