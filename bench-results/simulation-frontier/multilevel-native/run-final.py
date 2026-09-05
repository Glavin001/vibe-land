#!/usr/bin/env python3
"""Machine-local recipe; requires exclusive GPU access managed by the caller."""
import json
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parent
solver=Path('/root/workspace/blast-stress-solver-2')
exe=solver/'demos/blast-stress-demo/build-gpu-activity/multilevel_gpu_test'
results=[]
arms=[
 ('anchored-python','anchored',None,True),('free-python','free',None,True),
 ('anchored-native-mixed','anchored','anchored',True),
 ('free-native-mixed','free','free',True),
 ('anchored-native-double','anchored','anchored',False),
 ('free-native-double','free','free',False),
 ('large-native-mixed','large-load','free',True),
 ('small-native-mixed','small-load','free',True),
 ('gravity-native-mixed','free-gravity','free',True),
 ('free-zero-native-mixed','free-zero','free',True),
 ('anchored-zero-native-mixed','anchored-zero','anchored',True),
]
for label,fixture,basis,mixed in arms:
 cmd=[str(exe),f'/tmp/multilevel-{fixture}.bin','--solves','4']
 if basis:cmd+=['--native-basis',f'/tmp/multilevel-{basis}.basis']
 if mixed:cmd+=['--float-preconditioner']
 with (root/(label+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 result={'label':label,'command':cmd,'exit':r.returncode,'expected_exit':0}
 results.append(result);print(json.dumps(result),flush=True)
negative=[str(exe),'/tmp/multilevel-anchored.bin','--native-basis','/tmp/multilevel-anchored.basis','--float-preconditioner','--solves','1','--iterations','1']
with (root/'incomplete-negative.log').open('w') as log:r=subprocess.run(negative,stdout=log,stderr=subprocess.STDOUT)
results.append({'label':'incomplete-negative','command':negative,'exit':r.returncode,'expected_exit':1})
for label,fixture in [('memcheck-free-gravity','free-gravity'),('memcheck-free-zero','free-zero')]:
 cmd=['/usr/local/cuda/bin/compute-sanitizer','--tool','memcheck','--leak-check','full','--error-exitcode','3',str(exe),f'/tmp/multilevel-{fixture}.bin','--native-basis','/tmp/multilevel-free.basis','--float-preconditioner','--solves','1']
 with (root/(label+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 result={'label':label,'command':cmd,'exit':r.returncode,'expected_exit':0}
 results.append(result);print(json.dumps(result),flush=True)
(root/'commands.json').write_text(json.dumps(results,indent=2)+'\n')
sys.exit(int(any(r['exit']!=r['expected_exit'] for r in results)))
