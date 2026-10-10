#!/usr/bin/env python3
"""Passive system sampler for a hang-forensics run (scripts/ops/hang-forensics.sh).

    hang_sampler.py DIR PID [PERIOD_S]

Every PERIOD_S (0.5) appends one line to DIR/samples.tsv, flushed and fsynced
so it survives a logout: wall clock, CLOCK_UPTIME_RAW seconds (`uptime_s`, the
clock of CuMetal's trace and VIBE_HANG_TRACE), WindowServer's answer time to a
window-list request (scripts/ops/ws-probe), the GPU driver's own statistics
(utilisation, memory in use, recoveryCount = GPU resets), the watched process's
CPU and memory, the load average and the busiest processes.

When WindowServer takes over 1 s to answer (at most once every 10 s) it also
records what the app's threads are doing (`sample PID 1`) and the GPU's full
registry entry, into DIR/sample-<uptime>.txt and DIR/ioreg-<uptime>.txt.

Observes only: it stops nothing and changes nothing. Exits when PID exits
(after five more samples, to see whether the desktop recovers), or on SIGTERM.
"""
import os
import re
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROBE = os.path.join(ROOT, 'scripts', 'ops', 'ws-probe', 'ws_probe')
COLUMNS = ['epoch', 'uptime_s', 'ws_ms', 'gpu_device_pct', 'gpu_renderer_pct', 'gpu_tiler_pct',
           'gpu_inuse_mb', 'gpu_alloc_mb', 'gpu_recoveries', 'app_alive', 'app_cpu_pct', 'app_rss_mb',
           'load1', 'top_cpu']


def run(cmd, timeout):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None


def ws_probe():
    if not os.access(PROBE, os.X_OK):
        return 'noprobe'
    out = run([PROBE], 3)
    return 'timeout' if out is None or not out.strip() else out.strip()


def gpu():
    out = run(['ioreg', '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], 3) or ''
    m = re.search(r'"PerformanceStatistics" = \{([^}]*)\}', out)
    stats = dict(re.findall(r'"([^"]+)"=(\d+)', m.group(1))) if m else {}
    mb = lambda k: str(int(stats[k]) // (1 << 20)) if k in stats else '?'
    return [stats.get('Device Utilization %', '?'), stats.get('Renderer Utilization %', '?'),
            stats.get('Tiler Utilization %', '?'), mb('In use system memory'), mb('Alloc system memory'),
            stats.get('recoveryCount', '?')]


def app(pid):
    out = run(['ps', '-o', 'pcpu=,rss=', '-p', str(pid)], 2)
    if not out or not out.strip():
        return ['0', '', '']
    cpu, rss = out.split()[:2]
    return ['1', cpu, str(int(rss) // 1024)]


def top_cpu():
    out = run(['ps', '-Ao', 'pcpu=,comm='], 2) or ''
    rows = []
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            try:
                rows.append((float(parts[0]), os.path.basename(parts[1])[:24]))
            except ValueError:
                pass
    rows.sort(reverse=True)
    return ' '.join(f'{name}:{cpu:.0f}' for cpu, name in rows[:5])


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    directory, pid = sys.argv[1], int(sys.argv[2])
    period = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    path = os.path.join(directory, 'samples.tsv')
    new = not os.path.exists(path)
    out = open(path, 'a')
    if new:
        out.write('\t'.join(COLUMNS) + '\n')
    last_capture, after_exit = -1e9, 0
    while not stop:
        started = time.monotonic()
        ws = ws_probe()
        alive = app(pid)
        row = [f'{time.time():.3f}', f'{started:.6f}', ws] + gpu() + alive + \
              [f'{os.getloadavg()[0]:.2f}', top_cpu()]
        out.write('\t'.join(row) + '\n')
        out.flush()
        os.fsync(out.fileno())
        slow = ws in ('timeout',) or (ws.replace('.', '', 1).isdigit() and float(ws) > 1000)
        if slow and started - last_capture > 10 and alive[0] == '1':
            last_capture = started
            tag = f'{started:.3f}'
            # Backgrounded: the next samples keep coming while these run.
            subprocess.Popen(['sample', str(pid), '1', '-mayDie', '-file', os.path.join(directory, f'sample-{tag}.txt')],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with open(os.path.join(directory, f'ioreg-{tag}.txt'), 'w') as f:
                subprocess.Popen(['ioreg', '-r', '-c', 'IOAccelerator', '-l', '-w', '0'], stdout=f,
                                 stderr=subprocess.DEVNULL)
        if alive[0] == '0':
            after_exit += 1
            if after_exit > 5:
                break
        time.sleep(max(0.0, period - (time.monotonic() - started)))
    out.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
