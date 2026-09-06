from pathlib import Path
import fcntl,hashlib,importlib.util,json,os,shutil,time
root=Path('/root/workspace/vibe-land-4');stage=Path('/tmp/city-diagnostics-staged-client');live=root/'client/dist'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
proof=json.loads(Path('/tmp/city-diagnostics-staged-browser.json').read_text())
assert proof['ok'] and proof['city']['chunksTotal']==96420 and proof['city']['diagnosticSweep']['performed']
assert sha(stage/'index.html')=='0155c62cf6548173dbca6bca1109d597d2d8bd5a579d4c1807bce5405b431e34'
spec=importlib.util.spec_from_file_location('city_deploy',root/'scripts/vast-city.py');deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
with (deploy.STATE/'lock').open('w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 d=deploy.discover();assert d['server']==166548 and deploy.health(d['api'])['status']=='ok'
 binary_sha=sha(f"/proc/{d['server']}/exe")
 assert binary_sha=='7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee'
 assert sha(live/'index.html')=='fde8160a41dc72c3347e5f2c636b54edf9e830328cb3d9355881f6c57db2f836'
 added=[]
 for p in sorted(stage.rglob('*')):
  if not p.is_file() or p.name=='index.html':continue
  rel=p.relative_to(stage);target=live/rel
  if target.exists():assert sha(target)==sha(p),f'unexpected existing asset change: {rel}'
  else:
   assert rel.parts[0]=='assets',f'unexpected new public path: {rel}'
   added.append((p,target,sha(p)))
 backup=deploy.STATE/'client-index-before-diagnostics.html';assert not backup.exists()
 shutil.copyfile(live/'index.html',backup)
 for p,target,digest in added:
  target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copyfile(p,target)
  assert sha(target)==digest
 temporary=live/'index.diagnostics-next.html';shutil.copyfile(stage/'index.html',temporary)
 os.replace(temporary,live/'index.html')
 result={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'kind':'client-only static publication',
  'server_pid':d['server'],'server_sha256':binary_sha,'server_restarted':False,
  'players_before':deploy.health(d['api'])['players'],'index_sha256':sha(live/'index.html'),
  'previous_index_sha256':sha(backup),'rollback_index':str(backup),
  'added_assets':{str(target.relative_to(live)):digest for _,target,digest in added}}
 (deploy.STATE/'client-diagnostics-deployment.json').write_text(json.dumps(result,indent=2)+'\n')
 Path('/tmp/city-diagnostics-publication.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
