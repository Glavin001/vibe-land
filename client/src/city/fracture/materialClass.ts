// What a piece is made of, as far as BREAKING it is concerned.
//
// The packs name materials for the solver (reinforced-concrete, stud-timber,
// brick-veneer, veneer-mortar-joint, ...). The fracture look needs fewer,
// coarser classes: what the inside of the material looks like and how it
// breaks. Unknown names fall back to plain concrete, which is what the city is
// made of.

export const enum FractureClass {
  Concrete = 0,
  Reinforced = 1,
  Brick = 2,
  Stone = 3,
  Wood = 4,
  Gypsum = 5,
  Plaster = 6,
  Glass = 7,
  Steel = 8,
  Ceramic = 9,
  Mortar = 10,
  Slate = 11,
}

export const FRACTURE_CLASS_COUNT = 12;

export const FRACTURE_CLASS_NAMES: readonly string[] = [
  'concrete', 'reinforced', 'brick', 'stone', 'wood', 'gypsum',
  'plaster', 'glass', 'steel', 'ceramic', 'mortar', 'slate',
];

/** Ordered: the first pattern a name contains wins. */
const RULES: ReadonlyArray<[RegExp, FractureClass]> = [
  [/mortar/, FractureClass.Mortar],
  [/glass|glazing|pane/, FractureClass.Glass],
  [/reinforced|prestressed|slab|footing|foundation/, FractureClass.Reinforced],
  [/brick/, FractureClass.Brick],
  [/stone|limestone|marble|granite/, FractureClass.Stone],
  [/drywall|gypsum|plasterboard/, FractureClass.Gypsum],
  [/plaster|stucco|render/, FractureClass.Plaster],
  [/timber|wood|stud|joist|rafter|oak|board|siding|weatherboard|plank|particleboard|ply|frame|trim|joinery/, FractureClass.Wood],
  [/steel|metal|iron|alloy|rebar|fastener|nail|bolt/, FractureClass.Steel],
  [/tile|ceramic|terracotta/, FractureClass.Ceramic],
  [/slate/, FractureClass.Slate],
  [/concrete|cement/, FractureClass.Concrete],
];

export function fractureClassOf(name: string | undefined, fallback = FractureClass.Concrete): FractureClass {
  if (!name) return fallback;
  const lower = name.toLowerCase();
  for (const [pattern, cls] of RULES) {
    if (pattern.test(lower)) return cls;
  }
  return fallback;
}

/**
 * Materials that exist to JOIN two parts. A contact through one of these is a
 * joint letting go (mortar bed, nail line, glazing bead), not a break through
 * solid material, and looks clean rather than torn.
 */
export function isJointMaterial(name: string | undefined): boolean {
  if (!name) return false;
  return /mortar|joint|clip|fastener|nail|bolt|screw|anchor|tie|bead/.test(name.toLowerCase());
}

/** Classes that break THROUGH each other: a contact between them is a fracture. */
export function sameFamily(a: FractureClass, b: FractureClass): boolean {
  const family = (c: FractureClass): number =>
    c === FractureClass.Reinforced ? FractureClass.Concrete
      : c === FractureClass.Plaster ? FractureClass.Gypsum
        : c;
  return family(a) === family(b);
}

/** The city texture layer an exterior of this class wears (cityTextures.ts keys). */
export function exteriorTextureKey(cls: FractureClass): string {
  switch (cls) {
    case FractureClass.Brick: return 'brick';
    case FractureClass.Stone: return 'stone';
    case FractureClass.Wood: return 'aged-timber';
    case FractureClass.Gypsum:
    case FractureClass.Plaster:
    case FractureClass.Glass: return 'white-concrete';
    case FractureClass.Steel: return 'metal';
    case FractureClass.Ceramic:
    case FractureClass.Slate: return 'roof-slate';
    default: return 'concrete-wall';
  }
}
