#!/usr/bin/env python3
"""hang_analyze.py names the stuck work from synthetic hang-forensics runs.

    python3 scripts/ops/test_hang_analyze.py
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hang_analyze  # noqa: E402

SUBMIT = 'CUMETAL_SUBMIT seq={seq} kind=batch stream=0x1 dispatches=3 commit_s={t:.6f} kernels={k}'
COMMIT = ('CUMETAL_COMMIT seq={seq} kind=batch stream=0x1 dispatches=3 commit_s={t:.6f} gpu_start_s={t:.6f} '
          'gpu_end_s={e:.6f} done_s={e:.6f} steady_commit_ns=1 waits=0 status={st} error={er} '
          'error_text="{tx}" kernels={k}')
HEADER = 'epoch\tuptime_s\tws_ms\tgpu_device_pct\tgpu_renderer_pct\tload1\ttop_cpu'


def run(app, trace, samples):
    d = tempfile.mkdtemp(prefix='hang-test-')
    for name, lines in (('app.log', app), ('trace.log', trace), ('samples.tsv', samples)):
        with open(os.path.join(d, name), 'w') as f:
            f.write('\n'.join(lines) + '\n')
    return hang_analyze.analyze(d)


class Analyze(unittest.TestCase):
    def test_physics_kernel_that_never_completes(self):
        app = [SUBMIT.format(seq=1, t=10.0, k='prepare,solve'),
               COMMIT.format(seq=1, t=10.0, e=10.001, st=4, er=0, tx='', k='prepare,solve'),
               SUBMIT.format(seq=2, t=10.016, k='stressRootWalk,cycle'),
               'some unrelated line']
        trace = ['10.0000 physx simulate step=7 world=0x5', '10.0001 physx simulated step=7 world=0x5',
                 '10.0002 physx fetch step=7 world=0x5', '10.0100 js submit frame=3 buffers=1',
                 '10.0101 js submitted frame=3', '10.0120 js done frame=3']
        samples = [HEADER, '1\t10.5\t55\t30\t20\t2.0\tmystral:90', '2\t11.0\ttimeout\t100\t0\t2.0\tmystral:90']
        text = run(app, trace, samples)
        self.assertIn('NEVER COMPLETED seq=2', text)
        self.assertIn('stressRootWalk, cycle', text)
        self.assertIn('last phase "fetch step=7 world=0x5"', text)
        self.assertIn('never finished', text)
        self.assertIn('WindowServer stall onset: uptime 11.000', text)
        self.assertIn('names the kernels (physics)', text)

    def test_gpu_timeout_reported(self):
        app = [SUBMIT.format(seq=1, t=5.0, k='solve'),
               COMMIT.format(seq=1, t=5.0, e=7.0, st=5, er=2,
                             tx='Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)', k='solve')]
        text = run(app, [], [HEADER])
        self.assertIn('FAILED seq=1 status=5 error=2', text)
        self.assertIn('kIOGPUCommandBufferCallbackErrorTimeout', text)

    def test_rendering_side_hang(self):
        app = [SUBMIT.format(seq=1, t=1.0, k='a'), COMMIT.format(seq=1, t=1.0, e=1.001, st=4, er=0, tx='', k='a')]
        trace = [f'{1 + i * 0.016:.4f} js submit frame={i}' for i in range(1, 7)] + ['1.02 js done frame=1']
        text = run(app, trace, [HEADER, '1\t2.0\t3500\t100\t100\t1.0\tmystral:50'])
        self.assertIn('submitted and never finished', text)
        self.assertIn('hang is on the rendering side', text)

    def test_quiet_run(self):
        app = [SUBMIT.format(seq=1, t=1.0, k='a'), COMMIT.format(seq=1, t=1.0, e=1.001, st=4, er=0, tx='', k='a')]
        text = run(app, ['1.0 physx fetched step=1 world=0x1 ms=2.0'], [HEADER, '1\t2.0\t50\t10\t5\t1.0\tx:1'])
        self.assertIn('no hang in this run', text)
        self.assertIn('0 never completed', text)


if __name__ == '__main__':
    unittest.main()
