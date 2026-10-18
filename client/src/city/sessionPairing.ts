// A tape and a server capture of the same session, paired by one id.
//
// The client tape says what arrived and when, and what each frame cost; it
// cannot say what the server simulated, what it chose to send, or when. So a
// manual tape (and the e2e bridge's) asks the match to capture the same
// session: the server records its authoritative world, every packet it sent
// to every client (tick, lane, what became of it), and its per-tick costs,
// into debug-reports/session-<id>/, and the tape is uploaded into the same
// bundle when it stops. scripts/perf/session_bundle.py joins the two.
//
// Order matters at both ends. The server capture starts BEFORE the tape
// opens and stops AFTER it closes, so every packet on the tape was sent while
// the server was logging. Every request is bracketed by this page's clock
// and answered with the server's tick and clocks, which makes it a clock
// sample; a few more are taken while recording.
//
// A server without the routes (404) or one that refuses leaves the tape
// exactly as it was before pairing existed: saved, downloaded, and uploaded
// standalone. Pairing can only add to a recording, never cost one.
//
// The automatic hot-spot tapes are NOT paired: they fire during frame-rate
// collapses, which are when the server is busiest, and a capture's writer
// threads and disk traffic would land exactly then, on every client's
// server, without anyone having asked.

import {
  cityTapeRecorder,
  encodeCityTape,
  type CityTape,
  type CityTapeOwner,
  type TapeClockSample,
  type TapePairing,
} from './cityTape';
import { uploadTape } from './hotspotWatch';

export interface PairingDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** How often to take a clock sample while recording; 0 disables. */
  clockIntervalMs?: number;
  /** How long to wait for the server to start its capture. */
  startTimeoutMs?: number;
}

const MAX_CLOCK_SAMPLES = 2000;

/** `20260924-101112-ab12cd`: sortable, readable, unique enough per server. */
export function newSessionId(now: Date = new Date(), random: () => number = Math.random): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += Math.floor(random() * 36).toString(36);
  return `${stamp}-${suffix}`;
}

function sessionUrl(matchId: string, sessionId: string, action: string): string {
  return `/match-stats/${encodeURIComponent(matchId)}/session/${encodeURIComponent(sessionId)}/${action}`;
}

interface ServerMark { tick: number; unix_us: number; mono_us: number }

/** The server half of one paired recording. */
export class SessionPairing {
  readonly pairing: TapePairing;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly clockIntervalMs: number;
  private readonly startTimeoutMs: number;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly matchId: string, readonly sessionId: string, deps: PairingDeps = {}) {
    this.fetchFn = deps.fetch ?? ((...args) => fetch(...args));
    this.now = deps.now ?? (() => performance.now());
    this.clockIntervalMs = deps.clockIntervalMs ?? 5000;
    this.startTimeoutMs = deps.startTimeoutMs ?? 6000;
    this.pairing = { sessionId, state: 'pending', clockSamples: [] };
  }

  get paired(): boolean {
    return this.pairing.state === 'paired';
  }

  /** Asks the server to capture this session. Never throws. */
  async start(playerId: number | null): Promise<boolean> {
    const sentPerfMs = this.now();
    try {
      const controller = typeof AbortController === 'undefined' ? null : new AbortController();
      const timer = controller ? setTimeout(() => controller.abort(), this.startTimeoutMs) : null;
      const response = await this.fetchFn(sessionUrl(this.matchId, this.sessionId, 'start'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ player_id: playerId }),
        signal: controller?.signal,
      }).finally(() => { if (timer) clearTimeout(timer); });
      const receivedPerfMs = this.now();
      if (response.status === 404 || response.status === 405) {
        // No such route (an older server), or no such match: standalone.
        this.pairing.state = 'unpaired';
        this.pairing.error = `server answered ${response.status}`;
        return false;
      }
      if (!response.ok) {
        this.pairing.state = 'failed';
        this.pairing.error = `server answered ${response.status}: ${(await response.text()).slice(0, 200)}`;
        return false;
      }
      const body = await response.json() as {
        start: ServerMark; server_dir: string; joined: boolean; capture_epoch_unix_us: number;
      };
      this.pairing.state = 'paired';
      this.pairing.serverDir = body.server_dir;
      this.pairing.joined = body.joined;
      this.pairing.startTick = body.start.tick;
      this.pairing.captureEpochUnixUs = body.capture_epoch_unix_us;
      this.pushSample({
        what: 'start',
        sentPerfMs,
        receivedPerfMs,
        serverTick: body.start.tick,
        serverUnixUs: body.start.unix_us,
        serverMonoUs: body.start.mono_us,
      });
      return true;
    } catch (error) {
      // Offline, aborted, or a dev server answering with its HTML fallback.
      this.pairing.state = 'unpaired';
      this.pairing.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** Clock samples every `clockIntervalMs` until stopped. */
  startClockSamples(): void {
    if (!this.paired || this.clockIntervalMs <= 0 || this.clockTimer) return;
    this.clockTimer = setInterval(() => { void this.sampleClock(); }, this.clockIntervalMs);
  }

  stopClockSamples(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  async sampleClock(): Promise<TapeClockSample | null> {
    const sentPerfMs = this.now();
    try {
      const response = await this.fetchFn(`/match-stats/${encodeURIComponent(this.matchId)}/session-clock`);
      const receivedPerfMs = this.now();
      if (!response.ok) return null;
      const body = await response.json() as { tick: number; unix_us: number; capture_mono_us: number | null };
      return this.pushSample({
        what: 'clock',
        sentPerfMs,
        receivedPerfMs,
        serverTick: body.tick,
        serverUnixUs: body.unix_us,
        serverMonoUs: body.capture_mono_us,
      });
    } catch {
      return null;
    }
  }

  /** Ends the server capture of this session. Never throws. */
  async stop(): Promise<boolean> {
    this.stopClockSamples();
    if (!this.paired) return false;
    const sentPerfMs = this.now();
    try {
      const response = await this.fetchFn(sessionUrl(this.matchId, this.sessionId, 'stop'), { method: 'POST' });
      const receivedPerfMs = this.now();
      if (!response.ok) {
        this.pairing.error = `stop answered ${response.status}`;
        return false;
      }
      const body = await response.json() as { stop: ServerMark };
      this.pairing.stopTick = body.stop.tick;
      this.pushSample({
        what: 'stop',
        sentPerfMs,
        receivedPerfMs,
        serverTick: body.stop.tick,
        serverUnixUs: body.stop.unix_us,
        serverMonoUs: body.stop.mono_us,
      });
      return true;
    } catch (error) {
      this.pairing.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** The tape, into this session's bundle. */
  async upload(tape: CityTape): Promise<{ uploaded: boolean; folder: string | null }> {
    try {
      const response = await this.fetchFn(sessionUrl(this.matchId, this.sessionId, 'tape'), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: encodeCityTape(tape) as BodyInit,
      });
      if (!response.ok) return { uploaded: false, folder: null };
      const { folder } = await response.json() as { folder: string };
      return { uploaded: true, folder };
    } catch {
      return { uploaded: false, folder: null };
    }
  }

  private pushSample(sample: TapeClockSample): TapeClockSample {
    if (this.pairing.clockSamples.length < MAX_CLOCK_SAMPLES) this.pairing.clockSamples.push(sample);
    return sample;
  }
}

/** A tape being recorded, and its server half. */
export interface PairedTape {
  token: number;
  pairing: SessionPairing;
}

/**
 * Asks the server to capture, then opens the tape for `owner`. Null when
 * another owner's tape is recording (the server capture is released again).
 */
export async function startPairedTape(
  owner: CityTapeOwner,
  matchId: string,
  deps: PairingDeps & { sessionId?: string } = {},
): Promise<PairedTape | null> {
  const pairing = new SessionPairing(matchId, deps.sessionId ?? newSessionId(), deps);
  // Server first: its capture then covers the tape from the first packet.
  await pairing.start(cityTapeRecorder.localPlayerId());
  const token = cityTapeRecorder.start(owner);
  if (token === 0) {
    await pairing.stop();
    return null;
  }
  cityTapeRecorder.attachPairing(token, pairing.pairing);
  pairing.startClockSamples();
  return { token, pairing };
}

/** Closes the tape, then the server capture (so it covers every packet). */
export async function stopPairedTape(paired: PairedTape): Promise<CityTape | null> {
  const tape = cityTapeRecorder.stop(paired.token);
  if (!tape) {
    // Not ours to stop (any more); leave the server capture to its owner.
    return null;
  }
  await paired.pairing.sampleClock();
  await paired.pairing.stop();
  return tape;
}

/**
 * Uploads into the session's bundle when the server captured it, and to the
 * standalone tape route otherwise -- or when the bundle upload fails.
 */
export async function uploadPairedTape(
  matchId: string,
  tape: CityTape,
  pairing: SessionPairing | null,
): Promise<{ uploaded: boolean; folder: string | null; paired: boolean }> {
  if (pairing?.paired) {
    const result = await pairing.upload(tape);
    if (result.uploaded) return { ...result, paired: true };
  }
  const standalone = await uploadTape(matchId, tape);
  return { ...standalone, paired: false };
}
