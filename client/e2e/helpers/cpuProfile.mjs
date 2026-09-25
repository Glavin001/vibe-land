// Reading V8 CPU profiles (Chrome DevTools protocol `Profiler.stop`) for the
// frame-hitch harnesses: e2e/tape-replay/profile-windows.mjs (a replayed
// tape) and e2e/city-bench/bench.mjs with CITY_BENCH_PROFILE (a live run).
//
// A hitch shows up in a profile as a busy stretch: consecutive non-idle
// samples. At 120 Hz a healthy frame keeps the main thread busy for 1-2 ms and
// idles the rest, so any stretch much longer than a frame is a slow frame (or
// a long task between frames). `busyStretches` finds them and says what ran.

const IGNORED = new Set(['(idle)', '(program)', '(root)']);

/** `name file:line` for a profile node; the special nodes keep their bare name. */
export function nodeLabel(node) {
  const f = node.callFrame;
  const file = f.url ? f.url.replace(/^.*\/(src|node_modules|deps)\//, '$1/').replace(/\?.*$/, '') : '';
  if (!file) return f.functionName || '(anon)';
  return `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`;
}

function index(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const labels = new Map(profile.nodes.map((n) => [n.id, nodeLabel(n)]));
  return { byId, parent, labels };
}

/** Sample times on the profile clock (ms) and each sample's weight (ms). */
function sampleTimes(profile) {
  const n = profile.samples.length;
  const at = new Float64Array(n);
  const weight = new Float64Array(n);
  let t = profile.startTime / 1000;
  for (let i = 0; i < n; i += 1) {
    t += profile.timeDeltas[i] / 1000;
    at[i] = t;
  }
  for (let i = 0; i < n; i += 1) weight[i] = i + 1 < n ? at[i + 1] - at[i] : 0;
  return { at, weight };
}

function accumulate(profile, idx, samples, weight, from, to, self, total) {
  for (let i = from; i < to; i += 1) {
    const id = samples[i];
    const label = idx.labels.get(id);
    if (IGNORED.has(label)) continue;
    const w = weight[i];
    self.set(label, (self.get(label) ?? 0) + w);
    const seen = new Set();
    for (let node = id; node !== undefined; node = idx.parent.get(node)) {
      const l = idx.labels.get(node);
      if (IGNORED.has(l) || seen.has(l)) continue;
      seen.add(l);
      total.set(l, (total.get(l) ?? 0) + w);
    }
  }
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(2)]);

/**
 * Self and inclusive time per function over the samples `include(tMs)`
 * accepts (profile clock, ms); idle and program time left out.
 */
export function topFunctions(profile, include = () => true, n = 30) {
  const idx = index(profile);
  const { at, weight } = sampleTimes(profile);
  const self = new Map();
  const total = new Map();
  let counted = 0;
  for (let i = 0; i < at.length; i += 1) {
    if (!include(at[i])) continue;
    const label = idx.labels.get(profile.samples[i]);
    if (!IGNORED.has(label)) counted += weight[i];
    accumulate(profile, idx, profile.samples, weight, i, i + 1, self, total);
  }
  return { countedMs: +counted.toFixed(1), self: top(self, n), total: top(total, n) };
}

/**
 * Busy stretches of at least `minMs`: runs of non-idle samples with no idle
 * gap over `gapMs`. Each carries its start on the profile clock (ms), its
 * length, and the functions with the most self and inclusive time in it.
 */
export function busyStretches(profile, { minMs = 25, gapMs = 1, n = 40 } = {}) {
  const idx = index(profile);
  const { at, weight } = sampleTimes(profile);
  const out = [];
  let start = -1;
  let lastBusy = -1;
  const close = () => {
    if (start < 0) return;
    const durMs = at[lastBusy] + weight[lastBusy] - at[start];
    if (durMs >= minMs) {
      const self = new Map();
      const total = new Map();
      accumulate(profile, idx, profile.samples, weight, start, lastBusy + 1, self, total);
      out.push({ atMs: at[start], durMs: +durMs.toFixed(1), self: top(self, n), total: top(total, n) });
    }
    start = -1;
  };
  for (let i = 0; i < at.length; i += 1) {
    const idle = idx.labels.get(profile.samples[i]) === '(idle)';
    if (idle) {
      if (start >= 0 && at[i] + weight[i] - (at[lastBusy] + weight[lastBusy]) > gapMs) close();
      continue;
    }
    if (start < 0) start = i;
    lastBusy = i;
  }
  close();
  return out;
}

/** Sum of self time per function over several stretches (what the hitches have in common). */
export function mergeStretches(stretches, n = 30) {
  const self = new Map();
  const total = new Map();
  for (const s of stretches) {
    for (const [k, v] of s.self) self.set(k, (self.get(k) ?? 0) + v);
    for (const [k, v] of s.total) total.set(k, (total.get(k) ?? 0) + v);
  }
  return { stretches: stretches.length, ms: +stretches.reduce((a, s) => a + s.durMs, 0).toFixed(1), self: top(self, n), total: top(total, n) };
}
