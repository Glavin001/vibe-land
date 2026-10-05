// The vehicle QA engine, shared by the browser runner (e2e/vehicle-qa.mjs:
// headless Chromium against the fleet server) and the native runner
// (client/native/vehicle-qa-native.mjs: the macOS app with its in-process
// city). Scenarios are e2e/vehicle-scenarios.mjs; what differs per runner is
// only how it reaches the game, the `env` passed to runScenario:
//
//   env.carState(car)      server truth for fleet car `car` (index), from
//                          /city-vehicle-debug: see carStateFromDebug
//   env.reset()            rebuild the city (/city-reset)
//   env.join([x, y, z])    put the player there
//   env.meteor([x, y, z])  drop the city's meteor (/city-meteor)
//   env.drive(fn, ...args) window.__VIBE_DRIVE__[fn](...args)
//   env.snap()             window.__VIBE_E2E__.snapshot()
//   env.afterStep(index)   optional: screenshot or similar
//   env.note(text)         log a line
//   env.sleep(ms)
//
// The trace side is pure: feed accumulate() the renderer's vehicle trace
// frames (frameFromTrace() turns one raw __VIBE_VEHICLE_TRACE__ entry into
// what accumulate() reads), then analyze() and evaluateChecks().

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const angle = (a, b) =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;

/** Server truth for one car: pose, heading, loose parts, which parts are off. */
export function carStateFromDebug(car, d) {
  const off = new Set(d.hulls.filter((h) => h.actor !== 0).map((h) => h.part));
  const q = d.vehicle2?.rotation ?? [0, 0, 0, 1];
  // Yaw of the car's +z (forward) axis.
  const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
  return { car, handle: d.handle, position: d.snapshot?.position ?? d.vehicle2?.position, heading: Math.atan2(fx, fz),
    speed: Math.hypot(...(d.vehicle2?.linearVelocity ?? [0, 0, 0])), bodies: d.actors.length, partsOff: [...off].sort((a, b) => a - b),
    wheelMask: d.vehicle?.wheelMask };
}

/**
 * Where a join puts the player: standing at the join point (a scenario's
 * car plus its offset), facing downtown. Both runners send it as a city
 * camera drop (the bridge's dropAt), the command the garage arrival uses.
 */
export const joinDropPose = ([x, y, z]) => ({ position: [x, y + 1, z], yaw: -Math.PI / 2, pitch: -0.2 });

// Flip detection online, per car handle: each series keeps only its last two
// distinct samples, so memory is O(parts) however long the run. A flip is
// A -> B -> A among distinct samples: out = |A-B| over `min`, back = |A-C|
// under 30% of it.
export function tracker(measure, min) {
  return { a: null, b: null, count: 0, worst: 0, example: null, measure, min,
    push(sample) {
      if (this.b && this.measure(this.b.v, sample.v) < 1e-4) return; // unchanged
      if (this.a && this.b) {
        const out = this.measure(this.a.v, this.b.v), back = this.measure(this.a.v, sample.v);
        if (out > this.min && back < out * 0.3) {
          this.count++; this.first ??= sample.i; this.last = sample.i;
          if (out > this.worst) { this.worst = out; this.example = [this.a, this.b, sample].map((x) => ({ frame: x.i, rigTick: x.rigTick, v: x.v.map((n) => +n.toFixed(3)) })); }
        }
      }
      this.a = this.b; this.b = sample;
    } };
}

/**
 * One raw vehicle-trace frame (scene/netEntityRenderers.ts) in the compact
 * form accumulate() reads. Only parts that changed since the last sample are
 * kept (`changed(key, values)` remembers); `watch` limits loose parts to
 * those cars' handles (null = every car).
 */
export function frameFromTrace(x, watch, changed) {
  const r = (v, d) => v.map((n) => Math.round(n * d) / d);
  const watched = !watch || watch.includes(x.id);
  return { t: x.t, id: x.id, rigTick: x.rigTick, position: r(x.position, 1e4), detached: x.detached,
    loose: watched ? (x.drawnLoose ?? []).map((p) => [p.id, r(p.center ?? p.position, 1e4), p.rotation ? r(p.rotation, 1e5) : null])
      .filter(([id, p, q]) => changed(`${x.id}/${id}`, q ? [...p, ...q] : p)) : [],
    received: watched ? (x.rigDetached ?? []).filter((d) => d.rotation).map((d) => [d.part, r(d.rotation, 1e5)])
      .filter(([part, q]) => changed(`${x.id}#${part}`, q)) : [] };
}

/** A `changed(key, values)` for frameFromTrace, with its own memory. */
export function changeFilter() {
  const last = new Map();
  return (key, v) => { const k = v.join(','); if (last.get(key) === k) return false; last.set(key, k); return true; };
}

export function createTraceAnalyzer() {
  const tracks = {};
  let frameCount = 0;
  return {
    get frameCount() { return frameCount; },
    accumulate(f) {
      const i = frameCount++;
      const t = (tracks[f.id] ??= { frames: 0, maxLoose: 0, car: tracker(dist, 0.1), parts: {}, spins: {}, received: {}, where: {} });
      t.frames++;
      t.car.push({ i, rigTick: f.rigTick, v: f.position });
      for (const [id, p, q] of f.loose) {
        (t.parts[id] ??= tracker(dist, 0.2)).push({ i, rigTick: f.rigTick, v: p });
        if (q) (t.spins[id] ??= tracker(angle, 10)).push({ i, rigTick: f.rigTick, v: q });
        t.where[id] = p;
      }
      // What the client RECEIVED for each detached group (server truth on the
      // wire), so a flip can be placed on the server or in the renderer.
      for (const [part, q] of f.received ?? []) (t.received[part] ??= tracker(angle, 10)).push({ i, rigTick: f.rigTick, v: q });
    },
    analyze() {
      const analysis = {};
      for (const [handle, t] of Object.entries(tracks)) {
        let partFlips = 0, flipParts = 0, worst = 0, example = null;
        for (const [id, tr] of Object.entries(t.parts)) if (tr.count) { partFlips += tr.count; flipParts++; if (tr.worst > worst) { worst = tr.worst; example = { part: id, samples: tr.example }; } }
        // A part that flips three or more times is rocking between two
        // orientations (what a player sees as a phantom); one flip is a fast
        // tumble caught between frames.
        let spinFlips = 0, spinParts = 0, spinWorst = 0, spinExample = null, rocking = 0, rockingFlips = 0;
        const rockingDetail = [];
        for (const [id, tr] of Object.entries(t.spins)) {
          if (!tr.count) continue;
          spinFlips += tr.count; spinParts++;
          if (tr.worst > spinWorst) { spinWorst = tr.worst; spinExample = { part: id, samples: tr.example }; }
          if (tr.count >= 3) { rocking++; rockingFlips += tr.count; rockingDetail.push({ part: id, flips: tr.count, worstDegrees: +tr.worst.toFixed(1), frames: [tr.first, tr.last], position: t.where[id] }); }
        }
        const received = Object.entries(t.received).filter(([, tr]) => tr.count >= 3)
          .map(([part, tr]) => ({ part: +part, flips: tr.count, worstDegrees: +tr.worst.toFixed(1), frames: [tr.first, tr.last] })).sort((a, b) => b.flips - a.flips);
        analysis[handle] = { frames: t.frames, maxLooseDrawn: Object.keys(t.parts).length,
          receivedSpin: { groups: Object.keys(t.received).length, rockingGroups: received.length, rockingFlips: received.reduce((n, r) => n + r.flips, 0), rocking: received.slice(0, 30) },
          car: { count: t.car.count, worst: +t.car.worst.toFixed(2), example: t.car.example },
          loose: { parts: Object.keys(t.parts).length, flips: partFlips, flipParts, worst: +worst.toFixed(2), example },
          spin: { flips: spinFlips, parts: spinParts, rockingParts: rocking, rockingFlips, rocking: rockingDetail, worstDegrees: +spinWorst.toFixed(1), example: spinExample } };
      }
      return analysis;
    },
  };
}

export function evaluateChecks(scenario, final, analysis) {
  const checks = [];
  for (const c of scenario.checks ?? []) {
    const st = final.find((s) => s.car === c.car);
    const a = st ? analysis[st.handle] : null;
    let pass, detail;
    if (c.drawnFlicker) {
      const flipsSeen = a?.loose.flips ?? 0;
      pass = flipsSeen <= c.drawnFlicker.max; detail = `${flipsSeen} loose-part flips (max ${c.drawnFlicker.max}), worst ${a?.loose.worst ?? 0} m over ${a?.loose.parts ?? 0} parts`;
    } else if (c.spinFlicker) {
      const n = a?.spin.rockingParts ?? 0; pass = n <= c.spinFlicker.max;
      detail = `${n} loose parts rocking between two orientations (>=3 flips over 10°; max ${c.spinFlicker.max}), ${a?.spin.rockingFlips ?? 0} flips; all flips ${a?.spin.flips ?? 0} on ${a?.spin.parts ?? 0} parts, worst ${a?.spin.worstDegrees ?? 0}°`;
    } else if (c.carFlicker) {
      const n = a?.car.count ?? 0; pass = n <= c.carFlicker.max; detail = `${n} car-body flips (max ${c.carFlicker.max}), worst ${a?.car.worst ?? 0} m`;
    } else if (c.partsOff) {
      const n = st.partsOff.length; pass = (c.partsOff.min ?? 0) <= n && n <= (c.partsOff.max ?? Infinity); detail = `${n} parts off (want ${c.partsOff.min ?? 0}..${c.partsOff.max ?? '∞'})`;
    } else if (c.wheelsOn) {
      pass = st.wheelMask === 15; detail = `wheel mask ${st.wheelMask?.toString(2).padStart(4, '0')} (1111 = all four on the car)`;
    }
    checks.push({ car: c.car, check: Object.keys(c).find((k) => k !== 'car'), pass, detail });
  }
  return checks;
}

async function steerTo(env, car, target, { maxMs = 15000, speed = 8, arrive = 3 } = {}) {
  const t0 = Date.now();
  let st = await env.carState(car);
  while (Date.now() - t0 < maxMs) {
    st = await env.carState(car);
    const dx = target[0] - st.position[0], dz = target[2] - st.position[2];
    if (Math.hypot(dx, dz) < arrive) break;
    let err = Math.atan2(dx, dz) - st.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    // +strafe steers right; heading grows toward +x from +z, i.e. to the car's left.
    const steer = Math.max(-1, Math.min(1, -err * 2));
    // Slow for a sharp turn, or the car circles a point inside its turning circle.
    const forward = st.speed < speed * Math.max(0.35, Math.cos(err)) ? 1 : 0;
    await env.drive('move', { forward, strafe: steer, durationMs: 200 });
    await env.sleep(100);
  }
  await env.drive('move', { forward: 0, strafe: 0, durationMs: 50 });
  return st;
}

/**
 * Run a scenario's steps. `frameCount()` reports how many trace frames have
 * been accumulated so far (for step marks). Returns { results, marks }.
 */
export async function runScenario(scenario, env, frameCount = () => 0) {
  const results = {};
  const marks = {}; // step label -> frame index at that point
  let stepIndex = 0;
  for (const step of scenario.steps) {
    marks[step.label ?? JSON.stringify(step).slice(0, 40)] = frameCount();
    if (step.resetCity) {
      await env.reset();
      await env.sleep(3000);
      env.note('city reset');
    } else if (step.joinBeside !== undefined) {
      const st = await env.carState(step.joinBeside);
      const [x, , z] = st.position;
      const off = step.offset ?? [0, 0, -12];
      await env.join([x + off[0], 1, z + off[2]]);
    } else if (step.joinAt) {
      await env.join(step.joinAt);
    } else if (step.lookAtPoint) {
      await env.drive('lookAt', ...step.lookAtPoint);
      await env.sleep(200);
    } else if (step.aimAt !== undefined) {
      const st = await env.carState(step.aimAt);
      await env.drive('lookAt', st.position[0], st.position[1] + (step.up ?? 0.5), st.position[2]);
      await env.sleep(200);
    } else if (step.fire) {
      const { count = 1, intervalMs = 600, reaim, at } = step.fire;
      for (let i = 0; i < count; i++) {
        if (reaim !== undefined) { const st = await env.carState(reaim); await env.drive('lookAt', st.position[0], st.position[1] + 0.5, st.position[2]); }
        if (at) await env.drive('lookAt', ...at);
        await env.drive('fire', { holdMs: 60 });
        await env.sleep(intervalMs);
      }
      env.note(`fired ${count}`);
    } else if (step.meteor !== undefined) {
      const st = await env.carState(step.meteor);
      await env.meteor(st.position);
      env.note(`meteor on car ${step.meteor}`);
    } else if (step.enter !== undefined) {
      await env.drive('interact');
      await env.sleep(800);
      const s = await env.snap();
      env.note(`driving vehicle ${s.drivenVehicleId}`);
      if (s.drivenVehicleId == null) throw new Error('could not enter the car');
    } else if (step.driveTo) {
      const target = typeof step.driveTo.to === 'number' ? (await env.carState(step.driveTo.to)).position : step.driveTo.to;
      const st = await steerTo(env, step.driveTo.car, target, step.driveTo);
      env.note(`drove car ${step.driveTo.car} to ${st.position.map((v) => v.toFixed(1))} at ${st.speed.toFixed(1)} m/s`);
    } else if (step.wait) {
      await env.sleep(step.wait);
    }
    if (step.label) results[step.label] = await Promise.all((scenario.cars ?? []).map((c) => env.carState(c)));
    await env.afterStep?.(stepIndex++);
  }
  await env.sleep(scenario.settleMs ?? 1500);
  return { results, marks };
}
