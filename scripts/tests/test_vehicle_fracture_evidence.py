"""Negative controls for the full-model GPU qualification evidence gate."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'verifier', Path(__file__).resolve().parents[1] / 'verify-vehicle-bridge-fracture.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
STRUCTURE_BASE = verifier.AUTHORED_STRUCTURE << 20


def reports(heavy=False):
    return [dict(model=model, chunks=200, hulls=400, bonds=600,
                 projectileMassKg=300 if heavy else 30, speedMps=120 if heavy else 55,
                 requiresWheelLoss=heavy, error=None, brokenBonds=[STRUCTURE_BASE+2, STRUCTURE_BASE+4],
                 disabledWheelTicks=114 if heavy else 0,
                 frames=[dict(tick=t, contacts=1 if t == 0 else 0, error=0,
                              converged=True, targetAttached=not heavy or t < 5,
                              wheelSpeed=0 if heavy and t > 5 else 3, wheelsOnRoad=0)
                         for t in range(120)])
            for model in sorted(verifier.AUTHORED_MODELS)]


class VehicleFractureEvidenceTests(unittest.TestCase):
    def test_complete_converged_localized_impacts_and_functional_loss(self):
        errors, rows = verifier.check_authored_reports(reports(), reports(True))
        self.assertEqual(errors, [])
        self.assertEqual(len(rows), 12)
        self.assertTrue(all(r['disabledWheelTicks'] == 114 for r in rows if r['scenario'] == 'heavy'))

    def test_missing_and_duplicate_models_cannot_pass(self):
        for mutate in (lambda rows: rows.pop(), lambda rows: rows.__setitem__(0, copy.deepcopy(rows[1]))):
            nominal = reports()
            mutate(nominal)
            errors, _ = verifier.check_authored_reports(nominal, reports(True))
            self.assertTrue(any('inventory' in e for e in errors))

    def test_no_contact_damage_or_wrong_load_is_rejected(self):
        for field, value, expected in (
            ('brokenBonds', [], 'broken bonds'), ('brokenBonds', [STRUCTURE_BASE+2]*2, 'broken bonds'),
            ('brokenBonds', [-1], 'broken bonds'), ('brokenBonds', [STRUCTURE_BASE+600], 'broken bonds'),
            ('brokenBonds', [((verifier.AUTHORED_STRUCTURE+1) << 20)+2], 'broken bonds'),
            ('brokenBonds', [2], 'broken bonds'),
            ('brokenBonds', [STRUCTURE_BASE+i for i in range(150)], 'widespread'),
            ('projectileMassKg', 300, 'scenario'), ('speedMps', 120, 'scenario'),
            ('requiresWheelLoss', True, 'scenario'), ('error', 'GPU rejected', 'aftermath'),
        ):
            with self.subTest(field=field, value=value):
                nominal = reports()
                nominal[0][field] = value
                errors, _ = verifier.check_authored_reports(nominal, reports(True))
                self.assertTrue(any(expected in e for e in errors), errors)
        nominal = reports()
        for f in nominal[0]['frames']:
            f['contacts'] = 0
        self.assertTrue(any('no physical contact' in e for e in verifier.check_authored_reports(nominal, reports(True))[0]))

    def test_failed_repeated_or_missing_step_cannot_pass(self):
        for field, value in (('converged', False), ('error', 4096), ('tick', 3)):
            nominal = reports()
            nominal[0]['frames'][8][field] = value
            self.assertTrue(verifier.check_authored_reports(nominal, reports(True))[0])
        nominal = reports()
        nominal[0]['frames'].pop()
        self.assertTrue(verifier.check_authored_reports(nominal, reports(True))[0])

    def test_ownership_loss_must_disable_wheel_for_the_remaining_aftermath(self):
        for field, value in (('targetAttached', True), ('wheelSpeed', 1),
                             ('wheelSpeed', float('nan')), ('wheelsOnRoad', 1)):
            with self.subTest(field=field):
                heavy = reports(True)
                heavy[0]['frames'][12][field] = value
                errors, _ = verifier.check_authored_reports(reports(), heavy)
                self.assertTrue(any('still active or reattached' in e for e in errors), errors)
        heavy = reports(True)
        for f in heavy[0]['frames']:
            f['targetAttached'] = True
        heavy[0]['disabledWheelTicks'] = 0
        self.assertTrue(any('shutdown' in e for e in verifier.check_authored_reports(reports(), heavy)[0]))

    def test_fabricated_shutdown_counter_cannot_pass(self):
        heavy = reports(True)
        heavy[0]['disabledWheelTicks'] += 1
        self.assertTrue(any('shutdown' in e for e in verifier.check_authored_reports(reports(), heavy)[0]))

    def test_compilation_or_partial_test_selection_is_not_execution(self):
        names = '\n'.join(f'test physx_runtime::vehicle_fracture_tests::{name} ... ok'
                          for name in verifier.AUTHORED_TESTS)
        passed = 'test result: ok. 3 passed; 0 failed; 0 ignored;'
        self.assertTrue(verifier.authored_inventory_ok(names + '\n' + passed))
        self.assertFalse(verifier.authored_inventory_ok(names))
        self.assertFalse(verifier.authored_inventory_ok(passed))
        self.assertFalse(verifier.authored_inventory_ok(names + '\ntest result: ok. 0 passed; 0 failed; 3 ignored;'))


if __name__ == '__main__':
    unittest.main()
