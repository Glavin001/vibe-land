#!/usr/bin/env python3
"""A film's performance, from its log: per-frame stats to a CSV, a summary and a chart.

    scripts/film/stats.py LOG [--out BASE]

The film runner (client/native/film/film.mjs) logs one `stats {json}` line
per film frame -- wall-clock costs (frameMs, stepMs: the sim ticks, renderMs,
or wallMs: the gap between frames), the sim's (physxMs, gpuWaitMs, awake
bodies), the city's (chunksAwake, broken bonds), meteors in flight, the
renderer's (cpuMs, draws) and the recorder's (captureMs) -- plus `shot i/n
NAME at Ts` and `impact {at, position}` lines. This writes, next to BASE
(default: the log without .log):

  BASE-stats.csv    one row per film frame, with its shot
  BASE-stats.json   per shot and overall: frames, frame/step/physx ms
                    (median, p95, max), peak awake bodies, bonds broken,
                    impacts; the slowest frames
  BASE-stats.html   the same as charts over film time (inline SVG, no
                    dependencies): frame cost, bodies, damage, with the
                    shots shaded and the impacts marked

A frame's cost is frameMs when film mode reports it, else wallMs. In film
mode a frame may take as long as the sim needs: these say where it did.
"""

import argparse
import csv
import html
import json
import os
import re
import statistics
import sys

STATS = re.compile(r'\bstats (\{.*\})\s*$')
SHOT = re.compile(r'\bshot (\d+)/(\d+) (\S+) at ([0-9.]+)s')
IMPACT = re.compile(r'\bimpact (\{.*\})\s*$')
FIELDS = ['f', 't', 'tick', 'shot', 'cost', 'wallMs', 'frameMs', 'stepMs', 'pumpMs', 'renderMs', 'onFrameMs', 'tickMs',
          'maxTickMs', 'dynamicsMs', 'cityMs', 'physxMs', 'gpuWaitMs', 'awake', 'frozen', 'chunksAwake', 'broken', 'meteors',
          'cpuMs', 'draws', 'captureMs', 'frames']


def parse(lines):
    """(frames, shots [(start, name)], impacts [{at, position}]) from a film log."""
    frames, shots, impacts = [], [], []
    for line in lines:
        m = STATS.search(line)
        if m:
            try:
                frames.append(json.loads(m.group(1)))
            except json.JSONDecodeError:
                pass
            continue
        m = SHOT.search(line)
        if m:
            shots.append((float(m.group(4)), m.group(3)))
            continue
        m = IMPACT.search(line)
        if m:
            try:
                impacts.append(json.loads(m.group(1)))
            except json.JSONDecodeError:
                pass
    for fr in frames:
        # A frame's whole wall cost: from its start to the next (film mode's
        # intervalMs, logged as wallMs: present and recording included).
        fr['cost'] = fr.get('wallMs') if fr.get('wallMs') is not None else fr.get('frameMs')
        fr['shot'] = shot_at(shots, fr.get('t') or 0)
    return frames, shots, impacts


def shot_at(shots, t):
    name = shots[0][1] if shots else ''
    for start, n in shots:
        if t + 1e-6 >= start:
            name = n
    return name


def pct(values, q):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    k = min(len(values) - 1, max(0, round(q * (len(values) - 1))))
    return values[k]


def spread(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {'median': round(statistics.median(values), 2), 'p95': round(pct(values, 0.95), 2), 'max': round(max(values), 2)}


def summarise(frames, shots, impacts):
    def block(rows, start=None, end=None):
        broken = [r['broken'] for r in rows if r.get('broken') is not None]
        return {
            'frames': len(rows),
            'wallSeconds': round(sum(r['cost'] or 0 for r in rows) / 1000, 1),
            'frameMs': spread([r['cost'] for r in rows]),
            'stepMs': spread([r.get('stepMs') for r in rows]),
            'renderMs': spread([r.get('renderMs') for r in rows]),
            'physxMs': spread([r.get('physxMs') for r in rows]),
            'cityMs': spread([r.get('cityMs') for r in rows]),
            'maxTickMs': max((r['maxTickMs'] for r in rows if r.get('maxTickMs') is not None), default=None),
            'peakAwake': max((r['awake'] for r in rows if r.get('awake') is not None), default=None),
            'peakChunksAwake': max((r['chunksAwake'] for r in rows if r.get('chunksAwake') is not None), default=None),
            'bondsBroken': (broken[-1] - broken[0]) if len(broken) > 1 else 0,
            'impacts': sum(1 for i in impacts if start is None or start <= i['at'] < end),
        }

    ends = [s for s, _ in shots[1:]] + [float('inf')]
    per_shot = []
    for (start, name), end in zip(shots, ends):
        rows = [r for r in frames if start <= (r.get('t') or 0) < end]
        per_shot.append({'shot': name, 'start': start, **block(rows, start, end)})
    slowest = sorted((r for r in frames if r['cost'] is not None), key=lambda r: -r['cost'])[:10]
    return {
        'overall': block(frames),
        'shots': per_shot,
        'slowest': [{k: r.get(k) for k in ('f', 't', 'shot', 'cost', 'stepMs', 'renderMs', 'physxMs', 'awake', 'chunksAwake')} for r in slowest],
    }


# ------------------------------------------------------------------ charts

COLOURS = ['#2a6fdb', '#e8590c', '#2f9e44', '#9c36b5', '#c92a2a', '#0b7285']


def chart(frames, shots, impacts, series, title, unit, width=1100, height=220):
    """An inline SVG line chart of `series` [(field, label)] over film time."""
    pad_l, pad_r, pad_t, pad_b = 56, 12, 26, 26
    ts = [r.get('t') or 0 for r in frames]
    t1 = max(ts) if ts else 1
    peak = max((r.get(f) or 0 for r in frames for f, _ in series), default=1) or 1
    x = lambda t: pad_l + (width - pad_l - pad_r) * t / t1
    y = lambda v: height - pad_b - (height - pad_t - pad_b) * v / peak
    out = [f'<svg viewBox="0 0 {width} {height}" width="100%" role="img" aria-label="{html.escape(title)}">',
           f'<text x="{pad_l}" y="16" class="title">{html.escape(title)} ({unit})</text>']
    ends = [s for s, _ in shots[1:]] + [t1]
    for k, ((start, name), end) in enumerate(zip(shots, ends)):
        if k % 2:
            out.append(f'<rect x="{x(start):.1f}" y="{pad_t}" width="{max(0, x(end) - x(start)):.1f}" height="{height - pad_t - pad_b}" class="band"/>')
        out.append(f'<text x="{x(start) + 3:.1f}" y="{height - 8}" class="shot">{html.escape(name)}</text>')
    for i in impacts:
        if 0 <= i['at'] <= t1:
            out.append(f'<line x1="{x(i["at"]):.1f}" x2="{x(i["at"]):.1f}" y1="{pad_t}" y2="{pad_t + 6}" class="impact"/>')
    for v in (0, peak / 2, peak):
        out.append(f'<text x="{pad_l - 6}" y="{y(v) + 4:.1f}" class="axis" text-anchor="end">{v:.0f}</text>')
        out.append(f'<line x1="{pad_l}" x2="{width - pad_r}" y1="{y(v):.1f}" y2="{y(v):.1f}" class="grid"/>')
    for k, (field, label) in enumerate(series):
        pts = [(x(r.get('t') or 0), y(r[field])) for r in frames if r.get(field) is not None]
        if not pts:
            continue
        colour = COLOURS[k % len(COLOURS)]
        out.append(f'<polyline fill="none" stroke="{colour}" stroke-width="1.3" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in pts)}"/>')
        out.append(f'<text x="{width - pad_r - 6 - 150 * (len(series) - 1 - k)}" y="16" fill="{colour}" class="legend" text-anchor="end">{html.escape(label)}</text>')
    out.append('</svg>')
    return '\n'.join(out)


def report(frames, shots, impacts, summary, name):
    o = summary['overall']
    rows = ''.join(
        f'<tr><td>{html.escape(s["shot"])}</td><td>{s["start"]:.1f}</td><td>{s["frames"]}</td><td>{s["wallSeconds"]}</td>'
        f'<td>{(s["frameMs"] or {}).get("median", "")}</td><td>{(s["frameMs"] or {}).get("p95", "")}</td><td>{(s["frameMs"] or {}).get("max", "")}</td>'
        f'<td>{(s["stepMs"] or {}).get("median", "")}</td><td>{(s["physxMs"] or {}).get("p95", "")}</td>'
        f'<td>{s["peakAwake"] if s["peakAwake"] is not None else ""}</td><td>{s["bondsBroken"]}</td><td>{s["impacts"]}</td></tr>'
        for s in summary['shots'])
    slow = ''.join(
        f'<tr><td>{r["f"]}</td><td>{(r["t"] or 0):.2f}</td><td>{html.escape(r["shot"] or "")}</td><td>{r["cost"]}</td>'
        f'<td>{r.get("stepMs") if r.get("stepMs") is not None else ""}</td><td>{r.get("renderMs") if r.get("renderMs") is not None else ""}</td>'
        f'<td>{r.get("physxMs") if r.get("physxMs") is not None else ""}</td><td>{r.get("awake") if r.get("awake") is not None else ""}</td></tr>'
        for r in summary['slowest'])
    charts = [
        chart(frames, shots, impacts, [('cost', 'frame'), ('stepMs', 'sim step'), ('renderMs', 'render'), ('cityMs', 'destruction stage')], 'Wall time per film frame', 'ms'),
        chart(frames, shots, impacts, [('awake', 'awake bodies'), ('frozen', 'frozen bodies'), ('chunksAwake', 'awake chunks')], 'Active bodies', 'count'),
        chart(frames, shots, impacts, [('broken', 'broken bonds')], 'Damage', 'bonds'),
        chart(frames, shots, impacts, [('meteors', 'meteors in flight'), ('draws', 'draw calls')], 'Meteors and draws', 'count'),
    ]
    fm = o['frameMs'] or {}
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(name)} stats</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {{ --fg:#1b1d21; --bg:#fff; --muted:#667; --band:#f1f3f7; --grid:#e3e6ec; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fg:#e6e8ec; --bg:#15171b; --muted:#99a; --band:#1f2228; --grid:#2a2e36; }} }}
body {{ font:14px system-ui, sans-serif; color:var(--fg); background:var(--bg); margin:16px; max-width:1140px; }}
h1 {{ font-size:20px; margin:0 0 4px; }} p {{ color:var(--muted); margin:0 0 12px; }}
table {{ border-collapse:collapse; margin:8px 0 18px; font-variant-numeric:tabular-nums; }}
td, th {{ padding:3px 8px; border-bottom:1px solid var(--grid); text-align:right; }} td:first-child, th:first-child {{ text-align:left; }}
svg text {{ fill:var(--fg); font:11px system-ui, sans-serif; }} svg .title {{ font-weight:600; font-size:12px; }}
svg .axis, svg .shot {{ fill:var(--muted); }} svg .band {{ fill:var(--band); }} svg .grid {{ stroke:var(--grid); }}
svg .impact {{ stroke:#c92a2a; stroke-width:1.5; }}
</style></head><body>
<h1>{html.escape(name)}</h1>
<p>{o['frames']} film frames in {o['wallSeconds']} s of wall time; frame median {fm.get('median')} ms, p95 {fm.get('p95')} ms, max {fm.get('max')} ms;
peak {o['peakAwake']} awake bodies; {o['bondsBroken']} bonds broken; {o['impacts']} impacts (red ticks).</p>
{''.join(charts)}
<h2>Per shot</h2>
<table><tr><th>shot</th><th>start s</th><th>frames</th><th>wall s</th><th>frame ms median</th><th>p95</th><th>max</th><th>step ms median</th><th>physx ms p95</th><th>peak awake</th><th>bonds broken</th><th>impacts</th></tr>{rows}</table>
<h2>Slowest frames</h2>
<table><tr><th>frame</th><th>t s</th><th>shot</th><th>frame ms</th><th>step ms</th><th>render ms</th><th>physx ms</th><th>awake</th></tr>{slow}</table>
</body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('log')
    ap.add_argument('--out', help='output base (default: the log path without .log)')
    args = ap.parse_args()
    with open(args.log, errors='replace') as f:
        frames, shots, impacts = parse(f)
    if not frames:
        print(f'stats: no stats lines in {args.log}')
        return 0
    base = args.out or re.sub(r'\.log$', '', args.log)
    summary = summarise(frames, shots, impacts)
    with open(f'{base}-stats.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction='ignore')
        w.writeheader()
        w.writerows(frames)
    with open(f'{base}-stats.json', 'w') as f:
        json.dump(summary, f, indent=1)
    with open(f'{base}-stats.html', 'w') as f:
        f.write(report(frames, shots, impacts, summary, os.path.basename(base)))
    o = summary['overall']
    fm = o['frameMs'] or {}
    print(f'stats: {o["frames"]} frames, {o["wallSeconds"]} s wall, frame median {fm.get("median")} ms p95 {fm.get("p95")} max {fm.get("max")}, '
          f'peak {o["peakAwake"]} awake bodies -> {base}-stats.html, -stats.csv, -stats.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
