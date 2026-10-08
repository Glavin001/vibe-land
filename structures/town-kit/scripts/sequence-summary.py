#!/usr/bin/env python3
"""A house-headers calibration run's damage, classified as sequence-lab.py classifies it
(C10): per case the joints broken after the removal (or all), frame / roof / skin, front wall
or the rest, over the gap (the knocked-out bay +- 0.6 m) or beyond it, and the first breaks.

    python3 structures/town-kit/scripts/sequence-summary.py structures/calibration/out/house-headers-removal-high [report-high.json] [--after TICK]
"""
import collections, json, os, sys

SKIN = {'drywall', 'brick-veneer', 'veneer-lintel-course', 'ceiling-lining', 'glazing', 'window-frame', 'door-frame',
        'roof-covering', 'ivory-trim', 'roof-batten', 'gable-weatherboard'}
ROOF = {'rafter', 'ridge-board', 'ceiling-joist', 'hip-rafter', 'gable-frame'}
GAP = {'intact': None, 'bay1': (1.45, 1.65), 'bay2': (0.9, 1.65), 'truck': (-1.5, 1.3), 'truck-door': (-1.5, 1.65)}


def main():
    out = sys.argv[1]; report = next((a for a in sys.argv[2:] if a.endswith('.json')), 'report-high.json')
    after = int(sys.argv[sys.argv.index('--after') + 1]) if '--after' in sys.argv else 0
    spec = json.load(open(os.path.join(out, 'spec.json'))); r = json.load(open(os.path.join(out, report)))
    scene = json.load(open(spec['scene']))['scenario']
    result = {}
    for c in spec['cases']:
        b0, n0 = c['bonds'][0], c['nodes'][0]; gap = GAP.get(c['id']); dz = c['offset'][2]
        broken = [b for b in r['cases'].get(c['id'], {}).get('broken', []) if b['tick'] >= after]
        cnt = collections.Counter(); first = []
        for b in sorted(broken, key=lambda x: x['tick']):
            bd = scene['bonds'][b['bond']]; t0, t1 = c['types'][bd['node0'] - n0], c['types'][bd['node1'] - n0]
            kind = 'skin' if (t0 in SKIN or t1 in SKIN) else ('roof' if (t0 in ROOF or t1 in ROOF) else 'frame')
            x, z = bd['centroid']['x'], bd['centroid']['z'] - dz
            where = 'over' if gap and gap[0] - 0.6 <= x <= gap[1] + 0.6 else 'beyond'
            cnt[f"{kind}:{'front' if z < -3.0 else 'rest'}:{where}"] += 1
            if len(first) < 12: first.append((b['tick'], f'{t0}|{t1}', round(x, 2), round(z, 2)))
        fb = sum(v for k, v in cnt.items() if k.startswith('frame') and k.endswith('beyond'))
        result[c['id']] = {'broken': len(broken), 'frameBeyond': fb, 'frontFrameBeyond': cnt.get('frame:front:beyond', 0),
                           'lastTick': max((b['tick'] for b in broken), default=None), 'regions': dict(sorted(cnt.items())), 'first': first}
    print(json.dumps(result, indent=1))


if __name__ == '__main__':
    main()
