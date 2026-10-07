/**
 * Engine configurations a calibration runs under, and the SDK each needs.
 *
 *   default    the stage as the game runs it: bond bending from the capped
 *              square-patch gain (bend_gain_max 3), one rotational length
 *              scale for every bond
 *   section    VIBE_SECTION_BENDING=1: each bond's bending and torsion from its
 *              real cross-section (PhysX PX_DESTRUCTION_SECTION_BENDING)
 *   rotation   VIBE_SECTION_ROTATION=1: and each bond's rotational stiffness
 *              from its section (PX_DESTRUCTION_SECTION_ROTATIONAL_STIFFNESS;
 *              implies section bending)
 *   impact     VIBE_IMPACT_CAPACITY=1 with section bending: impact model E
 *              (PhysX feat/impact-capacity), against whatever SDK PHYSX_ROOT names
 *
 * Every run: the app's stress settings (server/src/calibration.rs
 * app_settings), FP32, the fleet's 64-iteration cap (VIBE_CITY_NATIVE_STRESS_ITERATIONS),
 * internal correction limit 1 (the stage default). `model` is the prediction
 * a configuration is held to (the scenario's predictions are keyed by it):
 * `real` is the engineering prediction (true section moduli); `gain` is what
 * the default stage's capped-gain bending can read.
 *
 * PHYSX_ROOT, when set, replaces every configuration's SDK (one SDK per run).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { REPO } from './scenario.mjs';

const PHYSX = path.resolve(REPO, '../PhysX/out/install');
export const SDKS = {
  // Clean, current (PhysX 0e0aba8a0, section bending): the calibration default.
  roof: path.join(PHYSX, 'garage-roof'),
  // Section rotational stiffness (PhysX feat/section-rotational-stiffness).
  multihull: path.join(PHYSX, 'garage-multihull'),
  // Every accuracy capability (PhysX integration/high-fidelity): scripts/fidelity/high.env's SDK.
  hifi: process.env.HIGH_PHYSX_ROOT ?? path.resolve(REPO, '../PhysX/.claude/worktrees/hifi/out/install/garage-hifi'),
};

/** A profile's runtime flags, read from scripts/fidelity/<name>.env (its `export X=1` lines, not PHYSX_ROOT or pack flags). */
function profileEnv(name) {
  const text = readFileSync(path.join(REPO, 'scripts/fidelity', `${name}.env`), 'utf8'), env = {};
  for (const m of text.matchAll(/^export (VIBE_[A-Z_]+|PX_[A-Z_]+)=([^\s$]+)$/gm)) if (!['VIBE_CRUSH', 'VIBE_REAL_CAPACITIES', 'VIBE_PACK_SET', 'VIBE_FIDELITY'].includes(m[1])) env[m[1]] = m[2];
  return env;
}

export const CONFIGS = {
  default: { env: {}, sdk: 'roof', model: 'gain' },
  section: { env: { VIBE_SECTION_BENDING: '1' }, sdk: 'roof', model: 'real' },
  rotation: { env: { VIBE_SECTION_ROTATION: '1' }, sdk: 'multihull', model: 'real' },
  impact: { env: { VIBE_IMPACT_CAPACITY: '1', VIBE_SECTION_BENDING: '1' }, sdk: null, model: 'real' },
  // The project's two engine profiles (scripts/fidelity/{runtime,high}.env): `runtime` is what ships
  // (= default, on the clean SDK); `high` is every accuracy capability on, on the combined SDK
  // (garage-hifi), with its pack-build flags (VIBE_CRUSH, VIBE_REAL_CAPACITIES, centroid hulls) applied
  // to the scenario's packs: run.mjs builds a `high` variant of the spec for it.
  runtime: { env: {}, sdk: 'roof', model: 'gain' },
  high: { env: profileEnv('high'), sdk: 'hifi', model: 'real', variant: 'high', build: { VIBE_CRUSH: '1', VIBE_REAL_CAPACITIES: '1', TOWN_KIT_HULL_ORIGIN: 'centroid' } },
};

/** The SDK a configuration runs against (PHYSX_ROOT wins). */
export function sdkFor(config) {
  if (process.env.PHYSX_ROOT) return process.env.PHYSX_ROOT;
  const c = CONFIGS[config];
  if (!c.sdk) throw Error(`config ${config} needs PHYSX_ROOT (an SDK with its feature)`);
  return SDKS[c.sdk];
}

/** The elastic section modulus each prediction model reads a bond's bending with. */
export const BENDING = {
  real: (sec) => sec.S,
  // The stage's default: sigma = M/A min(6/sqrt(A), bend_gain_max 3) (NvBlastExtStressFormula.h).
  gain: (sec) => sec.A / Math.min(6 / Math.sqrt(sec.A), 3),
};
