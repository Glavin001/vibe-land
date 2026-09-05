from pathlib import Path
import os,subprocess,json
out=Path('/root/workspace/vibe-land-4/bench-results/simulation-frontier/lazy-readback-promotion')
exe='/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build/gpu_lazy_readback_test'
results={}
for name,extra in (('bond-space',{'BLAST_GPU_NODE_SPACE':'0'}),('jacobi',{'BLAST_GPU_JACOBI':'1'})):
 env=dict(os.environ,BLAST_GPU_DETERMINISTIC_REDUCTIONS='1',BLAST_GPU_GATHER='1',**extra)
 with (out/('cpu-gpu-preparation-'+name+'.log')).open('w') as log:
  result=subprocess.run([exe,'--cpu-gpu-walk'],env=env,stdout=log,stderr=subprocess.STDOUT)
 results[name]=result.returncode
 print(name,result.returncode,flush=True)
(out/'cpu-gpu-preparation-variants.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(any(results.values()))
