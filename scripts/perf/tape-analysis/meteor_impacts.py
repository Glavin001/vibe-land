#!/usr/bin/env python3
"""Per-meteor impact analysis of a paired session capture (server + client tape).

CPU only. Reads:
  - the session bundle (debug-reports/session-<id>/): server/ticks.jsonl,
    server/city/stats.jsonl, server/city/events.jsonl, server/city/manifest.json,
    server/selections.jsonl, session.json
  - the tape tables written by decode.ts / meteors.ts / dumpstats.ts into <tape_out>
  - the server log (ANSI colour codes are stripped) for fracture and stream lines

Writes into <out>: impacts.csv, impact_ticks.csv (per-tick rows around each
impact), aligned.csv (event-aligned means), meteor_summary.json and SVG charts.

  python3 scripts/perf/tape-analysis/meteor_impacts.py \
      debug-reports/session-<id> target/meteor-analysis/tape <server.log> target/meteor-analysis/out

Standard library only (charts through svgplot.py).
"""
import collections
import csv
import json
import math
import os
import re
import statistics as st
import sys

sys.dont_write_bytecode = True  # keep the source tree free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import svgplot  # noqa: E402
import tick_phases  # noqa: E402

BUDGET_MS = 1000.0 / 60.0
ANSI = re.compile(r'\x1b\[[0-9;]*m')
KV = re.compile(r'(\w+)=([^ ]+)')


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def r1(x, n=1):
    return None if x is None else round(x, n)


def corr(a, b):
    if len(a) < 3:
        return None
    ma, mb = st.mean(a), st.mean(b)
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va == 0 or vb == 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(2)
    bundle, tape, log_path, out = sys.argv[1:5]
    os.makedirs(out, exist_ok=True)
    srv = os.path.join(bundle, 'server')

    # ---------------------------------------------------------------- server
    ticks = {}
    for line in open(os.path.join(srv, 'ticks.jsonl')):
        d = json.loads(line)
        ticks[d['tick']] = d
    tick_list = sorted(ticks)
    t0_unix = ticks[tick_list[0]]['unix_us']
    cstats = {}
    for line in open(os.path.join(srv, 'city', 'stats.jsonl')):
        d = json.loads(line)
        cstats[d['tick']] = d
    launches = [json.loads(line) for line in open(os.path.join(srv, 'city', 'events.jsonl'))]
    launches = [e for e in launches if e.get('kind') == 'meteor']
    manifest = json.load(open(os.path.join(srv, 'city', 'manifest.json')))
    boxes = {}
    for s in manifest['structures']:
        p = s['worldPosition']
        ch = s['chunks']
        lo = [min(p[i] + c['centroid'][i] - c['size'][i] / 2 for c in ch) for i in range(3)]
        hi = [max(p[i] + c['centroid'][i] + c['size'][i] / 2 for c in ch) for i in range(3)]
        boxes[s['structureId']] = (lo, hi, len(ch), len(s['bonds']))

    # selections: per tick, city stream for the player
    sel = collections.defaultdict(dict)
    for line in open(os.path.join(srv, 'selections.jsonl')):
        d = json.loads(line)
        sel[d['tick']][d.get('stream', '?')] = d

    # server log: fracture lines and per-second stream lines inside the capture
    fract = {}
    stream_lines = []
    t_first = tick_list[0]
    t_last = tick_list[-1]
    for raw in open(log_path, errors='replace'):
        line = ANSI.sub('', raw)
        if 'city stress fracture' in line:
            d = dict(KV.findall(line))
            t = int(d['tick'])
            if t_first - 400 <= t <= t_last:
                prev = fract.get(t)
                db = int(d['delta_broken'])
                fract[t] = (db + (prev[0] if prev else 0), int(d['awake_before']) if not prev else prev[1],
                            int(d['awake_after']), int(d['broken_bonds_after']))
        elif 'city stream' in line and 'chunk_bodies=' in line:
            stream_lines.append((line[:27], dict(KV.findall(line))))

    # ---------------------------------------------------------------- client tape
    def rows(name):
        with open(os.path.join(tape, name)) as f:
            return list(csv.DictReader(f))

    header = json.load(open(os.path.join(tape, 'header.json')))
    pairing = header.get('pairing') or {}
    samples = pairing.get('clockSamples') or []
    clock_origin = header.get('clockOriginMs', 0.0)
    # server unix us -> tape ms, from the pairing samples (midpoint of send/receive)
    pairs = [((s['sentPerfMs'] + s['receivedPerfMs']) / 2 - clock_origin, s['serverUnixUs']) for s in samples]
    offs = [tm - u / 1000.0 for tm, u in pairs]
    off_ms = st.median(offs) if offs else 0.0

    def unix_to_tape_s(u):
        return (u / 1000.0 + off_ms) / 1000.0

    frames = rows('frames.csv')
    fr_t = [float(r['t_ms']) / 1000 for r in frames]
    fr_ms = [float(r['frame_ms']) for r in frames]
    fr_cpu = [float(r['cpu_ms']) for r in frames]
    fr_awake = [int(r['awake']) for r in frames]
    # The frame's own GPU time (tapes since 2026-09-24); None where it has none.
    fr_gpu = [tick_phases.fnum_or_none(r.get('gpu_max_pass_ms')) for r in frames]
    snaps = rows('snapshots.csv')
    sn_t = [float(r['t_ms']) / 1000 for r in snaps]
    sn_tick = [int(r['tick']) for r in snaps]
    chunks = rows('chunks.csv')
    packets = rows('packets.csv')
    topo = json.load(open(os.path.join(tape, 'topology.json')))
    topo_by_tick = collections.defaultdict(collections.Counter)
    topo_structs = collections.defaultdict(set)
    for x in topo:
        for k in ('broken', 'promos', 'promoNodes', 'retired', 'migr', 'settled', 'wakes'):
            topo_by_tick[x['tick']][k] += x[k]
        for s in x.get('structures') or []:
            topo_structs[x['tick']].add(s)
    meteor_raw = rows('meteor_raw.csv')
    mraw = collections.defaultdict(list)
    for r in meteor_raw:
        mraw[int(r['body'])].append(r)

    # ---------------------------------------------------------------- impacts
    impacts = []
    for e in launches:
        body = e['body_id']
        lt = e['tick']
        planned = lt + round(e['flight_s'] * 60)
        # body ids are reused: stop at the next launch of the same id
        nxt = min([x['tick'] for x in launches if x['body_id'] == body and x['tick'] > lt], default=planned + 900)
        rs = sorted((r for r in mraw[body] if lt <= int(r['tick']) < min(nxt, planned + 900)),
                    key=lambda r: int(r['tick']))
        # first contact: the first tick whose velocity change is not gravity alone (> 1 m/s)
        hit = None
        for a, b in zip(rs, rs[1:]):
            if int(b['tick']) - int(a['tick']) != 1:
                continue
            dv = math.sqrt((float(b['vx']) - float(a['vx'])) ** 2 +
                           (float(b['vy']) - float(a['vy']) + 9.81 / 60) ** 2 +
                           (float(b['vz']) - float(a['vz'])) ** 2)
            if dv > 1.0:
                hit = b
                break

        def speed(r):
            return math.sqrt(float(r['vx']) ** 2 + float(r['vy']) ** 2 + float(r['vz']) ** 2)

        post = {}
        if hit is not None:
            it = int(hit['tick'])
            # the contact's fracture can land on the tick before the velocity change shows
            for back in (3, 2, 1):
                if (it - back) in fract and fract[it - back][0] > 0:
                    it -= back
                    break
            pos = [float(hit['x']), float(hit['y']), float(hit['z'])]
            how = 'first contact (dv > 1 m/s)'
            after = [r for r in rs if int(r['tick']) >= it]
            by_dt = {int(r['tick']) - it: r for r in after}
            post = dict(speed_in=r1(speed(hit), 1),
                        speed_after_5=r1(speed(by_dt[5]), 1) if 5 in by_dt else None,
                        speed_after_60=r1(speed(by_dt[60]), 1) if 60 in by_dt else None,
                        streamed_s_after_contact=r1((int(after[-1]['tick']) - it) / 60.0, 2),
                        travel_after_contact_m=r1(max(math.dist(pos, [float(r[k]) for k in 'xyz']) for r in after), 1))
        else:
            it = planned
            pos = e['target']
            how = 'planned (flight_s)'
        # structures touched by the fracture batches within the impact window
        touched = set()
        for t in range(it - 2, it + 8):
            touched |= topo_structs.get(t, set())
        inside = [sid for sid, (lo, hi, _, _) in boxes.items()
                  if all(lo[i] - 3 <= pos[i] <= hi[i] + 3 for i in range(3))]
        target_in = [sid for sid, (lo, hi, _, _) in boxes.items()
                     if all(lo[i] - 0.5 <= e['target'][i] <= hi[i] + 0.5 for i in range(3))]
        impacts.append(dict(body=body, launch_tick=lt, planned_tick=planned, impact_tick=it, how=how,
                            pos=[round(v, 1) for v in pos], target=[round(v, 1) for v in e['target']],
                            structures_fractured=sorted(touched), structure_at_point=sorted(inside),
                            target_structure=sorted(target_in), flight_s=e['flight_s'], **post))
    impacts.sort(key=lambda m: m['impact_tick'])
    after_capture = [m for m in impacts if m['impact_tick'] > tick_list[-1]]
    impacts = [m for m in impacts if m['impact_tick'] <= tick_list[-1]]

    # group impacts that land within 60 ticks of each other
    events = []
    for m in impacts:
        if events and m['impact_tick'] - events[-1][-1]['impact_tick'] <= 60:
            events[-1].append(m)
        else:
            events.append([m])

    def tick_unix(t):
        return ticks[t]['unix_us'] if t in ticks else None

    def awake(t):
        return ticks[t]['awake_city_bodies'] if t in ticks else None

    def broken_in(a, b):
        return sum(fract[t][0] for t in fract if a <= t <= b)

    def promos_in(a, b, k='promos'):
        return sum(topo_by_tick[t][k] for t in range(a, b + 1) if t in topo_by_tick)

    # A capture with per-tick phases says itself which ticks split and broke
    # (the stage's committed events); an older one is read off the tape's
    # topology and the log's fracture lines.
    def is_split(t):
        cls = tick_phases.tick_class(ticks[t]) if t in ticks else None
        if cls is not None:
            return cls == 'split'
        return topo_by_tick[t]['promos'] > 0

    def is_break(t):
        cls = tick_phases.tick_class(ticks[t]) if t in ticks else None
        if cls is not None:
            return cls in ('split', 'break')
        return (t in fract and fract[t][0] > 0) or topo_by_tick[t]['broken'] > 0

    def tick_at_unix(u):
        # last tick whose end is at or before u
        lo, hi = 0, len(tick_list) - 1
        if u < ticks[tick_list[0]]['unix_us']:
            return tick_list[0]
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if ticks[tick_list[mid]]['unix_us'] <= u:
                lo = mid
            else:
                hi = mid - 1
        return tick_list[lo]

    # recovery: first tick after impact from which the trailing 30-tick mean total_ms stays under
    # the budget for 60 consecutive ticks
    def recovery_tick(start, limit):
        run = 0
        for t in range(start, limit + 1):
            if t not in ticks:
                continue
            w = [ticks[u]['total_ms'] for u in range(t - 29, t + 1) if u in ticks]
            if st.mean(w) < BUDGET_MS:
                run += 1
                if run >= 60:
                    return t - 59
            else:
                run = 0
        return None

    next_start = {}
    for i, ev in enumerate(events):
        next_start[i] = events[i + 1][0]['impact_tick'] if i + 1 < len(events) else tick_list[-1] + 1

    per_tick_rows = []
    ev_rows = []
    for i, ev in enumerate(events):
        it = ev[0]['impact_tick']
        end = next_start[i] - 1
        pre = [ticks[t]['total_ms'] for t in range(it - 120, it - 20) if t in ticks]
        approach = [ticks[t]['total_ms'] for t in range(it - 10, it) if t in ticks]
        win = [t for t in range(it, end + 1) if t in ticks]
        rec = recovery_tick(it, end)
        rec_end = rec if rec is not None else end
        el = [t for t in win if t <= rec_end]
        u0 = tick_unix(it - 1) or tick_unix(it)
        wall_el = (ticks[el[-1]]['unix_us'] - u0) / 1e6 if el else 0
        sim_el = len(el) / 60.0

        def sim_rate(a_s, b_s):
            ua, ub = u0 + a_s * 1e6, u0 + b_s * 1e6
            ta, tb = tick_at_unix(ua), tick_at_unix(ub)
            if tb > end:
                return None
            return (tb - ta) / ((ub - ua) / 1e6 * 60.0)

        excess_split = sum(max(0, ticks[t]['total_ms'] - BUDGET_MS) for t in el if is_split(t))
        excess_break = sum(max(0, ticks[t]['total_ms'] - BUDGET_MS) for t in el if not is_split(t) and is_break(t))
        excess_other = sum(max(0, ticks[t]['total_ms'] - BUDGET_MS) for t in el if not is_split(t) and not is_break(t))
        split_ticks = [t for t in el if is_split(t)]
        other_ticks = [t for t in el if not is_split(t) and not is_break(t)]
        a_before = awake(it - 1)
        a_peak = max((awake(t) for t in win[:600]), default=None)
        row = dict(
            event=i + 1,
            impact_tick=it,
            t_s=r1((u0 - t0_unix) / 1e6, 2),
            tape_s=r1(unix_to_tape_s(u0), 2),
            meteors=len(ev),
            bodies=' '.join(str(m['body']) for m in ev),
            structures=' '.join(str(s) for s in sorted(set(sum((m['structures_fractured'] for m in ev), [])))),
            pos=' '.join('(%g,%g,%g)' % tuple(m['pos']) for m in ev),
            bonds_first_tick=broken_in(it, it + 1),
            bonds_1s=broken_in(it, it + 60),
            bonds_window=broken_in(it, end),
            max_bonds_one_tick=max((fract[t][0] for t in fract if it <= t <= end), default=0),
            fragments_1s=promos_in(it, it + 60),
            fragments_window=promos_in(it, end),
            migrated_nodes_1s=promos_in(it, it + 60, 'migr'),
            split_ticks_1s=sum(1 for t in range(it, it + 61) if is_split(t)),
            split_ticks_window=len([t for t in win if is_split(t)]),
            awake_before=a_before,
            awake_peak=a_peak,
            awake_at_5s=awake(tick_at_unix(u0 + 5e6)) if tick_at_unix(u0 + 5e6) <= end else None,
            pre_tick_ms_median=r1(st.median(pre)) if pre else None,
            approach_tick_ms_max=r1(max(approach)) if approach else None,
            peak_tick_ms=r1(max(ticks[t]['total_ms'] for t in win[:120])) if win else None,
            ticks_over_50ms=sum(1 for t in el if ticks[t]['total_ms'] > 50),
            ticks_over_100ms=sum(1 for t in el if ticks[t]['total_ms'] > 100),
            elevated_wall_s=r1(wall_el, 2),
            elevated_sim_s=r1(sim_el, 2),
            recovered=rec is not None,
            lost_sim_s=r1(wall_el - sim_el, 2),
            sim_rate_0_1s=r1(sim_rate(0, 1), 2),
            sim_rate_1_5s=r1(sim_rate(1, 5), 2),
            split_tick_ms_median=r1(st.median([ticks[t]['total_ms'] for t in split_ticks])) if split_ticks else None,
            other_tick_ms_median=r1(st.median([ticks[t]['total_ms'] for t in other_ticks])) if other_ticks else None,
            excess_split_s=r1(excess_split / 1000, 2),
            excess_break_only_s=r1(excess_break / 1000, 2),
            excess_other_s=r1(excess_other / 1000, 2),
        )
        ev_rows.append(row)
        for t in range(it - 30, min(end, it + 600) + 1):
            if t not in ticks:
                continue
            d = ticks[t]
            cs = cstats.get(t, {})
            tp = topo_by_tick.get(t, collections.Counter())
            row = dict(event=i + 1, tick=t, dt=t - it, wall_ms=r1((d['unix_us'] - u0) / 1000),
                       total_ms=r1(d['total_ms'], 2), dynamics_ms=r1(d['dynamics_ms'], 2),
                       city_ms=r1(d['city_ms'], 3), snapshot_ms=r1(d['snapshot_ms'], 3),
                       awake=d['awake_city_bodies'], broken=fract.get(t, (0,))[0],
                       promos=tp['promos'], promo_nodes=tp['promoNodes'], migr=tp['migr'],
                       encode_ms=r1(cs.get('encode_ms', 0), 3))
            # The step's phases (empty cells in a capture without them).
            row.update({k: v for k, v in tick_phases.flat(d).items()
                        if k not in ('tick', 'total_ms', 'dynamics_ms')})
            per_tick_rows.append(row)

    # ---------------------------------------------------------------- whole capture accounting
    wall = (ticks[tick_list[-1]]['unix_us'] - ticks[tick_list[0]]['unix_us']) / 1e6
    total_excess = sum(max(0, ticks[t]['total_ms'] - BUDGET_MS) for t in tick_list) / 1000
    split_excess = sum(max(0, ticks[t]['total_ms'] - BUDGET_MS) for t in tick_list if is_split(t)) / 1000
    break_excess = sum(max(0, ticks[t]['total_ms'] - BUDGET_MS) for t in tick_list
                       if not is_split(t) and is_break(t)) / 1000
    capture = dict(
        ticks=len(tick_list), wall_s=r1(wall, 2), sim_rate=r1(len(tick_list) / (wall * 60), 3),
        tick_ms_p50_p95_p99_max=[r1(pct([ticks[t]['total_ms'] for t in tick_list], p)) for p in (50, 95, 99, 100)],
        dynamics_share=r1(sum(ticks[t]['dynamics_ms'] for t in tick_list) / sum(ticks[t]['total_ms'] for t in tick_list), 3),
        city_ms_max=r1(max(ticks[t]['city_ms'] for t in tick_list), 2),
        snapshot_ms_max=r1(max(ticks[t]['snapshot_ms'] for t in tick_list), 2),
        excess_over_budget_s=r1(total_excess, 2),
        excess_on_split_ticks_s=r1(split_excess, 2),
        excess_on_break_only_ticks_s=r1(break_excess, 2),
        excess_other_s=r1(total_excess - split_excess - break_excess, 2),
        split_ticks=sum(1 for t in tick_list if is_split(t)),
        break_ticks=sum(1 for t in tick_list if is_break(t)),
        # Per-tick PhysX / destruction-stage phases by tick class (captures
        # from servers with timing_version 2; empty for older ones).
        phases=tick_phases.summary([ticks[t] for t in tick_list]),
    )

    # split-tick cost vs size: is it a fixed cost per split?
    def local_base(t):
        xs = [ticks[u]['total_ms'] for u in range(t - 6, t + 7)
              if u in ticks and u != t and not is_split(u) and not is_break(u)]
        return st.median(xs) if xs else None

    split_rows = []
    for t in tick_list:
        if is_split(t):
            b = local_base(t)
            if b is None:
                continue
            tp = topo_by_tick[t]
            split_rows.append((t, tp['promos'], tp['promoNodes'], tp['migr'], fract.get(t, (0,))[0],
                               ticks[t]['awake_city_bodies'], ticks[t]['total_ms'], b))
    ex = [r[6] - r[7] for r in split_rows]
    capture['split_tick_excess_ms_p10_p50_p90'] = [r1(pct(ex, p)) for p in (10, 50, 90)]
    capture['r_split_excess_vs_promos'] = r1(corr(ex, [r[1] for r in split_rows]), 2)
    capture['r_split_excess_vs_promo_nodes'] = r1(corr(ex, [r[2] for r in split_rows]), 2)
    capture['r_split_excess_vs_bonds'] = r1(corr(ex, [r[4] for r in split_rows]), 2)
    capture['r_split_excess_vs_awake'] = r1(corr(ex, [r[5] for r in split_rows]), 2)
    buckets = collections.OrderedDict()
    for lo, hi in ((1, 2), (2, 5), (5, 20), (20, 400)):
        xs = [r[6] - r[7] for r in split_rows if lo <= r[1] < hi]
        buckets['promos %d-%d' % (lo, hi - 1)] = dict(n=len(xs), excess_ms_p50=r1(pct(xs, 50)), excess_ms_p90=r1(pct(xs, 90)))
    capture['split_excess_by_promos'] = buckets
    # non-event ticks: awake vs cost
    other = [t for t in tick_list if not is_split(t) and not is_break(t)]
    capture['r_other_tick_ms_vs_awake'] = r1(corr([ticks[t]['total_ms'] for t in other],
                                                  [ticks[t]['awake_city_bodies'] for t in other]), 2)
    by_awake = collections.OrderedDict()
    for lo, hi in ((0, 1), (1, 150), (150, 300), (300, 500), (500, 800), (800, 2000)):
        xs = [ticks[t]['total_ms'] for t in other if lo <= ticks[t]['awake_city_bodies'] < hi]
        if xs:
            by_awake['%d-%d' % (lo, hi - 1)] = dict(n=len(xs), p50=r1(pct(xs, 50)), p90=r1(pct(xs, 90)))
    capture['other_tick_ms_by_awake'] = by_awake

    # event-aligned: other-tick cost vs seconds since impact (all events), and vs awake
    aligned = collections.defaultdict(list)
    for i, ev in enumerate(events):
        it = ev[0]['impact_tick']
        end = next_start[i] - 1
        for t in range(it, min(end, it + 900) + 1):
            if t in ticks and not is_split(t) and not is_break(t):
                aligned[(t - it) // 30].append(ticks[t]['total_ms'])
    aligned_rows = [dict(sim_s=r1(k * 0.5, 1), n=len(v), other_tick_ms_p50=r1(pct(v, 50)), other_tick_ms_p90=r1(pct(v, 90)))
                    for k, v in sorted(aligned.items())]

    # ---------------------------------------------------------------- client per event
    def frame_window(a, b):
        idx = [k for k, t in enumerate(fr_t) if a <= t < b]
        if not idx:
            return None
        ms = [fr_ms[k] for k in idx]
        cpu = [fr_cpu[k] for k in idx]
        long = [k for k in idx if fr_ms[k] > 50]
        return dict(frames=len(idx), fps=r1(len(idx) / (b - a)), frame_ms_p50=r1(pct(ms, 50)),
                    frame_ms_p95=r1(pct(ms, 95)), frame_ms_max=r1(max(ms)),
                    over_33=sum(1 for x in ms if x > 33.4), over_50=len(long), over_100=sum(1 for x in ms if x > 100),
                    cpu_ms_p95=r1(pct(cpu, 95)), cpu_ms_max=r1(max(cpu)),
                    cpu_bound_long=sum(1 for k in long if fr_cpu[k] > 0.6 * fr_ms[k]),
                    gpu_or_wait_long=sum(1 for k in long if fr_cpu[k] <= 0.6 * fr_ms[k]),
                    # With the frame's own GPU time on the tape: the long
                    # frames split into cpu / gpu / wait (unknown without it).
                    long_by_class=dict(collections.Counter(
                        tick_phases.frame_class(fr_ms[k], fr_cpu[k], fr_gpu[k]) for k in long)),
                    awake_max=max(fr_awake[k] for k in idx))

    def snap_window(a, b):
        idx = [k for k, t in enumerate(sn_t) if a <= t < b]
        if len(idx) < 2:
            return None
        gaps = [(sn_t[k] - sn_t[k - 1]) * 1000 for k in idx if k > 0]
        return dict(snapshots=len(idx), gap_ms_p95=r1(pct(gaps, 95)), gap_ms_max=r1(max(gaps)),
                    gaps_over_100=sum(1 for g in gaps if g > 100),
                    client_sim_rate=r1((sn_tick[idx[-1]] - sn_tick[idx[0]]) / ((sn_t[idx[-1]] - sn_t[idx[0]]) * 60), 2))

    def bytes_window(a, b):
        by = collections.Counter()
        n = collections.Counter()
        for p in packets:
            t = float(p['t_ms']) / 1000
            if a <= t < b:
                by[p['channel']] += int(p['len'])
                n[p['channel']] += 1
        dur = b - a
        return {ch: dict(kB_s=r1(by[ch] / 1000 / dur), pkts_s=r1(n[ch] / dur)) for ch in by}

    client_rows = []
    for row in ev_rows:
        ts = row['tape_s']
        c = dict(event=row['event'], tape_s=ts)
        for name, a, b in (('pre', ts - 3, ts), ('0_2s', ts, ts + 2), ('2_6s', ts + 2, ts + 6)):
            c['frames_' + name] = frame_window(a, b)
            c['snaps_' + name] = snap_window(a, b)
            c['net_' + name] = bytes_window(a, b)
        client_rows.append(c)

    # long client frames vs concurrent server ticks (same GPU): server tick cost overlapping each frame
    tick_tape = [(unix_to_tape_s(ticks[t]['unix_us']), ticks[t]['total_ms']) for t in tick_list]
    overlap = []
    j = 0
    for k in range(len(frames)):
        t_end = fr_t[k]
        t_start = t_end - fr_ms[k] / 1000
        while j < len(tick_tape) and tick_tape[j][0] < t_start:
            j += 1
        # max server tick that ended within the frame (+ the one that ended just after)
        mx = 0.0
        q = j
        while q < len(tick_tape) and tick_tape[q][0] <= t_end + 0.05:
            mx = max(mx, tick_tape[q][1])
            q += 1
        overlap.append(mx)
    in_cap = [k for k in range(len(frames)) if tick_tape[0][0] <= fr_t[k] <= tick_tape[-1][0]]
    long_f = [k for k in in_cap if fr_ms[k] > 50]
    client_summary = dict(
        frames_in_capture=len(in_cap),
        long_frames_over_50=len(long_f),
        long_frames_cpu_bound=sum(1 for k in long_f if fr_cpu[k] > 0.6 * fr_ms[k]),
        long_frames_by_class=dict(collections.Counter(
            tick_phases.frame_class(fr_ms[k], fr_cpu[k], fr_gpu[k]) for k in long_f)),
        long_frames_with_server_tick_over_50=sum(1 for k in long_f if overlap[k] > 50),
        r_frame_ms_vs_server_tick_ms=r1(corr([fr_ms[k] for k in in_cap], [overlap[k] for k in in_cap]), 2),
        frames_over_50_when_server_tick_under_20=sum(1 for k in in_cap if fr_ms[k] > 50 and overlap[k] < 20),
        cpu_bound_frames=[dict(tape_s=r1(fr_t[k], 2), frame_ms=fr_ms[k], cpu_ms=fr_cpu[k], awake=fr_awake[k])
                          for k in range(len(frames)) if fr_ms[k] > 50 and fr_cpu[k] > 0.6 * fr_ms[k]],
    )

    # ---------------------------------------------------------------- write
    with open(os.path.join(out, 'impacts.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        keys = ['body', 'launch_tick', 'planned_tick', 'impact_tick', 'how', 'pos', 'target', 'target_structure',
                'structure_at_point', 'structures_fractured', 'speed_in', 'speed_after_5', 'speed_after_60',
                'streamed_s_after_contact', 'travel_after_contact_m']
        w.writerow(keys)
        for m in impacts:
            w.writerow([m.get(k) if not isinstance(m.get(k), list) else ' '.join(map(str, m[k])) for k in keys])
    with open(os.path.join(out, 'events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(ev_rows[0].keys()))
        w.writeheader()
        w.writerows(ev_rows)
    with open(os.path.join(out, 'impact_ticks.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(per_tick_rows[0].keys()))
        w.writeheader()
        w.writerows(per_tick_rows)
    with open(os.path.join(out, 'aligned.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(aligned_rows[0].keys()))
        w.writeheader()
        w.writerows(aligned_rows)
    summary = dict(capture=capture, impacts=impacts, impacts_after_capture=after_capture, events=ev_rows, client=client_rows,
                   client_summary=client_summary, aligned=aligned_rows, tape_offset_ms=r1(off_ms, 1),
                   structures={k: dict(chunks=v[2], bonds=v[3], lo=v[0], hi=v[1]) for k, v in boxes.items()})
    json.dump(summary, open(os.path.join(out, 'meteor_summary.json'), 'w'), indent=1)

    # ---------------------------------------------------------------- charts
    xs = [(ticks[t]['unix_us'] - t0_unix) / 1e6 for t in tick_list]
    p1 = svgplot.Panel('Server tick cost (total_ms); red = ticks that split off new bodies', 'ms', ymin=0, height=230)
    p1.line(xs, [ticks[t]['total_ms'] for t in tick_list], 'tick ms', color='#4b5563', width=0.8)
    p1.scatter([xs[k] for k, t in enumerate(tick_list) if is_split(t)],
               [ticks[t]['total_ms'] for t in tick_list if is_split(t)], 'split tick', color='#dc2626', r=1.8)
    p1.hlines.append((BUDGET_MS, '#16a34a', '16.7 ms'))
    p2 = svgplot.Panel('Sim rate (ticks per wall second / 60), 1 s windows', 'x real time', ymin=0, ymax=1.1, height=150)
    sr_x, sr_y = [], []
    s = 0.0
    while s < wall:
        a = tick_at_unix(t0_unix + s * 1e6)
        b = tick_at_unix(t0_unix + (s + 1) * 1e6)
        sr_x.append(s + 0.5)
        sr_y.append((b - a) / 60.0)
        s += 1
    p2.line(sr_x, sr_y, 'sim rate', color='#2563eb')
    p3 = svgplot.Panel('Awake city bodies', 'bodies', ymin=0, height=150)
    p3.line(xs, [ticks[t]['awake_city_bodies'] for t in tick_list], 'awake', color='#9333ea')
    for row in ev_rows:
        for p in (p1, p2, p3):
            p.vlines.append((row['t_s'], '#ea580c', 'E%d' % row['event'] if p is p1 else ''))
    svgplot.render([p1, p2, p3], os.path.join(out, 'server_timeline.svg'), 'capture seconds (server wall clock)',
                   title='Meteor impacts: server tick cost, sim rate and awake bodies')
    svgplot.scatter_chart(os.path.join(out, 'split_excess_vs_promos.svg'),
                          'Split-tick excess over local baseline vs new bodies in that tick',
                          [r[1] for r in split_rows], [r[6] - r[7] for r in split_rows], 'new bodies (promos) in tick',
                          'excess ms')
    ax = [r['sim_s'] for r in aligned_rows]
    p4 = svgplot.Panel('Ticks without fracture, aligned on impact (all events)', 'tick ms', ymin=0, height=220)
    p4.line(ax, [r['other_tick_ms_p50'] for r in aligned_rows], 'p50', color='#2563eb')
    p4.line(ax, [r['other_tick_ms_p90'] for r in aligned_rows], 'p90', color='#dc2626')
    p4.hlines.append((BUDGET_MS, '#16a34a', '16.7 ms'))
    svgplot.render([p4], os.path.join(out, 'aligned_other_ticks.svg'), 'sim seconds after impact')

    # client frames against the server's ticks on the same (tape) clock
    pc1 = svgplot.Panel('Client frame time (grey) and its CPU part (blue)', 'ms', ymin=0, ymax=160, height=200)
    lo_t, hi_t = tick_tape[0][0], tick_tape[-1][0]
    ks = [k for k in range(len(frames)) if lo_t <= fr_t[k] <= hi_t]
    pc1.line([fr_t[k] for k in ks], [fr_ms[k] for k in ks], 'frame ms', color='#4b5563', width=0.8)
    pc1.line([fr_t[k] for k in ks], [fr_cpu[k] for k in ks], 'cpu ms', color='#2563eb', width=0.8)
    pc1.hlines.append((BUDGET_MS, '#16a34a', '16.7 ms'))
    pc2 = svgplot.Panel('Server tick cost on the same clock', 'ms', ymin=0, ymax=340, height=170)
    pc2.line([x for x, _ in tick_tape], [y for _, y in tick_tape], 'tick ms', color='#dc2626', width=0.8)
    for row in ev_rows:
        for p in (pc1, pc2):
            p.vlines.append((row['tape_s'], '#ea580c', 'E%d' % row['event'] if p is pc1 else ''))
    svgplot.render([pc1, pc2], os.path.join(out, 'client_frames_vs_server.svg'), 'tape seconds',
                   title='Client frames stretch when the server step does (same machine, same GPU)')

    print(json.dumps(capture, indent=1))
    for row in ev_rows:
        print(json.dumps(row))
    print(json.dumps(client_summary, indent=1)[:3000])


if __name__ == '__main__':
    main()
