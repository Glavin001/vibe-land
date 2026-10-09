// The native FPS counter's GPU-time sampler. At most one timestamp readback in
// flight: three maps one result buffer, and resolving again while it is still
// mapped (a slow frame) is a WebGPU validation error and a rejected submit,
// every frame after. Call tick() at the start of each frame.
export type TimestampSampler = { tick(): void; readonly ms: number | null; readonly pending: boolean };

export function createTimestampSampler(
  resolve: () => Promise<number | undefined>,
  every: number,
): TimestampSampler {
  let countdown = every;
  let ms: number | null = null;
  let pending = false;
  return {
    tick() {
      if (pending || --countdown > 0) return;
      countdown = every;
      pending = true;
      void resolve().then((value) => {
        if (typeof value === 'number' && value > 0) ms = value;
      }).catch(() => {}).finally(() => { pending = false; });
    },
    get ms() { return ms; },
    get pending() { return pending; },
  };
}
