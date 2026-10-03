"""`vl perf gpu`: real GPU time per tick on Metal, from CuMetal's commit trace.

On Metal the stage's `cuda.*` zones and `*_gpu_ms` are host timestamps
(CuMetal's cudaEventElapsedTime subtracts steady_clock stamps), so the only
real GPU timing is the command buffers' own GPUStartTime/GPUEndTime, which
CuMetal prints with CUMETAL_TRACE_COMMITS=1:

  CUMETAL_COMMIT seq= kind= stream= dispatches=N commit_s= gpu_start_s= gpu_end_s=
                 done_s= steady_commit_ns= waits= kernels=k1,k2,...   (one name per dispatch)

All `_s` fields are mach_absolute_time seconds, the clock the server stamps
each tick record with (`TickTiming.abs_end_s`). This joins the two:

- per tick: GPU busy (the union of buffer GPU windows inside the tick), the
  number of command buffers, the CPU-to-GPU latency (gpu_start - commit) and
  the GPU idle gaps inside the tick;
- per kernel: GPU time over the run, a buffer's time split evenly over its
  dispatches (APPROXIMATE: Metal reports time per command buffer, not per
  dispatch), per tick and per step;
- what fraction of the tick's wall time the GPU was busy -- the difference
  between "the GPU is slow" and "we wait on the GPU while it idles".

The trace itself costs time (a line per buffer); use it for attribution runs,
not for the numbers you quote.
"""
from __future__ import annotations

import json
import re
import statistics as st
from collections import defaultdict
from pathlib import Path

LINE = re.compile(r"CUMETAL_COMMIT (.*)$")


def parse(log: Path):
    buffers = []
    for line in log.read_text(errors="replace").splitlines():
        m = LINE.search(line)
        if not m:
            continue
        fields = dict(kv.split("=", 1) for kv in m.group(1).split() if "=" in kv)
        try:
            b = {"seq": int(fields["seq"]), "kind": fields.get("kind"), "dispatches": int(fields.get("dispatches", 0)),
                 "commit": float(fields["commit_s"]), "start": float(fields["gpu_start_s"]), "end": float(fields["gpu_end_s"]),
                 "done": float(fields["done_s"]), "waits": int(fields.get("waits", 0)),
                 "kernels": [] if fields.get("kernels", "-") == "-" else fields["kernels"].split(",")}
        except (KeyError, ValueError):
            continue
        if b["end"] > b["start"] > 0:
            buffers.append(b)
    buffers.sort(key=lambda b: b["start"])
    return buffers


def union_ms(intervals):
    total, cur_s, cur_e = 0.0, None, None
    for s, e in sorted(intervals):
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        total += cur_e - cur_s
    return total * 1e3


def join(ticks, buffers):
    """Per tick: GPU busy ms, buffers, latency, per-kernel ms (approximate)."""
    rows = []
    j = 0
    for t in ticks:
        end = t.get("abs_end_s")
        if end is None:
            continue
        start = end - (t.get("total_ms") or 0) / 1e3
        while j < len(buffers) and buffers[j]["end"] < start:
            j += 1
        inside, k = [], j
        while k < len(buffers) and buffers[k]["start"] <= end:
            b = buffers[k]
            s, e = max(b["start"], start), min(b["end"], end)
            if e > s:
                inside.append((b, s, e))
            k += 1
        busy = union_ms([(s, e) for _, s, e in inside])
        kernels = defaultdict(float)
        for b, s, e in inside:
            share = (e - s) * 1e3 / max(len(b["kernels"]), 1)
            for name in b["kernels"] or ["(unnamed)"]:
                kernels[name] += share
        lat = [(b["start"] - b["commit"]) * 1e3 for b, _, _ in inside]
        rows.append({"tick": t["tick"], "total_ms": t.get("total_ms"), "gpu_busy_ms": busy, "buffers": len(inside),
                     "dispatches": sum(b["dispatches"] for b, _, _ in inside),
                     "commit_to_gpu_ms": st.median(lat) if lat else None, "kernels": dict(kernels),
                     "fetch_ms": (t.get("physx") or {}).get("fetch_ms")})
    return rows


def report(rows, top=15, label="run"):
    if not rows:
        print("no ticks joined (no CUMETAL_COMMIT lines, or ticks without abs_end_s)")
        return {}
    busy = [r["gpu_busy_ms"] for r in rows]
    total = [r["total_ms"] or 0 for r in rows]
    fetch = [r["fetch_ms"] for r in rows if r["fetch_ms"] is not None]
    kern = defaultdict(float)
    for r in rows:
        for k, v in r["kernels"].items():
            kern[k] += v
    per_tick = {k: v / len(rows) for k, v in kern.items()}
    out = {"ticks": len(rows), "median_tick_ms": st.median(total), "median_gpu_busy_ms": st.median(busy),
           "median_fetch_ms": st.median(fetch) if fetch else None,
           "median_buffers": st.median(r["buffers"] for r in rows), "median_dispatches": st.median(r["dispatches"] for r in rows),
           "kernels_ms_per_tick": dict(sorted(per_tick.items(), key=lambda kv: -kv[1])[:top])}
    print(f"{label}: {len(rows)} ticks; median tick {out['median_tick_ms']:.2f} ms, GPU busy {out['median_gpu_busy_ms']:.2f} ms"
          + (f", fetch (CPU waiting) {out['median_fetch_ms']:.2f} ms" if fetch else "")
          + f"; {out['median_buffers']:g} command buffers, {out['median_dispatches']:g} dispatches a tick")
    print("  GPU time per tick by kernel (buffer time split evenly over its dispatches, approximate):")
    for k, v in out["kernels_ms_per_tick"].items():
        print(f"    {v:7.3f} ms  {k}")
    return out


def run(log, ticks_path, steps_path=None, top=15):
    from . import perf_explain
    buffers = parse(Path(log))
    ticks = perf_explain.load([ticks_path])
    rows = join(ticks, buffers)
    print(f"{len(buffers)} command buffers in {log}")
    result = {"all": report(rows, top)}
    if steps_path and Path(steps_path).exists():
        for m in json.loads(Path(steps_path).read_text()):
            part = [r for r in rows if m["from_tick"] <= r["tick"] <= m["to_tick"]]
            if part:
                print()
                result[m["step"]] = report(part, top, label=f"step {m['step']}")
    return result


PROV = re.compile(r'CUMETAL_PROVENANCE event=kernel_launch kernel="([^"]*)".*?duration_ns=(-?\d+) grid=\((\d+),(\d+),(\d+)\) block=\((\d+),(\d+),(\d+)\)')


def kernels_exact(log: Path, ticks: int, top=20):
    """Per-kernel GPU time from CUMETAL_TRACE_GPU=1 (each launch waited on, so
    the tick timing is distorted but each kernel's duration is exact), with its
    grid: the kernels that dominate and how much work each launch covers."""
    agg = defaultdict(lambda: {"ms": 0.0, "launches": 0, "threads": []})
    for line in Path(log).read_text(errors="replace").splitlines():
        m = PROV.search(line)
        if not m:
            continue
        name, ns = m.group(1), int(m.group(2))
        if ns < 0:
            continue
        g = [int(x) for x in m.group(3, 4, 5)]
        b = [int(x) for x in m.group(6, 7, 8)]
        a = agg[name]
        a["ms"] += ns / 1e6
        a["launches"] += 1
        a["threads"].append(g[0] * g[1] * g[2] * b[0] * b[1] * b[2])
    rows = sorted(agg.items(), key=lambda kv: -kv[1]["ms"])
    total = sum(v["ms"] for _, v in rows)
    print(f"exact per-kernel GPU time ({len(rows)} kernels, {total:.1f} ms over {ticks} ticks = {total / max(ticks, 1):.3f} ms/tick):")
    for name, v in rows[:top]:
        threads = st.median(v["threads"]) if v["threads"] else 0
        print(f"  {v['ms'] / max(ticks, 1):8.3f} ms/tick  {v['launches'] / max(ticks, 1):6.2f} launches/tick  "
              f"{v['ms'] / max(v['launches'], 1):8.3f} ms/launch  {threads:>10,.0f} threads  {name[:90]}")
    return {name: {"ms_per_tick": v["ms"] / max(ticks, 1), "launches": v["launches"]} for name, v in rows[:top]}
