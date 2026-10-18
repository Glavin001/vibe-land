#!/usr/bin/env node
/**
 * Calibration structures: build a scenario's scene, run it on the GPU stage
 * under each engine configuration, judge it against the hand calculation.
 *
 *   node structures/calibration/run.mjs bridge-piers [--configs default,section,rotation]
 *        [--ticks N] [--judge-only] [--spec-only]
 *   node structures/calibration/run.mjs --all            # every scenario (the regression suite)
 *
 * Writes structures/calibration/out/<scenario>/{scene,spec}.json, a report per
 * configuration (report-<config>.json, server/src/calibration.rs) and
 * verdict.json. Exit 1 when a configuration held to the engineering
 * prediction (`real`) misses it.
 *
 * Correctness runs share the GPU (VIBE_GPU_SHARED=1 is set for the harness:
 * no timing is taken here). Each SDK builds in its own cargo tree,
 * target/calib-<sdk> (CALIB_TARGET_DIR overrides); PHYSX_ROOT replaces every
 * configuration's SDK, e.g. to run impact model E:
 *   PHYSX_ROOT=../PhysX/.claude/worktrees/impact-e/out/install/garage-impact \
 *     node structures/calibration/run.mjs bridge-piers --configs impact
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeScenario, REPO, OUT } from './src/scenario.mjs';
import { CONFIGS, sdkFor } from './src/configs.mjs';
import { judge } from './src/judge.mjs';

const KNOWN = existsSync(new URL('./known-gaps.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('./known-gaps.json', import.meta.url), 'utf8')) : {};
export const SCENARIOS = ['bridge-piers', 'truss-members', 'house-studs', 'house-headers', 'frame-column', 'demolition', 'masonry-arch'];

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);

/**
 * The source the harness builds from. The shared checkout carries other
 * agents' work in progress (a half-committed bridge does not compile), so a
 * pinned worktree, target/calib-src (`git worktree add --detach target/calib-src
 * <commit>`), with this checkout's harness copied over it, when one exists;
 * CALIB_SRC overrides, CALIB_SRC=. builds the checkout itself.
 */
export function source() {
  const dir = path.resolve(REPO, process.env.CALIB_SRC ?? 'target/calib-src');
  if (dir === REPO || !existsSync(path.join(dir, 'server/src/main.rs'))) return REPO;
  for (const f of ['calibration.rs', 'calibration_charges.rs']) {
    const want = readFileSync(path.join(REPO, 'server/src', f), 'utf8'), target = path.join(dir, 'server/src', f);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== want) writeFileSync(target, want);
  }
  const main = path.join(dir, 'server/src/main.rs');
  let text = readFileSync(main, 'utf8');
  const before = text;
  if (!/^mod calibration;$/m.test(text)) text = text.replace(/^mod structure_qualification;$/m, 'mod structure_qualification;\nmod calibration;');
  if (!/^mod calibration_charges;$/m.test(text)) text = text.replace(/^mod calibration;$/m, 'mod calibration;\nmod calibration_charges;');
  // The match loop's charge hook (main.rs, before the city step), for films of a demolition.
  const hook = '        crate::calibration_charges::apply_in_match(self.server_tick, self.arena.physx_world_mut());\n';
  if (!text.includes(hook)) text = text.replace('        #[cfg(feature = \"physx-city\")]\n        let world = self.arena.physx_world_mut();', `        #[cfg(feature = "physx-city")]\n${hook}        #[cfg(feature = "physx-city")]\n        let world = self.arena.physx_world_mut();`);
  if (text !== before) writeFileSync(main, text);
  return dir;
}

/** The test binary holding calibration_run for an SDK (cargo builds it once per tree). */
const binaries = new Map();
export function binary(sdk) {
  if (binaries.has(sdk)) return binaries.get(sdk);
  const target = process.env.CALIB_TARGET_DIR ?? path.join(REPO, 'target', `calib-${path.basename(sdk)}`);
  const src = source();
  const r = spawnSync('cargo', ['test', '-p', 'web-fps-server', '--release', '--features', 'native-destruction', '--no-run', '--message-format=json'],
    { cwd: src, env: { ...process.env, PHYSX_ROOT: sdk, CARGO_TARGET_DIR: target }, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) { process.stderr.write(r.stderr.slice(-4000)); throw Error(`build against ${sdk} failed`); }
  for (const line of r.stdout.split('\n')) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.executable && path.basename(m.executable).startsWith('web_fps_server-')) {
      const list = spawnSync(m.executable, ['--list', '--ignored'], { encoding: 'utf8' }).stdout;
      if (list.includes('calibration_run')) { binaries.set(sdk, m.executable); return m.executable; }
    }
  }
  throw Error('no test binary with calibration_run');
}

/** One GPU run of a scene under a configuration; returns the report. */
export function runScene({ scene, out, config, ticks, extraEnv = {} }) {
  const sdk = sdkFor(config), exe = binary(sdk);
  const env = {
    ...process.env, ...CONFIGS[config].env, ...extraEnv,
    PHYSX_ROOT: sdk, VIBE_CITY_SCENE: scene, VIBE_CALIB_OUT: out, VIBE_CALIB_TICKS: String(ticks), VIBE_GPU_SHARED: '1',
    VIBE_CITY_NATIVE_STRESS_ITERATIONS: extraEnv.VIBE_CITY_NATIVE_STRESS_ITERATIONS ?? process.env.VIBE_CITY_NATIVE_STRESS_ITERATIONS ?? '64',
    VIBE_DESTRUCTION_ASSET_DIR: path.join(REPO, 'destruction/assets/scenes'),
    CUMETAL_CACHE_DIR: process.env.CUMETAL_CACHE_DIR ?? path.join(REPO, 'target', 'cumetal-cache-calib'),
  };
  const log = out.replace(/\.json$/, '.log');
  const r = spawnSync(path.join(REPO, 'scripts/perf/gpu-run.sh'), [`calib-${config}`, exe, 'calibration_run', '--ignored', '--nocapture', '--test-threads=1'],
    // A run whose GPU work stalls (a shared, saturated GPU) is cut off: CALIB_TIMEOUT_S (default 1800).
    { cwd: path.join(REPO, 'server'), env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1000 * Number(process.env.CALIB_TIMEOUT_S ?? 1800), killSignal: 'SIGKILL' });
  writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0 || !existsSync(out)) throw Error(`calibration run (${config}) failed: see ${log}\n${(r.stderr ?? '').split('\n').filter((l) => /panicked|error|Error/.test(l)).slice(0, 8).join('\n')}`);
  const line = (r.stderr ?? '').split('\n').find((l) => l.startsWith('[calibration]') && l.includes('ticks in'));
  if (line) console.log(`  ${config}: ${line.replace('[calibration] ', '')}`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

function table(v) {
  const pad = (s, n) => String(s ?? '-').padEnd(n);
  console.log(`\n${v.config} (held to: ${v.model}${v.own ? `; its own model ${v.own.model}: ${v.own.passed ? 'consistent' : 'inconsistent'}, first collapse ${v.own.firstCollapse.predicted}` : ''}) -- first collapse: engineering prediction ${v.firstCollapse.real}, this model ${v.firstCollapse.predicted}; engine failed ${v.firstCollapse.failed}, fell ${v.firstCollapse.fell}; unconverged ticks ${v.unconvergedTicks}`);
  for (const r of v.cases) {
    const crit = r.stress.critical ? `${r.stress.critical.key} engine ${r.stress.critical.engine} hand ${r.stress.critical.hand}` : '';
    console.log(`  ${r.ok.state && r.ok.members ? (r.known && r.known.state !== '*' ? 'FIXD' : 'ok  ') : r.known?.holds ? 'GAP ' : 'MISS'} ${pad(r.case, 7)} predicted ${pad(r.predicted.state, 9)} u ${pad(r.predicted.u, 6)} measured ${pad(r.measured.state, 9)} broken ${pad(r.measured.broken, 4)} free ${pad(r.measured.free, 4)} drop ${pad(r.measured.maxDrop, 6)} | ${crit} | ratio ${r.stress.ratio ? `${r.stress.ratio.median} (${r.stress.ratio.p10}-${r.stress.ratio.p90})` : '-'}${r.measured.firstBroken.length ? ` | first: ${r.measured.firstBroken.slice(0, 4).join(', ')}` : ''}${r.scenario ? ` | ${JSON.stringify(r.scenario)}` : ''}`);
  }
}

export async function run(id, { configs, ticks, judgeOnly = false, specOnly = false }) {
  // A configuration that needs its own pack build (the high profile) runs as its own variant.
  const own = configs.filter((c) => CONFIGS[c]?.variant), rest = configs.filter((c) => !CONFIGS[c]?.variant);
  if (own.length && !process.env.CALIB_VARIANT) {
    let passed = true;
    if (rest.length) passed = (await run(id, { configs: rest, ticks, judgeOnly, specOnly })).passed && passed;
    for (const c of own) {
      const saved = { ...process.env };
      Object.assign(process.env, CONFIGS[c].build ?? {}, { CALIB_VARIANT: CONFIGS[c].variant });
      try { passed = (await run(id, { configs: [c], ticks, judgeOnly, specOnly })).passed && passed; }
      finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
    }
    return { passed };
  }
  const scenario = await import(`./scenarios/${id}.mjs`);
  // CALIB_VARIANT: the same scenario built another way (e.g. VIBE_REAL_CAPACITIES=1 CALIB_VARIANT=real-capacities),
  // in its own out/<id>-<variant>/ and known-gaps entry.
  const variant = process.env.CALIB_VARIANT;
  if (variant) id = `${id}-${variant}`;
  const { dir, spec } = writeScenario({ ...scenario, id, hand: scenario.hand?.() });
  console.log(`${id}: ${spec.cases.length} cases, scene ${spec.scene}`);
  if (specOnly) return { passed: true };
  const verdicts = [];
  for (const config of configs) {
    const out = path.join(dir, `report-${config}.json`);
    const iterations = process.env.VIBE_CITY_NATIVE_STRESS_ITERATIONS ?? (scenario.iterations ? String(scenario.iterations) : undefined);
    const extraEnv = { ...(iterations ? { VIBE_CITY_NATIVE_STRESS_ITERATIONS: iterations } : {}), ...(spec.charges ? { VIBE_CALIB_CHARGES: spec.charges } : {}) };
    let report;
    try { report = judgeOnly ? JSON.parse(readFileSync(out, 'utf8')) : runScene({ scene: spec.scene, out, config, ticks: ticks ?? spec.ticks, extraEnv }); }
    catch (error) { console.log(`\n${config}: NO RUN -- ${error.message.split('\n')[0]}`); verdicts.push({ config, passed: false, error: error.message.split('\n')[0], cases: [] }); continue; }
    // Held to the engineering prediction (`real`); the configuration's own model (the stage's
    // failure law with its bending and limits) is judged too, as a diagnostic of why it differs.
    const own = scenario.configModel?.[config] ?? CONFIGS[config].model;
    const v = judge(spec, report, config, 'real');
    if (own !== 'real') { const o = judge(spec, report, config, own); v.own = { model: own, passed: o.passed, firstCollapse: o.firstCollapse, cases: o.cases.map((r) => ({ case: r.case, predicted: r.predicted, ok: r.ok, stress: r.stress })) }; }
    // Known gaps (known-gaps.json): a case the engine is recorded to get wrong, with the state it
    // does reach. It still prints as a miss; the suite fails only on a miss that is not recorded,
    // or a recorded gap whose state changed (fixed, or worse: update the record either way).
    // A scenario's own checks per case (demolition: where the debris went), part of passing.
    if (scenario.judgeCase) for (const r of v.cases) { const extra = scenario.judgeCase(spec, report, spec.cases.find((c) => c.id === r.case)); if (extra) { r.scenario = extra; r.ok.scenario = extra.ok; r.ok.state = r.ok.state && extra.ok; } }
    const gaps = (KNOWN[id] ?? {})[config] ?? {};
    for (const r of v.cases) {
      // A case's own record, or the configuration's '*' (every case; state '*' matches any: a
      // structure that does not yet stand under that configuration, in another agent's hands).
      const g = gaps[r.case] ?? gaps['*'];
      const matches = g != null && (g.state === '*' || g.state === r.measured.state);
      r.known = g ? { state: g.state, note: g.note, holds: matches } : null;
      r.pass = (r.ok.state && r.ok.members && !g) || matches;
    }
    v.passed = v.cases.every((r) => r.pass);
    v.sdk = report.physxRoot; v.wallSeconds = report.wallSeconds;
    verdicts.push(v);
    table(v);
  }
  const prior = existsSync(path.join(dir, 'verdict.json')) ? JSON.parse(readFileSync(path.join(dir, 'verdict.json'), 'utf8')) : {};
  const merged = { ...prior, scenario: id, updated: new Date().toISOString(), configs: { ...(prior.configs ?? {}), ...Object.fromEntries(verdicts.map((v) => [v.config, v])) } };
  writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify(merged, null, 1));
  // Held to the engineering prediction: must match it. The default stage is held to its own model (a regression check).
  const passed = verdicts.every((v) => v.passed);
  return { passed, verdicts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = flag('--all') ? SCENARIOS : argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--all', '--judge-only', '--spec-only'].includes(argv[i - 1])));
  const configs = (opt('--configs', 'default,section,rotation,high')).split(',');
  const ticks = opt('--ticks') ? Number(opt('--ticks')) : undefined;
  let failed = 0;
  for (const id of ids) {
    const r = await run(id, { configs, ticks, judgeOnly: flag('--judge-only'), specOnly: flag('--spec-only') });
    if (!r.passed) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}
