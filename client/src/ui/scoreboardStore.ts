// Central scoreboard store consumed by the leaderboard overlay and HUD chip.
//
// Fed by:
//   - NetcodeClient (multiplayer): welcome, roster resync, stats delta
//   - LocalPracticeClient (singleplayer): `WasmLocalSession.leaderboardJson()`
//
// Exposes a React hook via `useSyncExternalStore` so UI can subscribe
// without per-frame renders. State is replaced wholesale whenever the
// scoreboard changes; consumers should treat entries as immutable per tick.

import { useSyncExternalStore } from 'react';

export type ScoreboardEntry = {
  playerId: number;
  username: string;
  kills: number;
  deaths: number;
  /** True for the player controlling the local session. */
  isLocal: boolean;
  /** True for AI-driven bots (practice mode only). */
  isBot: boolean;
};

export type ScoreboardState = {
  localPlayerId: number;
  entries: ReadonlyArray<ScoreboardEntry>;
};

const EMPTY_STATE: ScoreboardState = { localPlayerId: 0, entries: [] };

let current: ScoreboardState = EMPTY_STATE;
const listeners = new Set<(state: ScoreboardState) => void>();

function publish(next: ScoreboardState): void {
  current = next;
  for (const fn of listeners) fn(current);
}

function sortEntries(entries: ScoreboardEntry[]): ScoreboardEntry[] {
  return [...entries].sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills;
    if (a.deaths !== b.deaths) return a.deaths - b.deaths;
    return a.playerId - b.playerId;
  });
}

export function resetScoreboard(): void {
  publish(EMPTY_STATE);
}

export function setScoreboard(next: {
  localPlayerId: number;
  entries: ScoreboardEntry[];
}): void {
  publish({ localPlayerId: next.localPlayerId, entries: sortEntries(next.entries) });
}

export function setLocalPlayerId(playerId: number): void {
  publish({ ...current, localPlayerId: playerId });
}

export function upsertLocalPlayer(playerId: number, username: string, kills: number, deaths: number): void {
  const entries = current.entries.filter((e) => e.playerId !== playerId);
  entries.push({ playerId, username, kills, deaths, isLocal: true, isBot: false });
  publish({ localPlayerId: playerId, entries: sortEntries(entries) });
}

/**
 * Replace the roster wholesale (multiplayer resync). Preserves `isLocal`
 * by comparing against `current.localPlayerId`. Bots are never sent over
 * the wire, so everything from the network roster is a real player.
 */
export function applyRoster(entries: Array<{ playerId: number; username: string; kills: number; deaths: number }>): void {
  const rebuilt = entries.map<ScoreboardEntry>((entry) => ({
    playerId: entry.playerId,
    username: entry.username,
    kills: entry.kills,
    deaths: entry.deaths,
    isLocal: entry.playerId === current.localPlayerId,
    isBot: false,
  }));
  publish({ localPlayerId: current.localPlayerId, entries: sortEntries(rebuilt) });
}

/**
 * Apply a stats delta (single-kill event). Creates a placeholder entry if the
 * player hasn't arrived via roster yet — the next roster resync will fill in
 * the username.
 */
export function applyStatsDelta(deltas: Array<{ playerId: number; kills: number; deaths: number }>): void {
  const byId = new Map(current.entries.map((e) => [e.playerId, e] as const));
  for (const delta of deltas) {
    const existing = byId.get(delta.playerId);
    if (existing) {
      byId.set(delta.playerId, { ...existing, kills: delta.kills, deaths: delta.deaths });
    } else {
      byId.set(delta.playerId, {
        playerId: delta.playerId,
        username: `Player ${delta.playerId}`,
        kills: delta.kills,
        deaths: delta.deaths,
        isLocal: delta.playerId === current.localPlayerId,
        isBot: false,
      });
    }
  }
  publish({
    localPlayerId: current.localPlayerId,
    entries: sortEntries(Array.from(byId.values())),
  });
}

/**
 * Practice-mode replacement. The WASM session serializes its full leaderboard
 * so we overwrite whatever's present.
 */
export function applyPracticeSnapshot(params: {
  localPlayerId: number;
  entries: Array<{ id: number; username: string; kills: number; deaths: number; isBot: boolean; isLocal: boolean }>;
}): void {
  publish({
    localPlayerId: params.localPlayerId,
    entries: sortEntries(
      params.entries.map((e) => ({
        playerId: e.id,
        username: e.username,
        kills: e.kills,
        deaths: e.deaths,
        isLocal: e.isLocal,
        isBot: e.isBot,
      })),
    ),
  });
}

export function getScoreboard(): ScoreboardState {
  return current;
}

export function subscribeScoreboard(fn: (state: ScoreboardState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useScoreboard(): ScoreboardState {
  return useSyncExternalStore(
    (onStoreChange) => subscribeScoreboard(onStoreChange),
    getScoreboard,
    () => EMPTY_STATE,
  );
}

export function useLocalKD(): { kills: number; deaths: number } {
  const state = useScoreboard();
  const local = state.entries.find((e) => e.playerId === state.localPlayerId);
  return { kills: local?.kills ?? 0, deaths: local?.deaths ?? 0 };
}
