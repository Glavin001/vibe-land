cmake_minimum_required(VERSION 3.24)
project(TownKitWarmRuntime LANGUAGES CXX CUDA)
set(PHYSX_ROOT_DIR "/root/workspace/physx-2/physx" CACHE PATH "SDK PhysX directory")
set(PHYSX_SOURCE_DIR "${PHYSX_ROOT_DIR}/source")
# Build the SDK's own target in a private build tree. Never run its shared
# preset/generation/install commands or overwrite installed runtime artifacts.
add_subdirectory("${PHYSX_SOURCE_DIR}/gpudestruction/runtime" native-runtime)
