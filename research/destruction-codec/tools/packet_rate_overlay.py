#!/usr/bin/env python3
"""Turn a recorder packet dump into an .ass subtitle overlay of its byte rate.

Every comparison video should carry its own receipts: this reads
`packets.jsonl` (written by `record-city-trace --packets-out`), buckets bytes
per second of sim time, and emits one subtitle event per second showing the
current rate plus running average and peak. Burn it with:

    ffmpeg -i leg.mp4 -vf "ass=leg.ass" ...

Usage: packet_rate_overlay.py <packets-dir> <out.ass> <label> [--hz 60]
Prints the summary (avg / peak-second / total) to stdout as JSON.
"""
import json
import os
import sys


def main() -> None:
    packets_dir, out_path, label = sys.argv[1], sys.argv[2], sys.argv[3]
    hz = 60
    if "--hz" in sys.argv:
        hz = int(sys.argv[sys.argv.index("--hz") + 1])

    meta = json.load(open(os.path.join(packets_dir, "meta.json")))
    seconds_total = meta["ticks"] // hz
    per_second = [0] * (seconds_total + 1)
    reliable = [0] * (seconds_total + 1)
    for line in open(os.path.join(packets_dir, "packets.jsonl")):
        if not line.strip():
            continue
        entry = json.loads(line)
        second = min(entry["tick"] // hz, seconds_total)
        size = len(entry["hex"]) // 2
        per_second[second] += size
        if entry["chan"] == "r":
            reliable[second] += size

    mbps = [b * 8 / 1e6 for b in per_second]
    total = sum(per_second)
    avg = total * 8 / max(1, seconds_total) / 1e6
    peak = max(mbps)

    # Minimal ASS: one style, one event per second. Sized for a 1920-wide pane.
    header = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, "
        "BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        "Style: rate,DejaVu Sans Mono,34,&H00FFFFFF,&H00000000,&H80000000,1,2,0,1,24,24,24\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Text\n"
    )
    lines = [header]
    running_total = 0
    running_peak = 0.0
    for second in range(seconds_total):
        running_total += per_second[second]
        running_peak = max(running_peak, mbps[second])
        running_avg = running_total * 8 / (second + 1) / 1e6
        start = f"0:{second // 60:02d}:{second % 60:02d}.00"
        end = f"0:{(second + 1) // 60:02d}:{(second + 1) % 60:02d}.00"
        text = (
            f"{label}\\N{mbps[second]:5.2f} Mbps now\\N"
            f"avg {running_avg:5.2f}  peak {running_peak:5.2f}\\N"
            f"total {running_total / 1e6:6.2f} MB"
        )
        lines.append(f"Dialogue: 0,{start},{end},rate,{{\\an7}}{text}\n")
    with open(out_path, "w") as handle:
        handle.writelines(lines)

    print(
        json.dumps(
            {
                "label": label,
                "avg_mbps": round(avg, 3),
                "peak_second_mbps": round(peak, 3),
                "total_mb": round(total / 1e6, 3),
                "reliable_mb": round(sum(reliable) / 1e6, 3),
                "seconds": seconds_total,
            }
        )
    )


if __name__ == "__main__":
    main()
