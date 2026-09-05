import subprocess
from pathlib import Path
binary='/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity/multilevel_gpu_test'
cases=[]
for fixture in ['anchored','free']:
 for precision in ['double','mixed']:
  options=['--float-preconditioner'] if precision=='mixed' else []
  cases.append((fixture+'-'+precision+'-v3',[binary,'/tmp/multilevel-'+fixture+'.bin','--solves','4','--phase-profile',*options],0))
for fixture in ['reused','large-load','small-load']:
 cases.append((fixture+'-mixed-v3',[binary,'/tmp/multilevel-'+fixture+'.bin','--solves','4','--float-preconditioner'],0))
cases.extend([
 ('incomplete-negative-control-v3',[binary,'/tmp/multilevel-anchored.bin','--solves','1','--iterations','1','--float-preconditioner'],1),
 ('memcheck-v3',['/usr/local/cuda/bin/compute-sanitizer','--tool','memcheck','--error-exitcode','3','--leak-check','full',binary,'/tmp/multilevel-large-load.bin','--float-preconditioner','--solves','1'],0)])
status=0
for label,command,expected in cases:
 print('Running',label,flush=True)
 with Path('/tmp/multilevel-cuda-'+label+'.log').open('w') as log:
  result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=180)
 print(label,'exit',result.returncode,'expected',expected,flush=True)
 if result.returncode!=expected:status=1
raise SystemExit(status)
