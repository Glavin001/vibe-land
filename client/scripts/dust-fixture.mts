// Fixture for client-core/src/dust.rs: the web's DustPolicy (city/dustPolicy.ts) on seeded random
// sources, and every parcel it spawns, with its smoulder ticks between. Writes
// client-core/tests/fixtures/dust_web.json, which client-core/tests/dust_parity.rs replays through
// the Rust port.
// Run: npx tsx scripts/dust-fixture.mts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DustPolicy, paletteFromAppearance } from '../src/city/dustPolicy';
import type { DustSource } from '../src/city/destructionEvents';
import type { DustParcelStore } from '../src/vfx/dustParcelStore';

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

type P = { bornMs: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; radius0: number; intensity: number; seed: number; shape: number; palette: number };
let spawned: P[] = [];
const store = { spawn: (p: P) => spawned.push({ bornMs: p.bornMs, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, radius0: p.radius0, intensity: p.intensity, seed: p.seed, shape: p.shape, palette: p.palette }) } as unknown as DustParcelStore;

const appearance = [
  { name: 'concrete', textureKey: 'concrete' },
  { name: 'Oak timber', textureKey: 'wood' },
  { name: 'steel girder' },
  { name: 'window glass', textureKey: 'glass' },
  { name: 'brick' },
];
const paletteOf = (m: number) => paletteFromAppearance(appearance as never, m);
const policy = new DustPolicy(store, paletteOf);
const KINDS = ['fracture', 'crush', 'impact', 'entry', 'shed', 'wave'] as const;

const next = rng(2026);
const ops: unknown[] = [];
let tick = 100;
let nowMs = 1000;
for (let i = 0; i < 1200; i += 1) {
  if (next() < 0.3) {
    tick += 1 + Math.floor(next() * 3);
    nowMs += 16 + next() * 40;
    spawned = [];
    policy.tick(nowMs);
    ops.push({ tick: { nowMs, parcels: spawned } });
  }
  const unit = () => {
    if (next() < 0.15) return [0, 0, 0];
    const v = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return v.map((c) => c / l);
  };
  const n = unit();
  const source = {
    kind: KINDS[Math.floor(next() * KINDS.length)],
    structureId: Math.floor(next() * 16),
    simTick: tick,
    ordinal: Math.floor(next() * 50),
    x: next() * 200 - 100, y: next() * 30, z: next() * 200 - 100,
    nx: n[0], ny: n[1], nz: n[2],
    vx: next() * 10 - 5, vy: next() * 6 - 3, vz: next() * 10 - 5,
    magnitude: next() < 0.1 ? 0 : Math.exp(next() * 7) - 1,
    material: Math.floor(next() * appearance.length),
    atMs: nowMs,
  } as unknown as DustSource;
  spawned = [];
  const count = policy.emit(source);
  ops.push({ emit: { source, palette: paletteOf(source.material), count, parcels: spawned } });
}
const palettes = appearance.map((a) => ({ name: a.name, textureKey: a.textureKey ?? null, palette: paletteFromAppearance([a] as never, 0) }));
const out = join(dirname(fileURLToPath(import.meta.url)), '../../client-core/tests/fixtures/dust_web.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ palettes, stats: policy.stats, ops }));
console.log(`dust fixture: ${ops.length} ops, ${policy.stats.emitted} parcels, ${policy.stats.droppedByTickCap} dropped by the tick cap -> ${out}`);
