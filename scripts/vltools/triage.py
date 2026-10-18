"""`vl triage`: every dump in a reports directory, grouped by symptom.

Reads report-* (SEND REPORT / hotspot watch), spike-* and anomaly-* folders
and gives each a signature:

- anomaly: its invariant (stage_error, velocity_explosions, escaped_bodies...)
- spike: the phase that grew most (vl perf explain), e.g.
  spike:zone.correction_prep_ms, or spike:physx.fetch_ms when unprofiled
- report: the symptoms the client and server recorded, from client.json's
  flicker block and event rings (teleports, adoption jumps, visibility
  flips, draw drops), the hotspot watch (client frames over budget), the
  server tick ring (p95 over budget), topology counters (hash mismatches,
  sequence gaps, orphans, chunks below ground), GPU warnings, a degraded
  stage.

Groups print largest first with the newest example, whether it carries a
repro bundle (`repro/`, recorded since 2026-10-03; older reports cannot be
replayed) and the command that reproduces it. --json for machines.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from . import perf_explain


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def report_signature(d: Path):
    sig = []
    try:
        client = json.loads((d / "client.json").read_text())
    except (OSError, ValueError):
        client = {}
    try:
        server = json.loads((d / "server.json").read_text())
    except (OSError, ValueError):
        server = {}
    flicker = client.get("flicker") or {}
    for key in ("teleports", "adoptionJumps", "sameSlotWithin250ms"):
        if _num(flicker.get(key)) > 0:
            sig.append(f"client:{key}")
    vis = flicker.get("visibility") or {}
    if _num(vis.get("hidden")) > 0 or _num(vis.get("bodiesPartlyHidden")) > 0:
        sig.append("client:visibility")
    census = flicker.get("drawCensus") or {}
    if _num(census.get("dropFrames")) > 0:
        sig.append("client:drawDrops")
    if client.get("hotspot"):
        sig.append("client:hotspot")
    city = ((client.get("snapshot") or {}).get("city")) or {}
    for key in ("hashMismatches", "topoSeqGaps", "orphanedChunks", "chunksBelowGround", "staleDrawnChunks"):
        if _num(city.get(key)) > 0:
            sig.append(f"client:{key}")
    ring = server.get("tick_ring") or []
    if ring:
        totals = sorted(_num(e.get("total")) for e in ring)
        p95 = totals[int(0.95 * (len(totals) - 1))]
        if p95 > 16.7:
            sig.append("server:slow-ticks")
    if _num(server.get("physics_gpu_warning_count")) > 0:
        sig.append("server:gpu-warnings")
    if _num((server.get("city") or {}).get("degraded")) > 0:
        sig.append("server:degraded")
    return sig or ["no-symptom-recorded"]


def spike_signature(d: Path):
    try:
        ticks = perf_explain.load([d / "ticks.jsonl"])
        meta = json.loads((d / "meta.json").read_text())
        spike = meta.get("spike_tick")
        idx = next((i for i, t in enumerate(ticks) if t.get("tick") == spike), None)
        if idx is None:
            return ["spike:unknown"]
        e = perf_explain.explain_spike(ticks, idx, meta.get("threshold_ms", 33.0))
        inner = [g for g in e["grew"] if g["level"] > 0]
        top = (inner or e["grew"] or [{"metric": "unknown"}])[0]["metric"]
        return [f"spike:{top}"]
    except (OSError, ValueError, KeyError):
        return ["spike:unreadable"]


def anomaly_signature(d: Path):
    try:
        return [f"anomaly:{json.loads((d / 'repro' / 'meta.json').read_text())['anomaly']['kind']}"]
    except (OSError, ValueError, KeyError):
        return [f"anomaly:{d.name.rsplit('-', 1)[-1]}"]


def run(root, as_json=False):
    root = Path(root)
    groups = defaultdict(list)
    for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime):
        if not d.is_dir():
            continue
        if d.name.startswith("report-"):
            sig = report_signature(d)
        elif d.name.startswith("spike-"):
            sig = spike_signature(d)
        elif d.name.startswith("anomaly-"):
            sig = anomaly_signature(d)
        else:
            continue
        groups[" + ".join(sorted(sig))].append(d)
    out = []
    for sig, dirs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        replayable = [d for d in dirs if (d / "repro" / "meta.json").exists()]
        newest = dirs[-1]
        target = replayable[-1] if replayable else None
        out.append({"signature": sig, "count": len(dirs), "replayable": len(replayable), "newest": str(newest),
                    "reproduce": f"scripts/vl repro {target} --reps 3" if target else None})
    if as_json:
        print(json.dumps(out, indent=1))
        return out
    print(f"{sum(g['count'] for g in out)} dumps in {root}, {len(out)} symptom groups (largest first)")
    for g in out:
        print(f"\n  {g['count']:4d} x {g['signature']}   ({g['replayable']} replayable)")
        print(f"       newest: {g['newest']}")
        print(f"       {g['reproduce'] or 'no repro bundle (recorded before the flight recorder): reproduce by hand from client.json/server.json'}")
    return out
