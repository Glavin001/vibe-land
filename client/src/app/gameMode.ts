export type GameMode = 'multiplayer' | 'practice';

export function isPracticeMode(mode: GameMode): boolean {
  return mode === 'practice';
}

export function gameModeLabel(mode: GameMode): string {
  return isPracticeMode(mode) ? 'Firing range' : 'Multiplayer';
}

