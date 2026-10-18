"""Independent analytic checks for the captured-equation inspector (numpy required)."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('inspector', Path(__file__).resolve().parents[1] / 'inspect-vehicle-stress-capture.py')
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)

class CaptureInspectorTests(unittest.TestCase):
    def fixture(self, directory):
        path = Path(directory) / 'chain.solve-0.json'
        nodes = np.zeros(3, dtype=inspector.NODE)
        nodes['inertia'] = 1
        nodes['threshold'] = 1e-5
        nodes['rhs'][0, 3] = nodes['residual'][0, 3] = 1
        nodes['rhs'][1, 3] = nodes['residual'][1, 3] = -1
        bonds = np.zeros(2, dtype=inspector.BOND)
        bonds['first'], bonds['second'] = [0, 1], [1, 2]
        bonds['health'] = bonds['scale'] = 1
        # Zero lever arms isolate six identical 3-node chain Laplacians:
        # eigenvalues {0,1,3}, each repeated six times; ||B^T rhs||^2 = 5.
        nodes.tofile(path.with_suffix('.nodes.bin'))
        bonds.tofile(path.with_suffix('.bonds.bin'))
        path.write_text(json.dumps(dict(version=1, solve=0, node_count=3, bond_count=2, record_bytes=64, endian='little')))
        return path, nodes

    def test_analytic_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _ = self.fixture(directory)
            row = inspector.inspect(path)['components'][0]
            self.assertFalse(row['anchored'])
            self.assertEqual(row['initialGradientSquared'], 5)
            self.assertEqual(row['warmResidualScaledDiscrepancy'], 0)
            np.testing.assert_allclose(row['smallestEigenvalues'], [0]*6+[1]*6, atol=1e-14)
            self.assertAlmostEqual(row['largestEigenvalue'], 3)

    def test_corrupted_residual_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path, nodes = self.fixture(directory)
            nodes['residual'][0, 3] += 0.1
            nodes.tofile(path.with_suffix('.nodes.bin'))
            with self.assertRaisesRegex(AssertionError, 'capture disagrees'):
                inspector.inspect(path)

    def test_offset_signs_and_nonzero_warm_impulse(self):
        with tempfile.TemporaryDirectory() as directory:
            path, nodes = self.fixture(directory)
            bonds = np.fromfile(path.with_suffix('.bonds.bin'), dtype=inspector.BOND)
            bonds['offset0'][0] = [0, 2, 0]
            bonds['offset1'][0] = [0, -3, 0]
            # A +X force at either end produces -r cross F in the
            # angular rows. The second node carries the opposite bond sign.
            bonds['warm'][0, 3] = 4
            nodes['residual'] = nodes['rhs']
            nodes['residual'][0, 2] -= 8
            nodes['residual'][0, 3] -= 4
            nodes['residual'][1, 2] -= 12
            nodes['residual'][1, 3] += 4
            nodes.tofile(path.with_suffix('.nodes.bin'))
            bonds.tofile(path.with_suffix('.bonds.bin'))
            row = inspector.inspect(path)['components'][0]
            self.assertEqual(row['warmResidualScaledDiscrepancy'], 0)

    def test_static_anchor_is_not_a_dynamic_component(self):
        with tempfile.TemporaryDirectory() as directory:
            path, nodes = self.fixture(directory)
            nodes['inertia'][2] = 0
            nodes['component'][2] = 2**32-1
            nodes.tofile(path.with_suffix('.nodes.bin'))
            row = inspector.inspect(path)['components'][0]
            self.assertTrue(row['anchored'])
            self.assertEqual(row['nodes'], 2)
            self.assertEqual(row['bonds'], 2)
            # Two dynamic nodes on a fixed-ended chain have spectrum
            # (3 +/- sqrt(5))/2, each repeated for the six spatial axes.
            np.testing.assert_allclose(row['smallestEigenvalues'],
                [(3-np.sqrt(5))/2]*6 + [(3+np.sqrt(5))/2]*6, atol=1e-14)

if __name__ == '__main__':
    unittest.main()
