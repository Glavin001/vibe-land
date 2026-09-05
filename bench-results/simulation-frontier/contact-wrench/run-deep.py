import os,subprocess,sys
from pathlib import Path
root=Path('/root/workspace/vibe-land-4')
env=dict(os.environ,CONTACT_ORDER_SECONDS='60',CONTACT_ORDER_SHOTS='400')
for i in ([int(x) for x in sys.argv[1:]] or range(1,4)):
 for order in ('0','1') if i%2 else ('1','0'):
  label=('deep-cpu-' if order=='0' else 'deep-gpu-')+str(i)
  subprocess.run([sys.executable,str(Path(__file__).with_name('profile.py')),label,order],cwd=root,env=env,check=True)
