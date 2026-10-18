#!/usr/bin/env python3
"""Rank codec sweeps by hard visual acceptance, then measured bitrate."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


METRICS = (
    "frame_pixel_p95_p99",
    "frame_pixel_p95_max",
    "frame_position_p95_cm_p99",
    "frame_position_p95_cm_max",
    "frame_correction_p95_cm_p99",
    "frame_correction_p95_cm_max",
    "frame_correction_speed_p95_mps_p99",
    "frame_excess_step_p95_cm_p99",
    "frame_excess_step_p95_cm_max",
    "frame_freeze_pct_max",
    "frame_linear_reversal_pct_p99",
    "frame_linear_reversal_pct_max",
    "moving_stale_p95_ms_p99",
    "moving_stale_ms_max",
    "camera_position_error_m_p99",
    "camera_position_error_m_max",
    "camera_direction_error_deg_p99",
    "camera_direction_error_deg_max",
)


def load_run(path: Path) -> dict[str, object] | None:
    report = json.loads(path.read_text())
    if "visual_acceptance" not in report:
        return None
    quality = report["visual_acceptance"]
    thresholds = quality["thresholds"]
    failures = [name for name in METRICS if quality[name] > thresholds[name]]
    buffered = report["buffered"]
    row: dict[str, object] = {
        "run": path.parent.name,
        "pass": not failures,
        "failed_metrics": ",".join(failures),
        "average_mbps": buffered["average_mbps"],
        "peak_one_second_mbps": buffered["peak_one_second_mbps"],
        "pixel_budget": buffered["pixel_budget"],
        "bitrate_budget_mbps": report.get("bitrate_budget_mbps"),
        "loss_rate": report.get("telemetry_loss_rate", 0.0),
        "interpolation_delay_ms": report["interpolation_delay_ms"],
        "max_extrapolation_ms": report["max_extrapolation_ms"],
        "correction_ms": report["correction_ms"],
        "max_moving_update_ms": report["max_moving_update_ms"],
        "contact_update_ms": report["contact_update_ms"],
        "single_view_interest": report.get("single_view_interest", False),
        "interest_fov_margin_deg": report.get("interest_fov_margin_deg"),
        "interest_lookahead_ms": report.get("interest_lookahead_ms"),
        "interest_grace_ms": report.get("interest_grace_ms"),
        "interest_proximity_m": report.get("interest_proximity_m"),
    }
    row.update({name: quality[name] for name in METRICS})
    return row


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-root", type=Path, required=True)
    parser.add_argument("--pattern", default="opt-*")
    parser.add_argument("--output-prefix", type=Path, required=True)
    args = parser.parse_args()

    paths = sorted(args.results_root.glob(f"{args.pattern}/video_metrics.json"))
    rows = [row for path in paths if (row := load_run(path)) is not None]
    rows.sort(
        key=lambda row: (
            not bool(row["pass"]),
            float(row["average_mbps"]),
            float(row["peak_one_second_mbps"]),
        )
    )
    if not rows:
        raise SystemExit("no video_metrics.json files matched")

    csv_path = args.output_prefix.with_suffix(".csv")
    json_path = args.output_prefix.with_suffix(".json")
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    json_path.write_text(json.dumps(rows, indent=2) + "\n")

    for row in rows:
        status = "PASS" if row["pass"] else "FAIL"
        print(
            f"{status:4} {row['average_mbps']:7.3f} Mbps avg "
            f"{row['peak_one_second_mbps']:7.3f} peak  {row['run']}"
        )


if __name__ == "__main__":
    main()
