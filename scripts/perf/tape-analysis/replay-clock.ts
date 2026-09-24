// Replays a tape through the CURRENT client netcode (NetcodeClient via
// ReplayNetWorld, its server-clock estimator, interpolation delays and
// interpolators) instead of reading the live client's recorded clock, and
// reconstructs per frame what the dynamic-body and player render clocks were
// and where each meteor was drawn. This is how a clock/interpolation change is
// judged against a recorded session: meteors.ts shows what the recording
// client drew; this shows what the code under test would have drawn from the
// same packets arriving at the same times.
//
//   (cd client && npx tsx ../scripts/perf/tape-analysis/replay-clock.ts <tape> <outdir> \
//        [--wasm <dir with vibe_land_shared.js + _bg.wasm>] [--legacy-meteors])
//
// --wasm         run the live (WASM) clock estimator from that wasm-pack output
//                instead of the TypeScript one (the live client uses WASM).
// --legacy-meteors  mirror the pre-2026-09-24 MeteorLayer choice (arc until a
//                body streams, then the body at render time, wall-clock 250 ms
//                stale rule) instead of calling `placeMeteor`. Use it to replay
//                an older client tree, which has no `meteorPlacement.ts`.
//
// Writes render_clock.csv and meteor_frames.csv in the formats analyse.py
// reads, player_clock.csv, and replay_summary.json with the headline metrics.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { decodeCityTape, inboundChannelOf, TAPE_CHANNEL_RTT } from '../../../client/src/city/cityTape';
import { ReplayNetWorld } from '../../../client/src/city/replayWorld';
import { isCityPacketKind } from '../../../client/src/city/wire';
import { SERVER_TICK_US } from '../../../client/src/net/protocol';
import { provideWasmClockSync } from '../../../client/src/net/interpolation';
import { decodeMeteorLaunched, meteorPositionAt, type MeteorLaunchedPacket } from '../../../client/src/vfx/meteorFlights';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--wasm'));
const [tapePath, outDir] = positional;
const wasmDir = args.includes('--wasm') ? args[args.indexOf('--wasm') + 1] : null;
const legacyMeteors = args.includes('--legacy-meteors');
mkdirSync(outDir, { recursive: true });

if (wasmDir) {
  const js = pathToFileURL(resolve(wasmDir, 'vibe_land_shared.js')).href;
  const mod = await import(js);
  mod.initSync({ module: readFileSync(resolve(wasmDir, 'vibe_land_shared_bg.wasm')) });
  provideWasmClockSync(mod.WasmClockSync);
}

type Placement = typeof import('../../../client/src/vfx/meteorPlacement');
const placementPath = resolve(import.meta.dirname, '../../../client/src/vfx/meteorPlacement.ts');
const placement: Placement | null = !legacyMeteors && existsSync(placementPath)
  ? await import(pathToFileURL(placementPath).href)
  : null;

const tape = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const f = tape.frames!;
let now = 0;
const world = new ReplayNetWorld(() => now);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = world.client;

type Flight = MeteorLaunchedPacket & {
  arrivalMs: number;
  launchedAtLocalMs: number;
  lastStreamedAtMs: number;
  lastDrawn: number[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  track: any;
};
const flights: Flight[] = [];
const rows = ['frame_t_ms,body,launch_t_ms,source,draw_x,draw_y,draw_z,arc_x,arc_y,arc_z,raw_x,raw_y,raw_z,raw_speed,rend_x,rend_y,rend_z,arc_t_s,sample_age_ms,lead_ms,render_dyn_us,latest_sample_us'];
const clockRows = ['t_ms,render_dyn_us,server_now_us,latest_snapshot_us,lead_ms,offset_us,dyn_ms'];
const playerRows = ['t_ms,render_player_us,latest_snapshot_us,lead_ms,interp_ms,x,y,z,srv_speed,self_lead_ms'];
let latestSnapshotUs = 0;
// Snapshot times are decoded on this tree's scale (protocol.ts SERVER_TICK_US).
const tickUs = SERVER_TICK_US;

let pi = 0;
for (let fi = 0; fi < f.times.length; fi++) {
  const ft = f.times[fi];
  while (pi < tape.packets.length && tape.times[pi] <= ft) {
    const bytes = tape.packets[pi];
    const ch = tape.channels[pi];
    now = tape.times[pi];
    if ((ch & 0x7f) === TAPE_CHANNEL_RTT) {
      world.observeRtt(new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, true));
    } else if (bytes[0] === 130) {
      const m = decodeMeteorLaunched(bytes)!;
      const existing = flights.findIndex((x) => x.bodyId === m.bodyId);
      if (existing >= 0) flights.splice(existing, 1);
      flights.push({
        ...m,
        arrivalMs: now,
        launchedAtLocalMs: world.serverToTapeMs(m.serverLaunchTimeUs),
        lastStreamedAtMs: 0,
        lastDrawn: null,
        track: placement ? placement.newMeteorTrack() : null,
      });
      if (flights.length > 8) flights.shift();
    } else if (!isCityPacketKind(bytes[0])) {
      const channel = inboundChannelOf(ch);
      if (channel) world.deliver(bytes, channel);
      if (bytes[0] === 112) latestSnapshotUs = client.latestServerTick * tickUs;
    }
    pi++;
  }
  now = ft;
  const renderDynUs: number = client.getDynamicBodyRenderTimeUs();
  const serverNowUs: number = client.serverClock.serverNowUs(ft * 1000);
  const dynMs: number = client.dynamicBodyInterpolationDelayMs;
  clockRows.push([ft.toFixed(2), renderDynUs.toFixed(0), serverNowUs.toFixed(0), latestSnapshotUs,
    ((renderDynUs - latestSnapshotUs) / 1000).toFixed(2), (serverNowUs - ft * 1000).toFixed(0), dynMs.toFixed(2)].join(','));

  const renderPlayerUs: number = client.getRenderTimeUs();
  // The own avatar (the camera, thin-authoritative): its own clock where the
  // client has one, the player clock otherwise (the pre-2026-09-24 client).
  const renderSelfUs: number = client.getLocalPlayerRenderTimeUs?.() ?? renderPlayerUs;
  const self = client.playerId ? client.interpolator.sample(client.playerId, renderSelfUs) : null;
  const srvSelf = client.playerId ? client.interpolator.byEntity?.get(client.playerId)?.at(-1) : null;
  playerRows.push([ft.toFixed(2), renderPlayerUs.toFixed(0), latestSnapshotUs,
    ((renderPlayerUs - latestSnapshotUs) / 1000).toFixed(2), client.interpolationDelayMs.toFixed(2),
    ...(self ? self.position.map((v: number) => v.toFixed(4)) : ['', '', '']),
    srvSelf ? Math.hypot(srvSelf.velocity[0], srvSelf.velocity[2]).toFixed(3) : '',
    ((renderSelfUs - latestSnapshotUs) / 1000).toFixed(2)].join(','));

  if (placement) {
    for (let i = flights.length - 1; i >= 0; i--) {
      if (placement.meteorFlightForgotten(flights[i] as never, ft, renderDynUs)) flights.splice(i, 1);
    }
  } else {
    for (let i = flights.length - 1; i >= 0; i--) {
      const fl = flights[i];
      const age = (ft - fl.launchedAtLocalMs) / 1000;
      const forgotten = fl.lastStreamedAtMs > 0 ? ft - fl.lastStreamedAtMs > 750 : age > fl.flightTimeS + 3;
      if (age > 60 || forgotten) flights.splice(i, 1);
    }
  }
  for (const fl of flights) {
    const raw = client.dynamicBodies.get(fl.bodyId) ?? null;
    const sUs: number | undefined = client.dynamicBodyServerTimeUs.get(fl.bodyId);
    const rawSpeed = raw ? Math.hypot(...(raw.velocity as [number, number, number])) : 0;
    const arcT = (renderDynUs - fl.serverLaunchTimeUs) / 1e6;
    const arc = meteorPositionAt(fl as never, arcT, [0, 0, 0]);
    let source: string;
    let drawn: number[];
    let rendered: number[] | null = null;
    let sampleAgeMs = 0;
    if (placement) {
      const placed = placement.placeMeteor(fl as never, fl.track, {
        renderServerUs: renderDynUs,
        samples: client.dynamicBodyInterpolator.samples(fl.bodyId),
        ticksSinceSeen: client.getDynamicBodyTicksSinceSeen(fl.bodyId),
        tickUs,
        nowMs: ft,
      });
      source = placed.source;
      drawn = [...placed.position];
      if (placed.source === 'body') rendered = drawn;
      sampleAgeMs = (client.getDynamicBodyTicksSinceSeen(fl.bodyId) ?? 0) * tickUs / 1000;
    } else {
      sampleAgeMs = raw && sUs != null ? Math.max(0, (serverNowUs - sUs) / 1000) : 0;
      const stale = raw !== null && sampleAgeMs > 250 && rawSpeed > 2;
      if (raw && !stale) {
        const s = client.sampleRemoteDynamicBody(fl.bodyId, renderDynUs);
        rendered = s ? s.position : raw.position;
      }
      if (rendered) { source = 'body'; drawn = rendered; fl.lastStreamedAtMs = ft; }
      else if (fl.lastStreamedAtMs > 0) { source = 'hold'; drawn = fl.lastDrawn ?? arc; }
      else if (arcT < 0) { source = 'hidden'; drawn = arc; }
      else { source = 'arc'; drawn = arc; }
      if (source !== 'hidden') fl.lastDrawn = drawn;
    }
    const n = (v: number[] | null) => (v ? v.map((x) => x.toFixed(3)) : ['', '', '']);
    rows.push([ft.toFixed(2), fl.bodyId, fl.arrivalMs.toFixed(1), source, ...n(drawn), ...n(arc),
      ...n(raw ? raw.position : null), rawSpeed.toFixed(2), ...n(rendered), arcT.toFixed(4), sampleAgeMs.toFixed(1),
      sUs != null ? ((renderDynUs - sUs) / 1000).toFixed(2) : '', renderDynUs.toFixed(0), sUs ?? ''].join(','));
  }
}
writeFileSync(`${outDir}/meteor_frames.csv`, rows.join('\n'));
writeFileSync(`${outDir}/render_clock.csv`, clockRows.join('\n'));
writeFileSync(`${outDir}/player_clock.csv`, playerRows.join('\n'));

// ---------------- headline metrics
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;
function clockStats(csv: string[], renderCol: number, leadCol: number) {
  const recs = csv.slice(1).map((l) => l.split(','));
  const render = recs.map((r) => Number(r[renderCol]));
  const lead = recs.map((r) => Number(r[leadCol]));
  const t = recs.map((r) => Number(r[0]));
  const back: number[] = [];
  for (let i = 1; i < render.length; i++) {
    const d = (render[i] - render[i - 1]) / 1000;
    if (d < 0) back.push(d);
  }
  // playout rate vs wall, per 5 s
  const rates: number[] = [];
  for (let s = 0; s < t[t.length - 1] / 1000; s += 5) {
    const idx = t.map((x, i) => [x, i]).filter(([x]) => x >= s * 1000 && x < (s + 5) * 1000).map(([, i]) => i);
    if (idx.length < 2) continue;
    const a = idx[0], b = idx[idx.length - 1];
    rates.push(Math.round(((render[b] - render[a]) / 1000 / (t[b] - t[a])) * 100) / 100);
  }
  return {
    backward_steps: back.length,
    backward_total_ms: r1(back.reduce((s, x) => s + x, 0)),
    worst_backward_ms: r1(Math.min(0, ...back)),
    share_frames_extrapolating: Math.round((lead.filter((x) => x > 0).length / lead.length) * 1000) / 1000,
    lead_ms_p50_p90_p95_p99_max: [50, 90, 95, 99, 100].map((p) => r1(pct(lead, p))),
    share_frames_lead_over_100ms: Math.round((lead.filter((x) => x > 100).length / lead.length) * 1000) / 1000,
    playout_rate_per_5s: rates,
  };
}
const dyn = clockStats(clockRows, 1, 4);
const player = clockStats(playerRows, 1, 3);
const selfLead = playerRows.slice(1).map((l) => Number(l.split(',')[9]));
const dynDelays = clockRows.slice(1).map((l) => Number(l.split(',')[6]));
const playerDelays = playerRows.slice(1).map((l) => Number(l.split(',')[4]));

// meteors, analyse.py's definitions: a frame moves "backward" when its
// displacement opposes the previous frame's by more than 0.3 m.
type Row = { t: number; body: number; launch: number; source: string; p: number[]; arc: number[]; raw: number[] | null };
const mrows: Row[] = rows.slice(1).map((l) => {
  const c = l.split(',');
  return {
    t: Number(c[0]), body: Number(c[1]), launch: Number(c[2]), source: c[3],
    p: [Number(c[4]), Number(c[5]), Number(c[6])],
    arc: [Number(c[7]), Number(c[8]), Number(c[9])],
    raw: c[10] !== '' ? [Number(c[10]), Number(c[11]), Number(c[12])] : null,
  };
});
const byFlight = new Map<string, Row[]>();
for (const r of mrows) {
  const k = `${r.body}@${r.launch}`;
  (byFlight.get(k) ?? byFlight.set(k, []).get(k)!).push(r);
}
let backwardFrames = 0, backwardOnArc = 0, maxBackward = 0, backwardTotal = 0, belowWhileServerAbove = 0, minDrawnY = Infinity;
let meteorsWithBackward = 0;
const handovers: Record<string, number[]> = {};
// The discontinuity at an arc->body switch: the body against the arc at the
// same render time (the step above also contains a frame of flight, ~2 m at
// 150 m/s and 72 fps).
const arcToBodyGaps: number[] = [];
for (const rs of byFlight.values()) {
  let prev: Row | null = null;
  let prevd: number[] | null = null;
  let lastBack = false;
  let any = false;
  for (const r of rs) {
    if (r.source === 'hidden') { prev = null; continue; }
    if (r.p[1] < minDrawnY) minDrawnY = r.p[1];
    if (r.source === 'body' && r.p[1] < -0.5 && r.raw && r.raw[1] >= 0) belowWhileServerAbove++;
    if (prev) {
      const d = [0, 1, 2].map((k) => r.p[k] - prev!.p[k]);
      const dist = Math.hypot(d[0], d[1], d[2]);
      let back = false;
      // The step right after a backward one is not judged: it is the rock
      // carrying on (counted twice before) or bouncing on (report.py).
      if (prevd && dist > 0.05 && !lastBack) {
        const pn = Math.hypot(prevd[0], prevd[1], prevd[2]);
        const along = pn > 0.05 ? (d[0] * prevd[0] + d[1] * prevd[1] + d[2] * prevd[2]) / pn : 0;
        if (along < -0.3) {
          backwardFrames++; any = true; backwardTotal += -along; maxBackward = Math.max(maxBackward, -along);
          if (r.source === 'arc') backwardOnArc++;
          back = true;
        }
      }
      if (r.source !== prev.source) (handovers[`${prev.source}>${r.source}`] ??= []).push(r1(dist));
      if (prev.source === 'arc' && r.source === 'body') {
        arcToBodyGaps.push(Math.round(Math.hypot(r.p[0] - r.arc[0], r.p[1] - r.arc[1], r.p[2] - r.arc[2]) * 100) / 100);
      }
      if (dist > 0.05) { lastBack = back; prevd = d; }
    }
    prev = r;
  }
  if (any) meteorsWithBackward++;
}
const hs = Object.fromEntries(Object.entries(handovers).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), max: Math.max(...v) }]));

// own avatar (spectated, interpolated at the player delay): per-frame speed vs
// the server's reported ground speed while moving.
const pr = playerRows.slice(1).map((l) => l.split(',').map(Number));
let moving = 0, frozen = 0, overshoot = 0, reversals = 0;
for (let i = 2; i < pr.length; i++) {
  const [t0, , , , , x0, , z0] = pr[i - 1];
  const [t1, , , , , x1, , z1, spd] = pr[i];
  const [, , , , , xm, , zm] = pr[i - 2];
  if (!Number.isFinite(x1) || !Number.isFinite(x0) || !Number.isFinite(spd) || spd < 1) continue;
  const dt = (t1 - t0) / 1000;
  if (dt <= 0) continue;
  moving++;
  const d = Math.hypot(x1 - x0, z1 - z0);
  if (d < 0.005) frozen++;
  if (d > 3 * spd * dt + 0.05) overshoot++;
  const dot = (x1 - x0) * (x0 - xm) + (z1 - z0) * (z0 - zm);
  if (dot < 0 && d > 0.02) reversals++;
}

const summary = {
  mode: { clock: wasmDir ? `wasm:${wasmDir}` : 'typescript', meteors: placement ? 'placeMeteor' : 'legacy-mirror' },
  frames: f.times.length,
  dynamic_body_render_clock: { ...dyn, delay_ms_p5_p50_p95: [5, 50, 95].map((p) => r1(pct(dynDelays, p))) },
  player_render_clock: { ...player, delay_ms_p5_p50_p95: [5, 50, 95].map((p) => r1(pct(playerDelays, p))) },
  own_avatar: {
    lead_ms_p50_p95_p99: [50, 95, 99].map((p) => r1(pct(selfLead, p))),
    share_frames_extrapolating: Math.round((selfLead.filter((x) => x > 0).length / selfLead.length) * 1000) / 1000,
    moving_frames: moving, frozen_share: r1((frozen / moving) * 1000) / 10, over_3x_share: r1((overshoot / moving) * 1000) / 10, reversal_share: r1((reversals / moving) * 1000) / 10 },
  meteors: {
    flights: byFlight.size,
    with_backward_frames: meteorsWithBackward,
    backward_frames: backwardFrames,
    backward_frames_on_arc: backwardOnArc,
    backward_total_m: r1(backwardTotal),
    max_backward_m: r1(maxBackward),
    handovers: hs,
    arc_to_body_gap_m: { n: arcToBodyGaps.length, p50: pct(arcToBodyGaps, 50), max: Math.max(0, ...arcToBodyGaps) },
    body_frames_below_ground_while_server_above: belowWhileServerAbove,
    min_drawn_y: r1(minDrawnY),
  },
};
writeFileSync(`${outDir}/replay_summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
