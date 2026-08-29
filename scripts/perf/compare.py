"""Compare fingerprinted run dirs: the one-command A/B verdict.

    python3 -m scripts.perf.compare <runA...> --vs <runB...>
    python3 -m scripts.perf.compare latest labelA labelB [-n 2]

Prints the equivalence verdict, the joint-bucket table, and per-phase
attribution. Refuses incomparable arms rather than producing a number.
"""

from __future__ import annotations

import sys

from . import runs as runs_mod
from . import verdict as verdict_mod


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == "latest":
        count = 1
        if "-n" in argv:
            index = argv.index("-n")
            count = int(argv[index + 1])
            argv = argv[:index] + argv[index + 2 :]
        label_a, label_b = argv[1], argv[2]
        paths_a = runs_mod.latest(label_a, count)
        paths_b = runs_mod.latest(label_b, count)
        if not paths_a or not paths_b:
            print(f"no runs found for labels {label_a!r} / {label_b!r} under {runs_mod.RUNS_ROOT}")
            return 2
    else:
        split = argv.index("--vs")
        paths_a, paths_b = argv[:split], argv[split + 1 :]
    arm_a = [runs_mod.load(path) for path in paths_a]
    arm_b = [runs_mod.load(path) for path in paths_b]
    print(f"A: {[run.label for run in arm_a]}")
    print(f"B: {[run.label for run in arm_b]}")
    result = verdict_mod.compare(arm_a, arm_b)
    print(result.render())
    return 0 if result.comparable else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
