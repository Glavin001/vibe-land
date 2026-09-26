# Authored vehicle functional groups

The browser validation worker and server preparation worker now use the same
functional collider grouping. A wheel's tire, tread, rim and rotating hub share
one fracture chunk. Every previously audited hull keeps its original geometry
and placement; axles, uprights and suspension remain independent groups. The
Monster Truck already absorbs its hub into its single cylinder and needs no
extra hulls. No tread colliders are added.

The recipe explicitly identifies the central chassis crossmember, engine core
and transmission. The chassis anchor becomes chunk zero, which the native
Vehicle2 bridge retains on the original actor. Identity does not depend on the
heaviest part, paint, part numbering or ambiguous source left/right names.
The preparation cache recipe is now `vehicle-physics-functional-1`.

Server validation checks this contract, then the native conversion preserves
every hull, measured external interface, material in Pa, chunk mass, COM and
full inertia tensor. Interfaces inside a wheel group disappear; parallel
external interfaces retain their distinct locations and strengths. All visual
IDs retain exactly one owner. Engine and transmission chunks both participate
in the native powertrain connectivity mask.

## Evidence

- [32 client tests](client-tests.log), including a real Sprint assembly and
  exploded-view transforms for every visual, plus geometry-preserving grouping.
- [Seven server tests](server-tests.log), including all 11 drivable presets
  converted against the isolated ABI 22 bridge with no ignored tests.
- [Seven base models plus custom wheelbase](assets.log): complete geometry,
  collider audits, visual ownership, connectivity and mass preparation.
- [Prepared preset inventory](fixtures.json), including metadata hashes and
  function identities; [source hashes and qualification](report.json).
- Full client `tsc --noEmit` passed.

Reproduce from the repository root:

```sh
node client/scripts/verify-vehicle-assets.mjs /tmp/vehicle-functional-cache
node client/scripts/verify-vehicle-builds.mjs /tmp/vehicle-functional-cache /tmp/vehicle-functional-fixtures.json
cd client && npx vitest run src/vehicles
```

Run the server check from the repository root with the coherent ABI 22 SDK:

```sh
PHYSX_ROOT=/tmp/vehicle-fracture-sdk22 \
CARGO_TARGET_DIR=/tmp/vibe-vehicle-abi22-target \
VIBE_VEHICLE_BUILD_FIXTURES=/tmp/vehicle-functional-fixtures.json \
CUMETAL_USE_METAL_DEVICE_ADDRESSES=1 CUMETAL_SYNC_EACH_LAUNCH=0 \
cargo test -p web-fps-server --bin web-fps-server --features native-destruction \
  vehicle_assets::fracture::tests -- --include-ignored --nocapture --test-threads=1
```

## Remaining work

This is asset mapping qualification, **not a full garage GPU destruction pass**.
The new native conversion is not yet installed by the live garage/city spawn
path. The preceding [GPU bridge evidence](../vehicle-bridge-fracture-2026-09-26/README.md)
uses a small fixture and a heavy proof projectile.

The moving suspension and wheel shapes must stay consistent with native stress
geometry and accepted fragment ownership. Installing rest-pose wheel colliders
as a rigid chassis compound would defeat the suspension, so that is not enabled.
The live integration also still needs fragment rendering/streaming, asset reset,
preserving existing city damage when registering a new vehicle, and qualification
of the actual 30 kg cannon and severe impacts against the full authored graph.
No CUDA/Vast validation or performance qualification was performed. Browser
verification was unavailable: no garage tab remained and the Mac was locked.
