"""`vl perf stacks`: read a macOS /usr/bin/sample call graph (vl perf scenario --sample).

  vl perf stacks <run>/sample-step-N.txt [thread substring, default match-] [top]

For each matching thread, the inclusive samples of every function (counted
once per stack, so recursion is not double counted). Samples are 1 ms, so
16.7 are one 60 Hz tick. Waits (__psynch_cvwait, kevent) count too: a thread
blocked in NpScene::fetchResults is waiting on the step's workers or the GPU.
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

LINE = re.compile(r"^(\s*)(?:[+!:|]\s*)*(\d+)\s+(.*)$")


def clean(name: str) -> str:
    name = re.sub(r"\s+\(in [^)]*\)\s*\+.*$", "", name)
    name = re.sub(r"\s+\[0x[0-9a-f]+\].*$", "", name)
    name = re.sub(r"\(.*\)\s*(const)?$", "", name) if "physx::" in name or "cumetal::" in name else name
    return name.strip()


def threads(path: Path):
    """{thread header: [(depth, count, name)]} from the 'Call graph' section."""
    out, current = {}, None
    in_graph = False
    for raw in path.read_text(errors="replace").splitlines():
        if raw.startswith("Call graph:"):
            in_graph = True
            continue
        if in_graph and (raw.startswith("Total number in stack") or raw.startswith("Sort by top")):
            break
        if not in_graph or not raw.strip():
            continue
        m = LINE.match(raw)
        if not m:
            continue
        depth = len(raw) - len(raw.lstrip(" +!:|"))
        count, name = int(m.group(2)), m.group(3)
        if "Thread_" in name and depth <= 4:
            current = name
            out[current] = []
            continue
        if current:
            out[current].append((depth, count, clean(name)))
    return out


def analyse(nodes):
    """Inclusive samples per function, each counted once per stack."""
    inclusive = Counter()
    stack = []  # (depth, name)
    for depth, count, name in nodes:
        while stack and stack[-1][0] >= depth:
            stack.pop()
        if name not in {n for _, n in stack}:
            inclusive[name] += count
        stack.append((depth, name))
    return inclusive


def main(argv):
    path = Path(argv[0])
    who = argv[1] if len(argv) > 1 else "match-"
    top = int(argv[2]) if len(argv) > 2 else 45
    per = threads(path)
    picked = [t for t in per if who in t]
    if not picked:
        print("threads:", *per, sep="\n  ")
        return 1
    for t in picked:
        nodes = per[t]
        total = max((c for d, c, _ in nodes), default=0)
        inc = analyse(nodes)
        print(f"{t}: {total} samples")
        for name, count in inc.most_common(top):
            print(f"  {count:7d} {100*count/max(total,1):5.1f}%  {name[:150]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
