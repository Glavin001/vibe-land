import hashlib,json,os,subprocess,sys,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
solver=Path('/root/workspace/blast-stress-solver-2')
out=root/'bench-results/simulation-frontier/gpu-contact-order/qualification'
out.mkdir(parents=True,exist_ok=True)
mode=sys.argv[1]
arm=sys.argv[2] if len(sys.argv)>2 else 'direct'
assert arm in ('direct','native')
profile=sys.argv[3] if len(sys.argv)>3 else 'debug'
assert profile in ('debug','release')
label=arm+'-'+mode+('-release' if profile=='release' else '')
if len(sys.argv)>4: label+='-'+sys.argv[4]
trace=root/'target/gpu-activity/release/record-city-trace'
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
if mode in ('scenario','audit','idle','collapse'):
 env=json.loads(subprocess.check_output(['bash','-c','source scripts/physics-env.sh\npython3 -c "import os,json;print(json.dumps(dict(os.environ)))"'],cwd=root,env=env))
env.update(PHYSX_ROOT='/root/workspace/physx-gpu-activity/physx',BLAST_ROOT=str(solver/'blast'),CARGO_TARGET_DIR='target/gpu-activity',LD_LIBRARY_PATH='/usr/local/cuda/lib64:/root/workspace/physx-gpu-activity/physx/bin/linux.x86_64/release',BLAST_GPU_IMPULSE_READBACK='0',BLAST_BOND_STRESS_GPU='1',VIBE_CITY_RESIM_PASSES='1',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0',VIBE_PHYSX_DIRECT_GPU='1' if arm=='direct' else '0')
commands={
 'full-tests':['cargo','test','-p','vibe-land-destruction','-p','vibe-land-physx-bridge','--features','cuda-stress','--no-fail-fast','--','--test-threads=1'],
 'destruction':['cargo','test','-p','vibe-land-destruction','--features','cuda-stress','--no-fail-fast','--','--test-threads=1'],
 'authored':['cargo','test','-p','vibe-land-destruction','--features','cuda-stress','--test','authored_structures_sim','--','--test-threads=1'],
 'bridge':['cargo','test','-p','vibe-land-physx-bridge','--features','cuda-stress','--no-fail-fast','--','--test-threads=1'],
 'scenario':['bash','scripts/scenario-suite.sh'],
 'idle':['bash','scripts/check-at-rest.sh','0.45','90'],
 'collapse':[str(trace),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','1','--seconds','40','--shots','12','--shot-interval-ticks','10','--targets','1','--aim-lock','--output','/dev/null','--metrics-out',str(out/(label+'.csv')),'--summary-out',str(out/(label+'-summary.json'))],
 'audit':[str(trace),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','2','--seconds','15','--shots','100','--shot-interval-ticks','4','--targets','27','--output','/dev/null','--metrics-out',str(out/(label+'.csv'))]
}
if profile=='release' and commands[mode][:2]==['cargo','test']:commands[mode].insert(2,'--release')
if mode in ('scenario','idle'):
 env.update(VIBE_CITY_TRACE_BIN=str(trace),VIBE_CITY_SCENARIO_OUT=str(out/(label+'-data')))
env['VIBE_PHYSX_GPU_CONTACT_ORDER']='1'
if mode=='audit':
 env['VIBE_PHYSX_GPU_CONTACT_ORDER_VERIFY']='1'
if mode=='audit':
 for key in ('BLAST_BOND_STRESS_GPU_VERIFY','BLAST_BOND_STRESS_COMPACT_VERIFY','BLAST_FRACTURE_CANDIDATES_VERIFY','BLAST_RESIM_RESTORE_VERIFY','VIBE_PHYSX_DRAIN_PARALLEL_VERIFY','VIBE_PHYSX_BONDLESS_HOIST_VERIFY','VIBE_CITY_BOND_SAMPLE_VERIFY'):env[key]='1'
manifest={'game_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'solver_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=solver,text=True).strip(),'command':commands[mode],'cwd':str(root),'env':{k:v for k,v in env.items() if k.startswith(('VIBE_','BLAST_','PHYSX_','CARGO_TARGET')) or k=='LD_LIBRARY_PATH'},'start_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
for repo,path in (('game',root),('solver',solver)):
 manifest[repo+'_diff_sha256']=hashlib.sha256(subprocess.check_output(['git','diff','--binary','HEAD'],cwd=path)).hexdigest()
for name in ('record-city-trace','web-fps-server'):
 path=root/'target/gpu-activity/release'/name
 if path.exists():manifest[name+'_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
manifest['sdk_manifest_sha256']=hashlib.sha256(Path(env['PHYSX_ROOT'],'gpu-activity-manifest.json').read_bytes()).hexdigest()
path=out/(label+'.json');path.write_text(json.dumps(manifest,indent=2)+'\n')
print('Running '+label,flush=True)
start=time.monotonic()
with (out/(label+'.log')).open('w') as log:
 result=subprocess.run(commands[mode],env=env,cwd=root,stdout=log,stderr=subprocess.STDOUT)
manifest.update(exit_code=result.returncode,wall_seconds=time.monotonic()-start)
path.write_text(json.dumps(manifest,indent=2)+'\n')
print(label+' exit '+str(result.returncode)+' in '+str(round(manifest['wall_seconds'],1))+'s',flush=True)
raise SystemExit(result.returncode)
