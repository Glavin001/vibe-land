#!/usr/bin/env python3
"""Render frame-synchronized codec telemetry beneath a chase-camera A/B video."""

from __future__ import annotations

import argparse
import csv
import functools
import math
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1920
STRIP_HEIGHT = 360
FPS = 30
BACKGROUND = (18, 21, 27)
PANEL = (27, 31, 39)
GRID = (66, 72, 84)
TEXT = (235, 238, 244)
MUTED = (160, 167, 180)
RAW = (86, 166, 255)
BUFFERED = (255, 166, 74)
CORRECTION = (255, 211, 92)
POSITION = (245, 104, 120)
TARGET = (110, 205, 144)


def load_csv(path: Path) -> list[dict[str, float]]:
    with path.open(newline="") as handle:
        return [
            {key: float(value) for key, value in row.items()}
            for row in csv.DictReader(handle)
        ]


@functools.lru_cache
def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{name}", size)


def log_y(value: float, maximum: float, top: int, height: int) -> float:
    ratio = math.log1p(max(0.0, value)) / math.log1p(maximum)
    return top + height * (1.0 - min(1.0, ratio))


def draw_log_chart(
    draw: ImageDraw.ImageDraw,
    *,
    box: tuple[int, int, int, int],
    title: str,
    rows: list[dict[str, float]],
    series: list[tuple[str, str, tuple[int, int, int]]],
    maximum: float,
    ticks: list[float],
    current: int,
    target: float | None = None,
) -> None:
    left, top, width, height = box
    draw.rounded_rectangle(
        (left, top, left + width, top + height), radius=8, fill=PANEL
    )
    plot_left = left + 54
    plot_top = top + 29
    plot_width = width - 72
    plot_height = height - 50
    draw.text((left + 12, top + 7), title, fill=TEXT, font=font(15, True))
    for tick in ticks:
        y = log_y(tick, maximum, plot_top, plot_height)
        draw.line((plot_left, y, plot_left + plot_width, y), fill=GRID, width=1)
        draw.text(
            (plot_left - 8, y),
            f"{tick:g}",
            fill=MUTED,
            font=font(11),
            anchor="rm",
        )
    if target is not None:
        y = log_y(target, maximum, plot_top, plot_height)
        for x in range(plot_left, plot_left + plot_width, 10):
            draw.line((x, y, min(x + 5, plot_left + plot_width), y), fill=TARGET, width=1)
    count = max(1, len(rows) - 1)
    for label, key, color in series:
        points = []
        for index, row in enumerate(rows):
            x = plot_left + index / count * plot_width
            points.append((x, log_y(row[key], maximum, plot_top, plot_height)))
        draw.line(points, fill=color, width=2)
    marker_x = plot_left + current / count * plot_width
    draw.line(
        (marker_x, plot_top, marker_x, plot_top + plot_height),
        fill=TEXT,
        width=2,
    )
    legend_x = left + width - 12
    for label, _, color in reversed(series):
        legend_width = draw.textlength(label, font=font(11))
        legend_x -= int(legend_width)
        draw.text((legend_x, top + 9), label, fill=color, font=font(11))
        legend_x -= 18


def render_strip(
    raw: list[dict[str, float]],
    buffered: list[dict[str, float]],
    output: Path,
    reduced_label: str,
) -> None:
    if len(raw) != len(buffered):
        raise ValueError("raw and buffered telemetry frame counts differ")
    command = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{WIDTH}x{STRIP_HEIGHT}",
        "-framerate",
        str(FPS),
        "-i",
        "-",
        "-an",
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p5",
        "-tune",
        "hq",
        "-cq",
        "18",
        "-b:v",
        "0",
        "-pix_fmt",
        "yuv420p",
        str(output),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    screen_error_rows = [
        {
            "raw": raw_row["chase_pixel_p95"],
            "buffered": buffered_row["chase_pixel_p95"],
        }
        for raw_row, buffered_row in zip(raw, buffered)
    ]
    for index, row in enumerate(buffered):
        image = Image.new("RGB", (WIDTH, STRIP_HEIGHT), BACKGROUND)
        draw = ImageDraw.Draw(image)
        draw_log_chart(
            draw,
            box=(18, 10, 900, 165),
            title="Displayed chase view: p95 screen error (px, log scale)",
            rows=screen_error_rows,
            series=[
                ("raw", "raw", RAW),
                (reduced_label, "buffered", BUFFERED),
            ],
            maximum=1000.0,
            ticks=[0, 2, 10, 50, 250, 1000],
            current=index,
            target=2.0,
        )
        draw_log_chart(
            draw,
            box=(18, 185, 900, 165),
            title="Visible bodies: p95 position and reconciliation error (cm, log scale)",
            rows=buffered,
            series=[
                ("position", "position_cm_p95", POSITION),
                ("correction", "correction_cm_p95", CORRECTION),
            ],
            maximum=10_000.0,
            ticks=[0, 10, 100, 1000, 10000],
            current=index,
        )
        draw.rounded_rectangle((936, 10, 1902, 350), radius=8, fill=PANEL)
        draw.text(
            (958, 26),
            f"FRAME {int(row['frame']):04d}   t={row['time_seconds']:5.2f}s",
            fill=TEXT,
            font=font(22, True),
        )
        values = [
            ("Bandwidth, rolling 1 s", f"{row['rolling_one_second_mbps']:6.2f} Mbps"),
            ("Interested / entering bodies", f"{int(row['interested_bodies'])} / {int(row['interest_entries'])}"),
            ("Visible / moving bodies", f"{int(row['chase_visible_bodies'])} / {int(row['chase_moving_bodies'])}"),
            ("Chase p95 / max error", f"{row['chase_pixel_p95']:7.1f} / {row['chase_pixel_max']:7.1f} px"),
            ("Position p95 / max", f"{row['position_cm_p95']:7.1f} / {row['position_cm_max']:7.1f} cm"),
            ("Active correction p95", f"{row['correction_cm_p95']:7.1f} cm"),
            ("Correction speed p95", f"{row['correction_speed_mps_p95']:7.2f} m/s"),
            ("Excess displayed step p95", f"{row['excess_step_cm_p95']:7.1f} cm/frame"),
            ("Staleness p95 / max", f"{row['stale_ms_p95']:7.0f} / {row['stale_ms_max']:7.0f} ms"),
            ("Freeze / linear reversal", f"{row['freeze_pct']:6.2f}% / {row['linear_reversal_pct']:6.2f}%"),
            ("Chase camera eye error", f"{row['chase_camera_position_error_m']:7.2f} m"),
            ("Chase camera direction error", f"{row['chase_camera_direction_error_deg']:7.2f} deg"),
        ]
        y = 66
        for label, value in values:
            draw.text((958, y), label, fill=MUTED, font=font(15))
            draw.text((1878, y), value, fill=TEXT, font=font(15, True), anchor="ra")
            y += 24
        process.stdin.write(image.tobytes())
    process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("ffmpeg telemetry-strip encoder failed")


def compose(
    raw_video: Path,
    buffered_video: Path,
    strip_video: Path,
    output: Path,
    delay_seconds: float,
    reduced_label: str,
) -> None:
    filter_graph = (
        f"[0:v]tpad=start_duration={delay_seconds},trim=duration=30,"
        "crop=960:540:960:540,"
        "drawbox=x=0:y=0:w=330:h=48:color=black@0.65:t=fill,"
        "drawtext=text='RAW AUTHORITATIVE':x=16:y=12:fontsize=26:fontcolor=white[raw];"
        "[1:v]crop=960:540:960:540,"
        "drawbox=x=0:y=0:w=390:h=48:color=black@0.65:t=fill,"
        f"drawtext=text='{reduced_label}':x=16:y=12:fontsize=26:fontcolor=white[reduced];"
        "[raw][reduced]hstack=inputs=2[top];"
        "[top][2:v]vstack=inputs=2[out]"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(raw_video),
            "-i",
            str(buffered_video),
            "-i",
            str(strip_video),
            "-filter_complex",
            filter_graph,
            "-map",
            "[out]",
            "-an",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-cq",
            "18",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-csv", type=Path, required=True)
    parser.add_argument("--buffered-csv", type=Path, required=True)
    parser.add_argument("--raw-video", type=Path, required=True)
    parser.add_argument("--buffered-video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--delay-ms", type=float, default=100.0)
    parser.add_argument("--label", default="BUFFERED CODEC")
    args = parser.parse_args()

    raw = load_csv(args.raw_csv)
    buffered = load_csv(args.buffered_csv)
    with tempfile.TemporaryDirectory(prefix="codec-telemetry-") as directory:
        strip = Path(directory) / "strip.mp4"
        render_strip(raw, buffered, strip, args.label)
        compose(
            args.raw_video,
            args.buffered_video,
            strip,
            args.output,
            args.delay_ms / 1000.0,
            args.label,
        )


if __name__ == "__main__":
    main()
