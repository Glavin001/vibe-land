#!/usr/bin/env python3
"""The netcode lab's quick merge gate (plan milestone 12), on CPU, about a
minute and a half.

    scripts/netlab/ci-quick.py [--truth DIR] [--out DIR] [--update]

1. `cargo test` for the netcode crates (the replication trait's
   byte-identity with the live call order, per player's core, every
   perceptual metric's injection test).
2. The wedge capture through both strategies (4 clients, lte, seed 1,
   1024 kbit/s bucket). Per player runs with its Rust client core; shared
   v2 runs the server stage only (`--no-client`), because its client stage
   needs Node.
3. Against `scripts/netlab/ci-baseline.json`:
   - **Tapes:** each strategy's client-0 tape hash. The lab is
     deterministic, so a changed hash means the wire changed; review it and
     `--update` when the change is intended.
   - **Gates:** no gate count may rise over the baseline's (G1 hash
     mismatches, G2 early events, G3 clients over the cap, G4 solid-geometry
     frames, G5 resurrections).
   - **Quality:** per player's penalty may not rise by more than 1%. The
     same inputs give the same score, so the slack only absorbs float
     differences across machines.
   - **Bytes:** per player's kbit/s may not rise by more than 5% with no
     penalty gain.

Exit 0 on pass. Captures are not in git (12-63 MB each); a runner needs
`--truth` holding `wedge/capture` (record with
`scripts/netlab/record-truth.py`).
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.environ.get("CARGO_TARGET_DIR", "/Users/glavin/Development/vibe-land/target/nds")
BASELINE = os.path.join(ROOT, "scripts", "netlab", "ci-baseline.json")
GATE_COUNTS = ("g1_hash_mismatches", "g2_events_early", "g3_clients_over", "g4_solid_frames", "g5_resurrection_frames", "g7_frames_ahead_of_data")


def sh(cmd, **kw):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT, env={**os.environ, "CARGO_TARGET_DIR": TARGET}, **kw)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--truth", default="/Users/glavin/Development/vibe-land/target/nds/truth")
    ap.add_argument("--out", default=os.path.join(TARGET, "ci-quick"))
    ap.add_argument("--update", action="store_true", help="write the baseline from this run")
    args = ap.parse_args()
    failures = []
    if sh(["cargo", "test", "--release", "-p", "vibe-land-destruction", "-p", "vibe-land-perplayer", "--lib", "-q"]).returncode != 0:
        failures.append("cargo test failed")
    if sh(["cargo", "build", "--release", "-p", "web-fps-server", "--bin", "netlab2", "-q"]).returncode != 0:
        print("netlab2 did not build")
        return 1
    netlab2 = os.path.join(TARGET, "release", "netlab2")
    capture = os.path.join(args.truth, "wedge", "capture")
    common = ["city", "--capture", capture, "--clients", "4", "--link", "lte", "--seed", "1",
              "--budget-kbps", "1024", "--burst-kbps", "3072", "--burst-s", "3"]
    runs = {
        "per-player": common + ["--strategy", "per-player", "--knob", "pp.tolerance_px=2"],
        "shared-v2": common + ["--strategy", "shared-v2", "--no-client"],
    }
    now = {}
    for name, cmd in runs.items():
        out = os.path.join(args.out, name)
        os.makedirs(out, exist_ok=True)
        if sh([netlab2] + cmd + ["--out", out], stdout=subprocess.DEVNULL).returncode != 0:
            failures.append(f"{name}: netlab2 failed")
            continue
        with open(os.path.join(out, "scorecard.json")) as f:
            card = json.load(f)
        now[name] = {
            "tape_sha256": digest(os.path.join(out, "c00", "lab.vltape")),
            "kbit_s": round(card["kbit_s_mean"], 3),
            "penalty": card.get("penalty_per_minute_mean"),
            "gates": card["gates"]["pass"],
            "gate_counts": {k: card["gates"].get(k, 0) for k in GATE_COUNTS},
        }
    if args.update:
        with open(BASELINE, "w") as f:
            json.dump(now, f, indent=2)
        print(f"baseline written: {BASELINE}")
        return 0 if not failures else 1
    with open(BASELINE) as f:
        base = json.load(f)
    for name, cur in now.items():
        ref = base.get(name, {})
        if cur["tape_sha256"] != ref.get("tape_sha256"):
            failures.append(f"{name}: the wire changed (tape hash); review and --update if intended")
        for gate, count in cur["gate_counts"].items():
            if count > ref.get("gate_counts", {}).get(gate, 0):
                failures.append(f"{name}: {gate} {count} > baseline {ref.get('gate_counts', {}).get(gate, 0)}")
    pp, ref = now.get("per-player"), base.get("per-player", {})
    if pp:
        if ref.get("penalty") and pp["penalty"] > ref["penalty"] * 1.01:
            failures.append(f"per-player: penalty {pp['penalty']:.1f} > baseline {ref['penalty']:.1f} +1%")
        if ref.get("kbit_s") and pp["kbit_s"] > ref["kbit_s"] * 1.05 and pp["penalty"] >= ref.get("penalty", 0):
            failures.append(f"per-player: {pp['kbit_s']:.1f} kbit/s > baseline {ref['kbit_s']:.1f} +5% with no quality gain")
    print(json.dumps(now, indent=2))
    if failures:
        print("FAIL\n- " + "\n- ".join(failures))
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
