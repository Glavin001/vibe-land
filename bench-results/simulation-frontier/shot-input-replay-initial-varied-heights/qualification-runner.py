import csv, hashlib, json, os, re, struct, subprocess, time
from pathlib import Path
base=Path('/tmp/city-shot-tape-qualification')
base.mkdir(exist_ok=False)
config=json.loads(Path('/tmp/profile-city-restore-config.json').read_text())
binary=Path(config['binary'])
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
env.update(config['simulation_env'])
env.update(PHYSX_ROOT=config['physx_root'],BLAST_ROOT=config['solver_root'],LD_LIBRARY_PATH=config['library_path'])
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def revision(root):return subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
provenance={'binary_sha256':sha(binary),'game_revision':revision(config['game_root']),
 'solver_revision':revision(Path(config['solver_root']).parent), 'simulation_env':config['simulation_env'],
 'scene':config['scene'],'scene_sha256':sha(config['scene']),
 'physx_library_sha256':sha(Path(config['physx_root'])/'bin/linux.x86_64/release/libPhysXGpuActivity_64.so'),
 'sources':{rel:sha(Path(config['game_root'])/rel) for rel in ['server/src/bin/record_city_trace.rs','server/src/bin/record_city_trace/shot_tape.rs']}}
(base/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
results={}
def run(name,seconds,flags,extra_env=None):
 out=base/name;out.mkdir()
 command=[str(binary),'--scene',config['scene'],'--grid','2','--seconds',str(seconds),'--output','/dev/null',
 '--metrics-out',str(out/'metrics.csv'),'--timings-out',str(out/'timings.jsonl'),
 '--summary-out',str(out/'scenario.json'),'--shot-tape-out',str(out/'shots.json'),*flags]
 start=time.monotonic(); stamp=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
 with (out/'native.log').open('w') as log:
  process=subprocess.run(command,cwd=config['game_root'],env=env| (extra_env or {}),stdout=log,stderr=subprocess.STDOUT,timeout=240)
 record={'command':command,'extra_env':extra_env or {},'start_utc':stamp,'exit_code':process.returncode,'wall_seconds':time.monotonic()-start}
 (out/'run.json').write_text(json.dumps(record,indent=2)+'\n')
 if process.returncode: raise RuntimeError(f'{name} failed: see {out}/native.log')
 sidecar=json.loads((out/'metrics.sidecar.json').read_text())
 rows=list(csv.DictReader((out/'metrics.csv').open()))
 assert len(rows)==round(seconds*60)
 stats={'ticks':len(rows),'attempted':sidecar['shotInputs'],'hits':sidecar['shotHits'],
 'misses':sidecar['shotInputs']-sidecar['shotHits'],'max_awake':max(int(r['awake']) for r in rows),
 'replay_ticks':sum(float(r['resim_passes'])>0 for r in rows),'final_broken_bonds':int(rows[-1]['bonds']),
 'input_sha256':sha(out/'shots.json'), 'membership_mismatch_ticks':sidecar['membershipMismatchTicks']}
 assert stats['membership_mismatch_ticks']==0,stats
 results[name]=stats
 print(json.dumps({name:record|stats}),flush=True)
 return out
record=run('record',20,['--shots','200','--shot-interval-ticks','4','--targets','27'])
assert results['record']['attempted']==200
replay=run('replay',20,['--shot-tape-in',str(record/'shots.json')],{'VIBE_TRACE_ADAPTIVE_AIM':'0'})
assert (record/'shots.json').read_bytes()==(replay/'shots.json').read_bytes()
# Exercise two inputs on one tick, a known miss, the last tick, and signed zero
# through actual GPU queries. These are fixture inputs, not runtime caps.
tape=json.loads((record/'shots.json').read_text());tape['metadata']['ticks']=120
first=tape['shots'][0];first['tick']=60
bits=lambda x:struct.unpack('<I',struct.pack('<f',x))[0]
miss={'tick':60,'origin_bits':list(map(bits,[1000000.,1000000.,1000000.])),
      'direction_bits':list(map(bits,[-0.,1.,0.]))}
last=dict(miss);last['tick']=119
tape['shots']=[first,miss,last]
fixture=base/'dispatch-fixture.json';fixture.write_text(json.dumps(tape,indent=2)+'\n')
dispatch=run('dispatch',2,['--shot-tape-in',str(fixture)])
assert json.loads((dispatch/'shots.json').read_text())==tape
assert results['dispatch']['attempted']==3 and results['dispatch']['hits']==1
# Mismatches must fail before creating trace/metrics files or creating a GPU world.
negative=[]
for label,flags in [('weapon',['--seconds','20']),('duration',['--seconds','2'])]:
 out=base/('negative-'+label);out.mkdir()
 target=out/'must-not-exist.trace'
 command=[str(binary),'--scene',config['scene'],'--grid','2','--shot-tape-in',str(record/'shots.json'),
 '--output',str(target),*flags]
 testenv=dict(env)
 if label=='weapon': testenv['VIBE_CITY_SHOT_BLAST_RADIUS']='2.6'
 p=subprocess.run(command,cwd=config['game_root'],env=testenv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
 (out/'native.log').write_text(p.stdout)
 assert p.returncode!=0 and not target.exists() and 'metadata differs' in p.stdout,p.stdout[-1000:]
 negative.append({'case':label,'exit_code':p.returncode,'output_created':target.exists(),'metadata_rejected':True})
summary={'scope':'Exact external input replay and error handling; not deterministic physics or a performance comparison',
 'city_simulation_changed':False,'identical_full_run_shot_inputs':True,'cases':results,'negative_cases':negative}
(base/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2),flush=True)
