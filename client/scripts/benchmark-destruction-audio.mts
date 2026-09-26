#!/usr/bin/env -S node --import=tsx/esm
/** CPU-only audio control benchmarks. These do not run Web Audio, a browser,
 * network decoding, occlusion rays, asset decoding, or the physics simulation.
 * Run from client/: node --import=tsx/esm scripts/benchmark-destruction-audio.mts
 * Optional: --samples=21 --frames=360 --json
 */
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { AudioDirector } from '../src/audio/director.ts';
import { DestructionActivity } from '../src/audio/destructionActivity.ts';
import { SoundMotionTracker, type MotionSample } from '../src/audio/motion.ts';
import { MATERIALS, type SoundEvent, type Vec3 } from '../src/audio/model.ts';

const args = new Set(process.argv.slice(2));
function positiveArg(name: string, fallback: number): number {
  const arg = [...args].find(value => value.startsWith(`--${name}=`));
  const value = arg ? Number(arg.split('=')[1]) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error(`Invalid --${name}`);
  return value;
}
const samples = positiveArg('samples', 21);
const frames = positiveArg('frames', 360);
const WARMUPS = 5, BURST = 10000, BODIES = 600;
const listener: Vec3 = [0, 1.6, 0];
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => Number(sorted[Math.floor((sorted.length - 1) * fraction)].toFixed(3));
  return { minMs: at(0), medianMs: at(.5), p95Ms: at(.95), maxMs: at(1) };
}
function events(order: 'normal' | 'increasing' | 'decreasing'): SoundEvent[] {
  return Array.from({ length: BURST }, (_, i) => ({
    id: `bench-${i}`, kind: order === 'normal' && i % 97 === 0 ? 'flyby' : 'impact',
    material: MATERIALS[i % MATERIALS.length],
    position: order === 'normal' ? [((i * 17) % 47 - 23) * 3, i % 5, ((i * 29) % 43 - 21) * 3] : [0, 0, -20],
    intensity: order === 'normal' ? .1 + ((i * 7919) % 1000) / 1112 : order === 'increasing' ? (i + 1) / BURST : 1 - i / BURST,
    size: .2 + i % 7, seed: i, atMs: 1000,
    protected: order !== 'normal' || i % 97 === 0,
  }));
}
function benchmarkDirector(order: 'normal' | 'increasing' | 'decreasing') {
  const input = events(order); // Allocation/fixture generation excluded.
  const enqueue: number[] = [], drain: number[] = [];
  let last: { queued: number; selected: number; grouped: number; dropped: number } | undefined;
  for (let run = -WARMUPS; run < samples; run++) {
    const director = new AudioDirector(); director.listener = listener;
    const started = performance.now();
    for (const event of input) director.enqueue(event);
    const queuedAt = performance.now(), queued = director.queued;
    let played = 0, weakestSelected = Infinity;
    director.drain(1000, event => { played++; weakestSelected = Math.min(weakestSelected, event.intensity); });
    const drainedAt = performance.now();
    if (queued > 256 || played > 12) throw new Error('Audio director exceeded its resource bound');
    if (order === 'increasing' && weakestSelected < .998) throw new Error('Director lost the most important late events');
    if (run >= 0) { enqueue.push(queuedAt - started); drain.push(drainedAt - queuedAt); }
    last = { queued, selected: played, grouped: director.stats.grouped, dropped: director.stats.dropped };
  }
  return { eventCount: BURST, order, enqueue: summarize(enqueue), drain: summarize(drain), final: last };
}

function benchmarkMotion() {
  const frameInput: MotionSample[][] = [];
  for (let frame = 0; frame < frames + 30; frame++) {
    const nowMs = 1000 + frame * (1000 / 60);
    frameInput.push(Array.from({ length: BODIES }, (_, body) => ({
      id: `body-${body}`, nowMs, sampleTimeMs: nowMs,
      position: [(body % 30 - 15) * 3 + Math.sin(frame * .05), .5 + (body % 4) * .2, (Math.floor(body / 30) - 10) * 3],
      velocity: frame % 30 === 0 ? [.1, 0, 0] : [6, 0, 2],
      material: MATERIALS[body % MATERIALS.length], mass: 30, size: .8,
    })));
  }
  const timings: number[] = [];
  const tracker = new SoundMotionTracker(); let emitted = 0;
  const accept = () => { emitted++; };
  for (let frame = 0; frame < frameInput.length; frame++) {
    const started = performance.now();
    for (const sample of frameInput[frame]) tracker.note(sample, listener, accept);
    tracker.prune(frameInput[frame][0].nowMs);
    const elapsed = performance.now() - started;
    if (frame >= 30) timings.push(elapsed);
  }
  // This also catches complete LRU churn: there must be prior motion samples
  // left when a 600-body frame slows down. Timing alone would miss that bug.
  if (frames >= 30 && emitted < BODIES) throw new Error('Repeated motion frames lost their body history');
  return { bodiesPerFrame: BODIES, measuredFrames: frames, warmupFrames: 30, perFrame: summarize(timings), emitted };
}

function benchmarkActivity() {
  const input=events('normal'),timings:number[]=[];
  let regions=0,emitters=0;
  for(let run=-WARMUPS;run<samples;run++){
    const activity=new DestructionActivity(),started=performance.now();
    for(const e of input)activity.add(e,listener,1000);
    const beds=activity.sample(1000,listener),elapsed=performance.now()-started;
    regions=activity.regionCount;emitters=beds.length;
    if(regions>64||emitters>4||emitters===0)throw new Error('Destruction activity lost its bounded output');
    if(run>=0)timings.push(elapsed);
  }
  return {eventCount:BURST,addAndSample:summarize(timings),regions,emitters};
}

const report = {
  scope: 'CPU control logic only; not browser audio rendering, audio-thread work, sound quality, GPU performance, or network cost.',
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, measuredAt: new Date().toISOString() },
  directorSamples: samples,
  directorWarmups: WARMUPS,
  director: [benchmarkDirector('normal'), benchmarkDirector('increasing'), benchmarkDirector('decreasing')],
  motion: benchmarkMotion(),
  activity: benchmarkActivity(),
};
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(report.scope);
  console.log(`${report.environment.cpu}; ${report.environment.node}; ${samples} measured director runs after ${WARMUPS} warmups.`);
  console.table(report.director.map(r => ({ workload: `${r.eventCount} ${r.order}`, enqueueMedianMs: r.enqueue.medianMs, enqueueP95Ms: r.enqueue.p95Ms, drainMedianMs: r.drain.medianMs, queued: r.final?.queued, played: r.final?.selected })));
  console.log(`${BODIES} bodies, ${frames} repeated frames after 30 warmups: median ${report.motion.perFrame.medianMs} ms/frame, p95 ${report.motion.perFrame.p95Ms} ms/frame; ${report.motion.emitted} detected events.`);
  console.log(`${BURST} raw destruction events to ${report.activity.emitters} beds / ${report.activity.regions} regions: median ${report.activity.addAndSample.medianMs} ms, p95 ${report.activity.addAndSample.p95Ms} ms.`);
}
