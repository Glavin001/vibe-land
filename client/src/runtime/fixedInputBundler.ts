import type { SemanticInputState } from '../input/types';
import type { InputCmd } from '../net/protocol';
import { buildInputFromState } from '../scene/inputBuilder';

export class FixedInputBundler {
  private accumulatorSec = 0;
  private nextSeq = 1;

  constructor(
    private readonly fixedDtSec: number,
    private readonly maxCatchupSteps: number,
  ) {}

  reset(nextSeq = 1): void {
    this.accumulatorSec = 0;
    this.nextSeq = nextSeq;
  }

  peekNextSeq(): number {
    return this.nextSeq & 0xffff;
  }

  produce(frameDeltaSec: number, input: SemanticInputState): InputCmd[] {
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
