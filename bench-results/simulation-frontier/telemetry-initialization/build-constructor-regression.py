from pathlib import Path
import subprocess,sys
root=Path('/root/workspace/blast-stress-solver-2-rooted-wire');blast=root/'blast';physx=Path('/root/workspace/physx-gpu-activity/physx')
command=['g++','-std=c++17','-O2','-DNDEBUG','-DPX_PHYSX_STATIC_LIB','-ffunction-sections','-fdata-sections']
for p in [blast/'include',blast/'include/lowlevel',blast/'include/shared/NvFoundation',blast/'include/extensions/stressphysx',blast/'rust_stress_example/ffi',physx/'include']:
 command += ['-I',str(p)]
command += [str(root/'demos/blast-stress-demo/tests/telemetry_initialization_test.cpp'),str(blast/'source/sdk/extensions/stressphysx/NvBlastExtStressPhysX.cpp'),'-Wl,--gc-sections','-o',sys.argv[1]]
subprocess.run(command,check=True)
