// Play a tape into the real clients, on the clock the tape was cut at.
//
// The replay page's whole difference from the game is here: the clients'
// bytes come from a tape instead of a session, and the manifest and debris
// dictionary are fetched from the page's origin exactly as the game fetches
// them. Each packet is routed as the transport it arrived on routed it: city
// kinds into a CityClient (ledger, presentation, dust), everything else into
// a netcode client (players, vehicles, dynamic bodies, shots; replayWorld.ts).
// Everything downstream is the shipping code, untouched.

import { CityClient } from './cityClient';
import { fetchCityManifest, type LoadedCityManifest } from './manifest';
import { PKT_CITY_BOOTSTRAP, PKT_METEOR_LAUNCHED } from '../net/sharedConstants';
import { routeInboundPacket } from '../net/inbound';
import {
  inboundChannelOf,
  TAPE_CHANNEL_CITY,
  TAPE_CHANNEL_PRELUDE,
  TAPE_CHANNEL_RTT,
  type CityTape,
} from './cityTape';
import { ReplayNetWorld } from './replayWorld';
import { clearMeteorFlights, decodeMeteorLaunched, registerMeteorFlight } from '../vfx/meteorFlights';

export interface ReplayPlayer {
  readonly tape: CityTape;
  readonly client: CityClient;
  /**
   * The rest of the world -- players, vehicles, dynamic bodies, shots -- on a
   * v2 tape; null on a city-only (v1) tape. Replaced when a loop starts over.
   */
  readonly world: ReplayNetWorld | null;
  /** Tape time in ms, 0 at the bootstrap the tape opens on. */
  timeMs(): number;
  /** Where that 0 is on the recording's own clock (ms since recording start). */
  readonly originMs: number;
  /**
   * The recording's clock: ms since the recording started, which is what the
   * packet arrival times, the frame samples and the netcode clock are on.
   */
  tapeTimeMs(): number;
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
  // The tape opens on the resync the recorder asked for; city packets before
  // that bootstrap describe a ledger this client never had.
  let first = tape.packets.findIndex(
    (packet, index) => packet[0] === PKT_CITY_BOOTSTRAP && tape.channels[index] !== TAPE_CHANNEL_RTT,
  );
  if (first < 0) first = 0;
  const origin = tape.times.length > 0 ? tape.times[first] : 0;
  const client = new CityClient(assets.manifest, () => {}, await assets.decoder());
  // A v2 tape carries the transport channels; a v1 tape is the city alone.
  const hasGameStream = tape.channels.some((channel) => channel !== TAPE_CHANNEL_CITY);
  let cursor = 0;
  let startedAt = 0;
  let pausedAt = 0;
  let playingNow = false;
  const durationMs = tape.times.length > 0 ? tape.times[tape.times.length - 1] - origin : 0;
  // While a packet is dispatched the netcode clock reads its arrival time, so
  // the server-clock estimator sees each snapshot when the recording machine
  // did, whatever frame the replay happens to apply it in.
  let dispatchAtMs: number | null = null;
  const tapeNow = () => dispatchAtMs ?? origin + player.timeMs();
  const newWorld = () => (hasGameStream ? new ReplayNetWorld(tapeNow) : null);
  let world = newWorld();
  // A fresh player (a rewind) starts with no rocks in the air.
  clearMeteorFlights();

  // A meteor launch is on the city stream; its body is in the snapshots. Each
  // flight is registered on the tape clock: through the server-clock offset
  // when the tape has the game stream (as the live runtime does), and as
  // leaving when its packet arrived on a city-only tape, whose meteor layer
  // then draws the planned arc with no body.
  const launchMeteor = (packet: Uint8Array, arrivedMs: number) => {
    const launch = decodeMeteorLaunched(packet);
    if (!launch) return;
    if (world) {
      const w = world;
      registerMeteorFlight(launch, (serverTimeUs) => w.serverToTapeMs(serverTimeUs));
    } else {
      registerMeteorFlight(launch, () => arrivedMs);
    }
  };

  const dispatch = (index: number) => {
    const packet = tape.packets[index];
    const channel = tape.channels[index];
    const arrivedMs = tape.times[index];
    dispatchAtMs = arrivedMs;
    try {
      if (channel === TAPE_CHANNEL_RTT) {
        if (packet.length >= 4) {
          world?.observeRtt(new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getFloat32(0, true));
        }
        return;
      }
      const inbound = inboundChannelOf(channel);
      const isCity = inbound === null || routeInboundPacket(packet, inbound).route === 'city';
      if (!isCity) {
        world?.deliver(packet, inbound!);
        return;
      }
      if (index < first && (channel & TAPE_CHANNEL_PRELUDE) === 0) return;
      if (packet[0] === PKT_METEOR_LAUNCHED) {
        launchMeteor(packet, arrivedMs);
        return;
      }
      client.handlePacket(packet);
    } catch (error) {
      console.warn('[cityreplay] packet', index, 'failed', error);
    } finally {
      dispatchAtMs = null;
    }
  };

  const dispatchThrough = (tapeMs: number) => {
    while (cursor < tape.packets.length && tape.times[cursor] <= tapeMs) {
      dispatch(cursor);
      cursor += 1;
    }
  };

  const player: ReplayPlayer = {
    tape,
    client,
    get world() {
      return world;
    },
    originMs: origin,
    speed: 1,
    loop: false,
    timeMs: () => (playingNow ? (performance.now() - startedAt) * player.speed : pausedAt),
    tapeTimeMs: () => origin + player.timeMs(),
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
      pausedAt = target;
      startedAt = performance.now() - target / player.speed;
      dispatchThrough(origin + target);
      // Dust is born at the wall clock a packet is applied, so the burst just
      // applied would raise a minute of destruction dust at once -- a storm
      // the tape never had, thick enough to hide the city and to dominate a
      // measurement taken from here. The skipped past raises none.
      client.drainDustSources(() => {});
    },
    tick: () => {
      if (!playingNow) return;
      dispatchThrough(origin + player.timeMs());
      if (cursor >= tape.packets.length) {
        if (player.loop) {
          // Looping means the SAME city client sees the tape again from its
          // bootstrap, which re-bootstraps the ledger in place. The netcode
          // client cannot go back in time (it drops snapshots older than the
          // newest it has), so the rest of the world starts afresh.
          cursor = 0;
          clearMeteorFlights();
          world = newWorld();
          startedAt = performance.now();
          pausedAt = 0;
          dispatchThrough(origin);
        } else {
          // The tape is over; the clock stops with it. A settled end state
          // at 120 Hz is not a measurement of the storm.
          pausedAt = durationMs;
          playingNow = false;
        }
      }
    },
  };
  // Everything up to the bootstrap: the prelude, and the snapshots that
  // arrived while the resync was in flight, each at its own time.
  dispatchThrough(origin);
  return player;
}
