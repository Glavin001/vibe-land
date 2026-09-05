import ctypes,json,os,signal,subprocess,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
out=root/'bench-results/simulation-frontier/direct-gpu-city-qualification'
manifest=json.loads((out/'direct-destruction.json').read_text())
env={k:v for k,v in os.environ.items() if not k.startswith(('VIBE_','BLAST_'))}
env.update(manifest['env'],LD_PRELOAD='/tmp/direct-gpu-stack-probe.so')
binary=root/'target/gpu-activity/debug/deps/authored_structures_sim-25f9971959a3b1fc'
command=[str(binary),'--exact','a_dropped_building_breaks_up_instead_of_landing_in_one_piece','--nocapture','--test-threads=1']
start=time.monotonic();snapshots=[]
with (out/'direct-drop-probe.log').open('w') as log:
 p=subprocess.Popen(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 for i in range(9):
  try:
   code=p.wait(timeout=20)
   break
  except subprocess.TimeoutExpired:
   candidates=[]
   for t in (Path('/proc')/str(p.pid)/'task').iterdir():
    if (t/'comm').read_text().strip()=='a_dropped_build':
     data=(t/'stat').read_text().split(') ',1)[1].split()
     candidates.append((int(data[11])+int(data[12]),int(t.name)))
   if candidates:
    ticks,tid=max(candidates)
    rc=ctypes.CDLL(None).tgkill(p.pid,tid,signal.SIGUSR2)
    snapshots.append({'seconds':time.monotonic()-start,'tid':tid,'cpu_ticks':ticks,'signal_result':rc})
    print('Sample',len(snapshots),'at',round(time.monotonic()-start),'s',flush=True)
 else:
  p.terminate();code=p.wait(timeout=5)
 (out/'direct-drop-probe.json').write_text(json.dumps({'command':command,'source_manifest':'direct-destruction.json','test_only_preload':'direct-gpu-stack-probe.so','wall_seconds':time.monotonic()-start,'exit_code':code,'samples':snapshots},indent=2)+'\n')
print('Probe finished',code,flush=True)
raise SystemExit(0 if code==0 else 1)
