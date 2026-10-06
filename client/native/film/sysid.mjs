#!/usr/bin/env node
// The truck's response, measured: the `turn {json}` lines of a turning run
// (scripts/turning-lab.sh sysid, client/native/films/turning.mjs) reduced to
// the numbers vehicle-model.mjs is built from.
//
//   node client/native/film/sysid.mjs target/native-video/turning-<stamp>.log [--json out.json]
//
// Per steer step (full lock, then half lock the other way, at a held speed):
// the delay from the key to the front wheels moving and to the yaw rate
// reaching 10/63/90% of its steady value; the steady yaw rate, radius and
// lateral acceleration; the wheels' steady angle. Per phase: full-throttle
// acceleration, coasting and reverse-key braking against speed. Per
// handbrake turn: yaw rate, heading change and speed lost while held, and
// after release.
import { readFileSync, writeFileSync } from 'node:fs';

export function parseTurnLog(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf('turn {');
    if (i < 0) continue;
    try { rows.push(JSON.parse(line.slice(i + 5))); } catch { /* a torn line */ }
  }
  const episodes = new Map();
  for (const r of rows) {
    if (!episodes.has(r.e)) episodes.set(r.e, []);
    episodes.get(r.e).push(r);
  }
  return episodes;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const unwrap = (rows) => {
  const out = [];
  let prev = null, acc = 0;
  for (const r of rows) {
    if (prev != null) { let d = r.psi - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; acc += d; }
    prev = r.psi; out.push(acc);
  }
  return out;
};
/** The front wheels' mean steer (the two that move). */
const frontSteer = (r) => { const ws = r.ws ?? []; return ws.length >= 2 ? (ws[0] + ws[1]) / 2 : NaN; };

/** Time (s after t0) a signal first reaches `frac` of `target` (same sign). */
function reach(rows, t0, value, target, frac) {
  for (const r of rows) {
    if (r.t < t0) continue;
    if (Math.sign(target) * value(r) >= Math.abs(target) * frac) return +(r.t - t0).toFixed(3);
  }
  return null;
}

/** A steer step: from its first frame, the response, and its steady state (its last second). */
function stepResponse(rows, phase) {
  const step = rows.filter((r) => r.ph === phase);
  if (step.length < 30) return null;
  const t0 = step[0].t, t1 = step.at(-1).t, input = step[0].u[1];
  const steady = step.filter((r) => r.t >= t1 - 1.0);
  const r = mean(steady.map((s) => s.r)), v = mean(steady.map((s) => s.vf)), delta = mean(steady.map(frontSteer));
  const after = rows.filter((x) => x.t >= t0);
  const out = {
    input, speed: +v.toFixed(2), yawRate: +r.toFixed(3), wheelSteer: +delta.toFixed(4),
    radius: +(v / Math.abs(r)).toFixed(1), latG: +((v * Math.abs(r)) / 9.81).toFixed(3),
    curvature: +(r / v).toFixed(4), slipDeg: +((Math.atan2(mean(steady.map((s) => s.vl)), v) * 180) / Math.PI).toFixed(2),
    wheel10: reach(after, t0, frontSteer, delta, 0.1), wheel90: reach(after, t0, frontSteer, delta, 0.9),
    yaw10: reach(after, t0, (x) => x.r, r, 0.1), yaw63: reach(after, t0, (x) => x.r, r, 0.632), yaw90: reach(after, t0, (x) => x.r, r, 0.9),
  };
  // Release: from the next phase's first frame, yaw rate down to 37% and 10%.
  const rel = rows.filter((x) => x.t > t1);
  if (rel.length) {
    const tr = rel[0].t;
    const drop = (frac) => { const hit = rel.find((x) => Math.sign(r) * x.r <= Math.abs(r) * frac); return hit ? +(hit.t - tr).toFixed(3) : null; };
    out.release37 = drop(0.368); out.release10 = drop(0.1);
  }
  // The yaw-rate trace from the key, every 0.05 s (for the model fit).
  out.trace = after.filter((x) => x.t <= t0 + 2.5).filter((_, k) => k % 3 === 0).map((x) => [+(x.t - t0).toFixed(3), x.r, +frontSteer(x).toFixed(4), x.vf]);
  return out;
}

/** dv/dt against v over a phase, in 1 m/s bins (central differences over ±0.1 s). */
function accelCurve(rows, phases) {
  const bins = new Map();
  for (const ph of phases) {
    const seg = rows.filter((r) => r.ph === ph);
    for (let k = 6; k < seg.length - 6; k += 1) {
      const dt = seg[k + 6].t - seg[k - 6].t;
      if (dt <= 0) continue;
      const a = (seg[k + 6].vf - seg[k - 6].vf) / dt, v = seg[k].vf, bin = Math.round(v);
      if (!bins.has(bin)) bins.set(bin, []);
      bins.get(bin).push(a);
    }
  }
  return [...bins].sort((a, b) => a[0] - b[0]).map(([v, as]) => [v, +mean(as).toFixed(3), as.length]);
}

function handbrake(rows) {
  const hb = rows.filter((r) => r.ph === 'hb');
  if (!hb.length) return null;
  const psi = unwrap(rows), at = (t) => psi[rows.findIndex((r) => r.t >= t)] ?? psi.at(-1);
  const t0 = hb[0].t, t1 = hb.at(-1).t, v0 = hb[0].vf;
  const rel = rows.filter((r) => r.ph === 'hbrel');
  const peak = hb.reduce((m, r) => (Math.abs(r.r) > Math.abs(m.r) ? r : m), hb[0]);
  const sample = (list, every) => list.filter((_, k) => k % every === 0).map((r) => [+(r.t - t0).toFixed(2), r.r, +r.vf.toFixed(2), +((at(r.t) - at(t0)) * 180 / Math.PI).toFixed(1), +(Math.hypot(r.vf, r.vl)).toFixed(2)]);
  return {
    entrySpeed: +v0.toFixed(2), hold: +(t1 - t0).toFixed(2),
    peakYawRate: +peak.r.toFixed(3), peakAt: +(peak.t - t0).toFixed(2),
    headingAtRelease: +(((at(t1) - at(t0)) * 180) / Math.PI).toFixed(1), speedAtRelease: +hb.at(-1).vf.toFixed(2),
    planarSpeedAtRelease: +Math.hypot(hb.at(-1).vf, hb.at(-1).vl).toFixed(2),
    headingAfter: rel.length ? +(((at(rel.at(-1).t) - at(t0)) * 180) / Math.PI).toFixed(1) : null,
    trace: sample([...hb, ...rel], 6),
  };
}

export function analyse(episodes) {
  const out = { steps: [], handbrake: [], accel: [], coast: [], brake: [], reverse: null, latency: null };
  for (const [id, rows] of episodes) {
    if (id.startsWith('steps')) {
      for (const ph of ['stepA', 'stepB']) { const s = stepResponse(rows, ph); if (s) out.steps.push({ id, phase: ph, ...s }); }
    }
    if (id.startsWith('handbrake')) { const h = handbrake(rows); if (h) out.handbrake.push({ id, ...h }); }
    out.accel.push(...accelCurve(rows, ['accel']).map((b) => [id, ...b]));
    out.coast.push(...accelCurve(rows, ['coast', 'hbrel']).map((b) => [id, ...b]));
    out.brake.push(...accelCurve(rows, ['brake']).map((b) => [id, ...b]));
    if (rows.some((r) => r.ph === 'rev')) {
      const rev = rows.filter((r) => r.ph === 'rev'), turn = rows.filter((r) => r.ph === 'revturn');
      out.reverse = { topSpeed: +Math.min(...rev.map((r) => r.vf)).toFixed(2), accel: accelCurve(rows, ['rev']), turnYawRate: turn.length ? +mean(turn.slice(-30).map((r) => r.r)).toFixed(3) : null };
    }
  }
  // Pool the curves over episodes.
  const pool = (list) => {
    const m = new Map();
    for (const [, v, a, n] of list) { if (!m.has(v)) m.set(v, [0, 0]); const e = m.get(v); e[0] += a * n; e[1] += n; }
    return [...m].sort((a, b) => a[0] - b[0]).map(([v, [s, n]]) => [v, +(s / n).toFixed(3), n]);
  };
  out.accel = pool(out.accel); out.coast = pool(out.coast); out.brake = pool(out.brake);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: sysid.mjs LOG [--json OUT]'); process.exit(2); }
  const result = analyse(parseTurnLog(readFileSync(file, 'utf8')));
  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(result, null, 1));
  console.log('steer steps (input, speed m/s, yaw rate rad/s, radius m, lateral g, wheel rad, slip deg; s from the key: wheel 10/90%, yaw 10/63/90%, release 37/10%)');
  for (const s of result.steps) {
    console.log(`  ${s.id.padEnd(9)} ${String(s.input).padStart(4)}  v ${s.speed.toFixed(1).padStart(5)}  r ${s.yawRate.toFixed(3).padStart(6)}  R ${String(s.radius).padStart(5)}  ${s.latG.toFixed(2)} g  wheel ${s.wheelSteer.toFixed(3)}  slip ${s.slipDeg}  `
      + `wheel ${s.wheel10}/${s.wheel90}  yaw ${s.yaw10}/${s.yaw63}/${s.yaw90}  release ${s.release37}/${s.release10}`);
  }
  console.log('handbrake (entry m/s, held s, peak yaw rad/s at s, heading at release deg, speed at release, heading after)');
  for (const h of result.handbrake) console.log(`  ${h.id.padEnd(18)} ${h.entrySpeed}  ${h.hold}  ${h.peakYawRate} @ ${h.peakAt}  ${h.headingAtRelease}  ${h.speedAtRelease} (${h.planarSpeedAtRelease})  ${h.headingAfter}`);
  const curve = (name, c) => console.log(`${name}: ${c.map(([v, a]) => `${v}:${a}`).join(' ')}`);
  curve('full throttle accel (m/s: m/s^2)', result.accel);
  curve('coast', result.coast);
  curve('reverse-key brake', result.brake);
  if (result.reverse) console.log(`reverse: top ${result.reverse.topSpeed} m/s, turn yaw ${result.reverse.turnYawRate}`);
}

/**
 * The model against the run: from the logged state at the start of each
 * `horizon`-second window, the logged keys replayed through vehicle-model.mjs;
 * the position and heading it ends at against where the truck was.
 * Windows with the handbrake (not modelled) are skipped. Returns per-window
 * errors and a summary.
 */
export async function replayErrors(episodes, { horizon = 2, every = 1 } = {}) {
  const model = await import('./vehicle-model.mjs');
  const out = [];
  for (const [id, rows] of episodes) {
    for (let k = 0; k < rows.length; k += Math.round(every * 60)) {
      const n = Math.round(horizon * 60);
      if (k + n >= rows.length) break;
      const win = rows.slice(k, k + n + 1);
      if (win.some((r) => r.u[2]) || win[0].vf < 0.5) continue;
      // The keys already in the input path at the window's start: the two before it.
      const s = model.initialState({ x: win[0].x, z: win[0].z, psi: win[0].psi, vf: win[0].vf, r: win[0].r });
      s.cmd = -(win[0].ws?.[0] ?? 0) / model.SERVER.maxSteer; // the inner (left) wheel: lock x maxSteer when turning that way
      if (Math.abs(win[0].ws?.[1] ?? 0) > Math.abs(win[0].ws?.[0] ?? 0)) s.cmd = -(win[0].ws[1]) / model.SERVER.maxSteer;
      s.queue = [rows[k - 2]?.u ?? [0, 0], rows[k - 1]?.u ?? [0, 0]].map((u) => [u[0], u[1]]);
      for (let j = 0; j < n; j += 1) model.step(s, { forward: win[j].u[0], strafe: win[j].u[1] });
      const end = win[n];
      const dpsi = Math.atan2(Math.sin(s.psi - end.psi), Math.cos(s.psi - end.psi));
      out.push({ id, ph: win[0].ph, t: win[0].t, pos: Math.hypot(s.x - end.x, s.z - end.z), psiDeg: (dpsi * 180) / Math.PI, dv: s.vf - end.vf });
    }
  }
  const q = (a, f) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(f * b.length))]; };
  const pos = out.map((o) => o.pos), psi = out.map((o) => Math.abs(o.psiDeg)), dv = out.map((o) => Math.abs(o.dv));
  return { windows: out, summary: { n: out.length, horizon, posMedian: q(pos, 0.5), posP90: q(pos, 0.9), posMax: Math.max(...pos), psiMedianDeg: q(psi, 0.5), psiP90Deg: q(psi, 0.9), dvMedian: q(dv, 0.5), dvP90: q(dv, 0.9) } };
}
