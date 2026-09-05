"""Roll out a qualified native-SDK candidate using the city helper's owned processes.
Keeps the existing Caddy, client, ports, certificate and physics settings.
"""
import fcntl, hashlib, importlib.util, json, os, shutil, sys, time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
sdk=Path('/root/workspace/physx-gpu-activity/physx')
spec=importlib.util.spec_from_file_location('city_deploy',root/'scripts/vast-city.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
mode=sys.argv[1];expected=sys.argv[2]
assert mode in ('0','1')
binary=root/'target/gpu-activity/release/web-fps-server'
assert digest(binary)==expected, 'Candidate binary changed after qualification'
manifest=json.loads((sdk/'gpu-activity-manifest.json').read_text())
for name,sha in manifest['libraries'].items():
 assert digest(sdk/'bin/linux.x86_64/release'/name)==sha, 'SDK artifact changed: '+name
assert manifest['patch_sha256']==digest(root.parent/'blast-stress-solver-2/patches/physx/5.10-direct-gpu-sleep.patch')
os.umask(0o077)
with (deploy.STATE/'lock').open('w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 d=deploy.discover()
 assert d['server'] and deploy.health(d['api']).get('players')==0, 'City must be healthy and empty'
 # Validate the unchanged web/TLS setup before replacing the server.
 deploy.verify(d,browser=False,public=False)
 assert deploy.process_identity(d['server'])==d['server_identity'], 'Serving process changed'
 oldenv=dict(d['env'])
 backup=deploy.STATE/'web-fps-server-before-rotation'
 shutil.copyfile(f"/proc/{d['server']}/exe",backup);backup.chmod(0o700)
 (deploy.STATE/'before-rotation.json').write_text(json.dumps(oldenv))
 candidate_env=dict(oldenv,PHYSX_ROOT=str(sdk),VIBE_PHYSX_DIRECT_GPU=mode)
 candidate_env['LD_LIBRARY_PATH']=str(sdk/'bin/linux.x86_64/release')+':/usr/local/cuda/lib64:'+oldenv.get('LD_LIBRARY_PATH','')
 active=deploy.STATE/f'web-fps-server-rotation-{time.time_ns()}'
 shutil.copy2(binary,active)
 # Check again: the preflight can take time and a human may have connected.
 assert deploy.health(d['api']).get('players')==0, 'A player connected during preflight'
 for pid,stamp in d['supervisors']:deploy.stop(pid,stamp)
 deploy.stop(d['server'],d['server_identity'])
 process=None
 try:
  process=deploy.start(active,candidate_env,deploy.STATE/'server.log')
  deploy.ready(process,d['api'])
  actual=deploy.discover()
  assert digest(f"/proc/{actual['server']}/exe")==expected
  assert actual['env']['VIBE_PHYSX_DIRECT_GPU']==mode
  assert actual['env']['PHYSX_ROOT']==str(sdk)
  maps=Path(f"/proc/{actual['server']}/maps").read_text()
  assert str(sdk/'bin/linux.x86_64/release/libPhysXGpuActivity_64.so') in maps
  result=deploy.verify(actual,browser=True,public=True)
 except Exception:
  current=deploy.discover()
  if current['server']:
   if digest(f"/proc/{current['server']}/exe")!=expected or deploy.health(current['api']).get('players')!=0:
    raise RuntimeError('Verification failed; rollback refused because ownership changed or a player connected')
   for pid,stamp in current['supervisors']:deploy.stop(pid,stamp)
   deploy.stop(current['server'],current['server_identity'])
  elif process is not None and process.poll() is None:
   deploy.stop(process.pid,deploy.process_identity(process.pid))
  restored=deploy.start(backup,oldenv,deploy.STATE/'rollback.log')
  deploy.ready(restored,d['api'])
  raise
 (deploy.STATE/'deployment.json').write_text(json.dumps(dict(env=candidate_env,web=d['web'])))
 report=dict(binary_sha256=expected,previous_binary_sha256=digest(backup),sdk_manifest_sha256=digest(sdk/'gpu-activity-manifest.json'),direct_gpu=mode,verification=result)
 (root/'bench-results/simulation-frontier/velocity-fidelity/deployment.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2),flush=True)
