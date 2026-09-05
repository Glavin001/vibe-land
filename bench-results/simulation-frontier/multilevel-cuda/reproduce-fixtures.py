import hashlib,json,os,subprocess
from pathlib import Path
repo=Path('/root/workspace/blast-stress-solver-2')
script=repo/'demos/blast-stress-demo/tests/export_multilevel.py'
graph='/root/workspace/vibe-land-4/bench-results/simulation-frontier/contact-wrench/conditioning/single-building.json.gz'
cases=[('anchored',[]),('free',['--release','--loads','random']),('reused',['--release','--loads','random','--reuse-anchored-hierarchy']),('large-load',['--release','--loads','random','--load-scale','1e30']),('small-load',['--release','--loads','random','--load-scale','1e-30'])]
env=dict(os.environ,OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
records=[]
for name,args in cases:
 output=Path('/tmp/multilevel-reproduced.bin')
 command=['python3',str(script),'--graph',graph,'--out',str(output),*args]
 with Path('/tmp/multilevel-reproduce-'+name+'.log').open('w') as log:subprocess.run(command,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
 original=Path('/tmp/multilevel-'+name+'.bin')
 digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 record={'fixture':name,'bytes':original.stat().st_size,'sha256':digest(original),'reproduced_sha256':digest(output),'options':args}
 assert record['sha256']==record['reproduced_sha256'],record
 records.append(record);print(json.dumps(record),flush=True)
Path('/tmp/multilevel-fixture-reproduction.json').write_text(json.dumps(records,indent=2)+'\n')
