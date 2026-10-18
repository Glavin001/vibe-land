"""scripts/film/stats.py on a synthetic film log (python3 -m unittest discover -s scripts/film)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stats  # noqa: E402


def synthetic_log():
    lines = ['[log] [film 0.3s] 2 shots, 2.0 s: calm, storm', '[log] [film 9.0s] rolling',
             '[log] [film 9.0s] shot 1/2 calm at 0.0s', '[log] [film 9.1s] impact {"at": 1.5, "position": [1, 2, 3]}']
    for f in range(120):
        t = f / 60
        if f == 60:
            lines.append('[log] [film 10s] shot 2/2 storm at 1.0s')
        heavy = f >= 90
        row = {'f': f, 't': t, 'tick': 300 + f, 'wallMs': 40 if heavy else 17, 'frameMs': 400 if heavy else 16,
               'stepMs': 380 if heavy else 9, 'renderMs': 12, 'physxMs': 300 if heavy else 5, 'awake': 900 if heavy else 0,
               'chunksAwake': 1200 if heavy else 0, 'broken': 20 + (f - 89) * 50 if heavy else 20, 'meteors': 1}
        lines.append(f'[log] [film {10 + t:.1f}s] stats {json.dumps(row)}')
    lines.append('[log] [film 30s] cut')
    return lines


class StatsTest(unittest.TestCase):
    def test_parse_and_summary(self):
        frames, shots, impacts = stats.parse(synthetic_log())
        self.assertEqual(len(frames), 120)
        self.assertEqual(shots, [(0.0, 'calm'), (1.0, 'storm')])
        self.assertEqual(impacts[0]['at'], 1.5)
        s = stats.summarise(frames, shots, impacts)
        calm, storm = s['shots']
        self.assertEqual((calm['frames'], storm['frames']), (60, 60))
        self.assertEqual(calm['frameMs']['max'], 17)          # wallMs (the whole frame) preferred to frameMs
        self.assertEqual(storm['frameMs']['max'], 40)
        self.assertEqual(storm['peakAwake'], 900)
        self.assertEqual(storm['bondsBroken'], 30 * 50)
        self.assertEqual((calm['impacts'], storm['impacts']), (0, 1))
        self.assertEqual(s['slowest'][0]['shot'], 'storm')

    def test_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, 'film.log')
            with open(log, 'w') as f:
                f.write('\n'.join(synthetic_log()))
            out = subprocess.run([sys.executable, os.path.join(HERE, 'stats.py'), log], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            for suffix in ('-stats.csv', '-stats.json', '-stats.html'):
                self.assertTrue(os.path.getsize(os.path.join(tmp, 'film' + suffix)) > 100, suffix)
            with open(os.path.join(tmp, 'film-stats.csv')) as f:
                self.assertEqual(len(f.read().strip().splitlines()), 121)
            with open(os.path.join(tmp, 'film-stats.html')) as f:
                page = f.read()
            self.assertIn('<svg', page)
            self.assertIn('storm', page)

    def test_no_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, 'film.log')
            with open(log, 'w') as f:
                f.write('[log] [film 1s] cut\n')
            out = subprocess.run([sys.executable, os.path.join(HERE, 'stats.py'), log], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0)
            self.assertFalse(os.path.exists(os.path.join(tmp, 'film-stats.csv')))


if __name__ == '__main__':
    unittest.main()
