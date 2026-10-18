#!/usr/bin/env python3
"""Answer drift: the stage's textbook answers against a recorded golden run.

    scripts/verify/answer-drift.py scripts/verify/golden RUN_DIR      # check
    scripts/verify/answer-drift.py scripts/verify/golden RUN_DIR --update   # re-record

Why: an optimisation must make the solver faster without changing its answer
(AGENTS.md, "GPU destruction"). The textbook suite checks each answer against
its closed form to 1%, so an optimisation could move an answer by 0.9% and pass
every check. This compares every check's stage value (textbook-{runtime,high}
.jsonl, the value the GPU stage produced) with the golden run's:

- FAIL: it moved by more than the solve's own convergence tolerance, 1e-3 of
  its magnitude (the product's stress tolerance: the solve is not asked to be
  more exact than that, so a change inside it is not a different answer).
- MOVED: it changed by less (summation order, FP32 rounding); reported.
- A check missing from either side is reported (a case added or retired).

The stage is deterministic: on garage-clean the 85 high and 82 runtime answers
were bit-identical across three runs (2026-10-08). Re-record (--update) only
for an intended model change, saying which in the commit.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

TOLERANCE = 1e-3


def load(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if line.strip():
            d = json.loads(line)
            out[(d["config"], d["case"], d["check"])] = d.get("stage")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("golden", type=Path)
    ap.add_argument("run", type=Path)
    ap.add_argument("--update", action="store_true")
    a = ap.parse_args()
    profiles = ("runtime", "high")
    if a.update:
        a.golden.mkdir(parents=True, exist_ok=True)
        for p in profiles:
            shutil.copy(a.run / f"textbook-{p}.jsonl", a.golden / f"textbook-{p}.jsonl")
        print(f"answer-drift: golden re-recorded from {a.run}")
        return 0
    failed = moved = same = 0
    notes = []
    for p in profiles:
        g_path, r_path = a.golden / f"textbook-{p}.jsonl", a.run / f"textbook-{p}.jsonl"
        if not r_path.exists():
            notes.append(f"{p}: no textbook results in {a.run}")
            failed += 1
            continue
        g, r = load(g_path), load(r_path)
        for k in sorted(set(g) | set(r), key=str):
            if k not in r or k not in g:
                notes.append(f"{p}: {k[1]} / {k[2]}: {'retired (in golden only)' if k in g else 'new (not in golden)'}")
                continue
            gv, rv = g[k], r[k]
            if gv is None or rv is None:
                if gv != rv:
                    notes.append(f"{p}: {k[1]} / {k[2]}: stage value {gv} -> {rv}")
                    failed += 1
                continue
            scale = max(abs(gv), abs(rv))
            rel = abs(rv - gv) / scale if scale > 0 else 0.0
            if rel > TOLERANCE:
                failed += 1
                notes.append(f"FAIL {p}: {k[1]} / {k[2]}: {gv:.7g} -> {rv:.7g} ({rel:.2e} of it, > {TOLERANCE:g})")
            elif rv != gv:
                moved += 1
                notes.append(f"moved {p}: {k[1]} / {k[2]}: {gv:.9g} -> {rv:.9g} ({rel:.2e})")
            else:
                same += 1
    for n in notes:
        print("  " + n)
    print(f"answer-drift: {same} identical, {moved} moved within the solve tolerance {TOLERANCE:g}, {failed} changed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
