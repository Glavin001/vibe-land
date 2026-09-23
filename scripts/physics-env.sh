# Physics/destruction configuration for the vl4 city, in ONE place.
#
# Sourced by both scripts/run-vl4-server.sh and the perf suite. It lives here
# because the two drifted apart and the perf numbers silently stopped
# describing production: the suite ran with BLAST_BOND_STRESS_GPU unset, which
# defaults OFF in the library, so it measured the serial walk and reported idle
# at 14.9 ms/tick when production idles at 4.0. Anything that changes how the
# city simulates belongs in this file, not in one caller.
#
# Every value is `${VAR:-default}` so a caller can still override a single knob
# for an A/B without editing this file.

export VIBE_PHYSICS_BACKEND=${VIBE_PHYSICS_BACKEND:-physx_gpu}
# Which destruction engine drives /city: blast | blast-core | native.
#
# `native` is PhysX's own GPU destruction stage (physx-2), where stress,
# fracture and the corrected re-solve all run inside PxScene::simulate(). It
# needs a binary built with the native-destruction feature, and that binary
# links the physx-2 SDK rather than the upstream install -- hence the library
# path below, which must agree or the process loads a different engine than it
# was built against.
#
# macOS (Apple Silicon, Metal via CuMetal) has only the native stage: the
# binary is built with native-destruction alone. physx-bridge's build finds the
# PhysX fork's macos-cumetal install in a sibling checkout and links it with an
# rpath, so no SDK or library path is set here.
if [ "$(uname -s)" = "Darwin" ]; then
  export VIBE_CITY_DESTRUCTION=${VIBE_CITY_DESTRUCTION:-native}
else
export VIBE_CITY_DESTRUCTION=${VIBE_CITY_DESTRUCTION:-blast}
export PHYSX_DESTRUCTION_SDK=${PHYSX_DESTRUCTION_SDK:-/root/workspace/physx-2}
if [ "$VIBE_CITY_DESTRUCTION" = "native" ]; then
  export PHYSX_LIB_DIR=${PHYSX_LIB_DIR:-$PHYSX_DESTRUCTION_SDK/physx/bin/linux.x86_64/release}
  # Architecture 89 is qualified on CUDA 12.8; see the destruction runtime's
  # CMakeLists. A 13.x build of the same source compiles and then faults inside
  # the GPU module while creating a scene.
  export CUDA_HOME=${CUDA_HOME:-/usr/local/cuda-12.8}
else
  export PHYSX_LIB_DIR=${PHYSX_LIB_DIR:-${PHYSX_ROOT:-/root/PhysX/physx/install/linux-clang/PhysX}/bin/linux.x86_64/release}
fi
fi
# GPU capacities for a city-scale collapse.
#
# The defaults in WorldConfig are sized for a match, not for eight thousand
# simultaneously-colliding fragments, and overflowing PhysX's GPU collision
# stack or pair buffers is not a clean failure. What it produced here was an
# illegal memory access inside GPU narrowphase -- `Synchronizing GPU
# Narrowphase failed! 700` -- which poisons the CUDA context for the life of
# the process, so the server detects it and exits for a restart. From a
# player's side that is the match ending mid-collapse, repeatedly, with
# chunk_bodies around 8,700 each time.
#
# This card has 24 GB and the scene was using 1.8 of it, so the headroom was
# never the constraint; the numbers were just never raised past what a smaller
# scene needed. Raised well past the observed peak rather than to it, because
# the cost of being wrong in this direction is a crash and the cost in the
# other direction is some GPU memory nobody was using.
export VIBE_PHYSX_GPU_COLLISION_STACK_SIZE=${VIBE_PHYSX_GPU_COLLISION_STACK_SIZE:-536870912}
export VIBE_PHYSX_GPU_HEAP_CAPACITY=${VIBE_PHYSX_GPU_HEAP_CAPACITY:-2147483648}
export VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS=${VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS:-8388608}
export VIBE_PHYSX_GPU_MAX_RIGID_PATCHES=${VIBE_PHYSX_GPU_MAX_RIGID_PATCHES:-8388608}
export VIBE_PHYSX_GPU_FOUND_LOST_PAIRS_CAPACITY=${VIBE_PHYSX_GPU_FOUND_LOST_PAIRS_CAPACITY:-4194304}

export VIBE_CITY_SCENE=${VIBE_CITY_SCENE:-fractured-downtown.json}
export VIBE_CITY_GRID=${VIBE_CITY_GRID:-2}
export VIBE_CITY_VARIED_HEIGHTS=${VIBE_CITY_VARIED_HEIGHTS:-0}
export VIBE_CITY_FREEZE=${VIBE_CITY_FREEZE:-1}
export VIBE_CITY_STRESS_LIMIT_SCALE=${VIBE_CITY_STRESS_LIMIT_SCALE:-0.45}
# Shot profile. These now match ShotProfile::city() in destruction/src/
# city_config.rs (the structural-realism calibration: 1.2e7 at 2.5 m). The
# previous override here, 4.0e7 at 0.7 m, was tuned against the old physics and
# after the 2026-09-02 merge (Young's-modulus column scaling, fibre bending,
# 9.81 gravity) it breaks NOTHING: 12 shots on grid 1 -> 0 bonds, where this
# profile breaks 5,725. Judge the look on video before retuning either number.
export VIBE_CITY_SHOT_BLAST_RADIUS=${VIBE_CITY_SHOT_BLAST_RADIUS:-2.5}
export VIBE_CITY_SHOT_STRESS_IMPULSE=${VIBE_CITY_SHOT_STRESS_IMPULSE:-1.2e7}
export VIBE_CITY_EXCESS_FORCES=${VIBE_CITY_EXCESS_FORCES:-1}
# DEFAULT ON (owner decision 2026-09-02): fracture-frame resimulation is the
# intended production behaviour, and every measurement must include its cost.
# 0 disables it for A/B only. The code default (destruction/src/runtime.rs)
# is 1 as well, so tests get it without this file.
export VIBE_CITY_RESIM_PASSES=${VIBE_CITY_RESIM_PASSES:-1}
export VIBE_CITY_SOLVER_ITERATIONS=${VIBE_CITY_SOLVER_ITERATIONS:-32}
export VIBE_WORLD_FRICTION=${VIBE_WORLD_FRICTION:-0.75}
export VIBE_WORLD_RESTITUTION=${VIBE_WORLD_RESTITUTION:-0.02}

# DEFAULT ON: the incremental device-topology change (blast 5ed909d9) makes the
# GRID=2 city tear itself apart at rest -- no players, no shots, 0 -> 122,819
# broken bonds in 90 s. With this switch the same scene holds at 0 broken.
# Set to 0 only to reproduce the bug.
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=${BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY:-1}

# The bond-stress walk on the GPU. Default OFF in the library, ON here. At idle
# this is the difference between 10.5 ms/tick of walking 268k unmoving bonds
# and 0.2 ms, because the launch-skip cache retires 99% of the launches.
export BLAST_BOND_STRESS_GPU=${BLAST_BOND_STRESS_GPU:-1}
