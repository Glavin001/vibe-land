import os,subprocess,sys
from pathlib import Path
binary=Path('/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build-gpu-activity/resim_restore_bench')
for flag in ('0','1'):
 env=dict(os.environ,BLAST_RESIM_BATCH_CUDA_CONTEXT=flag,BLAST_RESIM_PROFILE='0',LD_LIBRARY_PATH='/usr/local/cuda/lib64:/root/workspace/physx-gpu-activity/physx/bin/linux.x86_64/release')
 with open(f'/tmp/restore-context-gpu-{flag}.log','w') as log:
  p=subprocess.run([str(binary),'6000','2','gpu'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=45)
 print('GPU context and 6001-body replay checks',flag,p.returncode,flush=True)
 if p.returncode: sys.exit(p.returncode)
