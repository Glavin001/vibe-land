#!/usr/bin/env python3
"""Rank camera-independent archive sweeps without weakening fidelity gates."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def load(path: Path) -> dict[str, object]:
    report = json.loads(path.read_text())
    spectators = report["spectators"]
    passing = bool(report["whole_world_error"]["pass"]) and all(
        route["pass"] for route in spectators
    )
    return {
        "path": str(path),
        "shell_error_mm": report["shell_error_mm"],
        "whole_world_pass": report["whole_world_error"]["pass"],
        "all_routes_pass": report["all_standard_routes_pass"],
        "pass": passing,
        "archive_mbps": report["baselines"]["archive_average_mbps"],
        "seekable_zstd_mbps": report["baselines"]["seekable_zstd_average_mbps"],
        "global_track_publish_mbps": report["track_publish_total_bytes"]
        * 8
        / report["duration_seconds"]
        / 1_000_000,
        "max_route_average_mbps": max(route["average_mbps"] for route in spectators),
        "min_route_average_mbps": min(route["average_mbps"] for route in spectators),
        "max_route_peak_mbps": max(
            route["peak_one_second_mbps"] for route in spectators
        ),
        "max_active_tracks": max(route["active_tracks_max"] for route in spectators),
        "shell_cm_max": report["whole_world_error"]["shell_cm_max"],
    }


def write_svg(path: Path, rows: list[dict[str, object]]) -> None:
    width, height = 900, 420
    margin = 60
    maximum = max(float(row["seekable_zstd_mbps"]) for row in rows) * 1.15
    bars = []
    bar_width = (width - margin * 2) / max(len(rows), 1) * 0.55
    for index, row in enumerate(rows):
        x = margin + (index + 0.5) * (width - margin * 2) / len(rows)
        value = float(row["seekable_zstd_mbps"])
        bar_height = value / maximum * (height - margin * 2)
        color = "#22c55e" if row["pass"] else "#ef4444"
        bars.append(
            f'<rect x="{x - bar_width / 2:.1f}" y="{height - margin - bar_height:.1f}" '
            f'width="{bar_width:.1f}" height="{bar_height:.1f}" fill="{color}"/>'
            f'<text x="{x:.1f}" y="{height - margin + 22}" text-anchor="middle">'
            f'{row["shell_error_mm"]} mm</text>'
            f'<text x="{x:.1f}" y="{height - margin - bar_height - 8:.1f}" '
            f'text-anchor="middle">{value:.2f} Mbps</text>'
        )
    path.write_text(
        f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">
<rect width="100%" height="100%" fill="#0f172a"/>
<g fill="#e2e8f0" font-family="sans-serif" font-size="14">
<text x="{margin}" y="30" font-size="20">Seekable omniscient archive rate</text>
{''.join(bars)}
<text x="18" y="{height / 2}" transform="rotate(-90 18 {height / 2})">Mbps</text>
</g></svg>
"""
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reports", nargs="+", type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    rows = sorted((load(path) for path in args.reports), key=lambda row: row["shell_error_mm"])
    passing = [row for row in rows if row["pass"]]
    selected = min(passing, key=lambda row: row["seekable_zstd_mbps"]) if passing else None
    with (args.out_dir / "omniscient-sweep.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (args.out_dir / "omniscient-sweep.json").write_text(
        json.dumps({"selected": selected, "runs": rows}, indent=2) + "\n"
    )
    write_svg(args.out_dir / "omniscient-sweep.svg", rows)
    if selected is None:
        raise SystemExit("no sweep satisfies whole-world and spectator gates")
    print(
        f"selected {selected['shell_error_mm']} mm at "
        f"{selected['seekable_zstd_mbps']:.3f} Mbps"
    )


if __name__ == "__main__":
    main()
