#!/usr/bin/env node
// Summarise a V8 .cpuprofile (from scripts/native-mac.sh profile, or any
// Chrome DevTools / node --cpu-prof profile): where the JS thread's time went.
//
//   node scripts/perf/cpuprofile-summary.mjs target/native-perf/triple-meteor.cpuprofile [top=25]
//
// Prints the busy share (not idle), garbage collection, the time under each
// root entry point (the frame callback, timers, promise jobs), and the top
// functions by inclusive time (with everything they call) and by self time.
// Times are sampled wall time on the JS thread, in ms per second of profile.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const top = Number(process.argv[3] ?? 25);
if (!file) {
  console.error('usage: cpuprofile-summary.mjs <file.cpuprofile> [top]');
  process.exit(2);
}
const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const isNative = (n) => String(n.callFrame.scriptId) === '0' && !n.callFrame.functionName.startsWith('(');
const jsLabel = (n) => {
  const f = n.callFrame;
  const name = f.functionName || '(anonymous)';
  const where = f.url ? `${path.basename(f.url)}:${f.lineNumber + 1}` : `line ${f.lineNumber + 1}`;
  return `${name}  ${where}`;
};
// A native function (a runtime binding, e.g. a WebGPU call) has no name or
// script: it is labelled by the JS function that called it.
const label = (n) => {
  if (!isNative(n)) return jsLabel(n);
  let caller = nodes.get(parent.get(n.id));
  while (caller && isNative(caller)) caller = nodes.get(parent.get(caller.id));
  return `[native] <- ${caller ? jsLabel(caller) : '?'}`;
};
const special = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

const totalUs = profile.timeDeltas.reduce((a, b) => a + b, 0);
const seconds = totalUs / 1e6;
const self = new Map();
const inclusive = new Map();
const roots = new Map();
let idleUs = 0;
let gcUs = 0;
let programUs = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const dt = profile.timeDeltas[i + 1] ?? 0;
  const node = nodes.get(profile.samples[i]);
  const name = node.callFrame.functionName;
  if (name === '(idle)') { idleUs += dt; continue; }
  if (name === '(garbage collector)') gcUs += dt;
  if (name === '(program)') programUs += dt;
  self.set(label(node), (self.get(label(node)) ?? 0) + dt);
  // Inclusive: once per distinct function on the stack. Root: the outermost
  // named frame under (root).
  const seen = new Set();
  let rootLabel = label(node);
  for (let id = node.id; id !== undefined; id = parent.get(id)) {
    const n = nodes.get(id);
    if (special.has(n.callFrame.functionName)) continue;
    const l = label(n);
    if (!seen.has(l)) {
      seen.add(l);
      inclusive.set(l, (inclusive.get(l) ?? 0) + dt);
    }
    rootLabel = l;
  }
  roots.set(rootLabel, (roots.get(rootLabel) ?? 0) + dt);
}

const busyUs = totalUs - idleUs;
const perSec = (us) => (us / 1000 / seconds).toFixed(1).padStart(7);
const share = (us) => `${((us / Math.max(1, busyUs)) * 100).toFixed(1).padStart(5)}%`;
const table = (title, map, n) => {
  console.log(`\n${title} (ms per second of profile, share of busy time)`);
  for (const [k, us] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)) {
    console.log(`${perSec(us)}  ${share(us)}  ${k}`);
  }
};

console.log(`== ${path.basename(file)}: ${seconds.toFixed(1)} s, ${profile.samples.length} samples`);
console.log(`busy ${perSec(busyUs)} ms/s (${((busyUs / totalUs) * 100).toFixed(0)}% of wall time)  gc ${perSec(gcUs).trim()} ms/s  program (native/runtime) ${perSec(programUs).trim()} ms/s`);
table('Entry points', roots, 12);
table('Inclusive', inclusive, top);
table('Self', self, top);
