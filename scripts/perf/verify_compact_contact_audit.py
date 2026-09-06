#!/usr/bin/env python3
"""Reject incomplete compact-contact audits; this command never starts a GPU job.

A passing contact audit is boundary equivalence evidence only. Performance,
settling, scenario, native integration and multiplayer gates remain separate.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re

MANIFEST = '1172d302f5598a5f366d8149b3772f8a9642788f42b753f00e8c3607fbe09c50'
TAPE_SHA256 = '4d333252d93e2bc02874ef6d8a80304caae07d645d5243b14dbb529ff01aed79'


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def verify(sidecar, rows, log, tape_bytes):
    require(sidecar.get('manifestHash') == MANIFEST and sidecar.get('chunks') == 96420,
            'audit must exercise the deployed 96,420-chunk manifest')
    require(sidecar.get('membershipMismatchTicks') == 0, 'membership mismatch or missing evidence')
    require(sidecar.get('ticks') == 1200 and len(rows) == 1200, 'audit must complete all 1,200 ticks')
    require([int(r['tick']) for r in rows] == list(range(1200)), 'missing, repeated or reordered metric ticks')
    require(sidecar.get('physicsHz') == 60 and sidecar.get('grid') == 2, 'wrong timestep or scene grid')
    require(sidecar.get('shotTapeReplay') is True and sidecar.get('shotInputs') == 200,
            'audit must replay all 200 recorded shot inputs')
    require(hashlib.sha256(tape_bytes).hexdigest() == TAPE_SHA256, 'recorded shot input bytes changed')
    matches = re.findall(r'\[compact-contact-audit\] batches=(\d+) verified=(\d+) records=(\d+) pairs=(\d+) mismatches=(\d+)', log)
    require(len(matches) == 1, 'missing or ambiguous final native audit totals')
    batches, verified, records, pairs, mismatches = map(int, matches[0])
    replay_passes = sum(int(r['resim_passes']) for r in rows)
    require(batches == verified and batches >= len(rows) + replay_passes,
            'every initial and replay contact batch must be audited')
    require(records > 0 and pairs > 0 and mismatches == 0, 'empty audit or contact/event mismatch')
    heavy = [r for r in rows if int(r['awake']) >= 5000]
    require(len(heavy) >= 20, 'insufficient coverage at 5,000+ awake bodies (need 20 ticks)')
    heavy_replay = [r for r in heavy if int(r['resim_passes']) > 0
                    and float(r['resim_restore']) > 0 and float(r['resim_step']) > 0]
    require(heavy_replay, 'no measured restore and physics replay at 5,000+ awake bodies')
    return {'audit_batches': batches, 'verified_batches': verified,
            'verified_records': records, 'verified_pairs': pairs, 'mismatches': mismatches,
            'max_awake': max(int(r['awake']) for r in rows), 'heavy_ticks': len(heavy),
            'heavy_replay_ticks': len(heavy_replay), 'replay_passes': replay_passes,
            'scope': 'Full-batch boundary equivalence; not performance, settling or deployment qualification.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    b = args.directory
    with (b / 'metrics.csv').open() as f:
        rows = list(csv.DictReader(f))
    try:
        result = verify(json.loads((b / 'metrics.sidecar.json').read_text()), rows,
                        (b / 'native.log').read_text(), (b / 'shots.json').read_bytes())
    except (ValueError, KeyError) as error:
        parser.exit(1, f'FAIL: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
