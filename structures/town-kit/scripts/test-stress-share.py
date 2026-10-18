#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Regression test for stress-share.py's bond-normal orientation (f03cd6e6).

The GPU solver orients every bond's normal from node0 to node1 along the
chunks' displacement (NvBlastExtStressGpu prepare), so tension is tension
whichever way the normal was authored. stress-share.py once used the authored
normal as given and read every tension as compression where it pointed the
other way (566 of 1,380 facade clips on a Vibe Town tower).

Two chunks, an anchor and a 100 kg block, joined by one bond with its normal
authored node1 -> node0 (the wrong way round):
  - the block hangs under the anchor: the bond is in tension, m g / A;
  - the block sits on the anchor: the bond is in compression, m g / A.

    uv run structures/town-kit/scripts/test-stress-share.py
"""
import importlib.util
import os
import sys

import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("stress_share", os.path.join(here, "stress-share.py"))
ss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ss)

MAT = {"elasticModulus": 30e9, "compressionElastic": 1e9, "compressionFatal": 2e9,
       "tensionElastic": 1e9, "tensionFatal": 2e9, "shearElastic": 1e9, "shearFatal": 2e9}


def case(block_above):
    y_block = 1.0 if block_above else -1.0
    nodes = [{"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0.0},
             {"centroid": {"x": 0, "y": y_block, "z": 0}, "mass": 100.0}]
    # node0 = anchor, node1 = block; the authored normal points block -> anchor.
    normal = {"x": 0, "y": -1.0 if block_above else 1.0, "z": 0}
    bond = {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": y_block / 2, "z": 0},
            "normal": normal, "area": 0.01, "m": 0}
    s = {"nodes": nodes, "bonds": [bond]}
    pos = np.array([[0, 0, 0], [0, y_block, 0]], dtype=float)
    mass = np.array([0.0, 100.0])
    J, resid = ss.solve(s, [MAT], pos, mass)
    assert resid < 1e-9, resid
    util, fatal, compression, tension, shear, bend = ss.stresses(s, [MAT], J, pos=pos)[0]
    return compression, tension


def main():
    expected = 100.0 * ss.G / 0.01
    c, t = case(block_above=False)
    print(f"hanging block: tension {t:.1f} Pa, compression {c:.1f} Pa (expected tension {expected:.1f})")
    assert abs(t - expected) < 1e-6 * expected and c == 0.0, "a hanging block's bond must read tension"
    c, t = case(block_above=True)
    print(f"block on anchor: compression {c:.1f} Pa, tension {t:.1f} Pa (expected compression {expected:.1f})")
    assert abs(c - expected) < 1e-6 * expected and t == 0.0, "a resting block's bond must read compression"
    print("ok")


if __name__ == "__main__":
    sys.exit(main())
