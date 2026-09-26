#!/usr/bin/env python3
"""Inspect captured native vehicle equations, without changing the simulation.

Requires numpy. Reconstructs the actual bond operator and checks the captured
warm residual. Spectra diagnose conditioning; they do not qualify a solver,
choose new tolerances, or replace native fracture results.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np

NODE = np.dtype([('inertia', '<f4', (2,)), ('rhs', '<f4', (6,)),
                 ('residual', '<f4', (6,)), ('threshold', '<f4'), ('component', '<u4')])
BOND = np.dtype([('first', '<u4'), ('second', '<u4'), ('offset0', '<f4', (3,)),
                 ('offset1', '<f4', (3,)), ('health', '<f4'), ('scale', '<f4'), ('warm', '<f4', (6,))])


def skew(v):
    x, y, z = v
    return np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]], dtype=np.float64)


def inspect(meta_path):
    meta = json.loads(meta_path.read_text())
    assert meta['version'] == 1 and meta['record_bytes'] == NODE.itemsize == BOND.itemsize == 64
    assert meta['endian'] == 'little'
    nodes_path = meta_path.with_suffix('.nodes.bin')
    bonds_path = meta_path.with_suffix('.bonds.bin')
    nodes, bonds = np.fromfile(nodes_path, dtype=NODE), np.fromfile(bonds_path, dtype=BOND)
    assert len(nodes) == meta['node_count'] and len(bonds) == meta['bond_count']
    rows = []
    for identity in np.unique(nodes['component']):
        if identity == 2**32-1:
            continue
        members = np.flatnonzero(nodes['component'] == identity)
        local = {int(node): i for i, node in enumerate(members)}
        edges = [b for b in bonds if b['health'] > 0 and
                 (int(b['first']) in local or int(b['second']) in local)]
        matrix = np.zeros((6 * len(members), 6 * len(edges)), dtype=np.float64)
        anchored = False
        for e, bond in enumerate(edges):
            for side, key in enumerate(('first', 'second')):
                node = int(bond[key])
                if node not in local:
                    assert np.all(nodes[node]['inertia'] == 0), 'bond crosses dynamic components'
                    anchored = True
                    continue
                block = np.eye(6)
                block[:3, 3:] = -skew(bond['offset' + str(side)])
                block[:3] *= float(nodes[node]['inertia'][0])
                block[3:] *= float(nodes[node]['inertia'][1])
                block *= float(bond['scale']) * (1 if side == 0 else -1)
                i = local[node] * 6
                matrix[i:i+6, e*6:e*6+6] = block
        rhs = nodes['rhs'][members].astype(np.float64).ravel()
        warm = np.array([b['warm'] for b in edges], dtype=np.float64).ravel()
        residual = rhs - matrix @ warm
        stored = nodes['residual'][members].astype(np.float64).ravel()
        scale = np.abs(rhs) + np.abs(matrix) @ np.abs(warm) + 1
        discrepancy = float(np.max(np.abs(residual-stored) / scale))
        assert discrepancy <= 8*np.finfo(np.float32).eps, 'capture disagrees with independent bond operator'
        thresholds = nodes['threshold'][members]
        assert np.all(thresholds == thresholds[0]), 'inconsistent native component threshold'
        normal = matrix @ matrix.T
        gradient = matrix.T @ residual
        eigenvalues = np.linalg.eigvalsh(normal)
        diagonal = np.diag(normal)
        # This is merely a scale diagnostic. No singular value is deleted and
        # no independently chosen rank threshold becomes an acceptance test.
        scaled = normal / np.sqrt(diagonal[:, None] * diagonal[None, :])
        scaled_eigenvalues = np.linalg.eigvalsh(scaled)
        rows.append(dict(component=int(identity), nodes=len(members), bonds=len(edges), anchored=anchored,
                         nativeThresholdSquared=float(thresholds[0]),
                         initialGradientSquared=float(gradient @ gradient),
                         warmResidualScaledDiscrepancy=discrepancy,
                         inertiaWeightsMin=float(nodes['inertia'][members].min()),
                         inertiaWeightsMax=float(nodes['inertia'][members].max()),
                         diagonalMin=float(diagonal.min()), diagonalMax=float(diagonal.max()),
                         smallestEigenvalues=eigenvalues[:12].tolist(), largestEigenvalue=float(eigenvalues[-1]),
                         diagonalScaledSmallestEigenvalues=scaled_eigenvalues[:12].tolist(),
                         diagonalScaledLargestEigenvalue=float(scaled_eigenvalues[-1])))
    return dict(capture=str(meta_path), solve=meta['solve'], components=rows,
                hashes={str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in (meta_path, nodes_path, bonds_path)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('captures', nargs='+', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('--output must be a new file')
    report = dict(scope='independent equation and conditioning diagnostic', solverQualified=False,
                  captures=[inspect(path) for path in args.captures])
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(args.output)


if __name__ == '__main__':
    main()
