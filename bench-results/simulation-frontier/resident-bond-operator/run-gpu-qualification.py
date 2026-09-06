import json, subprocess
from pathlib import Path
out=Path('/tmp/resident-operator-gpu');out.mkdir(exist_ok=True)
bin=Path('/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity')
commands=[('transitions-small',[str(bin/'resident_bond_operator_test')],0),('transitions-building',[str(bin/'resident_bond_operator_test'),'/tmp/physical-graph-final/building-anchored-component.input'],0)]
for mode in ['anchored','free']:
 for precision in ['float','double']:
  for resident in [False,True]:
   name=f'{mode}-{precision}-'+('resident' if resident else 'assembled')
   cmd=[str(bin/'multilevel_gpu_test'),f'/tmp/multilevel-{mode}.bin','--native-graph',f'/tmp/physical-graph-final/building-{mode}-component.input','--solves','4']
   if precision=='float':cmd+=['--float-preconditioner']
   if resident:cmd+=['--resident-operator']
   commands.append((name,cmd,0))
commands.append(('incomplete-negative',[str(bin/'multilevel_gpu_test'),'/tmp/multilevel-anchored.bin','--native-graph','/tmp/physical-graph-final/building-anchored-component.input','--resident-operator','--float-preconditioner','--solves','1','--iterations','1'],1))
commands.append(('sanitizer-transitions',['/usr/local/cuda/bin/compute-sanitizer','--tool','memcheck','--leak-check','full','--error-exitcode','99',str(bin/'resident_bond_operator_test')],0))
results=[]
for name,cmd,expected in commands:
 with (out/(name+'.log')).open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
 row=dict(name=name,command=cmd,expected=expected,exit=r.returncode);results.append(row)
 (out/'commands.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,'exit',r.returncode,'expected',expected,flush=True)
 if r.returncode!=expected:raise SystemExit(1)
