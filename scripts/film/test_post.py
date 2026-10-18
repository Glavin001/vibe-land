#!/usr/bin/env python3
"""Tests for post.py: python3 -m unittest discover -s scripts/film -p 'test_*.py'

A synthetic 6 s, 60 fps source (testsrc2, its frame number drawn as text and
as ten black/white bit blocks in rows 120..135), cut to 30 fps by an edit
list, then checked frame by frame on the decoded output.
"""

import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import post  # noqa: E402

W, H, SRC_FPS, SECONDS, OUT_FPS = 320, 180, 60, 6, 30
BITS_Y, BIT_W, NBITS = 128, 32, 10
BAR = 24  # 2.39:1 in 320x180: (180 - 133.9) / 2, to an even row
FFMPEG, FFPROBE = post.tool("ffmpeg"), post.tool("ffprobe")

EDITS = [
    '{"type":"letterbox","ratio":2.39}',
    '{"type":"title","text":"one quiet town","from":0.5,"to":1.5,"style":"overlay"}',
    '{"type":"slowmo","from":2.0,"to":3.0,"rate":0.5}',
    '{"type":"title","text":"slow","from":2.5,"to":2.9}',
    '{"type":"title","text":"CARD","from":3.5,"to":4.5,"style":"card","size":"big"}',
    '{"type":"flash","at":5.2,"seconds":0.15}',
    '{"type":"cut"}',
    '{"type":"wobble","at":1}',
]
# The warp: 0..2 s as is, 2..3 s twice as long, after that +1 s.
def warp(t): return t if t < 2 else (2 + 2 * (t - 2) if t < 3 else t + 1)
def unwarp(u): return u if u < 2 else (2 + (u - 2) / 2 if u < 4 else u - 1)


def write_log(path, edits):
    with open(path, "w") as f:
        f.write("[log] [film 0.3s] 3 shots, 6.0 s: a, b, c\n")
        f.write("[log] [film 1.0s] rolling\n")
        for i, e in enumerate(edits):
            f.write(f"[log] [film {1.0 + i * 0.1:.1f}s] edit {e}\n")
        f.write("[log] [film 9.0s] cut\n")


def frames(video):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         check=True, capture_output=True).stdout
    n = W * H
    return [raw[i:i + n] for i in range(0, len(raw), n)]


def px(f, x, y): return f[y * W + x]
def rows(f, y0, y1): return f[y0 * W:y1 * W]
def mean(b): return sum(b) / len(b)
def frame_number(f): return sum((px(f, i * BIT_W + BIT_W // 2, BITS_Y) > 128) << i for i in range(NBITS))
def at(t): return round(t * OUT_FPS)  # the output frame shown at output time t


class PostTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="film-post-test-")
        d = cls.tmp.name
        cls.src = os.path.join(d, "src.mp4")
        bits = f"16+219*mod(floor(N/pow(2,floor(X/{BIT_W}))),2)"
        subprocess.run([
            FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i",
            f"testsrc2=s={W}x{H}:r={SRC_FPS}:d={SECONDS},format=yuv420p,"
            f"drawtext=text='%{{n}}':fontsize=24:fontcolor=white:x=8:y=30:box=1:boxcolor=black,"
            f"geq=lum='if(between(Y,120,135),{bits},lum(X,Y))'"
            f":cb='if(between(Y,60,67),128,cb(X,Y))':cr='if(between(Y,60,67),128,cr(X,Y))'",
            "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", cls.src], check=True)
        cls.log = os.path.join(d, "src.log")
        write_log(cls.log, EDITS)
        cls.out = os.path.join(d, "final.mp4")
        subprocess.run([sys.executable, post.__file__, cls.src, cls.log, "--out", cls.out],
                       check=True, capture_output=True)
        cls.f = frames(cls.out)
        # The same cut without titles: what the titles change.
        cls.log_plain = os.path.join(d, "plain.log")
        write_log(cls.log_plain, [e for e in EDITS if '"title"' not in e])
        cls.out_plain = os.path.join(d, "plain.mp4")
        subprocess.run([sys.executable, post.__file__, cls.src, cls.log_plain, "--out", cls.out_plain],
                       check=True, capture_output=True)
        cls.plain = frames(cls.out_plain)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_source_is_readable(self):
        src = frames(self.src)
        self.assertEqual(len(src), SRC_FPS * SECONDS)
        self.assertEqual([frame_number(src[i]) for i in (0, 1, 77, 359)], [0, 1, 77, 359])

    def test_duration_after_slowmo(self):
        out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=r_frame_rate,codec_name,pix_fmt:format=duration", "-of", "csv=p=0",
                              self.out], check=True, capture_output=True, text=True).stdout.split()
        self.assertEqual(out[0], "h264,yuv420p,30/1")
        self.assertAlmostEqual(float(out[1]), warp(SECONDS), delta=1 / OUT_FPS)
        self.assertEqual(len(self.f), round(warp(SECONDS) * OUT_FPS))  # 7 s, 210 frames

    def test_time_warp_frame_by_frame(self):
        hidden = set(range(at(4.5) - 1, at(5.5) + 2)) | set(range(at(6.2) - 1, at(6.35) + 2))  # card, flash
        seen = {}
        for k, f in enumerate(self.f):
            if k in hidden:
                continue
            expect = unwarp(k / OUT_FPS) * SRC_FPS
            seen[k] = frame_number(f)
            self.assertLessEqual(abs(seen[k] - expect), 1, f"output frame {k}: source frame {seen[k]}, want ~{expect:.1f}")
        # Normal speed: every other source frame; in the 0.5 span: every one.
        for k in range(1, len(self.f)):
            if k in seen and k - 1 in seen:
                step = seen[k] - seen[k - 1]
                u = k / OUT_FPS
                if 2.05 < u < 3.95:
                    self.assertEqual(step, 1, f"slow-mo step at output frame {k}")
                elif u < 1.95 or u > 4.05:
                    self.assertEqual(step, 2, f"normal step at output frame {k}")

    def test_letterbox_bars_black(self):
        bar = BAR
        for k, f in enumerate(self.f):
            self.assertLess(max(rows(f, 0, bar)), 30, f"top bar, frame {k}")
            self.assertLess(max(rows(f, H - bar, H)), 30, f"bottom bar, frame {k}")
        # ...and not more than the bars.
        self.assertGreater(mean(rows(self.f[at(0.2)], bar + 2, bar + 20)), 60)

    def test_card_black_except_text(self):
        a, b = at(4.5), at(5.5)  # source 3.5..4.5 after the slow-mo's extra second
        for k in range(a, b + 1):
            f = self.f[k]
            lit = sum(v > 40 for v in f) / len(f)
            self.assertLess(lit, 0.06, f"card frame {k}: {lit:.0%} lit")
            if a + 8 <= k <= b - 8:  # text fully faded in
                self.assertGreater(max(f), 200, f"card frame {k}: no text")
                self.assertLess(max(rows(f, 0, 60)) + max(rows(f, 120, H)), 60, f"card frame {k}: picture shows")
        for k in (a - 1, b + 1):
            lit = sum(v > 40 for v in self.f[k]) / (W * H)
            self.assertGreater(lit, 0.4, f"frame {k} just outside the card is black")

    def test_flash_bright(self):
        bar = BAR
        visible = lambda k: mean(rows(self.f[k], bar, H - bar))
        k = at(6.2)
        self.assertGreater(visible(k), 225, "flash frame not white")
        self.assertLess(visible(k - 1), 170)
        self.assertLess(abs(visible(k + 6) - mean(rows(self.plain[k + 6], bar, H - bar))), 0.01 + 3)
        self.assertGreater(visible(k), visible(k + 2))  # decays

    def test_titles_land_after_warp(self):
        """Where the titles change the picture: their spans, mapped through the warp."""
        def diff(k):
            a, b = rows(self.f[k], 70, 110), rows(self.plain[k], 70, 110)
            return sum(abs(x - y) for x, y in zip(a, b)) / len(a)
        spans = [(0.5, 1.5), (warp(2.5), warp(2.9))]  # "SLOW": output 3.0..3.8
        self.assertEqual(spans[1], (3.0, 3.8))
        for k in range(at(4.4)):
            u = k / OUT_FPS
            inside = [s for s in spans if s[0] + 0.1 <= u <= s[1] - 0.1]
            outside = all(u < s[0] - 0.04 or u > s[1] + 0.04 for s in spans)
            if inside:
                self.assertGreater(diff(k), 6, f"output frame {k} ({u:.3f} s): no title")
            elif outside:
                self.assertLess(diff(k), 2.5, f"output frame {k} ({u:.3f} s): a title outside its span")

    def test_quarter_speed_repeats_frames(self):
        d = self.tmp.name
        log, out = os.path.join(d, "quarter.log"), os.path.join(d, "quarter.mp4")
        write_log(log, ['{"type":"slowmo","from":1.0,"to":1.5,"rate":0.25}'])
        subprocess.run([sys.executable, post.__file__, self.src, log, "--out", out], check=True, capture_output=True)
        n = [frame_number(f) for f in frames(out)]
        self.assertEqual(len(n), round((SECONDS + 0.5 * 3) * OUT_FPS))  # 0.5 s lasts 2 s
        # 60 fps at a quarter speed into 30 fps: each source frame twice.
        span = n[at(1.0):at(3.0)]
        self.assertEqual(span, [60 + i // 2 for i in range(60)])
        self.assertEqual(n[at(3.0)], 90)
        self.assertEqual(n[-1], 358)

    def test_no_edit_list_does_nothing(self):
        d = self.tmp.name
        log = os.path.join(d, "none.log")
        write_log(log, [])
        out = os.path.join(d, "none.mp4")
        r = subprocess.run([sys.executable, post.__file__, self.src, log, "--out", out], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(out))

    def test_parsing(self):
        edits = post.read_edits(self.log)
        self.assertEqual([e["type"] for e in edits],
                         ["letterbox", "title", "slowmo", "title", "title", "flash", "cut", "wobble"])
        w = post.Warp([(2.0, 3.0, 0.5), (4.0, 5.0, 0.25)])
        self.assertEqual([w(t) for t in (1, 2.5, 3.5, 4.5, 6)], [1, 3, 4.5, 7, 10])


if __name__ == "__main__":
    unittest.main()
