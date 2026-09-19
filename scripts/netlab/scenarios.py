#!/usr/bin/env python3
"""Record and replay the destruction-streaming scenario set.

    scripts/netlab/scenarios.py record [--only NAME ...] [--out DIR]
    scripts/netlab/scenarios.py replay [--only NAME ...] [--out DIR] [--arg ...]

Recording runs the real GPU sim once per scenario and writes an encoder tape:
exactly what the physics half handed the encoder, tick by tick. Replay runs
the encoder against those tapes, which is deterministic and needs no GPU, so a
scheduling change can be compared across every scenario in a couple of seconds.

Why a SET rather than one collapse: the trade-offs genuinely differ by regime.
A change that helps a tower going over sideways can hurt a settled rubble
field, and a single aggregate over both reports the average of two opposite
effects, which is the number least useful for deciding anything.

The .towertrace each run also produces is per-chunk and runs to gigabytes; it
is deleted immediately unless --keep-traces is passed, because the encoder tape
is what the replay needs and the trace is what fills the disk.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE = "destruction/assets/scenes/fractured-downtown.json"

# Every scenario is one deterministic attack. The comment on each says what
# question it exists to answer -- a scenario nobody can state a question for is
# a number that cannot settle an argument.
SCENARIOS = {
    # The reference case: one tall building taken over sideways, progressively.
    # This is the regime the visible artefacts were reported in.
    "wedge": dict(
        seconds=30,
        args=["--demolish", "--demolish-wedge-deg", "55", "--demolish-jitter", "0.35",
              "--demolish-radius-m", "40", "--demolish-below-y", "30",
              "--demolish-per-tick", "2"],
    ),
    # Few large bodies: a clean, fast cut severs the building into a handful of
    # big rigid pieces. Each record is expensive and each error is enormous on
    # screen -- the opposite economics to a rubble field.
    "slabs": dict(
        seconds=30,
        args=["--demolish", "--demolish-wedge-deg", "80", "--demolish-jitter", "0.0",
              "--demolish-radius-m", "40", "--demolish-below-y", "18",
              "--demolish-per-tick", "40"],
    ),
    # Many small bodies: a ragged, slow cut propagates as hundreds of separate
    # fractures. Cheap records, many of them, and the budget is the constraint.
    "rubble": dict(
        seconds=30,
        args=["--demolish", "--demolish-wedge-deg", "55", "--demolish-jitter", "0.6",
              "--demolish-radius-m", "45", "--demolish-below-y", "40",
              "--demolish-per-tick", "1"],
    ),
    # Continuous load: three buildings in sequence, so the stream never gets an
    # idle stretch to recover in. This is what a burst budget has to survive.
    "sustained": dict(
        seconds=90,
        args=["--demolish", "--demolish-buildings", "3", "--demolish-stagger-ticks", "900",
              "--demolish-wedge-deg", "55", "--demolish-jitter", "0.35",
              "--demolish-radius-m", "36", "--demolish-below-y", "30",
              "--demolish-per-tick", "2"],
    ),
    # The aftermath: thousands of bodies awake but barely moving, long after
    # anything interesting has happened. Most of the encoder's work goes here.
    "aftermath": dict(
        seconds=120,
        args=["--demolish", "--demolish-wedge-deg", "55", "--demolish-jitter", "0.35",
              "--demolish-radius-m", "40", "--demolish-below-y", "30",
              "--demolish-per-tick", "2"],
    ),
}

# Viewpoints replayed against the `wedge` tape. The physics is identical; only
# the camera differs, which is the one comparison where overriding the recorded
# camera is the question rather than a mistake.
VIEWS = {
    "near": ["--camera-eye", "6,10,34", "--camera-look", "4,20,-44"],
    "distant": ["--camera-eye", "40,90,320", "--camera-look", "4,30,-44"],
}


def record(names, out: Path, keep_traces: bool) -> int:
    out.mkdir(parents=True, exist_ok=True)
    env = dict(
        os.environ,
        CUDA_HOME=os.environ.get("CUDA_HOME", "/usr/local/cuda-12.8"),
        VIBE_CITY_SCENE="fractured-downtown.json",
        VIBE_CITY_GRID="1",
        VIBE_CITY_DESTRUCTION="native",
    )
    env["PATH"] = f'{env["CUDA_HOME"]}/bin:{env.get("PATH", "")}'
    binary = ROOT / "target/release/record-city-trace"
    if not binary.exists():
        print(f"missing {binary}; build it with:\n"
              f"  CUDA_HOME=/usr/local/cuda-12.8 cargo build --release -p web-fps-server "
              f"--bin record-city-trace --features cuda-stress,blast-core,native-destruction",
              file=sys.stderr)
        return 1

    failures = 0
    for name in names:
        spec = SCENARIOS[name]
        directory = out / name
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)
        trace = directory / "truth.towertrace"
        command = [
            str(binary), "--scene", SCENE, "--grid", "1",
            "--seconds", str(spec["seconds"]), "--settle-ticks", "60",
            *spec["args"],
            "--packets-out", str(directory / "pkts"), "--packets-wire", "2",
            "--encoder-tape-out", str(directory / "encoder.tape"),
            "--output", str(trace),
        ]
        log = directory / "record.log"
        print(f"recording {name} ({spec['seconds']} s) ...", flush=True)
        started = time.time()
        with log.open("w") as handle:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=handle,
                                    stderr=subprocess.STDOUT)
        if not keep_traces and trace.exists():
            # Gigabytes of per-chunk poses. The encoder tape is what replay
            # needs; this is what fills the disk.
            trace.unlink()
        if result.returncode != 0:
            failures += 1
            print(f"  FAILED (rc={result.returncode}); see {log}", file=sys.stderr)
            print("  " + "\n  ".join(log.read_text().splitlines()[-6:]), file=sys.stderr)
            continue
        tape = directory / "encoder.tape"
        print(f"  {time.time() - started:.0f} s, tape {tape.stat().st_size / 1e6:.0f} MB")
    return failures


def replay(names, out: Path, extra) -> int:
    binary = ROOT / "target/release/netlab-encoder"
    if not binary.exists():
        print(f"missing {binary}; cargo build --release -p vibe-land-destruction "
              f"--bin netlab-encoder", file=sys.stderr)
        return 1
    failures = 0
    for name in names:
        directory = out / name
        tape = directory / "encoder.tape"
        manifest = directory / "pkts/manifest.json"
        if not tape.exists():
            print(f"{name}: no tape at {tape}; run `record` first", file=sys.stderr)
            failures += 1
            continue
        views = {"": []}
        if name == "wedge":
            views.update(VIEWS)
        for view, camera in views.items():
            label = f"{name}/{view}" if view else name
            command = [str(binary), "--tape", str(tape), "--manifest", str(manifest),
                       "--label", label, "--json-out",
                       str(directory / f"audit{('-' + view) if view else ''}.json"),
                       *camera, *extra]
            result = subprocess.run(command, cwd=ROOT)
            failures += result.returncode != 0
    return failures


def summarize(names, out: Path) -> int:
    rows = []
    for name in names:
        for path in sorted((out / name).glob("audit*.json")):
            report = json.loads(path.read_text())
            view = path.stem.replace("audit", "").lstrip("-")
            sent = {c["phase"]: c for c in report["cells"] if c["outcome"] == "sent"}
            total = {}
            for cell in report["cells"]:
                total.setdefault(cell["phase"], 0)
                total[cell["phase"]] += cell["count"]
            freed = sent.get("just-freed", {})
            latency = report["fall_latency_ticks"]
            rows.append((
                f"{name}/{view}" if view else name,
                latency["p50"], latency["p90"], latency["p99"], latency["max"],
                report["unresolved_falls"],
                100.0 * freed.get("count", 0) / max(1, total.get("just-freed", 1)),
                freed.get("error_per_byte", 0.0) * 1000.0,
            ))
    if not rows:
        print("no audits found; run `replay` first", file=sys.stderr)
        return 1
    print(f"{'scenario':<18}{'p50':>5}{'p90':>5}{'p99':>6}{'max':>7}{'never':>7}"
          f"{'freed sent%':>13}{'freed mm/B':>12}")
    for row in rows:
        print(f"{row[0]:<18}{row[1]:>5}{row[2]:>5}{row[3]:>6}{row[4]:>7}{row[5]:>7}"
              f"{row[6]:>12.1f}%{row[7]:>12.3f}")
    print("\nfall-notification latency in ticks (60 Hz); 'never' = bodies that")
    print("entered free flight and were never sent a record at all.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["record", "replay", "summarize", "list"])
    parser.add_argument("--only", nargs="*", default=None, metavar="NAME")
    parser.add_argument("--out", default="/dev/shm/netlab/scenarios", type=Path)
    parser.add_argument("--keep-traces", action="store_true",
                        help="keep the multi-gigabyte per-chunk .towertrace files")
    parser.add_argument("--arg", action="append", default=[], dest="extra",
                        help="extra flag passed through to netlab-encoder, repeatable")
    args, unknown = parser.parse_known_args()

    names = args.only or list(SCENARIOS)
    for name in names:
        if name not in SCENARIOS:
            print(f"unknown scenario {name!r}; have {', '.join(SCENARIOS)}", file=sys.stderr)
            return 2

    if args.command == "list":
        for name, spec in SCENARIOS.items():
            print(f"{name:<12}{spec['seconds']:>4} s  {' '.join(spec['args'])}")
        return 0
    if args.command == "record":
        return record(names, args.out, args.keep_traces)
    if args.command == "replay":
        return replay(names, args.out, args.extra + unknown)
    return summarize(names, args.out)


if __name__ == "__main__":
    sys.exit(main())
