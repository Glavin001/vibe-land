#!/usr/bin/env python3
"""Render a chase-view A/B with omniscient track/error telemetry."""

from __future__ import annotations

import argparse
import csv
import functools
import math
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT, FPS = 1920, 360, 30
BACKGROUND = (18, 21, 27)
PANEL = (27, 31, 39)
GRID = (66, 72, 84)
TEXT = (235, 238, 244)
MUTED = (160, 167, 180)
ERROR = (255, 166, 74)
RATE = (86, 166, 255)
TARGET = (110, 205, 144)


@functools.lru_cache
def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{name}", size)


def load(path: Path, route: str) -> list[dict[str, float | str]]:
    with path.open(newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["route"] == route]
    if not rows:
        raise ValueError(f"route {route!r} not found in {path}")
    return [
        {
            key: value if key == "route" else float(value)
            for key, value in row.items()
        }
        for row in rows
    ]


def y(value: float, maximum: float, top: int, height: int) -> float:
    ratio = math.log1p(max(0.0, value)) / math.log1p(maximum)
    return top + height * (1.0 - min(1.0, ratio))


def chart(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    title: str,
    rows: list[dict[str, float | str]],
    key: str,
    maximum: float,
    ticks: list[float],
    current: int,
    target: float | None,
    color: tuple[int, int, int],
) -> None:
    left, top, width, height = box
    draw.rounded_rectangle((left, top, left + width, top + height), 8, fill=PANEL)
    plot_left, plot_top = left + 52, top + 30
    plot_width, plot_height = width - 68, height - 48
    draw.text((left + 10, top + 7), title, fill=TEXT, font=font(14, True))
    for tick in ticks:
        py = y(tick, maximum, plot_top, plot_height)
        draw.line((plot_left, py, plot_left + plot_width, py), fill=GRID)
        draw.text((plot_left - 7, py), f"{tick:g}", fill=MUTED, font=font(10), anchor="rm")
    if target is not None:
        py = y(target, maximum, plot_top, plot_height)
        for px in range(plot_left, plot_left + plot_width, 10):
            draw.line((px, py, px + 5, py), fill=TARGET)
    count = max(1, len(rows) - 1)
    points = [
        (
            plot_left + index / count * plot_width,
            y(float(row[key]), maximum, plot_top, plot_height),
        )
        for index, row in enumerate(rows)
    ]
    draw.line(points, fill=color, width=2)
    marker = plot_left + current / count * plot_width
    draw.line((marker, plot_top, marker, plot_top + plot_height), fill=TEXT, width=2)


def render_strip(
    rows: list[dict[str, float | str]],
    output: Path,
    rate_target_mbps: float,
    freeze_label: str,
    reversal_label: str,
) -> None:
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
        f"{WIDTH}x{HEIGHT}",
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
    for index, row in enumerate(rows):
        image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
        draw = ImageDraw.Draw(image)
        chart(
            draw,
            (16, 10, 570, 160),
            "Max visible screen error (px, log)",
            rows,
            "screen_error_px_max",
            4.0,
            [0, 0.5, 1, 2, 4],
            index,
            4.0,
            ERROR,
        )
        chart(
            draw,
            (16, 185, 570, 160),
            "Max visible rigid-shell error (cm, log)",
            rows,
            "shell_error_cm_max",
            0.5,
            [0, 0.1, 0.25, 0.5],
            index,
            0.5,
            ERROR,
        )
        chart(
            draw,
            (606, 10, 700, 335),
            "Delivered track rate (rolling 1 s, Mbps)",
            rows,
            "rolling_mbps",
            110.0,
            [0, 5, 10, 20, 50, 100],
            index,
            rate_target_mbps,
            RATE,
        )
        draw.rounded_rectangle((1326, 10, 1904, 345), 8, fill=PANEL)
        draw.text(
            (1348, 28),
            f"FRAME {int(float(row['frame'])):04d}   t={float(row['simulation_time']):5.2f}s",
            fill=TEXT,
            font=font(21, True),
        )
        values = [
            ("Active tracks", f"{int(float(row['active_tracks']))} / 30 target"),
            ("Rolling delivered rate", f"{float(row['rolling_mbps']):.2f} Mbps"),
            ("Visible bodies", f"{int(float(row['visible_bodies']))}"),
            ("Missing visible bodies", f"{int(float(row['missing_visible_bodies']))}"),
            ("Max screen error", f"{float(row['screen_error_px_max']):.3f} px"),
            ("Max shell error", f"{float(row['shell_error_cm_max']):.3f} cm"),
            ("Canonical bound", "0.500 cm"),
            ("Codec-induced freeze", freeze_label),
            ("Direction reversal", reversal_label),
        ]
        py = 78
        for label, value in values:
            draw.text((1348, py), label, fill=MUTED, font=font(15))
            draw.text((1880, py), value, fill=TEXT, font=font(15, True), anchor="ra")
            py += 27
        process.stdin.write(image.tobytes())
    process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("telemetry strip encoding failed")


def compose(
    raw: Path,
    reconstructed: Path,
    strip: Path,
    output: Path,
    codec_label: str,
) -> None:
    escaped_label = (
        codec_label.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", r"\'")
        .replace("%", r"\%")
    )
    graph = (
        "[0:v]crop=960:540:960:540,"
        "drawbox=x=0:y=0:w=330:h=48:color=black@0.65:t=fill,"
        "drawtext=text='RAW AUTHORITATIVE':x=16:y=12:fontsize=26:fontcolor=white[raw];"
        "[1:v]crop=960:540:960:540,"
        "drawbox=x=0:y=0:w=600:h=48:color=black@0.65:t=fill,"
        f"drawtext=text='{escaped_label}':x=16:y=12:fontsize=26:"
        "fontcolor=white:expansion=none[codec];"
        "[raw][codec]hstack=inputs=2[top];[top][2:v]vstack=inputs=2[out]"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(raw),
            "-i",
            str(reconstructed),
            "-i",
            str(strip),
            "-filter_complex",
            graph,
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
    parser.add_argument("--timeline", required=True, type=Path)
    parser.add_argument("--route", default="projectile-chase")
    parser.add_argument("--raw-video", required=True, type=Path)
    parser.add_argument("--reconstructed-video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--codec-label", default="OMNISCIENT 5 MM")
    parser.add_argument("--rate-target-mbps", default=20.0, type=float)
    parser.add_argument("--freeze-label", default="0.000%")
    parser.add_argument("--reversal-label", default="0.000%")
    args = parser.parse_args()
    rows = load(args.timeline, args.route)
    with tempfile.TemporaryDirectory(prefix="omniscient-proof-") as directory:
        strip = Path(directory) / "strip.mp4"
        render_strip(
            rows,
            strip,
            args.rate_target_mbps,
            args.freeze_label,
            args.reversal_label,
        )
        compose(
            args.raw_video,
            args.reconstructed_video,
            strip,
            args.output,
            args.codec_label,
        )


if __name__ == "__main__":
    main()
