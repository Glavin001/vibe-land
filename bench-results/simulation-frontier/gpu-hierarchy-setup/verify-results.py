#!/usr/bin/env python3
"""Validate the archived setup evidence; this is not a city release gate."""
import hashlib
import json
from pathlib import Path
import statistics

root = Path(__file__).resolve().parent
for name, expected in json.loads((root / 'hashes.json').read_text()).items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name

summary = json.loads((root / 'summary.json').read_text())
commands = json.loads((root / 'final/commands.json').read_text())
assert len(commands) == 24
assert all(row['exit'] == row['expected'] for row in commands)
assert [row['name'] for row in commands if row['expected']] == ['incomplete-negative']
samples = 0
for command in commands:
    name = command['name']
    raw = (root / 'final' / (name + '.log')).read_text()
    rows = [json.loads(line) for line in raw.splitlines() if line.startswith('{')]
    trials = [row for row in rows if 'trial' in row]
    if name.endswith('memcheck'):
        assert 'ERROR SUMMARY: 0 errors' in raw
        assert 'LEAK SUMMARY: 0 bytes leaked in 0 allocations' in raw
        assert all(row['passed'] for row in trials)
    elif name == 'incomplete-negative':
        assert len(trials) == 1 and not trials[0]['passed']
    else:
        assert all(row['passed'] for row in trials)
        samples += len(trials)
    if '-alg' in name:
        setup = [row for row in rows if 'setup_repeat' in row]
        assert len(setup) == 8
        recorded = summary['timings'][name]
        assert statistics.median(row['setup_ms'] for row in setup[4:]) == recorded['warm_setup_ms']
        assert len({row['allocations'] for row in setup}) == 1
        assert setup[-1]['retained_bytes'] == recorded['retained_bytes']
    if '--verify-galerkin' in command['command']:
        assert any(row.get('gpu_hierarchy_reference_check') for row in rows)

assert samples == summary['normal_solve_samples'] == 60
inputs = json.loads((root / 'inputs.json').read_text())
assert inputs['/tmp/multilevel-native-anchored.bin'] == inputs['/tmp/multilevel-native-anchored-final.bin']
native = json.loads((root / 'native-refresh.json').read_text())
assert all(row['passed'] for row in native)
assert {row['policy']: row['iterations'] for row in native} == {
    'unchanged': 326, 'refresh-pinv': 243, 'unsmoothed-4': 142,
}
city = json.loads((root / 'city-state.json').read_text())
assert city['binary_sha256'] == '9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert city['settings']['VIBE_PHYSX_DIRECT_GPU'] == '1'
assert not summary['city_changed']
print('PASS: 60 physical solve samples, matrix comparisons, negative control, memory checks, unchanged CPU fixture and city artifact.')
print('NOT A RELEASE PASS: current-fracture hierarchy integration and the prior split convergence gate remain open.')
