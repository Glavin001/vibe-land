import os,subprocess,sys
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
for i in range(1,4):
 for order in ('0','1') if i%2 else ('1','0'):
  label=('cpu-' if order=='0' else 'gpu-')+str(i)
  subprocess.run([sys.executable,'/tmp/profile_contact_order.py',label,order],cwd=root,check=True)
