import csv
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('campaign', Path(__file__).with_name('gpu-activity-campaign.py'))
campaign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(campaign)


class ActivitySummaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'frames.csv'
        self.rows = [dict(trial=0, mode=mode, bodies=4, phase=phase, tick=tick,
                          step_ms=tick + 1, command_ms=2 if phase == 'mass_wake' and tick == 0 else 0)
                     for mode in campaign.MODES for phase, count in campaign.PHASES.items()
                     for tick in range(count)]

    def summarize(self):
        with self.path.open('w', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=self.rows[0].keys())
            writer.writeheader()
            writer.writerows(self.rows)
        return campaign.summarize(self.path, 4, 1)

    def test_complete_samples_p99_and_command_cost(self):
        result = self.summarize()['direct_gpu_sleep']
        self.assertEqual(result['airborne']['mean_ms'], 150.5)
        self.assertEqual(result['airborne']['p99_ms'], 297)
        self.assertEqual(result['first_wake_including_command_ms'], [3])

    def test_missing_frame_rejected(self):
        self.rows.pop()
        with self.assertRaisesRegex(ValueError, 'Incomplete'): self.summarize()

    def test_duplicate_frame_rejected(self):
        self.rows.append(self.rows[-1])
        with self.assertRaisesRegex(ValueError, 'duplicate'): self.summarize()

    def test_nonfinite_timing_rejected(self):
        self.rows[0]['step_ms'] = 'nan'
        with self.assertRaisesRegex(ValueError, 'Invalid timing'): self.summarize()

    def test_wrong_population_rejected(self):
        self.rows[0]['bodies'] = 3
        with self.assertRaisesRegex(ValueError, 'Unexpected'): self.summarize()

    def test_missing_mode_rejected(self):
        self.rows = [row for row in self.rows if row['mode'] != 'direct_gpu_sleep']
        with self.assertRaisesRegex(ValueError, 'Incomplete'): self.summarize()


if __name__ == '__main__':
    unittest.main()
