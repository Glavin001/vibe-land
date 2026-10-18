#!/usr/bin/env python3
"""Do bodies that were put to sleep wake when hit? From the per-cycle server
captures of a rest-soak run (soak.mjs): every settle and wake edge in the
encoder tape, and every meteor in events.jsonl.

A settle is a rest sleep when it lands on a rest-pass tick (every 120 ticks;
the phase moves at a city reset, so it is found per capture as the residue
that holds the settles where native_rest_slept_bodies rose in stats.jsonl)
and that counter rose across that tick. An engine sleep landing on the same
tick is miscounted as rest (rare: one tick in 120, and only where the counter
rose). For every
meteor impact (launch tick + flight time, at its exact target), each body that
was asleep then within R m of the target (by its settle pose) is a candidate:
did it wake within 2 s, and did it then move? Cannonball volleys of the
re-wake checks are scored the same way around the building centre.
usage: rewake.py <run dir> [--json]"""
import sys, json, math, glob, os, subprocess
from collections import Counter, defaultdict
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rubble-sleep'))
from tape import ticks as _ticks

def ticks(f):
    """The tape's ticks; a trailing partial tick (a capture stopped mid-write) ends it."""
    try:
        yield from _ticks(f)
    except EOFError:
        return

run = sys.argv[1]
soak = json.load(open(os.path.join(run, 'soak.json')))
ent = lambda sid, isl: 0x80000000 | (sid << 20) | isl
BANDS = [(0, 3), (3, 6)]
WAKE_WINDOW = 150  # ticks after the impact tick
PRE = 30           # a wake up to this many ticks before the computed impact still counts
total = defaultdict(Counter)
per_cycle = []
stats = [json.loads(l) for l in open(os.path.join(run, 'stats.jsonl')) if l.strip()]
stats = [l for l in stats if 'spans' in l and l['spans'].get('native_frame') is not None]
# Brackets (tick_lo, tick_hi] in which the rest counter rose.
rises = []
for a, b in zip(stats, stats[1:]):
    va, vb = a['spans'].get('native_rest_slept_bodies') or 0, b['spans'].get('native_rest_slept_bodies') or 0
    if vb > va and b['server_tick'] - b['spans']['native_frame'] == a['server_tick'] - a['spans']['native_frame']:
        rises.append((a['server_tick'], b['server_tick']))

for cap in soak.get('captures', []):
    d = os.path.join(run, 'debug-reports', f"session-{cap['sessionId']}", 'server', 'city')
    tp = os.path.join(d, 'encoder.tape')
    if not os.path.exists(tp):
        per_cycle.append({'session': cap['sessionId'], 'error': 'no tape'}); continue
    meta = json.load(open(os.path.join(d, 'capture.json'))) if os.path.exists(os.path.join(d, 'capture.json')) else {}
    ev = [json.loads(l) for l in open(os.path.join(d, 'events.jsonl')) if l.strip()] if os.path.exists(os.path.join(d, 'events.jsonl')) else []
    impacts = []
    for e in ev:
        if e.get('kind') == 'meteor' and e.get('target'):
            impacts.append(('meteor', e['tick'] + int(round(e.get('flight_s', 0) * 60)), e['target']))
    # Cannon volleys of the re-wake checks: from the first shot of the volley.
    for chk in soak.get('rewake', []):
        if chk.get('sessionId') != cap['sessionId']: continue
        m = {x['what']: x for x in chk['marks']}
        a, b = m.get('before cannon', {}).get('tick'), m.get('after cannon', {}).get('tick')
        if a is None or b is None: continue
        shots = [e['tick'] for e in ev if e.get('kind') == 'shot' and a - 60 <= e['tick'] <= b + 60]
        if shots: impacts.append(('cannon', min(shots), chk['centre']))
    impacts.sort(key=lambda x: x[1])

    # The rest pass's tick residue: the one that carries the settles inside
    # the brackets where the rest counter rose (first pass over the tape).
    in_rise = lambda t: any(lo < t <= hi for lo, hi in rises)
    by_residue = Counter()
    p = subprocess.Popen(['zstd', '-dc', tp], stdout=subprocess.PIPE)
    for tick, rows, batches, settles, wakes in ticks(p.stdout):
        if settles and in_rise(tick): by_residue[tick % 120] += len(settles)
    p.wait()
    residue = by_residue.most_common(1)[0][0] if by_residue else None
    is_rest_tick = lambda t: residue is not None and t % 120 == residue and in_rise(t)
    asleep = {}          # entity -> (settle tick, pose, rest)
    cands = []           # per impact: list of (entity, rest, band)
    pending = []         # (impact index, deadline tick, {entity: (rest, band, pose)})
    woke_after = {}      # (impact idx, entity) -> wake tick
    track = {}           # entity -> (pose at settle, wake tick, max displacement) while being followed
    moved = set()
    rest_settles = engine_settles = rest_wakes = immediate_rest_rewakes = 0
    rest_sleep_durations = []
    below = set(); first = last = None
    ii = 0
    p = subprocess.Popen(['zstd', '-dc', tp], stdout=subprocess.PIPE)
    for tick, rows, batches, settles, wakes in ticks(p.stdout):
        first = tick if first is None else first; last = tick
        # Impacts whose tick has come: freeze the candidate set.
        while ii < len(impacts) and impacts[ii][1] - PRE <= tick:
            kind, t_hit, target = impacts[ii]
            c = {}
            for e, (st, pose, rest) in asleep.items():
                dd = math.hypot(pose[0] - target[0], pose[2] - target[2])
                for lo, hi in BANDS:
                    if lo <= dd < hi: c[e] = (rest, f'{lo}-{hi}m', pose)
            pending.append((ii, t_hit + WAKE_WINDOW, c))
            cands.append((kind, c))
            ii += 1
        for w in wakes:
            e = ent(w[0], w[1])
            if e in asleep:
                st, pose, rest = asleep.pop(e)
                if rest:
                    rest_wakes += 1
                    rest_sleep_durations.append(tick - st)
                    if tick - st <= 60: immediate_rest_rewakes += 1
                track[e] = [pose, tick, 0.0]
            for (k, dl, c) in pending:
                if e in c and tick <= dl and (k, e) not in woke_after: woke_after[(k, e)] = tick
        for r in rows:
            if r[2] < -1.0: below.add(r[0])
            t = track.get(r[0])
            if t is not None:
                disp = math.dist(t[0], r[1:4])
                if disp > t[2]: t[2] = disp
                if disp > 0.01: moved.add((r[0], t[1]))
                if tick - t[1] > 180: del track[r[0]]
        for s in settles:
            e = ent(s[0], s[1]); rest = is_rest_tick(tick)
            asleep[e] = (tick, s[2:5], rest)
            track.pop(e, None)
            if rest: rest_settles += 1
            else: engine_settles += 1
        pending = [x for x in pending if x[1] >= tick]
    p.wait()

    cyc = {'session': cap['sessionId'], 'ticks': [first, last], 'rest_residue': residue, 'dropped_ticks': meta.get('dropped_ticks'),
           'rest_settles': rest_settles, 'engine_settles': engine_settles, 'rest_wakes': rest_wakes,
           'immediate_rest_rewakes_le_60_ticks': immediate_rest_rewakes, 'impacts': len(impacts),
           'rest_sleep_s_p50': round(sorted(rest_sleep_durations)[len(rest_sleep_durations) // 2] / 60, 1) if rest_sleep_durations else None,
           'rows_below_minus_1m': len(below), 'still_asleep_at_end': len(asleep),
           'still_asleep_rest_at_end': sum(1 for v in asleep.values() if v[2])}
    agg = defaultdict(Counter)
    missed = []
    for k, (kind, c) in enumerate(cands):
        for e, (rest, band, pose) in c.items():
            cls = 'rest' if rest else 'engine'
            key = f'{kind} {band} {cls}'
            agg[key]['asleep'] += 1
            wt = woke_after.get((k, e))
            if wt is not None:
                agg[key]['woke'] += 1
                if (e, wt) in moved: agg[key]['moved_1cm'] += 1
            elif band == '0-3m':
                missed.append({'impact': kind, 'impact_tick': impacts[k][1], 'entity': hex(e), 'class': cls,
                               'pose': [round(x, 2) for x in pose], 'target': [round(x, 2) for x in impacts[k][2]]})
    cyc['by_impact'] = {k: dict(v) for k, v in sorted(agg.items())}
    cyc['not_woken_within_3m'] = len(missed)
    cyc['not_woken_examples'] = missed[:12]
    for k, v in agg.items(): total[k].update(v)
    per_cycle.append(cyc)

out = {'cycles': per_cycle, 'total': {k: dict(v) for k, v in sorted(total.items())}}
if '--json' in sys.argv:
    print(json.dumps(out))
else:
    for c in per_cycle: print(json.dumps(c))
    print('TOTAL ' + json.dumps(out['total']))
