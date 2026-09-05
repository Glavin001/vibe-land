import os,subprocess,sys
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
env=dict(os.environ,CONTACT_ORDER_SECONDS='20',CONTACT_ORDER_SHOTS='200')
results=[]
for command,task_env in [([sys.executable,'/tmp/profile_contact_order.py','heavy-audit','1','verify'],env),([sys.executable,'/tmp/qualify_contact_order_city.py','scenario','direct','release'],os.environ)]:
 results.append(subprocess.run(command,cwd=root,env=task_env).returncode)
print('Final qualification exit codes',results,flush=True)
sys.exit(any(results))
