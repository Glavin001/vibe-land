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
export VIBE_CITY_SCENE=${VIBE_CITY_SCENE:-fractured-downtown.json}
export VIBE_CITY_GRID=${VIBE_CITY_GRID:-2}
export VIBE_CITY_VARIED_HEIGHTS=${VIBE_CITY_VARIED_HEIGHTS:-0}
export VIBE_CITY_FREEZE=${VIBE_CITY_FREEZE:-1}
export VIBE_CITY_STRESS_LIMIT_SCALE=${VIBE_CITY_STRESS_LIMIT_SCALE:-0.45}
export VIBE_CITY_SHOT_BLAST_RADIUS=${VIBE_CITY_SHOT_BLAST_RADIUS:-0.7}
export VIBE_CITY_SHOT_STRESS_IMPULSE=${VIBE_CITY_SHOT_STRESS_IMPULSE:-4.0e7}
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
