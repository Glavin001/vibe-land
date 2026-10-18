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
# With a .log beside the .json: the impact solve's (or step's) cost and detectors,
# and each trial's breaks by source (PX_DESTRUCTION_IMPACT_LOG: the islands the
# impact solve or step decided, or the static verdict), the log split at each
# trial's summary line.
import os, re
def impact_summary(txt, indent='  '):
    ev = [float(m.group(1)) for m in re.finditer(r'\[impact\] evaluation \d+ pass \d: ([\d.]+) ms', txt)]
    disp = [float(m.group(1)) for m in re.finditer(r'longest ([\d.]+) ms\)', txt)]
    def total(key): return sum(int(m.group(1)) for m in re.finditer(r'(\d+) ' + key, txt))
    by = [(int(m.group(1)), int(m.group(2))) for m in re.finditer(r'breaks: (\d+) on islands the impact \w+ decided, (\d+) by the static verdict', txt)]
    if ev: print(f"{indent}impact: {len(ev)} evaluations, mean {sum(ev)/len(ev):.0f} ms, max {max(ev):.0f} ms, longest dispatch {max(disp) if disp else 0:.0f} ms;"
                 f" capped {total('capped,')}, fallen back {total('capped fallback')}, diverged {total('diverged')}, energy gains {total('energy gains')}, infeasible {total('infeasible projections')},"
                 f" held over capacity {sum(int(m.group(1)) for m in re.finditer(r'HELD OVER CAPACITY: (\\d+)', txt))}")
    ghosts = sum(int(m.group(1)) for m in re.finditer(r'ANCHORED GHOSTS: (\d+)', txt))
    created = sum(float(m.group(1)) for m in re.finditer(r'CRUSH ENERGY CREATED: ([\d.e+-]+) J', txt))
    paid = [(float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(5))) for m in re.finditer(
        r'crush pass \d: paid (\d+) \(([\d.e+-]+) J\); not crushed: (\d+) by no body that can pay \(([\d.e+-]+) J\), (\d+) past', txt)]
    if ev or ghosts or created or paid:
        print(f"{indent}anchored ghosts {ghosts}, crush energy created {created:.4g} J"
              + (f"; crushes paid {sum(p[0] for p in paid):.0f} ({sum(p[1] for p in paid):.4g} J), not crushed: {sum(p[2] for p in paid):.0f} unpayable, {sum(p[3] for p in paid):.0f} past their striker's KE" if paid else ""))
    if by: print(f"{indent}breaks by source: impact {sum(a for a, _ in by)}, static {sum(b for _, b in by)} (largest static pass {max(b for _, b in by)})"
                 + ''.join(f"; {m.group(0)}" for m in re.finditer(r'static collapse: [^\n]*', txt)))
for path in sys.argv[1:]:
    log = path[:-5] + '.log'
    if not os.path.exists(log): continue
    txt = open(log).read()
    parts = re.split(r'\n(monster  (\S+)[^\n]*)', txt)
    print(f"== {os.path.basename(log)}")
    if len(parts) < 3: impact_summary(txt); continue
    for k in range(0, len(parts) - 2, 3):
        print(f"  {parts[k + 2]}"); impact_summary(parts[k], '    ')
