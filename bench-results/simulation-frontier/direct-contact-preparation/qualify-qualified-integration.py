import subprocess
failed=False
for mode in ('full-tests','audit','scenario'):
 r=subprocess.run(['python3','/tmp/qualify_publication_city.py',mode,'direct','release'])
 failed |= r.returncode!=0
 if r.returncode:print(mode+' failed; retaining result and completing independent checks',flush=True)
raise SystemExit(1 if failed else 0)
