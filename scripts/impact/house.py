#!/usr/bin/env python3
"""The house metrics of vehicle test bed runs (target/vehicle-testbed/LABEL.json),
one line per trial: house bonds broken (frame), break distance, frame still
anchored, roof drop, the car's reach past the front and back brick faces.

    python3 scripts/impact/house.py target/vehicle-testbed/A.json [B.json ...]
Targets (the impact solve): roof drop < 0.2 m, frame >= 80% anchored."""
import json, sys
for path in sys.argv[1:]:
    d = json.load(open(path))
    print(f"== {d.get('label', path)}")
    for r in d['runs']:
        h = r.get('house') or {}
        if not h: continue
        z = r.get('maxZ'); past = r.get('attack', {}) or {}
        reach = f"front {z - 20.1:+.1f} m back {z - 27.9:+.1f} m" if z is not None and r.get('trial') in ('framed-house', 'framed-house-corner') else f"projectile past front {past.get('pastTarget')}"
        print(f"  {r['trial']:24s} house {h['broken']:5d}/{h['bonds']} (frame {h['structuralBroken']}/{h['structuralBonds']}), median break {h.get('medianBreakDistance', 0):.1f} m,"
              f" by distance {h.get('byDistance')}, frame anchored {h.get('frameAnchoredFrac', 0):.2f}, roof drop {h.get('roofDropMean', 0):.2f} m"
              f" ({h.get('roofMembersDown')}/{h.get('roofMembers')} down), crushed {h.get('crushedChunks')}, car bonds {r.get('bondsBroken')}, {reach}")
