#!/usr/bin/env python3
"""Isolated Bayline runtime. Copies finished builds; never rebuilds or stops shared services."""
import argparse, gzip, hashlib, json, os, pathlib, shutil, signal, socket, subprocess, sys, time, urllib.request
KIT=pathlib.Path(__file__).resolve().parents[1]
REPO=KIT.parents[1]
RUN=KIT/'out/bayline-runtime'
STATE=RUN/'process.json'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,obj): p.write_text(json.dumps(obj,indent=2)+'\n')
def identity(pid):
    try: return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[19]
    except (FileNotFoundError,ProcessLookupError): return None

def owned():
    if not STATE.exists(): return None
    state=json.loads(STATE.read_text())
    return state if identity(state['pid'])==state['startTicks'] else None

def free(port,udp=False):
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:s.bind(('0.0.0.0',port))

def prepare(scene="bayline-small-town"):
    if owned(): raise RuntimeError('This scene is running; stop only this scene before refreshing its snapshot.')
    RUN.mkdir(parents=True,exist_ok=True)
    # Assets referenced by /city, excluding the unrelated 409 MiB scene library.
    source=REPO/'client/dist';web=RUN/'web';web.mkdir(exist_ok=True)
    files={}
    for p in source.rglob('*'):
        relative=p.relative_to(source)
        if not p.is_file() or relative.parts[0]=='scenes': continue
        dest=web/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
        files[str(relative)]=sha(dest)
        if files[str(relative)]!=sha(p):raise RuntimeError('Client build changed during snapshot; retry prepare.')
    index=web/'index.html'
    injection='''<script>document.title='Bayline Town · Experimental';let townFinishAttempts=0;const townFinish=setInterval(()=>{if(window.__VIBE_CITY_TEX__){window.__VIBE_CITY_TEX__({scale:.65,normalScale:.5,tone:1.04,macroAlbedo:.065,macroNormal:.05,macroRough:.055});clearInterval(townFinish)}else if(++townFinishAttempts>600)clearInterval(townFinish)},100);</script>'''
    index.write_text(index.read_text().replace('</head>',injection+'</head>'))
    binary=RUN/'bayline-server';shutil.copy2(REPO/'target/release/web-fps-server',binary)
    if sha(binary)!=sha(REPO/'target/release/web-fps-server'):raise RuntimeError('Server changed during snapshot; retry prepare.')
    source_pack=KIT/'out'/(scene+'.json')
    if source_pack.exists():shutil.copy2(source_pack,RUN/source_pack.name)
    else:
        with gzip.open(str(source_pack)+'.gz','rb') as source, (RUN/source_pack.name).open('wb') as target:shutil.copyfileobj(source,target)
    shutil.copy2(KIT/'out'/(scene+'.meta.json'),RUN/(scene+'.meta.json'))
    expected=json.loads((RUN/(scene+'.meta.json')).read_text())['assetSha256']
    if sha(RUN/(scene+'.json'))!=expected:raise RuntimeError('Scene snapshot does not match its reviewed asset hash.')
    save(RUN/'snapshot.json',{'createdAt':time.time(),'scene':scene,'sceneSha256':sha(RUN/(scene+'.json')),'serverSha256':sha(binary),'clientSources':files,'clientIndexSha256':sha(index),'sdk':json.loads((REPO.parent/'physx-2/out/sdk-artifacts.json').read_text())})
    return binary

def supervise():
    config=json.loads((RUN/'config.json').read_text());env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','PHYSX_','BLAST_','WT_'))}
    env.update(config['env']);child=subprocess.Popen([str(RUN/'bayline-server')],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    save(STATE,{'pid':os.getpid(),'startTicks':identity(os.getpid()),'childPid':child.pid,'url':config['url'],'apiPort':config['apiPort'],'udpPort':config['udpPort']})
    def stop(*_):
        if child.poll() is None:child.terminate()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    log=RUN/'server.log'
    try:
        with log.open('ab',buffering=0) as out:
            for line in iter(child.stdout.readline,b''):
                if out.tell()>2*1024*1024:
                    out.close();previous=RUN/'server.previous.log';os.replace(log,previous);out=log.open('ab',buffering=0)
                out.write(line)
        child.wait()
    finally:
        if child.poll() is None:
            child.terminate()
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        state=owned()
        if state and state['pid']==os.getpid():STATE.unlink(missing_ok=True)

p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['prepare','start','status','stop','supervise'])
p.add_argument('--scene',choices=['bayline-town','bayline-district','bayline-small-town'],default='bayline-small-town');p.add_argument('--host',default='127.0.0.1');p.add_argument('--web-port',type=int,default=6176);p.add_argument('--api-port',type=int,default=6175);p.add_argument('--udp-port',type=int,default=6177);p.add_argument('--public-web-port',type=int);p.add_argument('--public-udp-port',type=int)
a=p.parse_args()
if a.action=='supervise':supervise();sys.exit()
if a.action=='status':print(json.dumps(owned() or {'running':False},indent=2));sys.exit()
if a.action=='stop':
    state=owned()
    if state:os.kill(state['pid'],signal.SIGTERM)
    print('Stopped only the owned Bayline scene.' if state else 'Bayline is not running.');sys.exit()
if a.action=='prepare':prepare(a.scene);print(RUN);sys.exit()
if owned():raise RuntimeError('Bayline already running; use status for its address.')
if (KIT/'out/native-review.lock').exists():raise RuntimeError('Wait for the town-kit native review or capture to finish before starting the live scene.')
for port in [a.web_port,a.api_port]:free(port)
free(a.udp_port,True)
prepare(a.scene)
cert=RUN/'page-cert.pem';key=RUN/'page-key.pem'
subprocess.run(['openssl','ecparam','-name','prime256v1','-genkey','-noout','-out',str(key)],check=True);key.chmod(0o600)
subprocess.run(['openssl','req','-new','-x509','-key',str(key),'-out',str(cert),'-days','12','-subj',f'/CN={a.host}','-addext',f'subjectAltName=IP:{a.host},IP:127.0.0.1'],check=True)
sdk=REPO.parent/'physx-2';lib=sdk/'physx/bin/linux.x86_64/release'
if not (lib/'libPhysXGpuActivity_64.so').exists():raise RuntimeError('Native GPU SDK missing')
url=f'https://{a.host}:{a.public_web_port or a.web_port}/city'
env={'BIND_ADDR':f'127.0.0.1:{a.api_port}','WEB_BIND_ADDR':f'0.0.0.0:{a.web_port}','WT_BIND_ADDR':f'0.0.0.0:{a.udp_port}','WT_PUBLIC_URL':f'https://{a.host}:{a.public_udp_port or a.udp_port}',
 'WT_CERT_PEM':str(cert),'WT_KEY_PEM':str(key),'VIBE_WEB_DIR':str(RUN/'web'),'VIBE_DESTRUCTION_ASSET_DIR':str(RUN),'VIBE_CITY_SCENE':a.scene+'.json','VIBE_CITY_GRID':'1','VIBE_CITY_VARIED_HEIGHTS':'0',
 'VIBE_PHYSICS_BACKEND':'physx_gpu','VIBE_CITY_DESTRUCTION':'native','VIBE_CITY_FREEZE':'0','VIBE_CITY_NATIVE_SETTLE_TICKS':'0','VIBE_CITY_NATIVE_SETTLE_FREEZE':'0','VIBE_CITY_NATIVE_DEBRIS_FLOOR_M':'-inf',
 'VIBE_CITY_NATIVE_STRESS_ITERATIONS':'16','VIBE_CITY_NATIVE_VERDICT_SAMPLE_TICKS':'1','PHYSX_DESTRUCTION_SDK':str(sdk),'CUDA_HOME':'/usr/local/cuda-12.8','LD_LIBRARY_PATH':f'/usr/local/cuda-12.8/lib64:{lib}',
 'SKIP_SPACETIMEDB_VERIFY':'1','RUST_LOG':'info'}
save(RUN/'config.json',{'url':url,'apiPort':a.api_port,'udpPort':a.udp_port,'env':env})
proc=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).resolve()),'supervise'],cwd=KIT,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for _ in range(60):
    if proc.poll() is not None:raise RuntimeError(f'Bayline exited; inspect {RUN}/server.log')
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{a.api_port}/healthz',timeout=1) as r:health=json.load(r)
        print(json.dumps({'url':url,'health':health,'state':str(STATE)},indent=2));break
    except Exception:time.sleep(.5)
else:
    proc.terminate();raise RuntimeError(f'Bayline did not become healthy; inspect {RUN}/server.log')
