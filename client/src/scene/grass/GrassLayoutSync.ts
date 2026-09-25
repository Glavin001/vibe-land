import { GrassPaint, type GrassPaintDocument } from './GrassPaint';

export interface SharedGrassSnapshot { revision: string; layout: GrassPaintDocument }
export interface GrassSyncStatus { state: 'idle' | 'loading' | 'ready' | 'error'; revision: string | null; message: string }
let status: GrassSyncStatus = { state: 'idle', revision: null, message: '' };
const listeners = new Set<() => void>();
export const getGrassSyncStatus = () => status;
export const subscribeGrassSyncStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const setGrassSyncStatus = (next: GrassSyncStatus) => { status = next; for (const listener of listeners) listener(); };

export function grassLayoutUrl(origin: string, match: string): string {
  return new URL(`/match-stats/${encodeURIComponent(match)}/grass`, origin).href;
}
export async function fetchSharedGrass(url: string, revision?: string | null, signal?: AbortSignal): Promise<SharedGrassSnapshot | null> {
  const response = await fetch(url, { headers: revision ? { 'If-None-Match': `"${revision}"` } : {}, cache: 'no-store', signal });
  if (response.status === 304) return null;
  if (!response.ok) throw new Error(`Shared grass unavailable (${response.status})`);
  const value = await response.json() as SharedGrassSnapshot;
  if (!value || !/^[a-f0-9]{64}$/.test(value.revision) || value.layout?.version !== 2) throw new Error('Invalid shared grass response');
  // Validate before acknowledging a revision or replacing the visible layout.
  const validator = new GrassPaint();
  try { validator.import(value.layout); } finally { validator.dispose(); }
  return value;
}
export async function publishSharedGrass(url: string, revision: string, layout: GrassPaintDocument, key: string): Promise<SharedGrassSnapshot> {
  const response = await fetch(url, { method: 'PUT', headers: {
    'Content-Type': 'application/json', 'If-Match': `"${revision}"`, Authorization: `Bearer ${key}`,
  }, body: JSON.stringify(layout), signal: AbortSignal.timeout(20_000) });
  if (response.status === 409) throw new Error('Someone updated this city. Load shared grass before publishing again. Your draft is still here.');
  if (response.status === 401 || response.status === 403) throw new Error('Publishing requires the server’s grass editor key.');
  if (!response.ok) throw new Error(`Could not publish grass (${response.status}). Your draft is still here.`);
  const value = await response.json() as SharedGrassSnapshot;
  if (!value || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error('Invalid publishing response');
  return value;
}

/** One conditional request per two seconds, never per frame. No writes from a player. */
export class GrassLayoutSync {
  private revision: string | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  constructor(private readonly paint: GrassPaint, private readonly url: string,
    private readonly report: (value: GrassSyncStatus) => void = setGrassSyncStatus) {}
  start(): void {
    this.paint.clear(); // A private draft must never masquerade as a shared city layout.
    this.report({ state: 'loading', revision: null, message: 'Loading shared grass…' });
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.stopped || this.request) return;
    const request = new AbortController(); this.request = request;
    const timeout = setTimeout(() => request.abort(), 10_000);
    try {
      const snapshot = await fetchSharedGrass(this.url, this.revision, request.signal);
      if (this.stopped) return;
      if (snapshot) { this.paint.import(snapshot.layout); this.revision = snapshot.revision; }
      this.report({ state: 'ready', revision: this.revision, message: `Shared grass · ${this.revision?.slice(0, 8)}` });
    } catch {
      if (!this.stopped) this.report({ state: 'error', revision: this.revision,
        message: this.revision ? 'Grass sync offline · showing last shared layout' : 'Shared grass unavailable · showing default meadow' });
    } finally {
      clearTimeout(timeout); this.request = undefined;
      if (!this.stopped) this.timer = setTimeout(() => { void this.refresh(); }, 2000);
    }
  }
  dispose(): void { this.stopped = true; clearTimeout(this.timer); this.request?.abort(); }
}
