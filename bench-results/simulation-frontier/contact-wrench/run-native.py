import subprocess
from pathlib import Path
b=Path('/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity')
commands=[['ctest','--test-dir',str(b),'-R','point_force|direct_gpu_contacts','--output-on-failure','-V'],[str(b/'gpu_stress_suite'),'--pack','/root/workspace/blast-stress-solver-2/blast/blast-stress-solver/assets/mini-city/fractured-downtown.json','--grid','2','--iters','32','--solves','3','--compare']]
results=[]
for command in commands:
 print('Running',command,flush=True)
 results.append(subprocess.run(command).returncode)
print('Exit codes',results,flush=True)
raise SystemExit(any(results))
