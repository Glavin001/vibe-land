/**
 * Which step of joining a match we are currently on.
 *
 * "Connecting..." on its own is unfalsifiable: when it never resolves it gives
 * no clue whether the physics module, the network, or the server is at fault,
 * and on a phone there is no console to ask. Publishing the phase turns a hang
 * into a readable symptom.
 *
 * Deliberately a module-level store rather than React state: the runtime that
 * knows the phase lives inside the render canvas, far from the status banner
 * that displays it, and threading a callback between them would touch a dozen
 * components for a string.
 */

export type ConnectPhase =
  | 'fetching session config'
  | 'loading physics'
  | 'building local world'
  | 'opening transport'
  | 'waiting for server welcome'
  | null;

let current: ConnectPhase = null;
const listeners = new Set<() => void>();

export function setConnectPhase(phase: ConnectPhase): void {
  if (current === phase) return;
  current = phase;
  for (const listener of listeners) listener();
}

export function getConnectPhase(): ConnectPhase {
  return current;
}

export function subscribeConnectPhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Why the preferred transport was not used, when a session ends up on the
 * fallback. A silent demotion from UDP to TCP still "works", so without this
 * the only symptom is worse latency that nobody attributes to a bug.
 */
let transportNote: string | null = null;

export function setTransportNote(note: string | null): void {
  if (transportNote === note) return;
  transportNote = note;
  for (const listener of listeners) listener();
}

export function getTransportNote(): string | null {
  return transportNote;
}

/**
 * The session actually in play, which is not always what the URL says: a
 * control plane assigns the match id, and the server may be a rented box.
 *
 * `statsBaseUrl` is null when the game server's HTTP port cannot be reached
 * from this page -- a rented box serves plain HTTP on a random port. Callers
 * must then show nothing rather than fall back to the page origin, which
 * answers with a *different* server's numbers and reads as if it were this one.
 */
export type ActiveSession = { matchId: string; statsBaseUrl: string | null };

let activeSession: ActiveSession | null = null;

export function setActiveSession(session: ActiveSession | null): void {
  activeSession = session;
  for (const listener of listeners) listener();
}

export function getActiveSession(): ActiveSession | null {
  return activeSession;
}

/**
 * Latest per-match server telemetry, pushed over the session.
 *
 * Kept here rather than in React state because the runtime that receives it
 * lives inside the render canvas, far from the overlay that displays it.
 */
let matchStats: unknown = null;

export function setMatchStats(stats: unknown): void {
  matchStats = stats;
  for (const listener of listeners) listener();
}

export function getMatchStats(): unknown {
  return matchStats;
}
