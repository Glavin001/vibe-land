import subprocess
codes=[]
for mode,suffix in [('audit',''),('collapse','repeat1'),('collapse','repeat2')]:
 command=['python3','/tmp/qualify_velocity_city.py',mode,'direct','release']
 if suffix:command.append(suffix)
 codes.append(subprocess.run(command).returncode)
raise SystemExit(1 if any(codes) else 0)
