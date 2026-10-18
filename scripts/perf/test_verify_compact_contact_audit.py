import hashlib
import unittest
from unittest.mock import patch
import verify_compact_contact_audit as audit


class AuditCoverageTest(unittest.TestCase):
    def setUp(self):
        self.tape = b'unit-test shot bytes'
        self.sidecar = dict(manifestHash=audit.MANIFEST, chunks=96420, membershipMismatchTicks=0,
                            ticks=1200, physicsHz=60, grid=2, shotTapeReplay=True, shotInputs=200)
        self.rows = [dict(tick=i, awake=5500, resim_passes=1, resim_restore=3.0, resim_step=5.0)
                     for i in range(1200)]
        self.log = '[compact-contact-audit] batches=2400 verified=2400 records=1000000 pairs=100000 mismatches=0'
        self.addCleanup(patch.stopall)
        patch.object(audit, 'TAPE_SHA256', hashlib.sha256(self.tape).hexdigest()).start()

    def verify(self):
        return audit.verify(self.sidecar, self.rows, self.log, self.tape)

    def test_complete_coverage(self):
        self.assertEqual(self.verify()['heavy_replay_ticks'], 1200)

    def test_incomplete_or_wrong_scene(self):
        for key, value in [('manifestHash','wrong'), ('chunks',86966), ('membershipMismatchTicks',1),
                           ('ticks',1199), ('physicsHz',30), ('grid',1), ('shotTapeReplay',False), ('shotInputs',199)]:
            with self.subTest(key=key):
                old = self.sidecar[key];self.sidecar[key] = value
                with self.assertRaises(ValueError): self.verify()
                self.sidecar[key] = old

    def test_unverified_or_empty_batches(self):
        original = self.log
        for replacement in ['', original+'\n'+original, original.replace('verified=2400','verified=2399'),
                            original.replace('2400','1200'), original.replace('records=1000000','records=0'),
                            original.replace('pairs=100000','pairs=0'), original.replace('mismatches=0','mismatches=1')]:
            with self.subTest(log=replacement):
                self.log = replacement
                with self.assertRaises(ValueError): self.verify()
        self.log = original

    def test_low_load_and_replay_free_runs(self):
        for change in [dict(awake=4999), dict(resim_passes=0), dict(resim_restore=0), dict(resim_step=0)]:
            with self.subTest(change=change):
                self.rows = [dict(tick=i, awake=5500, resim_passes=1, resim_restore=3.0, resim_step=5.0)
                             for i in range(1200)]
                for row in self.rows: row.update(change)
                with self.assertRaises(ValueError): self.verify()

    def test_isolated_high_load_spike_is_insufficient(self):
        for row in self.rows[19:]: row['awake'] = 0
        with self.assertRaises(ValueError): self.verify()

    def test_tick_coverage_and_tape_integrity(self):
        self.rows[1]['tick'] = 0
        with self.assertRaises(ValueError): self.verify()
        self.rows[1]['tick'] = 1
        self.tape += b'changed'
        with self.assertRaises(ValueError): self.verify()


if __name__ == '__main__':
    unittest.main()
