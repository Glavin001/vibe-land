# Precision experiment: converged impacts, incomplete destruction

The existing `BLAST_STRESS_GPU_FP64=ON` option removes the full-model convergence
failures in this local CuMetal fixture. The actual projectile, geometry, mass,
materials, 2048-iteration cap, 1e-5 tolerance and one-correction limit are unchanged.
No source precision default or live installed SDK was changed.

All six models complete 30 pre-impact steps and 120 post-impact steps with zero
native errors, convergence and valid shape ownership. The companion free-fall
test also passes all six models without fracture. The authored impact test
**still fails** because four models do not break any bonds:

| Model | Broken bonds | Target wheel detached |
|---|---:|---|
| Buggy | 0 | No |
| Trophy | 0 | No |
| Rally | 0 | No |
| Monster | 1 | No |
| Derby | 2 | No |
| Sprint | 0 | No |

The existing bridge suite passes all 12 tests against this same overlay,
including city destruction/reset, tiny-COM registration, and the six-chunk
Vehicle2 fixture's 180 idle + 120 driving + 120 impact steps. That fixture uses
a **300 kg** projectile: the weaker interface detaches one wheel and disables
it for 119 following ticks; the stronger-material control does not fracture.
It does not substitute for the complete model's 30 kg cannon test.

Evidence: [impact output](impact.log), [all impact frames](impact.json.gz),
[bridge report](bridge-report.json), [bridge output](bridge-tests.log),
[configuration](configure.log), [build](build.log), [artifact hashes](artifacts.json).
Select `/tmp/vehicle-stress-fp64-libs` explicitly to reproduce this candidate.
The packaged ABI 22 SDK and live ABI 18 SDK remain unchanged.

Qualification is numerical/functional **for these isolated fixtures only**.
The first test run spent approximately five minutes compiling Metal shaders;
the total test duration cannot establish steady-state simulation cost. No
complete-step performance, frozen penetration, browser, moving-suspension,
full-model wheel detachment or remote CUDA qualification is claimed.

Next work must isolate the precision needed for a practical runtime, calibrate
actual joint behavior against operating and impact loads, and implement the
moving-geometry/lifecycle/streaming contracts. Lowering the accuracy tolerance
or accepting unconverged damage is not a substitute.
