import json,subprocess
from pathlib import Path
out=Path('/tmp/rigid-solve-gpu');out.mkdir(exist_ok=True)
exe='/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity/multilevel_gpu_test'
commands=[]
for mode in ['anchored','free']:
 for precision in ['float','double']:
  for projector in [False,True]:
   name=f'{mode}-{precision}-'+('gpu-projector' if projector else 'reference-projector')
   cmd=[exe,f'/tmp/multilevel-{mode}.bin','--native-graph',f'/tmp/physical-graph-final/building-{mode}-component.input','--resident-operator','--solves','4']
   if precision=='float':cmd+=['--float-preconditioner']
   if projector:cmd+=['--gpu-projector']
   commands.append((name,cmd,0))
for precision in ['float','double']:
 cmd=[exe,'/tmp/multilevel-anchored.bin','--native-graph','/tmp/physical-graph-final/building-anchored-component.input','--resident-operator','--gpu-projector','--sequence','/tmp/building-fracture-sequence.bin','--solves','2']
 if precision=='float':cmd+=['--float-preconditioner']
 commands.append(('sequence-'+precision,cmd,1))
 if precision=='float':commands.append(('diagnostic-sequence-1024',cmd+['--iterations','1024'],0))
commands.append(('incomplete-negative',[exe,'/tmp/multilevel-anchored.bin','--native-graph','/tmp/physical-graph-final/building-anchored-component.input','--resident-operator','--gpu-projector','--sequence','/tmp/building-fracture-sequence.bin','--solves','1','--iterations','1','--float-preconditioner'],1))
results=[]
for name,cmd,expected in commands:
 with (out/(name+'.log')).open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
 row=dict(name=name,command=cmd,expected=expected,exit=r.returncode);results.append(row);(out/'commands.json').write_text(json.dumps(results,indent=2)+'\n');print(name,'exit',r.returncode,'expected',expected,flush=True)
 if r.returncode!=expected:raise SystemExit(1)
