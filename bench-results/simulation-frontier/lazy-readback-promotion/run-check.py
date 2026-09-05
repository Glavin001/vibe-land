import csv,hashlib,json,os,shutil,subprocess,sys,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
solver=Path('/root/workspace/blast-stress-solver-2')
out=root/'bench-results/simulation-frontier/lazy-readback-promotion'
out.mkdir(parents=True,exist_ok=True)
mode=sys.argv[1]
arm=sys.argv[2] if len(sys.argv)>2 else 'lazy'
env=json.loads(subprocess.check_output(['bash','-c','source scripts/physics-env.sh\npython3 -c "import os,json;print(json.dumps(dict(os.environ)))"'],cwd=root))
env.update(PHYSX_ROOT='/root/PhysX/physx/install/linux-clang/PhysX',LD_LIBRARY_PATH='/usr/local/cuda/lib64:/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release',BLAST_GPU_IMPULSE_READBACK='0' if arm=='lazy' else '1',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0',VIBE_PHYSX_DIRECT_GPU='0')
env.pop('CARGO_TARGET_DIR',None)
if mode in ('destruction','bridge','native','fixtures','memcheck','numerical'):
 # Authored test fixtures use their own material tables and the code defaults.
 # The downtown launch profile deliberately scales strength to 0.45 and
 # enables excess forces; applying those overrides here changes the fixture.
 for key in list(env):
  if key.startswith(('VIBE_','BLAST_')):env.pop(key)
 env.update(BLAST_GPU_IMPULSE_READBACK='0' if arm=='lazy' else '1',BLAST_BOND_STRESS_GPU='1',VIBE_CITY_RESIM_PASSES='1',VIBE_PHYSX_DIRECT_GPU='0',BLAST_GPU_DETERMINISTIC_REDUCTIONS='0')
commands={
 'scenario':['bash','scripts/scenario-suite.sh'],
 'idle':[str(root/'target/release/record-city-trace'),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','2','--seconds','90','--shots','0','--targets','27','--output','/dev/null','--metrics-out',str(out/(arm+'-idle.csv'))],
 'memcheck':['compute-sanitizer','--tool','memcheck','--error-exitcode','99',str(solver/'demos/blast-stress-demo/build/gpu_lazy_readback_test'),'--cpu-gpu-walk'],
 'numerical':[str(solver/'demos/blast-stress-demo/build/gpu_stress_suite'),'--grid','1','--iters','32','--compare'],
 'native':['ctest','--test-dir',str(solver/'demos/blast-stress-demo/build'),'--output-on-failure'],
 'destruction':['cargo','test','-p','vibe-land-destruction','--features','cuda-stress','--no-fail-fast','--','--test-threads=1'],
 'fixtures':['cargo','test','-p','vibe-land-destruction','--features','cuda-stress','--test','authored_structures_sim','--test','rig_scenarios_sim','--test','structural_stability','--no-fail-fast','stands_under_its_own_weight','--','--test-threads=1'],
 'bridge':['cargo','test','-p','vibe-land-physx-bridge','--features','cuda-stress','--no-fail-fast','--','--test-threads=1'],
 'audit':[str(root/'target/release/record-city-trace'),'--scene','destruction/assets/scenes/fractured-downtown.json','--grid','2','--seconds','15','--shots','100','--shot-interval-ticks','4','--targets','27','--output','/dev/null','--metrics-out',str(out/(arm+'-audit.csv'))]
}
if mode=='memcheck':env.update(BLAST_GPU_DETERMINISTIC_REDUCTIONS='1',BLAST_GPU_GATHER='1')
if mode=='audit':
 for name in ('BLAST_BOND_STRESS_GPU_VERIFY','BLAST_BOND_STRESS_COMPACT_VERIFY','BLAST_FRACTURE_CANDIDATES_VERIFY','BLAST_RESIM_RESTORE_VERIFY','VIBE_PHYSX_DRAIN_PARALLEL_VERIFY','VIBE_PHYSX_BONDLESS_HOIST_VERIFY','VIBE_CITY_BOND_SAMPLE_VERIFY'):
  env[name]='1'
label=arm+'-'+mode
manifest={'game_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'solver_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=solver,text=True).strip(),'command':commands[mode],'env':{k:v for k,v in env.items() if k.startswith(('VIBE_','BLAST_','PHYSX_')) or k=='LD_LIBRARY_PATH'},'start_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
for name in ('record-city-trace','web-fps-server'):
 manifest[name+'_sha256']=hashlib.sha256((root/'target/release'/name).read_bytes()).hexdigest()
manifest['solver_diff_sha256']=hashlib.sha256(subprocess.check_output(['git','diff','--binary','HEAD'],cwd=solver)).hexdigest()
file=out/(label+'.json');file.write_text(json.dumps(manifest,indent=2)+'\n')
print('Running '+label+'; evidence: '+str(out),flush=True)
start=time.monotonic()
working_directory=solver/'demos/blast-stress-demo/build' if mode=='numerical' else root
manifest['working_directory']=str(working_directory)
with (out/(label+'.log')).open('w') as log:
 result=subprocess.run(commands[mode],cwd=working_directory,env=env,stdout=log,stderr=subprocess.STDOUT)
manifest.update(exit_code=result.returncode,wall_seconds=time.monotonic()-start)
if mode=='idle' and result.returncode==0:
 rows=[r for r in csv.DictReader((out/(arm+'-idle.csv')).open()) if int(r['tick'])>0]
 bonds=[float(r['bonds']) for r in rows]
 tail=bonds[-1]-bonds[max(0,len(bonds)-len(bonds)//3)]
 manifest['idle_check']={'ticks':len(rows),'broken_bonds':bonds[-1],'tail_broken_bonds':tail,'passed':bonds[-1]<=30 and tail<=3 and len(rows)==5399}
 if not manifest['idle_check']['passed']:manifest['exit_code']=1
file.write_text(json.dumps(manifest,indent=2)+'\n')
if mode=='scenario':
 destination=out/(label+'-data');destination.mkdir(exist_ok=True)
 for path in Path('/tmp/scenario-suite').glob('*'):
  if path.suffix in ('.csv','.json'):shutil.copyfile(path,destination/path.name)
print(label+' exit '+str(manifest['exit_code'])+' in '+str(round(manifest['wall_seconds'],1))+'s',flush=True)
raise SystemExit(manifest['exit_code'])
