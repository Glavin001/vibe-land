import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('inspection', Path(__file__).resolve().parents[1] / 'inspect-vehicle-impact.py')
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


def fixture():
    bond = dict(a='wheel', b='hub', area=.002, attachment='wheel-mount', strength=dict(
        compressionElastic=100., tensionElastic=50., shearElastic=25.))
    asset = dict(parts=[dict(id='wheel', name='Tire'), dict(id='hub', name='Hub')], bonds=[bond])
    verdict = dict(bond=0, part0='hub', part1='wheel', area=.002, compressionPa=20.,
        tensionPa=30., shearPa=10., utilisation=.6, damageArea=0.)
    report = dict(model='buggy', chunks=2, bonds=1, target=0, projectileMassKg=30, speedMps=55,
        error=None, brokenBonds=[], impactVerdicts=[dict(tick=0, bonds=[verdict])],
        frames=[dict(tick=0, error=0, converged=True, targetAttached=True)])
    return asset, report


class ImpactInspectionTests(unittest.TestCase):
    def test_peak_ratios_and_native_breakage_are_distinct(self):
        asset, report = fixture()
        frame = copy.deepcopy(report['impactVerdicts'][0])
        frame['tick'] = 1
        frame['bonds'][0].update(shearPa=40., utilisation=1.6, damageArea=.001)
        report['impactVerdicts'].append(frame)
        report['brokenBonds'] = [200 << 20]
        report['frames'].append(dict(tick=1, error=0, converged=True, targetAttached=False))
        result = inspection.inspect_impact(report, asset)
        interface = result['targetInterfaces'][0]
        self.assertEqual(interface['peakToElasticRatio'], [.2, .6, 1.6])
        self.assertEqual(interface['samples'], 2)
        self.assertTrue(interface['broken'])
        self.assertEqual(result['firstDetachedTick'], 1)
        self.assertEqual(result['attachments']['wheel-mount'], dict(total=1, broken=1, observed=1))

    def test_missing_verdict_is_unobserved_not_zero_stress(self):
        asset, report = fixture()
        report['impactVerdicts'] = []
        result = inspection.inspect_impact(report, asset)
        self.assertIsNone(result['targetInterfaces'][0]['peaks'])
        self.assertIsNone(result['targetInterfaces'][0]['peakToElasticRatio'])
        self.assertEqual(result['observedBonds'], 0)

    def test_rejected_steps_remain_visible(self):
        asset, report = fixture()
        report['error'] = 'nonconvergence'
        report['frames'][0].update(error=4096, converged=False)
        result = inspection.inspect_impact(report, asset)
        self.assertEqual(result['error'], 'nonconvergence')
        self.assertEqual(result['rejectedTicks'], [0])

    def test_mismatched_or_invalid_verdicts_fail(self):
        for field, value in [('bond', -1), ('bond', 1), ('part0', 'chassis'),
            ('area', .02), ('shearPa', float('nan')), ('damageArea', -1.)]:
            with self.subTest(field=field):
                asset, report = fixture()
                report['impactVerdicts'][0]['bonds'][0][field] = value
                with self.assertRaises(ValueError):
                    inspection.inspect_impact(report, asset)

    def test_duplicate_ticks_rows_and_wrong_packed_ids_fail(self):
        for case in ['tick', 'row', 'structure', 'local', 'duplicate', 'counts']:
            with self.subTest(case=case):
                asset, report = fixture()
                if case == 'tick': report['impactVerdicts'] *= 2
                elif case == 'row': report['impactVerdicts'][0]['bonds'] *= 2
                elif case == 'structure': report['brokenBonds'] = [201 << 20]
                elif case == 'local': report['brokenBonds'] = [(200 << 20) + 1]
                elif case == 'duplicate': report['brokenBonds'] = [200 << 20] * 2
                elif case == 'counts': report['chunks'] = 3
                with self.assertRaises(ValueError):
                    inspection.inspect_impact(report, asset)


if __name__ == '__main__':
    unittest.main()
