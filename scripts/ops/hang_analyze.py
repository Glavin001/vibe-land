#!/usr/bin/env python3
"""Name what was stuck when the desktop hung, from a hang-forensics run.

    scripts/ops/hang_analyze.py DIR        (scripts/ops/hang-forensics.sh writes DIR)

Reads, all optional:
  app.log      CuMetal's CUMETAL_SUBMIT / CUMETAL_COMMIT lines (CUMETAL_TRACE_COMMITS=1):
               a command buffer submitted and never completed is the GPU work
               that hung; a COMMIT with status=5 is one the GPU gave up on
               (error 2 = timeout). Also traps and launch failures.
  trace.log    VIBE_HANG_TRACE breadcrumbs: `<s> physx simulate|simulated|fetch|
               fetched step=N world=W`, `<s> js submit|submitted|done frame=N`.
  samples.tsv  hang_sampler.py: WindowServer's answer time, GPU utilisation,
               the app's CPU and memory, the busiest processes, once every 0.5 s.
  reports/     DiagnosticReports collected after the run; unified.log, the
               macOS log for the run's window.

Every timestamp is CLOCK_UPTIME_RAW seconds (CuMetal's mach_absolute_time base;
samples.tsv carries it as `uptime_s`), so the sources line up. Writes
DIR/summary.txt and prints it.
"""
import os
import re
import sys

KV = re.compile(r'(\w+)=("[^"]*"|\S+)')


def fields(line):
    return {k: v.strip('"') for k, v in KV.findall(line)}


def read(path):
    try:
        with open(path, errors='replace') as f:
            return f.read().splitlines()
    except OSError:
        return []


def cumetal(lines):
    """seq -> submit fields, seq -> commit fields, and the other notable lines."""
    submits, commits, notable = {}, {}, []
    for line in lines:
        i = line.find('CUMETAL_SUBMIT ')
        if i >= 0:
            f = fields(line[i:])
            submits[int(f['seq'])] = f
            continue
        i = line.find('CUMETAL_COMMIT ')
        if i >= 0:
            f = fields(line[i:])
            commits[int(f['seq'])] = f
            continue
        if re.search(r'trap|launch failure|CUMETAL_DEBUG_ERRORS|kIOGPU|GPU Timeout|panicked|fatal|Assertion', line, re.I):
            notable.append(line)
    return submits, commits, notable


def kernel_names(text, limit=12):
    names = []
    for name in re.split(r'[,; ]+', text or ''):
        if name and name != '-' and name not in names:
            names.append(name)
    more = len(names) - limit
    return ', '.join(names[:limit]) + (f' (+{more} more)' if more > 0 else '')


def breadcrumbs(lines):
    out = []
    for line in lines:
        parts = line.split(' ', 2)
        if len(parts) < 3:
            continue
        try:
            out.append((float(parts[0]), parts[1], parts[2]))
        except ValueError:
            continue
    return out


def samples(lines):
    if not lines:
        return []
    header = lines[0].split('\t')
    rows = []
    for line in lines[1:]:
        values = line.split('\t')
        if len(values) == len(header):
            rows.append(dict(zip(header, values)))
    return rows


def ws_ms(row):
    value = row.get('ws_ms', '')
    if value == 'timeout':
        return float('inf')
    try:
        return float(value)
    except ValueError:
        return None


def analyze(directory):
    out = []
    say = out.append
    submits, commits, notable = cumetal(read(os.path.join(directory, 'app.log')))
    crumbs = breadcrumbs(read(os.path.join(directory, 'trace.log')))
    rows = samples(read(os.path.join(directory, 'samples.tsv')))
    meta = read(os.path.join(directory, 'meta.txt'))

    say(f'hang forensics: {directory}')
    for line in meta[:12]:
        say(f'  {line}')

    # When WindowServer stopped answering promptly: the onset.
    onset = None
    for row in rows:
        ms = ws_ms(row)
        if ms is not None and ms > 1000:
            onset = float(row['uptime_s'])
            say(f'\nWindowServer stall onset: uptime {onset:.3f} s ({row.get("ws_ms")} ms; '
                f'GPU device {row.get("gpu_device_pct", "?")}%, renderer {row.get("gpu_renderer_pct", "?")}%; '
                f'load {row.get("load1", "?")}; busiest: {row.get("top_cpu", "?")})')
            break
    if onset is None and rows:
        worst = max((ws_ms(r) or 0 for r in rows), default=0)
        say(f'\nWindowServer answered within 1 s throughout ({len(rows)} samples, worst {worst:.0f} ms)')
    if rows:
        say(f'last sample: uptime {float(rows[-1]["uptime_s"]):.3f} s, ws {rows[-1].get("ws_ms")} ms')

    # The GPU work that never completed.
    pending = sorted(seq for seq in submits if seq not in commits)
    last_seen = max([float(s['commit_s']) for s in submits.values()] +
                    [float(c.get('done_s', 0)) for c in commits.values()] +
                    [t for t, _, _ in crumbs] + [0.0])
    say(f'\nCuMetal: {len(submits)} command buffers submitted, {len(commits)} completed, '
        f'{len(pending)} never completed')
    for seq in pending[:8]:
        s = submits[seq]
        age = last_seen - float(s['commit_s'])
        say(f'  NEVER COMPLETED seq={seq} kind={s.get("kind")} stream={s.get("stream")} '
            f'dispatches={s.get("dispatches")} submitted at {float(s["commit_s"]):.3f} s '
            f'({age:.3f} s before the last trace line)')
        say(f'    kernels: {kernel_names(s.get("kernels"))}')
    if len(pending) > 8:
        say(f'  ... {len(pending) - 8} more')
    if onset is not None:
        inflight = [seq for seq, s in submits.items() if float(s['commit_s']) <= onset and
                    (seq not in commits or float(commits[seq].get('done_s', 0)) > onset)]
        say(f'  in flight at the stall onset: {len(inflight)} command buffers'
            + (f', oldest seq={min(inflight)} (submitted {onset - float(submits[min(inflight)]["commit_s"]):.3f} s before)'
               if inflight else ''))
    failed = [(seq, c) for seq, c in sorted(commits.items()) if c.get('status') not in (None, '4')]
    for seq, c in failed[:8]:
        say(f'  FAILED seq={seq} status={c.get("status")} error={c.get("error")} "{c.get("error_text")}" '
            f'kernels: {kernel_names(c.get("kernels"))}')
    longest = sorted(((float(c['gpu_end_s']) - float(c['gpu_start_s']), seq) for seq, c in commits.items()
                      if c.get('gpu_end_s') and c.get('gpu_start_s')), reverse=True)[:3]
    for ms, seq in longest:
        say(f'  longest on the GPU: seq={seq} {ms * 1e3:.2f} ms: {kernel_names(commits[seq].get("kernels"), 6)}')

    # The breadcrumbs: where each thread was last seen.
    physx = [c for c in crumbs if c[1] == 'physx']
    js = [c for c in crumbs if c[1] == 'js']
    if physx:
        t, _, text = physx[-1]
        stuck = text.split()[0] in ('simulate', 'fetch')
        say(f'\nPhysX: last phase "{text}" at {t:.3f} s' + (' -- never finished' if stuck else ''))
    if js:
        frames = {}
        for t, _, text in js:
            f = fields(text)
            if 'frame' in f:
                frames.setdefault(int(f['frame']), {})[text.split()[0]] = t
        if frames:
            submitted = max(frames)
            done = max((n for n, ev in frames.items() if 'done' in ev), default=0)
            say(f'render: frames submitted up to {submitted}, GPU-finished up to {done}'
                + (f' -- {submitted - done} submitted and never finished (oldest frame {done + 1} at '
                   f'{frames.get(done + 1, {}).get("submit", float("nan")):.3f} s)' if submitted > done else ''))
        say(f'  last js line: "{js[-1][2]}" at {js[-1][0]:.3f} s')

    if notable:
        say(f'\nnotable app.log lines ({len(notable)}):')
        for line in notable[:10]:
            say(f'  {line[:300]}')

    reports = os.path.join(directory, 'reports')
    if os.path.isdir(reports):
        names = sorted(os.listdir(reports))
        say(f'\ndiagnostic reports collected: {len(names)}')
        for name in names[:20]:
            say(f'  {name}')
    unified = read(os.path.join(directory, 'unified.log')) + read(os.path.join(directory, 'unified-stream.log'))
    gpu = [l for l in unified if re.search(r'GPU Restart|timeout|IOGPU|AGX|watchdog|hang', l, re.I)]
    if unified:
        say(f'\nmacOS log: {len(unified)} lines, {len(gpu)} about the GPU or watchdogs')
        for line in gpu[:15]:
            say(f'  {line[:300]}')

    say('\nverdict:')
    if pending and physx and physx[-1][2].startswith('fetch'):
        say('  PhysX was waiting for GPU work that never completed: the NEVER COMPLETED command buffer above '
            'names the kernels (physics).')
    elif pending:
        say('  CuMetal work never completed: see NEVER COMPLETED above.')
    elif js and frames and max(frames) > max((n for n, ev in frames.items() if 'done' in ev), default=0) + 2:
        say('  every CuMetal command buffer completed but render frames did not: the hang is on the rendering side.')
    elif onset is not None:
        say('  WindowServer stalled with all traced GPU work completing: contention, not a stuck kernel '
            '(compare GPU utilisation and the busiest processes at the onset).')
    else:
        say('  no hang in this run.')
    return '\n'.join(out) + '\n'


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    text = analyze(sys.argv[1])
    with open(os.path.join(sys.argv[1], 'summary.txt'), 'w') as f:
        f.write(text)
    print(text, end='')
    return 0


if __name__ == '__main__':
    sys.exit(main())
