#!/usr/bin/env python3
"""The veneer-house trials judged for locality, frame and roof, from a test
bed run with VIBE_TESTBED_SCENE_BONDS=1 (each run's broken scene bonds as
node pairs, from tick 0 of that run).

    scripts/hifi/houses.py LABEL [PACK.json]   (pack: the run's scene by default)

Per trial: framed-house joints broken (of 3,084), the share of them more than
4 m and 8 m from the hit, the frame (studs, plates, joists, rafters and their
joints) and the roof (rafters, ridge, coverings, battens, heels, seats), the
skin (brick, mortar, ties, drywall), and the farthest break. The hit point:
the shot's target, or for a drive the house's front face at the car's lane.
"""
import json, math, os, sys, collections

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
label = sys.argv[1]
report = json.load(open(f'{root}/target/vehicle-testbed/{label}.json'))
pack = json.load(open(sys.argv[2] if len(sys.argv) > 2 else report['scene']))
meta = json.load(open(report['scene'].replace('.json', '.meta.json')))
sc = pack['scenario']; groups = sc['nodeGroups']; types = sc['nodeTypes']
names = [m['name'] for m in pack['defaults']['solver']['materials']]
pos = [(n['centroid']['x'], n['centroid']['y'], n['centroid']['z']) for n in sc['nodes']]
mat = {}
for b in sc['bonds']:
    mat[(b['node0'], b['node1'])] = mat[(b['node1'], b['node0'])] = (b['m'], b['centroid'])
house = [i for i, g in enumerate(groups) if g.startswith('framed-house')]
total = sum(1 for b in sc['bonds'] if groups[b['node0']].startswith('framed-house'))
FRAME = {'stud', 'king-stud', 'jack-stud', 'cripple-stud', 'junction-stud', 'top-plate', 'bottom-plate', 'header', 'ceiling-joist', 'rafter', 'ridge-board', 'gable-frame'}
ROOF = {'rafter', 'ridge-board', 'roof-covering', 'gable-frame', 'gable-cladding'}
SKIN_MATS = ('mortar', 'wall-tie', 'drywall', 'brick', 'veneer')
trials = {t['id']: t for t in meta['trials']}
lanes = {f"lane/{l['id']}": l for l in meta['lanes']}

def hit_point(trial):
    a = trial.get('attack') or {}
    if a.get('kind') == 'shot': return tuple(a['target'])
    if a.get('kind') == 'shots': return tuple(a['shots'][0]['target'])
    lane = lanes.get(trial['at'])
    x = lane['x'] + trial.get('dx', 0) if lane else 0
    return (x, 1.0, trial.get('impactZ', 20.1))

print(f'{label}: framed-house {total} joints')
print(f"{'trial':26s} {'broken':>7s} {'>4 m':>6s} {'>8 m':>6s} {'frame':>11s} {'roof':>9s} {'skin':>6s} {'far m':>6s}  top materials")
for run in report['runs']:
    tid = run.get('trial'); trial = trials.get(tid, {})
    pairs = [tuple(p) for p in run.get('sceneBrokenPairs', []) if groups[p[0]].startswith('framed-house')]
    hp = hit_point(trial)
    d = [math.dist((mat[p][1]['x'], mat[p][1]['y'], mat[p][1]['z']), hp) for p in pairs if p in mat]
    frame = sum(1 for a, b in pairs if types[a] in FRAME and types[b] in FRAME)
    frame_total = sum(1 for bb in sc['bonds'] if groups[bb['node0']].startswith('framed-house') and types[bb['node0']] in FRAME and types[bb['node1']] in FRAME)
    roof = sum(1 for a, b in pairs if types[a] in ROOF or types[b] in ROOF)
    roof_total = sum(1 for bb in sc['bonds'] if groups[bb['node0']].startswith('framed-house') and (types[bb['node0']] in ROOF or types[bb['node1']] in ROOF))
    skin = sum(1 for p in pairs if p in mat and any(s in names[mat[p][0]] for s in SKIN_MATS))
    far4 = sum(1 for x in d if x > 4); far8 = sum(1 for x in d if x > 8)
    top = collections.Counter(names[mat[p][0]] for p in pairs if p in mat).most_common(4)
    print(f"{tid:26s} {len(pairs):7d} {far4:6d} {far8:6d} {frame:5d}/{frame_total:<5d} {roof:4d}/{roof_total:<4d} {skin:6d} {max(d) if d else 0:6.1f}  "
          + ', '.join(f'{k} {v}' for k, v in top))
