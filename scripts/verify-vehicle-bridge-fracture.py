#!/usr/bin/env python3
"""Verify Vehicle2/native-fracture coupling against an isolated ABI 22 SDK.

Runs real local GPU tests sequentially, including the stronger-material control
and existing city fracture/reset regressions. Does not qualify garage assets,
nominal cannon tuning, browser rendering, remote CUDA, or performance.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--target-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sdk, output = args.sdk.resolve(), args.output.resolve()
    header = sdk / 'include/physx/PxDestructionScene.h'
    if not header.is_file() or '#define PX_DESTRUCTION_SCENE_VERSION 22' not in header.read_text():
        parser.error('--sdk must contain the matching packaged ABI 22 headers')
    if output.exists():
        parser.error('--output must be a new evidence directory')
    manifest = sdk / 'sdk-artifacts.json'
    if not manifest.is_file():
        parser.error('the isolated SDK must carry its artifact/source manifest')
    output.mkdir(parents=True)
    root = Path(__file__).resolve().parents[1]
    paths = [manifest, *sorted((sdk / 'lib').glob('*'))]
    artifacts = {str(p): digest(p) for p in paths if p.is_file()}
    command = ['cargo', 'test', '-p', 'vibe-land-physx-bridge', '--features', 'native-destruction',
               '--test', 'native_vehicle_fracture', '--test', 'native_gameplay', '--',
               '--include-ignored', '--nocapture', '--test-threads=1']
    env = dict(os.environ, PHYSX_ROOT=str(sdk), CARGO_TARGET_DIR=str(args.target_dir.resolve()))
    if sys.platform == 'darwin':
        env.update(CUMETAL_USE_METAL_DEVICE_ADDRESSES='1', CUMETAL_SYNC_EACH_LAUNCH='0')
    report = {'status': 'running', 'command': command, 'sdk': str(sdk), 'artifacts': artifacts,
              'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary', 'HEAD', '--', 'physx-bridge'], cwd=root)).hexdigest(),
              'fixture': {'chunks': 6, 'bonds': 5, 'projectileMassKg': 300,
                          'idleTicks': 180, 'drivingTicks': 120, 'impactTicks': 120},
              'garageVehicleQualified': False, 'remoteCudaQualified': False, 'performanceQualified': False}
    report['sourceFiles'] = {str(p.relative_to(root)): digest(p)
        for p in (root / 'physx-bridge').rglob('*')
        if p.is_file() and p.suffix in ('.rs', '.cc', '.h')}
    path = output / 'report.json' 
    path.write_text(json.dumps(report, indent=2) + '\n')
    with (output / 'tests.log').open('w') as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    log = (output / 'tests.log').read_text()
    # Fail if selection drifted, tests were merely compiled, or a gate disappeared.
    detached = re.search(r'broken=1, disabled-wheel ticks=(\d+)', log)
    inventory_ok = ('test result: ok. 10 passed; 0 failed; 0 ignored;' in log
                    and 'test result: ok. 1 passed; 0 failed; 0 ignored;' in log
                    and detached is not None and int(detached[1]) > 30
                    and 'broken=0, disabled-wheel ticks=0' in log)
    unchanged = all(digest(Path(p)) == expected for p, expected in artifacts.items())
    source_unchanged = all(digest(root / p) == expected for p, expected in report['sourceFiles'].items())
    report.update(exitCode=result.returncode, inventoryVerified=inventory_ok, artifactsUnchanged=unchanged, sourceUnchanged=source_unchanged,
                  status='passed' if result.returncode == 0 and inventory_ok and unchanged and source_unchanged else 'failed')
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(path)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
