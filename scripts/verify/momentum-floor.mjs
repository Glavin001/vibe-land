#!/usr/bin/env node
// The momentum floor of a shot through a structure: the slowest the impactor
// can leave it, from momentum and the struck joints' strength and failure
// displacement (Hibbeler, Dynamics, 15.2-15.4), computed from the pack.
//
//   struck set  every chunk of the struck structure whose box reaches within
//               the impactor's radius of its line, from the struck face on
//               (generous: more chunks, more resistance and mass, a lower floor)
//   C_j         each joint with an end in the set, at its fatal limits:
//               sqrt(max(tension, compression)^2 + shear^2) x area (the
//               infinite-wall probe's upper bound, server/src/wall_matrix.rs)
//   J_j         the most impulse joint j can deliver before it fails: it
//               carries at most C_j while the impactor, closing at v, carries
//               it through its failure displacement delta_j (brittle: C_j / k_j,
//               k_j = E A / max(d, sqrt A) as the probe's work model; ductile:
//               its ultimate slip), so J_j <= C_j delta_j / v, and never more
//               than C_j for the whole overlap t_contact = (depth + 2R) / v_in
//   m_struck    the set's mass, carried along (perfectly inelastic)
//
//   (M + m) v_f = M v_in - sum_j J_j(v_f), with J_j = min(C_j delta_j / v_f, C_j t_contact):
//   solved for v_f (the closing speed is at least the exit speed, so this bounds
//   each J_j from above and v_f from below). No positive root: the joints can
//   stop it, floor 0.
// A run whose impactor leaves slower than the floor (or never gets past) was
// held by more than the joints can carry: an infinite wall.
//   node scripts/verify/momentum-floor.mjs --pack PACK --meta META RUN.json ...
// Exit 1 when any run is under its floor.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const packPath = opt('--pack'), metaPath = opt('--meta');
if (!packPath || !args.length) { console.error('usage: momentum-floor.mjs --pack PACK RUN.json ...'); process.exit(2); }
const D = JSON.parse(readFileSync(packPath, 'utf8'));
const META = metaPath ? JSON.parse(readFileSync(metaPath, 'utf8')).trials ?? [] : [];
const P = D.scenario, M = D.defaults.solver.materials;
const cap = (b) => { const m = M[b.m] ?? {}; return Math.hypot(Math.max(m.tensionFatal ?? 0, m.compressionFatal ?? 0), m.shearFatal ?? 0) * b.area; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** A joint's failure displacement (m): its ductile slip, else C / k with k = E A / max(d, sqrt A). */
const delta = (b) => {
  const m = M[b.m] ?? {};
  if ((m.ductileSlip ?? 0) > 0) return m.ductileSlip;
  const d = Math.max(dist(P.nodes[b.node0].centroid, P.nodes[b.node1].centroid), Math.sqrt(Math.max(b.area, 0)));
  const k = (m.elasticModulus ?? 30e9) * b.area / d;
  return k > 0 ? cap(b) / k : 0;
};
const byNode = new Map();
P.bonds.forEach((b, i) => { for (const n of [b.node0, b.node1]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(i); } });

/** The floor for one run (its trial's attack and the probe's mass, radius and entry speed). */
export function floorOf(run) {
  const a = run.attack, pr = run.probe;
  const t = run.matrix ?? {};
  const meta = run.trialMeta;
  const group = meta?.matrix?.group ?? run.matrix?.group ?? run.house?.group;
  const target = meta?.attack?.target, from = meta?.attack?.from ?? 0, slope = meta?.attack?.slope ?? 0;
  if (!pr || !target || !group) return null;
  const b = from * Math.PI / 180, d0 = [-Math.sin(b), -slope, -Math.cos(b)], n = Math.hypot(...d0), d = d0.map((x) => x / n);
  const R = pr.radius, M0 = pr.mass, v = pr.vIn;
  const set = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.nodes.length; i += 1) {
    if (!P.nodeGroups[i].startsWith(group) || !(P.nodes[i].mass > 0)) continue;
    const c = P.nodes[i].centroid, s = P.nodeSizes[i];
    const rel = [c.x - target[0], c.y - target[1], c.z - target[2]];
    const along = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
    const perp = Math.hypot(rel[0] - along * d[0], rel[1] - along * d[1], rel[2] - along * d[2]);
    const half = 0.5 * Math.hypot(s.x, s.y, s.z);
    if (along + half < -R || perp - half > R) continue;
    set.push(i); lo = Math.min(lo, along - half); hi = Math.max(hi, along + half);
  }
  const joints = [...new Set(set.flatMap((i) => byNode.get(i) ?? []))].map((j) => P.bonds[j]);
  const C = joints.reduce((s, b) => s + cap(b), 0);
  const mStruck = set.reduce((s, i) => s + P.nodes[i].mass, 0);
  const depth = set.length ? hi - Math.max(lo, -R) : 0;
  const tContact = (depth + 2 * R) / v;
  // h(v_f) = (M + m) v_f + sum_j min(C_j delta_j / v_f, C_j t) - M v >= 0 holds for
  // any real exit speed. h is a line plus a falling curve: it can be >= 0 at a
  // stop too, which needs every struck joint to hold, so it is possible only if
  // they can absorb the impactor's kinetic energy within their failure
  // displacements (work-energy: 1/2 M v^2 <= sum_j C_j delta_j). If they cannot,
  // the floor is h's largest root below v (scanned down from v, then bisected).
  const h = (vf) => (M0 + mStruck) * vf + joints.reduce((s, b) => s + Math.min(cap(b) * delta(b) / Math.max(vf, 1e-6), cap(b) * tContact), 0) - M0 * v;
  const work = joints.reduce((s, b) => s + cap(b) * delta(b), 0);
  let floor = 0;
  if (0.5 * M0 * v * v > work) {
    let hiV = v, loV = v;
    for (let k = 1; k <= 1000; k += 1) { loV = v * (1 - k / 1000); if (h(loV) <= 0) break; hiV = loV; }
    if (h(loV) <= 0) { for (let k = 0; k < 60; k += 1) { const mid = 0.5 * (loV + hiV); if (h(mid) <= 0) loV = mid; else hiV = mid; } floor = loV; }
  }
  const impulse = joints.reduce((s, b) => s + Math.min(cap(b) * delta(b) / Math.max(floor, 1e-6), cap(b) * tContact), 0);
  return { floor, work, ke: 0.5 * M0 * v * v, chunks: set.length, joints: joints.length, capacityN: C, impulse, tContact, mStruck, depth, vIn: v, exit: pr.pastMax > 0 ? (pr.vExit ?? pr.vOut) : Math.min(pr.vOut, pr.vExit ?? pr.vOut), past: pr.pastMax };
}

let failed = 0;
for (const f of args) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  for (const run of d.runs ?? []) {
    if (!run.attack || run.attack.kind !== 'shot') continue;
    // The trial's own definition (the meta the run was made from) gives the line.
    const meta = META.find((t) => t.id === run.trial) ?? (d.meta?.trials ?? []).find((t) => t.id === run.trial);
    const r = floorOf({ ...run, trialMeta: meta ?? run.trialMeta });
    if (!r) { console.log(`${run.trial}: no line or probe (pass --meta-carrying reports)`); failed += 1; continue; }
    const ok = r.exit >= r.floor;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${run.trial}: exit ${r.exit.toFixed(1)} m/s ${ok ? '>=' : '<'} floor ${r.floor.toFixed(1)} m/s ` +
      `(${r.chunks} chunks ${(r.mStruck / 1e3).toFixed(1)} t; ${r.joints} joints ${(r.capacityN / 1e6).toFixed(0)} MN, at most ${(r.impulse / 1e3).toFixed(1)} kN s before they fail, work ${(r.work / 1e6).toFixed(2)} MJ vs KE ${(r.ke / 1e6).toFixed(0)} MJ; overlap ${(r.tContact * 1e3).toFixed(1)} ms over ${r.depth.toFixed(2)} m; in ${r.vIn.toFixed(1)} m/s)`);
  }
}
process.exit(failed ? 1 : 0);
