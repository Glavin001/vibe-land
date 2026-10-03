"""`vl repro`: a report, spike or anomaly dump -> a reproduction -> a test.

  vl repro <dump-dir> [--reps N] [--emit-test NAME] [--max-gap-s S]

Reads the dump's repro bundle (docs/repro-bundle.md) and builds a scenario:
- env: the recording server's VIBE_* / PX_* / BLAST_* settings (minus paths
  and ports, which the private stack owns);
- steps: the city events since the last reset, replayed at their tick offsets
  (idle gaps longer than --max-gap-s are shortened), then the ticks up to the
  moment of the dump;
- expect: the invariant the dump says was broken -- the anomaly's kind must
  not occur, or no tick may exceed the spike threshold.

It runs the scenario N times on fresh servers (the physics is not
reproducible, so a bug reproduces at a rate) and reports the rate: the share
of repetitions in which the original symptom came back. --emit-test writes the
scenario to scenarios/repro/NAME.json: a test that fails while the bug is
present (`vl perf scenario scenarios/repro/NAME.json --reps N`).

A plain debug report has no recorded symptom on the server; its expectation is
the recording's own worst tick and anomaly-free run, so a reproduction at least
shows whether the server-side regime comes back. Player inputs are recorded
(inputs.jsonl) but not yet replayed: the reproduction drives the world, not
the player's camera.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace

from . import perf_explain, perf_scenario, stack

DENY = ("DIR", "PATH", "_OUT", "FILE", "PORT", "ADDR", "TELEMETRY", "CAPTURE")


def find_bundle(path: Path) -> Path:
    for p in (path / "repro", path):
        if (p / "meta.json").exists() and (p / "events.jsonl").exists():
            return p
    raise SystemExit(f"no repro bundle in {path} (expected repro/meta.json and repro/events.jsonl)")


def offset_of(items, tick, max_gap):
    """A recorded tick's offset on the replay timeline (after the last event
    before it, with the same gap shortening)."""
    before = [i for i in items if i["original_tick"] <= tick]
    if not before:
        return 0
    last = before[-1]
    return last["offset"] + min(tick - last["original_tick"], max_gap)


def build_scenario(bundle: Path, max_gap_s: float):
    meta = json.loads((bundle / "meta.json").read_text())
    events = [json.loads(l) for l in (bundle / "events.jsonl").read_text().splitlines() if l.strip()]
    last_reset = max((i for i, e in enumerate(events) if e["event"].get("kind") == "reset"), default=-1)
    events = [e for e in events[last_reset + 1:] if e["event"].get("kind") != "join"]
    end_tick = meta.get("server_tick", 0)
    max_gap = int(max_gap_s * 60)
    items, offset, previous = [], 0, None
    for e in events:
        if previous is not None:
            offset += min(e["tick"] - previous, max_gap)
        items.append({"offset": offset, "event": e["event"], "original_tick": e["tick"]})
        previous = e["tick"]
    tail = min(max(end_tick - (previous if previous is not None else end_tick), 0), max_gap) + 120
    env = {k: v for k, v in (meta.get("env") or {}).items() if not any(d in k for d in DENY)}
    kind = meta.get("kind")
    expect = {"min_pass_rate": 1.0}
    symptom = "none recorded"
    if kind == "anomaly":
        expect["no_anomaly"] = [meta["anomaly"]["kind"]]
        symptom = f"anomaly {meta['anomaly']['kind']}: {meta['anomaly'].get('why', '')}"
    elif kind == "spike":
        threshold = 33.0
        try:
            threshold = json.loads((bundle.parent / "meta.json").read_text()).get("threshold_ms", 33.0)
        except (OSError, ValueError):
            pass
        spike_tick = meta.get("server_tick")
        try:
            spike_tick = json.loads((bundle.parent / "meta.json").read_text()).get("spike_tick", spike_tick)
        except (OSError, ValueError):
            pass
        # Where the spike falls in the replay: its offset from the first
        # replayed event (on the same compressed timeline), +-60 ticks.
        at = offset_of(items, spike_tick, max_gap)
        expect["max_tick_ms_window"] = {"from_offset": at - 60, "to_offset": at + 60, "ms": threshold}
        symptom = f"a tick over {threshold} ms near replay offset {at} ({meta.get('reason', '')})"
    else:
        from . import triage
        if (bundle.parent / "client.json").exists():
            client = [s for s in triage.report_signature(bundle.parent) if s.startswith("client:")]
            if client:
                expect["client_symptoms_absent"] = client
        ticks = perf_explain.load([bundle / "ticks.jsonl"]) if (bundle / "ticks.jsonl").exists() else []
        worst = max((t.get("total_ms") or 0 for t in ticks), default=0)
        if worst > 33:
            expect["max_tick_ms"] = 33.0
            symptom = f"the report's recent ticks reached {worst:.1f} ms"
        expect["no_anomaly_any"] = True
        if expect.get("client_symptoms_absent"):
            symptom = (symptom if symptom != "none recorded" else "") + ("; " if symptom != "none recorded" else "") + \
                "client " + ", ".join(expect["client_symptoms_absent"])
    name = f"repro-{bundle.parent.name if bundle.name == 'repro' else bundle.name}"
    scenario = {"name": name, "why": f"Reproduction of {bundle} ({kind}): {symptom}. Generated by vl repro; replays "
                f"{len(items)} city events since the last reset at their tick offsets (gaps over {max_gap_s:.0f} s shortened).",
                "source": str(bundle), "symptom": symptom, "env": env,
                "steps": [{"events": items, "tail_ticks": tail}], "expect": expect}
    return scenario, meta


def run(args):
    bundle = find_bundle(Path(args.dump))
    scenario, meta = build_scenario(bundle, args.max_gap_s)
    out = Path(args.out) if args.out else stack.ROOT / "target/vl/repro" / f"{time.strftime('%Y%m%d-%H%M%S')}-{scenario['name']}"
    out.mkdir(parents=True, exist_ok=True)
    scenario_path = out / "scenario.json"
    scenario_path.write_text(json.dumps(scenario, indent=1))
    steps = scenario["steps"][0]
    print(f"repro of {bundle}\n  kind {meta.get('kind')}, symptom: {scenario['symptom']}\n  "
          f"{len(steps['events'])} events over {steps['events'][-1]['offset'] / 60 if steps['events'] else 0:.0f} s + "
          f"{steps['tail_ticks'] / 60:.0f} s tail; env {len(scenario['env'])} settings; {args.reps} repetitions")
    run_args = SimpleNamespace(scenario=str(scenario_path), env=args.env, match=meta.get("match_id", "city-default"),
                               http_port=args.http_port, wt_port=args.wt_port, client_port=args.client_port,
                               warmup=args.warmup, binary=args.binary, gpu_trace=False, reps=args.reps,
                               label=scenario["name"], out=str(out / "run"))
    try:
        perf_scenario.run(run_args)
        failed_expectations = False
    except SystemExit as exit_:
        if exit_.code not in (1, None):
            raise
        failed_expectations = exit_.code == 1
    result = json.loads((out / "run" / "expect.json").read_text()) if (out / "run" / "expect.json").exists() else {}
    violations = result.get("violations", [])
    reproduced = sum(1 for v in violations if v)
    rate = reproduced / len(violations) if violations else 0.0
    summary = {"bundle": str(bundle), "symptom": scenario["symptom"], "reps": len(violations), "reproduced": reproduced,
               "rate": rate, "violations": violations, "run": str(out / "run")}
    (out / "repro.json").write_text(json.dumps(summary, indent=1))
    print(f"\nREPRODUCED in {reproduced}/{len(violations)} repetitions ({rate:.0%}): {scenario['symptom']}")
    if args.emit_test:
        test_dir = stack.ROOT / "scenarios/repro"
        test_dir.mkdir(parents=True, exist_ok=True)
        test = dict(scenario, name=args.emit_test)
        test["expect"] = dict(scenario["expect"], min_pass_rate=1.0)
        test["reproduction"] = {"rate": rate, "reps": len(violations), "measured": time.strftime("%Y-%m-%d")}
        path = test_dir / f"{args.emit_test}.json"
        path.write_text(json.dumps(test, indent=1))
        print(f"test written: {path}  (fails while the bug reproduces: vl perf scenario {path} --reps {max(3, args.reps)})")
    return summary, failed_expectations
