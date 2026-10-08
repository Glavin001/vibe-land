#!/usr/bin/env python3
"""Read CuMetal's commit and sync traces per server tick. Reads only; the GPU is not used.

A log needs CUMETAL_TRACE_COMMITS=1 (and CUMETAL_TRACE_SYNC=1 for `syncs`), plus tick
boundaries. Two kinds of log work:
  - perf_bench with VIBE_PERF_MARKERS=1 VIBE_PERF_ALL_TICKS=1. Ticks are the step markers,
    and the TICK lines give each tick's total.
  - a perf-suite job log (target/perf-suite/runs/<run>/logs/*.log). Each tick is
    everything before its SUITE_TICK line.

  cumetal_trace.py cbs LOG [--min MS]        GPU ms per tick by command-buffer signature
  cumetal_trace.py kernels LOG [--min MS]    dispatches and GPU ms per kernel. Exact only with
                                             CUMETAL_BATCH_DISPATCHES=0 CUMETAL_COND_ICB=0, which
                                             cost about 20 us per dispatch; batched command buffers
                                             split their time evenly over their kernels.
  cumetal_trace.py gaps LOG [--min MS]       GPU idle inside the tick, split into the CPU being
                                             late (it committed after the GPU had finished) and
                                             commit-to-start latency
  cumetal_trace.py syncs LOG [--min MS]      host waits by reason, or by source line (SYNCSITE, below)
  cumetal_trace.py timeline LOG --tick N     one tick's command buffers and waits in order

--min picks the ticks whose total is at least MS (default 16.7). Use --max to pick the
ordinary ticks instead. The traces cost time: use them to attribute, never to time.

Tracing sync call sites (see README.md): wrap cudaEventSynchronize and
cudaStreamSynchronize in the PhysX file under study. Each wrapper prints
"SYNCSITE <line>" to stderr when an environment variable is set; `syncs` then names
the CUMETAL_SYNC that follows each SYNCSITE by that line. perf_suite strips PX_*,
VIBE_*, BLAST_* and CUMETAL_* variables from a job, so use perf_bench for this.
"""
import argparse
import collections
import json
import re
import statistics

KV = re.compile(r'(\w+)=(\S+)')


def kv(line):
    return dict(KV.findall(line))


def parse(path):
    """[(tick_record, commits, syncs)]. commit = dict(commit, start, end, done, kind, kernels,
    dispatches); sync = (site, reason, start_s, wait_ms)."""
    ticks, totals = [], {}
    commits, syncs, site, frame, suite = [], [], None, None, False
    for line in open(path, errors='replace'):
        if line.startswith('event=begin'):
            if frame is not None:
                ticks.append([frame, commits, syncs])
            frame, commits, syncs = int(kv(line)['frame']), [], []
        elif line.startswith('SUITE_PHASE'):
            commits, syncs = [], []
        elif line.startswith('SYNCSITE'):
            site = line.split()[1]
        elif line.startswith('CUMETAL_COMMIT'):
            d = kv(line)
            commits.append({'commit': float(d['commit_s']), 'start': float(d['gpu_start_s']),
                            'end': float(d['gpu_end_s']), 'done': float(d['done_s']), 'kind': d['kind'],
                            'kernels': d.get('kernels', '').split(','), 'dispatches': int(d['dispatches'])})
        elif line.startswith('CUMETAL_SYNC'):
            d = kv(line)
            syncs.append((site or d['reason'], d['reason'], float(d['start_s']), float(d['wait_us']) / 1e3))
            site = None
        elif line.startswith('SUITE_TICK'):
            suite = True
            t = json.loads(line.split(' ', 1)[1])
            ticks.append([dict(t['t'], phase=t['phase'], k=t['k']), commits, syncs])
            commits, syncs = [], []
        elif line.startswith('TICK '):
            t = json.loads(line[5:])
            totals[t['tick']] = t
    if not suite:
        if frame is not None:
            ticks.append([frame, commits, syncs])
        ticks = [[totals[f], c, s] for f, c, s in ticks if f in totals]
    return ticks


def select(ticks, args):
    out = [t for t in ticks if t[1] and (t[0]['total'] >= args.min if args.max is None else t[0]['total'] < args.max)]
    if not out:
        raise SystemExit('no ticks selected')
    return out


def header(sel):
    n = len(sel)
    busy = sum(sum(c['end'] - c['start'] for c in cs) for _, cs, _ in sel) * 1e3 / n
    disp = sum(sum(c['dispatches'] for c in cs) for _, cs, _ in sel) / n
    print(f"{n} ticks, total {statistics.mean(t['total'] for t, _, _ in sel):.1f} ms, GPU busy {busy:.1f} ms, "
          f"{sum(len(cs) for _, cs, _ in sel) / n:.0f} command buffers, {disp:.0f} dispatches, "
          f"{sum(len(s) for _, _, s in sel) / n:.1f} host waits per tick")
    return n


def cmd_cbs(sel, args):
    n = header(sel)
    ms, cnt, disp = collections.Counter(), collections.Counter(), collections.Counter()
    for _, cs, _ in sel:
        for c in cs:
            sig = c['kind'] + ':' + ','.join(dict.fromkeys(c['kernels']))[:120]
            ms[sig] += (c['end'] - c['start']) * 1e3
            cnt[sig] += 1
            disp[sig] += c['dispatches']
    print(' ms/tick  cbs/tick  dispatches/cb  signature')
    for sig, v in ms.most_common(args.top):
        print(f'{v / n:7.2f} {cnt[sig] / n:8.1f} {disp[sig] / cnt[sig]:10.0f}     {sig}')


def cmd_kernels(sel, args):
    n = header(sel)
    ms, cnt = collections.Counter(), collections.Counter()
    for _, cs, _ in sel:
        for c in cs:
            g = (c['end'] - c['start']) * 1e3
            for k in c['kernels']:
                ms[k] += g / len(c['kernels'])
                cnt[k] += 1
    key = cnt if args.by == 'count' else ms
    print(' dispatches/tick  ms/tick  kernel')
    for k, _ in key.most_common(args.top):
        print(f'{cnt[k] / n:12.1f} {ms[k] / n:9.3f}  {k}')


def cmd_gaps(sel, args):
    n = header(sel)
    idle = late = lat = 0.0
    sites = collections.Counter()
    for _, cs, _ in sel:
        cs = sorted(cs, key=lambda c: c['start'])
        end, last = cs[0]['end'], cs[0]['kernels'][-1]
        for c in cs[1:]:
            if c['start'] > end:
                idle += c['start'] - end
                if c['commit'] > end:
                    late += c['commit'] - end
                    lat += c['start'] - c['commit']
                else:
                    lat += c['start'] - end
                if (c['start'] - end) * 1e3 > 0.1:
                    sites[(last[:40], c['kernels'][0][:40])] += (c['start'] - end) * 1e3
            if c['end'] > end:
                end, last = c['end'], c['kernels'][-1]
    print(f'GPU idle inside the tick {idle * 1e3 / n:.1f} ms: CPU late {late * 1e3 / n:.1f}, '
          f'commit-to-start latency {lat * 1e3 / n:.1f}')
    print('largest gaps (>0.1 ms), ms/tick: after -> before')
    for (a, b), v in sites.most_common(args.top):
        print(f'{v / n:6.2f}  {a} -> {b}')


def cmd_syncs(sel, args):
    n = header(sel)
    cnt, wait, after = collections.Counter(), collections.Counter(), collections.Counter()
    for _, cs, ss in sel:
        commits = sorted(c['commit'] for c in cs)
        for site, _, start, w in ss:
            cnt[site] += 1
            wait[site] += w
            nxt = [c for c in commits if c > start + w / 1e3]
            if nxt:
                after[site] += (nxt[0] - start - w / 1e3) * 1e3
    print(' waits/tick  waiting ms  CPU ms before the next commit  site')
    for s, _ in wait.most_common(args.top):
        print(f'{cnt[s] / n:10.1f} {wait[s] / n:11.2f} {after[s] / n:12.2f}                  {s}')


def cmd_timeline(ticks, args):
    t, cs, ss = [x for x in ticks if x[0].get('tick', x[0].get('k')) == args.tick][0]
    print(f"tick {args.tick}: total {t['total']:.2f} ms")
    t0 = min(c['commit'] for c in cs)
    ev = [(c['start'], 'gpu  %.3f ms  %3d dispatches  %s' % ((c['end'] - c['start']) * 1e3, c['dispatches'],
                                                              ','.join(dict.fromkeys(c['kernels']))[:100])) for c in cs]
    ev += [(s[2], 'WAIT %.3f ms  %s' % (s[3], s[0])) for s in ss]
    for at, text in sorted(ev):
        print(f'{(at - t0) * 1e3:8.2f}  {text}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['cbs', 'kernels', 'gaps', 'syncs', 'timeline'])
    ap.add_argument('log')
    ap.add_argument('--min', type=float, default=16.7)
    ap.add_argument('--max', type=float, default=None)
    ap.add_argument('--top', type=int, default=30)
    ap.add_argument('--by', choices=['ms', 'count'], default='ms')
    ap.add_argument('--tick', type=int)
    args = ap.parse_args()
    ticks = parse(args.log)
    if args.command == 'timeline':
        return cmd_timeline(ticks, args)
    globals()['cmd_' + args.command](select(ticks, args), args)


if __name__ == '__main__':
    main()
