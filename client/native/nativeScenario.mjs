// Run one e2e/vehicle-scenarios.mjs scenario inside the native app, through
// the browser QA's own engine (e2e/helpers/vehicleQaCore.mjs), against the
// in-process city. Used by the native QA (city-qa.mjs) and the recorded
// playthrough (city-demo.mjs).
//
// Server truth, meteors and resets come from the in-process session
// (globalThis.__VIBE_NATIVE_SESSION__: vehicleDebug / meteor / reset, the
// HTTP server's /city-vehicle-debug, /city-meteor, /city-reset); joins are
// the city camera drop the browser QA joins with.
import {
  carStateFromDebug,
  changeFilter,
  createTraceAnalyzer,
  evaluateChecks,
  frameFromTrace,
  joinDropPose,
  runScenario,
} from '../e2e/helpers/vehicleQaCore.mjs';

/**
 * `ctx`: { e2e, drive, session, note, sleep }. Returns the scenario's checks
 * ({ car, check, pass, detail }); throws if a step fails.
 */
export async function runNativeScenario(scenario, { e2e, drive, session, note, sleep }) {
  const snap = () => e2e.snapshot();
  const carState = async (car) => carStateFromDebug(car, JSON.parse(session.vehicleDebug(car)));
  const join = async (at) => {
    const [x, , z] = at;
    if (snap().drivenVehicleId != null) { drive.interact(); await sleep(800); }
    e2e.dropAt(joinDropPose(at));
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const p = snap().position;
      if (Math.hypot(p[0] - x, p[2] - z) < 3) break;
      await sleep(100);
    }
    await sleep(500);
    const p = snap().position;
    note(`joined at ${p.map((v) => v.toFixed(1)).join(', ')} (wanted ${x.toFixed(1)}, ${z.toFixed(1)})`);
  };

  const analyzer = createTraceAnalyzer();
  const changed = changeFilter();
  const watch = (await Promise.all((scenario.cars ?? []).map(carState))).map((st) => st.handle);
  globalThis.__VIBE_VEHICLE_TRACE__ = [];
  const drain = () => {
    const all = globalThis.__VIBE_VEHICLE_TRACE__ ?? [];
    for (const x of all.splice(0, all.length)) if (x.kind === 'frame') analyzer.accumulate(frameFromTrace(x, watch, changed));
  };
  const drainer = setInterval(drain, 100);
  e2e.setShotMode(scenario.shotMode ?? 'rifle');
  try {
    await runScenario(scenario, {
      carState,
      reset: async () => session.reset(),
      join,
      meteor: async ([x, y, z]) => session.meteor(x, y, z),
      drive: async (fn, ...args) => drive[fn](...args),
      snap: async () => snap(),
      note,
      sleep,
    }, () => analyzer.frameCount);
    drain();
  } finally {
    clearInterval(drainer);
    globalThis.__VIBE_VEHICLE_TRACE__ = undefined;
  }
  const final = await Promise.all((scenario.cars ?? [0, 1, 2, 3, 4]).map(carState));
  const analysis = analyzer.analyze();
  const checks = evaluateChecks(scenario, final, analysis);
  // A rocking part: was it rocking in what the client received (the server's
  // simulation) or only in what it drew (presentation)?
  for (const [handle, a] of Object.entries(analysis)) {
    if (a?.spin?.rockingParts > 0) {
      note(`car ${handle} spin: drawn ${JSON.stringify(a.spin.rocking.slice(0, 4))}; received ${a.receivedSpin.rockingGroups} rocking groups, ${a.receivedSpin.rockingFlips} flips ${JSON.stringify(a.receivedSpin.rocking.slice(0, 4))}`);
    }
  }
  return checks;
}
