# Vehicle2 fracture bridge — intermediate qualification

This checkpoint qualifies the native Vehicle2 wrapper and game bridge against
an isolated ABI 22 CuMetal SDK. It does **not** enable destruction on the garage
page or qualify a full authored garage vehicle. The goal remains in progress.
The installed/live ABI 18 SDK was not replaced; no remote CUDA run or service
restart was performed.

## Verified behavior

- Vehicle2 follows changed mass, COM and full principal inertia while retaining
  actor-space suspension mounts and the chassis forward/up axes. The original
  SDK components still compute and integrate forces; adapters convert frames.
- Equivalent principal-axis representations, two starting headings, mid-drive
  mass/COM changes, fixed wheel mounts and command-impulse conservation are
  tested. The prior wrapper fails the new mount regression (`mass-red.log`);
  the corrected wrapper passes (`mass-green.log`).
- The bridge registers an existing compound Vehicle2 actor as a native stress
  graph, sharing material/bond authoring with city structures. Multiple convex
  hulls can belong to one chunk without duplicating mass. Measured tensors set
  the assembly inertia; actual corner commands and solved constraints feed the
  native stage. GPU fragment ownership determines subsequent wheel/engine state.
- A real local GPU integration fixture runs 180 idle, 120 driving/turning and
  120 impact ticks: 6 chunks (7 hulls), 5 bonds, a **300 kg proof projectile**, 30 m/s lateral
  velocity, and no injected fracture command. Exactly the targeted wheel
  attachment breaks; its rotation speed and road-query bit stay zero for 119
  subsequent ticks. All other parts stay attached. A stronger-material control
  survives the same impact without fracture. This proof load is deliberately
  separate from the garage's **30 kg** cannon gameplay tuning.
- The shot starts at a positive pre-contact gap inside the collision margin,
  mirroring the endpoint needed by swept projectile handling. Launching this
  fast ball farther away exposed discrete-step tunneling through the fixture's
  small collider. The fixture is not an end-to-end test of the garage sweep.
- Borrowed vehicle actors survive native teardown; removing or resetting a
  registered vehicle without rebuilding its topology fails explicitly.
- Native bond health now starts at authored **bond area in m²**, rather than
  `1.0`. Material evaluation interprets health as remaining area; the old value
  inflated small interfaces' capacity. The existing city regression suite passes
  with this correction, but a full city workload/material recalibration remains
  outside this checkpoint.

## Evidence and reproduction

Native wrapper commit: `5367866c` in the sibling PhysX checkout, building on
`7b59b7d8`'s GPU world-constraint fracture/replay implementation.

```sh
python3 scripts/verify-vehicle-native-fracture.py \
  --physx-root ../PhysX \
  --build-root ../PhysX/out/build/garage-multihull \
  --output /tmp/new-native-evidence

python3 scripts/verify-vehicle-bridge-fracture.py \
  --sdk /tmp/vehicle-fracture-sdk22 \
  --target-dir /tmp/vibe-vehicle-abi22-target \
  --output /tmp/new-bridge-evidence
```

- `native/report.json`: **12/12** native tests passed (including the earlier
  PGS/TGS constraint, command replay, multihull, torque and correction cases).
- `bridge-final/report.json`: **10/10** existing city fracture/reset/identity tests
  plus the new Vehicle2 test's two material cases passed. It records SDK hashes
  and verifies no test was silently skipped.
- The bridge compiles against both the existing ABI 18 SDK and isolated ABI 22;
  vehicle registration explicitly requires ABI 22.
- The temporary SDK contains matching engine libraries, generated `PxConfig.h`,
  public headers and packaged wrapper/snippet sources. The standard all-package
  installation encountered an unrelated legacy Blast GPU compilation failure;
  the native engine subset was staged and relocated with the repository tool,
  with an artifact/source manifest. The live install was not modified.
- No performance qualification is claimed. Test durations are test-run costs,
  not representative garage/city complete-step performance captures.

## Remaining integration

The authored buggy currently has 194 collider groups; its first group is a
wheel, and each corner contains multiple wheel-role groups. The bridge's initial
contract requires a retained chassis as chunk zero and one functional group per
wheel. The real asset compiler must supply an explicit mapping (including any
wheel assembly aggregation), never silently discard those groups.

Full-model moving collider/visual transforms, engine/driveline semantic roles,
fragment streaming, reset reconstruction, and live city insertion into an
already-configured native stage remain to be connected and qualified. Current
native topology registration is before `configure`; it does not yet append to
a running city's immutable graph. The strict full-asset impact harness must
still pass, with 30 kg cannon balance and idle/max-speed/turning coverage, before
this work is called finished. Browser verification follows that integration.
