import hashlib,json,os,subprocess,sys,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4'); solver=Path('/root/workspace/blast-stress-solver-2')
out=root/'bench-results/simulation-frontier/velocity-fidelity';out.mkdir(parents=True,exist_ok=True)
phase=sys.argv[1]
env={k:v for k,v in os.environ.items() if not k.startswith(('BLAST_','VIBE_'))}
env.update(LD_LIBRARY_PATH='/usr/local/cuda/lib64:/root/workspace/physx-gpu-activity/physx/bin/linux.x86_64/release',BLAST_GPU_IMPULSE_READBACK='0')
cpp=solver/'demos/blast-stress-demo/build-gpu-activity/velocity_fidelity_test'
bridge=list((root/'target/gpu-activity/debug/deps').glob('velocity_fidelity-*'))
bridge=[p for p in bridge if p.is_file() and os.access(p,os.X_OK)]
assert len(bridge)==1, bridge
rows=[]
for label,cmd,direct in [(mode,[str(cpp),mode],mode=='direct') for mode in ('cpu','gpu','direct')]+[('bridge-'+mode,[str(bridge[0]),'--nocapture','--test-threads=1'],mode=='direct') for mode in ('gpu','direct')]:
    runenv=dict(env,VIBE_PHYSX_DIRECT_GPU='1' if direct else '0')
    start=time.monotonic()
    with (out/(phase+'-'+label+'.log')).open('w') as log:
        result=subprocess.run(cmd,env=runenv,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=60)
    row=dict(label=label,exit_code=result.returncode,wall_seconds=time.monotonic()-start,binary_sha256=hashlib.sha256(Path(cmd[0]).read_bytes()).hexdigest(),command=cmd)
    rows.append(row);print(phase,label,result.returncode,flush=True)
(out/(phase+'.json')).write_text(json.dumps(rows,indent=2)+'\n')

if phase != "before":
    raise SystemExit(1 if any(row["exit_code"] for row in rows) else 0)
