#!/usr/bin/env python3
"""Verify Vehicle2/native-fracture coupling against an isolated ABI 22 SDK.

Runs real local GPU tests sequentially. By default this runs the foundation and
stronger-material control. --authored-fixtures instead runs complete authored
vehicles in free fall, nominal impacts and severe wheel-loss impacts. Neither
suite qualifies moving suspension, road handling, browser rendering or performance.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import math


AUTHORED_MODELS = {'buggy', 'trophy', 'rally', 'monster', 'derby', 'sprint'}
AUTHORED_STRUCTURE = 200
AUTHORED_TESTS = {
    'authored_vehicle_native_registration_and_free_fall',
    'authored_vehicle_cannonball_localized_fracture',
    'authored_vehicle_heavy_impact_disables_detached_wheel',
}


def check_authored_reports(nominal, heavy):
    """Check saved physical evidence independently of the test process exit code.

    Reject incomplete/duplicated inventories and truncated aftermaths. The test
    produces one accepted frame per tick; wheel shutdown must follow committed
    ownership separation while throttle remains applied by the fixture.
    """
    failures, summary = [], []
    for label, rows, mass, speed, wheel_loss in (
        ('nominal', nominal, 30, 55, False), ('heavy', heavy, 300, 120, True)
    ):
        if len(rows) != len(AUTHORED_MODELS) or {r['model'] for r in rows} != AUTHORED_MODELS:
            failures.append(f'{label}: incomplete or duplicate model inventory')
        for row in rows:
            prefix = f'{label}/{row["model"]}'
            frames, broken = row['frames'], row['brokenBonds']
            detached = next((f['tick'] for f in frames if not f['targetAttached']), None)
            after = [f for f in frames if detached is not None and f['tick'] > detached]
            valid_disabled = [f for f in after if not f['targetAttached']
                              and f['wheelsOnRoad'] & 1 == 0
                              and math.isfinite(f['wheelSpeed']) and abs(f['wheelSpeed']) < 1e-5]
            if (row['projectileMassKg'], row['speedMps'], row['requiresWheelLoss']) != (mass, speed, wheel_loss):
                failures.append(f'{prefix}: wrong impact scenario')
            if row['error'] is not None or len(frames) != 120 or [f['tick'] for f in frames] != list(range(120)):
                failures.append(f'{prefix}: incomplete accepted aftermath')
            if any(f['error'] != 0 or f['converged'] is not True for f in frames):
                failures.append(f'{prefix}: rejected or unconverged step')
            if not any(f['contacts'] > 0 for f in frames):
                failures.append(f'{prefix}: no physical contact')
            # Gameplay bond IDs pack structure identity in the high bits. The
            # detailed stress rows use local indices, not those packed IDs.
            if not broken or len(set(broken)) != len(broken) or any(
                b >> 20 != AUTHORED_STRUCTURE or not 0 <= b & ((1 << 20)-1) < row['bonds'] for b in broken
            ):
                failures.append(f'{prefix}: missing or invalid broken bonds')
            if len(broken) * 4 >= row['bonds']:
                failures.append(f'{prefix}: widespread fracture')
            if len(valid_disabled) != len(after):
                failures.append(f'{prefix}: disconnected wheel still active or reattached')
            if row['disabledWheelTicks'] != len(valid_disabled) or (wheel_loss and len(valid_disabled) < 30):
                failures.append(f'{prefix}: insufficient verified wheel shutdown')
            summary.append(dict(scenario=label, model=row['model'], chunks=row['chunks'], hulls=row['hulls'],
                                bonds=row['bonds'], brokenBonds=len(broken), acceptedTicks=len(frames),
                                firstDetachedTick=detached, disabledWheelTicks=len(valid_disabled), error=row['error']))
    return failures, summary


def authored_inventory_ok(log):
    return ('test result: ok. 3 passed; 0 failed; 0 ignored;' in log
            and all(f'::{name} ...' in log for name in AUTHORED_TESTS))


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
    parser.add_argument('--authored-fixtures', type=Path,
                        help='Run full-model probes using verify-vehicle-builds.mjs output instead of the bridge fixture')
    args = parser.parse_args()
    sdk, output = args.sdk.resolve(), args.output.resolve()
    header = sdk / 'include/physx/PxDestructionScene.h'
    if not header.is_file() or '#define PX_DESTRUCTION_SCENE_VERSION 22' not in header.read_text():
        parser.error('--sdk must contain the matching packaged ABI 22 headers')
    if output.exists():
        parser.error('--output must be a new evidence directory')
    fixtures = args.authored_fixtures.resolve() if args.authored_fixtures else None
    if fixtures and not fixtures.is_file():
        parser.error('--authored-fixtures must be a prepared fixture manifest')
    manifest = sdk / 'sdk-artifacts.json'
    if not manifest.is_file():
        parser.error('the isolated SDK must carry its artifact/source manifest')
    output.mkdir(parents=True)
    root = Path(__file__).resolve().parents[1]
    paths = [manifest, *sorted((sdk / 'lib').glob('*'))]
    if fixtures:
        paths.append(fixtures)
        for fixture in json.loads(fixtures.read_text()):
            if fixture['name'] in AUTHORED_MODELS:
                metadata = Path(fixture['metadataPath']).resolve()
                paths.extend((metadata, metadata.with_name('physics.json')))
        if not all(p.is_file() for p in paths):
            parser.error('a fixture metadata or physics artifact is missing')
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
    if fixtures:
        command = ['cargo', 'test', '-p', 'web-fps-server', '--bin', 'web-fps-server',
                   '--features', 'native-destruction', 'authored_vehicle_', '--',
                   '--ignored', '--nocapture', '--test-threads=1']
    env = dict(os.environ, PHYSX_ROOT=str(sdk), CARGO_TARGET_DIR=str(args.target_dir.resolve()))
    # Exercise the nonblocking fetch path on the deliberate rejection too.
    # An error must terminate polling rather than masquerade as "not ready".
    env['VIBE_PHYSX_GPU_SAMPLE_TICKS'] = '1'
    if fixtures:
        env.update(VIBE_VEHICLE_BUILD_FIXTURES=str(fixtures),
                   VIBE_VEHICLE_FRACTURE_REPORT=str(output / 'cannon.json'))
    if sys.platform == 'darwin':
        env.update(CUMETAL_USE_METAL_DEVICE_ADDRESSES='1', CUMETAL_SYNC_EACH_LAUNCH='0')
        if overlay:
            env['DYLD_LIBRARY_PATH'] = str(overlay)
        elif env.get('DYLD_LIBRARY_PATH'):
            parser.error('use --runtime-overlay instead of an unrecorded DYLD_LIBRARY_PATH')
    report = {'status': 'running', 'command': command, 'sdk': str(sdk), 'artifacts': artifacts,
              'suite': 'authored' if fixtures else 'bridge',
              'runtimeOverlay': str(overlay) if overlay else None,
              'gpuSampleTicks': 1,
              'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary', 'HEAD', '--', 'physx-bridge'], cwd=root)).hexdigest(),
              'fixture': {'chunks': 6, 'bonds': 5, 'projectileMassKg': 300,
                          'idleTicks': 180, 'drivingTicks': 120, 'impactTicks': 120},
              'garageVehicleQualified': False, 'remoteCudaQualified': False, 'performanceQualified': False}
    report['sourceFiles'] = {str(p.relative_to(root)): digest(p)
        for p in (root / 'physx-bridge').rglob('*')
        if p.is_file() and p.suffix in ('.rs', '.cc', '.h')}
    if fixtures:
        report['fixture'] = {'manifest': str(fixtures), 'models': sorted(AUTHORED_MODELS),
                             'freeFallTicks': 30, 'impactTicks': 120,
                             'nominal': {'massKg': 30, 'speedMps': 55},
                             'heavy': {'massKg': 300, 'speedMps': 120}}
        report['sourceFiles'].update({str(p.relative_to(root)): digest(p)
            for folder in ('server/src/physx_runtime', 'server/src/vehicle_assets', 'client/src/vehicles')
            for p in (root / folder).rglob('*') if p.is_file()})
        for name in ('server/src/physx_runtime.rs', 'server/src/vehicle_assets.rs',
                     'server/src/garage_bombardment.rs'):
            report['sourceFiles'][name] = digest(root / name)
    path = output / 'report.json' 
    path.write_text(json.dumps(report, indent=2) + '\n')
    with (output / 'tests.log').open('w') as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    log = (output / 'tests.log').read_text()
    # Fail if selection drifted, tests were merely compiled, or a gate disappeared.
    detached = re.search(r'broken=1, disabled-wheel ticks=(\d+)', log)
    inventory_ok = ('test result: ok. 13 passed; 0 failed; 0 ignored;' in log
                    and 'test result: ok. 2 passed; 0 failed; 0 ignored;' in log
                    and 'test native_vehicle_accepts_small_authored_com_offsets ...' in log
                    and 'test native_bond_observation_includes_bending_and_material_verdict ...' in log
                    and 'test native_bond_stress_respects_unequal_authored_masses ...' in log
                    and 'test native_unconverged_stress_rejects_weak_material_damage ...' in log
                    and detached is not None and int(detached[1]) > 30
                    and 'broken=0, disabled-wheel ticks=0' in log)
    evidence_errors = []
    if fixtures:
        inventory_ok = authored_inventory_ok(log)
        try:
            evidence_errors, report['impacts'] = check_authored_reports(
                json.loads((output / 'cannon.json').read_text()),
                json.loads((output / 'cannon-heavy.json').read_text()))
        except (OSError, ValueError, KeyError, TypeError) as error:
            evidence_errors = [f'Missing or malformed impact evidence: {error}']
    unchanged = all(digest(Path(p)) == expected for p, expected in artifacts.items())
    source_unchanged = all(digest(root / p) == expected for p, expected in report['sourceFiles'].items())
    report.update(exitCode=result.returncode, inventoryVerified=inventory_ok, artifactsUnchanged=unchanged, sourceUnchanged=source_unchanged,
                  evidenceErrors=evidence_errors,
                  status='passed' if result.returncode == 0 and inventory_ok and unchanged and source_unchanged and not evidence_errors else 'failed')
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(path)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
