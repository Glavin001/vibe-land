// Extracts every match-stats packet (kind 124) from a tape, with its arrival time.
//   npx tsx dumpstats.ts <tape> <outdir>/match_stats.json
// analyse.py reads the result as match_stats.json. Older servers sent the whole
// /match-stats snapshot as JSON; current ones send the compact frame (the
// fields in shared/match-stats-frame.json). Both decode to the same shape.
import { readFileSync, writeFileSync } from 'fs';
import { decodeCityTape } from '../../../client/src/city/cityTape';
import { decodeMatchStatsPacket } from '../../../client/src/net/matchStatsFrame';

const [tapePath, outPath] = process.argv.slice(2);
if (!tapePath || !outPath) {
  console.error('usage: dumpstats.ts <tape> <out.json>');
  process.exit(2);
}
const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const out: { t: number; s: any }[] = [];
tape.packets.forEach((p, i) => {
  if (p[0] !== 124) return;
  const s = decodeMatchStatsPacket(p);
  if (s) out.push({ t: tape.times[i], s });
});
writeFileSync(outPath, JSON.stringify(out));
console.log(`match stats packets=${out.length}`);
if (out.length) {
  // One sample's shape, to see which fields a newer server publishes.
  const s = out[Math.min(30, out.length - 1)].s;
  console.log('fields', Object.keys(s).join(' '));
  if (s.spans) console.log('spans', Object.keys(s.spans).length);
}
