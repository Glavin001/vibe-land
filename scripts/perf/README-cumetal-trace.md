# Attributing a slow tick on the Mac

Tools for asking where a slow server tick spends its time on CuMetal: GPU work,
GPU idle, host waits or CPU work. They attribute; they never time. Take timings
from `scripts/perf/suite.sh` or `perf_bench`.

## 1. A trace

- **perf_bench**, with a tick marker per step:

  ```bash
  cd server && /Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh trace env \
    VIBE_PERF_SCENARIOS=meteor VIBE_PERF_PACE=1 VIBE_PERF_ALL_TICKS=1 VIBE_PERF_MARKERS=1 \
    CUMETAL_TRACE_COMMITS=1 CUMETAL_TRACE_SYNC=1 <bench binary> perf_bench --ignored --nocapture --test-threads=1 > trace.log 2>&1
  ```

- **The perf suite**: `CUMETAL_TRACE_COMMITS=1 CUMETAL_TRACE_SYNC=1 scripts/perf/suite.sh --quick --profiles runtime --no-compare`.
  - The CuMetal variables reach the jobs through the profile environment.
  - `PX_*`, `VIBE_*` and `BLAST_*` variables from your shell do not reach the jobs.
- **Exact per-kernel GPU time**: add `CUMETAL_BATCH_DISPATCHES=0 CUMETAL_COND_ICB=0`.
  - This puts every dispatch in its own command buffer, at about 20 µs each.
  - Compare kernels with it; never compare ticks.

## 2. `cumetal_trace.py`

```bash
scripts/perf/cumetal_trace.py cbs      trace.log --min 16.7   # GPU ms by command-buffer signature
scripts/perf/cumetal_trace.py kernels  trace.log --by count   # dispatches per kernel
scripts/perf/cumetal_trace.py gaps     trace.log              # GPU idle: CPU late vs commit-to-start latency
scripts/perf/cumetal_trace.py syncs    trace.log              # host waits by reason (or source line, below)
scripts/perf/cumetal_trace.py timeline trace.log --tick 349   # one tick in order
```

`--min MS` picks the slow ticks; `--max MS` picks the ordinary ones.

What it showed on 2026-10-07 (runtime profile, M3 Max), docs/perf/BACKLOG.md item 6:
- **A lab correction tick**: about 105 command buffers and about 710 dispatches.
  - GPU busy is about 18 ms.
  - GPU idle is about 10 ms: 4.3 ms of the CPU committing late and 5.7 ms of commit-to-start latency, about 0.1 ms per command buffer on an idle GPU.
- **Town**: the waits are mostly the CPU waiting for queued GPU work.

## 3. Which line waits (sync-site recipe)

Wrap the synchronisations in the PhysX file under study, temporarily, after its includes:

```cpp
static bool pxSyncSites(){static const bool on=std::getenv("PX_SYNC_SITES")!=nullptr;return on;}
static inline cudaError_t pxEventSync(cudaEvent_t e,int line){if(pxSyncSites())fprintf(stderr,"SYNCSITE %d\n",line);return (cudaEventSynchronize)(e);}
static inline cudaError_t pxStreamSync(cudaStream_t s,int line){if(pxSyncSites())fprintf(stderr,"SYNCSITE %d\n",line);return (cudaStreamSynchronize)(s);}
#define cudaEventSynchronize(e) pxEventSync(e,__LINE__)
#define cudaStreamSynchronize(s) pxStreamSync(s,__LINE__)
```

Then:
1. Rebuild the SDK.
2. Run perf_bench with `PX_SYNC_SITES=1` and the trace variables (the suite strips `PX_*`).
3. Read the result with `cumetal_trace.py syncs`. Its line numbers are shifted by the wrapper's lines.

Do not commit the wrapper.

Device `printf` inside a captured stress graph made native configuration fail. Use a debug buffer instead.

## 4. CPU samples of one suite job

```bash
scripts/perf/gpu-run.sh sample python3 scripts/perf/sample_suite_job.py target/perf-suite/runs/<run> lab-truck /tmp/s1
```

- The job runs in the suite's own environment, under macOS `sample`.
- Merge several runs: a correction tick yields only about 30 one-millisecond samples.
- Keep the stacks inside the physics step and drop the wait leaves (`__psynch_cvwait`, `semaphore_wait_trap`, ...).

## 5. Which code waits, by stack

`VIBE_GPU_SHARED=1 scripts/perf/gpu-run.sh lldb python3 scripts/perf/lldb_suite_job.py target/perf-suite/runs/<run> lab-truck out.log`
runs one suite job under lldb and prints a backtrace at every CuMetal host wait
(`lldb-wait-stacks.cmds`). The SUITE_TICK lines close each tick. Use it for attribution only.
