"""Profile the native executable directly; wait for its natural completion."""
import hashlib,json,os,subprocess,time
from pathlib import Path
config=json.loads(Path('/tmp/profile-city-restore-config.json').read_text())
out=Path('/tmp/city-restore-context-nsys-native-off');out.mkdir(exist_ok=False)
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
env.update(config['simulation_env'])
env.update(BLAST_RESIM_BATCH_CUDA_CONTEXT='0',BLAST_RESIM_PROFILE='1',PHYSX_ROOT=config['physx_root'],BLAST_ROOT=config['solver_root'],LD_LIBRARY_PATH=config['library_path'])
command=['/opt/nvidia/nsight-compute/2025.1.1/host/target-linux-x64/nsys','profile','--trace=cuda,osrt','--sample=none','--cpuctxsw=none','--wait=all','--output='+str(out/'cuda'),config['binary'],'--scene',config['scene'],'--grid','2','--seconds','6','--shots','72','--shot-interval-ticks','4','--targets','27','--output','/dev/null','--metrics-out',str(out/'metrics.csv'),'--timings-out',str(out/'timings.jsonl'),'--summary-out',str(out/'scenario.json')]
record=dict(config,command=command,profile='1',batch='0',binary_sha256=hashlib.sha256(Path(config['binary']).read_bytes()).hexdigest(),start_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
for name,root in [('game',config['game_root']),('solver',str(Path(config['solver_root']).parent))]:
 record[name+'_revision']=subprocess.check_output(['git','-C',root,'rev-parse','HEAD']).decode().strip()
record['attribution_only']=True
(out/'run.json').write_text(json.dumps(record,indent=2)+'\n')
start=time.monotonic()
with (out/'native.log').open('w') as log:
 result=subprocess.run(command,cwd=config['game_root'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
record.update(exit_code=result.returncode,wall_seconds=time.monotonic()-start)
(out/'run.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'out':str(out),'exit_code':result.returncode}),flush=True)
raise SystemExit(result.returncode)
