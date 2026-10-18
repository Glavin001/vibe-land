"""Analysis of the decoded tape tables (decode.ts, meteors.ts, dumpstats.ts output).

    python3 analyse.py <outdir> [server.log] [--meteors BODY@LAUNCH_S,...]

Reads frames.csv, snapshots.csv, packets.csv, chunks.csv, render_clock.csv,
meteor_frames.csv, match_stats.json, events.json, topology.json and
header.json from <outdir>. The server log (default <outdir>/server.log) is
optional: without it the log-derived sections are empty. Its timestamps must
be UTC ISO (ANSI colour codes are stripped). --meteors picks the
meteors to chart (default: the three with the most backward motion).

Writes summary.json, match_stats.csv, per_second.csv and SVG charts into <outdir>.
"""
import bisect
import collections
import csv
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from svgplot import Panel, render, scatter_chart  # noqa: E402

import datetime  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith('--meteors')]
METEOR_ARG = next((a.split('=', 1)[1] if '=' in a else sys.argv[sys.argv.index(a) + 1]
                   for a in sys.argv[1:] if a.startswith('--meteors')), None)
if METEOR_ARG and METEOR_ARG in ARGS:
    ARGS.remove(METEOR_ARG)
OUT = ARGS[0]
LOG_PATH = ARGS[1] if len(ARGS) > 1 else os.path.join(OUT, 'server.log')


def rd(name):
    return list(csv.DictReader(open(os.path.join(OUT, name))))


def pct(a, p):
    a = sorted(a)
    return a[min(len(a) - 1, max(0, int(p / 100 * len(a))))] if a else None


def corr(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((x - mb) ** 2 for x in b))
    return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / (sa * sb) if sa and sb else 0


def linfit(x, y):
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    k = sum((x[i] - mx) * (y[i] - my) for i in range(n)) / sum((v - mx) ** 2 for v in x)
    return k, my - k * mx


F = rd('frames.csv')
S = rd('snapshots.csv')
P = rd('packets.csv')
C = rd('chunks.csv')
R = rd('render_clock.csv')
M = rd('meteor_frames.csv')
MS = json.load(open(os.path.join(OUT, 'match_stats.json')))
EV = json.load(open(os.path.join(OUT, 'events.json')))
TOPO = json.load(open(os.path.join(OUT, 'topology.json')))
hdr = json.load(open(os.path.join(OUT, 'header.json')))
DUR = hdr['durationMs'] / 1000
summary = {}

ft = [float(r['t_ms']) / 1000 for r in F]
fms = [float(r['frame_ms']) for r in F]
fcpu = [float(r['cpu_ms']) for r in F]
fawake = [int(r['awake']) for r in F]
meteors = [e for e in EV if e['kind'] == 130]
repairs = [e for e in EV if e['kind'] == 129]

# ---------------- client frames
summary['client_frames'] = {
    'frames': len(F), 'avg_fps': round(len(F) / DUR, 1),
    'frame_ms_p50_p90_p99_max': [pct(fms, p) for p in (50, 90, 99, 100)],
    'cpu_ms_p50_p90_p99_max': [pct(fcpu, p) for p in (50, 90, 99, 100)],
    'share_over_16_7ms': round(sum(1 for x in fms if x > 16.7) / len(fms), 3),
    'share_over_33ms': round(sum(1 for x in fms if x > 33.3) / len(fms), 3),
    'hitches_over_100ms': [(round(ft[i], 2), fms[i], fcpu[i], fawake[i]) for i in range(len(F)) if fms[i] > 100],
    'cpu_bound_frames_over_50ms': [(round(ft[i], 2), fms[i], fcpu[i]) for i in range(len(F)) if fms[i] > 50 and fcpu[i] > 0.6 * fms[i]],
}

# ---------------- snapshots / server sim rate
st = [float(r['t_ms']) / 1000 for r in S]
stick = [int(r['tick']) for r in S]
gaps = [(st[i + 1] - st[i]) * 1000 for i in range(len(st) - 1)]
summary['snapshots'] = {
    'count': len(S), 'rate_hz': round(len(S) / (st[-1] - st[0]), 1),
    'tick_deltas': dict(collections.Counter(stick[i + 1] - stick[i] for i in range(len(stick) - 1))),
    'sim_seconds': round((stick[-1] - stick[0]) / 60, 1), 'wall_seconds': round(st[-1] - st[0], 1),
    'sim_speed': round((stick[-1] - stick[0]) / 60 / (st[-1] - st[0]), 3),
    'interarrival_ms_p50_p90_p99_max': [round(pct(gaps, p), 1) for p in (50, 90, 99, 100)],
    'gaps_over_100ms': sum(1 for g in gaps if g > 100), 'gaps_over_250ms': sum(1 for g in gaps if g > 250),
}
secs = list(range(int(DUR) + 1))
snap_per_s = collections.Counter(int(x) for x in st)
fps_per_s = collections.Counter(int(x) for x in ft)

# ---------------- match stats (server)
mt = [x['t'] / 1000 for x in MS]
msrow = []
for i, x in enumerate(MS):
    s = x['s']
    wall_per_tick = ((x['t'] - MS[i - 1]['t']) / (s['server_tick'] - MS[i - 1]['s']['server_tick'])) if i else None
    msrow.append(dict(
        t=x['t'] / 1000, tick=s['server_tick'], wall_ms_per_tick=wall_per_tick,
        total_avg=s['timings']['total_ms']['avg'], total_p95=s['timings']['total_ms']['p95'], total_max=s['timings']['total_ms']['max'],
        dynamics_avg=s['timings']['dynamics_ms']['avg'], city_avg=s['timings']['city_total_ms']['avg'],
        gpu_wait=s['physics_gpu_wait_ms'], last_step=s['physics_last_step_ms'],
        active=s['physics_active_dynamic_bodies'], awake=s['city']['awake_bodies'], chunk_bodies=s['city']['chunk_bodies'],
        broken=s['city']['broken_bonds'], sleeping=s['city']['sleeping_bodies'], repairs=s['city']['city_desync_repairs'],
        city_bytes_s=s['city']['bytes_per_sec'], outside=s['spans']['destruction/native_bodies_outside_world']['v'],
        escaped=s['spans']['destruction/native_escaped_bodies']['v'], vel_expl=s['spans']['destruction/native_velocity_explosions']['v'],
        gpu_warn=s['physics_gpu_warning_count'], contacts_hw=s['physics_gpu_rigid_contact_high_water']))
with open(os.path.join(OUT, 'match_stats.csv'), 'w') as f:
    w = csv.DictWriter(f, fieldnames=list(msrow[0].keys()))
    w.writeheader()
    w.writerows(msrow)
fitrows = [r for r in msrow[1:] if r['wall_ms_per_tick']]
k_act, c_act = linfit([r['active'] for r in fitrows], [r['total_avg'] for r in fitrows])
summary['server'] = {
    'tick_ms_avg_range': [round(min(r['total_avg'] for r in msrow), 1), round(max(r['total_avg'] for r in msrow), 1)],
    'tick_ms_max_max': round(max(r['total_max'] for r in msrow), 1),
    'dynamics_share_of_tick': round(sum(r['dynamics_avg'] for r in msrow) / sum(r['total_avg'] for r in msrow), 3),
    'city_ms_avg_max': round(max(r['city_avg'] for r in msrow), 2),
    'windows_over_budget': sum(1 for r in msrow if r['total_avg'] > 16.7), 'windows': len(msrow),
    'fit_tick_ms_vs_active_bodies': {'ms_per_body': round(k_act, 4), 'intercept_ms': round(c_act, 1),
                                     'r': round(corr([r['active'] for r in fitrows], [r['total_avg'] for r in fitrows]), 2)},
    'r_tick_ms_vs_broken_bonds': round(corr([r['broken'] for r in fitrows], [r['total_avg'] for r in fitrows]), 2),
    'r_tick_ms_vs_chunk_bodies': round(corr([r['chunk_bodies'] for r in fitrows], [r['total_avg'] for r in fitrows]), 2),
    'r_tick_ms_vs_awake': round(corr([r['awake'] for r in fitrows], [r['total_avg'] for r in fitrows]), 2),
    'gpu_warning_count_max': max(r['gpu_warn'] for r in msrow),
    'escaped_bodies_final': msrow[-1]['escaped'], 'velocity_explosions_final': msrow[-1]['vel_expl'],
    'desync_repairs_final': msrow[-1]['repairs'],
}

# ---------------- log: health lines -> ticks per wall second over the whole server run
log = re.sub(r'\x1b\[[0-9;]*m', '', open(LOG_PATH).read()).splitlines() if os.path.exists(LOG_PATH) else []
health = []
for line in log:
    m = re.match(r'(\S+)Z\s+INFO web_fps_server: match health .*server_tick=(\d+)', line)
    if m:
        hh, mm, ss = m.group(1).split('T')[1].split(':')
        health.append((int(hh) * 3600 + int(mm) * 60 + float(ss), int(m.group(2))))
# Tape start on the UTC wall clock = capturedAt - durationMs (seconds since midnight, like the log parse above).
_cap = datetime.datetime.fromisoformat(hdr['capturedAt'].replace('Z', '+00:00')) - datetime.timedelta(milliseconds=hdr['durationMs'])
h0 = _cap.hour * 3600 + _cap.minute * 60 + _cap.second + _cap.microsecond / 1e6
summary['server_log_health'] = [
    {'tape_s_from': round(health[i - 1][0] - h0, 1), 'tape_s_to': round(health[i][0] - h0, 1),
     'ticks_per_wall_s': round((health[i][1] - health[i - 1][1]) / (health[i][0] - health[i - 1][0]), 1)}
    for i in range(1, len(health))]
summary['escape_log_lines'] = [l.strip() for l in log if 'left the world' in l]

# ---------------- render clock (live client's recorded offset & delay)
rt = [float(r['t_ms']) / 1000 for r in R]
lead = [float(r['lead_ms']) for r in R]
rdus = [float(r['render_dyn_us']) for r in R]
steps = [(rt[i + 1], (rdus[i + 1] - rdus[i]) / 1000) for i in range(len(rdus) - 1)]
back = [(round(t, 2), round(s, 1)) for t, s in steps if s < 0]
summary['render_clock'] = {
    'dyn_interp_delay_ms': sorted(set(round(float(r['dyn_ms']), 2) for r in R)),
    'player_interp_delay_ms': sorted(set(round(float(r['interp_ms']), 2) for r in F)),
    'lead_ms_p50_p90_p99_max': [round(pct(lead, p), 1) for p in (50, 90, 99, 100)],
    'share_frames_extrapolating': round(sum(1 for x in lead if x > 0) / len(lead), 3),
    'share_frames_lead_over_100ms': round(sum(1 for x in lead if x > 100) / len(lead), 3),
    'share_frames_lead_over_250ms': round(sum(1 for x in lead if x > 250) / len(lead), 4),
    'backward_steps': len(back), 'backward_total_ms': round(sum(s for _, s in back), 1),
    'worst_backward_steps': sorted(back, key=lambda x: x[1])[:12],
}
per5 = []
for s in range(0, int(DUR) + 1, 5):
    idx = [i for i in range(len(rt)) if s <= rt[i] < s + 5]
    if len(idx) < 2:
        continue
    i0, i1 = idx[0], idx[-1]
    per5.append({'from_s': s, 'playout_rate': round((rdus[i1] - rdus[i0]) / 1000 / ((rt[i1] - rt[i0]) * 1000), 2),
                 'sim_rate': round(sum(snap_per_s[x] for x in range(s, s + 5)) / 5 / 60, 2)})
summary['render_clock']['per_5s'] = per5

# ---------------- meteors
by = collections.defaultdict(list)
for r in M:
    by[(int(r['body']), float(r['launch_t_ms']))].append(r)
met = []
for (body, lt), rs in sorted(by.items(), key=lambda kv: kv[0][1]):
    src = [r['source'] for r in rs]
    backs, jumps, handovers, gaps = [], [], [], []
    prev = prevd = None
    last_back = False
    for i, r in enumerate(rs):
        if r['source'] == 'hidden':
            prev = None
            continue
        p = [float(r['draw_x']), float(r['draw_y']), float(r['draw_z'])]
        tt = float(r['frame_t_ms']) / 1000
        if prev:
            d = [p[k] - prev[1][k] for k in range(3)]
            dist = math.sqrt(sum(x * x for x in d))
            stepped_back = False
            # The step right after a backward one is not judged (it is the
            # rock carrying on, or bouncing on; see report.py meteor_metrics).
            if prevd and dist > 0.05 and not last_back:
                pn = math.sqrt(sum(x * x for x in prevd))
                along = sum(d[k] * prevd[k] for k in range(3)) / pn if pn > 0.05 else 0
                if along < -0.3:
                    backs.append((round(tt, 2), round(-along, 1), r['source']))
                    stepped_back = True
            if r['source'] != rs[i - 1]['source'] and rs[i - 1]['source'] != 'hidden':
                handovers.append((rs[i - 1]['source'] + '>' + r['source'], round(dist, 1), round(tt, 2)))
                if rs[i - 1]['source'] == 'arc' and r['source'] == 'body':
                    # The discontinuity: the step less the body's own motion over
                    # it (city-bench report.py meteor_metrics); without the body
                    # columns, the body against the arc at the same render time.
                    if r.get('body_x') and rs[i - 1].get('body_x'):
                        bn = [float(r['body_' + c]) for c in 'xyz']
                        bp = [float(rs[i - 1]['body_' + c]) for c in 'xyz']
                        gaps.append(round(math.sqrt(sum((d[k] - (bn[k] - bp[k])) ** 2 for k in range(3))), 2))
                    elif r.get('arc_x'):
                        arc = [float(r['arc_x']), float(r['arc_y']), float(r['arc_z'])]
                        gaps.append(round(math.sqrt(sum((p[k] - arc[k]) ** 2 for k in range(3))), 2))
            if dist > 0.05:
                last_back = stepped_back
                prevd = d
        prev = (tt, p)
    seq = [src[0]] + [s for i, s in enumerate(src[1:], 1) if s != src[i - 1]]
    bl = [float(r['lead_ms']) for r in rs if r['source'] == 'body' and r['lead_ms']]
    met.append({'body': body, 'launch_t_s': round(lt / 1000, 2), 'frames': len(rs), 'sources': dict(collections.Counter(src)),
                'source_switches': len(seq) - 1, 'backward_frames': len(backs), 'backward_total_m': round(sum(b[1] for b in backs), 1),
                'max_backward_m': max([b[1] for b in backs], default=0),
                'backward_in_arc_frames': sum(1 for b in backs if b[2] == 'arc'),
                'arc_to_body_jump_m': gaps,
                'arc_to_body_frame_step_m': [h[1] for h in handovers if h[0] == 'arc>body'],
                'hold_to_body_jumps_m': [h[1] for h in handovers if h[0] == 'hold>body'],
                'body_lead_ms_p50': round(pct(bl, 50), 1) if bl else None})
summary['meteors'] = met
summary['meteor_totals'] = {
    'meteors': len(met), 'all_with_backward_frames': sum(1 for m in met if m['backward_frames'] > 0),
    'backward_frames': sum(m['backward_frames'] for m in met), 'backward_frames_while_on_arc': sum(m['backward_in_arc_frames'] for m in met),
    'arc_only_meteors': [m['launch_t_s'] for m in met if set(m['sources']) <= {'arc', 'hidden'}],
    'arc_to_body_jump_m_p50_max': [pct([j for m in met for j in m['arc_to_body_jump_m']], 50), max((j for m in met for j in m['arc_to_body_jump_m']), default=0)],
    'hold_to_body_jumps': sum(len(m['hold_to_body_jumps_m']) for m in met),
}

# ---------------- bandwidth per kind
kinds = {112: 'snapshot(dgram)', 119: 'city chunks(dgram)', 120: 'topology', 121: 'baseline', 124: 'match stats', 129: 'struct bootstrap', 115: 'energy', 128: 'topo hash'}
bw = {k: collections.Counter() for k in kinds}
pt = [float(r['t_ms']) / 1000 for r in P]
for r in P:
    k = int(r['kind'])
    if k in bw:
        bw[k][int(float(r['t_ms']) / 1000)] += int(r['len'])
summary['bandwidth'] = {kinds[k]: {'total_kB': round(sum(v.values()) / 1000, 1), 'peak_kB_s': round(max(v.values(), default=0) / 1000, 1)} for k, v in bw.items()}
allbw = collections.Counter()
for r in P:
    allbw[int(float(r['t_ms']) / 1000)] += int(r['len'])
summary['bandwidth']['all'] = {'avg_kbps': round(sum(allbw.values()) * 8 / 1000 / DUR, 0), 'peak_kbps': round(max(allbw.values()) * 8 / 1000, 0)}
bytick = collections.defaultdict(int)
for r in C:
    bytick[int(r['tick'])] += int(r['len'])
bs = list(bytick.values())
summary['city_stream'] = {
    'sends': len(bs), 'bytes_per_send_p50_p99_max': [pct(bs, 50), pct(bs, 99), max(bs)],
    'sends_at_ceiling_ge_10000B': sum(1 for b in bs if b >= 10000), 'ceiling_bytes': 10400,
    'datagram_seq_gaps': sum(1 for i in range(len(C) - 1) if int(C[i + 1]['seq']) != int(C[i]['seq']) + 1),
    'record_modes': {m: sum(int(r[m]) for r in C) for m in ('abs', 'delta', 'motion_abs', 'motion_delta', 'ballistic')},
    'topology_packets': len(TOPO), 'topology_seq_gaps': sum(1 for i in range(len(TOPO) - 1) if TOPO[i + 1]['topoSeq'] != TOPO[i]['topoSeq'] + 1),
    'structure_bootstraps': [(round(e['t'] / 1000, 2), e['structures'], e['len']) for e in repairs],
}

# ---------------- per-second correlation: client fps vs server sim rate
rows = [(s, fps_per_s[s], snap_per_s[s], max([fawake[i] for i in range(len(ft)) if int(ft[i]) == s] or [0])) for s in secs if fps_per_s[s]]
summary['client_vs_server'] = {
    'r_client_fps_vs_server_ticks_per_s': round(corr([r[1] for r in rows], [r[2] for r in rows]), 2),
    'r_client_fps_vs_client_awake_chunks': round(corr([r[1] for r in rows], [r[3] for r in rows]), 2),
    'r_client_fps_vs_cpu_ms': None,
}
with open(os.path.join(OUT, 'per_second.csv'), 'w') as f:
    f.write('s,client_fps,server_snapshots,client_awake\n' + '\n'.join(','.join(map(str, r)) for r in rows))

json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w'), indent=1)

# ================= charts
mv = [(e['t'] / 1000, f"m{e['bodyId']}") for e in meteors]


def mark(p, with_labels=False):
    for t, lab in mv:
        p.vline(t, '#f97316', lab if with_labels else None)
    for e in repairs:
        p.vline(e['t'] / 1000, '#7c3aed')
    return p


p1 = mark(Panel('Server simulation speed: snapshots (= server ticks) received per wall second', 'ticks / s', 0, 65), True)
p1.step([s for s in secs], [snap_per_s[s] for s in secs], 'server ticks/s (from snapshot arrivals)', '#2563eb').hline(60, '#16a34a', 'real time = 60')
p2 = mark(Panel('Client frames per second (live Chrome)', 'fps', 0, 125))
p2.step([s for s in secs], [fps_per_s[s] for s in secs], 'client fps', '#dc2626').hline(120, '#16a34a', '120 Hz display')
p3 = mark(Panel('Server tick cost per 60-tick window (match stats)', 'ms', 0, 160))
p3.step([r['t'] for r in msrow], [r['total_avg'] for r in msrow], 'tick avg', '#2563eb').step([r['t'] for r in msrow], [r['total_p95'] for r in msrow], 'tick p95', '#9333ea')
p3.step([r['t'] for r in msrow], [r['gpu_wait'] for r in msrow], 'PhysX GPU wait (last step)', '#ea580c').hline(16.7, '#16a34a', '16.7 ms budget')
p4 = mark(Panel('World load (server)', 'count', 0))
p4.step([r['t'] for r in msrow], [r['active'] for r in msrow], 'active dynamic bodies', '#2563eb').step([r['t'] for r in msrow], [r['chunk_bodies'] for r in msrow], 'chunk bodies', '#16a34a')
p4.step([r['t'] for r in msrow], [r['broken'] / 4 for r in msrow], 'broken bonds / 4', '#dc2626')
render([p1, p2, p3, p4], os.path.join(OUT, 'timeline.svg'), 'tape time (s)   [orange = meteor launch, purple = structure-bootstrap desync repair]', 0, DUR,
       title='Session timeline: server sim rate, client fps, server tick cost, world load')

# render clock chart
pc = mark(Panel('Dynamic-body render time minus newest snapshot time (live clock): >0 = extrapolating', 'ms', -50, 400))
pc.scatter(rt, lead, 'lead ms', '#2563eb', 1.0).hline(0, '#16a34a').hline(250, '#dc2626', '250 ms extrapolation cap')
pb = mark(Panel('Render clock steps backwards (each dot = one frame where the server render time went back)', 'ms', -700, 0))
pb.scatter([b[0] for b in back], [b[1] for b in back], 'backward step ms', '#dc2626', 2.0)
pr = mark(Panel('Playout rate vs server sim rate (5 s windows)', 'x real time', 0, 1.2))
pr.step([x['from_s'] for x in per5], [x['playout_rate'] for x in per5], 'client render-clock rate', '#2563eb').step([x['from_s'] for x in per5], [x['sim_rate'] for x in per5], 'server sim rate', '#dc2626')
render([pc, pb, pr], os.path.join(OUT, 'render_clock.svg'), 'tape time (s)', 0, DUR, title='Client server-clock: extrapolation lead and rewinds')

# frames chart
pf = Panel('Live client frame time and CPU time per frame', 'ms', 0, 130)
pf.scatter(ft, fms, 'frame ms (rAF delta)', '#2563eb', 1.0).scatter(ft, fcpu, 'CPU ms (rAF work)', '#dc2626', 1.0).hline(8.33, '#16a34a', '8.3 ms').hline(16.7, '#ca8a04', '16.7')
pa = Panel('Client awake chunks (2 Hz telemetry)', 'chunks', 0)
pa.step(ft, fawake, 'awake chunks', '#16a34a')
render([mark(pf), mark(pa)], os.path.join(OUT, 'frames.svg'), 'tape time (s)', 0, DUR, title='Client rendering')

# bandwidth chart
pbw = Panel('Inbound bytes per second by packet kind', 'kB/s', 0)
for i, (k, v) in enumerate(bw.items()):
    if sum(v.values()) > 5000:
        pbw.step(secs, [v[s] / 1000 for s in secs], kinds[k])
render([mark(pbw)], os.path.join(OUT, 'bandwidth.svg'), 'tape time (s)', 0, DUR, title='Network: inbound stream')

# scaling scatter
scatter_chart(os.path.join(OUT, 'scaling_tick_vs_bodies.svg'), 'Server tick ms (60-tick window avg) vs active dynamic bodies',
              [r['active'] for r in fitrows], [r['total_avg'] for r in fitrows], 'physics active dynamic bodies', 'tick ms (avg)', fit=(k_act, c_act))

# meteor examples: height of drawn / arc / raw over time
if METEOR_ARG:
    picks = [(int(b), float(t) * 1000) for b, t in (x.split('@') for x in METEOR_ARG.split(','))]
else:
    picks = [(m['body'], m['launch_t_s'] * 1000) for m in sorted(met, key=lambda m: -m['backward_total_m'])[:3]]
for body, lt in picks:
    rs = [r for r in M if int(r['body']) == body and abs(float(r['launch_t_ms']) - lt) < 50]
    if not rs:
        continue
    t = [float(r['frame_t_ms']) / 1000 for r in rs]
    tgt = [e for e in meteors if e['bodyId'] == body and abs(e['t'] - lt) < 50][0]
    tx, tz = tgt['target'][0], tgt['target'][2]
    hd = lambda r, p: math.hypot(float(r[p + '_x']) - tx, float(r[p + '_z']) - tz) if r[p + '_x'] else None
    pm = Panel(f'Meteor body {body} launched at {lt / 1000:.1f} s: height (m)', 'y (m)', -5)
    pm.line(t, [float(r['draw_y']) for r in rs], 'drawn', '#dc2626', 2).line(t, [float(r['arc_y']) for r in rs], 'arc at render time', '#2563eb', 1)
    pm.scatter(t, [float(r['raw_y']) if r['raw_y'] else None for r in rs], 'latest raw snapshot', '#16a34a', 1.4)
    pd = Panel('horizontal distance to aimed point (m)', 'm', 0)
    pd.line(t, [hd(r, 'draw') for r in rs], 'drawn', '#dc2626', 2).line(t, [hd(r, 'arc') for r in rs], 'arc', '#2563eb', 1).scatter(t, [hd(r, 'raw') for r in rs], 'raw', '#16a34a', 1.4)
    srcv = {'hidden': 0, 'arc': 1, 'body': 2, 'hold': 3}
    ps = Panel('source drawn (0 hidden, 1 arc, 2 body, 3 hold) and render lead/100 ms', '', 0, 4)
    ps.step(t, [srcv[r['source']] for r in rs], 'source', '#9333ea').line(t, [float(r['lead_ms']) / 100 if r['lead_ms'] else None for r in rs], 'lead/100 ms', '#ea580c')
    render([pm, pd, ps], os.path.join(OUT, f'meteor_{body}_{int(lt / 1000)}s.svg'), 'tape time (s)', title=f'Meteor {body} @ {lt / 1000:.1f}s: what the live client drew (reconstructed)')

print(json.dumps({k: summary[k] for k in ('client_frames', 'snapshots', 'server', 'render_clock', 'meteor_totals', 'city_stream', 'client_vs_server', 'bandwidth')}, indent=1)[:9000])
