/**
 * Netlab per-frame recorder — window.__VIBE_RECORDER__
 *
 * A high-rate telemetry tap for netcode-quality measurement. The E2E bridge
 * (`window.__VIBE_E2E__`) returns one instantaneous sample per call, so polling
 * it from Playwright aliases the 30-60 Hz phenomena we are trying to measure --
 * a snapshot gap or a correction spike lasts a handful of frames and a 200 ms
 * poll walks straight past it. This records every frame into a preallocated ring
 * and lets the driver drain it in bulk.
 *
 * Inactive is the common case: `isRecording()` is a single boolean read, and
 * call sites are expected to guard on it so they do not even build the sample.
 */

export const FRAME_COLUMNS = [
  // time
  'tMs',
  'frameDeltaMs',
  // presented (rendered) local player
  'renderX',
  'renderY',
  'renderZ',
  'camYaw',
  'camPitch',
  // authoritative local player
  'authX',
  'authY',
  'authZ',
  'authVelX',
  'authVelY',
  'authVelZ',
  // sync / reconciliation
  'presOffX',
  'presOffY',
  'presOffZ',
  'presOffMag',
  'playerCorrectionM',
  'vehicleCorrectionM',
  'predictionTicks',
  // snapshots
  'serverTick',
  'snapshotsPerSec',
  'lastSnapshotGapMs',
  'staleSnapshotsDropped',
  'datagramSnapshotsReceived',
  'reliableSnapshotsReceived',
  // clock / transport
  'clockOffsetUs',
  'interpDelayMs',
  'dynInterpDelayMs',
  'pingMs',
  'jitterMs',
  // input
  'pendingInputs',
  // client performance
  'fps',
  'physicsStepMs',
  // flags (0/1)
  'onGround',
  'inVehicle',
  // observed remote player (observer role); NaN when none
  'remoteId',
  'remoteX',
  'remoteY',
  'remoteZ',
  'remoteCount',
  // Destructible city. Published at ~2 Hz by CityChunksLayer (the topology
  // scan is too expensive per frame), so these hold their last value between
  // updates — enough to correlate city load with frame and delivery timing.
  'cityChunksTotal',
  'cityChunksAwake',
  'cityChunksSettled',
  'cityBrokenBonds',
  'cityLiveIslands',
  'cityTopoSeqGaps',
  'cityBytesPerSecond',
  'cityDatagramsReceived',
  'cityChunkUpdateP95Ms',
  'cityOrphanedChunks',
  'cityChunksBelowGround',
  'cityMinChunkY',
  'cityStaleDrawnChunks',
  'cityFloatingSettledIslands',
  'cityLargestIslandChunks',
  'cityLargestIslandSpanM',
] as const;

export type FrameColumn = (typeof FRAME_COLUMNS)[number];

const COLUMN_COUNT = FRAME_COLUMNS.length;
const DEFAULT_MAX_FRAMES = 65536;
const DEFAULT_MAX_EVENTS = 8192;

export type RecorderEventType =
  | 'snapshot_received'
  | 'stale_drop'
  | 'correction'
  | 'hard_snap'
  | 'resync'
  | 'transport_change'
  | 'drive_cmd'
  | 'marker'
  | 'note'
  // Destructible-city pose anomalies. These fire per body, so a collapse can
  // produce thousands per second; every one goes through recordCityEvent,
  // which caps the rate per type and counts what it suppressed.
  | 'city_clock_rollback'
  | 'city_snap'
  | 'city_implausible_jump'
  | 'city_flicker'
  | 'city_chunk_teleport'
  | 'city_membership'
  | 'city_migrate_anomaly'
  | 'city_settle_rollback'
  | 'city_frame_diag'
  | 'city_adoption_jump'
  | 'city_seed'
  | 'city_suspect_record';

export interface RecorderEvent {
  /** performance.now() at emit. */
  tMs: number;
  /** Monotonic across the whole session, so drains can resume without overlap. */
  seq: number;
  type: RecorderEventType;
  data: Record<string, unknown>;
}

/**
 * One frame of telemetry. Callers pass the objects they already hold for that
 * frame; the recorder copies scalars out and retains nothing.
 */
export interface RecorderFrameSample {
  tMs: number;
  frameDeltaMs: number;
  renderedPosition: readonly number[];
  authoritativePosition: readonly number[];
  authoritativeVelocity: readonly number[];
  camYaw: number;
  camPitch: number;
  stats: RecorderStatsInput;
  /** Active transport name; a change mid-run emits a `transport_change` event. */
  transport?: string;
  remote?: { id: number; position: readonly number[] } | null;
  remoteCount?: number;
}

/** The subset of DebugStats the recorder reads. Structurally satisfied by DebugStats. */
export interface RecorderStatsInput {
  fps: number;
  pingMs: number;
  serverTick: number;
  interpolationDelayMs: number;
  dynamicBodyInterpolationDelayMs: number;
  clockOffsetUs: number;
  snapshotsPerSec: number;
  jitterMs: number;
  lastSnapshotGapMs: number;
  staleSnapshotsDropped: number;
  reliableSnapshotsReceived: number;
  datagramSnapshotsReceived: number;
  pendingInputs: number;
  predictionTicks: number;
  playerCorrectionMagnitude: number;
  vehicleCorrectionMagnitude: number;
  physicsStepMs: number;
  onGround: boolean;
  inVehicle: boolean;
}

export interface DrainedFrames {
  schema: readonly string[];
  /** Absolute index of the first returned row. */
  fromIndex: number;
  /** Absolute index the caller should request next. */
  nextIndex: number;
  /** Frames overwritten before the caller could read them. Must stay 0. */
  lostFrames: number;
  rows: number[][];
}

export interface DrainedEvents {
  fromSeq: number;
  nextSeq: number;
  lostEvents: number;
  events: RecorderEvent[];
}

export interface RecorderClockInfo {
  perfNowMs: number;
  dateNowMs: number;
  timeOriginMs: number;
}

export interface RecorderStopResult {
  frames: number;
  events: number;
  droppedFrames: number;
  droppedEvents: number;
}

export interface VibeRecorderBridge {
  version: number;
  start(opts?: { maxFrames?: number; maxEvents?: number; cityEventsPerSecond?: number }): void;
  stop(): RecorderStopResult;
  active(): boolean;
  mark(label: string, data?: Record<string, unknown>): void;
  drainFrames(fromIndex: number, max: number): DrainedFrames;
  drainEvents(fromSeq: number, max: number): DrainedEvents;
  clockInfo(): RecorderClockInfo;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let recording = false;
let columns: Float64Array[] = [];
let capacity = 0;
/** Total frames ever written this session; also the absolute index of the next write. */
let frameCount = 0;
/** Frames overwritten before being drained. */
let droppedFrames = 0;

let eventRing: (RecorderEvent | undefined)[] = [];
let eventCapacity = 0;
let eventCount = 0;
let droppedEvents = 0;
let lastTransport: string | null = null;

/** Latest city stats, pushed by CityChunksLayer at its own cadence. */
export interface RecorderCityStats {
  wireVersion: number;
  chunksTotal: number;
  chunksAwake: number;
  chunksSettled: number;
  brokenBonds: number;
  liveIslands: number;
  topoSeqGaps: number;
  bytesPerSecond: number;
  datagramsReceived: number;
  chunkUpdateP95Ms: number;
  orphanedChunks: number;
  chunksBelowGround: number;
  minChunkY: number;
  /** Slots whose drawn pose disagrees with the ledger — a stale screen. */
  staleDrawnChunks: number;
  /** Settled islands hovering with no support beneath — physics verdict data. */
  floatingSettledIslands: number;
  /** Chunk count of the biggest live island: does sustained fire break it down? */
  largestIslandChunks: number;
  /** Longest AABB edge of the biggest island — what the player perceives as a monolith. */
  largestIslandSpanM: number;
}

let cityStats: RecorderCityStats | null = null;

/**
 * Publish the latest destructible-city stats. Cheap (a field copy); the caller
 * decides the cadence. No-op while inactive.
 */
export function recordCityStats(stats: RecorderCityStats): void {
  if (!recording) return;
  cityStats = stats;
}

/**
 * Rate-capped city-anomaly emitter.
 *
 * A collapse can trip the same anomaly on thousands of bodies in one frame.
 * Recording every instance would drown the ring and starve every other event
 * type, so each type gets a per-second budget and the analyzer reads the true
 * total from `totals` — the counts stay exact even when the samples are thinned.
 */
let cityEventsPerSecond = 40;

interface CityEventBudget {
  windowStartMs: number;
  emitted: number;
  suppressed: number;
  total: number;
}

const cityEventBudgets = new Map<RecorderEventType, CityEventBudget>();

export function recordCityEvent(
  type: RecorderEventType,
  data: Record<string, unknown> = {},
): void {
  if (!recording) return;
  const nowMs = performance.now();
  let budget = cityEventBudgets.get(type);
  if (!budget) {
    budget = { windowStartMs: nowMs, emitted: 0, suppressed: 0, total: 0 };
    cityEventBudgets.set(type, budget);
  }
  if (nowMs - budget.windowStartMs >= 1000) {
    budget.windowStartMs = nowMs;
    budget.emitted = 0;
  }
  budget.total += 1;
  if (budget.emitted >= cityEventsPerSecond) {
    budget.suppressed += 1;
    return;
  }
  budget.emitted += 1;
  recordEvent(type, data);
}

/**
 * Bodies under suspicion: once a detector sees a body misbehave repeatedly,
 * its raw applied records get logged verbatim so the wire stream itself can be
 * inspected — the difference between "the client mangles the pose" and "the
 * server sends two trajectories under one id" is only visible there.
 */
const citySuspects = new Set<number>();

export function addCitySuspect(key: number): void {
  if (recording && citySuspects.size < 8) citySuspects.add(key);
}

export function isCitySuspect(key: number): boolean {
  return recording && citySuspects.has(key);
}

/** Exact per-type totals, including instances the rate cap suppressed. */
export function cityEventTotals(): Record<string, { total: number; suppressed: number }> {
  const out: Record<string, { total: number; suppressed: number }> = {};
  for (const [type, budget] of cityEventBudgets) {
    out[type] = { total: budget.total, suppressed: budget.suppressed };
  }
  return out;
}

function allocate(maxFrames: number, maxEvents: number): void {
  capacity = maxFrames;
  columns = FRAME_COLUMNS.map(() => new Float64Array(maxFrames));
  frameCount = 0;
  droppedFrames = 0;
  eventCapacity = maxEvents;
  eventRing = new Array<RecorderEvent | undefined>(maxEvents);
  eventCount = 0;
  droppedEvents = 0;
  lastTransport = null;
  cityStats = null;
  cityEventBudgets.clear();
  citySuspects.clear();
}

/**
 * True when frames are being captured.
 *
 * Call sites guard on this so an idle session pays one boolean read per frame
 * rather than building a sample object that is thrown away.
 */
export function isRecording(): boolean {
  return recording;
}

function vec(v: readonly number[] | undefined, i: number): number {
  const value = v?.[i];
  return typeof value === 'number' ? value : Number.NaN;
}

/** Record one frame. No-op unless recording. */
export function recordFrame(sample: RecorderFrameSample): void {
  if (!recording) return;

  // A silent fall back to WebSocket changes which layer is under test, so the
  // analyzer has to know exactly when it happened.
  if (sample.transport != null && sample.transport !== lastTransport) {
    const from = lastTransport;
    lastTransport = sample.transport;
    if (from != null) recordEvent('transport_change', { from, to: sample.transport });
  }

  const slot = frameCount % capacity;
  if (frameCount >= capacity) droppedFrames += 1;

  const s = sample.stats;
  const rx = vec(sample.renderedPosition, 0);
  const ry = vec(sample.renderedPosition, 1);
  const rz = vec(sample.renderedPosition, 2);
  const ax = vec(sample.authoritativePosition, 0);
  const ay = vec(sample.authoritativePosition, 1);
  const az = vec(sample.authoritativePosition, 2);
  const ox = rx - ax;
  const oy = ry - ay;
  const oz = rz - az;

  let i = 0;
  const c = columns;
  c[i++][slot] = sample.tMs;
  c[i++][slot] = sample.frameDeltaMs;
  c[i++][slot] = rx;
  c[i++][slot] = ry;
  c[i++][slot] = rz;
  c[i++][slot] = sample.camYaw;
  c[i++][slot] = sample.camPitch;
  c[i++][slot] = ax;
  c[i++][slot] = ay;
  c[i++][slot] = az;
  c[i++][slot] = vec(sample.authoritativeVelocity, 0);
  c[i++][slot] = vec(sample.authoritativeVelocity, 1);
  c[i++][slot] = vec(sample.authoritativeVelocity, 2);
  c[i++][slot] = ox;
  c[i++][slot] = oy;
  c[i++][slot] = oz;
  c[i++][slot] = Math.sqrt(ox * ox + oy * oy + oz * oz);
  c[i++][slot] = s.playerCorrectionMagnitude;
  c[i++][slot] = s.vehicleCorrectionMagnitude;
  c[i++][slot] = s.predictionTicks;
  c[i++][slot] = s.serverTick;
  c[i++][slot] = s.snapshotsPerSec;
  c[i++][slot] = s.lastSnapshotGapMs;
  c[i++][slot] = s.staleSnapshotsDropped;
  c[i++][slot] = s.datagramSnapshotsReceived;
  c[i++][slot] = s.reliableSnapshotsReceived;
  c[i++][slot] = s.clockOffsetUs;
  c[i++][slot] = s.interpolationDelayMs;
  c[i++][slot] = s.dynamicBodyInterpolationDelayMs;
  c[i++][slot] = s.pingMs;
  c[i++][slot] = s.jitterMs;
  c[i++][slot] = s.pendingInputs;
  c[i++][slot] = s.fps;
  c[i++][slot] = s.physicsStepMs;
  c[i++][slot] = s.onGround ? 1 : 0;
  c[i++][slot] = s.inVehicle ? 1 : 0;
  const remote = sample.remote;
  c[i++][slot] = remote ? remote.id : Number.NaN;
  c[i++][slot] = remote ? vec(remote.position, 0) : Number.NaN;
  c[i++][slot] = remote ? vec(remote.position, 1) : Number.NaN;
  c[i++][slot] = remote ? vec(remote.position, 2) : Number.NaN;
  c[i++][slot] = sample.remoteCount ?? 0;
  const city = cityStats;
  c[i++][slot] = city ? city.chunksTotal : Number.NaN;
  c[i++][slot] = city ? city.chunksAwake : Number.NaN;
  c[i++][slot] = city ? city.chunksSettled : Number.NaN;
  c[i++][slot] = city ? city.brokenBonds : Number.NaN;
  c[i++][slot] = city ? city.liveIslands : Number.NaN;
  c[i++][slot] = city ? city.topoSeqGaps : Number.NaN;
  c[i++][slot] = city ? city.bytesPerSecond : Number.NaN;
  c[i++][slot] = city ? city.datagramsReceived : Number.NaN;
  c[i++][slot] = city ? city.chunkUpdateP95Ms : Number.NaN;
  c[i++][slot] = city ? city.orphanedChunks : Number.NaN;
  c[i++][slot] = city ? city.chunksBelowGround : Number.NaN;
  c[i++][slot] = city ? city.minChunkY : Number.NaN;
  c[i++][slot] = city ? city.staleDrawnChunks : Number.NaN;
  c[i++][slot] = city ? city.floatingSettledIslands : Number.NaN;
  c[i++][slot] = city ? city.largestIslandChunks : Number.NaN;
  c[i++][slot] = city ? city.largestIslandSpanM : Number.NaN;

  frameCount += 1;
}

/** Record a discrete event. No-op unless recording. */
export function recordEvent(type: RecorderEventType, data: Record<string, unknown> = {}): void {
  if (!recording) return;
  const slot = eventCount % eventCapacity;
  if (eventCount >= eventCapacity) droppedEvents += 1;
  eventRing[slot] = {
    tMs: performance.now(),
    seq: eventCount,
    type,
    data,
  };
  eventCount += 1;
}

function start(opts?: { maxFrames?: number; maxEvents?: number; cityEventsPerSecond?: number }): void {
  cityEventsPerSecond = Math.max(1, Math.floor(opts?.cityEventsPerSecond ?? 40));
  allocate(
    Math.max(1, Math.floor(opts?.maxFrames ?? DEFAULT_MAX_FRAMES)),
    Math.max(1, Math.floor(opts?.maxEvents ?? DEFAULT_MAX_EVENTS)),
  );
  recording = true;
}

function stop(): RecorderStopResult {
  // Emit the exact totals before flipping the flag, so counts thinned by the
  // rate cap are still recoverable from the artifacts.
  const totals = cityEventTotals();
  if (Object.keys(totals).length > 0) {
    recordEvent('note', { cityEventTotals: totals });
  }
  recording = false;
  return { frames: frameCount, events: eventCount, droppedFrames, droppedEvents };
}

function drainFrames(fromIndex: number, max: number): DrainedFrames {
  const oldestAvailable = Math.max(0, frameCount - capacity);
  const lostFrames = Math.max(0, oldestAvailable - Math.max(0, fromIndex));
  const start = Math.max(fromIndex, oldestAvailable);
  const end = Math.min(frameCount, start + Math.max(0, max));
  const rows: number[][] = [];
  for (let idx = start; idx < end; idx += 1) {
    const slot = idx % capacity;
    const row = new Array<number>(COLUMN_COUNT);
    for (let col = 0; col < COLUMN_COUNT; col += 1) {
      row[col] = columns[col][slot];
    }
    rows.push(row);
  }
  return {
    schema: FRAME_COLUMNS,
    fromIndex: start,
    nextIndex: end,
    lostFrames,
    rows,
  };
}

function drainEvents(fromSeq: number, max: number): DrainedEvents {
  const oldestAvailable = Math.max(0, eventCount - eventCapacity);
  const lostEvents = Math.max(0, oldestAvailable - Math.max(0, fromSeq));
  const start = Math.max(fromSeq, oldestAvailable);
  const end = Math.min(eventCount, start + Math.max(0, max));
  const events: RecorderEvent[] = [];
  for (let seq = start; seq < end; seq += 1) {
    const ev = eventRing[seq % eventCapacity];
    if (ev && ev.seq === seq) events.push(ev);
  }
  return { fromSeq: start, nextSeq: end, lostEvents, events };
}

function clockInfo(): RecorderClockInfo {
  return {
    perfNowMs: performance.now(),
    dateNowMs: Date.now(),
    timeOriginMs: typeof performance.timeOrigin === 'number' ? performance.timeOrigin : Number.NaN,
  };
}

/**
 * Flash a high-contrast overlay for two frames.
 *
 * The screencast recorder and the telemetry ring run on different clocks; the
 * flash is the fixed point that ties them together, so a marker is locatable in
 * the video without trusting either clock's epoch.
 */
function flashMarker(): void {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.setAttribute('data-netlab-marker', '1');
  el.style.cssText =
    'position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none;opacity:1';
  document.body.appendChild(el);
  let frames = 0;
  const tick = (): void => {
    frames += 1;
    if (frames >= 2) {
      el.remove();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function mark(label: string, data: Record<string, unknown> = {}): void {
  recordEvent('marker', { label, ...data });
  flashMarker();
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __VIBE_RECORDER__?: VibeRecorderBridge;
  }
}

const bridge: VibeRecorderBridge = {
  version: 1,
  start,
  stop,
  active: isRecording,
  mark,
  drainFrames,
  drainEvents,
  clockInfo,
};

if (typeof window !== 'undefined') {
  window.__VIBE_RECORDER__ = bridge;
}

export const __testing = { bridge, reset: (): void => { recording = false; allocate(16, 8); } };
