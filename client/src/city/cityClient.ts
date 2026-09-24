// CityClient: owns the manifest, topology ledger, baseline store, and
// per-body presentation tracks. Raw city packets (kinds 119-122) are routed
// here by the transport layer; the render layer reads `sampleBodies` each
// frame and composes chunk matrices.

import type { LoadedCityManifest } from './manifest';
import {
  MotionSnapshot,
  PresentationClass,
  PresentationTrack,
  presentationConfig60Hz,
} from './presentation';
import { CityTopology, bodyKey, bodyKeyParts, type LedgerBody } from './topology';
import type { Quat, Vec3 } from './vec';
import { qRotate, vAdd } from './vec';
import {
  BaselineMessage,
  ChunksDatagram,
  TopologyMessage,
  type TopologyPart,
  RECORD_FLAG_SETTLED_HINT,
  RecordMode,
  decodeBaseline,
  decodeBootstrap,
  decodeChunksDatagram,
  decodeStructureBootstrap,
  decodeTopology,
  decodeTopologyHashes,
  encodeCityResyncRequest,
  decodeCityLanes,
  decodeDebrisHeader,
  encodeCityNack,
  PKT_CITY_LANES,
  PKT_CITY_STRUCTURE_BOOTSTRAP,
  PKT_CITY_TOPO_HASH,
} from './wire';
import type { DebrisDecoder } from './debrisWasm';
import {
  PKT_CITY_BASELINE,
  PKT_CITY_BOOTSTRAP,
  PKT_CITY_CHUNKS,
  PKT_CITY_DEBRIS,
  PKT_CITY_NACK,
  PKT_CITY_TOPOLOGY,
} from '../net/sharedConstants';
import { isCitySuspect, isRecording, recordCityEvent } from '../netlab/recorder';
import { noteBaseline, noteClientEvent, noteFracture } from './debugReport';
import { addDecodeMs } from './renderStats';
import {
  DustSourceQueue,
  dustExtractStats,
  extractDustSources,
  type DustExtractContext,
  type DustSource,
} from './destructionEvents';
import { dustEnabled } from './dustSettings';
import { DustImpactDetector } from './dustImpacts';
import { matchDustShot } from '../vfx/dustShots';

export interface CityClientStats {
  chunksTotal: number;
  chunksAwake: number;
  chunksSettled: number;
  brokenBonds: number;
  orphanedChunks: number;
  orphanedByRetire: number;
  /** Streamed pose writes larger than the stream can account for: teleports. */
  poseJumpsOver1m: number;
  poseJumpsOver4m: number;
  poseJumpsOver16m: number;
  poseJumpMaxM: number;
  /** The same, on the writer the renderer reads. See CityTopology. */
  presentedJumpsOver1m: number;
  presentedJumpsOver4m: number;
  presentedJumpMaxM: number;
  reoffsets: number;
  reoffsetMetres: number;
  adoptionJumps: number;
  adoptionJumpMaxM: number;
  adoptionJumpMetres: number;
  adoptionJumpsFromMigration: number;
  adoptionJumpMetresFromMigration: number;
  presentedJumpChunks: number;
  presentedJumpWorstChunks: number;
  presentedJumpWorstChunksM: number;
  /// Discontinuities the presentation layer produced on purpose, by kind.
  /// See PresentationAnomalyKind: a correction too large to glide, a render
  /// clock that moved backwards, or two snapshots too far apart to interpolate.
  correctionSnaps: number;
  clockRollbacks: number;
  implausibleJumps: number;
  presentationAnomalyMaxM: number;
  /// Streamed poses refused for being outside the world. Must be 0.
  recordsOutsideWorld: number;
  /// Settles whose hard ledger write was put back so the track could glide it,
  /// and settles with no track left, where the hard write stands.
  /// Bodies re-anchored to their drawn pose after the server stopped serving
  /// them long enough for their track to give up.
  /// Tracks started from the ledger pose rather than from nothing, which is
  /// what a waking body needs and what neither of the other two seeds covered.
  /// Re-anchors that would have moved the render clock backwards.
  renderClockReanchorsRefused: number;
  /// Bodies carried across a structure repair rather than cut to its poses.
  bootstrapPosesSeen: number;
  bootstrapPosesGone: number;
  bootstrapPosesGlided: number;
  bootstrapPosesSnapped: number;
  repairBodiesGlided: number;
  wakeSeeds: number;
  starvedReadmissions: number;
  settlesRestored: number;
  settlesLeftHard: number;
  /// Promotion-continuity seeding: how many islands a fracture created, and
  /// how many of them had their presented pose anchored to where their chunks
  /// were already drawn. The gap is chunks jumping at the fracture.
  promotionsSeen: number;
  promotionsSeeded: number;
  promotionsSeedSkippedReused: number;
  promotionsSeedSkippedNoBody: number;
  promotionsSeedSkippedNoDrawnPose: number;
  promotionsUnseeded: number;
  liveIslands: number;
  topoSeqGaps: number;
  datagramsReceived: number;
  recordsApplied: number;
  /** 2 = ranked per-client records; 3 = LiveEncoder debris spans via wasm. */
  wireVersion: number;
  recordsBuffered: number;
  /// Ledger rebuilds this session. Each one is a full restatement of the
  /// world; a climbing count means the client keeps losing agreement with the
  /// server and asking for a fresh copy.
  bootstraps: number;
  /** Seq-aligned ledger-hash comparisons that actually ran. */
  hashChecks: number;
  /** Comparisons that found divergence — the detector firing. */
  hashMismatches: number;
  /** Targeted per-structure repairs applied (vs full bootstraps). */
  structureRepairs: number;
  /** Body NACKs sent upstream, the bodies they named, and ledger resync requests. */
  nacksSent: number;
  nackBodiesSent: number;
  resyncRequestsSent: number;
  /// Settles refused because their pose would have teleported the body --
  /// membership disagreement, caught before it could be drawn.
  settleRejects: number;
  /// Settles applied although they moved the body more than the reject
  /// distance, because the stream had stopped showing the body while it
  /// moved (it left this client's interest). Not a fault.
  settlesAfterSilence: number;
  /// Settles older than a pose the stream had already shown (the reliable
  /// message arrived after newer datagrams); the newer pose is kept.
  settlesSuperseded: number;
  /// Topology released by the wall-clock valve, ahead of the pose clock.
  valveApplies: number;
  valveTicksAhead: number;
  /// Frames the presentation was held behind a promotion the pose stream had
  /// shown but the reliable stream had not delivered, the ticks of delay those
  /// holds added, and evidence given up on (see HOLD_FOR_MISSING_TOPOLOGY).
  topologyHoldFrames: number;
  topologyHoldTicksAdded: number;
  topologyHoldExpired: number;
  /// Topology messages applied from their datagram copy (it beat the reliable
  /// stream), copies that arrived after the message was applied, reliable
  /// messages that arrived after their copy, and repairs that arrived behind
  /// a ledger the copies had advanced (see `acceptTopology`).
  topologyCopiesApplied: number;
  topologyCopiesLate: number;
  topologyReliableAfterCopy: number;
  repairsBehindCopies: number;
  /// Frames in which the copies showed a topology message missing (a later
  /// one, or a piece of it, had arrived); the presentation may be held below
  /// its tick (see `topologyGapLimit`).
  topologyGapHoldFrames: number;
  bytesReceived: number;
  bytesPerSecond: number;
  /// The playout delay in ticks actually applied this frame, and the network
  /// arrival lateness (also ticks) it is sized against. On a clean link these
  /// are 6 and 0; on a jittery one the first must exceed the second or debris
  /// is sampled from a span that has not arrived.
  sampleDelayTicks: number;
  arrivalLatenessTicks: number;
  arrivalLatenessPeakTicks: number;
  manifestHash: string;
  /// Destruction dust sources extracted from topology messages, cumulative,
  /// and the ones that never reached the renderer: over the per-message cap,
  /// or queued past what one frame drains.
  dustSources: number;
  dustSourcesDroppedByCap: number;
  dustQueueDropped: number;
  /// By kind: shot entries, velocity-stream impacts, collapse waves.
  dustEntries: number;
  dustImpacts: number;
  dustWaves: number;
}

interface BodyStreamState {
  track: PresentationTrack;
  lastTick: number;
  settledHint: boolean;
  /** Last pose handed to the renderer, for skipping motionless bodies. */
  lastPresented?: { position: Vec3; rotation: Quat };
  /**
   * Speed of the last presented sample, m/s.
   *
   * Kept so the renderer's teleport probe can judge a step against what this
   * body is KNOWN to be doing rather than against an average of the steps it
   * has already taken. The difference decides whether a collapse reads as
   * thousands of teleports or as thousands of chunks starting to fall.
   */
  lastPresentedSpeed?: number;
  /** The track's velocity at the last presented sample, m/s (wire v2). */
  lastPresentedVelocity?: Vec3;
}

/**
 * Motion below this is not worth re-composing a matrix for. Well under the
 * codec's own ~5 mm quantisation step, so a body that is genuinely moving is
 * never mistaken for a still one.
 */
const PRESENTATION_EPSILON_M = 1e-4;

/**
 * Minimum spacing between resync requests.
 *
 * A resync rebuilds the entire ledger, so it is the heaviest repair available
 * and must not be driven at the rate faults are discovered. One bootstrap
 * repairs every outstanding fault at once, so spacing them loses nothing but
 * time.
 */
const RESYNC_MIN_INTERVAL_MS = 3000;

/**
 * Half-width of the box a streamed pose may occupy, metres.
 *
 * Sized against what the simulation can produce, not what the wire can encode:
 * the cities are 130-180 m across and a chunk launched at the cannonball's
 * 60 m/s carries about 180 m in this world's gravity. A kilometre is five times
 * both, and matches the server's own filter -- this is the second line, for a
 * server that has not been updated or a scene that has widened its own bound.
 */
const WORLD_BOUND_M = 1000;

/**
 * How far a body may have moved and still be carried across a bootstrap.
 *
 * Generous against a collapse -- debris crosses tens of metres between a
 * client noticing it is holed and the repair arriving -- and far below what a
 * replaced world looks like, where the same key lands somewhere unrelated or
 * does not exist at all.
 */
const BOOTSTRAP_GLIDE_MAX_M = 40;

/**
 * How long a body may go unserved before its next record is treated as a
 * re-admission rather than a continuation, in sim ticks.
 *
 * Half a second. Below that the track's own interpolation and correction cover
 * the gap; beyond it the track has given up, been dropped from the per-frame
 * walk, and its chunks are frozen somewhere the body no longer is.
 */
const STARVED_TICKS = 30;

/** /city?seedStarved=0 restores the snap this replaced. */
const SEED_ON_STARVED_READMISSION = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('seedStarved') !== '0';
  } catch {
    return true;
  }
})();

/**
 * Forbid the render clock from running backwards. On by default.
 *
 * A switch only so the two can be compared in one build against one collapse:
 * /city?monotonicClock=0 restores the clock that could reverse.
 */
/**
 * Hold topology to the pose clock on wire v2 as well as v3.
 *
 * The comment above the v3 path says what this is for and that it was
 * "measured as meter-scale per-frame chunk teleports" -- and it was only ever
 * applied to v3, while production runs v2, so it has twice looked like the
 * obvious answer to the fracture-time flicker.
 *
 * OFF, because it has twice failed to pay. Three matched pairs on the same
 * scripted collapse, drawn chunk teleports per broken bond: 5.460/3.015,
 * 2.908/4.354, 2.885/5.084 without and with. Mean 3.75 against 4.15 -- no
 * benefit and possibly a cost, and the spread between runs is larger than the
 * difference either way. /city?holdTopology=1 turns it on.
 */
const HOLD_TOPOLOGY_ON_V2 = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('holdTopology') === '1';
  } catch {
    return false;
  }
})();

const MONOTONIC_RENDER_CLOCK = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '')
      .get('monotonicClock') !== '0';
  } catch {
    return true;
  }
})();

/**
 * The window the city's tick rate is measured over, and the least span it is
 * trusted at. Two seconds of a +-35 ms jitter is +-3.5% at worst, and the
 * render clock's pull turns a rate error into a lead of (error / 2) ticks.
 */
const TICK_RATE_WINDOW_MS = 2000;
const TICK_RATE_MIN_SPAN_MS = 250;

/**
 * Stop the v2 render clock one playout delay past the newest streamed tick,
 * so the presented tick never passes the pose stream (see `renderTickNow`).
 * /city?leadCap=0 restores the free-running clock.
 */
const RENDER_CLOCK_LEAD_CAP = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('leadCap') !== '0';
  } catch {
    return true;
  }
})();

/**
 * How long after the newest datagram the lead cap holds, ms. Slow ticks (a
 * fracture's corrected re-solve) are 20-100 ms; a stream silent for longer has
 * most likely gone quiet, and the clock then runs on through its pull.
 */
const RENDER_CLOCK_LEAD_CAP_MS = 300;

/**
 * How far behind the stream an idle clock may be before it jumps rather than
 * catching up through the pull. Two snapshot sends: less is ordinary jitter.
 */
const RENDER_CLOCK_IDLE_JUMP_TICKS = 4;

/** Floor on the playout delay: one flush window's worth, as shipped. */
const MIN_SAMPLE_DELAY_TICKS = 6;

/** Lab-only overrides for tuning (Netlab's client stage runs under node). */
const LAB_ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const labNumber = (key: string, fallback: number): number => {
  const value = Number(LAB_ENV[key]);
  return LAB_ENV[key] !== undefined && Number.isFinite(value) ? value : fallback;
};

/**
 * Size the wire-v2 playout delay from the measured stream, instead of
 * holding it at MIN_SAMPLE_DELAY_TICKS. OFF: /city?adaptiveDelay=1.
 *
 * The presented tick (render tick minus the delay) must stay at or behind
 * the newest streamed tick, and the lead cap enforces that by stopping the
 * render clock one delay past it (`renderTickNow`). A delay smaller than the
 * clock's usual lead over the newest tick makes the cap stop the clock on
 * more frames: the city freezes and then catches up (measured in Netlab:
 * sizing it from datagram arrivals instead took LTE from 4.2% to 7.6% of
 * frames stopped). So the delay is a high quantile (PLAYOUT_QUANTILE) of
 * that lead over the last PLAYOUT_WINDOW_MS, sampled at every frame before
 * the cap: the cap then stops the clock on no more frames than the fixed
 * delay did. Never above the fixed 6 ticks, never below 3; it slews like
 * any delay change.
 *
 * Off because the latency it gives back is paid for in corrections. Every
 * tick less leaves a record more chance to land after the presentation
 * passed its tick, and fast debris is then corrected in view. Measured in
 * Netlab on the 20260924-161728 capture (c1), delay 6 / 5 / 4 / 3 ticks on
 * loopback: presented tick behind the server 5.2 / 4.2 / 3.2 / 2.3,
 * presented jumps over 4 m 54 / 67 / 72 / 79, correction snaps
 * 25 / 31 / 33 / 37, debris pos@render p99 0.134 / 0.143 / 0.153 / 0.163 m.
 * On LTE, where the lead's tail keeps the adaptive delay near 5, it gains
 * one tick for +18% jumps. docs/netcode-tuning.md#city-latency-and-topology-delivery.
 */
const ADAPTIVE_PLAYOUT_DELAY = (() => {
  try {
    if (LAB_ENV.CITY_ADAPTIVE_DELAY !== undefined) return LAB_ENV.CITY_ADAPTIVE_DELAY === '1';
    return new URLSearchParams(globalThis.location?.search ?? '').get('adaptiveDelay') === '1';
  } catch {
    return false;
  }
})();
const PLAYOUT_WINDOW_MS = labNumber('CITY_PLAYOUT_WINDOW_MS', 4000);
const PLAYOUT_QUANTILE = labNumber('CITY_PLAYOUT_Q', 0.99);
const PLAYOUT_MARGIN_TICKS = labNumber('CITY_PLAYOUT_MARGIN', 0);
const PLAYOUT_FLOOR_TICKS = labNumber('CITY_PLAYOUT_FLOOR', 3);

/**
 * How fast the arrival estimates forget.
 *
 * The best-transit reference drifts back slowly, so one lucky packet cannot
 * latch the estimate low for the rest of the session. The lateness high-water mark decays faster but still far slower
 * than it rises: a link that just got worse must be believed at once, while a
 * link that got better should give its buffer back gradually, because
 * shrinking the delay is what makes bodies jump forward.
 */
const ARRIVAL_BEST_DECAY_TICKS_PER_S = 0.5;
const ARRIVAL_LATENESS_DECAY_TICKS_PER_S = 1.0;

/**
 * Ceiling on the playout delay.
 *
 * Buffering is bought with latency, and past about half a second of it the cure
 * is worse than the teleport: debris lands visibly after the impact that threw
 * it. A link needing more than this is not one a buffer can rescue.
 */
const MAX_SAMPLE_DELAY_TICKS = 30;

/**
 * Slew rates for the applied delay, in ticks per frame.
 *
 * Growing the buffer runs the sample clock slow for a moment; shrinking it runs
 * the clock fast, which is a small teleport of every moving body at once. So
 * growth is allowed to be three times quicker than release.
 */
const SAMPLE_DELAY_GROW_TICKS_PER_FRAME = 0.15;
const SAMPLE_DELAY_SHRINK_TICKS_PER_FRAME = 0.05;

/**
 * Size the playout delay against the measured link, rather than holding it at
 * one flush window.
 *
 * A switch because it is an experiment with a real cost on both sides: too
 * small a buffer snaps bodies, too large a one delays every impact the player
 * causes. Read once, from the page URL, so both arms of an A/B share a build
 * and a deploy: /city?adaptiveBuffer=1.
 */
/**
 * Glide a settling body onto its rest pose instead of cutting to it.
 *
 * Behind a switch for the same reason the playout buffer is: it trades a hard
 * step for a quarter-second of the body still drifting after the server says it
 * stopped, and which of those a player prefers is a judgement the measurement
 * alone does not make. /city?settleGlide=0 turns it off.
 */
const SETTLE_GLIDE = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('settleGlide') !== '0';
  } catch {
    return true;
  }
})();

/**
 * Hold the city's presented tick behind a promotion the pose stream has shown
 * exists but the reliable stream has not delivered yet.
 *
 * Topology rides the ordered reliable stream and the poses ride datagrams. On
 * a lossy link the reliable stream is head-of-line blocked (LTE: p50 123 ms,
 * p90 297 ms, against 90 ms for datagrams), so a fracture's promotion can
 * reach the client after the presentation has passed the fracture tick. Until
 * it arrives the promoted chunks are drawn on the body they left -- in the
 * wall, or riding the parent island -- which Netlab counts as wrong-identity
 * chunk draws (61,092 chunk-frames on LTE, 139,139 on poor-mobile, systematic
 * bundle, c1).
 *
 * A record for a body the ledger does not know is proof that such a promotion
 * exists: the encoder only streams bodies it has promoted, and it streams a new
 * body at the first send at or after the promotion tick (measured: first
 * record tick minus promotion tick p50 0, p90 1). So the presentation is held
 * one send before that record's tick until the promotion lands, then released
 * through the usual slow delay shrink. Only on evidence: a link whose topology
 * keeps up never holds, and the delay is not raised for everything.
 * /city?topologyHold=0 turns it off.
 */
const HOLD_FOR_MISSING_TOPOLOGY = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('topologyHold') !== '0';
  } catch {
    return true;
  }
})();

/**
 * How long evidence of a missing promotion may hold the presentation, ms.
 *
 * The reliable stream delivers everything eventually, so this only bounds a
 * record for a body the server will never promote to this client (a stale
 * record from before a bootstrap, say). Same bound as the topology valve.
 */
const TOPOLOGY_HOLD_MAX_MS = 1000;

/**
 * Where the hold stops, relative to the first record's tick: the promotion is
 * at that tick or the one before (the city sends every second tick), and the
 * scorer's and the eye's "presented tick" is the whole tick below the sample.
 */
const TOPOLOGY_HOLD_TICKS_BEFORE_RECORD = 1;

/** Topology copies held for an earlier seq, and pieces in reassembly, at most. */
const TOPOLOGY_AHEAD_MAX = 256;
/** Where a PKT_CITY_TOPOLOGY packet states its sim tick: kind, version, u32 seq. */
const TOPOLOGY_TICK_OFFSET = 6;
/** Applied topology messages kept to re-apply after a repair behind them. */
const TOPOLOGY_APPLIED_KEPT = 128;

const ADAPTIVE_PLAYOUT_BUFFER = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('adaptiveBuffer') === '1';
  } catch {
    return false;
  }
})();

export class CityClient {
  readonly topology: CityTopology;
  private readonly bodies: Map<number, BodyStreamState> = new Map();
  /**
   * Bodies whose next sample might move something -- the per-frame walk.
   *
   * `samplePresentation` used to walk EVERY body every frame, and in a
   * demolished city that is thousands of quiescent islands re-proving each
   * frame that they have not moved: ~2.5 ms of the M3's frame in the
   * post-demolition steady state. A body leaves this set when its track's
   * sample takes the settled fast-path (see `PresentationTrack.lastSampleSettled`
   * for why that is a proof, not a heuristic), and re-enters on exactly the
   * events that can make it move again: a datagram record, or track creation.
   * Settles and retires delete the body outright, which also removes it here.
   */
  private readonly kinetic = new Set<number>();
  private baselineId = 0;
  /**
   * Baseline poses per generation, newest last.
   *
   * A generation is broadcast as several parts, and delta records stamped with
   * it start arriving before the last part does. Keeping the previous
   * generation alive means those in-flight deltas still resolve against the
   * base the server actually used, instead of being dropped for the ~parts
   * window every time a generation rolls over.
   */
  private readonly baselineGenerations: Map<number, Map<number, Vec3>> = new Map();
  /** Records referencing bodies the ledger doesn't know yet (topology in flight). */
  private pendingRecords: ChunksDatagram[] = [];
  /**
   * Bodies the pose stream named before the ledger had them: the tick of the
   * first record seen for each, and when it arrived. Each is a promotion in
   * flight on the reliable stream; see HOLD_FOR_MISSING_TOPOLOGY.
   */
  private readonly awaitingTopology: Map<number, { tick: number; atMs: number }> = new Map();
  /**
   * Whether the last sample presented nothing moving: no body in the per-frame
   * walk. The render clock may jump forward then (see `renderTickNow`).
   */
  private presentationIdle = true;
  /** The sample tick the presentation last used (v2), never decreasing. */
  private lastSampleTick = -1;
  /** Frames the presentation was held for missing topology, and ticks of delay the holds added. */
  private topologyHoldFrames = 0;
  private topologyHoldTicksAdded = 0;
  /** Evidence given up on: the hold ran out before the promotion arrived. */
  private topologyHoldExpired = 0;
  /**
   * Datagram copies of topology messages (wire v2 trailer): pieces being
   * reassembled, whole messages waiting for an earlier seq, and the newest
   * seq the reliable stream itself has delivered. See `acceptTopology`.
   */
  private readonly topologyPieces: Map<number, { parts: number; got: Array<Uint8Array | undefined>; count: number; atMs: number }> = new Map();
  private readonly topologyAhead: Map<number, { message: TopologyMessage; atMs: number }> = new Map();
  /** The sim tick of the newest topology message applied. */
  private lastAppliedTopoTick = -1;
  /** Frames with a topology message the copies showed was missing. */
  private topologyGapHoldFrames = 0;
  private lastReliableTopoSeq = 0;
  /** Recently applied messages by seq, to re-apply after a repair behind them. */
  private readonly topologyApplied: TopologyMessage[] = [];
  private topologyCopiesApplied = 0;
  private topologyCopiesLate = 0;
  private topologyReliableAfterCopy = 0;
  private repairsBehindCopies = 0;
  private datagramsReceived = 0;
  private recordsApplied = 0;
  private recordsBuffered = 0;
  private bytesReceived = 0;
  private bytesWindow: Array<{ at: number; bytes: number }> = [];
  private latestSimTick = 0;
  private latestSimTickAtMs = 0;
  /**
   * The last time a datagram showed the server streaming with nothing newer
   * than `latestSimTick` to send: a send whose pose records the rate
   * controller withheld, carrying topology copies only. The lead cap treats
   * it like a records datagram; without it the cap lapsed after 300 ms and
   * the clock ran on 30+ ticks past the server during a slow patch (Netlab,
   * bw-capped-nq, measured).
   */
  private streamAliveAtMs = 0;
  /** Whether the lead cap held the render clock this frame. */
  private leadCapActive = false;
  /** Measured server tick rate (ticks per wall second). The server sheds
   *  sim rate under load (60 -> 20 Hz at heavy demolition); extrapolating
   *  the render clock at a hardcoded 60 made the clock outrun tick
   *  production and snap back ~10 ticks on every re-anchor -- visible as
   *  rubber-banding of flying debris whenever the sim was below 60 Hz.
   *
   *  A ratio over a window of arrivals (see `observeSimTick`), not an average
   *  of per-arrival ratios: under jitter the latter is biased high. */
  private tickRate = 60;
  /** Newest-tick advances in the rate window, oldest first. */
  private readonly tickArrivals: Array<{ tick: number; atMs: number }> = [];
  /** Continuous render clock (tick units); follows the extrapolated anchor
   *  with a ~0.5 s pull so per-packet anchor jitter never steps it. */
  private renderClockTick = -1;

  /** The tick this client is currently presenting, for the pose trace. */
  renderClockTickForTrace(): number {
    return this.renderClockTick;
  }
  /** Backwards re-anchors refused; see `renderTickNow`. */
  private renderClockReanchorsRefused = 0;
  private renderClockMs = 0;
  /** Wire v3: the wasm debris decoder; null means this match speaks v2. */
  private readonly debris: DebrisDecoder | null;
  private readonly simHz: number;
  /** Wire v3: lane -> body entity, from the reliable PKT_CITY_LANES stream. */
  private readonly laneToEntity: Map<number, number> = new Map();
  private readonly entityToLane: Map<number, number> = new Map();
  /** Previous sampled position per entity (netlab jump diagnostics only). */
  private readonly lastSamplePos: Map<number, [number, number, number]> = new Map();
  /**
   * Wire v3: topology messages held until the debris sample clock reaches
   * their tick, so ledger basis (membership, island COM) and sampled poses
   * describe the same instant. Drained by `sampleDebris`.
   */
  private readonly pendingTopology: { message: TopologyMessage; receivedAtMs: number }[] = [];
  /**
   * Observed span cadence in ticks (EMA of consecutive datagram spanTick
   * deltas). The sampling delay must cover one full flush window plus
   * interpolation margin: the governor stretches flush toward 250 ms under
   * load, and a client still sampling at a fixed 100 ms delay would run
   * ahead of the data and stutter -- the latency the governor spends has to
   * be spent HERE, visibly and smoothly.
   */
  private spanTicksEma = 6;
  private lastSpanTick = -1;
  /**
   * The delay actually applied, slewed toward the target at a bounded rate.
   * Stepping it integerly made the sample clock jump N ticks in one frame --
   * every moving body teleported by delay-delta x velocity simultaneously
   * (measured: 1.4-2.3 m excess steps at each governor transition). Slewing
   * at 0.05 ticks/frame spreads a 100 ms change over ~2 s of imperceptible
   * clock drift.
   */
  private sampleDelaySmooth = 6;
  /**
   * Network arrival lateness in ticks, measured from the datagrams themselves.
   *
   * The delay above covers the SERVER's flush window. It says nothing about
   * the link, and on loopback there is nothing to say -- which is exactly why
   * this was missing. How far the render clock has run past a span's tick when
   * that span arrives is constant while transit is constant, and grows by
   * exactly the extra transit a held-up packet suffered. The smallest such gap
   * seen recently is therefore the fastest transit on offer, and every packet's
   * excess over it is that packet's lateness.
   *
   * It is an instrument, not an input. Sampling at a delay under the lateness
   * would read a span that has not arrived -- the decoder would extrapolate the
   * last segment and snap when the real one landed -- and this number is what
   * says whether that is happening. So far it says no: see `sampleDebris`.
   */
  private arrivalOffsetBest = Number.POSITIVE_INFINITY;
  private arrivalOffsetBestAtMs = 0;
  private arrivalLateness = 0;
  private arrivalLatenessAtMs = 0;
  private arrivalLatenessPeak = 0;
  /**
   * The render clock's lead over the newest streamed tick at each frame,
   * over the last PLAYOUT_WINDOW_MS, and the delay it calls for (see
   * ADAPTIVE_PLAYOUT_DELAY); NaN until measured.
   */
  private readonly clockLeads: Array<{ atMs: number; lead: number }> = [];
  /** ADAPTIVE_PLAYOUT_DELAY, per instance (tests turn it on). */
  private adaptiveDelay = ADAPTIVE_PLAYOUT_DELAY;
  private playoutTarget = Number.NaN;
  /**
   * Deliberate presentation discontinuities, by kind.
   *
   * Each is a designed escape hatch -- a correction too large to glide, a
   * render clock that moved backwards, two snapshots too far apart to
   * interpolate -- and each is visible on screen. Counting them is the
   * difference between "the drawn pose stepped 7.9 m" and knowing which of
   * three mechanisms did it.
   */
  private readonly presentationAnomalies: Record<string, number> = {
    clock_rollback: 0,
    correction_snap: 0,
    implausible_jump: 0,
  };
  private presentationAnomalyMaxM = 0;
  /**
   * Streamed poses refused for being outside the world.
   *
   * Must be 0. Anything else is a fragment the server has thrown away and not
   * retired, and every one of them poisons the anomaly counters around it.
   */
  private recordsOutsideWorld = 0;
  /** Settles whose hard ledger write was put back for the track to glide. */
  /** Bodies re-anchored to their drawn pose after going unserved. */
  /** Tracks started from the ledger pose rather than from nothing. */
  /** Bodies carried across a structure repair instead of cut to its poses. */
  /** Bodies carried across a bootstrap, and bodies too far to carry. */
  private bootstrapPosesSeen = 0;
  private bootstrapPosesGone = 0;
  private bootstrapPosesGlided = 0;
  private bootstrapPosesSnapped = 0;
  private repairBodiesGlided = 0;
  private wakeSeeds = 0;
  private starvedReadmissions = 0;
  private settlesRestored = 0;
  /** Settles with no track left to glide them, so the hard write stands. */
  private settlesLeftHard = 0;
  /**
   * How the promotion-continuity seeding is actually going.
   *
   * Every fracture promotes islands, and each one either gets its presented
   * pose anchored to where its chunks are already drawn or it does not. The
   * ones that do not are the chunks that jump the instant a building breaks,
   * and until these were counted there was no way to tell whether the seeding
   * covered one promotion in a thousand or all of them.
   */
  private promotionsSeen = 0;
  private promotionsSeeded = 0;
  private promotionsSeedSkippedReused = 0;
  private promotionsSeedSkippedNoBody = 0;
  private promotionsSeedSkippedNoDrawnPose = 0;
  private promotionsUnseeded = 0;
  /** Preallocated sampling buffers -- one FFI call per frame, no garbage. */
  private sampleLanes = new Uint32Array(4096);
  private samplePoses = new Float32Array(4096 * 7);
  private decodeMsWindow: number[] = [];
  /**
   * Tick at which each body was last settled by the reliable channel. Guards
   * the unreliable stream, which has no ordering relationship to it.
   */
  private readonly settledAtTick: Map<number, number> = new Map();
  /** One resync request per divergence, cleared when the bootstrap lands. */
  private resyncRequested = false;
  private lastResyncAtMs = -1e9;
  /// Resyncs skipped by the rate limit. Each one is a full world rebuild that
  /// did not happen; the next one repairs whatever they would have.
  resyncsSuppressed = 0;
  /** Seq-aligned hash comparisons performed (the detector actually ran). */
  hashChecks = 0;
  /** Comparisons that found at least one structure diverged. */
  hashMismatches = 0;
  /** Targeted per-structure repairs applied. */
  structureRepairs = 0;
  /**
   * What this client asked the server to resend: body NACKs (and the bodies
   * they named) and ledger resync requests. Upstream traffic is not on the
   * tape, so these are the only record of it (scripts/perf/city-bench).
   */
  nacksSent = 0;
  nackBodiesSent = 0;
  resyncRequestsSent = 0;
  /**
   * Topology messages released by the wall-clock valve rather than by the
   * sample clock reaching their tick, and how far ahead they were.
   *
   * The valve exists so a stalled pose clock cannot delay fracture forever,
   * but anything it releases is applied AHEAD of the poses on screen, so its
   * absolute poses land as a jump. Non-zero means the pose clock is not
   * keeping up with the reliable channel.
   */
  topologyValveApplies = 0;
  topologyValveTicksAhead = 0;
  /**
   * Bodies whose ledger pose changed without a streaming update to carry it
   * to the screen — settles, promotions, migrations, wakes. The render layer
   * repaints only what streams; while the tab is hidden rAF is paused but the
   * reliable channel keeps mutating the ledger, and an island that settles in
   * that window is removed from the streaming set before it is ever sampled
   * again. Without this queue its chunks keep their pre-hide matrices forever
   * (measured: 690 stale chunks on refocus, 28 permanent).
   */
  private repaintAll = false;
  private readonly repaintBodies = new Set<number>();
  /** Whether any bootstrap has established the baseline this session. */
  private bootstrapped = false;

  constructor(
    readonly manifest: LoadedCityManifest,
    private readonly sendUpstream: (bytes: Uint8Array) => void,
    v3?: { decoder: DebrisDecoder; simHz?: number },
  ) {
    this.debris = v3?.decoder ?? null;
    this.simHz = v3?.simHz ?? 60;
    this.topology = new CityTopology(manifest.manifest);
    this.dustContext = {
      manifest: manifest.manifest,
      topology: this.topology,
      structureById: new Map(manifest.manifest.structures.map((s) => [s.structureId, s])),
      drawnPoseInto: (slot, out, at) => {
        const drawn = this.drawnChunkPose.get(slot);
        if (!drawn) return false;
        out[at] = drawn.position[0];
        out[at + 1] = drawn.position[1];
        out[at + 2] = drawn.position[2];
        out[at + 3] = drawn.rotation[0];
        out[at + 4] = drawn.rotation[1];
        out[at + 5] = drawn.rotation[2];
        out[at + 6] = drawn.rotation[3];
        return true;
      },
      presentedSpeed: (key) => this.bodyPresentedSpeed(key),
      impactedRecently: (key, nowMs) => this.dustImpacts.impactedRecently(key, nowMs),
      matchShot: (x, y, z, nowMs) => matchDustShot(x, y, z, nowMs),
    };
    // A body's frame moves when it sheds members. Carry that move through the
    // buffered poses so the smoothing delay cannot render new-frame offsets
    // against poses still stated in the old frame.
    this.topology.onReoffset = (key, deltaLocal) => {
      const state = this.bodies.get(key);
      if (!state) {
        return;
      }
      state.track.rebase(deltaLocal);
      if (state.lastPresented) {
        const worldDelta = qRotate(state.lastPresented.rotation, deltaLocal);
        state.lastPresented.position = vAdd(state.lastPresented.position, worldDelta);
      }
    };
  }

  /** Bootstraps applied this session; a forced resync bumps it on arrival. */
  bootstrapCount = 0;

  /** Ask the server for a fresh bootstrap (measurement / recovery). */
  requestResync(): void {
    this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
  }

  /**
   * Bodies needing a one-shot instance rewrite, drained by the render layer
   * each frame. `all` after a bootstrap/resync (the whole ledger was replaced).
   */
  /**
   * Wire v3: one wasm call fills the pose buffers for every live lane; lanes
   * map to entities through the reliable assignment stream, and poses land in
   * the same ledger slot the v2 path writes. Chains a lost packet poisoned are
   * drained here and nacked upstream, so the heal cost tracks actual loss.
   */
  /**
   * Fold a newest-seen sim tick into the anchor and the tick rate.
   *
   * The rate is ticks over wall time across the window: (newest tick - tick at
   * the window's start) / (time between their arrivals). It used to be an EMA
   * of the ratio between CONSECUTIVE arrivals, and the mean of a ratio is not
   * the ratio of the means: under jitter two datagrams arrive a few ms apart
   * as often as a whole cadence apart, and the short gaps dominate. Measured
   * on Netlab's LTE link (90 +- 35 ms): 69.3 ticks/s p50 (p90 81.9) against a
   * server running at 55.9. The render clock's pull then holds it ahead of its
   * anchor by (excess rate) / (pull rate), which put the presented city at
   * 3.5 ticks behind the server instead of about 11 -- ahead of the datagrams
   * it samples and of the topology that says which body each chunk is on
   * (docs/mac-metal-session-analysis-2026-09-24.md, item 12). Over the window
   * the jitter only enters at the two ends, and it does not scale with the
   * arrival rate.
   */
  private observeSimTick(tick: number): void {
    const now = performance.now();
    const arrivals = this.tickArrivals;
    arrivals.push({ tick, atMs: now });
    // Keep the window at least TICK_RATE_WINDOW_MS long: drop the oldest only
    // while the next one alone still spans it.
    while (arrivals.length > 2 && now - arrivals[1].atMs >= TICK_RATE_WINDOW_MS) {
      arrivals.shift();
    }
    const first = arrivals[0];
    const spanS = (now - first.atMs) / 1000;
    if (spanS >= TICK_RATE_MIN_SPAN_MS / 1000) {
      const rate = (tick - first.tick) / spanS;
      if (rate > 0.5 && rate < 240) {
        this.tickRate = rate;
      }
    }
    this.latestSimTick = tick;
    this.latestSimTickAtMs = now;
  }

  /**
   * Fold one datagram's arrival into the network-lateness estimate.
   *
   * See `arrivalOffsetBest` for why span-tick-minus-local-clock is the right
   * quantity. Both estimates are decayed on wall time rather than per packet,
   * so a link that goes quiet does not freeze them.
   */
  private observeArrival(spanTick: number, nowMs: number): void {
    // Measured against the render clock, NOT against wall time scaled by the
    // tick rate. The obvious spelling -- spanTick minus (now/1000 * rate) -- is
    // a difference of two large products, so a fraction of a percent of drift
    // in the rate estimate moves it by tens of ticks: it reported five to eight
    // SECONDS of network lateness on a 40 ms link. The render clock already
    // tracks the server's real tick production through a bounded pull, so how
    // far behind it a span arrives is the honest quantity, and the smallest
    // such gap seen recently is the reference everything else is late against.
    if (this.renderClockTick < 0) {
      return;
    }
    const behind = this.renderClockTick - spanTick;
    if (!Number.isFinite(this.arrivalOffsetBest) || behind <= this.arrivalOffsetBest) {
      this.arrivalOffsetBest = behind;
    } else {
      const elapsedS = Math.max(0, (nowMs - this.arrivalOffsetBestAtMs) / 1000);
      this.arrivalOffsetBest = Math.min(
        behind,
        this.arrivalOffsetBest + elapsedS * ARRIVAL_BEST_DECAY_TICKS_PER_S,
      );
    }
    this.arrivalOffsetBestAtMs = nowMs;

    const lateness = Math.max(0, behind - this.arrivalOffsetBest);
    const elapsedS = Math.max(0, (nowMs - this.arrivalLatenessAtMs) / 1000);
    this.arrivalLateness = Math.max(
      lateness,
      this.arrivalLateness - elapsedS * ARRIVAL_LATENESS_DECAY_TICKS_PER_S,
    );
    this.arrivalLatenessAtMs = nowMs;
    if (this.arrivalLateness > this.arrivalLatenessPeak) {
      this.arrivalLatenessPeak = this.arrivalLateness;
    }
  }

  /**
   * One frame's lead of the render clock over the newest streamed tick,
   * before the lead cap: the delay that would keep the cap from stopping
   * the clock this frame. A high quantile of it over the window is the
   * delay; the cap then stops the clock on the remaining frames only.
   */
  private observeLead(nowMs: number, lead: number): void {
    const samples = this.clockLeads;
    samples.push({ atMs: nowMs, lead });
    while (samples.length > 0 && nowMs - samples[0].atMs > PLAYOUT_WINDOW_MS) {
      samples.shift();
    }
    this.leadSamplesSinceSort += 1;
    if (this.leadSamplesSinceSort < 8 && Number.isFinite(this.playoutTarget)) {
      return;
    }
    this.leadSamplesSinceSort = 0;
    const sorted = samples.map((sample) => sample.lead).sort((a, b) => a - b);
    const at = Math.min(sorted.length - 1, Math.floor(PLAYOUT_QUANTILE * (sorted.length - 1) + 0.5));
    this.playoutTarget = sorted[at] + PLAYOUT_MARGIN_TICKS;
  }

  private leadSamplesSinceSort = 0;

  /** The wire-v2 playout delay this frame asks for. */
  private playoutDelayTarget(): number {
    if (!this.adaptiveDelay || !Number.isFinite(this.playoutTarget)) {
      return MIN_SAMPLE_DELAY_TICKS;
    }
    return Math.min(MIN_SAMPLE_DELAY_TICKS, Math.max(PLAYOUT_FLOOR_TICKS, this.playoutTarget));
  }

  /** The render clock: the newest-tick anchor extrapolated at the MEASURED
   *  tick rate, followed through a bounded pull. A >2 s discontinuity
   *  (join, reset, resync) snaps. */
  private renderTickNow(nowMs: number): number {
    const previousClock = this.renderClockTick;
    const raw =
      this.latestSimTick + ((nowMs - this.latestSimTickAtMs) / 1000) * this.tickRate;
    if (this.renderClockTick < 0 || Math.abs(raw - this.renderClockTick) > 120) {
      // The re-anchor. Two seconds of discontinuity means a join, a reset or a
      // resync, and the clock has to jump to wherever the stream now is.
      //
      // Forwards only, unless there is no clock yet. This branch was the hole
      // in the monotonic guard below: under a real collapse the server sheds
      // sim rate hard enough that the anchor lands more than 120 ticks behind
      // the extrapolating clock, the snap takes it backwards, and every
      // PresentationTrack sampling it abandons its correction and jumps to the
      // raw path. Toppling a ten-storey tower produced 5,561 of them with the
      // smooth branch already guarded.
      //
      // Refusing to go back leaves the clock ahead of a stream that has slowed,
      // which the smooth branch then walks off by slowing, over a second or so
      // of imperceptible drift.
      if (this.renderClockTick < 0 || raw > this.renderClockTick || !MONOTONIC_RENDER_CLOCK) {
        this.renderClockTick = raw;
      } else {
        this.renderClockReanchorsRefused += 1;
      }
    } else {
      const dt = Math.max(0, (nowMs - this.renderClockMs) / 1000);
      const error = raw - this.renderClockTick;
      const step = dt * this.tickRate + error * Math.min(1, dt * 2);
      // Never backwards.
      //
      // The pull can outrun the forward term: at 60 fps the frame advances the
      // clock by one tick and the correction contributes error/30, so an
      // anchor half a second behind the clock reverses it. That happens exactly
      // when a big collapse is under way, because the server sheds sim rate
      // under load and the rate estimate lags the shed.
      //
      // Reversing is not a small error. Every PresentationTrack samples at
      // this clock, and each one that sees it move backwards abandons the
      // correction it had in flight and snaps to the raw path -- so one
      // backwards frame is not one body twitching, it is every live body in the
      // city lurching at once. That is what "the whole building rubber-bands"
      // means, and a block-wide collapse here produced 12,202 of them, with an
      // 888-chunk island stepping eleven metres.
      //
      // A clock that is ahead is corrected by SLOWING, to a stop if need be,
      // and it catches up on the other side. Time is allowed to stall; it is
      // not allowed to run backwards.
      this.renderClockTick += MONOTONIC_RENDER_CLOCK ? Math.max(0, step) : step;
    }
    this.leadCapActive = this.debris === null
      && RENDER_CLOCK_LEAD_CAP
      && nowMs - Math.max(this.latestSimTickAtMs, this.streamAliveAtMs) < RENDER_CLOCK_LEAD_CAP_MS;
    if (this.leadCapActive) {
      // Never present a tick the pose stream has not reached (wire v2).
      //
      // The pull above keeps the clock running at the measured rate however
      // long the stream is silent, and the stream goes silent exactly when the
      // server stalls: a fracture's corrected re-solve takes 20-100 ms instead
      // of ~7. So the city was presented past ticks the server had not
      // finished yet, and the fracture's topology, however fast it travelled,
      // arrived after the presentation had passed it -- its chunks drawn on the
      // body they left (Netlab, LTE: the presentation passed a promotion's tick
      // p50 39 ms before the server finished simulating it). Stopping the clock
      // one playout delay past the newest tick keeps the presented tick at or
      // behind the newest datagram, as the netcode clock stops one interval
      // past its newest snapshot. It stops; it never steps back.
      //
      // Only for RENDER_CLOCK_LEAD_CAP_MS after the newest datagram: longer
      // than a slow tick, shorter than a stream that has gone quiet because
      // nothing is moving, where a clock held still would leave every glide
      // (a settle's, a late record's) unfinished until something moves again.
      // One playout delay past it: with the adaptive delay, the delay being
      // applied (so the presented tick stays at or behind the newest tick).
      this.observeLead(nowMs, this.renderClockTick - this.latestSimTick);
      const cap = this.latestSimTick
        + (this.adaptiveDelay ? this.sampleDelaySmooth : MIN_SAMPLE_DELAY_TICKS);
      if (this.renderClockTick > cap) {
        this.renderClockTick = Math.max(previousClock, cap);
      }
      // A clock left behind by a quiet stream -- nothing moving, so nothing
      // streamed -- would catch up through the pull, and the first second of
      // the next fracture would play fast. With nothing moving on screen the
      // jump is invisible, so take it.
      if (this.presentationIdle && raw > this.renderClockTick + RENDER_CLOCK_IDLE_JUMP_TICKS) {
        this.renderClockTick = Math.min(raw, cap);
      }
    }
    this.renderClockMs = nowMs;
    return this.renderClockTick;
  }

  /**
   * Slew the playout delay toward what this frame asks for, and return it.
   *
   * `spanFloor` is the wire's own requirement -- v3 must cover the encoder's
   * flush window, v2 only its fixed interpolation delay. The link's lateness is
   * added on top, behind the switch.
   */
  private advancePlayoutDelay(spanFloor: number): number {
    const targetDelay = ADAPTIVE_PLAYOUT_BUFFER
      ? Math.min(
        MAX_SAMPLE_DELAY_TICKS,
        Math.max(MIN_SAMPLE_DELAY_TICKS, spanFloor, Math.ceil(this.arrivalLateness) + 2),
      )
      : this.debris === null ? spanFloor : Math.max(MIN_SAMPLE_DELAY_TICKS, spanFloor);
    if (this.sampleDelaySmooth < targetDelay) {
      this.sampleDelaySmooth = Math.min(
        targetDelay, this.sampleDelaySmooth + SAMPLE_DELAY_GROW_TICKS_PER_FRAME);
    } else if (this.sampleDelaySmooth > targetDelay) {
      this.sampleDelaySmooth = Math.max(
        targetDelay, this.sampleDelaySmooth - SAMPLE_DELAY_SHRINK_TICKS_PER_FRAME);
    }
    return this.sampleDelaySmooth;
  }

  /**
   * Apply held topology whose tick the sample clock has reached.
   *
   * A migration's basis change has to land in the same frame as the poses that
   * were simulated under it. Sampled poses are read a playout delay behind the
   * newest tick, so applying the new membership and island centre of mass as
   * soon as the message arrives composes old-basis poses against the new basis.
   * The wall-clock valve keeps a stalled sample clock -- everything parked, no
   * datagrams -- from delaying fracture forever.
   *
   * `nowMs` comes from the caller rather than being read here, so the valve
   * runs on the same clock as the sampling around it. Reading `performance.now`
   * directly made the valve untestable: a test that advances the clock by
   * passing a later timestamp to `samplePresentation` moved everything except
   * this, and the held batch never released.
   */
  private drainPendingTopology(sampleTick: number, nowMs: number): void {
    while (this.pendingTopology.length > 0) {
      const head = this.pendingTopology[0];
      if (head.message.simTick > sampleTick && nowMs - head.receivedAtMs < 1000) {
        break;
      }
      // Count the valve firing SEPARATELY from an on-time apply. A message
      // released by the valve is applied ahead of the pose clock, so every
      // absolute pose it carries -- settles especially -- states where a body
      // will be, not where this client is drawing it. For fast debris that is
      // metres per released tick.
      if (head.message.simTick > sampleTick) {
        this.topologyValveApplies += 1;
        this.topologyValveTicksAhead += head.message.simTick - sampleTick;
      }
      this.pendingTopology.shift();
      this.applyTopologyMessage(head.message);
    }
  }

  private sampleDebris(renderTick: number, live: Set<number>, nowMs: number): Set<number> {
    const debris = this.debris;
    if (debris === null) {
      return live;
    }
    // Sampling delay = one observed flush window + interpolation margin, so
    // the sample clock never outruns the span the encoder is still filling.
    // Floor of 6 ticks preserves the fixed-flush behaviour exactly; the
    // applied delay slews toward the target so the clock never jumps.
    //
    // Under ADAPTIVE_PLAYOUT_BUFFER the link's own lateness is a third term.
    // Sampling below it reads a span that has not arrived: the track
    // extrapolates and then snaps when the real one lands, which is a body
    // teleporting. Measured with the delay fixed at 6 ticks, six cannonball
    // shots per link: lateness 7.1 ticks and no pose step over a metre; 8.5 and
    // seven of them, worst 3.7 m; 24.4 and sixteen, six of those over four
    // metres, worst 15.2 m. The presentation layer already glides a revised
    // path onto the pose on screen, which is why the gap has to grow this far
    // before it shows.
    this.advancePlayoutDelay(Math.ceil(this.spanTicksEma) + 3);
    const sampleTick = Math.max(0, Math.floor(renderTick - this.sampleDelaySmooth));
    this.drainPendingTopology(sampleTick, nowMs);
    if (debris.lane_count() > this.sampleLanes.length) {
      this.sampleLanes = new Uint32Array(this.sampleLanes.length * 2);
      this.samplePoses = new Float32Array(this.sampleLanes.length * 7);
    }
    const filled = debris.sample_into(sampleTick, this.sampleLanes, this.samplePoses);
    for (let index = 0; index < filled; index += 1) {
      const lane = this.sampleLanes[index];
      const entity = this.laneToEntity.get(lane);
      if (entity === undefined) {
        continue;
      }
      // Only the entity's current lane may write it. A lane whose records
      // raced ahead of its reliable reassignment, or a stale mapping left by
      // a lane move, would otherwise apply another body's trajectory here.
      if (this.entityToLane.get(entity) !== lane) {
        continue;
      }
      // A settled body is owned by the reliable channel, which carried the
      // authoritative rest pose. The v2 record path has always enforced this
      // (see applyRecord); v3 did not, and v3 is where it matters most,
      // because a parked lane stays SAMPLABLE indefinitely by design. So
      // every frame after a settle the sampled pose overwrote the settled
      // one, the next reliable message put it back, and the body oscillated
      // between the two -- measured as 118 settle disagreements and a 151 m
      // worst displacement per collapse on v3, against 0 and 2.4 m on v2.
      //
      // `clear_lane_until` already tries to stop this at the decoder, but it
      // is conditional on the lane maps agreeing; this is the guard at the
      // point of use, where correctness does not depend on that bookkeeping.
      const settledAt = this.settledAtTick.get(entity);
      if (settledAt !== undefined && sampleTick <= settledAt) {
        continue;
      }
      // Wire v3 keeps the settle drift check as it was: a parked lane stays
      // samplable while nothing is streamed to it, so a sample is not evidence
      // that the stream is showing this body. Marking every sample as a fresh
      // moving pose keeps the check armed whenever a lane is sampled.
      this.topology.noteStreamedPose(
        entity,
        sampleTick,
        this.samplePoses[index * 7],
        this.samplePoses[index * 7 + 1],
        this.samplePoses[index * 7 + 2],
        true,
      );
      const at = index * 7;
      // Epoch ordering in the decoder now guarantees a lane's samples belong
      // to its current tenant; the 5 m discontinuity hold that used to guard
      // this spot is gone with it. The jump detector stays as an instrument:
      // any large step it reports is now a REAL defect, not a race.
      if (isRecording()) {
        const prev = this.lastSamplePos.get(entity);
        if (prev) {
          const jump = Math.hypot(
            this.samplePoses[at] - prev[0],
            this.samplePoses[at + 1] - prev[1],
            this.samplePoses[at + 2] - prev[2],
          );
          if (jump > 1.0) {
            recordCityEvent('city_sample_jump', {
              body: entity,
              lane,
              stepM: jump,
              sampleTick,
              prev,
              next: [this.samplePoses[at], this.samplePoses[at + 1], this.samplePoses[at + 2]],
              history: Array.from(debris.lane_history(lane)),
            });
          }
        }
        this.lastSamplePos.set(entity, [
          this.samplePoses[at],
          this.samplePoses[at + 1],
          this.samplePoses[at + 2],
        ]);
      }
      this.topology.updateBodyPose(
        entity,
        [this.samplePoses[at], this.samplePoses[at + 1], this.samplePoses[at + 2]],
        [
          this.samplePoses[at + 3],
          this.samplePoses[at + 4],
          this.samplePoses[at + 5],
          this.samplePoses[at + 6],
        ],
        'presented',
      );
      live.add(entity);
      // No velocity on this wire: difference the samples.
      const body = this.topology.body(entity);
      if (body) {
        const prev = this.dustSamplePrev.get(entity);
        const px = this.samplePoses[at];
        const py = this.samplePoses[at + 1];
        const pz = this.samplePoses[at + 2];
        if (prev && sampleTick > prev[3]) {
          const dtS = (sampleTick - prev[3]) / this.simHz;
          this.noteDustVelocity(
            entity, body, sampleTick, px, py, pz,
            (px - prev[0]) / dtS, (py - prev[1]) / dtS, (pz - prev[2]) / dtS,
          );
          prev[0] = px; prev[1] = py; prev[2] = pz; prev[3] = sampleTick;
        } else if (!prev) {
          this.dustSamplePrev.set(entity, [px, py, pz, sampleTick]);
        }
      }
    }
    const poisoned = debris.drain_poisoned();
    if (poisoned.length > 0) {
      const entities: number[] = [];
      for (const lane of poisoned) {
        const entity = this.laneToEntity.get(lane);
        if (entity !== undefined) {
          entities.push(entity);
        }
      }
      if (entities.length > 0) {
        this.sendResync(encodeCityNack(entities));
      }
    }
    return live;
  }

  drainRepaint(): { all: boolean; bodies: number[] } {
    const all = this.repaintAll;
    const bodies = all ? [] : [...this.repaintBodies];
    this.repaintAll = false;
    this.repaintBodies.clear();
    return { all, bodies };
  }

  // -- Destruction dust ------------------------------------------------------
  //
  // Every applied topology message is read for where things broke and how
  // badly (destructionEvents.ts) and queued as dust sources. The dust layer
  // drains the queue once per frame, so the policy's cost is inside the frame
  // and its stats, and several messages applied between frames arrive together.
  private dustContext: DustExtractContext;
  private readonly dustQueue = new DustSourceQueue();
  private dustSourcesTotal = 0;
  private dustSourcesDroppedByCap = 0;

  private readonly dustImpacts = new DustImpactDetector();
  private readonly dustSamplePrev = new Map<number, [number, number, number, number]>();

  /**
   * A body's velocity sample from the wire (or differenced from samples on
   * v3). The impact detector raises a dust source when the body just lost a
   * lot of speed -- it hit something.
   */
  private noteDustVelocity(
    key: number, body: LedgerBody, tick: number,
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
  ): void {
    if (!dustEnabled()) return;
    let mass = 0;
    let radius = 0;
    const slots = body.chunkSlots;
    const scanned = Math.min(slots.length, 64);
    for (let i = 0; i < scanned; i += 1) {
      mass += this.topology.restMassOf(slots[i]);
      const r = this.topology.chunkRadiusOf(slots[i]);
      if (r > radius) radius = r;
    }
    if (scanned < slots.length) mass *= slots.length / scanned;
    // A body of many chunks is bigger than its biggest chunk.
    radius = Math.min(6, radius * (1 + Math.cbrt(slots.length) * 0.5));
    let leadMs = 0;
    if (this.renderClockTick >= 0) {
      const presentedTick = this.renderClockTick - this.sampleDelaySmooth;
      leadMs = Math.min(500, Math.max(0, ((tick - presentedTick) / this.tickRate) * 1000));
    }
    const before = this.dustQueue.dropped;
    if (this.dustImpacts.noteVelocity(
      key, body.structureId, tick, x, y, z, vx, vy, vz, mass, radius,
      performance.now() + leadMs, this.dustQueue,
    )) {
      this.dustSourcesTotal += 1 + (this.dustQueue.dropped - before);
    }
  }

  private extractDust(message: TopologyMessage): void {
    if (!dustEnabled()) return;
    // How far this message's tick is ahead of what is on screen. Wire v3 and
    // holdTopology apply at the sample clock, so ~0; wire v2 applies at
    // arrival, a playout delay ahead. Born that far in the future, the puff
    // appears with the crack rather than before it.
    let leadMs = 0;
    if (this.renderClockTick >= 0) {
      const presentedTick = this.renderClockTick - this.sampleDelaySmooth;
      leadMs = Math.max(0, ((message.simTick - presentedTick) / this.tickRate) * 1000);
      // A bootstrap or a valve release can put the tick far from the clock;
      // a puff a second late is a puff nobody connects to anything.
      leadMs = Math.min(leadMs, 500);
    }
    const before = this.dustQueue.dropped;
    this.dustContext.nowMs = performance.now();
    const pushed = extractDustSources(message, this.dustContext, this.dustQueue, performance.now() + leadMs);
    this.dustSourcesTotal += pushed + (this.dustQueue.dropped - before);
  }

  /**
   * Hands every queued dust source to `visit`, oldest first, and empties the
   * queue. The source object is reused between calls: copy what you keep.
   */
  drainDustSources(visit: (source: DustSource) => void): number {
    return this.dustQueue.drain(visit);
  }

  /** Sources that arrived faster than frames drained them. Cumulative. */
  dustQueueDropped(): number {
    return this.dustQueue.dropped;
  }

  /**
   * Speed of a body's last presented sample, m/s, or 0 if it has none.
   *
   * For the renderer's teleport probe: a step is only anomalous if the body's
   * own motion cannot account for it, and the body's own motion is known here.
   */
  bodyPresentedSpeed(key: number): number {
    return this.bodies.get(key)?.lastPresentedSpeed ?? 0;
  }

  /** The track's velocity at the last presented sample, or null (wire v3 has none). */
  bodyPresentedVelocity(key: number): Vec3 | null {
    return this.bodies.get(key)?.lastPresentedVelocity ?? null;
  }

  /** Bodies the last sample presented. Read-only; replaced every frame. */
  liveBodyKeys(): ReadonlySet<number> {
    return this.lastLive;
  }

  private lastLive: ReadonlySet<number> = new Set();

  /** Route one raw server packet (kind 119-122). */
  handlePacket(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    this.bytesReceived += bytes.length;
    const now = performance.now();
    this.bytesWindow.push({ at: now, bytes: bytes.length });
    while (this.bytesWindow.length > 0 && now - this.bytesWindow[0].at > 2000) {
      this.bytesWindow.shift();
    }
    switch (bytes[0]) {
      case PKT_CITY_CHUNKS:
        // A v3 match never ranks poses per client; any stray v2 datagram
        // (e.g. from a mid-deploy server) is ignored rather than mixed in.
        if (this.debris === null) {
          this.handleChunks(decodeChunksDatagram(bytes));
        }
        break;
      case PKT_CITY_DEBRIS: {
        if (this.debris === null) {
          break;
        }
        const started = performance.now();
        const header = decodeDebrisHeader(bytes);
        this.observeArrival(header.spanTick, now);
        if (header.spanTick > this.latestSimTick) {
          this.observeSimTick(header.spanTick);
        }
        try {
          if (this.lastSpanTick >= 0 && header.spanTick > this.lastSpanTick) {
            const delta = header.spanTick - this.lastSpanTick;
            if (delta <= 32) {
              this.spanTicksEma = 0.9 * this.spanTicksEma + 0.1 * delta;
            }
          }
          if (header.spanTick > this.lastSpanTick) {
            this.lastSpanTick = header.spanTick;
          }
          this.recordsApplied += this.debris.push_payload(
            header.compression,
            header.epoch,
            bytes.subarray(header.bodyOffset),
          );
        } catch (error) {
          // A malformed datagram is dropped like a lost one; the nack loop
          // and restatement heal whatever it carried.
          recordCityEvent('city_suspect_record', { error: String(error) });
        }
        this.datagramsReceived += 1;
        this.decodeMsWindow.push(performance.now() - started);
        if (this.decodeMsWindow.length > 240) {
          this.decodeMsWindow.shift();
        }
        break;
      }
      case PKT_CITY_LANES: {
        const { epoch, entries } = decodeCityLanes(bytes);
        for (const [lane, entity] of entries) {
          const previous = this.laneToEntity.get(lane);
          if (previous !== undefined && previous !== entity) {
            this.entityToLane.delete(previous);
            this.lastSamplePos.delete(previous);
            this.lastSamplePos.delete(entity);
            // Epoch ordering makes lane reuse SOUND: the decoder refuses
            // records from packets stamped before this assignment (the old
            // tenant's), and accepts the new tenant's even when they raced
            // ahead of this reliable message. This replaced a 5 m
            // discontinuity heuristic, a 12-tick hold, and a nack-heal
            // round trip.
            this.debris?.assign_lane(lane, epoch);
          } else if (previous === undefined) {
            // Fresh lane: same rule, so a late packet from a lost earlier
            // tenancy can never leak through.
            this.debris?.assign_lane(lane, epoch);
          }
          // The entity's old lane must stop writing it too: a parked Rest
          // holds a samplable pose indefinitely, so a stale lane->entity
          // entry keeps fighting the new lane every frame.
          const previousLane = this.entityToLane.get(entity);
          if (previousLane !== undefined && previousLane !== lane) {
            this.laneToEntity.delete(previousLane);
            this.debris?.clear_lane_until(previousLane, this.latestSimTick);
          }
          this.laneToEntity.set(lane, entity);
          this.entityToLane.set(entity, lane);
        }
        break;
      }
      case PKT_CITY_TOPOLOGY: {
        // The server sends a bootstrap to every joiner before any topology.
        // If topology arrives first, the bootstrap was dropped or lost — and
        // accepting the stream anyway would silently run an INTACT ledger:
        // every pre-join fracture invisible, settled islands never streaming
        // again to correct it. The first live message is the only evidence,
        // so it triggers the resync instead of being applied.
        if (!this.bootstrapped) {
          if (!this.resyncRequested) {
            this.resyncRequested = true;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
          }
          break;
        }
        const message = decodeTopology(bytes);
        // Wire v3: the ledger must not run ahead of the pose stream. Sampled
        // poses are read at renderTick-6, so applying a migration's new
        // membership/COM immediately would compose 100 ms of old-basis poses
        // against the new basis -- measured as meter-scale per-frame chunk
        // teleports. Queue the message and apply it when the sample clock
        // reaches its tick (sampleDebris drains this every frame).
        //
        // Tried on v2 as well, because the artefact this describes is exactly
        // what a collapse looks like there, and reverted: it changed the drawn
        // teleport rate from 1.55 to 1.85 per broken bond, inside the run-to-run
        // spread, and introduced 455 clock rollbacks that were not there before.
        // The v2 artefact has a different cause; see the settle handling below.
        if (this.debris !== null || HOLD_TOPOLOGY_ON_V2) {
          this.pendingTopology.push({ message, receivedAtMs: performance.now() });
          break;
        }
        this.acceptTopology(message, false);
        break;
      }
      case PKT_CITY_BASELINE:
        this.handleBaseline(decodeBaseline(bytes));
        break;
      case PKT_CITY_BOOTSTRAP: {
        const message = decodeBootstrap(bytes);
        // Where everything is drawn, if this is a RESYNC rather than a join.
        //
        // A bootstrap replaces the whole ledger and clears every presentation
        // track, so the entire city moves to the bootstrapped poses in a single
        // frame. That is right for a join or a city reset, where there is
        // nothing on screen to be continuous with -- and wrong for a resync,
        // where the same world is still being drawn and only the client's copy
        // of it was holed. Toppling a tower produced runs with 48,210 drawn
        // chunk teleports, which is twice the city's 24,105 chunks: two
        // whole-city jumps, and nothing else in a collapse moves every chunk
        // at once.
        const drawnBefore = this.bootstrapped ? this.captureAllDrawnPoses() : null;
        this.topology.applyBootstrap(message);
        if (drawnBefore) {
          this.restoreDrawnPosesAfterBootstrap(drawnBefore);
        }
        this.bodies.clear();
        this.kinetic.clear();
        this.pendingRecords = [];
        this.awaitingTopology.clear();
        this.lastSampleTick = -1;
        // Drop every held topology message. A bootstrap is a complete state
        // snapshot, so anything queued before it is stale by construction --
        // and comparing sequence numbers across it is WRONG, because a city
        // reset rebuilds the encoder and restarts the sequence at zero. That
        // comparison (added with the topology hold-back) kept 75 messages of
        // the DESTROYED world, which drained after the bootstrap and dragged
        // lastTopoSeq back up; every message of the fresh world then looked
        // like a duplicate and was silently discarded. The city rendered
        // intact and no shot ever changed it again. Messages that genuinely
        // postdate the bootstrap arrive after it on the ordered reliable
        // channel; the seq-gap resync path covers the same-tick race.
        this.pendingTopology.length = 0;
        // Copies belong to the stream position the bootstrap replaced.
        this.topologyPieces.clear();
        this.topologyAhead.clear();
        this.topologyApplied.length = 0;
        this.lastReliableTopoSeq = message.topoSeq;
        this.lastAppliedTopoTick = message.simTick;
        // A bootstrap means the world was REPLACED (join, resync, or a city
        // reset). Every lane-keyed thing describes the old world: the server
        // rebuilds its encoder, so lane ids restart from zero and its epoch
        // restarts with them. Keeping the old map silently routes the new
        // world's poses to bodies that no longer exist -- the city renders
        // intact and nothing ever moves again, which is exactly how a reset
        // after heavy damage failed in play.
        this.laneToEntity.clear();
        this.entityToLane.clear();
        this.lastSamplePos.clear();
        this.debris?.reset_all_lanes();
        // Pose-stream clocks belong to the old world too.
        this.lastSpanTick = -1;
        this.spanTicksEma = 6;
        // A reset restarts the tick count; the old arrivals say nothing.
        this.tickArrivals.length = 0;
        this.sampleDelaySmooth = MIN_SAMPLE_DELAY_TICKS;
        this.clockLeads.length = 0;
        this.streamAliveAtMs = 0;
        this.playoutTarget = Number.NaN;
        this.renderClockTick = -1;
        // A new ledger: no body's last velocity is the same body's.
        this.dustImpacts.clear();
        this.dustSamplePrev.clear();
        this.settledAtTick.clear();
        this.baselineGenerations.clear();
        this.resyncRequested = false;
        this.bootstrapped = true;
        this.bootstrapCount += 1;
        noteClientEvent('bootstrap', { topoSeq: message.topoSeq, simTick: message.simTick });
        this.repaintAll = true;
        this.repaintBodies.clear();
        // Bootstrap names the generation in flight. Recording it (empty) means
        // the parts that follow accumulate into it rather than being treated
        // as a rollover that discards what came before.
        this.baselineId = message.baselineId;
        this.baselineGenerations.set(message.baselineId, new Map());
        break;
      }
      case PKT_CITY_TOPO_HASH: {
        if (!this.bootstrapped) {
          break;
        }
        const message = decodeTopologyHashes(bytes);
        // Only compare at the position the hashes describe. During a cascade
        // (or the v3 hold-back) our applied seq lags the message's and the
        // comparison would be meaningless — the detector targets STEADY
        // divergence, which quiet periods expose within one interval.
        if (message.topoSeq !== this.topology.lastSeq()) {
          break;
        }
        this.hashChecks += 1;
        const local = this.topology.structureHashes();
        const mismatched: number[] = [];
        for (const entry of message.hashes) {
          const ours = local.get(entry.structureId);
          if (ours && (ours.laneA !== entry.laneA || ours.laneB !== entry.laneB)) {
            mismatched.push(entry.structureId);
          }
        }
        if (mismatched.length > 0) {
          this.hashMismatches += 1;
          noteClientEvent('hashMismatch', { structures: mismatched, topoSeq: message.topoSeq });
          const nowMs = performance.now();
          if (nowMs - this.lastResyncAtMs >= RESYNC_MIN_INTERVAL_MS) {
            this.lastResyncAtMs = nowMs;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq(), mismatched));
          } else {
            this.resyncsSuppressed += 1;
          }
        }
        break;
      }
      case PKT_CITY_STRUCTURE_BOOTSTRAP: {
        if (!this.bootstrapped) {
          break;
        }
        const message = decodeStructureBootstrap(bytes);
        // The repair restates content at a seq, so the ledger must BE at that
        // seq. Held v3 messages are applied now — a one-frame basis jump on a
        // repair beats comparing state across different positions.
        while (this.pendingTopology.length > 0) {
          this.applyTopologyMessage(this.pendingTopology.shift()!.message);
        }
        // Datagram copies may have carried the ledger past the seq the repair
        // restates (it waited behind them on the reliable stream). Restate,
        // then re-apply what the copies applied since, for those structures.
        const replay = this.topologyAppliedAfter(message.topoSeq);
        if (replay) {
          this.repairsBehindCopies += 1;
        } else if (message.topoSeq !== this.topology.lastSeq()) {
          // A real gap opened between request and repair; only the full path
          // can recover the stream position itself.
          if (!this.resyncRequested) {
            this.resyncRequested = true;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
          }
          break;
        }
        const repaired = new Set(message.structures.map((structure) => structure.structureId));
        // Where every affected body is DRAWN, before the repair replaces it.
        //
        // A repair rewrites the ledger pose of every body in the structure and
        // then deleted every presentation track for it, so there was nothing
        // left to carry the change: the whole structure moved to the repaired
        // poses in one frame. The city is authored as ONE structure, so that is
        // the entire city jumping at once, which is what a player watching a
        // collapse reports as a big part of the building teleporting. Repairs
        // are not rare during heavy destruction -- a rejected settle asks for
        // one, and a live session counted 32.
        const drawnBefore = new Map<number, { position: Vec3; rotation: Quat }>();
        for (const body of this.topology.allBodies()) {
          if (repaired.has(body.structureId) && this.bodies.has(body.key)) {
            drawnBefore.set(body.key, {
              position: [body.position[0], body.position[1], body.position[2]],
              rotation: [...body.rotation] as Quat,
            });
          }
        }
        this.topology.applyStructureBootstrap(message);
        if (replay) {
          for (const later of replay) {
            this.topology.reapplyForStructures(later, repaired);
          }
        }
        for (const key of this.awaitingTopology.keys()) {
          if (this.topology.body(key)) this.awaitingTopology.delete(key);
        }
        noteClientEvent('structureRepair', {
          topoSeq: message.topoSeq,
          structures: message.structures.map((structure) => structure.structureId),
        });
        const repairRenderTick = this.renderTickNow(performance.now());
        for (const key of [...this.bodies.keys()]) {
          if (!repaired.has(bodyKeyParts(key).structureId)) {
            continue;
          }
          const body = this.topology.body(key);
          const state = this.bodies.get(key);
          const before = drawnBefore.get(key);
          if (!body || !state || !before) {
            // Gone from the repaired ledger, or never had a track: there is
            // nothing to glide and the repaired pose stands.
            this.bodies.delete(key);
            this.kinetic.delete(key);
            continue;
          }
          // Glide instead: put the drawn pose back, anchor the track to it, and
          // hand it the repaired pose to move to over the usual correction.
          const target: Vec3 = [body.position[0], body.position[1], body.position[2]];
          const targetRotation = [...body.rotation] as Quat;
          this.topology.updateBodyPose(key, before.position, before.rotation, 'presented');
          state.track.seedPresented(
            {
              position: before.position,
              rotation: before.rotation,
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
            repairRenderTick,
          );
          state.track.push({
            tick: message.simTick,
            position: target,
            rotation: targetRotation,
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
            class: PresentationClass.Quiescent,
          });
          state.lastTick = message.simTick;
          this.kinetic.add(key);
          this.repairBodiesGlided += 1;
        }
        this.structureRepairs += 1;
        // Repaint ONLY the repaired structures — restating the whole world
        // here would reintroduce the full-bootstrap pop this path exists to
        // remove. The repaired structures' bodies (support included) cover
        // exactly the slots the repair rewrote.
        for (const body of this.topology.allBodies()) {
          if (repaired.has(body.structureId)) {
            this.repaintBodies.add(body.key);
          }
        }
        break;
      }
      default:
        break;
    }
    // Packet handling runs in the datagram reader's microtasks, between frames
    // -- it never shows up in the frame's CPU span, so it is accumulated here
    // and attributed to the frame that follows it.
    addDecodeMs(performance.now() - now);
  }

  /**
   * Apply one reliable topology message to the ledger, with every side effect
   * (promotion seeding, repaints, settle/retire lane clearing, resync check).
   * Wire v2 calls this on packet arrival; wire v3 defers through
   * `pendingTopology` so the ledger basis never runs ahead of the sampled
   * pose stream.
   */
  private applyTopologyMessage(message: TopologyMessage): void {
    // Read where the chunks about to be re-parented are drawn, before the
    // ledger moves them.
    this.captureDrawnPoses(message);
    // Where every settling body is drawn right now, so the settle's hard write
    // to the ledger can be put back.
    //
    // `topology.apply` assigns `body.position` from the settle directly,
    // bypassing `updateBodyPose` entirely -- which is why these writes carry no
    // pose source and why no jump counter in this client could see them. The
    // glide added for settles pushes the rest pose into the track, but the
    // ledger had already been overwritten underneath it, and the ledger is
    // what the render layer composes from. A body not in the live set that
    // frame is therefore drawn at the rest pose immediately, a whole playout
    // delay of motion in one frame: 3,756 of 6,980 drawn teleports in a
    // scripted collapse, all of them `settled=true` with no writer named, most
    // between four and thirty-two metres.
    const settledBefore = SETTLE_GLIDE ? this.captureSettlePoses(message) : null;
    const applied = this.topology.apply(message);
    if (settledBefore) {
      for (const [key, pose] of settledBefore) {
        // Only where a track survives to glide it: without one there is
        // nothing to carry the body to its rest pose and the hard write is the
        // only thing that would ever put it there.
        if (this.bodies.has(key)) {
          this.topology.updateBodyPose(key, pose.position, pose.rotation, 'presented');
          this.settlesRestored += 1;
        } else {
          // No track: the hard write stands, because nothing else would ever
          // move this body to where the server says it stopped.
          this.settlesLeftHard += 1;
        }
      }
    }
        if (applied) {
          this.seedPromotions(message);
          // Before the settle loop below closes tracks: an impact is weighed by
          // the speed the body was last drawn at, and that dies with the track.
          this.extractDust(message);
          for (const batch of message.batches) {
            for (const promotion of batch.promotions) {
              this.repaintBodies.add(bodyKey(promotion.structureId, promotion.islandId));
            }
            for (const migration of batch.migrations) {
              this.repaintBodies.add(bodyKey(batch.structureId, migration.fromIslandSerial));
              this.repaintBodies.add(bodyKey(batch.structureId, migration.toIslandSerial));
            }
          }
          for (const settle of message.settled) {
            this.repaintBodies.add(bodyKey(settle.structureId, settle.islandId));
          }
          // The timeline a debug report reads its jump rings against. "Chunks
          // flicker when a building comes down" is a claim about coincidence,
          // and no ring of jumps can support or refute it without the fractures
          // to line them up with.
          noteFracture({
            simTick: message.simTick,
            topoSeq: message.topoSeq,
            promotions: message.batches.reduce((n, b) => n + b.promotions.length, 0),
            migrations: message.batches.reduce((n, b) => n + b.migrations.length, 0),
            retires: message.batches.reduce((n, b) => n + b.retiredIslandIds.length, 0),
            settles: message.settled.length,
            brokenBonds: message.batches.reduce((n, b) => n + b.brokenBondIndices.length, 0),
          });
          for (const wake of message.wakes) {
            this.repaintBodies.add(bodyKey(wake.structureId, wake.islandSerial));
          }
          // Settle closes tracks.
          for (const settle of message.settled) {
            const key = bodyKey(settle.structureId, settle.islandId);
            // Hand the rest pose to the track before dropping it, so the body
            // GLIDES the last stretch instead of cutting to it.
            //
            // A settle carries the pose at the settle tick; the body is being
            // drawn a playout delay behind that, which for debris at 40-70 m/s
            // is several metres. Deleting the track and writing the rest pose
            // in the same frame spends that whole gap in one frame, per body.
            // In a collapse that is thousands of chunks each stepping metres --
            // measured at 4,082 drawn teleports the chunks' own trajectories
            // could not explain, over one building, on loopback, 97% of them on
            // bodies in exactly this state. It is the flicker reported from
            // play.
            //
            // The track already knows how to absorb a late revision: it
            // re-anchors to the pose on screen and glides the correction over
            // correctionSeconds. Pushed as a zero-velocity snapshot, a settle
            // is just one more revision, and the body stops where the server
            // says it stopped -- a quarter-second later instead of instantly.
            // The per-frame sampler drops the track itself once it converges
            // (`lastSampleSettled`), so nothing has to decide when that is.
            const settling = SETTLE_GLIDE ? this.bodies.get(key) : undefined;
            if (settling) {
              settling.track.push({
                tick: message.simTick,
                position: settle.position,
                rotation: settle.rotation,
                linearVelocity: [0, 0, 0],
                angularVelocity: [0, 0, 0],
                class: PresentationClass.Quiescent,
              });
              settling.settledHint = true;
              this.kinetic.add(key);
            } else {
              this.bodies.delete(key);
              this.kinetic.delete(key);
            }
            // Dropping the track also drops its per-body staleness guard, so
            // without this a pre-settle datagram still in flight would look
            // new, overwrite the authoritative rest pose, and stick -- the
            // body is asleep, so no later update ever corrects it. The guard
            // is deliberately NOT cleared on wake: a settle tick only ever
            // moves forward, so it keeps rejecting genuinely older records
            // while letting every post-wake record through.
            this.settledAtTick.set(key, message.simTick);
            // Wire v3: the reliable settle owns the pose from here; an
            // in-flight span must not resurrect the body with stale physics.
            // Both map directions must still agree: this apply runs delayed,
            // and the lane may have been reassigned in the meantime -- a
            // stale clear would gut the NEW tenant's stream.
            const lane = this.entityToLane.get(key);
            if (lane !== undefined && this.laneToEntity.get(lane) === key) {
              this.debris?.clear_lane_until(lane, message.simTick);
            }
          }
          // A retired island will never stream again; without this its track
          // is sampled for the rest of the match.
          for (const batch of message.batches) {
            for (const islandId of batch.retiredIslandIds) {
              const key = bodyKey(batch.structureId, islandId);
              this.bodies.delete(key);
            this.kinetic.delete(key);
              this.settledAtTick.delete(key);
              const lane = this.entityToLane.get(key);
              if (lane !== undefined && this.laneToEntity.get(lane) === key) {
                this.debris?.clear_lane_until(lane, message.simTick);
                this.entityToLane.delete(key);
                this.laneToEntity.delete(lane);
              } else if (lane !== undefined) {
                // Lane already reassigned; just drop the retired entity's map.
                this.entityToLane.delete(key);
              }
            }
          }
          this.drainPending();
        }
        // Checked independently of `applied`: a successful apply still flags
        // faults when a migration names an island the client does not have,
        // and that chunk stays on the wrong body until a repair replaces it.
        //
        // Two tiers, and the split is what broke the 3.0-second popping loop:
        // a seq GAP costs the stream position and only the full bootstrap can
        // recover it — but the cascade-time faults (missing migration
        // destination, settle-frame reject) corrupt ONE structure's content
        // at a position both sides still agree on. Those used to escalate to
        // the full path too: every world rebuild repainted all 96k chunks,
        // and with the faults recurring each collapse, the whole rubble field
        // visibly snapped on the rate-limiter's exact 3.0 s cadence.
        const nowMs = performance.now();
        if (this.topology.needsResync && !this.resyncRequested) {
          if (nowMs - this.lastResyncAtMs >= RESYNC_MIN_INTERVAL_MS) {
            this.lastResyncAtMs = nowMs;
            this.resyncRequested = true;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
          } else {
            this.resyncsSuppressed += 1;
          }
        } else if (this.topology.resyncStructures.size > 0 && !this.resyncRequested) {
          // Same spacing as the full path: the repair covers every fault
          // accumulated by send time, so waiting costs delay, not repair.
          // The set stays populated until the structure bootstrap lands and
          // clears it, so a lost request re-fires on the next interval.
          if (nowMs - this.lastResyncAtMs >= RESYNC_MIN_INTERVAL_MS) {
            this.lastResyncAtMs = nowMs;
            this.sendResync(
              encodeCityResyncRequest(this.topology.lastSeq(), [
                ...this.topology.resyncStructures,
              ]),
            );
          } else {
            this.resyncsSuppressed += 1;
          }
        }
  }

  private handleBaseline(message: BaselineMessage): void {
    noteBaseline(message.baselineId, message.simTick);
    let poses = this.baselineGenerations.get(message.baselineId);
    if (!poses) {
      poses = new Map();
      this.baselineGenerations.set(message.baselineId, poses);
      this.baselineId = message.baselineId;
      // Retire by age, not on arrival of a newer generation: the one being
      // replaced still has deltas in flight against it.
      while (this.baselineGenerations.size > 2) {
        const oldest = this.baselineGenerations.keys().next();
        if (oldest.done) {
          break;
        }
        this.baselineGenerations.delete(oldest.value);
      }
    }
    for (const record of message.records) {
      poses.set(record.bodyEntity, record.position);
    }
  }

  private handleChunks(datagram: ChunksDatagram): void {
    this.datagramsReceived += 1;
    // Topology copies first: a promotion they carry is what this datagram's
    // records for the new body resolve against.
    if (datagram.topologyParts) {
      for (const part of datagram.topologyParts) {
        this.acceptTopologyPart(part);
      }
    }
    // A datagram with no records carries only topology copies, stamped no
    // newer than the previous send: it says nothing about the pose clock's
    // rate or anchor. It does say the server is still streaming, so the lead
    // cap keeps holding (see `streamAliveAtMs`).
    if (datagram.records.length === 0 && datagram.topologyParts) {
      if (datagram.simTick >= this.latestSimTick) {
        this.streamAliveAtMs = performance.now();
      }
      return;
    }
    // Re-anchoring the clock on a datagram that did not advance the tick --
    // a reordered packet, or the 2nd..Nth of one tick's MTU-split burst --
    // walks render time backwards, which `PresentationTrack.sample` is
    // documented not to accept. Advance the anchor only with the tick.
    this.observeArrival(datagram.simTick, performance.now());
    if (datagram.simTick > this.latestSimTick) {
      this.observeSimTick(datagram.simTick);
    }
    let deferred = false;
    for (const record of datagram.records) {
      if (!this.applyRecord(datagram, record)) {
        deferred = true;
      }
    }
    if (deferred) {
      // Keep the datagram briefly; topology for a fresh promotion may still
      // be in flight on the reliable stream.
      this.pendingRecords.push(datagram);
      if (this.pendingRecords.length > 64) {
        this.pendingRecords.shift();
      }
    }
  }

  /**
   * One topology message, from the reliable stream (`copy` false) or a
   * datagram copy (wire v2, `EncoderConfig::topology_datagram_copies`).
   *
   * The ledger must see every message once and in seq order. The reliable
   * stream is ordered, so on its own it never skips; the copies are not, and
   * either may arrive first. A message is applied when it is the next seq,
   * held when an earlier one is still missing (the copy of it was lost and
   * its reliable message is on the way), and dropped when already applied.
   */
  private acceptTopology(message: TopologyMessage, copy: boolean): void {
    const last = this.topology.lastSeq();
    if (!copy) {
      if (message.topoSeq <= last && message.topoSeq > this.lastReliableTopoSeq && last !== 0) {
        // Its copy got here first.
        this.lastReliableTopoSeq = message.topoSeq;
        this.topologyReliableAfterCopy += 1;
        return;
      }
      this.lastReliableTopoSeq = message.topoSeq;
      this.applyTopologyMessage(message);
      this.recordApplied(message);
      this.drainTopologyAhead();
      return;
    }
    if (!this.bootstrapped || this.debris !== null || HOLD_TOPOLOGY_ON_V2) {
      return;
    }
    // Bootstrapped, so `last` is the stream position even at 0 (a fresh
    // world): a copy applies only as the very next seq.
    if (message.topoSeq <= last) {
      this.topologyCopiesLate += 1;
      return;
    }
    if (message.topoSeq !== last + 1) {
      if (this.topologyAhead.size < TOPOLOGY_AHEAD_MAX) {
        this.topologyAhead.set(message.topoSeq, { message, atMs: performance.now() });
      }
      return;
    }
    this.topologyCopiesApplied += 1;
    this.applyTopologyMessage(message);
    this.recordApplied(message);
    this.drainTopologyAhead();
  }

  /** Apply held copies that are now next in seq. */
  private drainTopologyAhead(): void {
    for (;;) {
      const last = this.topology.lastSeq();
      for (const seq of this.topologyAhead.keys()) {
        if (seq <= last) this.topologyAhead.delete(seq);
      }
      for (const seq of this.topologyPieces.keys()) {
        if (seq <= last) this.topologyPieces.delete(seq);
      }
      const next = this.topologyAhead.get(last + 1)?.message;
      if (!next) return;
      this.topologyAhead.delete(last + 1);
      this.topologyCopiesApplied += 1;
      this.applyTopologyMessage(next);
      this.recordApplied(next);
    }
  }

  private recordApplied(message: TopologyMessage): void {
    this.lastAppliedTopoTick = message.simTick;
    this.topologyApplied.push(message);
    if (this.topologyApplied.length > TOPOLOGY_APPLIED_KEPT) {
      this.topologyApplied.shift();
    }
  }

  /**
   * The messages applied after `seq`, oldest first, when the ledger is past
   * it and every one of them is still kept; otherwise null.
   */
  private topologyAppliedAfter(seq: number): TopologyMessage[] | null {
    const last = this.topology.lastSeq();
    if (seq >= last) {
      return null;
    }
    const after = this.topologyApplied.filter((message) => message.topoSeq > seq);
    if (after.length !== last - seq || after[0].topoSeq !== seq + 1) {
      return null;
    }
    return after;
  }

  /** One piece of a topology message's datagram copy. */
  private acceptTopologyPart(part: TopologyPart): void {
    if (!this.bootstrapped || this.debris !== null || HOLD_TOPOLOGY_ON_V2) {
      return;
    }
    const last = this.topology.lastSeq();
    if (part.topoSeq <= last) {
      this.topologyPieces.delete(part.topoSeq);
      this.topologyCopiesLate += part.parts === 1 ? 1 : 0;
      return;
    }
    let bytes: Uint8Array | null = null;
    if (part.parts === 1) {
      bytes = part.bytes;
    } else {
      let entry = this.topologyPieces.get(part.topoSeq);
      if (!entry || entry.parts !== part.parts) {
        entry = { parts: part.parts, got: new Array(part.parts).fill(undefined), count: 0, atMs: performance.now() };
        this.topologyPieces.set(part.topoSeq, entry);
        if (this.topologyPieces.size > TOPOLOGY_AHEAD_MAX) {
          const oldest = Math.min(...this.topologyPieces.keys());
          this.topologyPieces.delete(oldest);
        }
      }
      if (entry.got[part.part] === undefined) {
        entry.got[part.part] = part.bytes;
        entry.count += 1;
      }
      if (entry.count < entry.parts) {
        return;
      }
      this.topologyPieces.delete(part.topoSeq);
      const total = entry.got.reduce((sum, piece) => sum + piece!.length, 0);
      bytes = new Uint8Array(total);
      let at = 0;
      for (const piece of entry.got) {
        bytes.set(piece!, at);
        at += piece!.length;
      }
    }
    let message: TopologyMessage;
    try {
      message = decodeTopology(bytes);
    } catch (error) {
      recordCityEvent('city_suspect_record', { error: String(error), topologyCopy: part.topoSeq });
      return;
    }
    if (message.topoSeq !== part.topoSeq) {
      return;
    }
    this.acceptTopology(message, true);
  }

  private drainPending(): void {
    // Evidence the ledger has now caught up with: the promotion landed.
    for (const key of this.awaitingTopology.keys()) {
      if (this.topology.body(key)) {
        this.awaitingTopology.delete(key);
      }
    }
    if (this.pendingRecords.length === 0) {
      return;
    }
    const pending = this.pendingRecords;
    this.pendingRecords = [];
    for (const datagram of pending) {
      let deferred = false;
      for (const record of datagram.records) {
        if (!this.applyRecord(datagram, record)) {
          deferred = true;
        }
      }
      // Still waiting on a later promotion: keep it, or its records are lost
      // to whichever unrelated topology message happened to drain first.
      // Re-applying the records that did resolve is a no-op (the per-body
      // tick guard).
      if (deferred) {
        this.pendingRecords.push(datagram);
      }
    }
    if (this.pendingRecords.length > 64) {
      this.pendingRecords.splice(0, this.pendingRecords.length - 64);
    }
  }

  /**
   * A record named a body the ledger does not have: a promotion in flight.
   *
   * Only the first record counts (the promotion is at or just before it), and
   * only while the presentation has not already passed it: holding a clock
   * that is already beyond the fracture cannot put the chunks back on the
   * right body, it would only stop everything else.
   */
  private noteAwaitingTopology(key: number, tick: number): void {
    if (!HOLD_FOR_MISSING_TOPOLOGY || this.debris !== null || this.awaitingTopology.has(key)) {
      return;
    }
    if (tick - TOPOLOGY_HOLD_TICKS_BEFORE_RECORD <= this.lastSampleTick) {
      return;
    }
    this.awaitingTopology.set(key, { tick, atMs: performance.now() });
  }

  /**
   * The latest tick the presentation may sample while a topology message is
   * known to be missing, or +Infinity.
   *
   * Datagram copies make a gap visible: a later message (or a piece of the
   * missing one) arrived while the next seq did not. The missing message is
   * no earlier than the tick after the last one applied, and its first piece,
   * when it arrived, carries its tick exactly. Holding below that tick keeps
   * its chunks from being drawn on the body they are leaving until the
   * message (a repeat copy, or the reliable stream) lands. Bounded like the
   * record evidence, by TOPOLOGY_HOLD_MAX_MS from the first sign of the gap.
   */
  private topologyGapLimit(nowMs: number): number {
    if (this.topologyPieces.size === 0 && this.topologyAhead.size === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const last = this.topology.lastSeq();
    let firstSeenMs = Number.POSITIVE_INFINITY;
    for (const [seq, entry] of this.topologyPieces) {
      if (seq > last) firstSeenMs = Math.min(firstSeenMs, entry.atMs);
    }
    for (const [seq, entry] of this.topologyAhead) {
      if (seq > last) firstSeenMs = Math.min(firstSeenMs, entry.atMs);
    }
    if (!Number.isFinite(firstSeenMs) || nowMs - firstSeenMs > TOPOLOGY_HOLD_MAX_MS) {
      return Number.POSITIVE_INFINITY;
    }
    // The missing message's tick: exact from its first piece (after the kind
    // and version bytes and the u32 seq), else the least it can be.
    let tick = this.lastAppliedTopoTick + 1;
    const first = this.topologyPieces.get(last + 1)?.got[0];
    if (first && first.length >= TOPOLOGY_TICK_OFFSET + 4) {
      tick = new DataView(first.buffer, first.byteOffset, first.byteLength)
        .getUint32(TOPOLOGY_TICK_OFFSET, true);
    }
    return tick - 1e-3;
  }

  /**
   * The latest tick the presentation may sample while promotions are in
   * flight, or +Infinity. Expired evidence is dropped here.
   */
  private topologyHoldLimit(nowMs: number): number {
    let limit = HOLD_FOR_MISSING_TOPOLOGY ? this.topologyGapLimit(nowMs) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(limit)) {
      this.topologyGapHoldFrames += 1;
    }
    for (const [key, entry] of this.awaitingTopology) {
      if (nowMs - entry.atMs > TOPOLOGY_HOLD_MAX_MS) {
        this.awaitingTopology.delete(key);
        this.topologyHoldExpired += 1;
        continue;
      }
      // Strictly below the tick before the record: the whole tick the
      // presentation shows must be one the promotion had not happened in.
      const cap = entry.tick - TOPOLOGY_HOLD_TICKS_BEFORE_RECORD - 1e-3;
      if (cap < limit) {
        limit = cap;
      }
    }
    return limit;
  }

  /** Creates and registers a body's presentation track. */
  private createBodyState(key: number): BodyStreamState {
    const track = new PresentationTrack(presentationConfig60Hz());
    // presentation.ts classifies every discontinuity it presents on purpose and
    // says so through this listener rather than logging, "so a measurement
    // harness can count them". Nothing had ever attached one, so the drawn pose
    // steps this branch measured could be attributed to no mechanism at all.
    // ONE listener. There is one slot, and there used to be two callers: a
    // counting one installed here and a recording one installed immediately
    // after it whenever the netlab recorder was running. The second replaced
    // the first, so the counters read zero in precisely the runs that were
    // being measured -- every A/B in this branch that quoted "correction snaps
    // 0" was quoting a listener that had been unhooked. A report from a live
    // session, which has no recorder, counted 4,054 implausible jumps in the
    // same regime those runs called clean.
    track.setAnomalyListener((anomaly) => {
      this.presentationAnomalies[anomaly.kind] += 1;
      if (anomaly.magnitude > this.presentationAnomalyMaxM) {
        this.presentationAnomalyMaxM = anomaly.magnitude;
      }
      if (!isRecording()) {
        return;
      }
      recordCityEvent(
        anomaly.kind === 'clock_rollback'
          ? 'city_clock_rollback'
          : anomaly.kind === 'correction_snap'
            ? 'city_snap'
            : 'city_implausible_jump',
        {
          body: key,
          magnitude: anomaly.magnitude,
          ...(anomaly.abandonedCorrectionM !== undefined
            ? { abandonedCorrectionM: anomaly.abandonedCorrectionM }
            : {}),
        },
      );
    });
    const state: BodyStreamState = { track, lastTick: 0, settledHint: false };
    // A body the ledger already knows is already ON SCREEN somewhere, so start
    // the track there instead of nowhere.
    //
    // This also replaces the raw placeholder write. `applyRecord` used to put
    // the first record straight into the ledger for a body with no presented
    // sample yet, because "a body that has never been sampled needs SOME
    // ledger pose or its chunks compose against garbage" -- and the ledger's
    // own current pose is a better answer than the newest streamed tick, which
    // is an interpolation delay ahead of everything drawn around it.
    //
    // The case this exists for is waking. A body that settles has its track
    // converge and close, and when the server wakes it the next record builds a
    // brand-new track with no history -- so the first sample jumps from the
    // pose its chunks have been drawn at since the settle to wherever the body
    // is now. `seedPromotions` does this for a freshly fractured island and the
    // starved-readmission path does it for a body that went unserved; a wake
    // fell between the two, because it has neither a captured drawn pose nor a
    // previous presented sample to be re-anchored to.
    const existing = this.topology.body(key);
    if (existing && SEED_ON_STARVED_READMISSION) {
      track.seedPresented(
        {
          position: [existing.position[0], existing.position[1], existing.position[2]],
          rotation: [...existing.rotation] as Quat,
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        },
        this.renderTickNow(performance.now()),
      );
      state.lastPresented = {
        position: [existing.position[0], existing.position[1], existing.position[2]],
        rotation: [...existing.rotation] as Quat,
      };
      this.wakeSeeds += 1;
    }
    this.bodies.set(key, state);
    this.kinetic.add(key);
    return state;
  }

  /**
   * Opens a presentation track for every island a fracture just created,
   * anchored to where its chunks are already on screen.
   *
   * Without this a promoted island has no track until its first datagram, so
   * `samplePresentation` never visits it, the render layer never marks it
   * dirty, and its chunks keep the pose of the body they broke off until a
   * record lands -- at which point they jump. Seeding turns that jump into the
   * same bounded glide a late packet gets.
   */
  private seedPromotions(message: TopologyMessage): void {
    for (const batch of message.batches) this.promotionsSeen += batch.promotions.length;
    if (this.latestSimTickAtMs === 0) {
      this.promotionsUnseeded += message.batches.reduce((n, b) => n + b.promotions.length, 0);
      // Nothing has been drawn yet, so there is no on-screen pose to hold.
      return;
    }
    const renderTick = this.renderTickNow(performance.now());
    for (const batch of message.batches) {
      for (const promotion of batch.promotions) {
        const key = bodyKey(promotion.structureId, promotion.islandId);
        // A promotion for a key we already hold is NOT serial reuse, which is
        // what this used to assume before skipping it. The server republishes
        // a body whose membership changed -- `promoted |= old->chunks !=
        // group.chunks` in the observation shim -- because a changed
        // membership moves the centre of mass the wire pose is expressed in.
        //
        // So this is exactly the case where the frame just moved and the
        // presented pose most needs anchoring to where the chunks are already
        // drawn. Skipping it left the existing track holding motion from the
        // old frame while records arrived in the new one, and the sample
        // alternated between them: a 110-chunk slab drawn at [-0.2, 25.8,
        // -0.8] and [-14.7, 0.3, 11.3] on consecutive frames, for about 250 ms
        // each time. Counted, because these are the expensive ones.
        if (this.bodies.has(key)) {
          this.promotionsSeedSkippedReused += 1;
        }
        const body = this.topology.body(key);
        if (!body || body.chunkSlots.length === 0) {
          this.promotionsSeedSkippedNoBody += 1;
          continue;
        }
        // Solve for the body pose that leaves the anchor chunk exactly where
        // it is being drawn: worldPose = bodyPos + R * localOffset.
        const anchor = body.chunkSlots[0];
        const drawn = this.drawnChunkPose.get(anchor);
        if (!drawn) {
          this.promotionsSeedSkippedNoDrawnPose += 1;
          continue;
        }
        this.promotionsSeeded += 1;
        const local = this.topology.chunkLocalOffset(anchor).position;
        const seedRotation = drawn.rotation;
        const worldOffset = qRotate(seedRotation, local);
        const state = this.createBodyState(key);
        state.track.seedPresented(
          {
            position: [
              drawn.position[0] - worldOffset[0],
              drawn.position[1] - worldOffset[1],
              drawn.position[2] - worldOffset[2],
            ],
            rotation: seedRotation,
            linearVelocity: promotion.linearVelocity,
            angularVelocity: promotion.angularVelocity,
          },
          renderTick,
        );
        state.track.push({
          tick: message.simTick,
          position: promotion.position,
          rotation: promotion.rotation,
          linearVelocity: promotion.linearVelocity,
          angularVelocity: promotion.angularVelocity,
          class: PresentationClass.Ballistic,
        });
        state.lastTick = message.simTick;
        if (isRecording()) {
          const seedDelta = Math.hypot(
            drawn.position[0] - worldOffset[0] - promotion.position[0],
            drawn.position[1] - worldOffset[1] - promotion.position[1],
            drawn.position[2] - worldOffset[2] - promotion.position[2],
          );
          recordCityEvent('city_seed', {
            body: key,
            simTick: message.simTick,
            renderTick,
            seedDeltaM: seedDelta,
            members: body.chunkSlots.length,
            speed: Math.hypot(
              promotion.linearVelocity[0],
              promotion.linearVelocity[1],
              promotion.linearVelocity[2],
            ),
          });
        }
      }
    }
  }

  /**
   * Where each chunk about to be re-parented is currently drawn, captured
   * before the ledger changes. Reused across the topology branch only.
   */
  private readonly drawnChunkPose = new Map<number, { position: Vec3; rotation: Quat }>();

  /**
   * Ledger poses of the bodies this message settles, before it is applied.
   *
   * Returned rather than stored because it is consumed on the next line; the
   * promotion capture keeps a member for the same reason in reverse -- it is
   * read much later, inside `seedPromotions`.
   */
  private captureSettlePoses(
    message: TopologyMessage,
  ): Map<number, { position: Vec3; rotation: Quat }> | null {
    if (message.settled.length === 0) {
      return null;
    }
    const out = new Map<number, { position: Vec3; rotation: Quat }>();
    for (const settle of message.settled) {
      const key = bodyKey(settle.structureId, settle.islandId);
      const body = this.topology.body(key);
      if (!body) {
        continue;
      }
      out.set(key, {
        position: [body.position[0], body.position[1], body.position[2]],
        rotation: [...body.rotation] as Quat,
      });
    }
    return out.size > 0 ? out : null;
  }

  /** Every body's current ledger pose: where its chunks are drawn right now. */
  private captureAllDrawnPoses(): Map<number, { position: Vec3; rotation: Quat }> {
    const out = new Map<number, { position: Vec3; rotation: Quat }>();
    for (const body of this.topology.allBodies()) {
      out.set(body.key, {
        position: [body.position[0], body.position[1], body.position[2]],
        rotation: [...body.rotation] as Quat,
      });
    }
    return out;
  }

  /**
   * Put the drawn poses back after a bootstrap, where that is still the same
   * body in the same place.
   *
   * A bootstrap replaces the whole ledger, and the tracks are cleared with it,
   * so without this the entire city moves to the bootstrapped poses in one
   * frame. That is right for a join or a city reset -- nothing is on screen to
   * be continuous with -- and wrong for a resync, where the same world is
   * still being drawn and only this client's copy of it was holed.
   *
   * The two are told apart by evidence rather than by a flag the wire does not
   * carry: a body is restored only if it still exists after the bootstrap and
   * has not moved further than a collapse could have moved it unnoticed. A
   * genuine world replacement satisfies neither -- its island serials restart,
   * so the old keys are mostly absent, and what survives is somewhere else
   * entirely. The next record then builds a track seeded from the restored
   * pose (see `createBodyState`) and glides to the bootstrapped one.
   */
  private restoreDrawnPosesAfterBootstrap(
    drawnBefore: Map<number, { position: Vec3; rotation: Quat }>,
  ): void {
    this.bootstrapPosesSeen += drawnBefore.size;
    for (const [key, pose] of drawnBefore) {
      const body = this.topology.body(key);
      if (!body) {
        this.bootstrapPosesGone += 1;
        continue;
      }
      const drift = Math.hypot(
        body.position[0] - pose.position[0],
        body.position[1] - pose.position[1],
        body.position[2] - pose.position[2],
      );
      if (drift > BOOTSTRAP_GLIDE_MAX_M) {
        this.bootstrapPosesSnapped += 1;
        continue;
      }
      if (drift > PRESENTATION_EPSILON_M) {
        this.topology.updateBodyPose(key, pose.position, pose.rotation, 'presented');
        this.bootstrapPosesGlided += 1;
      }
    }
  }

  private captureDrawnPoses(message: TopologyMessage): void {
    this.drawnChunkPose.clear();
    if (this.latestSimTickAtMs === 0) {
      return;
    }
    for (const batch of message.batches) {
      for (const promotion of batch.promotions) {
        for (const node of promotion.nodes) {
          const slot = this.topology.slotOf(promotion.structureId, node);
          if (this.drawnChunkPose.has(slot)) {
            continue;
          }
          const pose = this.topology.chunkWorldPose(slot);
          this.drawnChunkPose.set(slot, {
            position: [pose.position[0], pose.position[1], pose.position[2]],
            rotation: [...pose.rotation] as Quat,
          });
        }
      }
    }
  }

  private applyRecord(
    datagram: ChunksDatagram,
    record: ChunksDatagram['records'][number],
  ): boolean {
    const body = this.topology.body(record.bodyEntity);
    if (!body) {
      this.recordsBuffered += 1;
      this.noteAwaitingTopology(record.bodyEntity, datagram.simTick);
      return false;
    }
    // The settle arrived on the reliable channel carrying the authoritative
    // rest pose; anything the unreliable stream produced at or before that
    // tick is older news, whether it arrives late or gets replayed from the
    // pending buffer.
    const settledAt = this.settledAtTick.get(record.bodyEntity);
    if (settledAt !== undefined && datagram.simTick <= settledAt) {
      return true;
    }
    let position: Vec3;
    if (record.mode === RecordMode.Delta || record.mode === RecordMode.MotionDelta) {
      const generation = this.baselineGenerations.get(datagram.baselineId);
      if (!generation) {
        return true; // stale/unknown baseline generation — drop, absolutes recover
      }
      const baseline = generation.get(record.bodyEntity);
      if (!baseline) {
        return true;
      }
      position = [
        baseline[0] + record.position[0],
        baseline[1] + record.position[1],
        baseline[2] + record.position[2],
      ];
    } else {
      position = record.position;
    }

    // A pose outside the world is not a pose. Refuse it rather than track it.
    //
    // A report from a live session had a single-member island at
    // (-82 km, -33 km, +61 km): not a composition error -- the island's local
    // offset was zero, so the body itself was there -- and not a decoding
    // artefact either, since the wire encodes that position perfectly well.
    // Something on the server threw a fragment out of the world and nothing
    // brought it back, because the debris floor is disabled.
    //
    // What that costs the client is out of all proportion to five stray
    // chunks. A body moving at kilometres per second makes every consecutive
    // pair of its poses implausible to interpolate, so the presentation layer
    // steps instead of blending, once per sampled frame, for as long as the
    // body exists: the same session counted 4,054 implausible jumps and 3,256
    // drawn pose steps whose worst magnitude was 29 km. Those numbers say
    // almost nothing about the building the player was watching.
    //
    // So this is a guard, not a fix. The runaway is a server-side fault and is
    // still there; `recordsOutsideWorld` is how anyone knows.
    if (!Number.isFinite(position[0] + position[1] + position[2])
        || Math.abs(position[0]) > WORLD_BOUND_M
        || Math.abs(position[1]) > WORLD_BOUND_M
        || Math.abs(position[2]) > WORLD_BOUND_M) {
      this.recordsOutsideWorld += 1;
      if (this.recordsOutsideWorld <= 4) {
        noteClientEvent('recordOutsideWorld', {
          body: record.bodyEntity,
          position,
          simTick: datagram.simTick,
        });
      }
      return true;
    }

    let state = this.bodies.get(record.bodyEntity);
    if (!state) {
      state = this.createBodyState(record.bodyEntity);
    }
    // A fresh record can revise the path even for a body that had settled out
    // of the walk; re-admit it before the staleness check, since even a stale
    // record costs one no-op sample and a missed fresh one costs a frozen chunk.
    // Re-admitted after being starved: anchor the track to where this body is
    // ACTUALLY DRAWN before taking the new record.
    //
    // A track whose snapshots stop arriving decides locally that it has
    // settled, and `samplePresentation` then drops it from the per-frame walk
    // so its chunks freeze at the last pose it produced. That is correct for a
    // body that stopped; it is wrong for a body the server simply is not
    // serving, and in a large collapse that is most of them -- a body outside
    // the ranked interest set gets about one record a second. So the chunks sit
    // still while the real body keeps falling, and when a record finally
    // arrives they cross the gap in a single frame. Measured on a scripted
    // collapse: 93% of all drawn chunk teleports were on bodies in exactly this
    // state, almost all of them between four and thirty-two metres, one of them
    // 14,070 ms since its last write.
    //
    // Seeding turns that into the bounded glide a late packet is supposed to
    // get: the correction starts from the pose on screen instead of from a
    // pose the track invented while nobody was looking. The same trick
    // `seedPromotions` uses for a freshly fractured island.
    const starvedTicks = datagram.simTick - state.lastTick;
    if (
      SEED_ON_STARVED_READMISSION
      && state.lastPresented
      && state.lastTick > 0
      && starvedTicks > STARVED_TICKS
    ) {
      state.track.seedPresented(
        {
          position: state.lastPresented.position,
          rotation: state.lastPresented.rotation,
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        },
        this.renderTickNow(performance.now()),
      );
      this.starvedReadmissions += 1;
    }
    this.kinetic.add(record.bodyEntity);
    if (datagram.simTick <= state.lastTick) {
      return true; // stale reordered datagram — latest wins
    }
    state.lastTick = datagram.simTick;
    state.settledHint = (record.flags & RECORD_FLAG_SETTLED_HINT) !== 0;
    // What the stream last showed of this body's motion, so a later settle
    // can tell a pose this client has been shown from one it never was.
    this.topology.noteStreamedMotion(
      record.bodyEntity, datagram.simTick, position, record.linearVelocity, record.angularVelocity,
    );
    const snapshot: MotionSnapshot = {
      tick: datagram.simTick,
      position,
      rotation: record.rotation,
      linearVelocity: record.linearVelocity,
      angularVelocity: record.angularVelocity,
      class:
        record.mode === RecordMode.Ballistic
          ? PresentationClass.Ballistic
          : PresentationClass.ContactActive,
    };
    state.track.push(snapshot);
    this.noteDustVelocity(
      record.bodyEntity, body, datagram.simTick,
      position[0], position[1], position[2],
      record.linearVelocity[0], record.linearVelocity[1], record.linearVelocity[2],
    );
    if (isCitySuspect(record.bodyEntity)) {
      recordCityEvent('city_suspect_record', {
        body: record.bodyEntity,
        tick: datagram.simTick,
        mode: record.mode,
        x: position[0],
        y: position[1],
        z: position[2],
        vx: record.linearVelocity[0],
        vy: record.linearVelocity[1],
        vz: record.linearVelocity[2],
      });
    }
    // Placeholder only: a body that has never been sampled needs SOME ledger
    // pose or its chunks compose against garbage. Once presentation owns the
    // body, writing the raw pose here puts a value ~one interpolation delay
    // AHEAD of everything drawn around it into the shared slot, and whenever
    // that write survives to draw time the chunk visibly leads its island and
    // snaps back — measured live as ~1.7 m alternation at datagram cadence on
    // a perfectly smooth wire trajectory.
    if (!state.lastPresented) {
      this.topology.updateBodyPose(record.bodyEntity, position, record.rotation, 'raw');
    }
    this.recordsApplied += 1;
    return true;
  }

  /**
   * Sample every streaming body at the current render time and push the
   * presented pose into the ledger. Returns the set of body keys with live
   * presentation (the render layer recomposes those chunks each frame).
   */
  /**
   * Returns the bodies that actually moved this frame.
   *
   * Every body is sampled, but a body whose presented pose has not changed is
   * left out of the returned set, so the render layer writes it once more and
   * then stops touching it. Previously every body ever created was reported
   * live every frame: the renderer's dirty set only drops a body when it is
   * absent from this set, so nothing was ever dropped and each frame
   * re-composed the matrix and colour of every chunk of every island in the
   * match. Frame time grew with cumulative destruction and never recovered
   * (measured: 16.7 ms -> 333 ms after four towers, still 333 ms once
   * everything had settled).
   *
   * Tracks are normally closed by SETTLE events, but a body the server never
   * settles must not cost anything per frame either.
   */
  /**
   * `due`, when given, says whether a body's chunks will be rewritten this
   * frame (the render layer's distance stride). A body that is not due is
   * still reported live -- it is still moving -- but not sampled: the track
   * measures elapsed ticks since its previous sample, so sampling a distant
   * body every k-th frame lands it on the same pose as sampling it every
   * frame would have. Sampling every kinetic body every frame was a fifth of
   * all CPU time in a collapse, most of it for chunks whose write was then
   * deferred anyway.
   */
  samplePresentation(
    nowMs: number,
    due?: (key: number, lastPosition: Vec3 | null) => boolean,
  ): Set<number> {
    const live = this.samplePresentationInto(nowMs, due);
    this.lastLive = live;
    return live;
  }

  private samplePresentationInto(
    nowMs: number,
    due?: (key: number, lastPosition: Vec3 | null) => boolean,
  ): Set<number> {
    const live = new Set<number>();
    if (this.latestSimTickAtMs === 0) {
      // No pose stream has arrived, so there is no clock to hold topology
      // against -- but the holding still has to end, or a city that never
      // moves never fractures. Only the wall-clock valve can release it here.
      // Caught by rootedWire's capture, which is a standing scene with no
      // motion packets by design: without this the roots never appear at all.
      this.drainPendingTopology(0, nowMs);
      return live;
    }
    // Render tick estimate: latest known sim tick + elapsed since it arrived.
    const renderTick = this.renderTickNow(nowMs);
    if (this.debris !== null) {
      return this.sampleDebris(renderTick, live, nowMs);
    }
    // The kinetic set, not the bodies map: a body whose track has settled
    // cannot move without an event that re-adds it, so re-sampling it every
    // frame only re-proves that. Deleting the current entry during Set
    // iteration is defined behaviour in JS.
    // v2 buffers inside each PresentationTrack, so the shared playout clock has
    // to be pushed into them rather than read out of one place.
    let playoutDelay = this.advancePlayoutDelay(this.playoutDelayTarget());
    if (this.adaptiveDelay) {
      // A delay that shrinks must not carry the presentation past the newest
      // streamed tick while the lead cap holds (the cap used last frame's
      // delay), and one that grows must not walk it back: the slew is spent
      // only as far as the clock moved.
      if (this.leadCapActive && renderTick - playoutDelay > this.latestSimTick) {
        playoutDelay = renderTick - this.latestSimTick;
      }
      if (this.lastSampleTick >= 0 && renderTick - playoutDelay < this.lastSampleTick) {
        playoutDelay = Math.max(0, renderTick - this.lastSampleTick);
      }
      this.sampleDelaySmooth = playoutDelay;
    }
    // A promotion in flight: stop short of it rather than draw its chunks on
    // the body they left. The delay grows by exactly what the hold costs and
    // is then given back at the usual shrink rate, so neither the hold nor
    // its release is a jump. Never backwards: evidence behind the clock was
    // refused when it arrived.
    const holdLimit = this.awaitingTopology.size > 0 || this.topologyPieces.size > 0 || this.topologyAhead.size > 0
      ? this.topologyHoldLimit(nowMs)
      : Number.POSITIVE_INFINITY;
    if (renderTick - playoutDelay > holdLimit) {
      const target = Math.max(holdLimit, this.lastSampleTick);
      const held = Math.min(MAX_SAMPLE_DELAY_TICKS, renderTick - target);
      if (held > playoutDelay) {
        this.topologyHoldFrames += 1;
        this.topologyHoldTicksAdded += held - playoutDelay;
        playoutDelay = held;
        this.sampleDelaySmooth = held;
      }
    }
    this.lastSampleTick = Math.max(this.lastSampleTick, renderTick - playoutDelay);
    this.drainPendingTopology(Math.max(0, Math.floor(renderTick - playoutDelay)), nowMs);
    for (const key of this.kinetic) {
      const state = this.bodies.get(key);
      if (!state) {
        this.kinetic.delete(key);
        continue;
      }
      if (due && !due(key, state.lastPresented ? state.lastPresented.position : null)) {
        live.add(key);
        continue;
      }
      state.track.setInterpolationDelayTicks(playoutDelay);
      const presented = state.track.sample(renderTick);
      if (state.track.lastSampleSettled) {
        this.kinetic.delete(key);
        // Settled means the returned state is the previous sample's object,
        // so the epsilon comparison below would `continue` anyway -- skip it.
        continue;
      }
      const previous = state.lastPresented;
      if (
        previous
        && Math.abs(previous.position[0] - presented.position[0]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.position[1] - presented.position[1]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.position[2] - presented.position[2]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[0] - presented.rotation[0]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[1] - presented.rotation[1]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[2] - presented.rotation[2]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[3] - presented.rotation[3]) < PRESENTATION_EPSILON_M
      ) {
        continue;
      }
      // Written in place. This used to build an object and two arrays per moved
      // body per frame; during a collapse that is thousands of allocations a
      // frame, and the resulting GC is exactly the kind of periodic stall that
      // shows up as a dropped frame rather than as a higher average. Nothing
      // holds a reference to `lastPresented` -- it is only compared, field by
      // field, a few lines above -- so mutating it is safe.
      if (previous) {
        previous.position[0] = presented.position[0];
        previous.position[1] = presented.position[1];
        previous.position[2] = presented.position[2];
        previous.rotation[0] = presented.rotation[0];
        previous.rotation[1] = presented.rotation[1];
        previous.rotation[2] = presented.rotation[2];
        previous.rotation[3] = presented.rotation[3];
        state.lastPresentedSpeed = Math.hypot(
          presented.linearVelocity[0],
          presented.linearVelocity[1],
          presented.linearVelocity[2],
        );
        state.lastPresentedVelocity = presented.linearVelocity;
      } else {
        state.lastPresentedSpeed = Math.hypot(
          presented.linearVelocity[0],
          presented.linearVelocity[1],
          presented.linearVelocity[2],
        );
        state.lastPresentedVelocity = presented.linearVelocity;
        state.lastPresented = {
          position: [presented.position[0], presented.position[1], presented.position[2]],
          rotation: [
            presented.rotation[0],
            presented.rotation[1],
            presented.rotation[2],
            presented.rotation[3],
          ],
        };
      }
      this.topology.updateBodyPose(key, presented.position, presented.rotation, 'presented');
      live.add(key);
    }
    this.presentationIdle = this.kinetic.size === 0;
    return live;
  }

  /**
   * The presentation clock as of the last `samplePresentation`: the render
   * tick bodies were sampled at and the playout delay behind it. Read-only,
   * for the offline replay to label each presented frame with the sim tick
   * it corresponds to; the render layer never needs it.
   */
  presentationClock(): { renderTick: number; playoutDelayTicks: number } {
    return { renderTick: this.renderClockTick, playoutDelayTicks: this.sampleDelaySmooth };
  }

  /**
   * The sim tick the last sample presented (render tick minus the playout
   * delay); +Infinity before any pose stream, so nothing waits on a clock
   * that does not exist yet.
   */
  presentedTick(): number {
    return this.renderClockTick < 0
      ? Number.POSITIVE_INFINITY
      : this.renderClockTick - this.sampleDelaySmooth;
  }

  /**
   * Bumps whenever the ledger is replaced wholesale (a bootstrap) or a
   * structure is rewritten (a repair); anything written before is not
   * comparable with anything written after. The render layer reads this every
   * frame, and it used to read it off `stats()`, which walks every chunk slot
   * of the city to count orphans -- 10% of all CPU time in a collapse.
   */
  ledgerEpoch(): number {
    return this.bootstrapCount + this.structureRepairs;
  }

  private sendResync(bytes: Uint8Array): void {
    if (bytes[0] === PKT_CITY_NACK) {
      this.nacksSent += 1;
      this.nackBodiesSent += bytes.length >= 3 ? new DataView(bytes.buffer, bytes.byteOffset).getUint16(1, true) : 0;
    } else {
      this.resyncRequestsSent += 1;
    }
    this.sendUpstream(bytes);
  }

  stats(): CityClientStats {
    const topologyStats = this.topology.stats();
    let windowBytes = 0;
    for (const entry of this.bytesWindow) {
      windowBytes += entry.bytes;
    }
    const windowSeconds =
      this.bytesWindow.length > 1
        ? (this.bytesWindow[this.bytesWindow.length - 1].at - this.bytesWindow[0].at) / 1000
        : 0;
    let chunksAwake = 0;
    let chunksSettled = 0;
    for (const body of this.topology.allBodies()) {
      if (body.islandSerial === 0) {
        continue;
      }
      if (body.settled) {
        chunksSettled += body.chunkSlots.length;
      } else {
        chunksAwake += body.chunkSlots.length;
      }
    }
    return {
      chunksTotal: this.topology.chunkCount,
      chunksAwake,
      chunksSettled,
      bootstraps: this.bootstrapCount,
      settleRejects: this.topology.settleFrameRejects,
      settlesAfterSilence: this.topology.settlesAfterSilence,
      settlesSuperseded: this.topology.settlesSuperseded,
      valveApplies: this.topologyValveApplies,
      valveTicksAhead: this.topologyValveTicksAhead,
      topologyHoldFrames: this.topologyHoldFrames,
      topologyHoldTicksAdded: this.topologyHoldTicksAdded,
      topologyHoldExpired: this.topologyHoldExpired,
      topologyCopiesApplied: this.topologyCopiesApplied,
      topologyCopiesLate: this.topologyCopiesLate,
      topologyReliableAfterCopy: this.topologyReliableAfterCopy,
      repairsBehindCopies: this.repairsBehindCopies,
      topologyGapHoldFrames: this.topologyGapHoldFrames,
      brokenBonds: topologyStats.brokenBonds,
      liveIslands: topologyStats.liveIslands,
      topoSeqGaps: topologyStats.topoSeqGaps,
      orphanedChunks: topologyStats.orphanedChunks,
      orphanedByRetire: topologyStats.orphanedByRetire,
      poseJumpsOver1m: topologyStats.poseJumpsOver1m,
      poseJumpsOver4m: topologyStats.poseJumpsOver4m,
      poseJumpsOver16m: topologyStats.poseJumpsOver16m,
      poseJumpMaxM: topologyStats.poseJumpMaxM,
      presentedJumpsOver1m: topologyStats.presentedJumpsOver1m,
      presentedJumpsOver4m: topologyStats.presentedJumpsOver4m,
      presentedJumpMaxM: topologyStats.presentedJumpMaxM,
      reoffsets: topologyStats.reoffsets,
      reoffsetMetres: topologyStats.reoffsetMetres,
      adoptionJumps: topologyStats.adoptionJumps,
      adoptionJumpMaxM: topologyStats.adoptionJumpMaxM,
      adoptionJumpMetres: topologyStats.adoptionJumpMetres,
      adoptionJumpsFromMigration: topologyStats.adoptionJumpsFromMigration,
      adoptionJumpMetresFromMigration: topologyStats.adoptionJumpMetresFromMigration,
      presentedJumpChunks: topologyStats.presentedJumpChunks,
      presentedJumpWorstChunks: topologyStats.presentedJumpWorstChunks,
      presentedJumpWorstChunksM: topologyStats.presentedJumpWorstChunksM,
      correctionSnaps: this.presentationAnomalies.correction_snap,
      clockRollbacks: this.presentationAnomalies.clock_rollback,
      implausibleJumps: this.presentationAnomalies.implausible_jump,
      presentationAnomalyMaxM: this.presentationAnomalyMaxM,
      recordsOutsideWorld: this.recordsOutsideWorld,
      renderClockReanchorsRefused: this.renderClockReanchorsRefused,
      bootstrapPosesSeen: this.bootstrapPosesSeen,
      bootstrapPosesGone: this.bootstrapPosesGone,
      bootstrapPosesGlided: this.bootstrapPosesGlided,
      bootstrapPosesSnapped: this.bootstrapPosesSnapped,
      repairBodiesGlided: this.repairBodiesGlided,
      wakeSeeds: this.wakeSeeds,
      starvedReadmissions: this.starvedReadmissions,
      settlesRestored: this.settlesRestored,
      settlesLeftHard: this.settlesLeftHard,
      promotionsSeen: this.promotionsSeen,
      promotionsSeeded: this.promotionsSeeded,
      promotionsSeedSkippedReused: this.promotionsSeedSkippedReused,
      promotionsSeedSkippedNoBody: this.promotionsSeedSkippedNoBody,
      promotionsSeedSkippedNoDrawnPose: this.promotionsSeedSkippedNoDrawnPose,
      promotionsUnseeded: this.promotionsUnseeded,
      datagramsReceived: this.datagramsReceived,
      recordsApplied: this.recordsApplied,
      wireVersion: this.debris === null ? 2 : 3,
      recordsBuffered: this.recordsBuffered,
      bytesReceived: this.bytesReceived,
      bytesPerSecond: windowSeconds > 0.25 ? windowBytes / windowSeconds : 0,
      sampleDelayTicks: this.sampleDelaySmooth,
      arrivalLatenessTicks: this.arrivalLateness,
      arrivalLatenessPeakTicks: this.arrivalLatenessPeak,
      manifestHash: this.manifest.hashHex,
      dustSources: this.dustSourcesTotal,
      dustSourcesDroppedByCap: dustExtractStats().droppedByCap,
      dustQueueDropped: this.dustQueue.dropped,
      dustEntries: dustExtractStats().entries,
      dustImpacts: this.dustImpacts.impacts,
      dustWaves: this.dustImpacts.wavesRaised,
      hashChecks: this.hashChecks,
      hashMismatches: this.hashMismatches,
      structureRepairs: this.structureRepairs,
      nacksSent: this.nacksSent,
      nackBodiesSent: this.nackBodiesSent,
      resyncRequestsSent: this.resyncRequestsSent,
    };
  }
}

export type { Vec3, Quat };
