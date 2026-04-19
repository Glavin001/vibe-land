const STORAGE_KEY = 'vibe-land/player-identity';

function randomFallback(): string {
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getOrCreatePlayerIdentity(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const cryptoObj = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
    const fresh = cryptoObj?.randomUUID?.() ?? randomFallback();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return randomFallback();
  }
}
