"""`vl perf scenario`: run a declared performance scenario on a private stack.

A scenario (scenarios/perf/<name>.json):

  {"name": "...", "why": "...",
   "env": {"VAR": "value", ...},             # server env on top of stack.DEFAULT_ENV
   "steps": [{"idle": 20},                    # seconds of nothing
             {"meteors": 8, "every_s": 2},    # meteors at the first N buildings
             {"events": [{"offset": 0, "event": {...}}, ...],   # recorded city events
              "tail_ticks": 600},             # replayed at their tick offsets (vl repro)
             {"idle": 20}],
   "expect": {"no_anomaly": ["stage_error"],  # invariants a passing run keeps
              "max_tick_ms": 100,
              "min_pass_rate": 1.0}}          # share of repetitions that must pass

Expectations make a scenario a test: `vl perf scenario` exits 1 when fewer than
min_pass_rate of the repetitions keep them. `vl repro --emit-test` writes
scenarios whose expectations the reported bug violates.

The run directory gets ticks.jsonl (every tick, from the server's flight
recorder), steps.json (each step's tick range), the server's automatic spike
dumps (debug-reports/spike-*), logs, meta.json (fingerprint) and explain.json
(`vl perf explain` of the whole run and of each step).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from . import perf_explain, perf_stats, stack


class TickPuller(threading.Thread):
    """Pulls the flight recorder every few seconds; the ring holds ~10 s."""

    def __init__(self, url, match):
        super().__init__(daemon=True)
        self.url, self.match = url, match
        self.rows, self.seen = [], set()
        self.stop_event = threading.Event()

    def pull(self):
        try:
            body = urllib.request.urlopen(f"{self.url}/match-stats/{self.match}/ticks", timeout=5).read().decode()
        except Exception:  # noqa: BLE001 - the match may not exist yet
            return
        for line in body.splitlines():
            if line.strip():
                t = json.loads(line)
                if t["tick"] not in self.seen:
                    self.seen.add(t["tick"])
                    self.rows.append(t)

    def last_tick(self):
        self.pull()
        return max(self.seen, default=0)

    def run(self):
        while not self.stop_event.wait(3.0):
            self.pull()


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    return urllib.request.urlopen(req, timeout=5).read().decode()


def current_tick(api, match):
    return int(urllib.request.urlopen(f"{api}/match-stats/{match}/tick", timeout=5).read())


def replay_events(api, match, items, tail_ticks, log):
    """Apply recorded events at their tick offsets from now, timed by the
    server's own tick (a loaded server runs behind wall time)."""
    base = current_tick(api, match)
    log.append({"base": base})
    for item in sorted(items, key=lambda i: i["offset"]):
        due = base + item["offset"]
        while current_tick(api, match) < due:
            time.sleep(0.02)
        try:
            reply = post_json(f"{api}/match-stats/{match}/replay-event", item["event"])
        except Exception as error:  # noqa: BLE001 - record and continue
            reply = f"failed: {error}"
        log.append({"due": due, "applied": current_tick(api, match), "kind": item["event"].get("kind"), "reply": reply})
    end = base + max([i["offset"] for i in items] or [0]) + tail_ticks
    while current_tick(api, match) < end:
        time.sleep(0.2)


def run_steps(api, match, steps, puller, run_dir=None):
    marks = []
    buildings = None
    for step in steps:
        start = puller.last_tick()
        if "events" in step:
            log = []
            replay_events(api, match, step["events"], step.get("tail_ticks", 600), log)
            if run_dir is not None:
                (Path(run_dir) / "replay-log.json").write_text(json.dumps(log, indent=1))
            kind = f"events {len(step['events'])}"
        elif "idle" in step:
            time.sleep(step["idle"])
            kind = f"idle {step['idle']}s"
        elif "meteors" in step:
            if buildings is None:
                b = json.loads(urllib.request.urlopen(f"{api}/city-buildings", timeout=10).read())
                buildings = b if isinstance(b, list) else b.get("buildings", [])
            for target in [x["centre"] for x in buildings[: step["meteors"]]]:
                post_json(f"{api}/city-meteor/{match}", {"targets": [target]})
                time.sleep(step.get("every_s", 2))
            kind = f"meteors {step['meteors']}"
        else:
            raise SystemExit(f"unknown step {step}")
        marks.append({"step": kind, "from_tick": start, "to_tick": puller.last_tick()})
    return marks


def anomalies_in(rep_dir: Path):
    """Anomaly dumps the server wrote during a repetition: [(kind, tick)]."""
    out = []
    for d in sorted((Path(rep_dir) / "debug-reports").glob("anomaly-*")):
        try:
            meta = json.loads((d / "repro" / "meta.json").read_text())
            out.append((meta["anomaly"]["kind"], meta["anomaly"]["tick"]))
        except (OSError, KeyError, ValueError):
            out.append((d.name.rsplit("-", 1)[-1], None))
    return out


def check_expect(expect, rep_dir: Path):
    """The expectations a repetition violated (empty: it passed)."""
    violations = []
    kinds = [k for k, _ in anomalies_in(rep_dir)]
    for kind in expect.get("no_anomaly", []):
        if kind in kinds:
            violations.append(f"anomaly {kind}")
    if expect.get("no_anomaly_any") and kinds:
        violations.append("anomalies " + ", ".join(sorted(set(kinds))))
    window = expect.get("max_tick_ms_window")
    log_path = Path(rep_dir) / "replay-log.json"
    if window and log_path.exists() and (Path(rep_dir) / "ticks.jsonl").exists():
        base = next((x["base"] for x in json.loads(log_path.read_text()) if "base" in x), None)
        if base is not None:
            lo, hi = base + window["from_offset"], base + window["to_offset"]
            ticks = [t for t in perf_explain.load([Path(rep_dir) / "ticks.jsonl"]) if lo <= t["tick"] <= hi]
            worst = max((t.get("total_ms") or 0 for t in ticks), default=0)
            if worst > window["ms"]:
                violations.append(f"worst tick {worst:.1f} ms > {window['ms']} within offsets {window['from_offset']}..{window['to_offset']}")
    limit = expect.get("max_tick_ms")
    if limit is not None and (Path(rep_dir) / "ticks.jsonl").exists():
        ticks = perf_explain.load([Path(rep_dir) / "ticks.jsonl"])
        worst = max((t.get("total_ms") or 0 for t in ticks), default=0)
        if worst > limit:
            violations.append(f"worst tick {worst:.1f} ms > {limit}")
    return violations


def locked(args):
    """The GPU part, run under gpu-run.sh: server, player, steps."""
    run_dir = Path(args.run_dir)
    scenario = json.loads(Path(args.scenario).read_text())
    env = dict(scenario.get("env", {}))
    for kv in args.env or []:
        k, _, v = kv.partition("=")
        env[k] = v
    binary = Path(args.binary)
    api = f"http://127.0.0.1:{args.http_port}"
    server = player = None
    code = 0
    try:
        server = stack.start_server(run_dir, binary, args.http_port, args.wt_port, env)
        player = stack.join(run_dir, args.client_port, args.http_port, args.match)
        puller = TickPuller(api, args.match)
        puller.start()
        time.sleep(args.warmup)
        marks = run_steps(api, args.match, scenario["steps"], puller, run_dir)
        puller.stop_event.set()
        puller.pull()
        time.sleep(1)
        rows = sorted(puller.rows, key=lambda t: t["tick"])
        (run_dir / "ticks.jsonl").write_text("".join(json.dumps(t) + "\n" for t in rows))
        (run_dir / "steps.json").write_text(json.dumps(marks, indent=1))
        if server.poll() is not None:
            print("the server died during the run", file=sys.stderr)
            code = 5
    finally:
        stack.kill_tree(player)
        stack.kill_tree(server)
    sys.exit(code)


def run(args):
    scenario_path = Path(args.scenario)
    if not scenario_path.exists():
        scenario_path = stack.ROOT / "scenarios/perf" / f"{args.scenario}.json"
    scenario = json.loads(scenario_path.read_text())
    label = args.label or scenario["name"]
    run_dir = Path(args.out) if args.out else stack.ROOT / "target/vl/runs" / f"{time.strftime('%Y%m%d-%H%M%S')}-{label}"
    run_dir.mkdir(parents=True, exist_ok=True)
    binary = Path(args.binary or stack.ROOT / "target/garage-vehicles/release/web-fps-server")
    if not binary.exists():
        raise SystemExit(f"no server binary at {binary}; build it (scripts/perf/garage-vehicle-server.sh builds one)")
    env = dict(scenario.get("env", {}))
    if getattr(args, "gpu_trace", False):
        args.env = (args.env or []) + ["CUMETAL_TRACE_COMMITS=1"]
    for kv in args.env or []:
        k, _, v = kv.partition("=")
        env[k] = v
    meta = {"kind": "scenario", "scenario": scenario, "label": label, "fingerprint": stack.fingerprint(binary, env),
            "reps": args.reps, "started": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    vite = stack.start_vite(run_dir, args.client_port, args.http_port)
    rep_dirs = []
    try:
        for rep in range(args.reps):
            rep_dir = run_dir / f"rep-{rep}" if args.reps > 1 else run_dir
            rep_dir.mkdir(parents=True, exist_ok=True)
            cmd = [str(stack.GPU_RUN), f"vl-{label}", sys.executable, str(stack.ROOT / "scripts/vl"), "perf", "_locked",
                   "--scenario", str(scenario_path), "--run-dir", str(rep_dir), "--binary", str(binary),
                   "--http-port", str(args.http_port), "--wt-port", str(args.wt_port), "--client-port", str(args.client_port),
                   "--match", args.match, "--warmup", str(args.warmup)]
            for kv in args.env or []:
                cmd += ["--env", kv]
            code = subprocess.call(cmd)
            if code != 0 or not (rep_dir / "ticks.jsonl").exists():
                raise SystemExit(f"scenario run failed (rep {rep}, exit {code}); see {rep_dir}")
            rep_dirs.append(rep_dir)
    finally:
        stack.kill_tree(vite)
    summaries = [perf_stats.summarise_rep(d) for d in rep_dirs]
    aggregate = perf_stats.aggregate(summaries)
    (run_dir / "summary.json").write_text(json.dumps({"label": label, "reps": [str(d) for d in rep_dirs],
                                                      "per_rep": summaries, "aggregate": aggregate}, indent=1, default=float))
    print(f"==== {label}: {len(rep_dirs)} repetition(s), per step (mean [min .. max] over repetitions)")
    perf_stats.print_aggregate(aggregate)
    expect = scenario.get("expect")
    if expect:
        verdicts = [check_expect(expect, d) for d in rep_dirs]
        passed = sum(1 for v in verdicts if not v)
        rate = passed / len(verdicts)
        (run_dir / "expect.json").write_text(json.dumps({"expect": expect, "violations": verdicts, "pass_rate": rate}, indent=1))
        print(f"\nexpectations {expect}: {passed}/{len(verdicts)} repetitions pass")
        for d, v in zip(rep_dirs, verdicts):
            if v:
                print(f"  {d.name}: " + "; ".join(v))
        if rate < expect.get("min_pass_rate", 1.0):
            print(f"FAIL: pass rate {rate:.2f} < {expect.get('min_pass_rate', 1.0)}")
            sys.exit(1)
    if args.reps > 1:
        print(f"\nrun: {run_dir}  (explain a repetition: vl perf explain {rep_dirs[0]})")
        return
    marks = json.loads((run_dir / "steps.json").read_text())
    explain = {"all": perf_explain.run([run_dir / "ticks.jsonl"], as_json=False)}
    ticks = perf_explain.load([run_dir / "ticks.jsonl"])
    for m in marks:
        part = [t for t in ticks if m["from_tick"] <= t["tick"] <= m["to_tick"]]
        if part:
            tmp = run_dir / f"step-{m['from_tick']}.jsonl"
            tmp.write_text("".join(json.dumps(t) + "\n" for t in part))
            print(f"\n==== step: {m['step']} (ticks {m['from_tick']}-{m['to_tick']})")
            explain[m["step"]] = perf_explain.run([tmp], top=5)
    steps = [(m["step"], [t for t in ticks if m["from_tick"] <= t["tick"] <= m["to_tick"]]) for m in marks]
    steps = [(name, part) for name, part in steps if part]
    if len(steps) > 1:
        explain["diffs"] = {}
        first_name, first = steps[0]
        for name, part in steps[1:]:
            print(f"\n==== diff: {first_name} -> {name}")
            explain["diffs"][f"{first_name} -> {name}"] = perf_explain.diff(first, part, "first", "this")
    (run_dir / "explain.json").write_text(json.dumps(explain, indent=1, default=float))
    print(f"\nrun: {run_dir}")
