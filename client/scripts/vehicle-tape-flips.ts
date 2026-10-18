// Vehicle loose-part flicker in a recorded tape (RECORD TAPE / session capture):
// per car, parts given two poses in one tick, and A->B->A flips across ticks
// (repeats collapsed) in what the server streamed.
//   cd client && npx tsx scripts/vehicle-tape-flips.ts <client.vltape>
// Positions are each part's car-frame origin, so a small piece far from that
// origin that only rotates reads as a large move; the drawn probe
// (__VIBE_VEHICLE_TRACE__ frame.drawnLoose) measures where parts are drawn.
import fs from 'node:fs';
import { decodeCityTape } from '../src/city/cityTape';
import { decodeVehicleRig } from '../src/vehicles/vehicleStream';
const tape = decodeCityTape(new Uint8Array(fs.readFileSync(process.argv[2])));
type P = { part: number; position: number[]; rotation: number[] };
// handle -> tick -> list of (arrival ms, packet index, parts)
const byHandle = new Map<number, Map<number, { t: number; page: number; pages: number; parts: P[] }[]>>();
let rigPackets = 0;
tape.packets.forEach((bytes, i) => {
  if (bytes[0] !== 141) return;
  const p = decodeVehicleRig(bytes) as any;
  if (!p) return;
  rigPackets++;
  let ticks = byHandle.get(p.handle); if (!ticks) byHandle.set(p.handle, ticks = new Map());
  let list = ticks.get(p.serverTick); if (!list) ticks.set(p.serverTick, list = []);
  list.push({ t: tape.times[i], page: p.page, pages: p.pages, parts: p.detached });
});
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
console.log('rig packets', rigPackets, 'handles', [...byHandle.keys()]);
for (const [handle, ticks] of byHandle) {
  const sorted = [...ticks.keys()].sort((a, b) => a - b);
  let sameTickConflicts = 0, worstSameTick = 0, conflictExample: any = null;
  // Same tick, same part, different poses in different packets.
  for (const tick of sorted) {
    const seen = new Map<number, number[]>();
    for (const pk of ticks.get(tick)!) for (const part of pk.parts) {
      const prev = seen.get(part.part);
      if (prev) { const d = dist(prev, part.position); if (d > 0.05) { sameTickConflicts++; if (d > worstSameTick) { worstSameTick = d; conflictExample = { tick, part: part.part, a: prev.map(v => +v.toFixed(2)), b: part.position.map(v => +v.toFixed(2)), packets: ticks.get(tick)!.map(x => ({ page: x.page, pages: x.pages, n: x.parts.length })) }; } } }
      seen.set(part.part, part.position);
    }
  }
  // Merged per tick like the client (last packet wins), then A-B-A flips across ticks.
  const merged = new Map<number, number[]>(); const series = new Map<number, { tick: number; p: number[] }[]>();
  for (const tick of sorted) {
    for (const pk of ticks.get(tick)!) for (const part of pk.parts) merged.set(part.part, part.position);
    for (const [part, p] of merged) { let s = series.get(part); if (!s) series.set(part, s = []); s.push({ tick, p }); }
  }
  let flips = 0, flipParts = new Set<number>(), worstFlip = 0, flipExample: any = null;
  // Repeated poses collapsed, so a flip that holds for a few ticks counts too.
  for (const [part, raw] of series) { const s = raw.filter((x, k) => k === 0 || dist(raw[k - 1].p, x.p) > 1e-4); series.set(part, s); }
  const flipTicks: number[] = [];
  for (const [part, s] of series) for (let i = 1; i + 1 < s.length; i++) {
    const out = dist(s[i - 1].p, s[i].p), back = dist(s[i - 1].p, s[i + 1].p);
    if (out > 0.2 && back < out * 0.3) { flips++; flipParts.add(part); flipTicks.push(s[i].tick); if (out > worstFlip) { worstFlip = out; flipExample = { part, ticks: [s[i - 1].tick, s[i].tick, s[i + 1].tick], p: [s[i - 1].p, s[i].p, s[i + 1].p].map(v => v.map(x => +x.toFixed(2))) }; } }
  }
  console.log(JSON.stringify({ handle, ticks: sorted.length, firstTick: sorted[0], lastTick: sorted.at(-1), maxParts: Math.max(...[...ticks.values()].map(l => l.reduce((n, x) => n + x.parts.length, 0))),
    flipTickRange: flipTicks.length ? [Math.min(...flipTicks), Math.max(...flipTicks)] : null, sameTickConflicts, worstSameTick: +worstSameTick.toFixed(2), conflictExample, abaFlips: flips, flipParts: flipParts.size, worstFlip: +worstFlip.toFixed(2), flipExample }));
}
