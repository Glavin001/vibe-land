import json,subprocess
from pathlib import Path
out=Path('/tmp/rigid-projector-gpu');out.mkdir(exist_ok=True)
exe='/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity/resident_rigid_projector_test'
commands=[('small',[exe],0),('building',[exe,'/tmp/physical-graph-final/building-anchored-component.input'],0),('rotated',[exe,'/tmp/rigid-projector-rotated.input'],0),('sanitizer-small',['/usr/local/cuda/bin/compute-sanitizer','--tool','memcheck','--leak-check','full','--error-exitcode','99',exe],0)]
results=[]
for name,cmd,expected in commands:
 with (out/(name+'.log')).open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
 row=dict(name=name,command=cmd,expected=expected,exit=r.returncode);results.append(row);(out/'commands.json').write_text(json.dumps(results,indent=2)+'\n');print(name,'exit',r.returncode,'expected',expected,flush=True)
 if r.returncode!=expected:raise SystemExit(1)
