import subprocess,sys
results=[]
for trial in [int(x) for x in sys.argv[1:]] or range(1,4):
 for arm in (('cpu','gpu') if trial%2 else ('gpu','cpu')):
  result=subprocess.run([sys.executable,'/tmp/qualify_contact_order_settling.py','collapse','direct','release',f'{arm}-{trial}','0' if arm=='cpu' else '1'])
  results.append(result.returncode)
  if result.returncode:sys.exit(result.returncode)
print('Settling controls exit codes',results,flush=True)
