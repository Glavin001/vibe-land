import subprocess
from pathlib import Path
out=Path('/root/workspace/vibe-land-4/bench-results/simulation-frontier/direct-contact-preparation')
with (out/'native-fixtures-qualified.log').open('w') as f:
 subprocess.run(['ctest','--test-dir','/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity','-R','velocity_fidelity|gpu_activity$|direct_gpu_contact|direct_gpu_resim','--verbose'],check=True,stdout=f,stderr=subprocess.STDOUT)
print('Corrected SDK native fixtures passed',flush=True)
for i in range(1,4):
 subprocess.run(['python3','/tmp/profile_direct_contacts.py',f'qualified-{i}'],check=True)
