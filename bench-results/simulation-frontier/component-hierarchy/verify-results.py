#!/usr/bin/env python3
"""Check component-hierarchy evidence without treating it as a city release."""
import hashlib
import json
from pathlib import Path
import statistics

root = Path(__file__).resolve().parent
for name, expected in json.loads((root / 'hashes.json').read_text()).items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
summary = json.loads((root / 'summary.json').read_text())
commands = json.loads((root / 'final/commands.json').read_text())
assert len(commands) == 15
samples = 0
for command in commands:
    name = command['name']
    assert command['exit'] == command['expected'], name
    raw = (root / 'final' / (name + '.log')).read_text()
    rows = [json.loads(line) for line in raw.splitlines() if line.startswith('{')]
    trials = [row for row in rows if 'trial' in row]
    if name == 'unchanged-hierarchy-control':
        assert len(trials) == 16
        assert [row['trial'] for row in trials if not row['passed']] == [4, 5]
        continue
    if name == 'incomplete-negative':
        assert len(trials) == 8
        assert [row['trial'] for row in trials if row['passed']] == [3]
        continue
    assert all(row['passed'] for row in trials), name
    rebuilds = [row for row in rows if 'component_hierarchy_rebuild_ms' in row]
    assert len(rebuilds) == 8
    assert all(row['independent_current_matrix_check'] for row in rebuilds)
    assert [row['bonded_components'] for row in rebuilds] == [1, 1, 2, 0, 1, 7, 1, 1]
    assert [row['isolated_nodes'] for row in rebuilds] == [0, 0, 0, 5936, 0, 1, 0, 0]
    assert rebuilds[3]['coarse_nnz'] == 0
    assert all(not row['coupling_reuploaded'] for row in rows if 'coupling_reuploaded' in row)
    if name == 'sequence-memcheck':
        assert len(trials) == 8
        assert 'ERROR SUMMARY: 0 errors' in raw
        assert 'LEAK SUMMARY: 0 bytes leaked in 0 allocations' in raw
    else:
        assert len(trials) == 16
        assert trials[4]['iterations'] == trials[5]['iterations'] == 36
        samples += len(trials)
assert samples == summary['rebuilt_samples'] == summary['rebuilt_passed'] == 192
for arm in summary['arms'].values():
    for frame in arm.values():
        for values in frame.values():
            assert statistics.median(values['samples']) == values['median']
inputs = json.loads((root / 'inputs.json').read_text())
assert inputs['/tmp/multilevel-native-anchored.bin'] == inputs['/tmp/multilevel-component-original.bin']
assert '100% tests passed' in (root / 'native.log').read_text()
asan = (root / 'asan.log').read_text()
assert asan.count('passed') == 3 and 'ERROR:' not in asan and 'runtime error:' not in asan
city = json.loads((root / 'city-state.json').read_text())
assert city['binary_sha256'] == '9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert city['settings']['VIBE_PHYSX_DIRECT_GPU'] == '1'
assert not summary['city_changed'] and not summary['end_to_end_performance_qualified']
print('PASS: 192 rebuilt fracture samples; split converges in 36 iterations; CPU/CUDA safety checks and controls pass.')
print('NOT A RELEASE PASS: rebuild/upload cost and production integration remain unresolved.')
