"""Private-port browser qualification, run only inside the exclusive GPU wrapper."""
import hashlib,importlib.util,json,os,subprocess,time,urllib.request
from pathlib import Path
spec=importlib.util.spec_from_file_location('city_deploy','/root/workspace/vibe-land-4/scripts/vast-city.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
config=json.loads((d.STATE/'outbound-candidate.json').read_text())
env=json.loads((d.STATE/'outbound-validation-env.json').read_text())
root=Path('/tmp/city-outbound-qualification');root.mkdir(exist_ok=False)
env.update(BIND_ADDR='127.0.0.1:40065',WT_BIND_ADDR='127.0.0.1:44365',WEB_BIND_ADDR='',VIBE_RELEASE_GAME_REVISION=config['game'],VIBE_RELEASE_SOLVER_REVISION=config['solver'],VIBE_RELEASE_BINARY_SHA256=config['sha256'])
assert hashlib.sha256(Path(config['binary']).read_bytes()).hexdigest()==config['sha256']
# Isolated proxy keeps the same static client and isolation headers without
# touching the public proxy or making the validation server publicly reachable.
caddyfile=root/'Caddyfile'
caddyfile.write_text('''{
 admin off
 auto_https off
}
https://127.0.0.1:44464 {
 tls %s %s
 header Cross-Origin-Opener-Policy same-origin
 header Cross-Origin-Embedder-Policy require-corp
 @api path /healthz /session-config /city-manifest/* /match-stats/* /city-reset/* /ws/*
 handle @api {
  reverse_proxy 127.0.0.1:40065
 }
 handle {
  root * /root/workspace/vibe-land-4/client/dist
  try_files {path} /index.html
  file_server
 }
}
''' % (env['WT_CERT_PEM'],env['WT_KEY_PEM']))
server=proxy=None
record=dict(config,start_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),tests=[])
(root/'run.json').write_text(json.dumps(record,indent=2)+'\n')
try:
 with (root/'server.log').open('w') as log:
  server=subprocess.Popen([config['binary']],cwd=d.ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
 d.ready(server,40065)
 with (root/'proxy.log').open('w') as log:
  proxy=subprocess.Popen(['caddy','run','--config',str(caddyfile),'--adapter','caddyfile'],cwd=d.ROOT,stdout=log,stderr=subprocess.STDOUT)
 for _ in range(50):
  try:
   d.fetch('https://127.0.0.1:44464/healthz');break
  except Exception: time.sleep(.1)
 else:raise RuntimeError('Private HTTPS proxy did not start')
 for name,harness,timeout in [('bootstrap',d.ROOT/'scripts/vast-city-verify.mjs',100),('destruction',d.ROOT/'bench-results/simulation-frontier/rooted-wire/browser-targeted-harness.mjs',170)]:
  command=['node',str(harness),'https://127.0.0.1:44464','44365',str(root/(name+'.json'))]
  with (root/(name+'.log')).open('w') as log:
   result=subprocess.run(command,cwd=d.ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=timeout)
  record['tests'].append({'name':name,'exit_code':result.returncode})
  print(name,result.returncode,flush=True)
  if result.returncode:raise RuntimeError(name+' qualification failed')
  report=json.loads((root/(name+'.json')).read_text())
  assert report['ok'] and report['city']['hashMismatches']==report['city']['structureRepairs']==0
 with urllib.request.urlopen('http://127.0.0.1:40065/match-stats/city-default',timeout=5) as response:stats=json.load(response)
 (root/'match-stats.json').write_text(json.dumps(stats,indent=2)+'\n')
 record['passed']=True
finally:
 for process in [proxy,server]:
  if process is not None and process.poll() is None:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait()
 record['finished_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
 (root/'run.json').write_text(json.dumps(record,indent=2)+'\n')
