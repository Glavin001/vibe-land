#!/usr/bin/env python3
"""Summarize saved city reports without modifying or publishing the originals.

Point samples, rolling windows, and cumulative counters stay separate. The
output deliberately excludes player positions, browser identity, and arbitrary
environment variables. Source hashes make the findings traceable locally.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics


CONTACT_HOST_PHASES = (
    "ownership", "validate", "sort", "reduce", "route",
)
ENV_KEYS = (
    "VIBE_PHYSX_DIRECT_GPU", "BLAST_GPU_IMPULSE_READBACK",
    "VIBE_CITY_SCENE", "VIBE_CITY_GRID", "VIBE_CITY_SOLVER_ITERATIONS",
    "VIBE_CITY_RESIM_PASSES", "VIBE_CITY_FREEZE", "VIBE_CITY_STRESS_LIMIT_SCALE",
    "VIBE_CITY_MAX_BODIES",
)


def load_report(directory):
    files = {}
    documents = {}
    for name in ("client", "server"):
        raw = (directory / f"{name}.json").read_bytes()
        files[f"{name}.json"] = hashlib.sha256(raw).hexdigest()
        documents[name] = json.loads(raw)
    client, server = documents["client"], documents["server"]
    snapshot = client["snapshot"]
    city = server["city"]
    client_city = snapshot["city"]
    direct = {
        name.removeprefix("physics/"): entry["v"]
        for name, entry in server["spans"].items()
        if name.startswith("physics/direct_")
    }
    direct["contact_host_work_ms"] = sum(
        direct[f"direct_contact_{phase}_ms"] for phase in CONTACT_HOST_PHASES
    )
    ring = server["tick_ring"]
    values = sorted(entry["total"] for entry in ring)
    # Same nearest-rank convention as RollingSamples::snapshot (positive n).
    p95_index = int((len(values) - 1) * 0.95 + 0.5)
    fingerprint = server["fingerprint"]
    repairs = [
        event for event in client["events"]["client"]
        if event["kind"] == "structureRepair"
    ]
    intervals = [
        (second["t"] - first["t"]) / 1000
        for first, second in zip(repairs, repairs[1:])
    ]
    result = {
        "report": directory.name,
        "source_sha256": files,
        "captured_at": client["capturedAt"],
        "server_build": server["server_build"],
        "server_started": server["server_started"],
        "source_revision": fingerprint["git"],
        "physics_env": {key: fingerprint["env"].get(key) for key in ENV_KEYS},
        "server_tick": server["server_tick"],
        "client_tick": snapshot["debugStats"]["serverTick"],
        "shots_fired": snapshot["shotsFired"],
        "bodies": city["chunk_bodies"],
        "awake_bodies": city["awake_bodies"],
        "broken_bonds": city["broken_bonds"],
        "pending_input_frames": [p["pending_inputs"] for p in server["players"]],
        "server_rolling_180_ticks_ms": {
            key: server["timings"][key]
            for key in ("total_ms", "dynamics_ms", "city_total_ms", "player_sim_ms")
        },
        "server_tick_ring": {
            "samples": len(ring),
            "first_tick": ring[0]["t"],
            "last_tick": ring[-1]["t"],
            "total_ms": {"avg": statistics.mean(values), "p95": values[p95_index],
                         "max": values[-1]},
            "worst_tick": max(ring, key=lambda entry: entry["total"]),
        },
        "first_physics_pass_point_sample": direct,
        "replay_point_sample": {
            key: value for key, value in city.items() if key.startswith("resim_")
        },
        "client_frame_point_sample": client["frameProfile"],
        "client_transport": snapshot["transport"],
        "client_bytes_per_second": client_city["bytesPerSecond"],
        "client_topology_counters": {
            key: client_city[key] for key in (
                "chunksTotal", "bootstraps", "topoSeqGaps", "orphanedChunks",
                "orphanedByRetire", "settleRejects", "hashChecks",
                "hashMismatches", "structureRepairs",
            )
        },
        "client_event_ring": {
            "teleports": len(client["events"]["teleports"]),
            "repair_events": len(repairs),
            "repaired_structure_mentions": dict(Counter(
                structure for event in repairs
                for structure in event["detail"]["structures"]
            )),
            "repair_interval_median_seconds": statistics.median(intervals) if intervals else None,
        },
        "server_counters": {
            key: city[key] for key in (
                "contacts_queued", "contacts_processed", "contacts_dropped",
                "escaped_bodies_parked", "unmapped_body_skips", "duplicate_body_records",
                "frozen_bodies", "freeze_flips", "unfreeze_flips", "degraded",
            )
        },
        "server_network_counters": {
            key: server["network"][key] for key in (
                "datagram_fallbacks", "dropped_outbound_packets",
                "dropped_outbound_snapshots", "malformed_packets",
            )
        },
        "gpu_warning_count": server["physics_gpu_warning_count"],
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path, nargs="+")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    reports = sorted((load_report(path) for path in args.reports),
                     key=lambda report: report["captured_at"])
    output = {
        "schema": 1,
        "notes": [
            "Rolling windows are 180 simulation ticks, not a fixed wall-clock duration.",
            "Client and server observations are asynchronous, not identical-state samples.",
            "Do not sum nested timing spans, different windows, or cumulative report counters.",
            "Client frame profiles are point samples; telemetryMs retains its last periodic value.",
            "Zero reported faults establish only the checks actually enabled and recorded.",
            "The 180-tick interpretation is for this server revision; check it before reuse.",
        ],
        "reports": reports,
    }
    encoded = json.dumps(output, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.out:
        args.out.write_text(encoded)
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
