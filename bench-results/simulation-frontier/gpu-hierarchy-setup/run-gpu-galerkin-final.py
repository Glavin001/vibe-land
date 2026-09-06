import json,subprocess
from pathlib import Path
out=Path('/tmp/gpu-galerkin-final');out.mkdir(exist_ok=True)
build=Path('/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity')
exe=str(build/'multilevel_gpu_test')
commands=[('small',[str(build/'gpu_galerkin_test')],0)]
for mode in ['anchored','free']:
 base=[exe,f'/tmp/multilevel-{mode}.bin','--native-graph',f'/tmp/physical-graph-final/building-{mode}-component.input','--resident-operator','--gpu-projector']
 for algorithm in [0,1,2,3]:
  cmd=base+['--float-preconditioner','--setup-repeats','8','--solves','4']
  if algorithm:cmd+=['--gpu-galerkin','--verify-galerkin','--galerkin-algorithm',str(algorithm)]
  commands.append((f'{mode}-alg{algorithm}',cmd,0))
 commands.append((mode+'-double',base+['--gpu-galerkin','--verify-galerkin','--solves','4'],0))
for fixture in ['anchored-zero','free-gravity','free-zero','large-load','small-load']:
 mode='anchored' if fixture.startswith('anchored') else 'free'
 for precision in ['float','double']:
  cmd=[exe,f'/tmp/multilevel-{fixture}.bin','--native-basis',f'/tmp/multilevel-{mode}.basis','--resident-operator','--gpu-galerkin','--verify-galerkin','--solves','2']
  if precision=='float':cmd+=['--float-preconditioner']
  commands.append((fixture+'-'+precision,cmd,0))
base=[exe,'/tmp/multilevel-free.bin','--native-graph','/tmp/physical-graph-final/building-free-component.input','--resident-operator','--gpu-projector','--float-preconditioner','--gpu-galerkin','--solves','1']
commands.append(('incomplete-negative',base+['--iterations','1'],1))
memcheck=['/usr/local/cuda/bin/compute-sanitizer','--tool','memcheck','--leak-check','full','--error-exitcode','99']
commands.append(('small-memcheck',memcheck+[str(build/'gpu_galerkin_test')],0))
commands.append(('integrated-memcheck',memcheck+base,0))
results=[]
for name,cmd,expected in commands:
 with (out/(name+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 results.append(dict(name=name,command=cmd,expected=expected,exit=r.returncode));(out/'commands.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,'exit',r.returncode,'expected',expected,flush=True)
 if r.returncode!=expected:raise SystemExit(1)
