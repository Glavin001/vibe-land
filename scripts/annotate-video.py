#!/usr/bin/env python3
"""Burn per-second run metrics into a viewer video, and emit a run summary.

A video without its numbers is an opinion. This takes the per-tick metrics CSV
that record-city-trace --metrics-out produces, aggregates it to one row per
video second, and burns it into the frame -- so a recording carries its own
receipts and two runs can be compared by eye AND by number without hunting for
which log belonged to which mp4.

  scripts/annotate-video.py in.mp4 metrics.csv out.mp4 --label "baseline"
"""
import argparse, csv, json, subprocess, sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("video"); ap.add_argument("metrics"); ap.add_argument("out")
ap.add_argument("--label", default="")
ap.add_argument("--fps", type=float, default=30.0)
ap.add_argument("--sim-hz", type=float, default=60.0)
a = ap.parse_args()

rows = list(csv.DictReader(open(a.metrics)))
rows = [r for r in rows if float(r["tick"]) > 0]
if not rows:
    sys.exit("no metrics rows")

# probe the video length so metrics and frames stay aligned even if the trace
# is longer than what was rendered
dur = float(subprocess.run(
    ["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0", a.video],
    capture_output=True, text=True).stdout.strip())
secs = int(dur)

def agg(lo, hi, key, how="median"):
    vals = sorted(float(r[key]) for r in rows[lo:hi])
    if not vals: return 0.0
    return vals[len(vals)//2] if how == "median" else vals[-1]

per_sec, tps = [], int(a.sim_hz)
for s in range(secs):
    lo, hi = s*tps, min((s+1)*tps, len(rows))
    if lo >= len(rows): break
    physx = agg(lo,hi,"physx_step"); city = agg(lo,hi,"stress_solve")
    per_sec.append(dict(
        t=s, awake=int(agg(lo,hi,"awake")), bodies=int(agg(lo,hi,"bodies")),
        bonds=int(agg(lo,hi,"bonds")), physx=physx, city=city, tick=physx+city,
        end=agg(lo,hi,"end"), begin=agg(lo,hi,"begin"), solve=agg(lo,hi,"solve"),
        support=agg(lo,hi,"support"), readback=agg(lo,hi,"readback"),
        frozen=int(agg(lo,hi,"frozen"))))

def esc(t):
    for c, r in [("\\","\\\\"),(":","\\:"),("'","\u2019"),("%","\\%"),(",","\\,")]:
        t = t.replace(c, r)
    return t

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
common = (f"fontfile={FONT}:fontcolor=white:fontsize=22:box=1:"
          f"boxcolor=black@0.65:boxborderw=8")
filters = []
if a.label:
    filters.append(f"drawtext={common}:fontsize=26:x=20:y=20:text='{esc(a.label)}'")
for p in per_sec:
    l1 = (f"t={p['t']:>2}s  awake {p['awake']:>5}  frozen {p['frozen']:>5}  "
          f"bonds {p['bonds']:>6}")
    l2 = (f"tick {p['tick']:>5.1f}ms = physx {p['physx']:>5.1f} + city {p['city']:>5.1f}")
    l3 = (f"begin {p['begin']:>4.1f}  solve {p['solve']:>4.1f}  end {p['end']:>4.1f}  "
          f"support {p['support']:>4.1f}  readback {p['readback']:>4.1f}")
    en = f":enable='between(t,{p['t']},{p['t']+1})'"
    for i, line in enumerate((l1, l2, l3)):
        filters.append(f"drawtext={common}:x=20:y={h}:text='{esc(line)}'{en}"
                       .replace("{h}", str(980 + i*30)) if False else
                       f"drawtext={common}:x=20:y={980+i*30}:text='{esc(line)}'{en}")

chain = ",".join(filters)
fl = Path("/tmp/_annot_filter.txt"); fl.write_text(chain)
r = subprocess.run(["ffmpeg","-y","-loglevel","error","-i",a.video,
                    "-filter_complex_script",str(fl),
                    "-c:v","libx264","-crf","20","-preset","medium",
                    "-c:a","copy", a.out], capture_output=True, text=True)
if r.returncode != 0:
    sys.exit(f"ffmpeg failed:\n{r.stderr[-3000:]}")

# companion summary, so the numbers survive independently of the pixels
peak = max(per_sec, key=lambda p: p["awake"])
summary = {
    "label": a.label, "video": Path(a.out).name, "seconds": len(per_sec),
    "peak_awake": peak["awake"], "peak_awake_at_s": peak["t"],
    "final_bonds": per_sec[-1]["bonds"], "final_bodies": per_sec[-1]["bodies"],
    "at_peak": {k: round(peak[k], 2) for k in
                ("tick","physx","city","begin","solve","end","support","readback")},
    "per_second": [{k: (round(v,2) if isinstance(v,float) else v)
                    for k,v in p.items()} for p in per_sec],
}
Path(a.out).with_suffix(".summary.json").write_text(json.dumps(summary, indent=1))
print(f"wrote {a.out}")
print(f"wrote {Path(a.out).with_suffix('.summary.json')}")
print(f"peak awake {peak['awake']} at t={peak['t']}s -> tick {peak['tick']:.1f}ms "
      f"(physx {peak['physx']:.1f} + city {peak['city']:.1f})")
