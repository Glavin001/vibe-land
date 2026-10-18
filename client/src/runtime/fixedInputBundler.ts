import type { SemanticInputState } from '../input/types';
import type { InputCmd } from '../net/protocol';
import { buildInputFromState } from '../scene/inputBuilder';

/** The shared client core's bundler (client-core input.rs, the Unreal client's), as core/clientCore.ts gives it. */
export type CoreInputBundler = {
  reset(nextSeq: number): void;
  next_seq(): number;
  remainder_s(): number;
  produce(dt: number, moveX: number, moveY: number, yaw: number, pitch: number, buttons: number): Float64Array;
};
let coreBundler: ((fixedDtSec: number, maxCatchupSteps: number) => CoreInputBundler) | null = null;

/** Make new bundlers delegate to the core's (behind `?coreInput=1`), or to this file's with null. */
export function provideCoreInputBundler(factory: ((fixedDtSec: number, maxCatchupSteps: number) => CoreInputBundler) | null): void {
  coreBundler = factory;
}

export class FixedInputBundler {
  private accumulatorSec = 0;
  private nextSeq = 1;
  private core: CoreInputBundler | null = null;
  /** Whether this bundler has produced frames on its own (then it stays on its own until a reset). */
  private started = false;

  constructor(
    private readonly fixedDtSec: number,
    private readonly maxCatchupSteps: number,
  ) {
    this.attachCore();
  }

  /**
   * Delegate to the core when it is provided. Runtimes build their bundlers before the WASM loads,
   * so this is retried at every reset and before the first frame, never mid-sequence.
   */
  private attachCore(): void {
    if (!this.core && !this.started && coreBundler) {
      this.core = coreBundler(this.fixedDtSec, this.maxCatchupSteps);
      this.core.reset(this.nextSeq & 0xffff);
    }
  }

  reset(nextSeq = 1): void {
    this.accumulatorSec = 0;
    this.nextSeq = nextSeq;
    this.started = false;
    this.attachCore();
    this.core?.reset(nextSeq & 0xffff);
  }

  /** Sub-tick render lead; never advances input sequence or server simulation. */
  remainderSec(): number {
    if (this.core) return this.core.remainder_s();
    return Math.max(0,Math.min(this.fixedDtSec,this.accumulatorSec));
  }

  /** Whether this bundler's frames come from the shared core (`?coreInput=1`). */
  usesCore(): boolean {
    return this.core !== null;
  }

  peekNextSeq(): number {
    if (this.core) return this.core.next_seq();
    return this.nextSeq & 0xffff;
  }

  produce(frameDeltaSec: number, input: SemanticInputState): InputCmd[] {
    this.attachCore();
    if (this.core) {
      const f = this.core.produce(frameDeltaSec, input.moveX, input.moveY, input.yaw, input.pitch, input.buttons);
      const frames: InputCmd[] = [];
      for (let i = 0; i < f.length; i += 6) {
        frames.push({ seq: f[i], buttons: f[i + 1], moveX: f[i + 2], moveY: f[i + 3], yaw: f[i + 4], pitch: f[i + 5] });
      }
      return frames;
    }
    this.started = true;
    this.accumulatorSec += frameDeltaSec;

    const bundledInputs: InputCmd[] = [];
    let steps = 0;
    while (this.accumulatorSec >= this.fixedDtSec && steps < this.maxCatchupSteps) {
      const seq = this.nextSeq++ & 0xffff;
      bundledInputs.push(buildInputFromState(seq, 0, input));
      this.accumulatorSec -= this.fixedDtSec;
      steps += 1;
    }

    if (this.accumulatorSec > this.fixedDtSec) {
      this.accumulatorSec = this.fixedDtSec;
    }

    return bundledInputs;
  }
}
