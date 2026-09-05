import hashlib, json, os, subprocess, sys, time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
dep=Path('/root/workspace/blast-stress-solver-2')
out=root/'bench-results/simulation-frontier/lazy-readback-city'
out.mkdir(parents=True,exist_ok=False)
binary=root/'target/gpu-activity/release/record-city-trace'
frozen=out/'record-city-trace'; os.link(binary,frozen)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def rev(repo): return subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
manifest={'game_head':rev(root),'solver_head':rev(dep),'binary_sha256':digest(frozen),'game_diff_sha256':hashlib.sha256(subprocess.check_output(['git','-C',str(root),'diff'])).hexdigest(),'solver_diff_sha256':hashlib.sha256(subprocess.check_output(['git','-C',str(dep),'diff'])).hexdigest(),'trials':3,'grid':2,'scenario':'demolition','seconds':45,'shots':450,'interval':4,'direct_gpu':False,'deterministic_reductions':False,'results':[]}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for trial in range(3):
 for mode in (('eager','lazy') if trial%2==0 else ('lazy','eager')):
  name=f'{trial}-{mode}'; folder=out/name; folder.mkdir()
  env=dict(os.environ,PHYSX_ROOT='/root/workspace/physx-gpu-activity/physx',LD_LIBRARY_PATH='/root/workspace/physx-gpu-activity/physx/bin/linux.x86_64/release',BLAST_GPU_IMPULSE_READBACK='1' if mode=='eager' else '0',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0',VIBE_PHYSX_DIRECT_GPU='0')
  command=['python3','/tmp/run_frontier_gpu_tests.py','bash','-c','. scripts/physics-env.sh\nexec "$@"','lazy-readback-trial',str(frozen),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','2','--seconds','45','--shots','450','--targets','27','--shot-interval-ticks','4','--output','/dev/null','--metrics-out',str(folder/'demolition.csv')]
  print('START',name,time.time(),flush=True)
  start=time.monotonic()
  with (folder/'run.log').open('w') as log:
   run=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
  record={'trial':trial,'mode':mode,'exit_code':run.returncode,'wall_seconds':time.monotonic()-start}
  manifest['results'].append(record)
  (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
  print('DONE',record,flush=True)
  if run.returncode: raise SystemExit(run.returncode)
assert digest(frozen)==manifest['binary_sha256']
print('CAMPAIGN COMPLETE',flush=True)
