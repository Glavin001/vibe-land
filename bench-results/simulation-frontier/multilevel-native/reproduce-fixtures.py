#!/usr/bin/env python3
"""Regenerate fixture binaries and basis sidecars into a specified scratch dir."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out',required=True,type=Path)
args=parser.parse_args()
root=Path(__file__).resolve().parent
solver=Path('/root/workspace/blast-stress-solver-2')
graph=Path('/root/workspace/vibe-land-4/bench-results/simulation-frontier/contact-wrench/conditioning/single-building.json.gz')
args.out.mkdir(parents=True,exist_ok=True)
cases=[('anchored',[],True),('free',['--release','--loads','random'],True),('large-load',['--release','--loads','random','--load-scale','1e30'],False),('small-load',['--release','--loads','random','--load-scale','1e-30'],False),('free-gravity',['--release'],False),('free-zero',['--release','--loads','zero'],False),('anchored-zero',['--loads','zero'],False)]
env=dict(os.environ,OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
for name,extra,basis in cases:
 cmd=[sys.executable,str(solver/'demos/blast-stress-demo/tests/export_multilevel.py'),'--graph',str(graph),'--out',str(args.out/f'multilevel-{name}.bin'),*extra]
 if basis:cmd+=['--basis-out',str(args.out/f'multilevel-{name}.basis')]
 with (args.out/f'{name}.log').open('w') as log:subprocess.run(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
checks=[]
for fixture in json.loads((root/'fixtures.json').read_text()):
 path=args.out/Path(fixture['path']).name
 digest=hashlib.sha256(path.read_bytes()).hexdigest()
 assert digest==fixture['sha256'],str(path)
 checks.append({'file':path.name,'sha256':digest,'matched':True})
print(json.dumps(checks,indent=2))
