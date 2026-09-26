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
    parser.add_argument('--runtime-overlay', type=Path,
                        help='Explicit macOS diagnostic runtime directory; hashes are included in evidence')
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
    overlay = args.runtime_overlay.resolve() if args.runtime_overlay else None
    if overlay:
        if sys.platform != 'darwin':
            parser.error('--runtime-overlay is only supported for the local macOS diagnostic workflow')
        overlay_paths = [overlay / name for name in ('libPhysXGpuActivity_64.dylib',
            'libPhysXDestructionGpuRuntime_64.dylib', 'libcumetal.dylib')]
        if not all(p.is_file() for p in overlay_paths):
            parser.error('--runtime-overlay must include both matching GPU modules and libcumetal')
        paths.extend(overlay_paths)
    artifacts = {str(p): digest(p) for p in paths if p.is_file()}
    command = ['cargo', 'test', '-p', 'vibe-land-physx-bridge', '--features', 'native-destruction',
               '--test', 'native_vehicle_fracture', '--test', 'native_gameplay', '--',
               '--include-ignored', '--nocapture', '--test-threads=1']
    env = dict(os.environ, PHYSX_ROOT=str(sdk), CARGO_TARGET_DIR=str(args.target_dir.resolve()))
    if sys.platform == 'darwin':
        env.update(CUMETAL_USE_METAL_DEVICE_ADDRESSES='1', CUMETAL_SYNC_EACH_LAUNCH='0')
        if overlay:
            env['DYLD_LIBRARY_PATH'] = str(overlay)
        elif env.get('DYLD_LIBRARY_PATH'):
            parser.error('use --runtime-overlay instead of an unrecorded DYLD_LIBRARY_PATH')
    report = {'status': 'running', 'command': command, 'sdk': str(sdk), 'artifacts': artifacts,
              'runtimeOverlay': str(overlay) if overlay else None,
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
    inventory_ok = ('test result: ok. 12 passed; 0 failed; 0 ignored;' in log
                    and 'test result: ok. 2 passed; 0 failed; 0 ignored;' in log
                    and 'test native_vehicle_accepts_small_authored_com_offsets ...' in log
                    and 'test native_bond_observation_includes_bending_and_material_verdict ...' in log
                    and 'test native_bond_stress_respects_unequal_authored_masses ...' in log
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
