#!/usr/bin/env python3
"""Watch the machine's GPU work and say, within seconds, when time is being wasted.

    scripts/ops/gpu-watch.py            # event stream: one line per new problem or change
    scripts/ops/gpu-watch.py --once     # the board now: slots, queue, waiters, problems

Reads the admission state of scripts/perf/gpu-run.sh (VIBE_GPU_LOCK_DIR) and the
process table. An event is printed when a condition first appears (and again
when it clears), never repeated while it holds. The conditions:

- finished: a job that ran over a third of VIBE_WATCH_LONG_S ended (VIBE_WATCH_VERBOSE=1: every admission and end);
- QUEUED: a job has waited longer than VIBE_WATCH_QUEUE_S (default 60 s), with
  who holds the slots it waits for;
- IDLE: a slot is free while nothing is queued for longer than
  VIBE_WATCH_IDLE_S (default 300 s; reported once per idle spell);
- STALLED: a running job's processes used no CPU for VIBE_WATCH_STALL_S
  (default 600 s). GPU jobs use little CPU but never none for minutes;
- LONG: a job has run longer than VIBE_WATCH_LONG_S (default 900 s; owner: no 1-2 h runs);
- STALE SDK: a running job's SDK (PHYSX_ROOT, from its lock info or command)
  was built from a revision missing the head of a PhysX branch in
  scripts/fidelity/branches.tsv; its result will be refused as stale;
- WAITER bugs: a shell loop polling with `pgrep -f` (it matches itself), one
  whose `kill -0 PID` target is gone, two loops polling the same target, or one
  older than VIBE_WATCH_WAITER_S (default 7200 s).

Diagnostics only: it never kills or changes anything.
"""
import json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIR = os.environ.get("VIBE_GPU_LOCK_DIR", os.path.expanduser("~/Library/Caches/vibe-land-gpu"))
PHYSX_SOURCE = os.environ.get("PHYSX_SOURCE", "/Users/glavin/Development/PhysX")
ENV = lambda k, d: float(os.environ.get(k, d))
QUEUE_S, IDLE_S, STALL_S = ENV("VIBE_WATCH_QUEUE_S", 60), ENV("VIBE_WATCH_IDLE_S", 300), ENV("VIBE_WATCH_STALL_S", 600)
LONG_S, WAITER_S, POLL = ENV("VIBE_WATCH_LONG_S", 900), ENV("VIBE_WATCH_WAITER_S", 7200), ENV("VIBE_WATCH_POLL_S", 10)
SLOTS = int(os.environ.get("VIBE_GPU_SLOTS", "3"))
VERBOSE = os.environ.get("VIBE_WATCH_VERBOSE") == "1"  # also every admission and short job's end


def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return ""


def etime_s(e):  # ps etime: [[dd-]hh:]mm:ss
    days, _, rest = e.strip().rpartition("-")
    parts = [int(x) for x in rest.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return (int(days) if days else 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def cputime_s(t):  # ps time: [[dd-]hh:]mm:ss.cc
    days, _, rest = t.strip().rpartition("-")
    parts = [float(x) for x in rest.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    return (int(days) if days else 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def processes():
    procs = {}
    for line in sh("ps", "-Ao", "pid=,ppid=,etime=,time=,command=").splitlines():
        f = line.split(None, 4)
        if len(f) < 5:
            continue
        try:
            procs[int(f[0])] = dict(ppid=int(f[1]), age=etime_s(f[2]), cpu=cputime_s(f[3]), cmd=f[4])
        except ValueError:
            continue
    return procs


def tree_cpu(procs, root):
    kids = {}
    for pid, p in procs.items():
        kids.setdefault(p["ppid"], []).append(pid)
    total, stack = 0.0, [root]
    while stack:
        pid = stack.pop()
        if pid in procs:
            total += procs[pid]["cpu"]
            stack += kids.get(pid, [])
    return total


def lock_entries():
    out = []
    if not os.path.isdir(DIR):
        return out
    for name in sorted(os.listdir(DIR)):
        if not (name.startswith("slot-") or name == "exclusive"):
            continue
        path = os.path.join(DIR, name)
        try:
            owner = open(os.path.join(path, "owner")).read().split()
        except OSError:
            continue
        info = {}
        try:
            for line in open(os.path.join(path, "info")):
                k, _, v = line.rstrip("\n").partition("=")
                info[k] = v
        except OSError:
            pass
        out.append(dict(slot=name, pid=int(owner[0]), label=owner[1] if len(owner) > 1 else "?", info=info))
    return out


def queue_entries():
    out, qdir = [], os.path.join(DIR, "queue")
    if not os.path.isdir(qdir):
        return out
    for name in os.listdir(qdir):
        try:
            f = open(os.path.join(qdir, name)).read().split()
            out.append(dict(pid=int(f[0]), label=f[1], since=float(f[2]), kind=f[3]))
        except (OSError, ValueError, IndexError):
            continue
    return out


_rev_cache = {}


def sdk_missing(job, procs):
    """PhysX branches whose head the job's SDK lacks ([] if fresh or unknown)."""
    root = job["info"].get("physx_root") or ""
    cmd = job["info"].get("cmd", "") + " " + " ".join(procs[c]["cmd"] for c in procs if procs[c]["ppid"] == job["pid"])
    m = re.search(r"PHYSX_ROOT=(\S+)", cmd)
    root = root or (m.group(1) if m else "")
    if not root:
        m = re.search(r"target/verify-server-([\w.-]+)/", cmd)  # the bridge's per-SDK target dir
        if m:
            for base in (f"{PHYSX_SOURCE}/.claude/worktrees/hifi/out/install", f"{PHYSX_SOURCE}/out/install"):
                if os.path.isdir(f"{base}/{m.group(1)}"):
                    root = f"{base}/{m.group(1)}"
                    break
    try:
        rev = json.load(open(os.path.join(root, "sdk-artifacts.json"))).get("source_revision", "")
    except Exception:
        return None
    missing = []
    try:
        rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(ROOT, "scripts/fidelity/branches.tsv"))]
    except OSError:
        return None
    for row in rows:
        if len(row) < 2 or row[0] != "physx":
            continue
        ok = False
        for b in row[1].split("|"):
            head = sh("git", "-C", PHYSX_SOURCE, "rev-parse", "--verify", "-q", b + "^{commit}").strip()
            if not head:
                continue
            key = (head, rev)
            if key not in _rev_cache:
                _rev_cache[key] = subprocess.run(["git", "-C", PHYSX_SOURCE, "merge-base", "--is-ancestor", head, rev],
                                                 capture_output=True).returncode == 0
            ok = ok or _rev_cache[key]
        if not ok:
            missing.append(row[1])
    return missing


def waiters(procs):
    """Shell loops that poll: their target and any problem with them."""
    out = []
    for pid, p in procs.items():
        if not p["cmd"].startswith(("/bin/zsh -c", "/bin/bash -c", "bash -c", "zsh -c", "/bin/sh -c")):
            continue
        cmd = p["cmd"]
        body = cmd.split("&& eval ", 1)[-1]
        if not re.search(r"\b(until|while)\b", body) or "sleep" not in body:
            continue
        if "gpu-watch.py" in body:
            continue
        m = re.search(r"kill -0 \$?(\w+)", body)
        target, problem = None, None
        if "pgrep -f" in body:
            g = re.search(r"pgrep -f\s+(\"[^\"]*\"|'[^']*'|\S+)", body)
            target = g.group(1) if g else "pgrep"
            problem = "polls with `pgrep -f`, which matches the loop itself"
        elif m and m.group(1).isdigit():
            target = m.group(1)
            if int(target) not in procs:
                problem = f"its target pid {target} has exited"
        else:
            g = re.search(r"grep[^;]*?(/\S+\.(?:log|out|output|json))", body)
            target = g.group(1) if g else None  # unknown target: never counted as a duplicate
            if g and os.path.exists(g.group(1)) and time.time() - os.path.getmtime(g.group(1)) > 1800:
                problem = f"the file it polls ({os.path.basename(g.group(1))}) has not changed for {int((time.time() - os.path.getmtime(g.group(1))) / 60)} min"
        if problem is None and p["age"] > WAITER_S:
            problem = f"has polled for {p['age'] // 3600} h"
        out.append(dict(pid=pid, age=p["age"], target=target if target is None else str(target), problem=problem))
    seen = {}
    for w in out:
        if w["target"] not in (None, "None"):
            seen.setdefault(w["target"], []).append(w)
    for target, ws in seen.items():
        if len(ws) > 1:
            for w in sorted(ws, key=lambda w: -w["age"])[:-1]:
                w["problem"] = w["problem"] or f"duplicate: {len(ws)} loops poll {target[:60]}"
    return out


def board(procs):
    now = time.time()
    jobs, queue = lock_entries(), queue_entries()
    lines = [f"GPU slots {sum(1 for j in jobs if j['slot'] != 'exclusive')}/{SLOTS} busy"
             + (", EXCLUSIVE held" if any(j["slot"] == "exclusive" for j in jobs) else "")]
    for j in jobs:
        p = procs.get(j["pid"])
        age = f"{p['age'] // 60} min" if p else "owner gone"
        miss = sdk_missing(j, procs) if p else None
        lines.append(f"  {j['slot']}: {j['label']} (pid {j['pid']}, {age}, cpu {tree_cpu(procs, j['pid']):.0f} s)"
                     + (f"  STALE SDK: lacks {', '.join(miss)}" if miss else ""))
    for q in queue:
        lines.append(f"  queued: {q['label']} ({q['kind']}, pid {q['pid']}, {int(now - q['since'])} s)")
    for w in waiters(procs):
        lines.append(f"  waiter {w['pid']} ({w['age'] // 60} min) on {str(w['target'])[:70]}" + (f"  PROBLEM: {w['problem']}" if w["problem"] else ""))
    return "\n".join(lines)


def stream():
    active, last_cpu, idle_since = {}, {}, None
    started = {}
    def emit(key, text):
        if active.get(key) != text:
            active[key] = text
            print(time.strftime("%H:%M:%S ") + text, flush=True)
    while True:
        procs, now = processes(), time.time()
        jobs, queue = lock_entries(), queue_entries()
        live = set()
        for j in jobs:
            if j["pid"] not in procs:
                continue
            key = f"job:{j['pid']}"
            live.add(key)
            if key not in started:
                started[key] = (j["label"], now - procs[j["pid"]]["age"])
                if VERBOSE:
                    emit(key, f"admitted {j['label']} to {j['slot']} (pid {j['pid']})")
            cpu = tree_cpu(procs, j["pid"])
            prev = last_cpu.get(key)
            if prev is None or cpu > prev[0] + 0.5:
                last_cpu[key] = (cpu, now)
                active.pop(key + ":stall", None)
            elif now - prev[1] > STALL_S:
                emit(key + ":stall", f"STALLED {j['label']} (pid {j['pid']}): no CPU for {int((now - prev[1]) / 60)} min; check its log")
            if procs[j["pid"]]["age"] > LONG_S:
                emit(key + ":long", f"LONG {j['label']} (pid {j['pid']}) has run {procs[j['pid']]['age'] // 60} min")
            miss = sdk_missing(j, procs)
            if miss:  # once per (missing heads), not once per job: short runs start in bursts
                heads = ", ".join(f"{b}@{sh('git', '-C', PHYSX_SOURCE, 'rev-parse', '--short', b).strip()}" for b in miss)
                if "stale:" + heads not in active:
                  emit("stale:" + heads, f"STALE SDK: jobs starting now (first: {j['label']}, pid {j['pid']}) run an SDK that lacks {heads}; results are provisional until the rebuild")
        for key in [k for k in started if k not in live]:
            label, t0 = started.pop(key)
            if VERBOSE or now - t0 > LONG_S / 3:
                print(time.strftime("%H:%M:%S ") + f"finished {label} after {int((now - t0) / 60)} min", flush=True)
            for k in [k for k in active if k == key or k.startswith(key + ":")]:
                active.pop(k)
            last_cpu.pop(key, None)
        holders = ", ".join(f"{j['label']} ({j['slot']})" for j in jobs if j["pid"] in procs) or "nothing (stale locks?)"
        for q in queue:
            if q["pid"] in procs and now - q["since"] > QUEUE_S and f"queue:{q['pid']}" not in active:  # once per waiting job
                emit(f"queue:{q['pid']}", f"QUEUED {q['label']} ({q['kind']}) has waited {int((now - q['since']) / 60)}+ min; slots held by {holders}")
        busy = sum(1 for j in jobs if j["slot"] != "exclusive" and j["pid"] in procs)
        if busy < SLOTS and not queue and not any(j["slot"] == "exclusive" for j in jobs):
            idle_since = idle_since or now
            if now - idle_since > IDLE_S and "idle" not in active:  # once per idle spell
                emit("idle", f"IDLE {SLOTS - busy} of {SLOTS} GPU slots free for {int((now - idle_since) / 60)} min, nothing queued")
        else:
            idle_since = None
            active.pop("idle", None)
        for w in waiters(procs):
            if w["problem"]:
                emit(f"waiter:{w['pid']}", f"WAITER {w['pid']} {w['problem']} (target {str(w['target'])[:60]})")
        time.sleep(POLL)


if __name__ == "__main__":
    if "--once" in sys.argv:
        print(board(processes()))
    else:
        stream()
