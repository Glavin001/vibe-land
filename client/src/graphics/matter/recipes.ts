// Material recipes: the parameters of each Matter material, their documented
// ranges and defaults, and validation. Plain data, no three.
export type MaterialKind = 'oak' | 'concrete' | 'steel' | 'marble' | 'glass';
export type MaterialRecipe = {
  version: 1;
  kind: MaterialKind;
  seed: number;
  scale: number;
  knot?: [number, number, number];
  /** Linear-RGB multiplier on the field's colour (wood species, stains); default white. */
  tint?: [number, number, number];
  structure: [number, number, number, number];
  finish: [number, number, number, number];
};
export type Parameter = {
  label: string;
  group: 'structure' | 'finish';
  index: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  factor?: number;
  description: string;
};
export const KINDS: MaterialKind[] = [
  'oak',
  'concrete',
  'steel',
  'marble',
  'glass',
];
export const MATERIALS: Record<
  MaterialKind,
  {
    name: string;
    tag: string;
    color: string;
    description: string;
    proof: string;
    parameters: Parameter[];
    sources: [string, string][];
  }
> = {
  oak: {
    name: 'Oak',
    tag: 'Quercus · finished',
    color: '#ba8e53',
    description:
      'Annual growth, longitudinal vessels, and radial rays are cut from one continuous volume. A separate fiber response sits beneath the surface finish.',
    proof:
      'Cut through the grain. Move the light to separate the finish reflection from the colored fiber response.',
    parameters: [
      {
        label: 'Annual ring spacing',
        group: 'structure',
        index: 0,
        min: 0.001,
        max: 0.014,
        step: 0.0001,
        unit: 'mm',
        factor: 1000,
        description: 'Growth layers retain their spacing across every cut.',
      },
      {
        label: 'Knot influence',
        group: 'structure',
        index: 1,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Distorts the growth field around a branch axis.',
      },
      {
        label: 'Vessel radius',
        group: 'structure',
        index: 2,
        min: 0.00005,
        max: 0.0004,
        step: 0.00001,
        unit: 'µm',
        factor: 1e6,
        description:
          'Longitudinal pore cross-section, concentrated in earlywood.',
      },
      {
        label: 'Coating',
        group: 'structure',
        index: 3,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description:
          'Changes the surface reflection and attenuates the fiber layer.',
      },
      {
        label: 'Cut orientation',
        group: 'finish',
        index: 0,
        min: 0,
        max: 180,
        step: 1,
        unit: '°',
        description: 'Rotates the virtual timber inside the object.',
      },
      {
        label: 'Sanding',
        group: 'finish',
        index: 1,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Smooths raised fibers and reduces pore relief.',
      },
      {
        label: 'Radial rays',
        group: 'finish',
        index: 2,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Ribbon-shaped rays appear as flecks on radial cuts.',
      },
    ],
    sources: [
      [
        'Solid wood with knots · 2022',
        'https://www.ma-la.com/procedural_knots/Procedural_Knots_2022.pdf',
      ],
      [
        'Measured fiber reflection · 2005',
        'https://www.cs.cornell.edu/~srm/publications/SG05-wood-lr.pdf',
      ],
    ],
  },
  concrete: {
    name: 'Concrete',
    tag: 'Cast · mineral composite',
    color: '#999b8c',
    description:
      'Graded aggregate lies below a paste-rich skin. Grinding exposes the mineral phase; pore relief and an energy-preserving rough diffuse response describe the surface.',
    proof:
      'Sweep a low light across the surface. Increase grinding depth to expose the aggregate.',
    parameters: [
      {
        label: 'Aggregate size',
        group: 'structure',
        index: 0,
        min: 0.004,
        max: 0.032,
        step: 0.001,
        unit: 'mm',
        factor: 1000,
        description:
          'Characteristic size of the embedded aggregate population.',
      },
      {
        label: 'Paste skin',
        group: 'structure',
        index: 1,
        min: 0,
        max: 0.006,
        step: 0.0001,
        unit: 'mm',
        factor: 1000,
        description: 'Covers coarse aggregate at the formed surface.',
      },
      {
        label: 'Cavity population',
        group: 'structure',
        index: 2,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description:
          'Controls large trapped-air voids separately from fine pores.',
      },
      {
        label: 'Grinding depth',
        group: 'structure',
        index: 3,
        min: 0,
        max: 0.008,
        step: 0.0001,
        unit: 'mm',
        factor: 1000,
        description: 'Removes the paste layer and exposes mineral inclusions.',
      },
      {
        label: 'Polishing',
        group: 'finish',
        index: 0,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Reduces relief and the width of the surface reflection.',
      },
      {
        label: 'Cavity depth',
        group: 'finish',
        index: 1,
        min: 0.0001,
        max: 0.0025,
        step: 0.0001,
        unit: 'mm',
        factor: 1000,
        description: 'Physical amplitude of the larger air cavities.',
      },
      {
        label: 'Paste variation',
        group: 'finish',
        index: 2,
        min: 0,
        max: 0.5,
        step: 0.01,
        unit: '',
        description: 'Low-frequency variation of the cement matrix.',
      },
    ],
    sources: [
      [
        'EON rough diffuse · 2025 / 2026',
        'https://jcgt.org/published/0014/01/06/',
      ],
      [
        'Concrete composition · NIST',
        'https://www.nist.gov/publications/characterization-and-modeling-pores-and-surfaces-cement-paste-correlations-processing',
      ],
    ],
  },
  steel: {
    name: 'Brushed steel',
    tag: 'Austenitic · abrasive finish',
    color: '#a7bab1',
    description:
      'Correlated abrasive grooves shape an anisotropic reflection lobe. Finite scratches and overlapping passes interrupt the highlight without adding painted streaks.',
    proof:
      'Move a narrow light over a cylinder. The reflection spreads across the brushing direction.',
    parameters: [
      {
        label: 'Groove width',
        group: 'structure',
        index: 0,
        min: 0.00003,
        max: 0.0005,
        step: 0.00001,
        unit: 'µm',
        factor: 1e6,
        description: 'Mean spacing of the procedural abrasive trajectories.',
      },
      {
        label: 'Groove depth',
        group: 'structure',
        index: 1,
        min: 0.000001,
        max: 0.00003,
        step: 0.000001,
        unit: 'µm',
        factor: 1e6,
        description: 'Relief amplitude before footprint filtering.',
      },
      {
        label: 'Direction spread',
        group: 'structure',
        index: 2,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Variation around the local manufacturing direction.',
      },
      {
        label: 'Cross brushing',
        group: 'structure',
        index: 3,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Adds a second abrasive pass.',
      },
      {
        label: 'Pass overlap',
        group: 'finish',
        index: 0,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Longitudinal correlation and interruption of grooves.',
      },
      {
        label: 'Handling scratches',
        group: 'finish',
        index: 1,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Sparse finite scratches independent of the fine finish.',
      },
      {
        label: 'Base roughness',
        group: 'finish',
        index: 2,
        min: 0.08,
        max: 0.6,
        step: 0.01,
        unit: '',
        description:
          'Unresolved microfacet contribution, separate from resolved grooves.',
      },
    ],
    sources: [
      [
        'Metal microgeometry · Cornell',
        'https://www.cs.cornell.edu/Projects/metalappearance/',
      ],
      [
        'Anisotropic environment lighting · 2024',
        'https://diglib.eg.org/items/1941bb58-90d5-40cb-92bc-2e987b4897da',
      ],
    ],
  },
  marble: {
    name: 'Marble',
    tag: 'Calcitic · polished',
    color: '#d3cebb',
    description:
      'Folded mineral bands and finer veins run through a three-dimensional crystalline field. Mineral-dependent absorption and diffusion soften the body beneath the polished reflection.',
    proof:
      'Inspect the slab edge under backlighting. Follow veins through the cut surface.',
    parameters: [
      {
        label: 'Vein scale',
        group: 'structure',
        index: 0,
        min: 0.035,
        max: 0.3,
        step: 0.005,
        unit: 'mm',
        factor: 1000,
        description: 'Physical spacing of broad mineral bands.',
      },
      {
        label: 'Vein width',
        group: 'structure',
        index: 1,
        min: 0.02,
        max: 0.35,
        step: 0.005,
        unit: '',
        description: 'Controls the mineral fraction within each vein.',
      },
      {
        label: 'Folding',
        group: 'structure',
        index: 2,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Coherent deformation of the compositional layers.',
      },
      {
        label: 'Grain size',
        group: 'structure',
        index: 3,
        min: 0.0002,
        max: 0.006,
        step: 0.0001,
        unit: 'mm',
        factor: 1000,
        description: 'Size of the interlocking mineral grain population.',
      },
      {
        label: 'Scattering distance',
        group: 'finish',
        index: 0,
        min: 0.1,
        max: 2,
        step: 0.05,
        unit: 'mm',
        description:
          'Effective transport distance for the diffusion approximation.',
      },
      {
        label: 'Mineral absorption',
        group: 'finish',
        index: 1,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Dark veins absorb more light than the pale matrix.',
      },
      {
        label: 'Polishing',
        group: 'finish',
        index: 2,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Smooths the surface across visible mineral boundaries.',
      },
    ],
    sources: [
      [
        'Heterogeneous subsurface transport',
        'https://www.cs.cornell.edu/~kb/projects/heterogeneousSS/',
      ],
      [
        'Separable subsurface scattering',
        'https://www.iryoku.com/separable-sss/',
      ],
    ],
  },
  glass: {
    name: 'Clear glass',
    tag: 'Soda-lime · optical solid',
    color: '#9fcabd',
    description:
      'Closed geometric boundaries determine refraction and optical path length. Absorption increases along the actual internal ray path; surface imperfections remain subtle.',
    proof:
      'Inspect straight lines through the glass. Change wall thickness and compare the tint at the edges.',
    parameters: [
      {
        label: 'Wall thickness',
        group: 'structure',
        index: 0,
        min: 0.001,
        max: 0.015,
        step: 0.0005,
        unit: 'mm',
        factor: 1000,
        description:
          'Physical wall thickness of the hollow vessel and pane specimens.',
      },
      {
        label: 'Iron absorption',
        group: 'structure',
        index: 1,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description:
          'Interpolates from a low-iron appearance to conventional green edge absorption.',
      },
      {
        label: 'Surface roughness',
        group: 'structure',
        index: 2,
        min: 0.005,
        max: 0.25,
        step: 0.005,
        unit: '',
        description: 'Controls the reflected and transmitted lobe width.',
      },
      {
        label: 'Manufacturing waviness',
        group: 'structure',
        index: 3,
        min: 0,
        max: 1,
        step: 0.01,
        unit: '',
        description: 'Small shape deviations alter reflected straight lines.',
      },
      {
        label: 'Index of refraction',
        group: 'finish',
        index: 0,
        min: 1.3,
        max: 1.8,
        step: 0.005,
        unit: '',
        description:
          'Soda-lime default 1.52. Changes outside that default describe a generic dielectric.',
      },
      {
        label: 'Dispersion',
        group: 'finish',
        index: 1,
        min: 0,
        max: 0.12,
        step: 0.005,
        unit: '',
        description:
          'A restrained three-band approximation to wavelength-dependent refraction.',
      },
      {
        label: 'Optical density',
        group: 'finish',
        index: 2,
        min: 0.1,
        max: 3,
        step: 0.1,
        unit: '',
        description:
          'Scales absorption while preserving path-length dependence.',
      },
    ],
    sources: [
      [
        'Glass manufacturing · Pilkington',
        'https://www.pilkington.com/-/media/pilkington/site-content/usa/window-manufacturers/technical-bulletins/ats186installingheattreatedglass20130116.pdf',
      ],
      [
        'Fresnel reflection and transmission',
        'https://www.pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission',
      ],
    ],
  },
};
export const DEFAULTS: Record<MaterialKind, MaterialRecipe> = {
  oak: {
    version: 1,
    kind: 'oak',
    seed: 17,
    scale: 1,
    knot: [0.09, 0, 0.055],
    structure: [0.0048, 0.36, 0.00015, 0.42],
    finish: [12, 0.65, 0.5, 1],
  },
  concrete: {
    version: 1,
    kind: 'concrete',
    seed: 23,
    scale: 1,
    structure: [0.015, 0.002, 0.32, 0.0005],
    finish: [0.15, 0.0008, 0.13, 1],
  },
  steel: {
    version: 1,
    kind: 'steel',
    seed: 31,
    scale: 1,
    structure: [0.00012, 0.000008, 0.14, 0.08],
    finish: [0.68, 0.12, 0.27, 1],
  },
  marble: {
    version: 1,
    kind: 'marble',
    seed: 47,
    scale: 1,
    structure: [0.135, 0.09, 0.6, 0.0016],
    finish: [0.65, 0.45, 0.88, 1],
  },
  glass: {
    version: 1,
    kind: 'glass',
    seed: 59,
    scale: 1,
    structure: [0.006, 0.4, 0.018, 0.07],
    finish: [1.52, 0.025, 1, 1],
  },
};
/**
 * A deep copy of a recipe (plain JSON). Not structuredClone: the native app's
 * runtime (mystralnative) does not have it.
 */
export function cloneRecipe<T extends object>(recipe: T): T {
  return JSON.parse(JSON.stringify(recipe)) as T;
}

export function freshRecipe(kind: MaterialKind): MaterialRecipe {
  return cloneRecipe(DEFAULTS[kind]);
}
export function validateRecipe(input: unknown): MaterialRecipe {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid material recipe.');
  const r = input as MaterialRecipe;
  if (r.version !== 1 || !KINDS.includes(r.kind))
    throw new Error('Unsupported recipe version or material.');
  if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed > 1e6)
    throw new Error('Seed must be an integer from 0 to 1,000,000.');
  if (!Number.isFinite(r.scale) || r.scale < 0.1 || r.scale > 10)
    throw new Error('Scale must be between 0.1 and 10.');
  for (const group of ['structure', 'finish'] as const)
    if (
      !Array.isArray(r[group]) ||
      r[group].length !== 4 ||
      r[group].some((v) => !Number.isFinite(v))
    )
      throw new Error('Recipe values must be finite four-component arrays.');
  for (const p of MATERIALS[r.kind].parameters)
    if (r[p.group][p.index] < p.min || r[p.group][p.index] > p.max)
      throw new Error(`${p.label} is outside its supported range.`);
  if (
    r.knot &&
    (!Array.isArray(r.knot) ||
      r.knot.length !== 3 ||
      r.knot.some((v) => !Number.isFinite(v) || Math.abs(v) > 0.3))
  )
    throw new Error('Knot coordinates must be within 300 mm of the origin.');
  if (
    r.tint &&
    (!Array.isArray(r.tint) || r.tint.length !== 3 || r.tint.some((v) => !Number.isFinite(v) || v < 0 || v > 4))
  )
    throw new Error('Tint must be three channel multipliers from 0 to 4.');
  if (r.finish[3] < 0 || r.finish[3] > 1)
    throw new Error('Detail contribution must be between 0 and 1.');
  return cloneRecipe(r);
}
