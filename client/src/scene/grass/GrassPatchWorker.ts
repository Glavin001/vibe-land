import type { GrassPaintDocument } from './GrassPaint';
import type { GrassExclusion, GrassPatchData, GrassQuality } from './grassPlacement';
export interface GrassPatchRequest {
  x: number; z: number; revision: number; quality: GrassQuality;
  exclusions: readonly GrassExclusion[]; paint: GrassPaintDocument;
}
export interface GrassPatchResult { x: number; z: number; revision: number; data: GrassPatchData }

/** Single bounded job, transferable results, and a synchronous fallback for tests/CSP failures. */
export class GrassPatchWorker {
  private worker: Worker | null = null;
  private started = 0;
  private pending = false;
  private result: GrassPatchResult | null = null;
  constructor() {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./grass.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<GrassPatchResult>) => { this.result = event.data; this.pending = false; };
      this.worker.onerror = () => this.dispose();
    } catch { this.dispose(); }
  }
  get available(): boolean { return this.worker !== null; }
  get busy(): boolean { return this.pending || this.result !== null; }
  request(request: GrassPatchRequest): void {
    if (!this.worker || this.busy) return;
    this.pending = true; this.started = performance.now();
    try { this.worker.postMessage(request); } catch { this.dispose(); }
  }
  take(): GrassPatchResult | null {
    if (this.pending && performance.now()-this.started > 5000) this.dispose();
    const result = this.result; this.result = null; return result;
  }
  dispose(): void { this.worker?.terminate(); this.worker = null; this.result = null; this.pending = false; }
}
