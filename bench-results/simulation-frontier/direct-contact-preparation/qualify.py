import subprocess,sys
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
out=root/'bench-results/simulation-frontier/direct-contact-preparation'
cmd=['ctest','--test-dir','/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity','-R','velocity_fidelity|gpu_activity$|direct_gpu_contact|direct_gpu_resim','--output-on-failure']
with (out/'native-fixtures.log').open('w') as f:
 r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
print('Native fixture exit',r.returncode,flush=True)
if r.returncode:raise SystemExit(r.returncode)
for label,binary in [('candidate-1',None),('baseline-2','/tmp/record-city-contact-baseline'),('candidate-2',None),('baseline-3','/tmp/record-city-contact-baseline'),('candidate-3',None)]:
 cmd=['python3','/tmp/profile_direct_contacts.py',label]
 if binary:cmd.append(binary)
 subprocess.run(cmd,check=True)
