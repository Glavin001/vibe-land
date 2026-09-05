import subprocess,sys
from pathlib import Path
r=Path('/root/workspace/vibe-land-4')
q=r/'bench-results/simulation-frontier/contact-wrench/qualify.py'
commands=[[sys.executable,str(q),'full-tests','direct','release','cpu-order','0'],[sys.executable,str(q),'audit','direct','release','gpu-order','1']]
results=[]
for command in commands:
 results.append(subprocess.run(command,cwd=r).returncode)
 if results[-1]: break
print('City qualification exit codes',results,flush=True)
raise SystemExit(any(results))
