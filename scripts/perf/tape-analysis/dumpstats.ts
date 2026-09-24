// Extracts every match-stats packet (kind 124, JSON) from a tape, with its arrival time.
//   npx tsx dumpstats.ts <tape> <outdir>/match_stats.json
// analyse.py reads the result as match_stats.json.
import { readFileSync, writeFileSync } from 'fs';
import { decodeCityTape } from '../../../client/src/city/cityTape';

const [tapePath, outPath] = process.argv.slice(2);
if (!tapePath || !outPath) {
  console.error('usage: dumpstats.ts <tape> <out.json>');
  process.exit(2);
}
const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const dec = new TextDecoder();
const out: { t: number; s: any }[] = [];
tape.packets.forEach((p, i) => {
  if (p[0] === 124) out.push({ t: tape.times[i], s: JSON.parse(dec.decode(p.subarray(1))) });
});
writeFileSync(outPath, JSON.stringify(out));
console.log(`match stats packets=${out.length}`);
if (out.length) {
  // One sample's shape, to see which fields a newer server publishes.
  const s = out[Math.min(30, out.length - 1)].s;
  console.log('fields', Object.keys(s).join(' '));
  if (s.spans) console.log('spans', Object.keys(s.spans).length);
}
