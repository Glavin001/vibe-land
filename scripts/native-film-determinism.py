#!/usr/bin/env python3
"""Compare two takes of client/native/film-determinism.mjs (scripts/native-mac.sh
film-determinism): the same film, seed and match seed, run twice.

Must match exactly: the server tick reached by each film frame, the input
frames the match applied on each tick (tick, player, move, buttons, yaw,
pitch; the sequence numbers are not compared, they count the load's frames),
and Math.random's draws (count and digest after each frame). The broken-bond
count after the scripted volley is reported, not required to match: GPU
PhysX is not bit-reproducible, so it measures that nondeterminism.
"""
import re
import sys

LINE = re.compile(r"\[film-det\] (\w+) (.*)$")


def read(path):
    take = {"frames": [], "random": [], "inputs": [], "bonds": None, "load": None, "verdict": None}
    with open(path, errors="replace") as handle:
        for line in handle:
            match = LINE.search(line.rstrip())
            if not match:
                continue
            kind, rest = match.groups()
            if kind == "frame":
                # frame N tick T rnd C D
                parts = rest.split()
                take["frames"].append((int(parts[0]), int(parts[2])))
                take["random"].append((int(parts[0]), int(parts[4]), int(parts[5])))
            elif kind == "input":
                tick, fields = rest.split(" ", 1)
                take["inputs"].append((int(tick), fields))
            elif kind == "bonds":
                take["bonds"] = int(rest)
            elif kind == "load":
                take["load"] = rest
            elif kind == "VERDICT":
                take["verdict"] = rest
    return take


def compare(name, a, b):
    if a == b:
        print(f"[film-det] PASS  {name}: {len(a)} records identical")
        return True
    for index, (x, y) in enumerate(zip(a, b)):
        if x != y:
            print(f"[film-det] FAIL  {name}: first difference at record {index}: {x} vs {y}")
            return False
    print(f"[film-det] FAIL  {name}: {len(a)} vs {len(b)} records (identical up to the shorter)")
    return False


def main():
    one, two = (read(path) for path in sys.argv[1:3])
    for label, take in (("take 1", one), ("take 2", two)):
        print(f"[film-det] {label}: load {take['load']}; verdict {take['verdict']}")
    ok = all([
        compare("tick schedule", one["frames"], two["frames"]),
        compare("inputs applied per tick", one["inputs"], two["inputs"]),
        compare("Math.random draws", one["random"], two["random"]),
        one["verdict"] == "PASS" and two["verdict"] == "PASS",
    ])
    a, b = one["bonds"], two["bonds"]
    if a is None or b is None:
        print("[film-det] FAIL  bonds: a take did not report them")
        ok = False
    else:
        spread = abs(a - b)
        print(f"[film-det] bonds after the volley: {a} vs {b} (difference {spread}, "
              f"{100.0 * spread / max(1, max(a, b)):.1f}%; GPU PhysX, not required to match)")
    print(f"[film-det] VERDICT {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
