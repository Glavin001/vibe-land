/**
 * Holds a calibration run (server/src/calibration.rs report) to its spec
 * (scenario.mjs): per case, what the engine did -- bonds broken, when, which,
 * how far the structure fell -- against the hand calculation's prediction for
 * the configuration's model, and the engine's own bond utilisations at rest
 * against the hand calculation's, bond by bond.
 */
const quantile = (v, p) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

export function measure(spec, report, c) {
  const [n0, n1] = c.nodes, anchors = new Set(c.anchors.map((i) => i + n0));
  const first = report.positions[0].p, last = report.positions.at(-1).p;
  let maxDrop = 0, maxMove = 0, worstNode = null;
  const drops = [];
  for (let i = n0; i < n1; i++) {
    if (anchors.has(i)) continue;
    const y0 = first[3 * i + 1], y1 = last[3 * i + 1];
    // A chunk no longer found has left the stage (crushed to dust): count it fallen.
    const drop = Number.isFinite(y1) ? y0 - y1 : Infinity;
    const move = Number.isFinite(y1) ? Math.hypot(last[3 * i] - first[3 * i], y1 - y0, last[3 * i + 2] - first[3 * i + 2]) : Infinity;
    drops.push(drop);
    if (drop > maxDrop) { maxDrop = drop; worstNode = i - n0; }
    maxMove = Math.max(maxMove, move);
  }
  // The scene bond -> this case's bond key, by its chunks (rows name authored nodes).
  const sceneBonds = new Map();
  const broken = (report.cases[c.id]?.broken ?? []).map((b) => {
    const at = b.detail.at, i0 = Math.min(at.node0, at.node1) - n0, i1 = Math.max(at.node0, at.node1) - n0;
    return { tick: b.tick, nodes: [i0, i1], chunks: [c.names[i0], c.names[i1]], utilisation: at.utilisation, before: b.detail.before?.utilisation ?? null,
      stresses: { tension: at.tension, compression: at.compression, shear: at.shear, normal: at.normal, bend: at.bend } };
  }).sort((a, b) => a.tick - b.tick);
  const firstTick = broken.length ? broken[0].tick : null;
  // Pieces cut off from every anchor by the broken bonds: a mechanism, whether or not it fell.
  const gone = new Set(broken.map((b) => `${b.nodes[0]}-${b.nodes[1]}`)), n = n1 - n0, parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  (c.bondNodes ?? []).forEach(([a, b]) => { if (!gone.has(`${Math.min(a, b)}-${Math.max(a, b)}`)) parent[find(a)] = find(b); });
  const anchored = new Set(c.anchors.map(find));
  // Only chunks that hung from an anchor as built count: a piece built loose (a precast plank on
  // its bearing, a kentledge block) is not "freed".
  const parent0 = [...Array(n).keys()], find0 = (i) => (parent0[i] === i ? i : (parent0[i] = find0(parent0[i])));
  (c.bondNodes ?? []).forEach(([a, b]) => { parent0[find0(a)] = find0(b); });
  const anchored0 = new Set(c.anchors.map(find0));
  const free = [...Array(n).keys()].filter((i) => anchored0.has(find0(i)) && !anchored.has(find(i)));
  // collapses: it fell. fractured: a piece is free of every anchor but has not fallen (it is jammed
  // or resting on the rest). damaged: bonds broke, everything still hangs from an anchor.
  // holdsByDrop (masonry): a cracked joint is not a failure, a fallen arch is.
  const state = maxDrop >= spec.criteria.collapseMinDrop ? 'collapses'
    : spec.holdsByDrop ? (maxDrop <= spec.criteria.holdsMaxDrop ? 'holds' : 'damaged')
    : free.length ? 'fractured' : broken.length === 0 && maxMove <= spec.criteria.holdsMaxDrop ? 'holds' : 'damaged';
  return { state, broken: broken.length, firstTick, freeChunks: free.length, freeExamples: free.slice(0, 6).map((i) => c.names[i]), firstBroken: broken.filter((b) => b.tick === firstTick), brokenList: broken.slice(0, 40),
    maxDrop: +maxDrop.toFixed(3), maxMove: +maxMove.toFixed(3), fallenChunks: drops.filter((d) => d > spec.criteria.collapseMinDrop).length, worstChunk: worstNode == null ? null : c.names[worstNode], sceneBonds };
}

/** The engine's bond utilisations at rest (tick 2) against the prediction's, keyed like the spec. */
export function compareStress(spec, report, c, prediction, bondKeyOf) {
  const rows = report.rows?.find((r) => r.tick === 2)?.rows ?? report.rows?.[0]?.rows ?? [];
  const out = [];
  for (const r of rows) {
    const key = bondKeyOf(r);
    if (!key) continue;
    const want = prediction.bonds?.[key];
    if (want == null) continue;
    out.push({ key, engine: r.utilisation, hand: want, ratio: want > 1e-6 ? r.utilisation / want : null, tension: r.tension, compression: r.compression, shear: r.shear, bend: r.bend, normal: r.normal });
  }
  const loaded = out.filter((x) => x.hand >= 0.2 && x.ratio != null);
  const critical = out.length ? out.reduce((a, b) => (b.hand > a.hand ? b : a)) : null;
  const engineWorst = out.length ? out.reduce((a, b) => (b.engine > a.engine ? b : a)) : null;
  return {
    bonds: out.length, critical, engineWorst,
    ratio: loaded.length ? { median: +quantile(loaded.map((x) => x.ratio), 0.5).toFixed(3), p10: +quantile(loaded.map((x) => x.ratio), 0.1).toFixed(3), p90: +quantile(loaded.map((x) => x.ratio), 0.9).toFixed(3), n: loaded.length } : null,
  };
}

export function judge(spec, report, config, model) {
  const results = [];
  for (const c of spec.cases) {
    const prediction = c.predictions[model];
    const m = measure(spec, report, c);
    // Bond key by its two chunks (case-local), from the case's bond list order in the scene.
    const keyByNodes = new Map();
    // The spec's bondKeys are in the case pack's bond order; the scene keeps that order.
    const packBonds = c.bondNodes;
    if (packBonds) packBonds.forEach(([a, b], k) => keyByNodes.set(`${Math.min(a, b)}-${Math.max(a, b)}`, c.bondKeys[k]));
    const bondKeyOf = (r) => {
      const a = r.node0 - c.nodes[0], b = r.node1 - c.nodes[0];
      if (a < 0 || b < 0 || a >= c.nodes[1] - c.nodes[0] || b >= c.nodes[1] - c.nodes[0]) return null;
      return keyByNodes.get(`${Math.min(a, b)}-${Math.max(a, b)}`) ?? null;
    };
    const stress = compareStress(spec, report, c, prediction, bondKeyOf);
    // Bonds the scenario tolerates breaking without calling it damage (spec.tolerate, a regex over
    // bond keys: a mortar bed cracking under a plank is not the frame failing).
    if (spec.tolerate && m.state === 'damaged') {
      const re = new RegExp(spec.tolerate), keys = (report.cases[c.id]?.broken ?? []).map((b) => { const at = b.detail.at; return keyByNodes.get(`${Math.min(at.node0, at.node1) - c.nodes[0]}-${Math.max(at.node0, at.node1) - c.nodes[0]}`) ?? ''; });
      if (keys.every((k) => re.test(k))) { m.state = 'holds'; m.tolerated = keys.length; }
    }
    const firstKeys = m.firstBroken.map((b) => keyByNodes.get(`${b.nodes[0]}-${b.nodes[1]}`) ?? `${b.chunks.join('|')}`);
    // The bonds the hand calculation has past its capacity beyond the band: each must break on the
    // first breaking tick (its trial, or the corrected pass the trial's breaks lead to).
    const mustBreak = (prediction.over ?? []).filter((o) => o.u > 1 + (spec.band ?? 0)).map((o) => o.key);
    // A predicted collapse is met by the structure becoming a mechanism (fractured) -- the hand
    // calculation predicts failure, not where the pieces land; whether it also fell is `fell`.
    const stateOk = prediction.state === 'either' || prediction.state === m.state || (prediction.state === 'collapses' && m.state === 'fractured');
    const fell = prediction.state !== 'collapses' || m.state === 'collapses';
    // Right members: what broke first is what the hand calculation has at or over its capacity (within the band).
    const firstSet = new Set(firstKeys);
    // Holds: nothing breaks. Collapses: it starts where the hand calculation is worst -- a bond
    // within 5% of the worst utilisation (symmetric structures have twins) breaks on the first
    // breaking tick. (Which of the rest also go depends on the order pieces come free: past the
    // first breaks the structure is a mechanism, and `missed` lists them for the record.)
    // It starts where the hand calculation has the structure past its capacity: a first-tick break
    // among the bonds over 1 + band (or, when none is, within 5% of the worst).
    const worstU = prediction.u, overBand = (prediction.over ?? []).filter((o) => o.u > 1 + (spec.band ?? 0)).map((o) => o.key);
    const critical = overBand.length ? overBand : (prediction.over ?? []).filter((o) => o.u >= 0.95 * worstU).map((o) => o.key);
    const membersOk = spec.holdsByDrop || !critical.length ? true : prediction.state === 'holds' ? (m.broken === 0 || m.tolerated === m.broken) : prediction.state === 'collapses' ? critical.some((k) => firstSet.has(k)) : true;
    results.push({ case: c.id, label: c.label, predicted: { state: prediction.state, u: prediction.u, worst: prediction.worst },
      measured: { state: m.state, broken: m.broken, firstTick: m.firstTick, maxDrop: m.maxDrop, maxMove: m.maxMove, fallen: m.fallenChunks, free: m.freeChunks, firstBroken: firstKeys, mustBreak, missed: mustBreak.filter((k) => !firstSet.has(k)) },
      stress: { critical: stress.critical && { key: stress.critical.key, engine: +stress.critical.engine.toFixed(3), hand: stress.critical.hand }, engineWorst: stress.engineWorst && { key: stress.engineWorst.key, engine: +stress.engineWorst.engine.toFixed(3), hand: stress.engineWorst.hand }, ratio: stress.ratio },
      ok: { state: stateOk, members: membersOk, fell } });
  }
  // The scenario's headline: the first case (in removal order) that collapses, predicted and measured.
  const firstCollapse = (pick) => results.find((r) => pick(r))?.case ?? 'none';
  return { config, model, cases: results,
    firstCollapse: { real: spec.cases.find((c) => c.predictions.real?.state === 'collapses')?.id ?? 'none', predicted: firstCollapse((r) => r.predicted.state === 'collapses'), failed: firstCollapse((r) => ['collapses', 'fractured'].includes(r.measured.state)), fell: firstCollapse((r) => r.measured.state === 'collapses') },
    passed: results.every((r) => r.ok.state && r.ok.members), unconvergedTicks: report.unconvergedTicks, errors: report.errors, iterations: report.stressIterations };
}
