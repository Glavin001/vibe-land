import json,subprocess
from pathlib import Path
out=Path('/tmp/component-hierarchy-final');out.mkdir(exist_ok=True)
exe='/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity/multilevel_gpu_test'
base=[exe,'/tmp/multilevel-anchored.bin','--native-graph','/tmp/physical-graph-final/building-anchored-component.input','--resident-operator','--gpu-projector','--sequence','/tmp/building-fracture-sequence.bin']
commands=[]
for run in range(3):
 for backend in ['cpu','gpu']:
  for precision in ['float','double']:
   cmd=base+['--rebuild-hierarchy','--solves','2']
   if backend=='gpu':cmd+=['--gpu-galerkin']
   if precision=='float':cmd+=['--float-preconditioner']
   commands.append((f'{backend}-{precision}-{run}',cmd,0))
commands.append(('unchanged-hierarchy-control',base+['--float-preconditioner','--solves','2'],1))
commands.append(('incomplete-negative',base+['--rebuild-hierarchy','--gpu-galerkin','--float-preconditioner','--solves','1','--iterations','1'],1))
commands.append(('sequence-memcheck',['/usr/local/cuda/bin/compute-sanitizer','--tool','memcheck','--leak-check','full','--error-exitcode','99']+base+['--rebuild-hierarchy','--gpu-galerkin','--float-preconditioner','--solves','1'],0))
results=[]
for name,cmd,expected in commands:
 with (out/(name+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 results.append(dict(name=name,command=cmd,expected=expected,exit=r.returncode));(out/'commands.json').write_text(json.dumps(results,indent=2)+'\n');print(name,'exit',r.returncode,'expected',expected,flush=True)
 if r.returncode!=expected:raise SystemExit(1)
