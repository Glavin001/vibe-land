import subprocess
codes=[]
for mode in ('native','direct'):
 codes.append(subprocess.run(['python3','/tmp/qualify_velocity_city.py','scenario',mode,'release']).returncode)
raise SystemExit(1 if any(codes) else 0)
