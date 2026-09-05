import hashlib,json,os,subprocess,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
out=root/'bench-results/simulation-frontier/direct-contact-preparation/settling-controls';out.mkdir(exist_ok=True)
results=[]
for trial in range(1,4):
 for arm in ('baseline','qualified'):
  sdk='/tmp/physx-query-baseline' if arm=='baseline' else '/root/workspace/physx-gpu-activity/physx'
  binary=Path('/tmp/record-city-contact-baseline') if arm=='baseline' else root/'target/gpu-activity/release/record-city-trace'
  env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
  env=json.loads(subprocess.check_output(['bash','-c','source scripts/physics-env.sh\npython3 -c "import os,json;print(json.dumps(dict(os.environ)))"'],cwd=root,env=env))
  env.update(PHYSX_ROOT=sdk,BLAST_ROOT='/root/workspace/blast-stress-solver-2/blast',LD_LIBRARY_PATH=sdk+'/bin/linux.x86_64/release:/usr/local/cuda/lib64',BLAST_GPU_IMPULSE_READBACK='0',BLAST_BOND_STRESS_GPU='1',VIBE_CITY_RESIM_PASSES='1',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0',VIBE_PHYSX_DIRECT_GPU='1')
  label=f'{arm}-{trial}'
  cmd=[str(binary),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','1','--seconds','60','--shots','12','--shot-interval-ticks','10','--targets','1','--aim-lock','--output','/dev/null','--metrics-out',str(out/(label+'.csv')),'--summary-out',str(out/(label+'-scene.json'))]
  start=time.monotonic()
  with (out/(label+'.log')).open('w') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
  record={'label':label,'command':cmd,'env':{k:v for k,v in env.items() if k.startswith(('VIBE_','BLAST_','PHYSX_')) or k=='LD_LIBRARY_PATH'},'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'sdk_manifest_sha256':hashlib.sha256(Path(sdk,'gpu-activity-manifest.json').read_bytes()).hexdigest(),'exit_code':r.returncode,'wall_seconds':time.monotonic()-start}
  results.append(record);(out/(label+'-run.json')).write_text(json.dumps(record,indent=2)+'\n')
  print(label,'exit',r.returncode,'seconds',round(record['wall_seconds'],1),flush=True)
  if r.returncode:raise SystemExit(r.returncode)
(out/'runs.json').write_text(json.dumps(results,indent=2)+'\n')
