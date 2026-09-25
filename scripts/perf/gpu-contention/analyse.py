#!/usr/bin/env python3
"""Summarise a GPU-contention A/B run (ab.sh output). Standard library only.

    python3 scripts/perf/gpu-contention/analyse.py <out_dir> [<out_dir> ...]

Per arm: server tick cost over the meteor impact windows, split-tick excess,
GPU wait (GpuDestruction.finishAndReserve) per tick, sim rate; the other GPU
client's frame times over the same wall-clock window. Writes
<out_dir>/summary.json and prints one table row per arm plus per-kind means.

Definitions
- Contact: the first tick after each METEOR launch whose broken_bonds rises.
- Impact window: contact .. contact + WINDOW ticks (default 120 = 2 s of sim).
- Split tick: a tick whose engine zones include GpuDestruction.applyBindings
  (the corrected re-solve that installs new bodies).
- Split excess: split tick total minus the median of the non-split ticks within
  +-10 ticks.
- Sim rate: simulated time / wall time over the impact windows, from the
  bench's per-tick monotonic markers.
"""
import json
import os
import re
import statistics
import sys

WINDOW = int(os.environ.get('WINDOW', 120))
BUDGET = 1000 / 60


def pct(v, p):
    if not v:
        return None
    s = sorted(v)
    return s[min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))]


def zone(stage, name):
    m = re.search(re.escape(name) + r' ([0-9.]+) \((\d+)x\)', stage)
    return (float(m.group(1)), int(m.group(2))) if m else (0.0, 0)


def load_bench(d):
    ticks, begin, end, launches = {}, {}, {}, None
    with open(os.path.join(d, 'bench.log'), errors='replace') as f:
        for line in f:
            if line.startswith('TICK {"scenario":"meteor_pair"'):
                t = json.loads(line[5:])
                ticks[t['tick']] = t
            elif line.startswith('event=begin'):
                m = re.search(r'frame=(\d+) monotonic_ns=(\d+)', line)
                begin[int(m.group(1))] = int(m.group(2)) / 1e6
            elif line.startswith('event=end'):
                m = re.search(r'frame=(\d+) monotonic_ns=(\d+)', line)
                end[int(m.group(1))] = int(m.group(2)) / 1e6
            elif line.startswith('METEOR '):
                launches = json.loads(line[7:])
    return ticks, begin, end, launches


def server_summary(d):
    ticks, begin, end, launches = load_bench(d)
    if not ticks or not launches:
        return None
    order = sorted(ticks)
    contacts = []
    for launch in (launches['first_launch_tick'], launches['second_launch_tick']):
        base = ticks.get(launch, ticks[order[0]])['broken_bonds']
        c = next((k for k in order if k > launch and ticks[k]['broken_bonds'] > base), None)
        if c is not None:
            contacts.append(c)
    window = sorted({k for c in contacts for k in range(c, c + WINDOW) if k in ticks})
    split = {k for k in order if 'GpuDestruction.applyBindings' in ticks[k]['stage']}

    def stats(keys):
        tot = [ticks[k]['total'] for k in keys]
        fr = [zone(ticks[k]['stage'], 'GpuDestruction.finishAndReserve')[0] for k in keys]
        excess = []
        for k in keys:
            if k not in split:
                continue
            nb = [ticks[j]['total'] for j in range(k - 10, k + 11) if j in ticks and j not in split and j != k]
            if nb:
                excess.append(ticks[k]['total'] - statistics.median(nb))
        ordinary = [ticks[k]['total'] for k in keys if k not in split]
        ks = [k for k in keys if k in begin]
        # Wall time from the markers (includes the pacing sleep), over runs of consecutive ticks.
        wall, sim = 0.0, 0.0
        for a, b in zip(ks, ks[1:]):
            if b == a + 1:
                wall += begin[b] - begin[a]
                sim += BUDGET
        return {
            'ticks': len(keys),
            'p50': pct(tot, 50), 'p90': pct(tot, 90), 'p99': pct(tot, 99), 'max': max(tot),
            'over_50ms': sum(1 for v in tot if v > 50), 'over_100ms': sum(1 for v in tot if v > 100),
            'excess_ms': sum(max(0, v - BUDGET) for v in tot),
            'split_ticks': len(excess),
            'split_excess_p50': pct(excess, 50), 'split_excess_p90': pct(excess, 90),
            'ordinary_p50': pct(ordinary, 50), 'ordinary_p90': pct(ordinary, 90),
            'finish_reserve_p50': pct(fr, 50), 'finish_reserve_p90': pct(fr, 90), 'finish_reserve_max': max(fr),
            'finish_reserve_sum_ms': sum(fr), 'total_sum_ms': sum(tot),
            'finish_reserve_share': sum(fr) / sum(tot),
            'sim_rate': (sim / wall) if wall > 0 else None,
        }
    first = contacts[0] if contacts else order[0]
    return {
        'contacts': contacts,
        'impact': stats(window),
        'post': stats([k for k in order if k >= first]),
        'bonds_broken': ticks[order[-1]]['broken_bonds'],
        'bench_mono': (begin[min(begin)], end[max(end)]) if begin and end else None,
        'window_mono': [(begin.get(c), begin.get(c + WINDOW - 1)) for c in contacts],
        'post_mono': (begin.get(first), end[max(end)]) if end else None,
        'slow_ticks_mono': [(begin[k], end[k], ticks[k]['total']) for k in order if k in begin and k in end and ticks[k]['total'] > 50],
    }


def frame_stats(intervals):
    if not intervals:
        return None
    return {
        'frames': len(intervals),
        'fps': 1000 * len(intervals) / sum(intervals),
        'p50': pct(intervals, 50), 'p90': pct(intervals, 90), 'p99': pct(intervals, 99), 'max': max(intervals),
        'over_25ms': sum(1 for v in intervals if v > 25) / len(intervals),
        'over_50ms': sum(1 for v in intervals if v > 50) / len(intervals),
    }


def client_summary(d, srv):
    path = os.path.join(d, 'client.json')
    if not os.path.exists(path) or not srv or not srv['bench_mono']:
        return None
    c = json.load(open(path))
    cs = c['clockStart']
    # page perf -> unix ms (performance.timeOrigin) -> CLOCK_UPTIME_RAW via the pair in clock.txt
    mono0, unix0 = [float(x) for x in open(os.path.join(d, 'clock.txt')).readline().split()[1:3]]
    to_mono = lambda perf: perf - cs['pagePerfMs'] + cs['pageUnixMs'] - unix0 + mono0
    if c.get('cap'):
        stamps = [to_mono(t) for t in c['cap']['renderedAtMs']]
    else:
        stamps = [to_mono(f[0]) for f in c['frames']]
    gpu = [(to_mono(f[0]), f[3], f[4]) for f in c['frames']]
    out = {'viewport': c['viewport'], 'maxFps': c['maxFps'], 'uncapped': c['uncapped'], 'loops': c['loops'], 'info': c['info']}

    def between(lo, hi):
        s = [t for t in stamps if lo <= t <= hi]
        return [b - a for a, b in zip(s, s[1:])]
    b0, b1 = srv['bench_mono']
    out['bench'] = frame_stats(between(b0, b1))
    out['post'] = frame_stats(between(*srv['post_mono']))
    win = []
    for lo, hi in srv['window_mono']:
        if lo and hi:
            win += between(lo, hi)
    out['impact'] = frame_stats(win)
    # Frames that overlap a server tick over 50 ms.
    s = sorted(t for t in stamps if b0 <= t <= b1)
    long_frames = [(a, b) for a, b in zip(s, s[1:]) if b - a > 50]
    slow = srv['slow_ticks_mono']
    out['long_frames'] = len(long_frames)
    out['long_frames_overlapping_slow_tick'] = sum(1 for a, b in long_frames if any(ta < b and te > a for ta, te, _ in slow))
    g = [x[1] for x in gpu if b0 <= x[0] <= b1 and x[1] > 0]
    out['gpu_timer_p50'] = pct(g, 50)
    out['dpr_scale_min'] = min((x[2] for x in gpu if b0 <= x[0] <= b1), default=None)
    out['dpr_scale_end'] = gpu[-1][2] if gpu else None
    return out


def client_alone(d):
    path = os.path.join(d, 'client.json')
    if not os.path.exists(path):
        return None
    c = json.load(open(path))
    stamps = c['cap']['renderedAtMs'] if c.get('cap') else [f[0] for f in c['frames']]
    stamps = stamps[len(stamps) // 10:]  # skip the first tenth (settling after the seek)
    return frame_stats([b - a for a, b in zip(stamps, stamps[1:])])


def load_alone(d):
    path = os.path.join(d, 'load.csv')
    if not os.path.exists(path):
        return None
    rows = [[float(x) for x in l.split(',')] for l in open(path) if l[0].isdigit()]
    rows = rows[len(rows) // 10:]
    return {'frames': len(rows), 'gpu_ms_p50': pct([x[4] - x[3] for x in rows], 50),
            'latency_p50': pct([x[5] - x[1] for x in rows], 50), 'latency_max': max(x[5] - x[1] for x in rows),
            'fps': 1000 * (len(rows) - 1) / (rows[-1][3] - rows[0][3])}


def load_summary(d, srv):
    path = os.path.join(d, 'load.csv')
    if not os.path.exists(path) or not srv or not srv['bench_mono']:
        return None
    rows, header = [], ''
    for line in open(path):
        if line.startswith('#'):
            header = line.strip()
        elif line[0].isdigit():
            rows.append([float(x) for x in line.split(',')])
    b0, b1 = srv['bench_mono']
    # load.csv is on CACurrentMediaTime (mach_absolute_time), the bench markers' clock.
    r = [x for x in rows if b0 <= x[1] <= b1]
    gpu = [x[4] - x[3] for x in r]
    lat = [x[5] - x[1] for x in r]
    starts = sorted(x[3] for x in r)
    win = []
    for lo, hi in srv['window_mono']:
        if lo and hi:
            win += [x for x in r if lo <= x[1] <= hi]
    return {
        'header': header, 'frames': len(r),
        'gpu_ms_p50': pct(gpu, 50), 'gpu_ms_p99': pct(gpu, 99),
        'latency_p50': pct(lat, 50), 'latency_p99': pct(lat, 99), 'latency_max': max(lat) if lat else None,
        'impact_latency_p50': pct([x[5] - x[1] for x in win], 50), 'impact_latency_max': max((x[5] - x[1] for x in win), default=None),
        'fps': 1000 * (len(starts) - 1) / (starts[-1] - starts[0]) if len(starts) > 1 else None,
    }


def fmt(v, n=1):
    return '-' if v is None else (f'{v:.{n}f}' if isinstance(v, float) else str(v))


def srv_cols(x):
    return (f"{fmt(x['p50'])} {fmt(x['p90'])} {fmt(x['p99'])} {fmt(x['max'])} {x['over_50ms']:3d} {x['over_100ms']:3d} "
            f"{x['excess_ms']:6.0f} {x['split_ticks']:3d} {fmt(x['split_excess_p50'])} {fmt(x['ordinary_p50'])} {fmt(x['ordinary_p90'])} "
            f"{fmt(x['finish_reserve_p90'])} {x['finish_reserve_share']:.2f} {fmt(x['sim_rate'], 3)}")


def main():
    for out in sys.argv[1:]:
        arms = sorted((d for d in os.listdir(out) if os.path.isdir(os.path.join(out, d))), key=lambda a: os.path.getmtime(os.path.join(out, a)))
        summary = {}
        print(f'## {out}  (impact = contact..+{WINDOW} ticks of both meteors; post = first contact..end)')
        head = 'p50 p90 p99 max >50 >100 excess spl sx50 ord50 ord90 FR90 FRshare sim'
        print(f'arm        IMPACT[{head}] | POST[{head}] | client fps p50 p90 p99 >25 >50 long(ovl-slow-tick) dprmin | load lat50 latmax gpu50')
        for arm in arms:
            d = os.path.join(out, arm)
            if not os.path.exists(os.path.join(d, 'bench.log')):
                alone = client_alone(d)
                if alone:
                    summary[arm] = {'client_alone': alone}
                    print(f"{arm:10s} client alone: fps {alone['fps']:.1f} p50 {alone['p50']:.1f} p90 {alone['p90']:.1f} "
                          f"p99 {alone['p99']:.1f} >25 {alone['over_25ms']:.2f} >50 {alone['over_50ms']:.2f}")
                ld = load_alone(d)
                if ld:
                    summary[arm] = {'load_alone': ld}
                    print(f"{arm:10s} load alone: lat50 {fmt(ld['latency_p50'])} latmax {fmt(ld['latency_max'])} gpu50 {fmt(ld['gpu_ms_p50'])} fps {fmt(ld['fps'])}")
                continue
            srv = server_summary(d)
            if not srv:
                print(f'{arm:10s} (no meteor ticks)')
                continue
            cli = client_summary(d, srv)
            ld = load_summary(d, srv)
            summary[arm] = {'server': {k: v for k, v in srv.items() if k != 'slow_ticks_mono'}, 'client': cli, 'load': ld}
            line = f"{arm:10s} {srv_cols(srv['impact'])} | {srv_cols(srv['post'])}"
            if cli and cli['post']:
                b = cli['post']
                line += (f" | {b['fps']:5.1f} {b['p50']:5.1f} {b['p90']:5.1f} {b['p99']:5.1f} {b['over_25ms']:.2f} {b['over_50ms']:.2f} "
                         f"{cli['long_frames']}({cli['long_frames_overlapping_slow_tick']}) {fmt(cli['dpr_scale_min'], 2)}")
            if ld:
                line += f" | {fmt(ld['latency_p50'])} {fmt(ld['latency_max'])} {fmt(ld['gpu_ms_p50'])} fps {fmt(ld['fps'])}"
            print(line)
        json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=1)
        kinds = {}
        for arm, s in summary.items():
            if 'server' not in s:
                continue
            kinds.setdefault(arm.split('.')[0], []).append(s)
        print('kind     n | POST p50 p90 p99 max(mean/max) >50 >100 excess sx50 ord50 FRshare sim | IMPACT p99 max excess sim | client fps p90 p99 >50')
        for k, v in kinds.items():
            def m(sec, key):
                vals = [x['server'][sec][key] for x in v if x['server'][sec][key] is not None]
                return statistics.mean(vals) if vals else None
            cl = [x['client']['post'] for x in v if x['client'] and x['client']['post']]
            cm = lambda key: statistics.mean(c[key] for c in cl) if cl else None
            print(f"{k:8s} {len(v)} | {fmt(m('post','p50'))} {fmt(m('post','p90'))} {fmt(m('post','p99'))} "
                  f"{fmt(m('post','max'))}/{fmt(max(x['server']['post']['max'] for x in v))} {fmt(m('post','over_50ms'))} {fmt(m('post','over_100ms'))} "
                  f"{fmt(m('post','excess_ms'), 0)} {fmt(m('post','split_excess_p50'))} {fmt(m('post','ordinary_p50'))} {fmt(m('post','finish_reserve_share'), 2)} {fmt(m('post','sim_rate'), 3)} | "
                  f"{fmt(m('impact','p99'))} {fmt(m('impact','max'))} {fmt(m('impact','excess_ms'), 0)} {fmt(m('impact','sim_rate'), 3)} | "
                  f"{fmt(cm('fps'))} {fmt(cm('p90'))} {fmt(cm('p99'))} {fmt(cm('over_50ms'), 2)}")


if __name__ == '__main__':
    main()
