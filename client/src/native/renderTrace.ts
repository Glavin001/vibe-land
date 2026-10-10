// Render-frame breadcrumbs for a GPU hang (VIBE_HANG_TRACE, off by default).
//
// Wraps the WebGPU queue's submit: each submission writes `submit frame=N`
// before it is handed to Dawn, `submitted frame=N` when submit returns, and
// `done frame=N` when the GPU has finished it (onSubmittedWorkDone). A hang
// in the app's own rendering then shows as frames submitted but never done;
// a hang in the physics, as render frames still completing while a CuMetal
// command buffer does not (scripts/ops/hang_analyze.py joins both).

export interface TraceableQueue {
  submit(buffers: Iterable<unknown>): void;
  onSubmittedWorkDone?: () => Promise<unknown>;
}

/** Install on `queue`; returns false (and changes nothing) without one. */
export function installRenderTrace(queue: TraceableQueue | undefined, trace: (text: string) => void): boolean {
  if (!queue || typeof queue.submit !== 'function') return false;
  const submit = queue.submit.bind(queue);
  const workDone = typeof queue.onSubmittedWorkDone === 'function' ? queue.onSubmittedWorkDone.bind(queue) : undefined;
  let frame = 0;
  queue.submit = (buffers: Iterable<unknown>) => {
    const id = ++frame;
    const list = Array.from(buffers);
    trace(`submit frame=${id} buffers=${list.length}`);
    submit(list);
    trace(`submitted frame=${id}`);
    workDone?.().then(
      () => trace(`done frame=${id}`),
      (error: unknown) => trace(`done-error frame=${id} ${String(error)}`),
    );
  };
  trace(`render trace installed (onSubmittedWorkDone ${workDone ? 'yes' : 'no'})`);
  return true;
}
