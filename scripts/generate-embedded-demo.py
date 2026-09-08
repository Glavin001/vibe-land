#!/usr/bin/env python3
"""Export the native 444-chunk benchmark geometry/materials for playable city.

Only initial geometry and material inputs are authored. No fracture is scripted.
The game controls camera, shot origin/direction and projectile insertion; this is
not a replacement for the engine's frozen trajectory regression.
"""
import argparse
import copy
import json
from pathlib import Path


def vec(x, y, z):
    return dict(x=x, y=y, z=z)


def generate():
    nodes, bonds, sizes, colliders, roles = [], [], [], [], []
    ids = {}
    half = 0.48
    volume = 8 * half**3
    for y in range(12):
        for z in range(8):
            for x in range(8):
                if x not in (0, 7) and z not in (0, 7) and y % 4:
                    continue
                frame = y % 4 == 0 or (x in (0, 7) and z in (0, 7))
                p = vec(x - 3.5, y + 0.5, z - 3.5)
                index = len(nodes)
                ids[x, y, z] = index
                nodes.append(dict(centroid=p, mass=1000 * volume if y else 0,
                                  volume=volume, m=int(frame)))
                sizes.append(vec(2 * half, 2 * half, 2 * half))
                colliders.append(dict(kind='cuboid', halfExtents=vec(half, half, half)))
                roles.append('foundation' if y == 0 else 'slab' if y % 4 == 0 else 'wall')
                for delta in [(-1, 0, 0), (0, -1, 0), (0, 0, -1)]:
                    other = ids.get((x + delta[0], y + delta[1], z + delta[2]))
                    if other is None:
                        continue
                    q = nodes[other]['centroid']
                    bonds.append(dict(node0=other, node1=index,
                        centroid={k: (p[k] + q[k]) / 2 for k in p},
                        normal={k: p[k] - q[k] for k in p}, area=4 * half**2,
                        m=int(frame and nodes[other]['m'] == 1)))
    materials = []
    for name, strength, color in [('panel', 24, '#beb9ad'), ('frame', 24 * 40, '#647e96')]:
        materials.append(dict(name=name, compressionElastic=250000 * strength,
            compressionFatal=500000 * strength, tensionElastic=30000 * strength,
            tensionFatal=60000 * strength, shearElastic=80000 * strength,
            shearFatal=160000 * strength, elasticModulus=30e9,
            residualAreaFraction=0, color=color, roughness=0.9))
    assert len(nodes) == 444 and len(bonds) == 896
    return dict(version=2, key='embedded-penetration', title='Native GPU demolition building',
        defaults=dict(solver=dict(materials=materials)),
        scenario=dict(nodes=nodes, bonds=bonds, nodeSizes=sizes,
                      nodeColliders=colliders, nodeTypes=roles))


def generate_tile():
    """Four disconnected buildings per asset; wire IDs identify asset instances.

    A 64-instance city then has 256 buildings without spending more structure
    bits or creating bonds between buildings. The 17.96 m pitch leaves 10 m
    between collision faces, matching the game's city layout rule.
    """
    source = generate()
    result = copy.deepcopy(source)
    result.update(key='embedded-four-buildings', title='Four native GPU demolition buildings')
    output = result['scenario'] = {key: [] for key in source['scenario']}
    for z in (-8.98, 8.98):
        for x in (-8.98, 8.98):
            offset = len(output['nodes'])
            part = copy.deepcopy(source['scenario'])
            for item in part['nodes'] + part['bonds']:
                item['centroid']['x'] += x
                item['centroid']['z'] += z
            for bond in part['bonds']:
                bond['node0'] += offset
                bond['node1'] += offset
            for key, values in part.items():
                output[key].extend(values)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--four-buildings', action='store_true',
                        help='author a disconnected four-building tile for the 256-building city')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    pack = generate_tile() if args.four_buildings else generate()
    target = args.output or (Path(__file__).resolve().parents[1] /
                            f"destruction/assets/scenes/{pack['key']}.json")
    target.write_text(json.dumps(pack, separators=(',', ':')) + '\n')
    scene = pack['scenario']
    print(f"{target}: {len(scene['nodes'])} chunks, {len(scene['bonds'])} bonds; "
          'unchanged native benchmark materials')
