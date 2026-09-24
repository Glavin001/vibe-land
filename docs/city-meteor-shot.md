# The meteor shot on /city

A third shot beside the rifle and the cannonball: aim at a point, and a
burning 110 t rock falls onto it from a random start high and far outside
the city, on a real ballistic arc through that point. Added 2026-09-20. The
look is ported from the Meteor Lab studio (`meteor-effect.js`: procedural
cratered basalt, emissive fissures, depth-aware raymarched fire, embers).

## Server

- `shared/src/constants.rs` — `WEAPON_METEOR = 4` in the fire packet's
  existing weapon byte; no fire-packet change. `PKT_METEOR_LAUNCHED = 130`
  (127–129 are the destruction wire's, defined in `destruction/src/wire.rs`).
- `server/src/meteor.rs` — the plan. The shooter's eye ray is cast against
  statics, chunks and loose bodies (`cast_solid_ray_point`; players are not
  solid, so the ray cannot stop on the shooter's own capsule). Aimed at the
  sky, nothing launches. The start is a random bearing around the aimed
  point, 240–360 m out and 180–300 m up; the flight time is the straight-line
  distance at 140 m/s; `v = (P − S)/T − gT/2`. Exact, because a launched
  ball has no damping (`launch_dynamic_ball` zeroes both) — the arc PhysX
  integrates is the one solved here, tested to land within 5 m at 60 Hz. A
  SplitMix64 seeded from the match id picks the bearing; the server has no
  `rand`. Knobs: `VIBE_CITY_METEOR_RADIUS_M` (2), `_DENSITY_KGM3` (3,300,
  chondrite; mass derived, `_MASS_KG` overrides), `_SPEED_MS`, `_RANGE_MIN_M`,
  `_RANGE_MAX_M`, `_HEIGHT_MIN_M`, `_HEIGHT_MAX_M`, `_TTL_TICKS` (900).
- `server/src/physx_runtime.rs` — a second reserved id ring (`METEOR_POOL`
  = 8) with its own join-time metadata, because the metadata is per id and a
  meteor through a cannonball's id would draw at cannonball size. The
  meteor keeps `SHAPE_SPHERE` on the physics path: the V2 snapshot's sphere
  record and the client's Rapier proxy both key on it.
- `route_city_shots` (`main.rs`) launches and broadcasts the launch packet;
  `process_hitscan` skips the meteor the way it skips the cannonball, so
  the rock is not also resolved as an instant ray.

## Why there is a launch packet

The V2 body snapshot is relative to the viewer and quantised to 2.5 mm in
an i16: ±82 m, which is why the dynamic-body AOI is 80 m. A rock launched
300 m out cannot be streamed until the last half second of its fall. So the
server tells every client the start, velocity, aimed point, radius, gravity
and flight time (65 bytes, reliable, raw bytes through the city-packet
path), and the client draws the arc itself until the streamed body appears;
the two agree to within quantisation until the rock hits something, so the
handover is invisible -- provided the arc is evaluated in the body
interpolator's own server-time base (`getDynamicBodyRenderTimeUs`). Mapping
the launch onto the local clock through the estimator's offset instead put
the arc tens of milliseconds ahead on a jittery link, 7 m at 147 m/s, and
the rock visibly jumped back when the body took over ("it rewinds and
comes in again"). Measured with `client/e2e/qa-meteor-trace.mjs` over the
netlab `lte` profile: 7.2 m gap before, 0.14 m after.

Since 2026-09-24 (`client/src/vfx/meteorPlacement.ts`, shared by the layer
and the tape tools) the rock stays on the arc until a streamed snapshot is
off it (more than 1.5 m from the arc at its own server time, or past the
flight time): contact. Only then does the body take over. Handing over at
the first streamed snapshot instead meant drawing a body with one sample --
which cannot be interpolated -- at that sample's time while the arc was at
the render time, a jump of lead x speed: 7.8 m median, 24 m worst on the
2026-09-24 Mac session, where a slowed server made the lead large. After
contact the body is interpolated at the render time and extrapolated for at
most 250 ms, never below its newest snapshot.

A body that stops arriving while it was moving has left the 80 m streaming
range; the client keeps its last state in `dynamicBodies`, and drawing that
is a rock hanging in the air where it last was. The layer treats a moving
body as gone once 15 ticks of snapshots have arrived without it (it was an
age of 250 ms against the estimated server clock, which a stalled server
tripped: the rock held, then jumped up to 33 m when snapshots resumed): held
where it was, cold, forgotten 0.75 s of server time after it was last drawn.
Past the aimed point with no body ever seen, the rock is held at the aimed
point for three seconds of server time.

## Client

- `client/src/city/shotMode.ts` — rifle → cannonball → meteor, cycled by
  the overlay's SHOT button (`data-testid="city-cannonball-toggle"` kept),
  stored under `vibe.city.shotMode` (the old boolean key still reads as
  cannonball). `setShotMode` on the e2e bridge; `setCannonball` still works.
- `client/src/vfx/meteorFlights.ts` — decoder and the store of live
  flights, read by the layer the way the dust reads `dustShots`. The runtime
  registers launches from `onCityPacket`, mapping the server stamp through
  the clock estimator.
- `client/src/vfx/meteorRock.ts` — the rock (icosphere, 24 subdivisions,
  built once and scaled per meteor), the fissure material
  (`MeshStandardMaterial` with `onBeforeCompile`, so the sun and sky light
  it), and the embers.
- `client/src/vfx/MeteorFireStage.ts` — the fire as a frame-pipeline stage
  (`order = 10`, after the dust) reading the beauty depth. Up to four meteors
  march in one pass. The field is evaluated in rock radii so the studio's
  look scales with the server's radius. Output is premultiplied linear HDR
  laid over the stage before it; the composite's ACES does what the studio's
  bloom did. Pipeline stages now chain through `ctx.under` and sort by
  `order`.
- `client/src/vfx/MeteorLayer.tsx` — owns the rocks, two pooled point
  lights (a light added mid-game recompiles every material), and feeds the
  stage. Position from the streamed body when it exists, else the arc at the
  interpolation-delayed render time. Fire fades three seconds after the rock
  stops moving. `GameWorld` skips the default sphere mesh for meteor bodies
  and brings the frame pipeline up while the meteor shot is selected.

## The crashes it caused, and what they were

The first live session crashed the server five times in seven minutes
(`CUDA error 700`, context lost, supervisor restart). Isolated A/B arms on a
second server ruled out mass, speed, start position and radius; the ball
trace (`VIBE_CITY_BALL_TRACE=1`) showed a rock rolling across the plain at a
constant 31 m/s crossing x = −256 on the faulting tick, twice. The city's
floor was a 2 km slab *and* a flat heightfield over ±256 m lying on it; the
GPU sphere-vs-heightfield kernel dereferences a non-existent adjacent
triangle on the field's outer edge (upstream PhysX 5.6, `convexHeightfield.cu:472`).
The heightfield is gone from `city_world()`; the reproducer and the
sanitizer trace are in `physx-bridge/tests/heightfield_edge.rs` and the
`native-destruction-faults` skill. After the fix: 5 + 4 launches of the
default 110 t rock, rocks rolling out to 493 m, no fault.

Still true: a 110 t rock ploughing through resting rubble ejects settled
chunks at km/s (the skill's open fault, now reproducible on demand). They
no longer crash the server; they fly to the slab's edge and are dropped by
the 1 km streaming filter.

## Correction passes

`VIBE_CITY_NATIVE_CORRECTION_LIMIT` (default 1) is the number of corrected
rigid solves one tick may run. From SDK v17 (physx-2 `8bc7aecb`) the stage
loops: while the re-evaluated contacts keep breaking bonds it rewinds to the
start of the tick and solves again, up to the limit, so a rock can go two or
more layers deep in one tick instead of rebounding off the second. Each extra
pass is a full rigid solve on fracturing frames only. `0` never rewinds and is
the cheapest setting. Older SDKs refuse anything above one and treat the value
as a boolean; against those the bridge clamps to 1 and logs.

## Not done

- No muzzle tracer or entry-dust registration for the meteor: the impact
  makes its own dust like any falling body (`dustImpacts.ts`), and the
  streamed rock is a dust mover.
- Remote players see the rock (the launch is broadcast) but nothing at the
  shooter, since no `PKT_SHOT_FIRED` goes out for balls or meteors.
- Build and deploy against the pinned SDK: `PHYSX_DESTRUCTION_SDK=/root/workspace/physx-2-deployed`
  (the live `physx-2` tree is another session's moving target).
- The headless driver's fire used to be a level pulse that a busy frame could
  miss entirely (`NO LAUNCH` on a healthy server); `__VIBE_DRIVE__.fire` is
  now also an edge the next sampled frame is guaranteed to see.
