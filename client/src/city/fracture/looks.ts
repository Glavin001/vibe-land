// How each material breaks: the tunable look table.
//
// Two halves. GEOMETRY parameters drive the CPU-built crack surfaces (relief,
// tessellation, rebar); changing one rebuilds the meshes. SHADING parameters
// drive the TSL fracture material (fractureNodes.ts) and are uniforms; changing
// one is free. Everything here is metres and linear RGB.
//
// Live-tunable from the console through window.__VIBE_FRACTURE__ (the lab's
// panel writes the same object), like window.__VIBE_CITY_TEX__.

import { FRACTURE_CLASS_COUNT, FractureClass } from './materialClass';
import { DEFAULT_REBAR_LOOK, type RebarLook } from './rebar';

export interface ReliefLook {
  /** Peak relief of the crack surface. */
  amplitude: number;
  /** Wavelength of the main relief. */
  featureSize: number;
  /** 0..1: share of sharp, ridged crests (conchoidal concrete breaks). */
  ridge: number;
  /** 0..1: strength of the finer octave. */
  detail: number;
  /** Largest tilt of a whole crack face away from the authored plane (slope). */
  tilt: number;
  /** Each side recedes this far from the shared surface (half the crack gap). */
  crackOpening: number;
  /** Sample spacing on the crack surface. */
  lattice: number;
  /** Relief fades to zero over this distance from pinned edges. */
  taper: number;
  /** Relief may not exceed this fraction of either piece's depth behind the face. */
  maxDepthFraction: number;
  /** Wood: splinter strength (0 none) and how far along the grain they run. */
  splinter: number;
  grainStretch: number;
  /** Brick: course height (incl. joint) and how far alternate courses step. */
  courseHeight: number;
  toothDepth: number;
  /** Most vertices one crack face may use; the lattice coarsens to fit. */
  maxFaceVerts: number;
  /** Spalling where a crack meets the outer face: how far back, how deep. */
  chipWidth: number;
  chipDepth: number;
}

export interface ShadeLook {
  /** Fresh-break base colour (cement paste, brick body, sapwood, gypsum...). */
  base: [number, number, number];
  /** Second colour: aggregate stones, mortar, latewood, paper face. */
  accent: [number, number, number];
  /** 0..1 how much of the surface the accent covers. */
  accentFill: number;
  /** Size of accent cells (aggregate, brick, grain spacing). */
  accentSize: number;
  /** Fine bump: wavelength and depth. */
  bumpSize: number;
  bumpDepth: number;
  /** Pits / voids: fill fraction. */
  pores: number;
  roughness: number;
  metalness: number;
  /** Darkening in relief valleys. */
  cavity: number;
}

export interface FractureLook {
  relief: ReliefLook;
  shade: ShadeLook;
  rebar: RebarLook;
}

const relief = (over: Partial<ReliefLook>): ReliefLook => ({
  amplitude: 0.022,
  featureSize: 0.16,
  ridge: 0.45,
  detail: 0.5,
  tilt: 0.12,
  crackOpening: 0.0015,
  lattice: 0.022,
  taper: 0.03,
  maxDepthFraction: 0.35,
  splinter: 0,
  grainStretch: 1,
  courseHeight: 0,
  toothDepth: 0,
  maxFaceVerts: 900,
  chipWidth: 0.028,
  chipDepth: 0.014,
  ...over,
});

const shade = (over: Partial<ShadeLook>): ShadeLook => ({
  base: [0.40, 0.365, 0.315],
  accent: [0.33, 0.30, 0.265],
  accentFill: 0.6,
  accentSize: 0.024,
  bumpSize: 0.006,
  bumpDepth: 0.8,
  pores: 0.008,
  roughness: 0.95,
  metalness: 0,
  cavity: 0.6,
  ...over,
});

function defaults(cls: FractureClass): FractureLook {
  switch (cls) {
    case FractureClass.Concrete:
    case FractureClass.Reinforced:
      return { relief: relief({}), shade: shade({}), rebar: { ...DEFAULT_REBAR_LOOK } };
    case FractureClass.Brick:
    case FractureClass.Mortar:
      return {
        relief: relief({
          amplitude: 0.012, featureSize: 0.1, ridge: 0.2, tilt: 0.05, lattice: 0.016,
          courseHeight: 0.075, toothDepth: 0.045, chipWidth: 0.012, chipDepth: 0.006,
        }),
        shade: shade({
          base: [0.30, 0.10, 0.06], accent: [0.42, 0.40, 0.36], accentFill: 0.2,
          accentSize: 0.075, bumpSize: 0.004, pores: 0.05, cavity: 0.45,
        }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
    case FractureClass.Stone:
      return {
        relief: relief({ amplitude: 0.03, featureSize: 0.22, ridge: 0.7, detail: 0.35 }),
        shade: shade({ base: [0.46, 0.43, 0.39], accent: [0.36, 0.34, 0.31], accentSize: 0.04, pores: 0.02 }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
    case FractureClass.Wood:
      return {
        relief: relief({
          amplitude: 0.06, featureSize: 0.007, ridge: 0.8, detail: 0.3, tilt: 0.35, lattice: 0.0028,
          taper: 0.002, maxDepthFraction: 0.8, splinter: 1, grainStretch: 12, maxFaceVerts: 1600,
          chipWidth: 0.004, chipDepth: 0.002,
        }),
        shade: shade({
          base: [0.62, 0.44, 0.26], accent: [0.43, 0.27, 0.13], accentFill: 0.35, accentSize: 0.004,
          bumpSize: 0.0015, bumpDepth: 0.8, pores: 0.0, roughness: 0.85, cavity: 0.7,
        }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
    case FractureClass.Gypsum:
    case FractureClass.Plaster:
      return {
        relief: relief({
          amplitude: 0.004, featureSize: 0.03, ridge: 0.3, tilt: 0.25, lattice: 0.006, taper: 0.003,
          chipWidth: 0.006, chipDepth: 0.002,
        }),
        shade: shade({
          base: [0.80, 0.78, 0.74], accent: [0.62, 0.55, 0.43], accentFill: 0.0, accentSize: 0.003,
          bumpSize: 0.002, bumpDepth: 0.4, pores: 0.12, roughness: 0.98, cavity: 0.3,
        }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
    case FractureClass.Glass:
      return {
        relief: relief({
          amplitude: 0.0008, featureSize: 0.02, ridge: 0, detail: 0, tilt: 0.02, lattice: 0.01, crackOpening: 0.0003,
          chipWidth: 0.003, chipDepth: 0.001,
        }),
        shade: shade({
          base: [0.30, 0.42, 0.36], accent: [0.20, 0.32, 0.27], accentFill: 0, bumpSize: 0.003, bumpDepth: 0.15,
          pores: 0, roughness: 0.08, cavity: 0,
        }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
    case FractureClass.Steel:
      return {
        relief: relief({ amplitude: 0.002, featureSize: 0.02, tilt: 0.05, chipWidth: 0, chipDepth: 0 }),
        shade: shade({ base: [0.56, 0.56, 0.57], accent: [0.4, 0.3, 0.22], accentFill: 0.1, pores: 0, roughness: 0.4, metalness: 1, cavity: 0.2 }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
    case FractureClass.Ceramic:
    case FractureClass.Slate:
      return {
        relief: relief({ amplitude: 0.006, featureSize: 0.05, ridge: 0.6, lattice: 0.01 }),
        shade: shade({ base: [0.55, 0.30, 0.20], accent: [0.42, 0.22, 0.14], pores: 0.04, roughness: 0.9 }),
        rebar: { ...DEFAULT_REBAR_LOOK },
      };
  }
}

/** One look per class, index = FractureClass. Mutated in place by the tuner. */
export const FRACTURE_LOOKS: FractureLook[] = Array.from(
  { length: FRACTURE_CLASS_COUNT }, (_, cls) => defaults(cls as FractureClass),
);

/** Bumped whenever a GEOMETRY parameter changes, so cached crack meshes rebuild. */
export const fractureLookVersion = { value: 0 };

export function resetFractureLooks(): void {
  for (let cls = 0; cls < FRACTURE_CLASS_COUNT; cls += 1) FRACTURE_LOOKS[cls] = defaults(cls as FractureClass);
  fractureLookVersion.value += 1;
}

declare global {
  interface Window {
    __VIBE_FRACTURE__?: { looks: FractureLook[]; version: { value: number }; reset: () => void };
  }
}

if (typeof window !== 'undefined') {
  window.__VIBE_FRACTURE__ = { looks: FRACTURE_LOOKS, version: fractureLookVersion, reset: resetFractureLooks };
}
