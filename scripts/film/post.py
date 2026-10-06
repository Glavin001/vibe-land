#!/usr/bin/env python3
"""Post-production for native films: the film's edit list to a finished cut.

    post.py VIDEO LOG [--out FINAL] [--fps 30] [--font PATH] [--verbose]

LOG is the film's .log (the app's stdout). Its edit list is every line with
the marker `edit ` followed by one JSON object, e.g.

    [log] [film 41.2s] edit {"type":"title","text":"ONE QUIET TOWN","from":0.5,"to":3.5}

(the `[film Ns]` prefix is wall time and is ignored). Every time in an edit
is in VIDEO seconds of the recorded VIDEO (0 = its first frame), the SOURCE
timeline. The cut is rendered in one ffmpeg pass, in this order:

  slowmo     {"from","to","rate"}  that span plays at `rate` (0.25..1); the
             whole film is time-warped first and every other edit's times are
             mapped through the warp. The output runs at --fps (default 30):
             a 60 fps recording at rate 1 keeps every other frame, at rate 0.5
             every frame; below what the source holds, frames repeat.
             Overlapping spans: the later one starts where the earlier ends.
  fade       {"dir":"in"|"out","at","seconds"}  from / to black. A fade out
             leaves the rest of the film black (titles still draw over it).
  flash      {"at","seconds"}  white at `at`, decaying to the picture.
  letterbox  {"ratio"}  black bars top and bottom over the whole 16:9 frame
             (no crop); the last one wins.
  title      {"text","from","to","style":"overlay"|"card"|"lower","size":"normal"|"big"|"small"}
             white, centred, upper case, in a bold condensed face; the text
             fades in and out over 0.25 s of OUTPUT time. `overlay` draws
             over the picture with a shadow and a soft dark band behind it;
             `card` cuts to black for the whole span (no fade on the black);
             `lower` is an overlay in the lower third (a caption, the
             picture's middle left clear)
             and draws the text on it. `big` is the hero size.
  cut        ignored. Unknown types are warned about and skipped.

Spans (from/to, at+seconds) are mapped endpoint by endpoint, so a fade or
flash inside a slow-motion span lasts longer on screen. FINAL defaults to
VIDEO with -final.mp4: H.264 (libx264 -crf 18 -preset medium), yuv420p,
+faststart, no audio. With no edit lines in LOG it exits 0 doing nothing.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction

FONTS = [
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/Library/Fonts/Impact.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
EDIT_RE = re.compile(r"(?:^|[\s\]])edit (\{.*\})\s*$")
TITLE_FADE = 0.25   # output seconds
SIZES = {"small": 0.045, "normal": 0.075, "big": 0.14}  # font size as a fraction of frame height
RATE_MIN, RATE_MAX = 0.25, 1.0


def warn(msg):
    print(f"post: warning: {msg}", file=sys.stderr)


def tool(name):
    for d in ("/opt/homebrew/bin", "/usr/local/bin"):
        p = os.path.join(d, name)
        if os.access(p, os.X_OK):
            return p
    p = shutil.which(name)
    if not p:
        sys.exit(f"post: {name} not found")
    return p


def read_edits(log_path):
    edits = []
    with open(log_path, errors="replace") as f:
        for n, line in enumerate(f, 1):
            m = EDIT_RE.search(line.rstrip("\n"))
            if not m:
                continue
            try:
                e = json.loads(m.group(1))
            except json.JSONDecodeError as err:
                warn(f"{log_path}:{n}: bad edit JSON ({err}): {m.group(1)}")
                continue
            if not isinstance(e, dict) or "type" not in e:
                warn(f"{log_path}:{n}: edit without a type: {m.group(1)}")
                continue
            edits.append(e)
    return edits


def probe(ffprobe, video):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", video],
        check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    fps = Fraction(s["r_frame_rate"])
    frames = int(s.get("nb_frames") or 0)
    duration = float(frames / fps) if frames else float(j["format"]["duration"])
    return {"w": int(s["width"]), "h": int(s["height"]), "fps": fps, "duration": duration}


class Warp:
    """Source time -> output time: rate-r spans last span/r."""

    def __init__(self, spans):
        self.spans = spans  # sorted, disjoint [(a, b, r)]

    def __call__(self, t):
        return t + sum(min(max(t - a, 0.0), b - a) * (1 / r - 1) for a, b, r in self.spans)

    def setpts(self, out_fps):
        """The warp as a setpts expression, a quarter output frame late: the fps
        filter that follows puts each frame in the nearest output slot and shows
        the last one in it, so output frame k shows the source frame at exactly
        k/out_fps (or the one before), never on a rounding tie between two."""
        x = "(T-STARTT)"
        terms = [x] + [f"clip({x}-{a:.6f},0,{b - a:.6f})*{1 / r - 1:.6f}" for a, b, r in self.spans]
        return "(" + "+".join(terms) + f"+{0.25 / out_fps:.6f})/TB"


def num(e, key, default=None):
    v = e.get(key, default)
    if v is None:
        raise ValueError(f"missing {key}")
    return float(v)


def q(s):
    """Quote a filter option value."""
    return "'" + str(s).replace("\\", "\\\\").replace("'", "'\\''") + "'"


def pick_font(explicit):
    for f in [explicit, os.environ.get("FILM_FONT")] + FONTS:
        if f and os.path.isfile(f):
            return f
    warn("no trailer font found; using fontconfig's Sans")
    return None


def build(edits, info, out_fps, font, tmp):
    """The filter chain, and a list of human-readable lines saying what it does."""
    dur = info["duration"]
    h = info["h"]
    plan = []
    spans, fades, flashes, titles, letterbox = [], [], [], [], None
    for e in edits:
        kind = e["type"]
        try:
            if kind == "cut":
                continue
            if kind == "slowmo":
                a, b, r = num(e, "from"), num(e, "to"), num(e, "rate", 0.5)
                if not RATE_MIN <= r <= RATE_MAX:
                    warn(f"slowmo rate {r} outside {RATE_MIN}..{RATE_MAX}; clamped")
                    r = min(max(r, RATE_MIN), RATE_MAX)
                a, b = max(0.0, a), min(dur, b)
                if b > a and r < 1:
                    spans.append((a, b, r))
            elif kind == "fade":
                d = e.get("dir")
                if d not in ("in", "out"):
                    raise ValueError(f"dir {d!r}")
                fades.append((d, num(e, "at", 0), num(e, "seconds", 0.8)))
            elif kind == "flash":
                flashes.append((num(e, "at"), num(e, "seconds", 0.15)))
            elif kind == "letterbox":
                letterbox = num(e, "ratio", 2.39)
            elif kind == "title":
                text = str(e.get("text", "")).upper()
                style, size = e.get("style", "overlay"), e.get("size", "normal")
                if style not in ("overlay", "card", "lower"):
                    warn(f"title style {style!r}: using overlay")
                    style = "overlay"
                if size not in SIZES:
                    warn(f"title size {size!r}: using normal")
                    size = "normal"
                titles.append((text, num(e, "from"), num(e, "to"), style, size))
            else:
                warn(f"unknown edit type {kind!r}: skipped ({json.dumps(e)})")
        except (ValueError, TypeError) as err:
            warn(f"bad {kind} edit ({err}): skipped ({json.dumps(e)})")

    # Slow motion: the later of two overlapping spans starts where the earlier ends.
    spans.sort()
    clean = []
    for a, b, r in spans:
        if clean and a < clean[-1][1]:
            warn(f"slowmo {a}..{b} overlaps {clean[-1][0]}..{clean[-1][1]}; starts at {clean[-1][1]}")
            a = clean[-1][1]
        if b > a:
            clean.append((a, b, r))
    warp = Warp(clean)
    total = warp(dur)
    chain = [f"setpts={q(warp.setpts(out_fps))}", f"fps={out_fps}"]
    for a, b, r in clean:
        plan.append(f"slowmo  {a:.3f}-{b:.3f}s x{r:g} -> output {warp(a):.3f}-{warp(b):.3f}s")

    for d, at, s in fades:
        a, b = warp(at), warp(at + s)
        chain.append(f"fade=t={d}:st={a:.4f}:d={max(b - a, 1e-3):.4f}")
        plan.append(f"fade {d:<3} {at:.3f}s+{s:g} -> output {a:.3f}-{b:.3f}s")
    for at, s in flashes:
        a, b = warp(at), warp(at + s)
        chain.append(f"fade=t=in:st={a:.4f}:d={max(b - a, 1e-3):.4f}:color=white"
                     f":enable={q(f'between(t,{a:.4f},{b:.4f})')}")
        plan.append(f"flash   {at:.3f}s+{s:g} -> output {a:.3f}-{b:.3f}s")
    if letterbox:
        bar = max(0, 2 * round((h - info["w"] / letterbox) / 4))  # even: whole chroma rows
        if bar:
            chain.append(f"drawbox=x=0:y=0:w=iw:h={bar}:color=black:t=fill")
            chain.append(f"drawbox=x=0:y=ih-{bar}:w=iw:h={bar}:color=black:t=fill")
        plan.append(f"letterbox {letterbox:g}:1 -> bars {bar} px")

    fontopt = f"fontfile={q(font)}" if font else "font=Sans"
    for i, (text, f0, f1, style, size) in enumerate(titles):
        a, b = warp(f0), warp(f1)
        if b <= a:
            warn(f"title {text!r} has no length: skipped")
            continue
        fade = min(TITLE_FADE, (b - a) / 2)
        enable = q(f"between(t,{a:.4f},{b:.4f})")
        alpha = q(f"clip(min((t-{a:.4f})/{fade:.4f},({b:.4f}-t)/{fade:.4f}),0,1)")
        fs = max(8, round(h * SIZES[size]))
        path = os.path.join(tmp, f"title{i}.txt")
        with open(path, "w") as f:
            f.write(text)
        common = (f"{fontopt}:textfile={q(path)}:expansion=none:fontsize={fs}:text_align=C"
                  f":x=(w-text_w)/2:y={'h*0.83-text_h/2' if style == 'lower' else '(h-text_h)/2'}"
                  f":enable={enable}:alpha={alpha}")
        if style == "card":
            chain.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable={enable}")
        else:
            # A soft dark band behind the words, across the frame, fading with them.
            pad_v, pad_h = round(fs * 0.55), info["w"]
            chain.append(f"drawtext={common}:fontcolor=black@0:box=1:boxcolor=black@0.35"
                         f":boxborderw={pad_v}|{pad_h}|{pad_v}|{pad_h}")
        shadow = max(1, round(fs * 0.04))
        chain.append(f"drawtext={common}:fontcolor=white:shadowcolor=black@0.6"
                     f":shadowx={shadow}:shadowy={shadow}")
        plan.append(f"title {style:<7} {size:<6} {f0:.3f}-{f1:.3f}s -> output {a:.3f}-{b:.3f}s  {text!r}")
    return chain, plan, total


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video")
    ap.add_argument("log")
    ap.add_argument("--out", help="the final cut (default VIDEO with -final.mp4)")
    ap.add_argument("--fps", type=int, default=30, help="output frame rate (default 30)")
    ap.add_argument("--font", help="TTF/OTF for titles (default Impact, else a condensed bold face)")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--verbose", "-v", action="store_true", help="print the ffmpeg command")
    args = ap.parse_args(argv)

    edits = read_edits(args.log)
    if not edits:
        print(f"post: no edit list in {args.log}; nothing to do")
        return 0
    ffmpeg, ffprobe = tool("ffmpeg"), tool("ffprobe")
    info = probe(ffprobe, args.video)
    out = args.out or re.sub(r"\.mp4$", "", args.video) + "-final.mp4"
    font = pick_font(args.font)
    with tempfile.TemporaryDirectory(prefix="film-post-") as tmp:
        chain, plan, total = build(edits, info, args.fps, font, tmp)
        cmd = [ffmpeg, "-v", "error", "-y", "-i", args.video, "-vf", ",".join(chain),
               "-frames:v", str(round(total * args.fps)), "-an",
               "-c:v", "libx264", "-crf", str(args.crf), "-preset", "medium", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", out]
        print(f"post: {len(edits)} edits; {info['w']}x{info['h']} {float(info['fps']):g} fps, "
              f"{info['duration']:.2f} s -> {args.fps} fps, {total:.2f} s; font {font or 'Sans'}")
        for line in plan:
            print(f"  {line}")
        if args.verbose:
            print(shlex.join(cmd))
        r = subprocess.run(cmd)
        if r.returncode:
            print("post: ffmpeg failed", file=sys.stderr)
            return r.returncode
    print(f"post: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
