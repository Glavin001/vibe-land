"""Build the SDK scaling diagnostic in a new private directory, never in the SDK."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('label');args=p.parse_args()
kit=Path(__file__).resolve().parents[2];sdk=Path('/root/workspace/physx-2');out=kit/'out'/args.label
out.mkdir(exist_ok=False);source=out/'stressgpu';shutil.copytree(sdk/'blast/source/sdk/extensions/stressgpu',source)
patch=Path(__file__).with_name('diagnostic-exact-scaling.patch');subprocess.run(['patch','--batch',str(source/'NvBlastExtStressGpu.cu'),str(patch)],check=True)
(out/'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.24)
project(TownKitBinaryScalingProbe LANGUAGES CXX CUDA)
set(PHYSX_ROOT_DIR "/root/workspace/physx-2/physx")
set(PHYSX_SOURCE_DIR "${PHYSX_ROOT_DIR}/source")
add_subdirectory("${PHYSX_SOURCE_DIR}/gpudestruction/runtime" native-runtime)
get_target_property(sources PhysXDestructionGpuRuntime SOURCES)
list(FILTER sources EXCLUDE REGEX "NvBlastExtStressGpu.cu$")
list(APPEND sources "${CMAKE_CURRENT_SOURCE_DIR}/stressgpu/NvBlastExtStressGpu.cu")
set_property(TARGET PhysXDestructionGpuRuntime PROPERTY SOURCES "${sources}")
''')
subprocess.run(['cmake','-S',str(out),'-B',str(out/'build'),'-DCMAKE_CUDA_COMPILER=/usr/local/cuda-12.8/bin/nvcc','-DCMAKE_BUILD_TYPE=Release'],check=True)
subprocess.run(['cmake','--build',str(out/'build'),'--target','PhysXDestructionGpuRuntime','-j2'],check=True)
lib=out/'build/native-runtime/libPhysXDestructionGpuRuntime_64.so'
(out/'receipt.json').write_text(json.dumps({'sdkRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=sdk,text=True).strip(),'patchSha256':hashlib.sha256(patch.read_bytes()).hexdigest(),'runtimeSha256':hashlib.sha256(lib.read_bytes()).hexdigest()},indent=2));print(lib)
