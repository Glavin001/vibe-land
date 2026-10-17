// Fixture for client-core/src/interp.rs: the web's PlayerInterpolator (net/interpolation.ts) on
// seeded random histories, and what it samples. Writes client-core/tests/fixtures/player_interp_web.json,
// which client-core/tests/interp_parity.rs replays through the Rust port.
// Run: npx tsx scripts/player-interp-fixture.mts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlayerInterpolator, type PlayerSample } from '../src/net/interpolation';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICK_US = 16_667;
type Op =
  | { push: { id: number; sample: PlayerSample; intervalUs: number } }
  | { sample: { id: number; targetUs: number; out: (PlayerSample & { held: boolean }) | null } }
  | { latest: { id: number; out: (PlayerSample & { held: boolean }) | null } }
  | { remove: number };

const next = rng(7);
const interp = new PlayerInterpolator();
const ops: Op[] = [];
const state = new Map<number, { tick: number; pos: [number, number, number]; resting: boolean }>();
const norm = (s: PlayerSample | null) => (s ? { ...s, held: !!s.held } : null);

for (let step = 0; step < 1500; step += 1) {
  const id = 1 + Math.floor(next() * 4);
  const r = next();
  if (r < 0.55) {
    const st = state.get(id) ?? { tick: 100, pos: [0, 0, 0] as [number, number, number], resting: false };
    // Mostly the next snapshot; sometimes a gap (left out while still), sometimes late or a duplicate.
    const g = next();
    const tick = g < 0.7 ? st.tick + 1 : g < 0.85 ? st.tick + 5 + Math.floor(next() * 30) : st.tick - Math.floor(next() * 4);
    if (next() < 0.1) st.resting = !st.resting;
    const v: [number, number, number] = st.resting
      ? [next() < 0.5 ? 0 : 0.03, 0, 0]
      : [(next() - 0.5) * 12, (next() - 0.5) * 4, (next() - 0.5) * 12];
    if (!st.resting) st.pos = [st.pos[0] + v[0] / 60, st.pos[1] + v[1] / 60, st.pos[2] + v[2] / 60];
    else if (next() < 0.2) st.pos = [st.pos[0] + 0.02, st.pos[1], st.pos[2]];
    const sample: PlayerSample = {
      serverTimeUs: tick * TICK_US,
      position: [...st.pos],
      velocity: v,
      yaw: (next() - 0.5) * 20,
      pitch: (next() - 0.5) * 3,
      hp: Math.floor(next() * 101),
      flags: Math.floor(next() * 32),
    };
    const intervalUs = next() < 0.8 ? TICK_US : 0;
    interp.push(id, sample, intervalUs);
    ops.push({ push: { id, sample, intervalUs } });
    st.tick = Math.max(st.tick, tick);
    state.set(id, st);
  } else if (r < 0.93) {
    const st = state.get(id);
    const targetUs = ((st?.tick ?? 100) + (next() - 0.7) * 20) * TICK_US;
    ops.push({ sample: { id, targetUs, out: norm(interp.sample(id, targetUs)) } });
  } else if (r < 0.98) {
    ops.push({ latest: { id, out: norm(interp.latest(id)) } });
  } else {
    interp.remove(id);
    state.delete(id);
    ops.push({ remove: id });
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '../../client-core/tests/fixtures/player_interp_web.json');
writeFileSync(out, JSON.stringify(ops));
console.log(`wrote ${ops.length} operations to ${out}`);
