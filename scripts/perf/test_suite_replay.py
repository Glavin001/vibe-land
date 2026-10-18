#!/usr/bin/env python3
"""The perf suite's replay parser against stored summary lines of both formats:
python3 scripts/perf/test_suite_replay.py (exit 1 on a mismatch)."""
import sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import suite

OLD = ("/x/cannonball-house.impc: 3376 chunks, 8961 bonds, 21 rows; 1 islands, 13 solves, 17187 iterations (1 capped), 13 rounds; "
       "broke 34, yielded 43; 1 contacts, 1 impactors; error 0; 5914.3 ms in 461 dispatches (longest 17.7 ms)")
# PhysX feat/impact-capacity after the explicit step (2026-10-08, rebearing-on run).
NEW = ("/x/cannonball-house.impc: 3376 chunks, 8961 bonds, 21 rows; 1 islands, 13 solves, 17187 iterations (1 capped), 13 rounds; "
       "broke 34, yielded 43; 1 contacts, 1 impactors; 0 diverged (worst bond -1), 0 infeasible, 0 non-finite, 0 energy gains; "
       "error 0; 5914.3 ms in 461 dispatches (longest 17.7 ms)")
ok = True
for name, line in (("old", OLD), ("new", NEW)):
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
        f.write("SUITE_LOCKED 1\n" + line + "\n")
    r = suite.read_replay(Path(f.name))
    good = r is not None and r["step_ms"]["median"] == 5914.3 and r["impact"]["solves"] == 13 and r["impact"]["chunks"] == 3376 \
        and r["impact"]["longest_dispatch_ms"] == 17.7 and r["impact"]["diverged"] == 0
    print(f"{'PASS' if good else 'FAIL'}  {name} replay line -> {r and r['impact']}")
    ok &= good
sys.exit(0 if ok else 1)
