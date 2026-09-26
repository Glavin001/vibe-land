# Vehicle2 network presentation: first implementation

PhysX sessions previously disabled the Rapier vehicle predictor and drew the
owner on the dynamic-body clock using constant-velocity extrapolation. That
path had neither input prediction nor contact queries. A late landing packet
could leave the car extrapolating through the road for 250 ms. Remote vehicles
used the same extrapolation whenever their interpolation buffer emptied.

The new owner path retains the authoritative server pose and replays only
unacknowledged input through a bounded browser approximation. It reuses shared
configuration dimensions, drive-force limits, steering lock and tuning. It
predicts throttle, braking, rear handbrake and steering while supported; it
retains server slip, pitch and roll. It is **not a browser port of Vehicle2**.
Replaying the engine/tires/suspension exactly would require a compatible CPU/WASM
Vehicle2 path and a substantially richer authoritative state checkpoint.

Translation is swept against the existing cosmetic WASM world's fixed,
non-sensor terrain and props. The proxy comprises a box and four wheel spheres;
visual tread meshes never become prediction colliders. Wheel road contacts
block descent without adding artificial spring impulses that fight the server's
suspension. Initial heightfield overlaps recover the terrain surface normal so
GJK overlap normals cannot masquerade as walls. The actual gap in a road stays
open: there is no hardcoded floor. Orientation remains a short-horizon angular
estimate, not a fully swept rotating rigid body.

Owner replay is capped at 400 ms; remote extrapolation at 250 ms. Input history
is bounded, sequence wrap and stale acknowledgements are handled, and three
recent input records are sent for vehicle packet-loss redundancy. No pose or
client collision result is sent as authoritative state. Corrections under 35 cm
blend over 80 ms and the translational correction is swept too. Larger corrections
take authority immediately. After 500 ms without an owning snapshot, prediction
freezes until new authority arrives. A bounded sub-tick render lead avoids
restricting visual motion to the 60 Hz input cadence. Replay work is reused
between snapshots. F3 now reports owner pending inputs, acknowledgements,
correction and proxy replay cost in PhysX sessions.

## Verification and limits

- 91 focused client tests (including existing interpolation, netcode and bundler
  tests), TypeScript check, three real Rapier query tests, and rebuilt WASM.
- Native local PhysX GPU trace: initial drop, acceleration across garage
  heightmap/washboard, a steering segment, then braking, over 720 ticks.
- The trace is replayed through the real browser WASM static queries with 80,
  180 and 300 ms acknowledgement delay, deterministic ±20 ms jitter, snapshots
  at 30 Hz, omitted snapshots and reordering. This is an offline regression,
  **not** a congestion-control benchmark or many-player collision validation.

Representative results in metres:

| Delay | Old max below authoritative height | Contact guard max below authoritative height | Owner position error p95 |
| --- | ---: | ---: | ---: |
| 80 ms | 0.516 | 0.103 | 0.234 |
| 180 ms | 1.321 | 0.322 | 0.596 |
| 300 ms | 1.617 | 0.568 | 1.456 |

Below-authority error measures visual height disagreement against the matching
server trace, **not geometric penetration depth**. Contact guarding trades some
trajectory accuracy for preventing missed contacts: remote position error p95
was 0.152/0.522/1.706 m, versus 0.128/0.420/1.667 m for unguarded extrapolation.
The implementation is a first pass, not a claim that international-latency driving
is solved. Owner total processing p95 was approximately 2.0/3.4/5.9 ms on the
local machine (observe/replay/update/pose included); further query batching and
profiling are warranted for busy scenes.

Known gaps: no predicted collisions with moving vehicles or debris; no replicated
destructible collision proxies; no faithful suspension/tire replay or predicted
wheel rig; no broad multiplayer/load qualification. Static queries only know the
terrain/props loaded into the local world document. Upcoming work should stream
contact and wheel state on the same timeline as the body, synchronize live city
collision proxies, and measure collision/correction error with multiple drivers
before extending the speculative physics horizon.

## Reproduce

From the repo root, with the local native SDK available:

```sh
VIBE_VEHICLE_NET_TRACE=/tmp/vehicle-net-trace.json cargo test -p web-fps-server --features native-destruction export_vehicle_netcode_trace -- --ignored
cargo test -p vibe-land-shared vehicle_presentation
wasm-pack build shared --target web --out-dir ../client/src/wasm/pkg
```

From `client/`:

```sh
node --import tsx scripts/verify-vehicle-netcode.mts /tmp/vehicle-net-trace.json
npx vitest run src/physics/vehiclePresentation.test.ts src/net/interpolation.test.ts src/net/netcodeClient.test.ts src/runtime/fixedInputBundler.test.ts
npx tsc --noEmit
```

Browser connection smoke: `/garage?netlab=1&impair=poor-mobile&impairSeed=42`
uses the existing netlab profile (150 ms delay per direction, ±40 ms jitter,
3% loss). The profile is an in-process packet impairment, not OS network shaping.
Return to `/garage` afterwards to remove it. No Vast/CUDA deployment was involved.

## Live driver and observer qualification

The [vehicle net lab](vehicle-netlab.md) now exposes preset network conditions,
per-reconciliation driver measurements, actual rendered vehicle telemetry, independent
observer joins, JSON export and a two-client scenario in the existing netlab runner.
Use its role-specific scorecard alongside this offline trace test. A spectator's
intentional render delay is not scored as driver prediction error.
