import subprocess,sys
from pathlib import Path
root=Path('/root/workspace/blast-stress-solver-2')
b=root/'demos/blast-stress-demo/build-gpu-activity/gpu_stress_suite'
base=[str(b),'--pack',str(root/'blast/blast-stress-solver/assets/mini-city/fractured-downtown.json'),'--grid','2','--solves','3','--compare']
for iters in (32,128,512,2048):
 command=base+['--iters',str(iters)]+([] if iters==32 else ['--only','single-building'])
 print('Running physical residual',iters,flush=True)
 result=subprocess.run(command)
 if result.returncode:sys.exit(result.returncode)
