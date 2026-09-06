"""Run only inside run_frontier_gpu_tests.py's exclusive idle-city lease."""
from pathlib import Path
import csv,hashlib,importlib.util,json,os,re,subprocess,time
base=Path('/tmp/compact-contact-city-audit')
base.mkdir(exist_ok=False)
config=json.loads(Path('/tmp/profile-city-restore-config.json').read_text())
binary=Path(config['binary'])
tape=Path('/tmp/city-shot-tape-live-manifest/record/shots.json')
expected='1172d302f5598a5f366d8149b3772f8a9642788f42b753f00e8c3607fbe09c50'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
env.update(config['simulation_env'])
env.update(PHYSX_ROOT=config['physx_root'],BLAST_ROOT=config['solver_root'],LD_LIBRARY_PATH=config['library_path'],
 VIBE_PHYSX_COMPACT_CONTACTS='1',VIBE_PHYSX_COMPACT_CONTACTS_VERIFY='1')
command=[str(binary),'--scene',config['scene'],'--grid','2','--seconds','20','--output','/dev/null',
 '--metrics-out',str(base/'metrics.csv'),'--timings-out',str(base/'timings.jsonl'),
 '--summary-out',str(base/'scenario.json'),'--shot-tape-in',str(tape),'--shot-tape-out',str(base/'shots.json')]
provenance={'binary_sha256':sha(binary),'input_tape_sha256':sha(tape),'command':command,
 'simulation_env':{k:v for k,v in env.items() if k.startswith(('VIBE_','BLAST_GPU_','BLAST_BOND_'))},
 'sources':{str(p):sha(p) for p in [Path(config['game_root'])/'physx-bridge/src/physx_bridge.cc',
  Path(config['solver_root'])/'include/extensions/stressphysx/NvBlastExtStressPhysXContactScratch.h']},
 'physx_library_sha256':sha(Path(config['physx_root'])/'bin/linux.x86_64/release/libPhysXGpuActivity_64.so')}
(base/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
started=time.monotonic()
with (base/'native.log').open('w') as f:
 result=subprocess.run(command,cwd=config['game_root'],env=env,stdout=f,stderr=subprocess.STDOUT,timeout=300)
assert result.returncode==0,f'recorder exit {result.returncode}; inspect {base}/native.log'
log=(base/'native.log').read_text()
audit=re.findall(r'\[compact-contact-audit\] batches=(\d+) verified=(\d+) records=(\d+) pairs=(\d+) mismatches=(\d+)',log)
assert len(audit)==1,audit
batches,verified,records,pairs,mismatches=map(int,audit[0])
assert batches==verified and batches>=1200 and records>0 and pairs>0 and mismatches==0,audit
sidecar=json.loads((base/'metrics.sidecar.json').read_text())
assert sidecar['manifestHash']==expected and sidecar['chunks']==96420,sidecar
assert sidecar['membershipMismatchTicks']==0,sidecar
assert (base/'shots.json').read_bytes()==tape.read_bytes(),'shot input replay changed'
rows=list(csv.DictReader((base/'metrics.csv').open()));assert len(rows)==1200
validator_path=Path(config['game_root'])/'scripts/perf/verify_compact_contact_audit.py'
spec=importlib.util.spec_from_file_location('compact_audit',validator_path)
validator=importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)
validated=validator.verify(sidecar,rows,log,(base/'shots.json').read_bytes())
summary={'audit_batches':batches,'verified_batches':verified,'verified_records':records,'verified_pairs':pairs,'mismatches':mismatches,
 'max_awake':max(int(r['awake']) for r in rows),'final_bonds':int(rows[-1]['bonds']),
 'replay_ticks':sum(float(r['resim_passes'])>0 for r in rows),'manifest_hash':sidecar['manifestHash'],
 'input_tape_sha256':sha(tape),'wall_seconds':time.monotonic()-started,
 'scope':'Same-input contact boundary equivalence; verifier overhead included in tick timings, not a speedup or settling qualification.'}
summary.update(validated)
(base/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
