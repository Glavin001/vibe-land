// Streaming efficiency from a client tape: what the city chunk stream and the
// game snapshots spent their bytes on, per second of tape.
//   (cd client && npx tsx ../scripts/perf/city-bench/stream.ts <tape> <out.json>)
//
// A "repeat" is a record that restates a pose the client already had: the
// same body, same record family (absolute or delta against the same
// baseline), position within 1 mm and rotation within ~0.01 degrees of that
// body's previous record, and (for motion records) no velocity. Every repeat
// is bytes that told the client nothing new -- the redundancy figure.
// Snapshot bodies are compared the same way, per handle, in world space.
import { readFileSync, writeFileSync } from 'fs';
import { decodeCityTape } from '../../../client/src/city/cityTape';
import { decodeChunksDatagram, RecordMode } from '../../../client/src/city/wire';
import { decodeServerDatagramPacket } from '../../../client/src/net/protocol';

const [tapePath, outPath] = process.argv.slice(2);
if (!tapePath || !outPath) {
  console.error('usage: stream.ts <tape> <out.json>');
  process.exit(2);
}
const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));

type Row = {
  s: number; cityBytes: number; cityDatagrams: number; records: number; repeats: number; repeatBytes: number;
  bodies: number; moving: number; abs: number; delta: number; motion: number; ballistic: number; belowGround: number;
  snapBytes: number; snapshots: number; snapBodies: number; snapBodyRepeats: number;
};
const rows = new Map<number, Row & { bodySet: Set<number>; movingSet: Set<number> }>();
const row = (s: number) => {
  let r = rows.get(s);
  if (!r) {
    r = { s, cityBytes: 0, cityDatagrams: 0, records: 0, repeats: 0, repeatBytes: 0, bodies: 0, moving: 0, abs: 0, delta: 0, motion: 0,
      ballistic: 0, belowGround: 0, snapBytes: 0, snapshots: 0, snapBodies: 0, snapBodyRepeats: 0, bodySet: new Set(), movingSet: new Set() };
    rows.set(s, r);
  }
  return r;
};

type Last = { family: string; p: number[]; q: number[] };
const lastRecord = new Map<number, Last>();
const lastSnapBody = new Map<number, number[]>();
const belowBodies = new Set<number>();
// When each snapshot body handle was being streamed: [first, last] tape ms
// runs, split where it went unsent for more than 250 ms.
const presence = new Map<number, number[][]>();
let decodeErrors = 0;
const isDelta = (m: RecordMode) => m === RecordMode.Delta || m === RecordMode.MotionDelta;

tape.packets.forEach((p, i) => {
  const s = Math.floor(tape.times[i] / 1000);
  try {
    if (p[0] === 119) {
      const c = decodeChunksDatagram(p);
      const r = row(s);
      r.cityBytes += p.length;
      r.cityDatagrams += 1;
      const perRecord = c.records.length ? (p.length - 15) / c.records.length : 0;
      for (const rec of c.records) {
        r.records += 1;
        r.bodySet.add(rec.bodyEntity);
        if (rec.mode === RecordMode.Absolute) r.abs += 1;
        else if (rec.mode === RecordMode.Delta) r.delta += 1;
        else if (rec.mode === RecordMode.Ballistic) r.ballistic += 1;
        else r.motion += 1;
        const family = isDelta(rec.mode) ? `d${c.baselineId}` : 'a';
        const prev = lastRecord.get(rec.bodyEntity);
        const still = Math.hypot(...rec.linearVelocity) < 0.01 && Math.hypot(...rec.angularVelocity) < 0.01;
        if (prev && prev.family === family && still
          && Math.hypot(rec.position[0] - prev.p[0], rec.position[1] - prev.p[1], rec.position[2] - prev.p[2]) < 0.001
          && Math.abs(Math.abs(rec.rotation[0] * prev.q[0] + rec.rotation[1] * prev.q[1] + rec.rotation[2] * prev.q[2] + rec.rotation[3] * prev.q[3]) - 1) < 1e-8) {
          r.repeats += 1;
          r.repeatBytes += perRecord;
        }
        lastRecord.set(rec.bodyEntity, { family, p: rec.position, q: rec.rotation });
        const moved = !prev || prev.family !== family
          || Math.hypot(rec.position[0] - prev.p[0], rec.position[1] - prev.p[1], rec.position[2] - prev.p[2]) > 0.01;
        if (moved || !still) r.movingSet.add(rec.bodyEntity);
        if (!isDelta(rec.mode) && rec.position[1] < -3) { r.belowGround += 1; belowBodies.add(rec.bodyEntity); }
      }
    } else if (p[0] === 112) {
      const snap: any = decodeServerDatagramPacket(p);
      const r = row(s);
      r.snapBytes += p.length;
      r.snapshots += 1;
      const ax = snap.anchorPxMm / 1000, ay = snap.anchorPyMm / 1000, az = snap.anchorPzMm / 1000;
      for (const b of [...snap.sphereStates, ...snap.boxStates]) {
        r.snapBodies += 1;
        const pos = [ax + b.dxQ2_5mm * 0.0025, ay + b.dyQ2_5mm * 0.0025, az + b.dzQ2_5mm * 0.0025];
        const prev = lastSnapBody.get(b.handle);
        if (prev && Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]) < 0.003 && b.vxCms === 0 && b.vyCms === 0 && b.vzCms === 0) {
          r.snapBodyRepeats += 1;
        }
        lastSnapBody.set(b.handle, pos);
        const t = tape.times[i];
        const runs = presence.get(b.handle) ?? [];
        const lastRun = runs[runs.length - 1];
        if (lastRun && t - lastRun[1] <= 250) lastRun[1] = t;
        else runs.push([t, t]);
        presence.set(b.handle, runs);
      }
    }
  } catch {
    decodeErrors += 1;
  }
});

const perSecond: Row[] = [...rows.values()].sort((a, b) => a.s - b.s).map(({ bodySet, movingSet, ...r }) => ({
  ...r, bodies: bodySet.size, moving: movingSet.size, repeatBytes: Math.round(r.repeatBytes),
}));
const sum = (k: keyof Row) => perSecond.reduce((a, r) => a + (r[k] as number), 0);
const totals = {
  cityBytes: sum('cityBytes'), cityDatagrams: sum('cityDatagrams'), records: sum('records'), repeats: sum('repeats'),
  repeatBytes: sum('repeatBytes'), abs: sum('abs'), delta: sum('delta'), motion: sum('motion'), ballistic: sum('ballistic'),
  belowGroundRecords: sum('belowGround'), snapBytes: sum('snapBytes'), snapshots: sum('snapshots'), snapBodies: sum('snapBodies'),
  snapBodyRepeats: sum('snapBodyRepeats'),
  belowGroundBodies: belowBodies.size, bodyEntitiesSeen: lastRecord.size, decodeErrors,
};
writeFileSync(outPath, JSON.stringify({ durationMs: tape.header.durationMs, totals, perSecond, snapshotBodyPresence: Object.fromEntries(presence) }));
console.log(`stream: ${totals.records} city records, ${totals.repeats} repeats, ${totals.snapshots} snapshots, decode errors ${decodeErrors}`);
