#!/usr/bin/env python3
"""Export the native 444-chunk benchmark geometry/materials for playable city.

Only initial geometry and material inputs are authored. No fracture is scripted.
The game controls camera, shot origin/direction and projectile insertion; this is
not a replacement for the engine's frozen trajectory regression.
"""
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


if __name__ == '__main__':
    target = Path(__file__).resolve().parents[1] / 'destruction/assets/scenes/embedded-penetration.json'
    target.write_text(json.dumps(generate(), separators=(',', ':')) + '\n')
    print(f'{target}: 444 chunks, 896 bonds; unchanged native benchmark materials')
