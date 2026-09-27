#!/usr/bin/env python3
"""Summarise a garage destruction recording's telemetry
(scripts/perf/garage-destruction-video.mjs writes <video>.telemetry.jsonl).

  python3 scripts/perf/analyze-destruction-telemetry.py [target/garage-destruction.telemetry.jsonl]

Per shot: the car body's jump in speed and spin, Vehicle2's wheel mask and
wheel travel, and how deep any hull sits below the terrain. "sunk" is the
longest run of samples with a colliding hull more than 5 cm into the ground;
"wheel hull" is the deepest terrain-excluded (Vehicle2-driven) wheel hull.
"""
import json, math, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'target/garage-destruction.telemetry.jsonl'
rows = [json.loads(line) for line in open(path)]
samples = [r for r in rows if 'bodies' in r]
shots = [r for r in rows if 'shot' in r]
norm = lambda v: math.sqrt(sum(x * x for x in v))
carrier = lambda s: next(b for b in s['bodies'] if b['actor'] == 0)

def window(start, end):
    return [s for s in samples if start <= s['t'] < end]

print(f"{len(samples)} samples over {samples[-1]['t'] / 1000:.1f} s, {len(shots)} shots")
print(f"{'shot':<28}{'bonds':>6}{'bodies':>7}{'dv m/s':>8}{'w rad/s':>8}{'mask':>5}{'travel':>8}{'pen m':>7}{'sunk s':>7}{'wheel hull':>11}")
bounds = [s['t'] for s in shots] + [samples[-1]['t'] + 1]
worst = []
for shot, end in zip(shots, bounds[1:]):
    w = window(shot['t'], end)
    if not w: continue
    before = window(shot['t'] - 300, shot['t']) or w[:1]
    v0 = carrier(before[-1])['v']
    dv = max(norm([a - b for a, b in zip(carrier(s)['v'], v0)]) for s in w)
    spin = max(norm(carrier(s)['w']) for s in w)
    travel = max((abs(j) for s in w for j in (s.get('vehicle2') or {}).get('wheelJounce', []) if abs(j) < 1e30), default=0)
    unset = any(abs(j) >= 1e30 for s in w for j in (s.get('vehicle2') or {}).get('wheelJounce', []))
    pen = [max((b['penetration'] for b in s['bodies'] if b['penetration'] is not None), default=0) for s in w]
    run = longest = 0
    for p, a, b in zip(pen, w, w[1:] + w[-1:]):
        run = run + (b['t'] - a['t']) if p > 0.05 else 0
        longest = max(longest, run)
    wheel = max((b['excludedPenetration'] for s in w for b in s['bodies'] if b['actor'] == 0 and b['excludedPenetration'] is not None and b['excludedPenetration'] > -1e9), default=0)
    last = w[-1]
    name = f"{shot['shot']['name']} #{shot['shot']['part']}"[:27]
    print(f"{name:<28}{last['brokenBonds']:>6}{len(last['bodies']):>7}{dv:>8.2f}{spin:>8.2f}{last['vehicle']['wheelMask']:>5}"
          f"{travel:>7.2f}{'*' if unset else ' '}{max(pen):>7.3f}{longest / 1000:>7.2f}{wheel:>11.3f}")
    deepest = max(((b['penetration'], b['deepest'], s['t']) for s in w for b in s['bodies'] if b['penetration'] is not None and b['deepest']), key=lambda x: x[0], default=None)
    if deepest and deepest[0] > 0.05: worst.append((name, deepest))
print("* = Vehicle2 reported the unspecified (FLT_MAX) jounce for a wheel")
for name, (depth, where, t) in worst:
    print(f"deepest after {name}: {where['name']} {depth:.3f} m under the terrain at t={t / 1000:.1f} s {where['point']}")

# Client vs server: how long after the server had N parts off the car did the
# client draw them as detached (the rest are drawn on the car body)?
frames = [r['client'] for r in rows if 'client' in r and r['client']['kind'] == 'frame']
if frames:
    drawn_by_tick = {}
    for f in frames:
        if f['rigTick'] is not None: drawn_by_tick[f['rigTick']] = max(drawn_by_tick.get(f['rigTick'], 0), f['detached'])
    lags = []
    for s in samples:
        off = sum(b['parts'] for b in s['bodies'] if b['actor'] != 0)
        if not off: continue
        later = [t for t, n in drawn_by_tick.items() if t >= s['tick'] and n >= off]
        lags.append((min(later) - s['tick']) if later else None)
    missing = sum(1 for l in lags if l is None)
    known = [l for l in lags if l is not None]
    print(f"client drew detached parts: {len(known)} samples matched, worst lag {max(known, default=0)} ticks, never drawn {missing}")
