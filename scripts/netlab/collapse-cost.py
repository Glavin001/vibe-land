#!/usr/bin/env python3
"""Collapse costs (plan milestone 2): what streaming a collapse costs per
player under the per-player netcode, from a `netlab2 city --strategy
per-player` run and its capture.

    scripts/netlab/collapse-cost.py RUN [RUN ...]

Per run:
- **Moving body-seconds:** the capture's awake bodies summed over its ticks
  (stats.jsonl), per client.
- **Keyframes per moving body per second:** the per-player strategy's
  keyframes sent per client, over those body-seconds.
- **Bytes by distance:** record bytes by the body's distance from the
  client's eye (under 10, 25, 50, 100 m, beyond), as kbit/s per client.
- **Mode mix:** keyframes and bytes by prediction mode (ballistic, sliding,
  resting, friction).
- **Peak and sustained rate:** the client's busiest trailing second (G3's
  steady window) and its mean: the sustained rate and burst a budget needs
  (decision D9's bucket).

The owner's keyframe_budget.py will take the same inputs; until it lands
this is the report. Output: one markdown table per run on stdout.
"""

import json
import os
import sys

BANDS = ["<10 m", "10-25 m", "25-50 m", "50-100 m", ">100 m"]
MODES = ["ballistic", "sliding", "resting", "friction"]


def report(run):
    card = json.load(open(os.path.join(run, "scorecard.json")))
    capture = card["spec"]["capture"]
    hz = card["hz"]
    stats = json.loads(open(os.path.join(run, "strategy.txt")).read())
    clients = len(card["clients"])
    awake = [json.loads(l)["awake"] for l in open(os.path.join(capture, "stats.jsonl")) if l.strip()]
    body_seconds = sum(awake) / hz
    seconds = len(awake) / hz
    keyframes = stats["keyframes_sent"] / clients
    out = [f"### {os.path.basename(os.path.dirname(capture.rstrip('/'))) or capture}: {run}", ""]
    out.append(f"{clients} clients, {card['spec']['link']}, {seconds:.0f} s; peak awake bodies {max(awake)}, "
               f"mean {sum(awake) / len(awake):.0f}; moving body-seconds {body_seconds:.0f}.")
    out.append("")
    out.append("| per client | value |")
    out.append("|---|---:|")
    out.append(f"| keyframes per moving body per second | {keyframes / max(body_seconds, 1e-9):.2f} |")
    out.append(f"| mean kbit/s | {card['kbit_s_mean']:.1f} |")
    out.append(f"| busiest 1 s, steady (kbit/s) | {max(c['stream'].get('kbit_s_max_1s_steady', 0) for c in card['clients']):.0f} |")
    out.append(f"| bytes per keyframe | {sum(stats['bytes_by_mode']) / max(stats['keyframes_sent'], 1):.1f} |")
    out.append(f"| delta records | {100 * stats['delta_records'] / max(stats['keyframes_sent'], 1):.0f}% |")
    out.append("")
    total_b = sum(stats["bytes_by_distance"]) or 1
    out.append("| distance | keyframes | share of bytes | kbit/s per client |")
    out.append("|---|---:|---:|---:|")
    for i, band in enumerate(BANDS):
        k = stats["keyframes_by_distance"][i] / clients
        b = stats["bytes_by_distance"][i]
        out.append(f"| {band} | {k:.0f} | {100 * b / total_b:.0f}% | {b / clients * 8 / 1000 / seconds:.1f} |")
    out.append("")
    total_k = sum(stats["by_mode"]) or 1
    total_m = sum(stats["bytes_by_mode"]) or 1
    out.append("| mode | keyframes | bytes |")
    out.append("|---|---:|---:|")
    for i, mode in enumerate(MODES):
        out.append(f"| {mode} | {100 * stats['by_mode'][i] / total_k:.0f}% | {100 * stats['bytes_by_mode'][i] / total_m:.0f}% |")
    return "\n".join(out)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    print("\n\n".join(report(run) for run in sys.argv[1:]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
