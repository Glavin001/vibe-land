#!/usr/bin/env python3
"""Summarise a rest-soak run (scripts/perf/rest-soak/run.sh): the server's tick
timeline, awake city bodies, stage errors, GPU warnings and the rest-sleep
counters over time, per 2-minute bucket and per idle window, plus the server
log's warnings and errors.
usage: analyse.py <run dir> [--json]"""
import sys, json, os, re, statistics
from collections import Counter

run = sys.argv[1]
soak = json.load(open(os.path.join(run, 'soak.json')))
lines = [json.loads(l) for l in open(os.path.join(run, 'stats.jsonl')) if l.strip()]
ok = [l for l in lines if 'error' not in l]
errs = [l for l in lines if 'error' in l]
T0 = soak.get('soakStartUnixMs') or ok[0]['unixMs']

def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))] if v else None

ticks = []  # (unixMs, t, total, dyn, city, awake)
for l in ok:
    for r in l.get('tick_ring', []):
        ticks.append((l['unixMs'], r['t'], r['total'], r['dyn_ms'], r['city'], r['awake']))
ticks.sort(key=lambda x: x[1])
gaps = [b[1] - a[1] - 1 for a, b in zip(ticks, ticks[1:]) if b[1] - a[1] > 1]

def summarise(sel):
    tot = [x[2] for x in sel]; aw = [x[5] for x in sel]; dy = [x[3] for x in sel]
    if not tot: return None
    return dict(n=len(tot), total_p50=round(pct(tot, 50), 2), total_p95=round(pct(tot, 95), 2), total_p99=round(pct(tot, 99), 2),
                total_max=round(max(tot), 1), over_16_7=round(sum(t > 16.7 for t in tot) / len(tot) * 100, 2),
                over_33=round(sum(t > 33.3 for t in tot) / len(tot) * 100, 2), dyn_p50=round(pct(dy, 50), 2),
                awake_mean=round(statistics.mean(aw), 1), awake_min=min(aw), awake_max=max(aw))

span_names = ['error_frames', 'error_bits_last', 'degraded', 'unconverged_frames', 'rest_slept_bodies', 'rest_slept_clusters',
              'rest_held_clusters', 'rest_rewakes', 'resettled_wakes', 'debris_parked', 'debris_settled', 'escaped_bodies',
              'bodies_outside_world', 'bodies_below_ground', 'bodies_retired_below_floor', 'velocity_explosions', 'frame']
def spans_of(l): return {k: l['spans'].get('native_' + k) for k in span_names}

out = {'run': os.path.basename(run.rstrip('/')), 'status': soak.get('status'), 'errors': soak.get('errors'),
       'soak_s': round(((soak.get('endedUnixMs') or ok[-1]['unixMs']) - T0) / 1000), 'stats_samples': len(ok),
       'stats_errors': len(errs), 'ticks_seen': len(ticks), 'tick_gaps': sum(gaps), 'first_tick': ticks[0][1] if ticks else None,
       'last_tick': ticks[-1][1] if ticks else None, 'resets': len(soak.get('resets', [])),
       'rewake_checks': len(soak.get('rewake', []))}
out['whole'] = summarise(ticks)
out['gpu_warning_count'] = [ok[0].get('physics_gpu_warning_count'), ok[-1].get('physics_gpu_warning_count')]
out['gpu_warning_first_rise_s'] = next((round((l['unixMs'] - T0) / 1000) for l in ok if (l.get('physics_gpu_warning_count') or 0) > (ok[0].get('physics_gpu_warning_count') or 0)), None)
out['spans_end'] = spans_of(ok[-1])
# The native counters restart at a city reset (the native frame drops): sum
# each counter's last value of every segment.
cum = Counter(); seg_last = {}; segments = 1; prev_frame = None
for l in ok:
    fr = l['spans'].get('native_frame')
    if prev_frame is not None and fr is not None and fr < prev_frame:
        for k, v in seg_last.items(): cum[k] += v or 0
        seg_last = {}; segments += 1
    prev_frame = fr if fr is not None else prev_frame
    seg_last = spans_of(l)
for k, v in seg_last.items(): cum[k] += v or 0
out['city_segments'] = segments
out['counters_total'] = {k: cum[k] for k in span_names if k not in ('error_bits_last', 'degraded', 'frame')}
# Stage error onset, and any sample with degraded / error bits.
out['error_frames_first_rise_s'] = next((round((l['unixMs'] - T0) / 1000) for l in ok if (l['spans'].get('native_error_frames') or 0) > 0), None)
out['error_bits_seen'] = sorted({int(l['spans'].get('native_error_bits_last') or 0) for l in ok})
out['degraded_seen'] = any(l['spans'].get('native_degraded') for l in ok)
out['city_degraded_seen'] = any(l['city'].get('degraded') for l in ok)
out['max_awake'] = max((l['city'].get('awake_bodies') or 0) for l in ok)
out['max_bodies'] = max((l['city'].get('chunk_bodies') or 0) for l in ok)
out['max_broken'] = max((l['city'].get('broken_bonds') or 0) for l in ok)

# 2-minute buckets.
buckets = []
for b in range(0, out['soak_s'] + 120, 120):
    lo, hi = T0 + b * 1000, T0 + (b + 120) * 1000
    sel = [x for x in ticks if lo <= x[0] < hi]
    sl = [l for l in ok if lo <= l['unixMs'] < hi]
    if not sel: continue
    s = summarise(sel)
    s['t_s'] = b
    s['broken_end'] = sl[-1]['city'].get('broken_bonds') if sl else None
    s['rest_slept_end'] = sl[-1]['spans'].get('native_rest_slept_bodies') if sl else None
    s['error_frames_end'] = sl[-1]['spans'].get('native_error_frames') if sl else None
    s['gpu_warn_end'] = sl[-1].get('physics_gpu_warning_count') if sl else None
    buckets.append(s)
out['buckets'] = buckets

# Idle windows: the last 20 s of every idle step (settled city, nobody touching it).
idle = []
for st in soak.get('steps', []):
    if st['name'].endswith(' idle') and 'intro' not in st['name'] or st['name'] == 'final idle':
        lo, hi = st['endUnixMs'] - 20000, st['endUnixMs']
        s = summarise([x for x in ticks if lo <= x[0] < hi])
        if s: idle.append({'step': st['name'], 't_s': round((lo - T0) / 1000), **s})
out['idle_windows'] = idle
# The last 10 s of each re-wake check's 28 s settle (a fresh pile, the rest of
# the city as it was left), and ticks by how many city bodies were awake.
settle = []
for chk in soak.get('rewake', []):
    m = {x['what']: x for x in chk['marks']}
    if 'before cannon' in m:
        hi = m['before cannon']['unixMs']
        s2 = summarise([x for x in ticks if hi - 10000 <= x[0] < hi])
        if s2: settle.append({'check': f"c{chk['cycle']} b{chk['building']}", **s2})
out['settle_windows'] = settle
bands = []
for lo, hi in ((0, 1), (1, 50), (50, 200), (200, 500), (500, 1 << 30)):
    s2 = summarise([x for x in ticks if lo <= x[5] < hi])
    if s2: bands.append({'awake': f'{lo}-{hi if hi < 1 << 29 else "inf"}', **s2})
out['by_awake'] = bands

# Server log.
log = open(os.path.join(run, 'server.log'), errors='replace').read().splitlines()
pat = re.compile(r'incomplete|FATAL|panic|error bits|refus|reject|degraded|ERROR|WARN', re.I)
hits = [l for l in log if pat.search(l)]
kinds = Counter(re.sub(r'\d+', 'N', re.sub(r'^\S+\s+', '', l))[:140] for l in hits)
out['log_lines'] = len(log)
out['log_hits'] = len(hits)
out['log_kinds'] = kinds.most_common(25)
if '--json' in sys.argv:
    print(json.dumps(out))
else:
    for k, v in out.items():
        if k in ('buckets', 'idle_windows', 'settle_windows', 'by_awake', 'log_kinds'):
            print(f'{k}:')
            for x in v: print('  ', json.dumps(x))
        else:
            print(f'{k}: {json.dumps(v)}')
