import hashlib,json,os,subprocess,sys,time
from pathlib import Path
root=Path('/root/workspace/vibe-land-4'); solver=Path('/root/workspace/blast-stress-solver-2')
out=root/'bench-results/simulation-frontier/gpu-contact-order/qualification';out.mkdir(parents=True,exist_ok=True)
cmd=['ctest','--test-dir',str(solver/'demos/blast-stress-demo/build-gpu-activity'),'-R','blast_stress_velocity_fidelity_(cpu|gpu|direct)$|blast_stress_physx_direct_gpu_(resim|contacts)$|blast_stress_physx_gpu_activity$','--output-on-failure','-V']
env=dict(os.environ,LD_LIBRARY_PATH='/usr/local/cuda/lib64:/root/workspace/physx-gpu-activity/physx/bin/linux.x86_64/release')
meta={'command':cmd,'start_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'binary_sha256':hashlib.sha256((solver/'demos/blast-stress-demo/build-gpu-activity/direct_gpu_contact_test').read_bytes()).hexdigest()}
t=time.monotonic()
with (out/'native.log').open('w') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
meta.update(exit_code=r.returncode,wall_seconds=time.monotonic()-t);(out/'native-run.json').write_text(json.dumps(meta,indent=2)+'\n')
print('Native qualification',r.returncode,round(meta['wall_seconds'],2),flush=True)
if r.returncode:sys.exit(r.returncode)
subprocess.run([sys.executable,'/tmp/profile_contact_order.py','provenance-audit','1','verify'],cwd=root,check=True)
subprocess.run([sys.executable,'/tmp/qualify_contact_order_city.py','full-tests','direct','release'],cwd=root,check=True)
