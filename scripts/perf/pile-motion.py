#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "matplotlib"]
# ///
"""Why does a settled rubble pile keep moving? Read a session's server encoder
tape (every awake body's pose and velocity each tick, every settle and wake
edge) and answer three questions:

  1. Is the motion dying out? Per-second awake count, speed percentiles and
     mean vertical velocity over the whole tape.
  2. Which way do the movers go? For bodies awake through the last window:
     net displacement split into down and sideways, against height.
  3. Is anything cycling? Bodies that settle and wake again, how often, how
     quickly after settling, and where they are.

usage: pile-motion.py <encoder.tape> [--out DIR] [--window S]
Writes DIR/motion.json, DIR/motion.png and DIR/movers.json (the top movers
with positions, to look at in /cityreplay)."""
import argparse, json, os, struct, subprocess, sys
from collections import defaultdict
import numpy as np

ROW = np.dtype([('id', '<u4'), ('p', '<f4', 3), ('q', '<f4', 4), ('v', '<f4', 3), ('w', '<f4', 3),
                ('nodes', '<u2'), ('flags', 'u1')])
assert ROW.itemsize == 59


def ticks(stream):
    read = stream.read

    def b(n):
        d = read(n)
        if len(d) < n:
            raise EOFError
        return d

    def u32():
        return struct.unpack('<I', b(4))[0]

    if b(8) != b'VLTAPE02':
        raise SystemExit('not a VLTAPE02 encoder tape')
    b(4 + 32 + 12 + 12 + 4)
    while True:
        try:
            tick = u32()
        except EOFError:
            return
        try:
            n = u32()
            rows = np.frombuffer(b(n * ROW.itemsize), dtype=ROW)
            for _ in range(u32()):  # destruction batches
                u32(); k = u32(); b(4 * k); m = u32(); b(12 * m)
                for _ in range(u32()):
                    b(8); c = u32(); b(4 * c); b(4 * 23)
                q = u32(); b(4 * q)
            s = u32(); settles = [struct.unpack('<II3f4f', b(36)) for _ in range(s)]
            w = u32(); wakes = [struct.unpack('<II', b(8)) for _ in range(w)]
        except EOFError:
            return
        yield tick, rows, settles, wakes


def ent(sid, isl):
    return 0x80000000 | (sid << 20) | isl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tape')
    ap.add_argument('--out', default=None)
    ap.add_argument('--window', type=float, default=30.0, help='seconds at the end for the per-body drift')
    a = ap.parse_args()
    out = a.out or os.path.dirname(os.path.abspath(a.tape))
    os.makedirs(out, exist_ok=True)
    proc = subprocess.Popen(['zstd', '-dcq', a.tape], stdout=subprocess.PIPE, bufsize=1 << 24)
    seconds = []                    # per-second summary
    cur = None
    settled_at = {}                 # entity -> tick of its last settle
    cycles = defaultdict(int)       # entity -> settle-then-wake count
    rewake_delay = []               # ticks from settle to the next wake
    samples = []                    # (tick, ids, positions) every 60 ticks, for the drift
    tape_ticks = []
    for tick, rows, settles, wakes in ticks(proc.stdout):
        tape_ticks.append(tick)
        sec = tick // 60
        if cur is None or cur['second'] != sec:
            if cur is not None:
                seconds.append(cur)
            cur = {'second': sec, 'tick': tick, 'speeds': [], 'vy': [], 'awake': 0,
                   'settles': 0, 'wakes': 0, 'rewakes_2s': 0, 'rewakes_10s': 0}
        if tick % 15 == 0 and len(rows):
            v = rows['v']
            cur['speeds'].append(np.linalg.norm(v, axis=1))
            cur['vy'].append(v[:, 1])
        cur['awake'] = max(cur['awake'], len(rows))
        for sid, isl, *_ in settles:
            e = ent(sid, isl)
            settled_at[e] = tick
            cur['settles'] += 1
        for sid, isl in wakes:
            e = ent(sid, isl)
            cur['wakes'] += 1
            if e in settled_at:
                d = tick - settled_at[e]
                rewake_delay.append(d)
                cycles[e] += 1
                cur['rewakes_2s'] += d <= 120
                cur['rewakes_10s'] += d <= 600
        # Every awake body's position every 60 ticks, for the drift.
        if tick % 60 == 0 and len(rows):
            samples.append((tick, rows['id'].copy(), rows['p'].copy()))
    if cur is not None:
        seconds.append(cur)
    proc.wait()
    if not tape_ticks:
        raise SystemExit('empty tape')

    series = []
    for s in seconds:
        sp = np.concatenate(s['speeds']) if s['speeds'] else np.zeros(0)
        vy = np.concatenate(s['vy']) if s['vy'] else np.zeros(0)
        q = (lambda x: float(np.percentile(sp, x)) * 1000 if len(sp) else 0.0)
        series.append({'t': (s['tick'] - tape_ticks[0]) / 60.0, 'awake': s['awake'],
                       'speed_p50_mm_s': q(50), 'speed_p90_mm_s': q(90), 'speed_p99_mm_s': q(99),
                       'mean_vy_mm_s': float(vy.mean() * 1000) if len(vy) else 0.0,
                       'settles': s['settles'], 'wakes': s['wakes'],
                       'rewakes_2s': s['rewakes_2s'], 'rewakes_10s': s['rewakes_10s']})

    # Drift: bodies awake at both ends of the final window, from the samples
    # that bracket it.
    drift = []
    if len(samples) >= 2:
        end_tick, end_ids, end_pos = samples[-1]
        start_tick = end_tick - int(a.window * 60)
        t0, ids0, pos0 = min(samples, key=lambda x: abs(x[0] - start_tick))
        dt = (end_tick - t0) / 60.0
        index = {int(e): i for i, e in enumerate(ids0)}
        for i, e in enumerate(end_ids):
            j = index.get(int(e))
            if j is None or dt <= 0:
                continue
            d = end_pos[i] - pos0[j]
            drift.append({'entity': int(e), 'height': float(end_pos[i][1]), 'pos': [float(x) for x in end_pos[i]],
                          'down_mm_s': float(-d[1] / dt * 1000), 'side_mm_s': float(np.hypot(d[0], d[2]) / dt * 1000),
                          'speed_mm_s': float(np.linalg.norm(d) / dt * 1000)})
    drift.sort(key=lambda x: -x['speed_mm_s'])
    if drift:
        down = np.array([x['down_mm_s'] for x in drift])
        side = np.array([x['side_mm_s'] for x in drift])
        net = np.array([x['speed_mm_s'] for x in drift])
        drift_summary = {
            'bodies': len(drift), 'seconds': dt,
            'net_mm_s_p50': float(np.percentile(net, 50)), 'net_mm_s_p90': float(np.percentile(net, 90)),
            'net_mm_s_p99': float(np.percentile(net, 99)),
            'down_mm_s_p50': float(np.percentile(down, 50)), 'down_mm_s_mean': float(down.mean()),
            'side_mm_s_p50': float(np.percentile(side, 50)),
            'share_mostly_down': float(np.mean(down > side)),
            'share_rising': float(np.mean(down < -1.0)),
            'share_net_below_1mm_s': float(np.mean(net < 1.0)),
        }
    else:
        drift_summary = {'bodies': 0}

    delays = np.array(rewake_delay) if rewake_delay else np.zeros(0)
    cycling = sorted(cycles.items(), key=lambda kv: -kv[1])
    report = {
        'tape_seconds': (tape_ticks[-1] - tape_ticks[0]) / 60.0,
        'series': series,
        'drift_window_s': a.window,
        'drift': drift_summary,
        'rewakes': {
            'total': int(len(delays)),
            'bodies_that_rewoke': len(cycles),
            'within_2s': int((delays <= 120).sum()), 'within_10s': int((delays <= 600).sum()),
            'delay_s_p50': float(np.percentile(delays, 50) / 60) if len(delays) else None,
            'most_cycles': [{'entity': e, 'cycles': c} for e, c in cycling[:20]],
        },
    }
    json.dump(report, open(os.path.join(out, 'motion.json'), 'w'), indent=1)
    json.dump(drift[:200], open(os.path.join(out, 'movers.json'), 'w'), indent=1)

    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    t = [s['t'] for s in series]
    fig, ax = plt.subplots(3, 1, figsize=(10, 9), sharex=True)
    for key, label in [('speed_p50_mm_s', 'p50'), ('speed_p90_mm_s', 'p90'), ('speed_p99_mm_s', 'p99')]:
        ax[0].plot(t, [s[key] for s in series], label=label)
    ax[0].set_yscale('log'); ax[0].set_ylabel('awake body speed, mm/s'); ax[0].legend(); ax[0].grid(alpha=0.3)
    ax[1].plot(t, [s['awake'] for s in series], color='k'); ax[1].set_ylabel('awake bodies'); ax[1].grid(alpha=0.3)
    ax2 = ax[1].twinx(); ax2.plot(t, [s['mean_vy_mm_s'] for s in series], color='tab:red', alpha=0.7)
    ax2.set_ylabel('mean vertical velocity, mm/s', color='tab:red')
    ax[2].plot(t, [s['settles'] for s in series], label='settles/s')
    ax[2].plot(t, [s['wakes'] for s in series], label='wakes/s')
    ax[2].plot(t, [s['rewakes_2s'] for s in series], label='re-wakes within 2 s')
    ax[2].set_ylabel('edges per second'); ax[2].set_xlabel('seconds into the tape'); ax[2].legend(); ax[2].grid(alpha=0.3)
    fig.tight_layout(); fig.savefig(os.path.join(out, 'motion.png'), dpi=110)
    print(json.dumps({k: report[k] for k in ('tape_seconds', 'drift', 'rewakes')}, indent=1))
    print('series (every 10 s):')
    for s in series[::10]:
        print(f"  t {s['t']:6.1f}s awake {s['awake']:6d} speed p50 {s['speed_p50_mm_s']:7.1f} p90 {s['speed_p90_mm_s']:7.1f} "
              f"p99 {s['speed_p99_mm_s']:8.1f} mm/s  vy {s['mean_vy_mm_s']:6.1f}  settles {s['settles']:4d} wakes {s['wakes']:4d} "
              f"rewakes<=2s {s['rewakes_2s']:4d}")


if __name__ == '__main__':
    main()
