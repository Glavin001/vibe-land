// The debris beds (destructionActivity.ts) from the shared client core (client-core audio.rs
// `Activity`, through client-core-wasm), behind `?coreAudio=1`; coreActivity.test.ts holds the two
// equal. engine.ts holds a SwitchableActivity: the TypeScript class until the core is provided,
// then the core's, switched only while no region is live so no energy is lost.
import { CoreActivity } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { DestructionActivity, type ActivityEmitter } from './destructionActivity';
import type { AcousticMaterial, SoundEvent, Vec3 } from './model';

export interface ActivityLike {
  add(e: SoundEvent, listener: Vec3, nowMs: number): void;
  sample(nowMs: number, listener: Vec3): ActivityEmitter[];
  clear(): void;
  readonly regionCount: number;
}

/** The core's DestructionActivity (needs the WASM loaded). */
export class CoreDestructionActivity implements ActivityLike {
  private readonly core = new CoreActivity();
  private live = 0;
  add(e: SoundEvent, listener: Vec3, nowMs: number): void {
    this.core.add(e.id, e.kind, e.material, e.position[0], e.position[1], e.position[2], e.intensity, e.size, e.atMs,
      e.occlusion ?? 0, listener[0], listener[1], listener[2], nowMs);
  }
  sample(nowMs: number, listener: Vec3): ActivityEmitter[] {
    const n = this.core.sample(nowMs, listener[0], listener[1], listener[2]);
    this.live = n;
    const out: ActivityEmitter[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.core.position(i);
      out.push({ id: `debris-bed:${this.core.key(i)}`, position: [p[0], p[1], p[2]], material: this.core.material(i) as AcousticMaterial,
        intensity: this.core.intensity(i), occlusion: this.core.occlusion(i) });
    }
    return out;
  }
  clear(): void { this.core.clear(); this.live = 0; }
  /** Beds sampled last (the core keeps its regions internal). */
  get regionCount(): number { return this.live; }
}

let coreProvided = false;
export function provideCoreActivity(): void { coreProvided = true; }

/** The TypeScript activity until the core is provided, then the core's from the next quiet moment. */
export class SwitchableActivity implements ActivityLike {
  private inner: ActivityLike = new DestructionActivity();
  private switchIfQuiet(): void {
    if (coreProvided && !(this.inner instanceof CoreDestructionActivity) && this.inner.regionCount === 0) this.inner = new CoreDestructionActivity();
  }
  add(e: SoundEvent, listener: Vec3, nowMs: number): void { this.switchIfQuiet(); this.inner.add(e, listener, nowMs); }
  sample(nowMs: number, listener: Vec3): ActivityEmitter[] { return this.inner.sample(nowMs, listener); }
  clear(): void { this.inner.clear(); this.switchIfQuiet(); }
  get regionCount(): number { return this.inner.regionCount; }
  get usesCore(): boolean { return this.inner instanceof CoreDestructionActivity; }
}
