"""One exclusive, city run with a fixed aiming policy (adaptive targets). Does not change deployment configuration."""
import hashlib,json,os,re,subprocess,sys,time
from pathlib import Path
config=json.loads(Path('/tmp/profile-city-restore-config.json').read_text())
label,batch,profile=sys.argv[1:]
assert re.fullmatch(r'[a-z0-9-]+',label) and batch in ('0','1') and profile in ('0','1')
out=Path('/tmp/city-restore-context-'+label)
out.mkdir(exist_ok=False)
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def git(root,*args): return subprocess.check_output(['git','-C',root,*args])
config['binary_sha256']=sha(config['binary'])
for name,root in [('game',config['game_root']),('solver',str(Path(config['solver_root']).parent))]:
 config[name+'_revision']=git(root,'rev-parse','HEAD').decode().strip()
 config[name+'_diff_sha256']=hashlib.sha256(git(root,'diff','HEAD')).hexdigest()
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
env.update(config['simulation_env'])
env.update(BLAST_RESIM_BATCH_CUDA_CONTEXT=batch,BLAST_RESIM_PROFILE=profile,PHYSX_ROOT=config['physx_root'],BLAST_ROOT=config['solver_root'],LD_LIBRARY_PATH=config['library_path'])
command=[config['binary'],'--scene',config['scene'],'--grid','2','--seconds','20','--shots','200','--shot-interval-ticks','4','--targets','27','--output','/dev/null','--metrics-out',str(out/'metrics.csv'),'--timings-out',str(out/'timings.jsonl'),'--summary-out',str(out/'scenario.json')]
record=dict(config,command=command,batch=batch,profile=profile,start_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
(out/'run.json').write_text(json.dumps(record,indent=2)+'\n')
start=time.monotonic()
with (out/'native.log').open('w') as log:
 try:
  result=subprocess.run(command,cwd=config['game_root'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
  record['exit_code']=result.returncode
 except subprocess.TimeoutExpired:
  record['exit_code']=124
record['wall_seconds']=time.monotonic()-start
(out/'run.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'out':str(out),'exit_code':record['exit_code'],'wall_seconds':record['wall_seconds']}),flush=True)
sys.exit(record['exit_code'])
