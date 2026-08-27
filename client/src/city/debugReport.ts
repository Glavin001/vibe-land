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
 * baseline arrivals, ledger repairs, anomalous chunk teleports — because the
 * questions this exists to answer are about TIMING ("do the pops land on
 * baseline rollovers or on freeze flips?"), and a point sample cannot say.
 */

const RING_CAP = 400;

interface BaselineArrival {
  /** performance.now() at arrival, ms. */
  t: number;
  baselineId: number;
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
}

const baselines: BaselineArrival[] = [];
const clientEvents: ClientEvent[] = [];
const teleports: TeleportEvent[] = [];

function push<T>(ring: T[], entry: T): void {
  ring.push(entry);
  if (ring.length > RING_CAP) {
    ring.shift();
  }
}

/** Called by cityClient on every PKT_CITY_BASELINE arrival. */
export function noteBaseline(baselineId: number): void {
  push(baselines, { t: performance.now(), baselineId });
}

/** Ledger repairs, resync requests, hash mismatches — the agreement timeline. */
export function noteClientEvent(kind: string, detail?: Record<string, unknown>): void {
  push(clientEvents, { t: performance.now(), kind, detail });
}

/** Anomalous chunk jumps from the always-on teleport probe. */
export function noteTeleport(event: Omit<TeleportEvent, 't'>): void {
  push(teleports, { t: performance.now(), ...event });
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
    },
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
