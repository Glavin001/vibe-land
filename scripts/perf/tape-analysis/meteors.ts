// Reconstructs, per recorded frame, what MeteorLayer drew for every meteor,
// using the real NetcodeClient decode + DynamicBodyInterpolator (via
// ReplayNetWorld) fed with the tape's packets at their arrival times, and the
// LIVE client's recorded clock (server-clock offset and dynamic-body
// interpolation delay, stored per frame in the v2 tape). The MeteorLayer
// source logic (arc / body / hold / hidden, 250 ms stale rule, 0.75 s
// unstreamed linger, 3 s landed linger) is mirrored here.
//   (cd client && npx tsx ../scripts/perf/tape-analysis/meteors.ts <tape> <outdir>)
import { readFileSync, writeFileSync } from 'fs';
import { decodeCityTape, inboundChannelOf, TAPE_CHANNEL_RTT } from '../../../client/src/city/cityTape';
import { ReplayNetWorld } from '../../../client/src/city/replayWorld';
import { decodeMeteorLaunched, meteorPositionAt, type MeteorLaunchedPacket } from '../../../client/src/vfx/meteorFlights';
import { isCityPacketKind } from '../../../client/src/city/wire';

const [tapePath, outDir] = process.argv.slice(2);
const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const origin = tape.header.clockOriginMs!;
const f = tape.frames!;
let now = 0;
const world = new ReplayNetWorld(() => now);
const client: any = world.client;

type Flight = MeteorLaunchedPacket & { arrivalMs: number; launchedAtLocalMs: number; lastStreamedAtMs: number; lastDrawn: number[] | null; lastSource: string };
const flights: Flight[] = [];
const rows = ['frame_t_ms,body,launch_t_ms,source,draw_x,draw_y,draw_z,arc_x,arc_y,arc_z,raw_x,raw_y,raw_z,raw_speed,rend_x,rend_y,rend_z,arc_t_s,sample_age_ms,lead_ms,render_dyn_us,latest_sample_us'];
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
      flights.push({ ...m, arrivalMs: now, launchedAtLocalMs: (m.serverLaunchTimeUs - off) / 1000, lastStreamedAtMs: 0, lastDrawn: null, lastSource: '' });
      if (flights.length > 8) flights.shift();
    } else if (!isCityPacketKind(bytes[0])) {
      const channel = inboundChannelOf(ch);
      if (channel) world.deliver(bytes, channel);
      if (bytes[0] === 112) {
        latestSnapshotUs = client.latestServerTick * Math.round(1_000_000 / 60);
        for (const fl of flights) {
          const us = client.dynamicBodyServerTimeUs.get(fl.bodyId);
          const st = client.dynamicBodies.get(fl.bodyId);
          if (us != null && st && lastRawUs.get(fl.bodyId) !== us) {
            lastRawUs.set(fl.bodyId, us);
            rawRows.push([now.toFixed(2), fl.bodyId, us, Math.round(us / 16667), ...st.position.map((v: number) => v.toFixed(3)), ...st.velocity.map((v: number) => v.toFixed(2))].join(','));
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
  const serverNowUs = localMs * 1000 + offsetUs;
  const renderDynUs = serverNowUs - dynMs * 1000;
  clockRows.push([ft.toFixed(2), renderDynUs.toFixed(0), serverNowUs.toFixed(0), latestSnapshotUs, ((renderDynUs - latestSnapshotUs) / 1000).toFixed(2), offsetUs.toFixed(0), dynMs.toFixed(2)].join(','));

  // meteorFlights(nowMs) sweep, on the live local clock
  for (let i = flights.length - 1; i >= 0; i--) {
    const fl = flights[i];
    const age = (localMs - fl.launchedAtLocalMs) / 1000;
    const forgotten = fl.lastStreamedAtMs > 0 ? localMs - fl.lastStreamedAtMs > 750 : age > fl.flightTimeS + 3;
    if (age > 60 || forgotten) flights.splice(i, 1);
  }
  for (const fl of flights) {
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
