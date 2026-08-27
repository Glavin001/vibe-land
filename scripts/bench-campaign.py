#!/usr/bin/env python3
"""Repeatable full-demolition benchmark for the 24k-chunk city.

The problem this exists to solve: GPU physics is not reproducible, so every run
destroys a different amount of building. Comparing whole-run medians therefore
compares damage, not code -- which is how a perf campaign convinces itself of
wins it did not get, and it has happened here already.

The fix is to compare at MATCHED LOAD rather than matched wall-clock. Every
per-tick sample is bucketed by awake-body count, and configs are compared
bucket by bucket. "end_ms at 4-6k awake" is a comparable number across runs
that collapsed different amounts of city; "median end_ms over the run" is not.

  run      scripts/bench-campaign.py run -n 3 --tag before
  compare  scripts/bench-campaign.py compare before after

Baselines live in bench-results/ and are plain JSON, so they survive sessions.
"""
import argparse, json, os, statistics as st, subprocess, sys, time
from pathlib import Path

RESULTS = Path("bench-results")
# Buckets in awake bodies. The tick cost is dominated by awake count, so this
# is the axis that makes two runs comparable.
BUCKETS = [(0, 1000), (1000, 2000), (2000, 3000), (3000, 4500),
           (4500, 6000), (6000, 8000), (8000, 10**9)]
# Cumulative counters: reported as per-tick rates, not raw totals.
CUMULATIVE = {"contacts_q", "islands_skip", "islands_tot", "quiet",
              "freeze", "unfreeze", "contact_wakes"}
SKIP = {"tick", "bodies", "awake", "frozen", "sleeping", "bonds", "min_y"}

def bucket_of(awake):
    for i, (lo, hi) in enumerate(BUCKETS):
        if lo <= awake < hi:
            return i
    return len(BUCKETS) - 1

def parse(csv_path):
    rows = []
    with open(csv_path) as f:
        header = f.readline().strip().split(",")
        prev = None
        for line in f:
            parts = line.strip().split(",")
            if len(parts) != len(header):
                continue
            r = {}
            for k, v in zip(header, parts):
                try:
                    r[k] = float(v)
                except ValueError:
                    r[k] = 0.0
            # differentiate cumulative counters into per-tick rates
            if prev is not None:
                for k in CUMULATIVE:
                    if k in r:
                        r[k] = max(0.0, r[k] - prev[k])
            else:
                for k in CUMULATIVE:
                    r[k] = 0.0
            prev = dict(zip(header, (float(x) if x.replace('.','',1).replace('-','',1).isdigit()
                                     else 0.0 for x in parts)))
            rows.append(r)
    return rows

def summarize(all_rows):
    """all_rows: list of per-trial row lists -> bucketed summary."""
    metrics = [k for k in all_rows[0][0] if k not in SKIP]
    out = {"buckets": [], "trials": len(all_rows)}
    for bi, (lo, hi) in enumerate(BUCKETS):
        per_trial = []
        for rows in all_rows:
            sel = [r for r in rows if bucket_of(r["awake"]) == bi and r["tick"] > 0]
            if len(sel) < 10:      # too few ticks in this bucket to mean anything
                continue
            per_trial.append({m: st.median([r[m] for r in sel]) for m in metrics}
                             | {"_n": len(sel)})
        if not per_trial:
            out["buckets"].append(None)
            continue
        b = {"range": [lo, hi if hi < 10**9 else None],
             "trials_present": len(per_trial),
             "ticks": sum(t["_n"] for t in per_trial)}
        for m in metrics:
            vals = [t[m] for t in per_trial]
            b[m] = {"median": st.median(vals),
                    # spread the SAME config produces across trials -- the floor
                    # any claimed effect has to clear
                    "spread": (max(vals) - min(vals)) / 2 if len(vals) > 1 else None}
        out["buckets"].append(b)
    return out

def do_run(a):
    RESULTS.mkdir(exist_ok=True)
    env = dict(os.environ,
        LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:"
                        + os.environ.get("LD_LIBRARY_PATH", ""),
        VIBE_CITY_FREEZE="1", VIBE_CITY_VARIED_HEIGHTS="0",
        VIBE_CITY_STRESS_LIMIT_SCALE="0.6", VIBE_CITY_SOLVER_ITERATIONS="32",
        VIBE_CITY_SHOT_BLAST_RADIUS="0.4", VIBE_CITY_SHOT_STRESS_IMPULSE="4.0e7",
        VIBE_WORLD_FRICTION="0.75", VIBE_WORLD_RESTITUTION="0.02",
        VIBE_PHYSX_PROFILE_FETCH="1")
    for kv in a.env or []:
        k, v = kv.split("=", 1)
        env[k] = v

    all_rows, meta = [], []
    for i in range(a.n):
        csv = f"/tmp/bench-{a.tag}-{i}.csv"
        cmd = ["./target/release/record-city-trace",
               "--scene", "destruction/assets/scenes/fractured-downtown.json",
               "--grid", "1", "--seconds", str(a.seconds), "--shots", str(a.shots),
               "--shot-interval-ticks", "4", "--targets", "27",
               "--output", "/dev/null", "--metrics-out", csv]
        t0 = time.time()
        r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=7200)
        if r.returncode != 0:
            print(f"  trial {i+1} FAILED\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
            return 1
        rows = parse(csv)
        peak = max(r_["awake"] for r_ in rows)
        bonds = max(r_["bonds"] for r_ in rows)
        all_rows.append(rows)
        meta.append({"peak_awake": peak, "broken_bonds": bonds, "ticks": len(rows),
                     "wall_s": round(time.time() - t0, 1)})
        print(f"  trial {i+1}/{a.n}  peak_awake {peak:.0f}  bonds {bonds:.0f}  "
              f"{time.time()-t0:.0f}s", flush=True)
        os.remove(csv)

    summary = summarize(all_rows)
    # The FULL resolved child env, not just CLI overrides: the hardcoded
    # block above (including PROFILE_FETCH=1, an observer-effect knob) shaped
    # every past campaign number and was recorded nowhere. Plus build
    # identity, for the same reason run dirs carry it.
    resolved_env = {k: v for k, v in env.items()
                    if k.startswith(("VIBE_", "BLAST_"))}
    git = subprocess.run(["git", "describe", "--always", "--dirty"],
                         capture_output=True, text=True).stdout.strip() or "unknown"
    summary["meta"] = {"tag": a.tag, "trials": meta, "env_overrides": a.env or [],
                       "resolved_env": resolved_env, "git": git,
                       "seconds": a.seconds, "shots": a.shots}
    path = RESULTS / f"{a.tag}.json"
    path.write_text(json.dumps(summary, indent=1))
    print(f"\nwrote {path}")
    report(summary)
    return 0

KEY = ["stress_solve", "physx_step", "begin", "solve", "end", "readback", "support",
       "events", "filters", "contact_proc", "gravity", "frac_topo", "frac_valid",
       "frac_rebuild", "frac_gen", "gpu_wait", "fetch_copy", "gpu_solve"]

def report(s):
    print(f"\n{'awake bucket':>14s} {'ticks':>6s} " + "".join(f"{m[:9]:>10s}" for m in KEY[:8]))
    for b in s["buckets"]:
        if not b: continue
        lo, hi = b["range"]
        label = f"{lo//1000}-{'inf' if hi is None else hi//1000}k"
        print(f"{label:>14s} {b['ticks']:>6d} " +
              "".join(f"{b[m]['median']:>10.2f}" for m in KEY[:8]))

def do_compare(a):
    A = json.loads((RESULTS / f"{a.before}.json").read_text())
    B = json.loads((RESULTS / f"{a.after}.json").read_text())
    print(f"{a.before} -> {a.after}\n")
    for bi, (ba, bb) in enumerate(zip(A["buckets"], B["buckets"])):
        if not ba or not bb: continue
        lo, hi = ba["range"]
        label = f"{lo//1000}-{'inf' if hi is None else hi//1000}k awake"
        print(f"=== {label}  ({ba['ticks']} vs {bb['ticks']} ticks) ===")
        print(f"  {'metric':14s} {'before':>9s} {'after':>9s} {'delta':>9s} {'noise':>8s}  verdict")
        for m in KEY:
            if m not in ba or m not in bb: continue
            mo, mn = ba[m]["median"], bb[m]["median"]
            sa, sb = ba[m].get("spread"), bb[m].get("spread")
            noise = max([x for x in (sa, sb) if x is not None], default=None)
            d = mn - mo
            if noise is None:
                v = "n=1, unmeasured"
            elif abs(d) > noise and noise > 0:
                v = "MEASURABLE " + ("better" if d < 0 else "WORSE")
            else:
                v = "inside noise"
            n = f"{noise:8.2f}" if noise is not None else "     n/a"
            print(f"  {m:14s} {mo:9.2f} {mn:9.2f} {d:+9.2f} {n}  {v}")
        print()
    return 0

ap = argparse.ArgumentParser()
sub = ap.add_subparsers(dest="cmd", required=True)
r = sub.add_parser("run"); r.add_argument("--tag", required=True)
r.add_argument("-n", type=int, default=3); r.add_argument("--seconds", default="45")
r.add_argument("--shots", default="700"); r.add_argument("--env", action="append")
c = sub.add_parser("compare"); c.add_argument("before"); c.add_argument("after")
a = ap.parse_args()
sys.exit(do_run(a) if a.cmd == "run" else do_compare(a))
