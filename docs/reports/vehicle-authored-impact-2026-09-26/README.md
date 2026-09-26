# Complete authored vehicle impact gate — failing

This is an actual local CuMetal physics regression, not a damage simulation or
performance qualification. The checkpoint preceding it is Vibeland `be344f92`
and PhysX `df66f3a6`. The live ABI 18 SDK is unchanged.

All six drivable base models pass the companion 30-step free-fall test with
their complete native chunk/bond graphs, original material strengths and simple
compound colliders. The impact test then fires a real 30 kg, 0.20 m radius ball
at 55 m/s against the ray-verified front wheel, starting with a positive gap.
It requires convergence and localized fracture (some bonds, fewer than 25% of
the graph), without synthetic fracture commands. This is an initial material
gate; it does not yet qualify wheel loss, operating suspension or driving.

Every model receives a physical contact but fails convergence in its first
impact step. The test deliberately stops each model there and retains the
evidence. It does not grant extra timesteps to finish that step's solve.

| Model | Chunks | Bonds | Iterations | Reported broken bonds |
|---|---:|---:|---:|---:|
| Buggy | 190 | 626 | 735 | 0 |
| Trophy | 332 | 1072 | 711 | 0 |
| Rally | 327 | 1102 | 711 | 0 |
| Monster | 328 | 1039 | 659 | 1 |
| Derby | 326 | 1016 | 1123 | 2 |
| Sprint | 222 | 754 | 888 | 0 |

The reported broken bonds on unconverged steps are **not accepted fracture
results**. Native status reports zero error despite non-convergence; the test
checks both independently. The material pipeline's behavior on unconverged
results also needs investigation.

Raw output: [impact.log](impact.log), [per-model results](impact.json), and
[artifact hashes](artifacts.json). The report records the isolated runtime used;
do not silently substitute the installed SDK.

```sh
PHYSX_ROOT=/tmp/vehicle-fracture-sdk22 \
CARGO_TARGET_DIR=/tmp/vibe-vehicle-abi22-target \
cargo test -p web-fps-server --bin web-fps-server --features native-destruction \
  authored_vehicle_ --no-run

DYLD_LIBRARY_PATH=/tmp/vehicle-motion-wide-libs \
VIBE_VEHICLE_BUILD_FIXTURES=/tmp/vehicle-functional-build-fixtures.json \
VIBE_VEHICLE_FRACTURE_REPORT=/tmp/vehicle-authored-impact-report.json \
CUMETAL_USE_METAL_DEVICE_ADDRESSES=1 CUMETAL_SYNC_EACH_LAUNCH=0 \
/tmp/vibe-vehicle-abi22-target/debug/deps/web_fps_server-a9f373fda0d7ae56 \
  authored_vehicle_ --ignored --nocapture --test-threads=1
```

`scripts/inspect-vehicle-stress-capture.py` independently reconstructs captured
equations and reports their spectra. Its analytic tests cover free and anchored
chains, lever-arm signs, nonzero warm impulses and corrupted residual rejection.
Equation capture uses the separate diagnostic runtime and unique output paths;
its execution times cannot qualify production performance.

The repaired CuMetal recorder (PhysX `623e99ca`) captures all six impact
equations at solve 30. [Independent reconstruction](equation-inspection.json)
matches every captured warm residual exactly. The first six near-zero spectral
values are consistent with free rigid motion; the remaining spectrum spans
roughly 3.8e7–4.7e8. This suggests a conditioning/precision investigation,
not a diagnosis by itself. Diagonal scaling substantially narrows the spectrum.

[Raw impact equations and component records](impact-equations.tar.gz),
[capture log](capture.log) and [capture hashes](capture-artifacts.json) preserve
that diagnostic run. Cycle timings are explicitly unavailable. The diagnostic
module reproduces non-convergence on every model, but its iteration counts
differ from the normal runtime; do not present this as bitwise parity or a
performance comparison. The normal-runtime evidence above remains authoritative.
