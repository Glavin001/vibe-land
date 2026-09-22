"""Run comparisons sequentially, using a private binary/cache and the live SDK runtime."""
import os,json,subprocess,hashlib,time,gzip,shutil
from pathlib import Path
KIT=Path(__file__).resolve().parents[2];REPO=KIT.parents[1];ROOT=KIT/'out/reviews/house-cannonball'
lock=KIT/'out/native-review.lock'
with lock.open('x') as f:json.dump({'pid':os.getpid(),'root':str(ROOT)},f)
try:
 binary=KIT/'native/target/release/house-impact-review'
 runtime=Path(os.environ.get('TOWN_KIT_DIAGNOSTIC_RUNTIME',str(REPO/'.certs/vast-city/warm-runtime')))
 gpu=Path(os.environ.get('TOWN_KIT_DIAGNOSTIC_GPU_DIR','/root/workspace/physx-2/physx/bin/linux.x86_64/release'))
 env=os.environ.copy();env.update({'PHYSX_DESTRUCTION_RUNTIME_DIR':str(runtime),'LD_LIBRARY_PATH':f'{runtime}:{gpu}:/root/workspace/physx-2/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64','VIBE_CITY_NATIVE_VERDICT_SAMPLE_TICKS':'1','VIBE_CITY_NATIVE_CORRECTION_LIMIT':os.environ.get('VIBE_CITY_NATIVE_CORRECTION_LIMIT','2'),'VIBE_CITY_NATIVE_STRESS_TOLERANCE':'0.001','VIBE_CITY_NATIVE_STRESS_ITERATIONS':os.environ.get('VIBE_CITY_NATIVE_STRESS_ITERATIONS','16'),'VIBE_CITY_NATIVE_DEPEN_VELOCITY':'0','VIBE_CITY_NATIVE_SLEEP_THRESHOLD':'0','VIBE_CITY_NATIVE_STABILIZATION_THRESHOLD':'0','VIBE_CITY_DEBRIS_LINEAR_DAMPING':'0','VIBE_CITY_DEBRIS_ANGULAR_DAMPING':'0','VIBE_CITY_STRESS_LIMIT_SCALE':'1'})
 provenance={'exclusiveGpu':False,'gpuLibraryPath':str(gpu/'libPhysXGpuActivity_64.so'),'gpuLibrarySha256':hashlib.sha256((gpu/'libPhysXGpuActivity_64.so').read_bytes()).hexdigest(),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'runtimeSha256':hashlib.sha256((runtime/'libPhysXDestructionGpuRuntime_64.so').read_bytes()).hexdigest(),'repoRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),'sdkRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd='/root/workspace/physx-2',text=True).strip(),'hardware':subprocess.check_output(['nvidia-smi','--query-gpu=name,driver_version,memory.used,utilization.gpu','--format=csv,noheader'],text=True).strip(),'settings':{k:v for k,v in env.items() if k.startswith(('VIBE_CITY_NATIVE_','VIBE_CITY_DEBRIS_','VIBE_PHYSX_','PHYSX_STRESS_','PHYSX_COMPONENT_'))},'started':time.time()}
 provenance_file=ROOT/('provenance-'+str(time.time_ns())+'.json')
 provenance_file.write_text(json.dumps(provenance,indent=2))
 import sys
 failures=[]
 for name in sys.argv[1:] or ['house-1story','bungalow','house-2story','porch-house']:
  d=ROOT/name
  if (d/'report.json').exists():raise RuntimeError(f'Preserve existing results: {d}')
  (d/'provenance.json').write_text(json.dumps(provenance,indent=2))
  with (d/'run.log').open('w') as log:p=subprocess.run([str(binary),str(d/'asset.json'),str(d)],env=env,stdout=log,stderr=log,timeout=240)
  # Preserve dense evidence losslessly without leaving hundreds of MB of JSON.
  recording=d/'recording.json'
  if recording.exists() and json.loads((d/'shot.json').read_text()).get('sampleTicks',0):
   compressed=d/'recording.json.gz'
   if compressed.exists():raise RuntimeError(f'Preserve existing recording: {compressed}')
   with recording.open('rb') as src,gzip.open(compressed,'wb',compresslevel=3) as dst:shutil.copyfileobj(src,dst)
   recording.unlink()
  if p.returncode:failures.append(name)
  print(name,p.returncode,(d/'report.json').read_text() if (d/'report.json').exists() else 'missing report',flush=True)
 if failures:raise RuntimeError('Native cases failed completion or physical acceptance: '+', '.join(failures))
finally:
 if json.loads(lock.read_text())['pid']==os.getpid():lock.unlink()
