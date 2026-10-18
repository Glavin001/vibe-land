# Moving vehicle stress geometry: build-only checkpoint

PhysX commit `d82b4da7`. The new device geometry transaction and test harness
compile with the isolated FP64 CuMetal stress core. This is **unqualified WIP**:
no new GPU test has executed, and no live runtime has been replaced.

The first build rejected undefined padding in an aligned helper return value;
explicit initialized trailing fields corrected it. The next build rejected a
host-only harness compiled as CUDA (no kernel launch stubs); changing that
harness to ordinary C++ corrected it. The third build completes both the new
geometry target and the existing stress integration target. Raw logs are kept.
Artifact hashes identify what was actually built, not a passing runtime result.

Regression coverage authored: whole-batch geometry validation, moved positions
and inertias versus fresh solves, independent force/moment equilibrium, reversed
support endpoints, stale/skipped/repeated updates, partial-write rejection,
retained broken bonds and invalid updates with no remaining live bonds.
The implementation also avoids geometry guard launches for callers that have
never used the extension, and fails closed after enqueue errors.

GPU execution is deferred while the user-requested local city server holds the
shared GPU lock. Do not kill it or run overlapping tests. CUDA/Vast testing is
still deferred. The stress-only API does not yet synchronize collision shapes,
full mass tensors, body COM/momentum or material geometry. Garage destruction,
normal-driving durability, fragment streaming and bombardment remain unfinished.

See PhysX `docs/destruction/VEHICLE_MOVING_GEOMETRY.md` for the contract and next
integration boundary. No performance, frozen-penetration or complete-vehicle
qualification is claimed.
