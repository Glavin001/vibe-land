# Open-center wheel colliders and full-model impact gates

Checkpoint `782813b3` prevents the simple tire proxy from swallowing the brake
caliper or upright into the rotating wheel's fracture group. The initial wheel
proxy uses eight annular wedges, an outboard plate and a short hub stem. The
later contact partition and combination with hub/rotor geometry produces
27–32 convex hulls per coherent wheel in these prepared models. This is not a
single cylinder, and no performance improvement is claimed. Treads remain
visual details within the wheel, never separate physics bodies.

The shared browser/server validator now rejects incompatible visual motion
roles in a wheel group. Physics cache recipe `vehicle-physics-functional-2`
invalidates the previous swallowed-carrier geometry. Authored material laws,
mass properties, solver tolerance and iteration budget were not retuned.

## Verification

- All seven base models pass raw clearance and finalized collision/ownership
  checks: 12 tests for the six driving models, then two semi checks. The semi
  checks cover tractor wheel ownership, not trailer driving or destruction.
- All 11 driving builds prepare successfully and pass the server's seven
  fracture-layout tests, including full authored metadata validation.
- Three shared validation/exploded-view tests and ten grouping/material/simple
  physics tests pass. TypeScript compilation passes.
- Seven independent evidence-gate tests reject missing models, wrong projectile
  loads, incomplete/nonconverged steps, invalid bond IDs, absent contact/damage,
  excessive damage and continuing wheel function after ownership separation.
- The GPU suite executes all three tests: free fall passes; nominal fracture
  and severe wheel-loss tests fail. Its process exits 101.

## Local GPU results

All six use their complete prepared graphs, ray-verified target wheel contact,
a positive initial gap, unchanged strengths, tolerance `1e-5` and at most 2048
iterations. Each aftermath covers 120 accepted steps. The nominal ball is
30 kg at 55 m/s; the separate wheel-loss proof load is 300 kg at 120 m/s. Both
use a 0.20 m radius. The latter is not a meteor qualification.

| Model | Chunks / hulls / bonds | Nominal broken bonds | Heavy broken bonds | Target wheel detached |
| --- | --- | --- | --- | --- |
| Buggy | 194 / 635 / 634 | 0 | 31 | No |
| Trophy | 336 / 907 / 1080 | 10 | 52 | No |
| Rally | 331 / 773 / 1110 | 6 | 63 | No |
| Monster | 336 / 911 / 1059 | 8 | 40 | No |
| Derby | 330 / 869 / 1024 | 2 | 45 | No |
| Sprint | 226 / 704 / 762 | 0 | 34 | No |

All nominal and heavy impact steps converge with no native error. All models
also survive 30 free-fall steps with no fracture or ownership corruption.
The heavy tests apply throttle before impact and keep it applied, requiring
at least 30 subsequent ticks of disabled wheel motion after actual ownership
separation. None reaches that condition. Free fall cannot qualify road traction
or surviving handling, even when the functional-loss assertion eventually passes.

The [target attachment audit](target-attachment-audit.json) identifies the actual
native target by chunk index, accounting for the source-to-actor reflection.
Wheel interfaces still include direct connections to arms, caliper, shock eye
and axle. Geometric contact alone does not establish a welded mechanical joint.
These interfaces need mechanical review; the result does not justify uniformly
weakening all materials. The audit decodes packed gameplay bond IDs before
matching them to local stress-row indices.

## Evidence and reproduction

`summary.json` is independently evaluated from the completed reports. `nominal.json.gz`
contains all nominal verdicts. `heavy-selected.json.gz` retains every frame and
contact sample, with verdicts for every target-wheel interface, every broken
bond, and every bond that recorded positive trial damage or utilisation >= 1.
Each row states its selection and original count. The complete unfiltered
heavy report is retained locally at the path and hash in `raw-evidence.json`;
it is not embedded in the repository. No accepted-step or ownership samples
were removed. Logs and fixture/runtime hashes accompany the reports.

This run used the saved full-double, authored-mass, convergence-rejection
runtime at `/tmp/vehicle-convergence-gate-libs` with the isolated ABI 22 SDK.
The generic native build output is still the rejected mixed-precision binary
and must not be substituted. The live ABI 18 installation was not changed.
Hashes were observed during this manual run, not asserted before and after it.
The subsequently extended verifier provides that protection for future runs:

```sh
python3 scripts/verify-vehicle-bridge-fracture.py \
  --sdk /tmp/vehicle-fracture-sdk22 \
  --target-dir /tmp/vibe-vehicle-abi22-target \
  --runtime-overlay /tmp/vehicle-convergence-gate-libs \
  --authored-fixtures /tmp/vehicle-open-wheel-fixtures.json \
  --output /tmp/new-authored-vehicle-verification
```

Without `--authored-fixtures`, the same tool retains the existing bridge-fixture
suite and stronger-material control. The output directory must be new. Tests
run sequentially; a red physical gate returns failure rather than a contact-only
success. Optional equation captures now use distinct scenario/model prefixes
and restore process environment on success or assertion failure; that bookkeeping
change was compiled and covered by a CPU regression after this GPU run.
Its first Cargo execution aborted before test output without the saved overlay;
the explicit matching-overlay invocation passed. Both execution logs are retained.

This qualifies collider ownership and reproduces the remaining impact failures.
It does not qualify moving suspension, normal road loads, full-model functional
wheel/engine loss, append/reset lifecycle, fragment streaming, browser gameplay,
CUDA/Vast, or performance. Those remain required for live vehicle destruction.
