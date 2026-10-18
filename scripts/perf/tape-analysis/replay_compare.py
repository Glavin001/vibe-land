"""Compare the live client's recorded frames with a server-less replay of the same tape.

    python3 replay_compare.py <outdir> <replay_perf.json> [label]
"""
import collections
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from svgplot import Panel, render  # noqa: E402

OUT, RP = sys.argv[1], sys.argv[2]
LABEL = sys.argv[3] if len(sys.argv) > 3 else 'replay'
rp = json.load(open(RP))
cols = rp['columns']
fr = [dict(zip(cols, f)) for f in rp['frames']]
F = list(csv.DictReader(open(os.path.join(OUT, 'frames.csv'))))
S = list(csv.DictReader(open(os.path.join(OUT, 'snapshots.csv'))))


def pct(a, p):
    a = sorted(a)
    return a[min(len(a) - 1, int(p / 100 * len(a)))] if a else None


def corr(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    sa = sum((x - ma) ** 2 for x in a) ** 0.5
    sb = sum((x - mb) ** 2 for x in b) ** 0.5
    return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / (sa * sb) if sa and sb else 0


dur = max(f['tape_ms'] for f in fr) / 1000
secs = list(range(int(dur) + 1))
# The replay's frames are bucketed by the TAPE time they drew (its clock follows the tape at 1x).
r_fps = collections.Counter()
r_cpu = collections.defaultdict(list)
r_raf = collections.defaultdict(list)
for f in fr[1:]:
    s = int(f['tape_ms'] / 1000)
    r_fps[s] += 1
    r_cpu[s].append(f['cpu_ms'])
    r_raf[s].append(f['raf_ms'])
l_fps = collections.Counter(int(float(r['t_ms']) / 1000) for r in F)
l_cpu = collections.defaultdict(list)
for r in F:
    l_cpu[int(float(r['t_ms']) / 1000)].append(float(r['cpu_ms']))
snap = collections.Counter(int(float(r['t_ms']) / 1000) for r in S)
rows = [s for s in secs if r_fps[s] and l_fps[s]]
raf = [f['raf_ms'] for f in fr[1:]]
cpu = [f['cpu_ms'] for f in fr[1:]]
res = {
    'label': LABEL, 'viewport': rp['viewport'], 'frames': len(fr),
    'replay_raf_ms_p50_p90_p99_max': [round(pct(raf, p), 1) for p in (50, 90, 99, 100)],
    'replay_cpu_ms_p50_p90_p99_max': [round(pct(cpu, p), 1) for p in (50, 90, 99, 100)],
    'replay_gpu_ms_p50_p90': [round(pct([f['gpu_ms'] for f in fr if f['gpu_ms']], p) or 0, 1) for p in (50, 90)],
    'replay_share_over_16_7ms': round(sum(1 for x in raf if x > 16.7) / len(raf), 3),
    'replay_avg_fps': round(len(fr) / dur, 1),
    'live_avg_fps': round(len(F) / dur, 1),
    'r_replay_fps_vs_server_ticks': round(corr([r_fps[s] for s in rows], [snap[s] for s in rows]), 2),
    'r_live_fps_vs_server_ticks': round(corr([l_fps[s] for s in rows], [snap[s] for s in rows]), 2),
    'r_replay_fps_vs_live_fps': round(corr([r_fps[s] for s in rows], [l_fps[s] for s in rows]), 2),
    'dpr_scales_seen': sorted(set(round(f['dpr_scale'], 2) for f in fr)),
    'per_5s': [{'from_s': s, 'live_fps': round(sum(l_fps[x] for x in range(s, s + 5)) / 5), 'replay_fps': round(sum(r_fps[x] for x in range(s, s + 5)) / 5),
                'server_ticks_s': round(sum(snap[x] for x in range(s, s + 5)) / 5),
                'live_cpu_p50': pct(sum((l_cpu[x] for x in range(s, s + 5)), []), 50), 'replay_cpu_p50': pct(sum((r_cpu[x] for x in range(s, s + 5)), []), 50)}
               for s in range(0, int(dur), 5)],
}
json.dump(res, open(os.path.join(OUT, f'replay_compare_{LABEL}.json'), 'w'), indent=1)
p1 = Panel('Frames per second: live (with server on the same GPU) vs server-less replay of the same tape', 'fps', 0, 125)
p1.step(secs, [l_fps[s] for s in secs], 'live client', '#dc2626').step(secs, [r_fps[s] for s in secs], f'replay ({LABEL})', '#2563eb').step(secs, [snap[s] * 2 for s in secs], 'server ticks/s x2', '#9ca3af')
p2 = Panel('CPU ms per frame (per-second median)', 'ms', 0)
p2.step(secs, [pct(l_cpu[s], 50) or 0 for s in secs], 'live cpu p50', '#dc2626').step(secs, [pct(r_cpu[s], 50) or 0 for s in secs], 'replay cpu p50', '#2563eb')
render([p1, p2], os.path.join(OUT, f'replay_vs_live_{LABEL}.svg'), 'tape time (s)', 0, dur, title='Is the client slow on its own? Live vs server-less replay')
print(json.dumps(res, indent=1))
