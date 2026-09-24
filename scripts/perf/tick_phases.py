"""The per-tick physics phases of a server capture's ticks.jsonl.

Servers from 2026-09-24 (`timing_version` 2) add to every tick record:

  shots_ms, meteors_launched, meteor_launch_ms, snapshot_sent
  physx: controller_ms, submit_ms, overlap_ms, fetch_ms, callbacks_ms,
         gpu_wait_ms (sampled ticks only), readback_ms, players_ms,
         awake_bodies, found_pairs, lost_pairs
  stage: frame, error, iterations, converged, passes, corrections,
         bonds_broken, bonds_broken_after_correction, crushed_chunks, contacts,
         bodies_promoted, chunks_migrated, observe_ms,
         zones (VIBE_PHYSX_PROFILE=1 only): see ZONE_FIELDS
  engine_zones (VIBE_PHYSX_PROFILE=1 only): {zone name: ms}
  phases_us: what collecting the above cost the tick

Older captures have none of these; every reader here returns None or an
empty summary for them rather than zeros. In those captures `snapshot_ms` on a
tick that sent no snapshot repeats the last snapshot tick's value
(`snapshot_ms_is_per_tick` says which kind a capture is).

Standard library only.
"""
from __future__ import annotations

import math

# physx phases that are parts of dynamics_ms (the named share).
DYNAMICS_PARTS = ("controller_ms", "submit_ms", "fetch_ms", "readback_ms", "players_ms")
PHYSX_FIELDS = DYNAMICS_PARTS + ("overlap_ms", "callbacks_ms", "gpu_wait_ms",
                                 "awake_bodies", "found_pairs", "lost_pairs")
STAGE_FIELDS = ("iterations", "passes", "corrections", "bonds_broken", "bonds_broken_after_correction",
                "crushed_chunks", "contacts", "bodies_promoted", "chunks_migrated", "observe_ms")
ZONE_FIELDS = ("submit_ms", "finish_ms", "finish_gpu_wait_ms", "stress_gpu_ms", "fracture_gpu_ms",
               "trial_broadphase_ms", "trial_broadphase_wait_ms", "trial_narrowphase_ms", "trial_other_ms",
               "correction_ms", "correction_prep_ms", "correction_gpu_ms", "island_repair_ms", "body_alloc_ms",
               "other_ms")


def has_phases(ticks) -> bool:
    return any(t.get("physx") or t.get("stage") for t in ticks)


def snapshot_ms_is_per_tick(ticks) -> bool:
    return any((t.get("timing_version") or 0) >= 2 for t in ticks)


def tick_class(t):
    """'split' (the tick created bodies), 'break' (broke bonds only),
    'other', or None when the record has no stage (an older capture)."""
    stage = t.get("stage")
    if not stage:
        return None
    if stage.get("bodies_promoted", 0) > 0:
        return "split"
    if stage.get("bonds_broken", 0) > 0:
        return "break"
    return "other"


def flat(t) -> dict:
    """One tick's phases as a flat row (None where the capture has none)."""
    px, sg = t.get("physx") or {}, t.get("stage") or {}
    zones = sg.get("zones") or {}
    row = {"tick": t.get("tick"), "total_ms": t.get("total_ms"), "dynamics_ms": t.get("dynamics_ms"),
           "shots_ms": t.get("shots_ms"), "meteors_launched": t.get("meteors_launched"),
           "class": tick_class(t)}
    for k in PHYSX_FIELDS:
        row[f"physx_{k}"] = px.get(k) if px else None
    for k in STAGE_FIELDS:
        row[f"stage_{k}"] = sg.get(k) if sg else None
    for k in ZONE_FIELDS:
        row[f"zone_{k}"] = zones.get(k) if zones else None
    row["named_dynamics_pct"] = named_dynamics_pct(t)
    return row


def named_dynamics_pct(t):
    """How much of the tick's dynamics_ms its physx phases account for, %."""
    px, dyn = t.get("physx"), t.get("dynamics_ms")
    if not px or not dyn:
        return None
    return round(100.0 * sum(px.get(k) or 0.0 for k in DYNAMICS_PARTS) / dyn, 1)


def _q(values, digits=2):
    xs = sorted(v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v)))
    if not xs:
        return {"n": 0}

    def at(p):
        return xs[max(0, min(len(xs) - 1, math.ceil(p / 100 * len(xs)) - 1))]
    return {"n": len(xs), "mean": round(sum(xs) / len(xs), digits), "p50": round(at(50), digits),
            "p90": round(at(90), digits), "max": round(xs[-1], digits)}


def summary(ticks) -> dict:
    """Phase statistics by tick class, for a report. Empty for an old capture."""
    if not has_phases(ticks):
        return {}
    out = {"ticks_with_phases": sum(1 for t in ticks if t.get("physx") or t.get("stage")),
           "profiled_ticks": sum(1 for t in ticks if (t.get("stage") or {}).get("zones")),
           "gpu_wait_sampled_ticks": sum(1 for t in ticks if (t.get("physx") or {}).get("gpu_wait_ms") is not None),
           "collect_us": _q([t.get("phases_us") for t in ticks], 1),
           "shots_ms": _q([t.get("shots_ms") for t in ticks if (t.get("shots_ms") or 0) > 0], 3),
           "meteor_launch_ms": _q([t.get("meteor_launch_ms") for t in ticks if (t.get("meteors_launched") or 0) > 0], 3),
           "meteors_launched": sum(t.get("meteors_launched") or 0 for t in ticks),
           "by_class": {}}
    classes = {}
    for t in ticks:
        classes.setdefault(tick_class(t) or "unknown", []).append(t)
    for name in ("split", "break", "other", "unknown"):
        group = classes.get(name)
        if not group:
            continue
        row = {"ticks": len(group), "total_ms": _q([t["total_ms"] for t in group]),
               "dynamics_ms": _q([t.get("dynamics_ms") for t in group]),
               "named_dynamics_pct": _q([named_dynamics_pct(t) for t in group], 1)}
        for k in PHYSX_FIELDS:
            row[f"physx.{k}"] = _q([(t.get("physx") or {}).get(k) for t in group])
        for k in STAGE_FIELDS:
            row[f"stage.{k}"] = _q([(t.get("stage") or {}).get(k) for t in group])
        if any((t.get("stage") or {}).get("zones") for t in group):
            for k in ZONE_FIELDS:
                row[f"zones.{k}"] = _q([((t.get("stage") or {}).get("zones") or {}).get(k) for t in group])
        out["by_class"][name] = row
    # The engine's own heaviest zones on split ticks, when profiled.
    split_zones = {}
    for t in classes.get("split", []):
        for name, ms in (t.get("engine_zones") or {}).items():
            split_zones.setdefault(name, []).append(ms)
    if split_zones:
        n = len(classes["split"])
        top = sorted(split_zones.items(), key=lambda kv: -sum(kv[1]))[:15]
        out["split_tick_engine_zones"] = [{"zone": k, "ticks": len(v), "mean_ms_per_split_tick": round(sum(v) / n, 2),
                                           "max_ms": round(max(v), 2)} for k, v in top]
    return out


def fnum_or_none(x):
    """A CSV cell as a float; None for an empty cell (no value) or NaN."""
    if x is None or x == "":
        return None
    v = float(x)
    return None if math.isnan(v) else v


def frame_class(frame_ms, cpu_ms, gpu_ms):
    """Why a client frame was long, from the tape's own numbers:

    'cpu'     the frame's main-thread work (cpu_ms) took most of it;
    'gpu'     its own GPU time (a tape's gpu_max_pass_ms) took most of it;
    'wait'    neither did: the browser waited on something that is not this
              frame's work -- a GPU shared with the server, the compositor;
    'unknown' the frame has no GPU time (older tape, no timer extension, or a
              result lost to a disjoint).

    On ANGLE/Metal a pass's timer spans its command buffer, which on a GPU
    shared with another process can include that process's work, so 'gpu'
    there is an upper bound on the frame's own GPU cost (inferred)."""
    if cpu_ms is not None and cpu_ms > 0.6 * frame_ms:
        return "cpu"
    if gpu_ms is None:
        return "unknown"
    return "gpu" if gpu_ms > 0.6 * frame_ms else "wait"
