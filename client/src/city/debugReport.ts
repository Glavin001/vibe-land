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

const baselines: BaselineArrival[] = [];
const clientEvents: ClientEvent[] = [];
const teleports: TeleportEvent[] = [];
const adoptionJumps: AdoptionJump[] = [];
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

/** Anomalous chunk jumps from the always-on teleport probe. */
export function noteTeleport(event: Omit<TeleportEvent, 't'>): void {
  push(teleports, { t: performance.now(), ...event });
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
      fractures: [...fractures],
    },
    /** The rings, already asked the question they exist to answer. */
    flicker: fractureCorrelation(),
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
