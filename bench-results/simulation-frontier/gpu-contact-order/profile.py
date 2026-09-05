import hashlib,json,os,subprocess,sys,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
solver=Path('/root/workspace/blast-stress-solver-2')
out=root/'bench-results/simulation-frontier/gpu-contact-order'
out.mkdir(parents=True,exist_ok=True)
label=sys.argv[1]
trace=root/'target/gpu-activity/release/record-city-trace'
order=sys.argv[2]
assert order in ('0','1')
verify=len(sys.argv)>3 and sys.argv[3]=='verify'
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
env=json.loads(subprocess.check_output(['bash','-c','source scripts/physics-env.sh\npython3 -c "import os,json;print(json.dumps(dict(os.environ)))"'],cwd=root,env=env))
env.update(PHYSX_ROOT='/root/workspace/physx-gpu-activity/physx',BLAST_ROOT=str(solver/'blast'),LD_LIBRARY_PATH='/usr/local/cuda/lib64:/root/workspace/physx-gpu-activity/physx/bin/linux.x86_64/release',BLAST_GPU_IMPULSE_READBACK='0',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0',VIBE_PHYSX_DIRECT_GPU='1')
env['VIBE_PHYSX_GPU_CONTACT_ORDER']=order
env['VIBE_PHYSX_GPU_CONTACT_ORDER_VERIFY']='1' if verify else '0'
if verify:
 for key in ('BLAST_BOND_STRESS_GPU_VERIFY','BLAST_BOND_STRESS_COMPACT_VERIFY','BLAST_FRACTURE_CANDIDATES_VERIFY','BLAST_RESIM_RESTORE_VERIFY','VIBE_PHYSX_DRAIN_PARALLEL_VERIFY','VIBE_PHYSX_BONDLESS_HOIST_VERIFY','VIBE_CITY_BOND_SAMPLE_VERIFY'):env[key]='1'
cmd=[str(trace),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','2','--seconds',os.environ.get('CONTACT_ORDER_SECONDS','15' if verify else '10'),'--shots',os.environ.get('CONTACT_ORDER_SHOTS','100'),'--shot-interval-ticks','4','--targets','27','--output','/dev/null','--metrics-out',str(out/(label+'.csv')),'--timings-out',str(out/(label+'.jsonl'))]
manifest={'command':cmd,'env':{k:v for k,v in env.items() if k.startswith(('VIBE_','BLAST_','PHYSX_')) or k=='LD_LIBRARY_PATH'},'binary_sha256':hashlib.sha256(trace.read_bytes()).hexdigest(),'start_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
for key,path in [('game',root),('solver',solver)]:
 manifest[key+'_head']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=path,text=True).strip()
 manifest[key+'_diff_sha256']=hashlib.sha256(subprocess.check_output(['git','diff','--binary','HEAD'],cwd=path)).hexdigest()
t=time.monotonic()
with (out/(label+'.log')).open('w') as f:
 r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
manifest.update(exit_code=r.returncode,wall_seconds=time.monotonic()-t)
(out/(label+'-run.json')).write_text(json.dumps(manifest,indent=2)+'\n')
print(label,manifest['exit_code'],round(manifest['wall_seconds'],2),flush=True)
raise SystemExit(r.returncode)
