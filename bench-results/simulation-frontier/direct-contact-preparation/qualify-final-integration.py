import subprocess
for mode in ('full-tests','audit','scenario'):
 subprocess.run(['python3','/tmp/qualify_publication_city.py',mode,'direct','release'],check=True)
