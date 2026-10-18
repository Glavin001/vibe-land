// Loose parts turning back and forth between two orientations, tick to tick,
// in what the server streamed (a recorded tape). A body flip-flopping between
// two orientations is drawn in two places at once; position checks miss it.
//   cd client && npx tsx scripts/vehicle-tape-spin-flips.ts <client.vltape> [handle]
import fs from 'node:fs';
import { decodeCityTape } from '../src/city/cityTape';
import { decodeVehicleRig } from '../src/vehicles/vehicleStream';
const tape = decodeCityTape(new Uint8Array(fs.readFileSync(process.argv[2])));
const only = process.argv[3] ? Number(process.argv[3]) : null;
type Q = number[];
const angle = (a: Q, b: Q) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
const byHandle = new Map<number, Map<number, Map<number, Q>>>();
tape.packets.forEach((b) => { if (b[0] !== 141) return; const r = decodeVehicleRig(b) as any; if (only !== null && r.handle !== only) return;
  let t = byHandle.get(r.handle); if (!t) byHandle.set(r.handle, t = new Map());
  let m = t.get(r.serverTick); if (!m) t.set(r.serverTick, m = new Map());
  for (const d of r.detached) m.set(d.part, d.rotation); });
for (const [handle, ticks] of byHandle) {
  const sorted = [...ticks.keys()].sort((a, b) => a - b);
  const merged = new Map<number, Q>(); const series = new Map<number, { tick: number; q: Q }[]>();
  for (const t of sorted) { for (const [p, q] of ticks.get(t)!) merged.set(p, q);
    for (const [p, q] of merged) { let s = series.get(p); if (!s) series.set(p, s = []); if (!s.length || angle(s.at(-1)!.q, q) > 0.01) s.push({ tick: t, q }); } }
  let flips = 0, worst = 0, ex: any = null; const parts = new Set<number>(); const perTick = new Map<number, number>();
  for (const [p, s] of series) for (let i = 1; i + 1 < s.length; i++) {
    const out = angle(s[i - 1].q, s[i].q), back = angle(s[i - 1].q, s[i + 1].q);
    if (out > 10 && back < out * 0.3) { flips++; parts.add(p); perTick.set(s[i].tick, (perTick.get(s[i].tick) ?? 0) + 1);
      if (out > worst) { worst = out; ex = { part: p, ticks: [s[i - 1].tick, s[i].tick, s[i + 1].tick], degrees: [+out.toFixed(1), +back.toFixed(1)] }; } }
  }
  if (!series.size) continue;
  const runs = [...parts].map((p) => { const s = series.get(p)!; let n = 0; for (let i = 1; i + 1 < s.length; i++) { const o = angle(s[i - 1].q, s[i].q); if (o > 10 && angle(s[i - 1].q, s[i + 1].q) < o * 0.3) n++; } return [p, n]; }).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(JSON.stringify({ handle, parts: series.size, spinFlips: flips, flipParts: parts.size, worstDegrees: +worst.toFixed(1), example: ex, mostFlips: runs,
    tickRange: perTick.size ? [Math.min(...perTick.keys()), Math.max(...perTick.keys())] : null }));
}
