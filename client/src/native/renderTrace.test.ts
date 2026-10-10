import { describe, expect, it } from 'vitest';
import { installRenderTrace, type TraceableQueue } from './renderTrace';

describe('installRenderTrace', () => {
  it('writes submit, submitted and done for each frame, in order, and still submits', async () => {
    const submitted: unknown[][] = [];
    let finish: () => void = () => {};
    const queue: TraceableQueue = {
      submit: (buffers) => { submitted.push(Array.from(buffers)); },
      onSubmittedWorkDone: () => new Promise<void>((resolve) => { finish = resolve; }),
    };
    const lines: string[] = [];
    expect(installRenderTrace(queue, (t) => lines.push(t))).toBe(true);
    queue.submit(['a', 'b']);
    expect(submitted).toEqual([['a', 'b']]);
    expect(lines.slice(1)).toEqual(['submit frame=1 buffers=2', 'submitted frame=1']);
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(lines.at(-1)).toBe('done frame=1');
  });

  it('a frame the GPU never finishes leaves no done line', () => {
    const queue: TraceableQueue = { submit: () => {}, onSubmittedWorkDone: () => new Promise(() => {}) };
    const lines: string[] = [];
    installRenderTrace(queue, (t) => lines.push(t));
    queue.submit([]);
    expect(lines.some((l) => l.startsWith('done'))).toBe(false);
  });

  it('changes nothing without a queue', () => {
    expect(installRenderTrace(undefined, () => {})).toBe(false);
  });
});
