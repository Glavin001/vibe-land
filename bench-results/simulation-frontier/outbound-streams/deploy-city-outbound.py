"""Deploy the privately qualified immutable server using the owned city helper."""
import fcntl,hashlib,importlib.util,json,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('city_deploy','/root/workspace/vibe-land-4/scripts/vast-city.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
config=json.loads((d.STATE/'outbound-candidate.json').read_text())
qualified=json.loads(Path('/tmp/city-outbound-qualification/run.json').read_text())
stats=json.loads(Path('/tmp/city-outbound-qualification/match-stats.json').read_text())
assert qualified['passed'] and qualified['sha256']==config['sha256']
assert stats['physics_gpu_warning_count']==0 and stats['network']['dropped_outbound_packets']==0
assert sha(config['binary'])==config['sha256']
with (d.STATE/'lock').open('w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 current=d.discover()
 if not current['server'] or d.health(current['api']).get('players')!=0:raise RuntimeError('Deployment requires a healthy empty city')
 previous=Path(f"/proc/{current['server']}/exe").resolve()
 assert sha(previous)==config['previous_sha256'],'Live artifact changed since qualification'
 env=dict(current['env'])
 assert env.get('VIBE_PHYSX_DIRECT_GPU')=='1'
 assert env.get('BLAST_RESIM_PROFILE','0')=='0' and env.get('BLAST_RESIM_BATCH_CUDA_CONTEXT','0')=='0'
 env.update(VIBE_RELEASE_GAME_REVISION=config['game'],VIBE_RELEASE_SOLVER_REVISION=config['solver'],VIBE_RELEASE_BINARY_SHA256=config['sha256'])
 (d.STATE/'outbound-previous-env.json').write_text(json.dumps(current['env']))
 record=dict(config,previous_binary=str(previous),started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
 process=None
 try:
  for pid,identity in current['supervisors']:d.stop(pid,identity)
  d.stop(current['server'],current['server_identity'])
  process=d.start(Path(config['binary']),env,d.STATE/'server.log')
  d.ready(process,current['api'])
  after=d.discover()
  assert sha(f"/proc/{after['server']}/exe")==config['sha256']
  changes={k:[current['env'].get(k),after['env'].get(k)] for k in set(current['env'])|set(after['env']) if k.startswith(('VIBE_','BLAST_')) and not k.startswith('VIBE_RELEASE_') and current['env'].get(k)!=after['env'].get(k)}
  assert not changes,'Unexpected simulation environment change'
  verification=d.verify(after,browser=True,public=True)
  assert verification['browser']['ok']
  assert verification['browser']['city']['structureRepairs']==verification['browser']['city']['hashMismatches']==0
  record.update(passed=True,simulation_env_changes=changes,server_pid=after['server'],url=after['url'],verification=verification)
  (d.STATE/'deployment.json').write_text(json.dumps({'env':env,'web':current['web']}))
 except BaseException:
  record['passed']=False
  # Do not restart an occupied city after a failed verification. The normal
  # successful path leaves the qualified server running for human review.
  active=d.discover()
  if active['server'] and d.health(active['api']).get('players')==0:
   for pid,identity in active['supervisors']:d.stop(pid,identity)
   d.stop(active['server'],active['server_identity'])
   rollback=d.start(previous,current['env'],d.STATE/'rollback.log');d.ready(rollback,current['api'])
   record['rolled_back']=True
  elif not active['server']:
   if process and process.poll() is None:d.stop(process.pid,d.process_identity(process.pid))
   rollback=d.start(previous,current['env'],d.STATE/'rollback.log');d.ready(rollback,current['api'])
   record['rolled_back']=True
  else:record['rollback_deferred_for_active_clients']=True
  raise
 finally:
  record['finished_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
  (d.STATE/'outbound-deployment.json').write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps(record,indent=2))
