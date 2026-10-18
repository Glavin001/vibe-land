// Reconstructs, per recorded frame, what MeteorLayer drew for every meteor,
// using the real NetcodeClient decode + DynamicBodyInterpolator (via
// ReplayNetWorld) fed with the tape's packets at their arrival times, and the
// LIVE client's recorded clock (server-clock offset and dynamic-body
// interpolation delay, stored per frame in the v2 tape). The placement is the
// layer's own `placeMeteor` (client/src/vfx/meteorPlacement.ts: arc until a
// snapshot shows contact, then the body; stale after 15 ticks without it; a
// flight is forgotten on server time).
//
// --legacy-meteors mirrors the MeteorLayer of before 2026-09-24 instead (arc
// until a body streams, then the body at render time, 250 ms stale rule on the
// estimated server clock, lingers on the local clock): the logic the
// recording client of an older tape actually ran.
//   (cd client && npx tsx ../scripts/perf/tape-analysis/meteors.ts <tape> <outdir> [--legacy-meteors])
import { readFileSync, writeFileSync } from 'fs';
import { decodeCityTape, inboundChannelOf, tapeSnapshotTickUs, TAPE_CHANNEL_RTT } from '../../../client/src/city/cityTape';
import { SERVER_TICK_US } from '../../../client/src/net/protocol';
import { ReplayNetWorld } from '../../../client/src/city/replayWorld';
import {
  decodeMeteorLaunched,
  meteorFlightForgotten,
  meteorPositionAt,
  newMeteorTrack,
  type MeteorFlight,
  type MeteorLaunchedPacket,
  type MeteorTrack,
} from '../../../client/src/vfx/meteorFlights';
import { placeMeteor } from '../../../client/src/vfx/meteorPlacement';
import { sampleDynamicBodyTrack } from '../../../client/src/net/interpolation';
import { isCityPacketKind } from '../../../client/src/city/wire';

const legacy = process.argv.includes('--legacy-meteors');
const [tapePath, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const origin = tape.header.clockOriginMs!;
const f = tape.frames!;
// The recording client's clock samples are on its snapshot time scale; the
// packets are decoded here on this tree's (SERVER_TICK_US). Put the recorded
// clock on this tree's scale (a client before 2026-09-24 timed ticks as
// 16 667 us, the server 16 666).
const clockScale = SERVER_TICK_US / tapeSnapshotTickUs(tape.header);
let now = 0;
const world = new ReplayNetWorld(() => now);
const client: any = world.client;

type Flight = MeteorLaunchedPacket & { arrivalMs: number; launchedAtLocalMs: number; lastStreamedAtMs: number; lastDrawn: number[] | null; lastSource: string; seed: number; track: MeteorTrack };
const flights: Flight[] = [];
// body_x/y/z: the streamed body at this frame's render time, whatever was
// drawn (blank before its first snapshot): the rock's own motion, which the
// report sets a handover's step against.
const rows = ['frame_t_ms,body,launch_t_ms,source,draw_x,draw_y,draw_z,arc_x,arc_y,arc_z,raw_x,raw_y,raw_z,raw_speed,rend_x,rend_y,rend_z,arc_t_s,sample_age_ms,lead_ms,render_dyn_us,latest_sample_us,body_x,body_y,body_z'];
const rawRows = ['arrival_t_ms,body,server_us,tick,x,y,z,vx,vy,vz'];
const clockRows = ['t_ms,render_dyn_us,server_now_us,latest_snapshot_us,lead_ms,offset_us,dyn_ms'];
let latestSnapshotUs = 0;
const lastRawUs = new Map<number, number>();

let pi = 0;
for (let fi = 0; fi < f.times.length; fi++) {
  const ft = f.times[fi];
  // deliver every packet that arrived before this frame
  while (pi < tape.packets.length && tape.times[pi] <= ft) {
    const bytes = tape.packets[pi];
    const ch = tape.channels[pi];
    now = tape.times[pi];
    if ((ch & 0x7f) === TAPE_CHANNEL_RTT) {
      world.observeRtt(new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, true));
    } else if (bytes[0] === 130) {
      const m = decodeMeteorLaunched(bytes)!;
      // live: launchedAtLocalMs = serverToLocalMs(serverLaunchTimeUs) through the live offset
      const off = fi > 0 ? f.clock!.offsetUs[fi - 1] : f.clock!.offsetUs[0];
      const existing = flights.findIndex((x) => x.bodyId === m.bodyId);
      if (existing >= 0) flights.splice(existing, 1);
      flights.push({ ...m, arrivalMs: now, launchedAtLocalMs: (m.serverLaunchTimeUs / clockScale - off) / 1000, lastStreamedAtMs: 0, lastDrawn: null, lastSource: '', seed: 0, track: newMeteorTrack() });
      if (flights.length > 8) flights.shift();
    } else if (!isCityPacketKind(bytes[0])) {
      const channel = inboundChannelOf(ch);
      if (channel) world.deliver(bytes, channel);
      if (bytes[0] === 112) {
        latestSnapshotUs = client.latestServerTick * SERVER_TICK_US;
        for (const fl of flights) {
          const us = client.dynamicBodyServerTimeUs.get(fl.bodyId);
          const st = client.dynamicBodies.get(fl.bodyId);
          if (us != null && st && lastRawUs.get(fl.bodyId) !== us) {
            lastRawUs.set(fl.bodyId, us);
            rawRows.push([now.toFixed(2), fl.bodyId, us, Math.round(us / SERVER_TICK_US), ...st.position.map((v: number) => v.toFixed(3)), ...st.velocity.map((v: number) => v.toFixed(2))].join(','));
          }
        }
      }
    }
    pi++;
  }
  now = ft;
  const localMs = ft + origin;
  const offsetUs = f.clock!.offsetUs[fi];
  const dynMs = f.clock!.dynDelayMs[fi];
  const serverNowUs = (localMs * 1000 + offsetUs) * clockScale;
  const renderDynUs = serverNowUs - dynMs * 1000;
  clockRows.push([ft.toFixed(2), renderDynUs.toFixed(0), serverNowUs.toFixed(0), latestSnapshotUs, ((renderDynUs - latestSnapshotUs) / 1000).toFixed(2), offsetUs.toFixed(0), dynMs.toFixed(2)].join(','));

  // meteorFlights(nowMs[, renderServerUs]) sweep
  for (let i = flights.length - 1; i >= 0; i--) {
    const fl = flights[i];
    if (!legacy) {
      if (meteorFlightForgotten(fl as unknown as MeteorFlight, localMs, renderDynUs)) flights.splice(i, 1);
      continue;
    }
    const age = (localMs - fl.launchedAtLocalMs) / 1000;
    const forgotten = fl.lastStreamedAtMs > 0 ? localMs - fl.lastStreamedAtMs > 750 : age > fl.flightTimeS + 3;
    if (age > 60 || forgotten) flights.splice(i, 1);
  }
  for (const fl of flights) {
    if (!legacy) {
      const raw = client.dynamicBodies.get(fl.bodyId) ?? null;
      const sUs = client.dynamicBodyServerTimeUs.get(fl.bodyId);
      const ticksSinceSeen: number | null = client.getDynamicBodyTicksSinceSeen(fl.bodyId);
      const samples = client.getDynamicBodySamples(fl.bodyId);
      const bodyNow = samples.length > 0 && renderDynUs >= samples[0].serverTimeUs
        ? sampleDynamicBodyTrack(samples, Math.min(renderDynUs, samples[samples.length - 1].serverTimeUs + 250_000))
        : null;
      const placed = placeMeteor(fl as unknown as MeteorFlight, fl.track, {
        renderServerUs: renderDynUs,
        samples,
        ticksSinceSeen,
        tickUs: SERVER_TICK_US,
        nowMs: localMs,
      });
      if (placed.source === 'body') fl.lastStreamedAtMs = localMs;
      const rawSpeed = raw ? Math.hypot(...(raw.velocity as [number, number, number])) : 0;
      const n = (v: number[] | null) => (v ? v.map((x) => x.toFixed(3)) : ['', '', '']);
      const rendered = placed.source === 'body' ? placed.position : null;
      rows.push([ft.toFixed(2), fl.bodyId, fl.arrivalMs.toFixed(1), placed.source, ...n(placed.position), ...n(placed.arc), ...n(raw ? raw.position : null), rawSpeed.toFixed(2), ...n(rendered), ((renderDynUs - fl.serverLaunchTimeUs) / 1e6).toFixed(4), ((ticksSinceSeen ?? 0) * 1000 / 60).toFixed(1), sUs != null ? ((renderDynUs - sUs) / 1000).toFixed(2) : '', renderDynUs.toFixed(0), sUs ?? '', ...n(bodyNow ? bodyNow.position : null)].join(','));
      continue;
    }
    const raw = client.dynamicBodies.get(fl.bodyId) ?? null;
    const sUs = client.dynamicBodyServerTimeUs.get(fl.bodyId);
    const sampleAgeMs = raw && sUs != null ? Math.max(0, (serverNowUs - sUs) / 1000) : 0;
    const rawSpeed = raw ? Math.hypot(...(raw.velocity as [number, number, number])) : 0;
    const stale = raw !== null && sampleAgeMs > 250 && rawSpeed > 2;
    let rendered: number[] | null = null;
    if (raw && !stale) {
      const s = client.sampleRemoteDynamicBody(fl.bodyId, renderDynUs);
      rendered = s ? s.position : raw.position;
    }
    const arcT = (renderDynUs - fl.serverLaunchTimeUs) / 1e6;
    const arc = meteorPositionAt(fl as any, arcT, [0, 0, 0]);
    let source: string;
    let drawn: number[];
    if (rendered) { source = 'body'; drawn = rendered; fl.lastStreamedAtMs = localMs; }
    else if (fl.lastStreamedAtMs > 0) { source = 'hold'; drawn = fl.lastDrawn ?? arc; }
    else if (arcT < 0) { source = 'hidden'; drawn = arc; }
    else { source = 'arc'; drawn = arc; }
    if (source !== 'hidden') fl.lastDrawn = drawn;
    const n = (v: number[] | null) => (v ? v.map((x) => x.toFixed(3)) : ['', '', '']);
    rows.push([ft.toFixed(2), fl.bodyId, fl.arrivalMs.toFixed(1), source, ...n(drawn), ...n(arc), ...n(raw ? raw.position : null), rawSpeed.toFixed(2), ...n(rendered), arcT.toFixed(4), sampleAgeMs.toFixed(1), sUs != null ? ((renderDynUs - sUs) / 1000).toFixed(2) : '', renderDynUs.toFixed(0), sUs ?? ''].join(','));
  }
}
writeFileSync(`${outDir}/meteor_frames.csv`, rows.join('\n'));
writeFileSync(`${outDir}/meteor_raw.csv`, rawRows.join('\n'));
writeFileSync(`${outDir}/render_clock.csv`, clockRows.join('\n'));
console.log('meteor frame rows', rows.length - 1, 'raw', rawRows.length - 1);
