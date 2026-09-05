import hashlib,json,os,re,subprocess,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
out=root/'bench-results/simulation-frontier/direct-contact-preparation/authored-order-control';out.mkdir(exist_ok=True)
results=[]
for trial in range(1,2):
 for arm in ('baseline','final'):
  binary=Path('/tmp/authored-query-'+arm)
  sdk='/tmp/physx-query-baseline' if arm=='baseline' else '/root/workspace/physx-gpu-activity/physx'
  env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
  env.update(PHYSX_ROOT=sdk,BLAST_ROOT='/root/workspace/blast-stress-solver-2/blast',LD_LIBRARY_PATH=sdk+'/bin/linux.x86_64/release:/usr/local/cuda/lib64',BLAST_GPU_IMPULSE_READBACK='0',BLAST_BOND_STRESS_GPU='1',VIBE_CITY_RESIM_PASSES='1',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0',VIBE_PHYSX_DIRECT_GPU='1')
  cmd=[str(binary),'--nocapture','--test-threads=1']
  label=f'{arm}-{trial}';log=out/(label+'.log')
  start=time.monotonic()
  with log.open('w') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
  s=log.read_text()
  observations=[dict(zip(('structure','burst','cascade','background_per_sec','awake','nodes','total_bonds'),m)) for m in re.findall(r'([\w-]+): facade burst=(\d+) cascade=(\d+) background_per_sec=([\d.eE+-]+) awake=(\d+) nodes=(\d+) total_bonds=(\d+)',s)]
  record={'label':label,'command':cmd,'env':{k:v for k,v in env.items() if k.startswith(('VIBE_','BLAST_','PHYSX_')) or k=='LD_LIBRARY_PATH'},'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'sdk_manifest_sha256':hashlib.sha256(Path(sdk,'gpu-activity-manifest.json').read_bytes()).hexdigest(),'exit_code':r.returncode,'wall_seconds':time.monotonic()-start,'observations':observations}
  results.append(record);(out/(label+'.json')).write_text(json.dumps(record,indent=2)+'\n')
  print(label,'exit',r.returncode,'seconds',round(record['wall_seconds'],1),'house2',[o for o in observations if o['structure']=='house-2story'],flush=True)
(out/'summary.json').write_text(json.dumps({'scope':'Diagnostic repeated identical fixture commands; any failed assertions remain failures, even though this collection script completes normally.','runs':results},indent=2)+'\n')
