"""`vl perf explain`: why the costly ticks cost what they cost.

Input: per-tick timing records (`TickTiming`, one JSON object per line) from
a spike dump (`debug-reports/spike-*/ticks.jsonl`), a session capture
(`<bundle>/server/ticks.jsonl`) or any file of them.

For every spike (a tick over the threshold) it compares the tick with the
median of its non-spike neighbours and reports, largest first, the phases that
grew -- top-level brackets, then the PhysX step's phases, then the destruction
stage's zones and engine zones -- the counts that grew with them (bodies
promoted, chunks migrated, contacts, broad-phase pairs, corrections...) and the
events just before it (meteors launched, bonds broken). Across all ticks it
reports what a steady tick is made of, a cost model per phase (least squares
on those counts: ms per unit and R^2) and a priority list: the phases that hold
the most over-budget time.

Zones exist only with the engine profiler on (VIBE_PHYSX_PROFILE=1); zones
overlap and are summed over threads, so they rank causes inside a bracket and
are never added to the brackets. On Metal the `cuda.*` zones and `*_gpu_ms`
stage zones are host timestamps, not GPU time.
"""
from __future__ import annotations

import json
import math
import statistics as st
from pathlib import Path

BRACKETS = ("player_sim_ms", "vehicle_ms", "dynamics_ms", "hitscan_ms", "shots_ms", "city_ms",
            "snapshot_ms", "publish_ms", "unattributed_ms")
PHYSX_TIMES = ("controller_ms", "submit_ms", "fetch_ms", "callbacks_ms", "readback_ms", "players_ms", "overlap_ms")
PHYSX_COUNTS = ("awake_bodies", "found_pairs", "lost_pairs")
STAGE_COUNTS = ("iterations", "passes", "corrections", "bonds_broken", "bonds_broken_after_correction",
                "crushed_chunks", "contacts", "bodies_promoted", "chunks_migrated")
DRIVERS = ("physx.found_pairs", "physx.lost_pairs", "physx.awake_bodies", "stage.bodies_promoted",
           "stage.chunks_migrated", "stage.contacts", "stage.bonds_broken", "stage.corrections",
           "stage.iterations", "awake_city_bodies", "meteors_launched", "players")


def load(paths):
    """Tick records from files or directories (ticks.jsonl inside), in tick order."""
    ticks = []
    for p in map(Path, paths):
        files = [p] if p.is_file() else sorted(p.rglob("ticks.jsonl"))
        for f in files:
            for line in f.read_text().splitlines():
                line = line.strip()
                if line:
                    ticks.append(json.loads(line))
    ticks.sort(key=lambda t: t.get("tick", 0))
    return ticks


def times(t):
    """{metric: ms} at three levels: bracket, physx phase, stage/engine zone."""
    out = {f"bracket.{k}": t.get(k) or 0.0 for k in BRACKETS}
    px = t.get("physx") or {}
    for k in PHYSX_TIMES:
        if k in px:
            out[f"physx.{k}"] = px.get(k) or 0.0
    if px.get("gpu_wait_ms") is not None:
        out["physx.gpu_wait_ms"] = px["gpu_wait_ms"]
    sg = t.get("stage") or {}
    if "observe_ms" in sg:
        out["stage.observe_ms"] = sg["observe_ms"]
    for k, v in (sg.get("zones") or {}).items():
        out[f"zone.{k}"] = v
    for k, v in (t.get("engine_zones") or {}).items():
        out[f"engine.{k}"] = v
    return out


def counts(t):
    px, sg = t.get("physx") or {}, t.get("stage") or {}
    out = {f"physx.{k}": px.get(k, 0) for k in PHYSX_COUNTS if px}
    out.update({f"stage.{k}": sg.get(k, 0) for k in STAGE_COUNTS if sg})
    out["awake_city_bodies"] = t.get("awake_city_bodies", 0)
    out["meteors_launched"] = t.get("meteors_launched", 0)
    out["players"] = t.get("players", 0)
    out["stage.error"] = sg.get("error", 0) if sg else 0
    return out


def level(name):
    return 0 if name.startswith("bracket.") else 1 if name.startswith(("physx.", "stage.")) else 2


def median_of(rows, key):
    vals = [r.get(key, 0.0) or 0.0 for r in rows]
    return st.median(vals) if vals else 0.0


def explain_spike(ticks, i, threshold, radius=10, lookback=60):
    t = ticks[i]
    tick = t.get("tick")
    neighbours = [n for n in ticks[max(0, i - radius): i + radius + 1]
                  if n is not t and (n.get("total_ms") or 0) <= threshold]
    if not neighbours:
        neighbours = [n for n in ticks if (n.get("total_ms") or 0) <= threshold][:2 * radius]
    nt = [times(n) for n in neighbours]
    nc = [counts(n) for n in neighbours]
    mt, mc = times(t), counts(t)
    keys = set(mt) | set().union(*[set(x) for x in nt]) if nt else set(mt)
    deltas = sorted(((k, (mt.get(k) or 0.0) - median_of(nt, k)) for k in keys), key=lambda kv: -kv[1])
    grew = [(k, d) for k, d in deltas if d >= 0.5]
    moved = []
    for k, v in mc.items():
        base = median_of(nc, k)
        if v != base and (abs(v - base) >= 1) and (base == 0 or v / max(base, 1e-9) >= 1.5 or v / max(base, 1e-9) <= 0.67):
            moved.append((k, v, base))
    recent = [r for r in ticks[max(0, i - lookback): i + 1]]
    meteors = [(r["tick"], r.get("meteors_launched")) for r in recent if r.get("meteors_launched")]
    breaks = sum(((r.get("stage") or {}).get("bonds_broken", 0) for r in recent))
    splits = sum(((r.get("stage") or {}).get("bodies_promoted", 0) for r in recent))
    return {
        "tick": tick, "total_ms": t.get("total_ms"), "baseline_ms": median_of([{"t": n.get("total_ms") or 0} for n in neighbours], "t"),
        "grew": [{"metric": k, "level": level(k), "delta_ms": round(d, 2)} for k, d in grew],
        "counts": [{"count": k, "value": v, "baseline": base} for k, v, base in moved],
        "context": {"meteors_launched_before": [{"tick": a, "n": b, "ticks_before": tick - a} for a, b in meteors],
                    f"bonds_broken_last_{lookback}": breaks, f"bodies_promoted_last_{lookback}": splits,
                    "stage_error": (t.get("stage") or {}).get("error", 0)},
    }


def sentence(e):
    top = [g for g in e["grew"] if g["level"] == 0][:3]
    inner = [g for g in e["grew"] if g["level"] > 0][:5]
    parts = [f"tick {e['tick']}: {e['total_ms']:.1f} ms vs {e['baseline_ms']:.1f} ms around it"]
    if top:
        parts.append("grew in " + ", ".join(f"{g['metric'].split('.', 1)[1]} +{g['delta_ms']:.1f}" for g in top))
    if inner:
        parts.append("inside: " + ", ".join(f"{g['metric']} +{g['delta_ms']:.1f}" for g in inner))
    if e["counts"]:
        parts.append("with " + ", ".join(f"{c['count']} {c['value']} (usually {c['baseline']:g})" for c in e["counts"][:6]))
    ctx = e["context"]
    m = ctx["meteors_launched_before"]
    if m:
        parts.append("after meteor launch " + ", ".join(f"{x['ticks_before']} ticks earlier" for x in m[-3:]))
    if ctx["stage_error"]:
        parts.append(f"stage error bits {ctx['stage_error']}")
    return "; ".join(parts)


def steady(ticks, threshold):
    """What an ordinary (non-spike) tick is made of: medians per metric."""
    calm = [t for t in ticks if (t.get("total_ms") or 0) <= threshold]
    if not calm:
        return {}
    rows = [times(t) for t in calm]
    keys = set().union(*[set(r) for r in rows])
    med = {k: median_of(rows, k) for k in keys}
    crows = [counts(t) for t in calm]
    ckeys = set().union(*[set(r) for r in crows])
    return {"ticks": len(calm), "total_ms": st.median(t.get("total_ms") or 0 for t in calm),
            "parts": sorted(((k, round(v, 2)) for k, v in med.items() if v >= 0.2), key=lambda kv: (level(kv[0]), -kv[1])),
            "counts": {k: median_of(crows, k) for k in sorted(ckeys)}}


def diff(a_ticks, b_ticks, label_a="A", label_b="B", top=12, quiet=False):
    """What changed between two sets of ticks (steps of a run, or two runs):
    median tick, the phases whose medians moved most, and the counts that moved
    with them. Medians, so a few spikes do not dominate."""
    def med(ticks, f):
        rows = [f(t) for t in ticks]
        keys = set().union(*[set(r) for r in rows]) if rows else set()
        return {k: median_of(rows, k) for k in keys}
    ta, tb = med(a_ticks, times), med(b_ticks, times)
    ca, cb = med(a_ticks, counts), med(b_ticks, counts)
    pa = st.median(t.get("total_ms") or 0 for t in a_ticks)
    pb = st.median(t.get("total_ms") or 0 for t in b_ticks)
    moved = sorted(((k, tb.get(k, 0.0) - ta.get(k, 0.0)) for k in set(ta) | set(tb)), key=lambda kv: -abs(kv[1]))
    moved = [(k, d) for k, d in moved if abs(d) >= 0.2][:top]
    cmoved = [(k, ca.get(k, 0), cb.get(k, 0)) for k in sorted(set(ca) | set(cb))
              if ca.get(k, 0) != cb.get(k, 0) and abs(cb.get(k, 0) - ca.get(k, 0)) >= max(1, 0.2 * max(abs(ca.get(k, 0)), 1))]
    out = {"median_ms": [pa, pb], "phases": [{"metric": k, "delta_ms": round(d, 2)} for k, d in moved],
           "counts": [{"count": k, label_a: x, label_b: y} for k, x, y in cmoved]}
    if not quiet:
        print(f"median tick {label_a} {pa:.1f} ms -> {label_b} {pb:.1f} ms ({pb - pa:+.1f})")
        for k, d in moved:
            print(f"  {'  ' * level(k)}{k} {d:+.2f} ms")
        if cmoved:
            print("  counts (median): " + ", ".join(f"{k} {x:g} -> {y:g}" for k, x, y in cmoved))
    return out


def cost_model(ticks, min_r2=0.3):
    """Per timing metric: least squares on the drivers present; ms per unit."""
    try:
        import numpy as np
    except ImportError:
        return {"error": "numpy not available (run through `uv run scripts/vl`)"}
    T = [times(t) for t in ticks]
    C = [counts(t) for t in ticks]
    drivers = [d for d in DRIVERS if any(c.get(d, 0) for c in C)]
    if not drivers or len(ticks) < 20:
        return {}
    X = np.array([[c.get(d, 0) for d in drivers] + [1.0] for c in C], dtype=float)
    out = {}
    metrics = set().union(*[set(r) for r in T])
    for m in sorted(metrics):
        y = np.array([r.get(m, 0.0) or 0.0 for r in T])
        if y.std() < 0.05:
            continue
        coef, *_ = np.linalg.lstsq(X, y, rcond=None)
        pred = X @ coef
        r2 = 1 - ((y - pred) ** 2).sum() / max(((y - y.mean()) ** 2).sum(), 1e-12)
        contrib = {d: float(coef[k] * X[:, k].mean()) for k, d in enumerate(drivers)}
        top = sorted(contrib.items(), key=lambda kv: -abs(kv[1]))[:3]
        out[m] = {"r2": round(float(r2), 3), "fixed_ms": round(float(coef[-1]), 3),
                  "per_unit": {d: round(float(coef[k]), 5) for k, d in enumerate(drivers) if abs(coef[k] * X[:, k].std()) >= 0.05},
                  "mean_ms": round(float(y.mean()), 3), "top_drivers": [d for d, _ in top],
                  "explained": bool(r2 >= min_r2)}
    return out


def priorities(explanations):
    """Over-budget time by phase across all spikes (sum of positive deltas)."""
    acc = {}
    for e in explanations:
        for g in e["grew"]:
            acc[g["metric"]] = acc.get(g["metric"], 0.0) + g["delta_ms"]
    return sorted(((k, round(v, 1)) for k, v in acc.items()), key=lambda kv: (level(kv[0]), -kv[1]))


def run(paths, threshold=None, top=10, as_json=False):
    ticks = load(paths)
    if not ticks:
        raise SystemExit(f"no tick records in {paths}")
    totals = [t.get("total_ms") or 0 for t in ticks]
    if threshold is None:
        threshold = max(33.0, 2 * st.median(totals))
    spikes = sorted((i for i, t in enumerate(ticks) if (t.get("total_ms") or 0) > threshold), key=lambda i: -totals[i])
    explanations = [explain_spike(ticks, i, threshold) for i in spikes]
    report = {
        "ticks": len(ticks), "threshold_ms": threshold,
        "distribution": {"p50": st.median(totals), "p95": sorted(totals)[int(0.95 * (len(totals) - 1))], "max": max(totals),
                         "over_16_7": sum(1 for x in totals if x > 16.7), "over_threshold": len(spikes)},
        "profiled": any(t.get("engine_zones") for t in ticks),
        "steady": steady(ticks, threshold),
        "spikes": explanations,
        "priorities": priorities(explanations),
        "cost_model": cost_model(ticks),
    }
    if as_json:
        print(json.dumps(report, indent=1, default=float))
        return report
    d = report["distribution"]
    print(f"{len(ticks)} ticks: p50 {d['p50']:.1f} ms, p95 {d['p95']:.1f}, max {d['max']:.1f}; "
          f"{d['over_16_7']} over 16.7 ms, {d['over_threshold']} over {threshold:.0f} ms"
          + ("" if report["profiled"] else " (no engine zones: run the server with VIBE_PHYSX_PROFILE=1 to see inside the stage)"))
    s = report["steady"]
    if s:
        print(f"\nsteady tick ({s['ticks']} ticks, median {s['total_ms']:.1f} ms) is made of:")
        for k, v in s["parts"][:14]:
            print(f"  {'  ' * level(k)}{k} {v} ms")
        busy = {k: v for k, v in s["counts"].items() if v}
        if busy:
            print("  with (median per tick): " + ", ".join(f"{k} {v:g}" for k, v in busy.items()))
    if explanations:
        print(f"\nworst {min(top, len(explanations))} spikes:")
        for e in explanations[:top]:
            print("  " + sentence(e))
        print("\nwhere the over-budget time goes (sum over all spikes):")
        for k, v in report["priorities"][:15]:
            print(f"  {'  ' * level(k)}{k} {v} ms")
    cm = report["cost_model"]
    if cm and "error" not in cm:
        print("\ncost model (least squares per phase on the stage/physx counts):")
        rows = sorted(cm.items(), key=lambda kv: -kv[1]["mean_ms"])
        for m, r in rows[:15]:
            drivers = ", ".join(f"{d} {r['per_unit'][d]:+.4g} ms/unit" for d in r["top_drivers"] if d in r["per_unit"])
            verdict = "explained" if r["explained"] else "NO DRIVER (fixed cost or a cause not recorded)"
            print(f"  {m}: mean {r['mean_ms']} ms, fixed {r['fixed_ms']} ms, R2 {r['r2']} -> {verdict}{'; ' + drivers if drivers else ''}")
    elif cm:
        print("\n" + cm["error"])
    return report
