#!/usr/bin/env python3
"""Verify retained native hierarchy evidence; no GPU or service changes."""
import hashlib
import json
from pathlib import Path
import statistics

root=Path(__file__).resolve().parent
commands=json.loads((root/'commands.json').read_text())
summary={'scope':'Standalone native hierarchy and CUDA solve; no game integration/deployment','arms':[]}
count=0
for command in commands:
 assert command['exit']==command['expected_exit'],command
 raw=(root/(command['label']+'.log')).read_text()
 rows=[json.loads(line) for line in raw.splitlines() if line.startswith('{')]
 trials=[r for r in rows if 'trial' in r]
 if command['label']=='incomplete-negative':
  assert len(trials)==1 and not trials[0]['passed'] and trials[0]['iterations']==1
  assert trials[0]['force_residual']>2e-7
  continue
 if command['label'].startswith('memcheck'):
  assert len(trials)==1 and trials[0]['passed']
  assert 'ERROR SUMMARY: 0 errors' in raw and 'LEAK SUMMARY: 0 bytes leaked' in raw
  continue
 assert len(trials)==4 and all(t['passed'] and not t['failed'] for t in trials)
 for t in trials:
  assert t['force_residual']<2e-7 and t['moment_residual']<2e-7
  assert t['bond_force_error_over_input']<2e-7 and t['bond_moment_error_over_input']<2e-7
  if t['zero_bond_reference']: assert t['bond_relative_error'] is None
  else: assert t['bond_relative_error']<2e-6
 if '-zero-' in command['label']:
  assert all(t['iterations']==0 and t['bond_force_error_n']==0 and t['bond_moment_error_nm']==0 for t in trials)
 count+=len(trials)
 setup=next((r['native_hierarchy_setup_ms'] for r in rows if 'native_hierarchy_setup_ms' in r),None)
 summary['arms'].append({'name':command['label'],'trials':4,'iterations':trials[0]['iterations'],'native_setup_ms':setup,'median_warmed_cuda_ms':statistics.median(t['cuda_solve_ms'] for t in trials[1:]),'max_force_residual':max(t['force_residual'] for t in trials),'max_moment_residual':max(t['moment_residual'] for t in trials),'max_bond_force_error_over_input':max(t['bond_force_error_over_input'] for t in trials),'max_bond_moment_error_over_input':max(t['bond_moment_error_over_input'] for t in trials)})
assert count==44
assert '100% tests passed' in (root/'multilevel-native-cpu.log').read_text()
cpu_san=(root/'multilevel-native-cpu-sanitizer.log').read_text()
assert 'All native hierarchy checks passed' in cpu_san and 'runtime error:' not in cpu_san and 'ERROR: AddressSanitizer' not in cpu_san
live=json.loads((root/'live-preserved.json').read_text())
assert live['binary_sha256']=='51efeb841976fe88eb5f52b1a2d84e4227ee2612d784463f82138315073a2f79' and not live['deployed_new_candidate']
summary.update(solves_passed=count,negative_control_rejected=True,cpu_sanitizers_passed=True,cuda_memory_checks_passed=2,live_binary_unchanged=True)
(root/'summary.json').write_text(json.dumps(summary,indent=2,allow_nan=False)+'\n')
print(json.dumps(summary,indent=2))
