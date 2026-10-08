#!/usr/bin/env python3
"""How long each GPU submission holds the GPU, from CuMetal's commit trace.

    CUMETAL_TRACE_COMMITS=1 <run> 2> run.log
    scripts/perf/gpu-submission-summary.py run.log [--budget-ms 4] [--top 15]

Why: Apple's GPU switches between processes between command buffers, not
inside one, so a long one holds off every other app and the window server
(2026-10-08: the native app on Vibe Town starved WindowServer for 40 s, twice,
and macOS's watchdog logged the owner out). A responsibly behaved app keeps
each submission short and its per-frame total within a budget (Apple, Metal
Best Practices: Command Buffers). This prints the distribution of GPU time per
command buffer (gpu_end - gpu_start), the longest ones with their kernels, the
kernels that appear in long ones, and the GPU-busy share of wall time.
Exit 1 when any submission exceeds --budget-ms (0: report only).
"""
import argparse
import collections
import re
import sys

LINE = re.compile(r"CUMETAL_COMMIT seq=(\d+) kind=(\S+) stream=(\S+) dispatches=(\d+) commit_s=([\d.]+) "
                  r"gpu_start_s=([\d.]+) gpu_end_s=([\d.]+) done_s=([\d.]+) steady_commit_ns=(-?\d+) waits=(\d+) kernels=(.*)$")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log")
    ap.add_argument("--budget-ms", type=float, default=0.0)
    ap.add_argument("--top", type=int, default=15)
    a = ap.parse_args()
    rows = []
    with open(a.log, errors="replace") as f:
        for line in f:
            m = LINE.search(line)
            if not m:
                continue
            start, end = float(m.group(6)), float(m.group(7))
            if end <= 0 or start <= 0 or end < start:
                continue  # not executed (an empty or failed buffer)
            rows.append({"seq": int(m.group(1)), "kind": m.group(2), "dispatches": int(m.group(4)),
                         "start": start, "end": end, "ms": (end - start) * 1e3, "waits": int(m.group(10)),
                         "kernels": m.group(11).strip()})
    if not rows:
        print("no CUMETAL_COMMIT lines (run with CUMETAL_TRACE_COMMITS=1)")
        return 2
    ms = sorted(r["ms"] for r in rows)
    q = lambda p: ms[min(len(ms) - 1, int(p * (len(ms) - 1)))]
    span = max(r["end"] for r in rows) - min(r["start"] for r in rows)
    # GPU-busy time: the union of [start, end] intervals.
    busy, cur_s, cur_e = 0.0, None, None
    for r in sorted(rows, key=lambda r: r["start"]):
        if cur_e is None or r["start"] > cur_e:
            if cur_e is not None:
                busy += cur_e - cur_s
            cur_s, cur_e = r["start"], r["end"]
        else:
            cur_e = max(cur_e, r["end"])
    busy += cur_e - cur_s
    print(f"{len(rows)} command buffers over {span:.1f} s; GPU busy (this process) {100 * busy / span:.1f}% of wall time")
    print(f"GPU time per command buffer (ms): p50 {q(0.5):.3f}  p90 {q(0.9):.3f}  p99 {q(0.99):.3f}  "
          f"p99.9 {q(0.999):.3f}  max {ms[-1]:.3f}")
    for edge in (1, 2, 4, 8, 16, 33, 100):
        n = sum(1 for x in ms if x > edge)
        if n:
            print(f"  longer than {edge:>3} ms: {n}")
    print(f"\nlongest {a.top}:")
    for r in sorted(rows, key=lambda r: -r["ms"])[: a.top]:
        k = r["kernels"]
        print(f"  {r['ms']:9.3f} ms  seq {r['seq']:>7}  {r['kind']:<10} dispatches {r['dispatches']:>4}  waits {r['waits']}  "
              f"{k[:160]}{'...' if len(k) > 160 else ''}")
    # Which kernels ride in the long buffers.
    threshold = max(q(0.99), a.budget_ms or 0.0)
    counts = collections.Counter()
    for r in rows:
        if r["ms"] >= threshold:
            for name in set(re.split(r"[,; ]+", r["kernels"])):
                if name and name != "-":
                    counts[name] += 1
    if counts:
        print(f"\nkernels in buffers >= {threshold:.3f} ms:")
        for name, n in counts.most_common(15):
            print(f"  {n:6}  {name[:140]}")
    over = [r for r in rows if a.budget_ms and r["ms"] > a.budget_ms]
    if a.budget_ms:
        print(f"\nbudget {a.budget_ms} ms per command buffer: {len(over)} over")
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
