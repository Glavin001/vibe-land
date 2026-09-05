import fcntl
import importlib.util
from pathlib import Path
import subprocess
import os
import signal
import sys
spec=importlib.util.spec_from_file_location('city_deploy','/root/workspace/vibe-land-4/scripts/vast-city.py')
deploy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
with (deploy.STATE/'lock').open('w') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    d=deploy.discover()
    if not d['server'] or deploy.health(d['api']).get('players') != 0:
        raise RuntimeError('Exclusive GPU tests require a healthy idle deployment')
    binary=Path(f"/proc/{d['server']}/exe").resolve()
    if not binary.is_file(): raise RuntimeError('Original server binary cannot be restored')
    result=1
    try:
        for pid,identity in d['supervisors']: deploy.stop(pid,identity)
        deploy.stop(d['server'],d['server_identity'])
        build=Path('/root/workspace/blast-stress-solver-2/demos/blast-stress-demo/build')
        command=sys.argv[1:] or ['ctest','--test-dir',str(build),'-R','blast_stress_gpu_(device_input|equivalence)$|direct_gpu_resim','--output-on-failure']
        process=subprocess.Popen(command,start_new_session=True)
        try:
            result=process.wait(timeout=600)
        except BaseException:
            # Own this process group: do not leave test/trace children on the
            # GPU when restoring the deployment after a timeout or interrupt.
            try: os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait()
            raise
    finally:
        restored=deploy.start(binary,d['env'],deploy.STATE/'server.log')
        deploy.ready(restored,d['api'])
        print('Original city deployment restored and healthy',flush=True)
    sys.exit(result)
