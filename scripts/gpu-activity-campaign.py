#!/usr/bin/env python3
"""Validate and measure the isolated Direct GPU sleeping prototype on an idle GPU.

This runner never changes or restarts the deployed city. Stop competing GPU work
before running it. Build the SDK with the dependency's build-physx-gpu-activity.py.
"""
import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys

MODES = ('native_sleep', 'gpu_forced_awake', 'direct_gpu', 'gpu_no_sleep_flag', 'direct_gpu_sleep')
PHASES = {'airborne': 300, 'rest': 300, 'mass_wake': 60}
TESTS = ('blast_stress_physx_gpu_activity', 'blast_stress_physx_direct_gpu_resim',
         'blast_stress_physx_direct_gpu_contacts', 'blast_stress_gpu_device_input', 'blast_stress_gpu_equivalence')
TARGETS = ('gpu_activity_test', 'gpu_activity_bench', 'direct_gpu_resim_test',
           'direct_gpu_contact_test', 'gpu_device_input_test', 'gpu_stress_test')
BASE = '3ca45ad36e9755f7c8c5bea9f7c57d308d9f0c54'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def capture(*args):
    return subprocess.check_output([str(a) for a in args], text=True).strip()


def run(command, log, env, stdout=None):
    with log.open('w') as err:
        if stdout:
            with stdout.open('w') as out:
                subprocess.run([str(a) for a in command], env=env, stdout=out, stderr=err,
                               check=True, timeout=600)
        else:
            subprocess.run([str(a) for a in command], env=env, stdout=err, stderr=subprocess.STDOUT,
                           check=True, timeout=600)


def summarize(path, bodies, trials):
    with path.open(newline='') as stream:
        rows = list(csv.DictReader(stream))
    expected = {(t, mode, phase, tick) for t in range(trials) for mode in MODES
                for phase, count in PHASES.items() for tick in range(count)}
    samples = {}
    for row in rows:
        key = (int(row['trial']), row['mode'], row['phase'], int(row['tick']))
        values = (float(row['step_ms']), float(row['command_ms']))
        if key not in expected or key in samples or int(row['bodies']) != bodies:
            raise ValueError(f'Unexpected/duplicate benchmark sample: {key}')
        if not all(math.isfinite(v) and v >= 0 for v in values):
            raise ValueError(f'Invalid timing sample: {key}')
        samples[key] = values
    if samples.keys() != expected:
        raise ValueError(f'Incomplete benchmark: {len(samples)}/{len(expected)} samples')
    result = {}
    for mode in MODES:
        result[mode] = {}
        for phase in PHASES:
            values = sorted(v[0] for k, v in samples.items() if k[1:3] == (mode, phase))
            result[mode][phase] = {'samples': len(values), 'mean_ms': statistics.mean(values),
                'p99_ms': values[math.ceil(.99 * len(values))-1],
                'trial_means_ms': [statistics.mean(v[0] for k, v in samples.items()
                    if k[:3] == (trial, mode, phase)) for trial in range(trials)]}
        result[mode]['first_wake_including_command_ms'] = [
            sum(samples[(trial, mode, 'mass_wake', 0)]) for trial in range(trials)]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dependency', type=Path, default=Path(__file__).resolve().parents[2] / 'blast-stress-solver-2')
    parser.add_argument('--sdk', type=Path, required=True, help='isolated checkout/physx directory')
    parser.add_argument('--output', type=Path, required=True, help='new output directory; existing paths are rejected')
    parser.add_argument('--bodies', type=int, default=4096)
    parser.add_argument('--trials', type=int, default=3)
    parser.add_argument('--jobs', type=int, default=8)
    parser.add_argument('--memcheck', action='store_true')
    args = parser.parse_args()
    if not 0 < args.bodies <= 20000 or not 0 < args.trials <= 20 or args.jobs < 1:
        parser.error('bodies must be 1..20000, trials 1..20, jobs positive')
    dep, sdk, out = args.dependency.resolve(), args.sdk.resolve(), args.output.resolve()
    manifest = json.loads((sdk / 'gpu-activity-manifest.json').read_text())
    patch = dep / 'patches/physx/5.10-direct-gpu-sleep.patch'
    lib = sdk / 'bin/linux.x86_64/release'
    if manifest['base'] != BASE or manifest['patch_sha256'] != sha(patch) or manifest['feature_version'] != 1:
        raise RuntimeError('SDK provenance does not match the dependency patch.')
    for name, digest in manifest['libraries'].items():
        if Path(name).name != name or sha(lib / name) != digest:
            raise RuntimeError(f'SDK artifact mismatch: {name}')
    if 'libPhysXGpuActivity_64.so' not in manifest['libraries']:
        raise RuntimeError('Experimental GPU module is missing from the manifest.')
    processes = capture('nvidia-smi', '--query-compute-apps=pid,process_name', '--format=csv,noheader')
    if processes:
        raise RuntimeError(f'Exclusive GPU campaign requires no running compute clients:\n{processes}')
    sanitizer = shutil.which('compute-sanitizer') if args.memcheck else None
    if args.memcheck and not sanitizer:
        raise RuntimeError('compute-sanitizer is required for --memcheck')
    out.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = str(lib)  # child-only; do not mix GPU SDK modules
    build = dep / 'demos/blast-stress-demo/build-gpu-activity'
    run(['cmake', '-S', dep / 'demos/blast-stress-demo', '-B', build,
         f'-DPHYSX_ROOT={sdk}', f'-DPHYSX_LIB_DIR={lib}', '-DBLAST_ENABLE_CUDA_STRESS=ON',
         '-DCMAKE_BUILD_TYPE=Release'], out / 'configure.log', env)
    run(['cmake', '--build', build, '--target', *TARGETS, f'-j{args.jobs}'], out / 'build.log', env)
    print('Running activity, checkpoint, contact and CUDA stress correctness gates.', flush=True)
    run(['ctest', '--test-dir', build, '--no-tests=error', '-R', '^(' + '|'.join(TESTS) + ')$',
         '--output-on-failure'], out / 'tests.log', env)
    if sanitizer:
        print('Running activity memcheck.', flush=True)
        run([sanitizer, '--tool', 'memcheck', '--error-exitcode', '99', build / 'gpu_activity_test'],
            out / 'memcheck.log', env)
    print(f'Measuring five modes, {args.bodies} bodies, {args.trials} rotated trials.', flush=True)
    run([build / 'gpu_activity_bench', args.bodies, args.trials], out / 'benchmark.log', env,
        stdout=out / 'frames.csv')
    result = {'bodies': args.bodies, 'trials': args.trials, 'sdk': manifest,
        'dependency_head': capture('git', '-C', dep, 'rev-parse', 'HEAD'),
        'dependency_dirty': bool(capture('git', '-C', dep, 'status', '--porcelain')),
        'gpu': capture('nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'),
        'summary': summarize(out / 'frames.csv', args.bodies, args.trials),
        'artifacts': {p.name: sha(p) for p in out.iterdir() if p.is_file()}}
    (out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['summary'], indent=2))


if __name__ == '__main__':
    main()
