// A session tape starts after the join, so it lacks the vehicle asset packets
// and /cityreplay draws the city fleet as stock cars. This prepends them
// (prepared by a running server) so the replay draws the real cars.
//   cd client && npx tsx scripts/tape-add-vehicle-assets.ts <in.vltape> <out.vltape>
import fs from 'node:fs';
import { decodeCityTape, encodeCityTape, TAPE_CHANNEL_WT_RELIABLE } from '../src/city/cityTape';
import { garageBuilds } from '../src/vehicles/builds.mjs';
const [input, output] = process.argv.slice(2);
const tape = decodeCityTape(new Uint8Array(fs.readFileSync(input)));
const fleet = ['monster', 'desert', 'derby', 'circuit', 'buggy'];
const extra: Uint8Array[] = [];
for (const [i, id] of fleet.entries()) {
  const configuration = garageBuilds.find((b: { id: string }) => b.id === id)!.configuration;
  const r = await fetch('http://localhost:4001/vehicle-assets/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configuration }) });
  if (!r.ok) throw new Error(`${id}: ${r.status} ${await r.text()}`);
  const vehicle = await r.json();
  const json = new TextEncoder().encode(JSON.stringify({ handle: i + 1, vehicle }));
  const bytes = new Uint8Array(json.length + 1); bytes[0] = 140; bytes.set(json, 1); // PKT_VEHICLE_ASSET
  extra.push(bytes);
  console.log(id, 'handle', i + 1, vehicle.assetHash.slice(0, 12));
}
const t0 = tape.times[0];
tape.packets = [...extra, ...tape.packets];
tape.times = Float64Array.from([...extra.map(() => t0), ...tape.times]);
tape.channels = Uint8Array.from([...extra.map(() => TAPE_CHANNEL_WT_RELIABLE), ...tape.channels]);
fs.writeFileSync(output, encodeCityTape(tape));
console.log('wrote', output, tape.packets.length, 'packets');
