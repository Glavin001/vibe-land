// Bodies streamed below ground (y < -3 m) in the city chunk stream (absolute-pose records only).
//   (cd client && npx tsx ../scripts/perf/tape-analysis/below.ts <tape>)
import { readFileSync, writeFileSync } from 'fs';
import { decodeCityTape } from '../../../client/src/city/cityTape';
import { decodeChunksDatagram, RecordMode } from '../../../client/src/city/wire';
const tape = decodeCityTape(new Uint8Array(readFileSync(process.argv[2])));
const firstBelow = new Map<number, { t: number; y: number; vy: number }>();
const minY = new Map<number, number>();
let absRecords = 0, below = 0;
const perSec: number[] = [];
tape.packets.forEach((p, i) => {
  if (p[0] !== 119) return;
  const c = decodeChunksDatagram(p);
  for (const r of c.records) {
    if (r.mode === RecordMode.Delta || r.mode === RecordMode.MotionDelta) continue;
    absRecords++;
    const y = r.position[1];
    minY.set(r.bodyEntity, Math.min(minY.get(r.bodyEntity) ?? 1e9, y));
    if (y < -3) {
      below++;
      const s = Math.floor(tape.times[i] / 1000); perSec[s] = (perSec[s] ?? 0) + 1;
      if (!firstBelow.has(r.bodyEntity)) firstBelow.set(r.bodyEntity, { t: tape.times[i], y, vy: r.linearVelocity[1] });
    }
  }
});
console.log({ absRecords, below, bodiesBelow: firstBelow.size });
const ys = [...minY.values()].sort((a, b) => a - b);
console.log('lowest min-y per body', ys.slice(0, 15).map((v) => v.toFixed(1)).join(' '));
console.log('first below-ground sightings', [...firstBelow.entries()].slice(0, 20).map(([e, v]) => `${e.toString(16)}@${(v.t / 1000).toFixed(1)}s y=${v.y.toFixed(1)} vy=${v.vy.toFixed(1)}`).join('\n'));
console.log('below-ground records per second', JSON.stringify(perSec));
