// Play a city tape into a real CityClient, on the clock the tape was cut at.
//
// The replay page's whole difference from the game is here: the client's
// bytes come from a tape instead of a session, and the manifest and debris
// dictionary are fetched from the page's origin exactly as the game fetches
// them. Everything downstream -- ledger, presentation, renderer, dust -- is
// the shipping code, untouched.

import { CityClient } from './cityClient';
import { fetchCityManifest, type LoadedCityManifest } from './manifest';
import { PKT_CITY_BOOTSTRAP } from '../net/sharedConstants';

/**
 * Tapes recorded before projectiles streamed from birth carry the meteor
 * launch packet the client no longer decodes. Skipped, not fed to the city
 * client, which never wanted it.
 */
const LEGACY_PKT_METEOR_LAUNCHED = 130;
import type { CityTape } from './cityTape';

export interface ReplayPlayer {
  readonly tape: CityTape;
  readonly client: CityClient;
  /** Tape time in ms, 0 at the bootstrap the tape opens on. */
  timeMs(): number;
  /** True once the last packet has played and `loop` is off. */
  ended(): boolean;
  durationMs(): number;
  playing(): boolean;
  play(): void;
  pause(): void;
  /**
   * A fresh client at the tape's start. The renderer sees a new client and
   * rebuilds its meshes, exactly as it does for a new match.
   */
  rewind(): Promise<ReplayPlayer>;
  /** Called every frame by the page; dispatches every packet now due. */
  tick(): void;
  /**
   * Jump forward to `ms` of tape: every packet up to there is applied at
   * once. Backwards is a rewind followed by this; the page does that.
   */
  fastForward(ms: number): void;
  /** Playback rate; 1 is real time. */
  speed: number;
  loop: boolean;
}

/**
 * What the tape needs from the origin, fetched once and shared across
 * rewinds: the manifest by hash and the wasm decoder's dictionary.
 */
export async function loadReplayAssets(tape: CityTape, baseUrl = ''): Promise<{
  manifest: LoadedCityManifest;
  decoder: (() => Promise<{ decoder: import('./debrisWasm').DebrisDecoder } | undefined>);
}> {
  const manifest = await fetchCityManifest(baseUrl, tape.header.manifestHash);
  let dictionary: Uint8Array | null = null;
  const decoder = async () => {
    if (tape.header.wireVersion !== 3) return undefined;
    const { initDebrisWasm, fetchDebrisDictionary, createDebrisDecoder } = await import('./debrisWasm');
    await initDebrisWasm();
    dictionary = dictionary ?? await fetchDebrisDictionary();
    return { decoder: createDebrisDecoder(dictionary, 1 << 16, tape.header.simHz) };
  };
  return { manifest, decoder };
}

export async function createReplayPlayer(
  tape: CityTape,
  assets: Awaited<ReturnType<typeof loadReplayAssets>>,
): Promise<ReplayPlayer> {
  // The tape opens on the resync the recorder asked for; anything before that
  // bootstrap describes a ledger this client never had.
  let first = tape.packets.findIndex((packet) => packet[0] === PKT_CITY_BOOTSTRAP);
  if (first < 0) first = 0;
  const origin = tape.times[first];
  const client = new CityClient(assets.manifest, () => {}, await assets.decoder());
  let cursor = first;
  let startedAt = 0;
  let pausedAt = 0;
  let playingNow = false;
  const durationMs = tape.times.length > 0 ? tape.times[tape.times.length - 1] - origin : 0;

  const player: ReplayPlayer = {
    tape,
    client,
    speed: 1,
    loop: false,
    timeMs: () => (playingNow ? (performance.now() - startedAt) * player.speed : pausedAt),
    durationMs: () => durationMs,
    playing: () => playingNow,
    ended: () => !playingNow && cursor >= tape.packets.length && !player.loop,
    play: () => {
      if (playingNow) return;
      startedAt = performance.now() - pausedAt / player.speed;
      playingNow = true;
    },
    pause: () => {
      if (!playingNow) return;
      pausedAt = player.timeMs();
      playingNow = false;
    },
    rewind: () => createReplayPlayer(tape, assets),
    fastForward: (ms) => {
      const target = Math.min(durationMs, Math.max(0, ms));
      while (cursor < tape.packets.length && tape.times[cursor] - origin <= target) {
        const packet = tape.packets[cursor];
        cursor += 1;
        if (packet[0] === LEGACY_PKT_METEOR_LAUNCHED) continue;
        client.handlePacket(packet);
      }
      // Dust is born at the wall clock a packet is applied, so the burst just
      // applied would raise a minute of destruction dust at once -- a storm
      // the tape never had, thick enough to hide the city and to dominate a
      // measurement taken from here. The skipped past raises none.
      client.drainDustSources(() => {});
      pausedAt = target;
      startedAt = performance.now() - target / player.speed;
    },
    tick: () => {
      if (!playingNow) return;
      const now = player.timeMs();
      while (cursor < tape.packets.length && tape.times[cursor] - origin <= now) {
        const packet = tape.packets[cursor];
        cursor += 1;
        // Old tapes' launch packets: the rock's own body and the dust it
        // raises are in the stream regardless.
        if (packet[0] === LEGACY_PKT_METEOR_LAUNCHED) continue;
        client.handlePacket(packet);
      }
      if (cursor >= tape.packets.length) {
        if (player.loop) {
          // Looping means the SAME client sees the tape again from its
          // bootstrap, which re-bootstraps the ledger in place.
          cursor = first;
          startedAt = performance.now();
          pausedAt = 0;
        } else {
          // The tape is over; the clock stops with it. A settled end state
          // at 120 Hz is not a measurement of the storm.
          pausedAt = durationMs;
          playingNow = false;
        }
      }
    },
  };
  return player;
}
