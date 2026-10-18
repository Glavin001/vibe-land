// Decodes a VLTAPE02 with the client's own decoders and writes flat CSV/JSON
// tables for the Python analysis (analyse.py).
//   (cd client && npx tsx ../scripts/perf/tape-analysis/decode.ts <tape> <outdir>)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { decodeCityTape, tapeChannelName } from '../../../client/src/city/cityTape';
import { decodeServerDatagramPacket, decodeServerReliablePacket } from '../../../client/src/net/protocol';
import {
  decodeBaseline,
  decodeBootstrap,
  decodeChunksDatagram,
  decodeStructureBootstrap,
  decodeTopology,
  decodeTopologyHashes,
} from '../../../client/src/city/wire';
import { decodeMeteorLaunched } from '../../../client/src/vfx/meteorFlights';
import { decodeMatchStatsPacket } from '../../../client/src/net/matchStatsFrame';

const [tapePath, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
writeFileSync(`${outDir}/header.json`, JSON.stringify(tape.header, null, 1));

// ---- frames
{
  const f = tape.frames!;
  // gpu_ms / gpu_max_pass_ms: the frame's own GPU time (tapes since
  // 2026-09-24; header.gpuTimer says whether the browser could measure it).
  // Empty where the frame has none, or the tape predates them.
  const gpuCell = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '' : v.toFixed(3));
  const rows = ['t_ms,frame_ms,cpu_ms,awake,cx,cy,cz,qx,qy,qz,qw,offset_us,interp_ms,dyn_ms,gpu_ms,gpu_max_pass_ms'];
  for (let i = 0; i < f.times.length; i++) {
    const c = f.camera.subarray(i * 7, i * 7 + 7);
    rows.push([
      f.times[i].toFixed(2), f.frameMs[i].toFixed(3), f.cpuMs[i].toFixed(3), f.awake[i],
      ...Array.from(c, (v) => v.toFixed(4)),
      f.clock ? f.clock.offsetUs[i].toFixed(0) : '', f.clock ? f.clock.interpDelayMs[i].toFixed(2) : '',
      f.clock ? f.clock.dynDelayMs[i].toFixed(2) : '',
      gpuCell(f.gpu?.ms[i]), gpuCell(f.gpu?.maxPassMs[i]),
    ].join(','));
  }
  writeFileSync(`${outDir}/frames.csv`, rows.join('\n'));
}

// ---- packets
const pk = ['t_ms,channel,kind,len,tick,info'];
const snaps = ['t_ms,tick,ack,ax,ay,az,vx,vy,vz,yaw,pitch,hp,flags,remote,spheres,boxes,vehicles,veh_driver,box_max_speed'];
const chunks = ['t_ms,seq,baseline,tick,records,abs,delta,motion_abs,motion_delta,ballistic,len'];
const topo: any[] = [];
const events: any[] = [];
let errors = 0;
tape.packets.forEach((p, i) => {
  const t = tape.times[i];
  const ch = tapeChannelName(tape.channels[i]);
  const kind = p[0];
  let tick: number | string = '';
  let info = '';
  try {
    if (kind === 112 || kind === 102) {
      const s: any = decodeServerDatagramPacket(p);
      tick = s.serverTick;
      const self = s.selfState;
      let boxMax = 0;
      for (const b of s.boxStates) boxMax = Math.max(boxMax, Math.hypot(b.vxCms, b.vyCms, b.vzCms) / 100);
      for (const b of s.sphereStates) boxMax = Math.max(boxMax, Math.hypot(b.vxCms, b.vyCms, b.vzCms) / 100);
      const drv = s.vehicleStates.map((v: any) => v.driverHandle).join('|');
      snaps.push([t.toFixed(2), s.serverTick, s.ackInputSeq, s.anchorPxMm / 1000, s.anchorPyMm / 1000, s.anchorPzMm / 1000,
        self.vxCms / 100, self.vyCms / 100, self.vzCms / 100, self.yawI16, self.pitchI16, self.hp, self.flags,
        s.remotePlayers.length, s.sphereStates.length, s.boxStates.length, s.vehicleStates.length, drv, boxMax.toFixed(2)].join(','));
    } else if (kind === 119) {
      const c = decodeChunksDatagram(p);
      tick = c.simTick;
      const m = [0, 0, 0, 0, 0];
      for (const r of c.records) m[r.mode]++;
      chunks.push([t.toFixed(2), c.sequence, c.baselineId, c.simTick, c.records.length, ...m, p.length].join(','));
    } else if (kind === 120) {
      const m = decodeTopology(p);
      tick = m.simTick;
      let broken = 0, promos = 0, promoNodes = 0, retired = 0, migr = 0;
      for (const b of m.batches) { broken += b.brokenBondIndices.length; promos += b.promotions.length; retired += b.retiredIslandIds.length; migr += b.migrations.length; for (const pr of b.promotions) promoNodes += pr.nodes.length; }
      topo.push({ t, topoSeq: m.topoSeq, tick: m.simTick, len: p.length, batches: m.batches.length, structures: m.batches.map((b) => b.structureId), broken, promos, promoNodes, retired, migr, settled: m.settled.length, wakes: m.wakes.length });
    } else if (kind === 121) {
      const b = decodeBaseline(p);
      tick = b.simTick;
      info = `baseline=${b.baselineId} part=${b.partIndex}/${b.partCount} records=${b.records.length}`;
      events.push({ t, kind, baselineId: b.baselineId, tick: b.simTick, part: b.partIndex, parts: b.partCount, records: b.records.length, len: p.length });
    } else if (kind === 122 || kind === 129) {
      const b = kind === 122 ? decodeBootstrap(p) : decodeStructureBootstrap(p);
      tick = b.simTick;
      info = `structures=${b.structures.map((s) => s.structureId).join('|')} islands=${b.islands.length} topoSeq=${b.topoSeq}`;
      events.push({ t, kind, tick: b.simTick, topoSeq: b.topoSeq, structures: b.structures.map((s) => s.structureId), islands: b.islands.length, len: p.length });
    } else if (kind === 128) {
      const h = decodeTopologyHashes(p);
      info = `topoSeq=${h.topoSeq} n=${h.hashes.length}`;
      events.push({ t, kind, topoSeq: h.topoSeq, n: h.hashes.length });
    } else if (kind === 130) {
      const m = decodeMeteorLaunched(p)!;
      info = `body=${m.bodyId} target=${m.target.map((v) => v.toFixed(1)).join('|')} flight=${m.flightTimeS.toFixed(2)}`;
      events.push({ t, kind, ...m });
    } else if (kind === 124) {
      tick = (decodeMatchStatsPacket(p)?.server_tick as number | undefined) ?? '';
    } else if (kind === 113 || kind === 115 || kind === 101 || kind === 114 || kind === 116 || kind === 117 || kind === 103 || kind === 118) {
      const r: any = decodeServerReliablePacket(p);
      if (kind === 115) info = `energy=${r.energyCenti}`;
      else if (kind === 113) info = `roster=${r.entries.map((e: any) => `${e.handle}:${e.playerId}`).join('|')}`;
      else info = r.type;
      if (kind !== 115) events.push({ t, kind, packet: r });
    }
  } catch (e) {
    errors++;
    info = `DECODE_ERROR ${(e as Error).message}`;
  }
  pk.push([t.toFixed(2), ch, kind, p.length, tick, JSON.stringify(info)].join(','));
});
writeFileSync(`${outDir}/packets.csv`, pk.join('\n'));
writeFileSync(`${outDir}/snapshots.csv`, snaps.join('\n'));
writeFileSync(`${outDir}/chunks.csv`, chunks.join('\n'));
writeFileSync(`${outDir}/topology.json`, JSON.stringify(topo));
writeFileSync(`${outDir}/events.json`, JSON.stringify(events));
console.log(`packets=${tape.packets.length} frames=${tape.frames?.times.length} decodeErrors=${errors}`);
