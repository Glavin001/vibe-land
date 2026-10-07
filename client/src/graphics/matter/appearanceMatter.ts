// Which Matter material a city material wears, and with what recipe.
//
// One table for the whole game, keyed by the material NAME the packs already
// author (structures/town-kit/src/materials.mjs, the base LOOK table): steel
// is steel wherever it appears, timber framing is pine, a kitchen counter is
// marble. Keyed by name rather than authored per pack because the town kit
// derives new materials by copying old ones (paving from footing, book covers
// from oak) and a recipe stored on the source would leak into every copy.
//
// A pack can still override any material explicitly with an appearance
// `matter` field ({ preset } or { kind, ...recipe fields }), e.g. a recipe
// tuned in /materials and copied out as JSON.
//
// Visual only: nothing here reaches the solver. Plain data, no three, so the
// WebGL build and the unit tests can import it.

import type { MaterialAppearance } from '../../city/manifest';
import { DEFAULTS, type MaterialKind, type MaterialRecipe, cloneRecipe, validateRecipe } from './recipes';

/**
 * How a material's grain is laid onto a chunk: along its longest rest axis
 * ('long', the default), or a fixed rest axis.
 */
export type MatterAxis = 'long' | 'x' | 'y' | 'z';

/** An authored `matter` field: a named preset, or a kind with overrides. */
export interface MatterSpec extends Partial<Omit<MaterialRecipe, 'version' | 'kind'>> {
  preset?: MatterPreset;
  kind?: MaterialKind;
  axis?: MatterAxis;
}

export interface ResolvedMatter {
  /** The preset or kind it came from, for logs and debugging. */
  name: string;
  recipe: MaterialRecipe;
  axis: MatterAxis;
}

const recipe = (kind: MaterialKind, changes: Partial<MaterialRecipe> = {}): MaterialRecipe =>
  validateRecipe({ ...cloneRecipe(DEFAULTS[kind]), ...changes });

/**
 * The named looks. Each is a Matter recipe at real-world scale (metres):
 * DEFAULTS are the lab's specimens, the rest are tuned for the parts that
 * wear them.
 */
export const MATTER_PRESETS = {
  /** Finished furniture oak: the lab's oak. */
  oak: recipe('oak'),
  /** Construction softwood: pale, wide-ringed, unfinished, sanded smooth. */
  pine: recipe('oak', {
    seed: 71,
    tint: [1.45, 1.32, 1.08],
    structure: [0.0075, 0.18, 0.00008, 0.08],
    finish: [6, 0.35, 0.12, 1],
  }),
  /**
   * Polished Carrara-like stone for kitchen counters: the lab's marble with
   * its veins drawn out to slab scale (scale 0.4: ~0.35 m between the broad
   * bands, a few sweeping veins across a 1.2 m worktop instead of a crackle).
   */
  'marble-countertop': recipe('marble', {
    seed: 53,
    scale: 0.4,
    structure: [0.135, 0.07, 0.75, 0.0016],
    finish: [0.7, 0.4, 0.94, 1],
  }),
  /** Appliances, fittings, handles: the lab's brushed stainless. */
  'brushed-steel': recipe('steel'),
  /** Structural sections: a coarser, rougher mill finish with handling marks. */
  'structural-steel': recipe('steel', {
    seed: 37,
    structure: [0.0003, 0.000012, 0.35, 0.25],
    finish: [0.45, 0.45, 0.42, 1],
  }),
  /** Grey cast concrete with exposed aggregate and air voids: footings, slabs. */
  'cast-concrete': recipe('concrete'),
  /**
   * Architectural white concrete: a thick paste skin over the aggregate,
   * few cavities, the paste lifted to off-white.
   */
  'white-concrete': recipe('concrete', {
    seed: 29,
    tint: [2.55, 2.5, 2.42],
    structure: [0.012, 0.005, 0.12, 0.0002],
    finish: [0.35, 0.0005, 0.06, 1],
  }),
  /** Window glass: the lab's soda-lime, drawn as a light physical surface. */
  'window-glass': recipe('glass'),
} satisfies Record<string, MaterialRecipe>;

export type MatterPreset = keyof typeof MATTER_PRESETS;

/** Material name -> preset. Exact names first, then the patterns below. */
const BY_NAME: Record<string, MatterPreset> = {
  // Town kit (structures/town-kit/src/materials.mjs, veneer-houses.mjs).
  'warm-oak': 'oak',
  'structure-timber': 'pine',
  'stud-timber': 'pine',
  'gable-frame': 'pine',
  'marble-countertop': 'marble-countertop',
  'insulated-appliance-panel': 'brushed-steel',
  metal: 'brushed-steel',
  'wall-tie': 'brushed-steel',
  footing: 'cast-concrete',
  'window-glass': 'window-glass',
  // The base table (blast-stress-solver structures/lib/materials.mjs LOOK).
  steel: 'structural-steel',
  'wood-frame': 'pine',
  'reinforced-concrete': 'white-concrete',
  'prestressed-concrete': 'white-concrete',
  'concrete-slab': 'cast-concrete',
  'footing-anchor': 'cast-concrete',
  glass: 'window-glass',
};

/** Names the patterns would catch that are not the solid they mention. */
const NOT_SOLID = /joint|clip|fastener|connection|seam|particleboard|paving|asphalt|paint|plaster|render|clad/;

const BY_PATTERN: Array<[RegExp, MatterPreset]> = [
  [/marble/, 'marble-countertop'],
  [/stainless|steel/, 'brushed-steel'],
  [/oak/, 'oak'],
  [/timber|lumber|stud/, 'pine'],
];

/**
 * The Matter look for one manifest material, or null to keep the city's
 * triplanar texture. An explicit `matter` field wins; otherwise the name.
 */
export function matterForAppearance(appearance: MaterialAppearance | undefined): ResolvedMatter | null {
  if (!appearance) return null;
  if (appearance.matter) return fromSpec(appearance.matter);
  const name = appearance.name ?? '';
  const preset = BY_NAME[name] ?? (NOT_SOLID.test(name) ? undefined : BY_PATTERN.find(([re]) => re.test(name))?.[1]);
  // Glass is glass only where the pack made it transparent.
  if (!preset || (preset === 'window-glass' && appearance.opacity == null)) return null;
  return { name: preset, recipe: cloneRecipe(MATTER_PRESETS[preset]), axis: 'long' };
}

function fromSpec(spec: MatterSpec): ResolvedMatter | null {
  const { preset, kind, axis, ...changes } = spec;
  const base = preset ? MATTER_PRESETS[preset] : kind ? DEFAULTS[kind] : null;
  if (!base) {
    console.warn('[matter] a matter field names neither a known preset nor a kind', spec);
    return null;
  }
  try {
    return {
      name: preset ?? kind ?? base.kind,
      recipe: validateRecipe({ ...cloneRecipe(base), ...changes }),
      axis: axis ?? 'long',
    };
  } catch (error) {
    console.warn('[matter] invalid matter recipe; keeping the triplanar texture', spec, error);
    return null;
  }
}
