// Play, and the data arrives: the hot-spot watch.
//
// The reporter should not have to press anything. This watches the frame
// pacing of a city match; when frames stay over budget for a couple of
// seconds it (1) opens a tape on a fresh bootstrap and records the next
// twenty seconds -- the collapse that is hurting, camera and all -- (2) saves
// the tape in this browser as `hotspot-<time>` for /cityreplay, (3) sends a
// debug report carrying the frame profile at the trigger and the last thirty
// seconds of frame times, and (4) uploads the tape to the server when the
// server has a route for it (older servers answer 404; the tape stays local
// and the report says so).
//
// A cooldown keeps one collapse from producing five reports, and a per-page
// cap keeps the browser's tape store from growing without bound.

import { renderStats } from './renderStats';
import { cityTapeRecorder, encodeCityTape, saveCityTape, type CityTape } from './cityTape';
import { sendDebugReport, noteHotspot } from './debugReport';

const OVER_BUDGET_FACTOR = 1.6;
const SUSTAIN_MS = 2000;
const COOLDOWN_MS = 45_000;
const TAPE_MS = 20_000;
const MAX_TAPES_PER_PAGE = 6;
const HISTORY_MS = 30_000;

type HotspotStatus = {
  armed: boolean;
  state: 'idle' | 'recording' | 'sending' | 'cooldown';
  fired: number;
  lastFolder: string | null;
  lastTape: string | null;
  tapeUploaded: boolean | null;
  secondsLeft: number;
};

class HotspotWatch {
  private matchId: string | null = null;
  private periodMs = 8.33;
  private overSinceMs = 0;
  private lastFiredMs = -Infinity;
  private fired = 0;
  private state: HotspotStatus['state'] = 'idle';
  private lastFolder: string | null = null;
  private lastTape: string | null = null;
  private tapeUploaded: boolean | null = null;
  private busyUntilMs = 0;
  /** Ring of [tMs, frameMs] at 10 Hz for the report's frame history. */
  private history: Array<[number, number]> = [];
  private lastHistoryMs = 0;
  private listeners = new Set<() => void>();

  arm(matchId: string): void {
    this.matchId = matchId;
    this.notify();
  }

  disarm(): void {
    this.matchId = null;
    this.notify();
  }

  /** The governor's estimate of the display period, so "over budget" means this display's. */
  setPeriod(periodMs: number): void {
    if (periodMs > 0) this.periodMs = periodMs;
  }

  /** Every rendered frame. Cheap: a compare and, ten times a second, a push. */
  observe(nowMs: number, frameMs: number): void {
    if (!this.matchId || !(frameMs > 0)) return;
    if (nowMs - this.lastHistoryMs >= 100) {
      this.lastHistoryMs = nowMs;
      this.history.push([nowMs, frameMs]);
      while (this.history.length > 0 && nowMs - this.history[0][0] > HISTORY_MS) this.history.shift();
    }
    if (this.state !== 'idle' && this.state !== 'cooldown') return;
    if (nowMs < this.busyUntilMs) return;
    if (frameMs > this.periodMs * OVER_BUDGET_FACTOR) {
      if (this.overSinceMs === 0) this.overSinceMs = nowMs;
      if (nowMs - this.overSinceMs >= SUSTAIN_MS && nowMs - this.lastFiredMs >= COOLDOWN_MS
        && this.fired < MAX_TAPES_PER_PAGE && !cityTapeRecorder.recording) {
        this.overSinceMs = 0;
        void this.fire(nowMs);
      }
    } else {
      this.overSinceMs = 0;
    }
  }

  private async fire(nowMs: number): Promise<void> {
    const matchId = this.matchId;
    if (!matchId) return;
    this.lastFiredMs = nowMs;
    this.fired += 1;
    this.state = 'recording';
    this.busyUntilMs = nowMs + TAPE_MS + 5000;
    this.notify();
    const trigger = {
      atMs: nowMs,
      frameMs: renderStats.frameTotalMs,
      cpuFrameMs: renderStats.cpuFrameMs,
      gpuFrameMs: renderStats.gpuFrameMs,
      periodMs: this.periodMs,
      history: this.history.map(([t, ms]) => [Math.round(t - nowMs), Number(ms.toFixed(2))]),
    };
    const session = cityTapeRecorder.start('hotspot');
    if (session === 0) {
      // Someone else is recording; stand down without spending a tape.
      this.fired -= 1;
      this.state = 'idle';
      this.busyUntilMs = 0;
      this.notify();
      return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, TAPE_MS));
    // Null when the player pressed RECORD and took this recording over: it is
    // theirs now, to stop and send whenever they choose.
    const tape = cityTapeRecorder.stop(session);
    if (!tape) {
      this.state = 'cooldown';
      this.notify();
      window.setTimeout(() => {
        if (this.state === 'cooldown') this.state = 'idle';
        this.notify();
      }, COOLDOWN_MS);
      return;
    }
    this.state = 'sending';
    this.notify();
    let tapeName: string | null = null;
    let uploaded: boolean | null = null;
    let tapeFolder: string | null = null;
    if (tape) {
      tapeName = `hotspot-${tape.header.capturedAt.replace(/[:.]/g, '-')}`;
      try {
        await saveCityTape(tapeName, tape);
      } catch {
        tapeName = null;
      }
      const upload = await uploadTape(matchId, tape);
      uploaded = upload.uploaded;
      tapeFolder = upload.folder;
    }
    noteHotspot({ ...trigger, tape: tapeName, tapeUploaded: uploaded, tapeFolder });
    try {
      this.lastFolder = await sendDebugReport(matchId);
    } catch {
      this.lastFolder = null;
    }
    this.lastTape = tapeName;
    this.tapeUploaded = uploaded;
    this.state = 'cooldown';
    this.notify();
    window.setTimeout(() => {
      if (this.state === 'cooldown') {
        this.state = 'idle';
        this.notify();
      }
    }, COOLDOWN_MS);
  }

  status(nowMs = performance.now()): HotspotStatus {
    return {
      armed: this.matchId !== null,
      state: this.state,
      fired: this.fired,
      lastFolder: this.lastFolder,
      lastTape: this.lastTape,
      tapeUploaded: this.tapeUploaded,
      secondsLeft: this.state === 'recording'
        ? Math.max(0, Math.round((this.busyUntilMs - 5000 - nowMs) / 1000))
        : this.state === 'cooldown' ? Math.max(0, Math.round((this.lastFiredMs + COOLDOWN_MS - nowMs) / 1000)) : 0,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** POST the tape; a server without the route answers 404 and the tape stays local. */
export async function uploadTape(matchId: string, tape: CityTape): Promise<{ uploaded: boolean; folder: string | null }> {
  try {
    const bytes = encodeCityTape(tape);
    const response = await fetch(`/match-stats/${encodeURIComponent(matchId)}/tape`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
    });
    if (!response.ok) return { uploaded: false, folder: null };
    const { folder } = (await response.json()) as { folder: string };
    return { uploaded: true, folder };
  } catch {
    return { uploaded: false, folder: null };
  }
}

export const hotspotWatch = new HotspotWatch();
