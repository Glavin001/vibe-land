/**
 * One-button debug reports — the mobile-friendly replacement for
 * "download the stats JSON and send it by hand".
 *
 * The client cannot write files on the box, but the server can: SEND REPORT
 * posts everything client-side to the game server, which bundles it with its
 * own live match-stats snapshot into a uniquely-named folder under
 * debug-reports/. Saying "sent a report" is then enough for whoever is
 * debugging to find the newest folder.
 *
 * Beyond the point-in-time stats (the e2e bridge snapshot already carries
 * every counter the overlay shows), the report includes short EVENT RINGS —
 * baseline arrivals, ledger repairs, anomalous chunk teleports, chunk poses
 * moving across a re-parent, and the fractures themselves — because the
 * questions this exists to answer are about TIMING ("do the pops land on
 * baseline rollovers or on freeze flips?"), and a point sample cannot say.
 *
 * The `flicker` block at the top of the payload is those rings already asked
 * the question they exist for: how many of the jumps landed next to a fracture,
 * and how many were the same chunk moving twice in a quarter second, which is
 * what a player means by rubber banding.
 */

const RING_CAP = 400;

interface BaselineArrival {
  /** performance.now() at arrival, ms. */
  t: number;
  baselineId: number;
  /** Server sim tick the baseline was cut at — correlates client rings to
   * the server's own tick ring in the same report. */
  simTick: number;
}

interface ClientEvent {
  t: number;
  kind: string;
  detail?: Record<string, unknown>;
}

interface TeleportEvent {
  t: number;
  slot: number;
  stepM: number;
  body: number;
  source: string;
  y: number;
  /** Where it went, so an out-and-back pair is recognisable as one. */
  x?: number;
  z?: number;
  /** Whether the ledger had this body settled and off the live list. */
  settling?: boolean;
  bodySettled?: boolean;
  recentlyRebased?: boolean;
}

/**
 * A chunk's world pose moving across a topology re-parent.
 *
 * A chunk is the same physical object before and after a batch re-parents it,
 * so its world pose should be continuous across the batch. Displacement here is
 * the fracture discontinuity: chunks jumping at the instant a building breaks.
 * Reported unconditionally because the question it answers -- does the flicker
 * land on fractures? -- can only be asked of an ordinary session.
 */
interface AdoptionJump {
  t: number;
  slot: number;
  stepM: number;
}

/**
 * A topology batch that changed island membership, and when it landed.
 *
 * The timeline everything else is read against. "Chunks flicker when a building
 * comes down" is a claim about coincidence, and no ring of jumps can support or
 * refute it without the fractures to line them up with.
 */
interface FractureBatch {
  t: number;
  simTick: number;
  topoSeq: number;
  promotions: number;
  migrations: number;
  retires: number;
  settles: number;
  brokenBonds: number;
}

/**
 * A chunk going invisible, or coming back.
 *
 * Hiding is the only thing in this renderer that makes geometry vanish: a
 * chunk whose composed height stays below -4 m for eight consecutive writes
 * has its scale zeroed. That is a cull for debris that escaped the world, and
 * it is correct for that -- but a body whose pose is briefly wrong takes all of
 * its chunks below the line together, and eight writes later a whole building
 * disappears and then comes back. Reported from play as large structures
 * phasing in and out.
 *
 * Both directions, with the body, so a report can distinguish a few strays from
 * an island going dark at once.
 */
interface VisibilityFlip {
  t: number;
  slot: number;
  body: number;
  hidden: boolean;
  y: number;
  /** How many chunks that body has, and how big it is across, in metres. */
  bodyChunks?: number;
  aabbM?: number;
}

/**
 * One frame's drawn-chunk census, kept only when it is anomalous.
 *
 * Every mechanism chased so far -- hiding, culling, shell transitions, stale
 * bounds -- was reached by guessing at a cause and then measuring it. This
 * measures the SYMPTOM instead: how much of the city was actually drawable on
 * a frame, and whether that number collapsed and came back. A player watching
 * a building phase in and out is watching this number drop for a frame or two,
 * whatever the reason, and one entry here names the body, the chunk count and
 * the size of the box that vanished.
 */
interface DrawCensus {
  t: number;
  /** Chunks drawable this frame, and on the frame before it. */
  drawn: number;
  previous: number;
  /** The body that lost the most chunks, with how big it is in metres. */
  body: number;
  bodyChunks: number;
  aabbM: number;
}

const baselines: BaselineArrival[] = [];
const clientEvents: ClientEvent[] = [];
const teleports: TeleportEvent[] = [];
const adoptionJumps: AdoptionJump[] = [];
const visibility: VisibilityFlip[] = [];
const census: DrawCensus[] = [];
let lastDrawn = -1;
let worstDropChunks = 0;
let worstDropAabbM = 0;
let dropFrames = 0;
let cameraMovedFrames = 0;
let visibilityHidden = 0;
let visibilityShown = 0;
/** Chunks hidden together on one body in one flip run, worst seen. */
const hiddenPerBody = new Map<number, number>();
let worstBodyHidden = 0;
const fractures: FractureBatch[] = [];

function push<T>(ring: T[], entry: T): void {
  ring.push(entry);
  if (ring.length > RING_CAP) {
    ring.shift();
  }
}

/** Called by cityClient on every PKT_CITY_BASELINE arrival. */
export function noteBaseline(baselineId: number, simTick: number): void {
  push(baselines, { t: performance.now(), baselineId, simTick });
}

/** Ledger repairs, resync requests, hash mismatches — the agreement timeline. */
export function noteClientEvent(kind: string, detail?: Record<string, unknown>): void {
  push(clientEvents, { t: performance.now(), kind, detail });
}

let teleportCount = 0;
let teleportWorstM = 0;
let teleportMetres = 0;
/**
 * The whole population, by cause.
 *
 * The ring holds 400 and the recorder is capped at 2,000 events a second,
 * while a collapse produces a hundred thousand of these -- so every proportion
 * read off either was a sample of whatever happened to fit, and two
 * investigations were steered by one. These count all of them.
 */
const teleportBy = {
  sourcePresented: 0,
  sourceRaw: 0,
  sourceUnknown: 0,
  bodySettled: 0,
  notInLiveSet: 0,
  recentlyRebased: 0,
  under1m: 0,
  under4m: 0,
  under32m: 0,
  over32m: 0,
};

/** Anomalous chunk jumps from the always-on teleport probe. */
export function noteTeleport(event: Omit<TeleportEvent, 't'>): void {
  push(teleports, { t: performance.now(), ...event });
  teleportCount += 1;
  teleportMetres += event.stepM;
  if (event.stepM > teleportWorstM) teleportWorstM = event.stepM;
  if (event.source === 'presented') teleportBy.sourcePresented += 1;
  else if (event.source === 'raw') teleportBy.sourceRaw += 1;
  else teleportBy.sourceUnknown += 1;
  if (event.bodySettled) teleportBy.bodySettled += 1;
  if (event.settling) teleportBy.notInLiveSet += 1;
  if (event.recentlyRebased) teleportBy.recentlyRebased += 1;
  if (event.stepM < 1) teleportBy.under1m += 1;
  else if (event.stepM < 4) teleportBy.under4m += 1;
  else if (event.stepM < 32) teleportBy.under32m += 1;
  else teleportBy.over32m += 1;
}

/**
 * The drawn-teleport totals, for the stats panel and the QA harness.
 *
 * This is the measurement that counts, and the ring alone could not carry it:
 * the ring holds 400 entries and a collapse produces tens of thousands, so
 * anything read off it is a floor. The probe judges an INSTANCE that was
 * actually composed for the renderer against that chunk's own recent speed, so
 * unlike a body-pose delta it cannot be fooled by a centre-of-mass change --
 * an island that sheds half its members legitimately moves its body pose a
 * long way in COM frame while every chunk stays exactly where it was.
 */
export function drawnTeleportTotals(): {
  count: number; worstM: number; metres: number;
} {
  return { count: teleportCount, worstM: teleportWorstM, metres: teleportMetres };
}

/** The whole teleport population split by cause. See `teleportBy`. */
export function drawnTeleportBreakdown(): Record<string, number> {
  return { ...teleportBy };
}

/** A chunk going invisible or coming back; see `VisibilityFlip`. */
export function noteVisibility(flip: Omit<VisibilityFlip, 't'>): void {
  push(visibility, { t: performance.now(), ...flip });
  if (flip.hidden) {
    visibilityHidden += 1;
    const n = (hiddenPerBody.get(flip.body) ?? 0) + 1;
    hiddenPerBody.set(flip.body, n);
    if (n > worstBodyHidden) worstBodyHidden = n;
  } else {
    visibilityShown += 1;
    const n = (hiddenPerBody.get(flip.body) ?? 0) - 1;
    if (n <= 0) hiddenPerBody.delete(flip.body);
    else hiddenPerBody.set(flip.body, n);
  }
}

/**
 * One frame's drawn-chunk count, recorded only when it falls sharply.
 *
 * `body`, `bodyChunks` and `aabbM` describe the largest contributor, because
 * the size of what disappears is the difference between a speck and half a
 * building -- and a single flip of an eight-hundred-chunk island is a bigger
 * event than a thousand flips of single fragments.
 */
export function noteDrawCensus(
  drawn: number,
  worst: { body: number; chunks: number; aabbM: number },
  cameraMoved: boolean,
): void {
  const previous = lastDrawn;
  lastDrawn = drawn;
  if (previous < 0) {
    return;
  }
  // A camera that turned explains any drop: half the city leaving the frustum
  // is the frustum working. Without this the census was dominated by the
  // harness walking backwards and looking round, and reported the whole city
  // vanishing 700 times a run.
  if (cameraMoved) {
    cameraMovedFrames += 1;
    return;
  }
  // A drop of more than 2% of the drawn city in one frame. Ordinary settling
  // retires chunks a handful at a time; this is for the cliff.
  if (drawn >= previous - Math.max(16, previous * 0.02)) {
    return;
  }
  dropFrames += 1;
  const lost = previous - drawn;
  if (lost > worstDropChunks) worstDropChunks = lost;
  if (worst.aabbM > worstDropAabbM) worstDropAabbM = worst.aabbM;
  push(census, {
    t: performance.now(),
    drawn,
    previous,
    body: worst.body,
    bodyChunks: worst.chunks,
    aabbM: worst.aabbM,
  });
}

/** Drawn-census totals: how often the drawn city collapsed, and by how much. */
export function drawCensusTotals(): Record<string, number> {
  return { dropFrames, worstDropChunks, worstDropAabbM, lastDrawn, cameraMovedFrames };
}

/** Visibility totals for the stats panel and the QA harness. */
export function visibilityTotals(): {
  hidden: number; shown: number; worstBodyHidden: number; bodiesPartlyHidden: number;
} {
  return {
    hidden: visibilityHidden,
    shown: visibilityShown,
    worstBodyHidden,
    bodiesPartlyHidden: hiddenPerBody.size,
  };
}

/** A chunk whose world pose moved when a topology batch re-parented it. */
export function noteAdoptionJump(slot: number, stepM: number): void {
  push(adoptionJumps, { t: performance.now(), slot, stepM });
}

/** A topology batch that changed membership, for lining the rings up against. */
export function noteFracture(batch: Omit<FractureBatch, 't'>): void {
  push(fractures, { t: performance.now(), ...batch });
}

/**
 * How many of the recorded jumps landed next to a fracture.
 *
 * Computed here rather than left to whoever reads the report, because it is the
 * whole question and doing it by hand across two rings of four hundred entries
 * is how it does not get done. A jump is "at a fracture" if a membership-
 * changing batch landed within 150 ms before it -- one playout delay plus a
 * frame, which is as long as a batch can plausibly still be showing.
 */
function fractureCorrelation(): Record<string, unknown> {
  const within = (t: number) => fractures.some((f) => t - f.t >= 0 && t - f.t <= 150);
  const near = teleports.filter((e) => within(e.t)).length;
  const worst = teleports.reduce((m, e) => Math.max(m, e.stepM), 0);
  // Out-and-back on one slot inside a quarter second is what a player calls
  // rubber banding, as opposed to a body simply arriving somewhere new.
  let rubberBands = 0;
  for (let i = 1; i < teleports.length; i += 1) {
    const a = teleports[i - 1];
    const b = teleports[i];
    if (a.slot === b.slot && b.t - a.t < 250) rubberBands += 1;
  }
  return {
    teleports: teleports.length,
    teleportsWithin150msOfAFracture: near,
    teleportsWorstM: worst,
    sameSlotWithin250ms: rubberBands,
    adoptionJumps: adoptionJumps.length,
    adoptionJumpsWorstM: adoptionJumps.reduce((m, e) => Math.max(m, e.stepM), 0),
    fractureBatches: fractures.length,
  };
}

/**
 * The most recent render cost sweep (DOWNLOAD PERF REPORT / MOBILE PERF
 * BISECT), so a sent report carries the per-feature wall-clock deltas from
 * the reporter's own GPU -- the one measurement the frame profile cannot
 * give, and the one that used to reach nobody: it downloaded to the phone or
 * showed on screen.
 */
let lastPerfSweep: { capturedAt: string; text: string; report: unknown } | null = null;

export function notePerfSweep(report: { capturedAt: string }, text: string): void {
  lastPerfSweep = { capturedAt: report.capturedAt, text, report };
}

/**
 * What the hot-spot watch saw when it fired, for the report it then sends:
 * the frame at the trigger, thirty seconds of frame history before it, and
 * where the tape it cut went.
 */
let lastHotspot: Record<string, unknown> | null = null;

export function noteHotspot(hotspot: Record<string, unknown>): void {
  lastHotspot = hotspot;
}

/**
 * POST the full client picture to the server; resolves to the folder name the
 * server stored it under. Uses the e2e bridge as the collector — it is
 * always on and already assembles every stat the overlay can show.
 */
export async function sendDebugReport(matchId: string): Promise<string> {
  const bridge = (
    window as unknown as {
      __VIBE_E2E__?: { snapshot?: () => unknown; frameProfile?: () => unknown };
    }
  ).__VIBE_E2E__;
  const payload = {
    capturedAt: new Date().toISOString(),
    /** Anchors the rings' performance.now() timestamps to the capture. */
    nowMs: performance.now(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    screen: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    snapshot: bridge?.snapshot?.() ?? null,
    frameProfile: bridge?.frameProfile?.() ?? null,
    events: {
      baselines: [...baselines],
      client: [...clientEvents],
      teleports: [...teleports],
      adoptionJumps: [...adoptionJumps],
      visibility: [...visibility],
      drawCensus: [...census],
      fractures: [...fractures],
    },
    /** The rings, already asked the question they exist to answer. */
    flicker: {
      ...fractureCorrelation(),
      visibility: visibilityTotals(),
      drawCensus: drawCensusTotals(),
    },
    perfSweep: lastPerfSweep,
    hotspot: lastHotspot,
  };
  const response = await fetch(`/match-stats/${encodeURIComponent(matchId)}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`report rejected: ${response.status}`);
  }
  const { folder } = (await response.json()) as { folder: string };
  return folder;
}
