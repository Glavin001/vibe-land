# The meteor shot on /city

A third shot beside the rifle and the cannonball: aim at a point, and a
burning 110 t rock falls onto it from a random start high and far outside
the city, on a real ballistic arc through that point. Added 2026-09-20. The
look is ported from the Meteor Lab studio (`meteor-effect.js`: procedural
cratered basalt, emissive fissures, depth-aware raymarched fire, embers).

## Server

- `shared/src/constants.rs` — `WEAPON_METEOR = 4` in the fire packet's
  existing weapon byte; no fire-packet change. `DYNAMIC_BODY_KIND_{PLAIN,
  CANNONBALL, METEOR}` in the join-time body metadata (130 was the retired
  launch packet; not reused, old tapes carry it).
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
- `route_city_shots` (`main.rs`) launches; `process_hitscan` skips the
  meteor the way it skips the cannonball, so the rock is not also resolved
  as an instant ray.

## Why projectiles are streamed absolutely

The V2 body snapshot is relative to the viewer and quantised to 2.5 mm in
an i16: ±82 m, which is why the dynamic-body area of interest is 80 m. A
rock launched 300 m out could not be sent until the last half second of its
fall, and the first version drew the meteor from a launch-arc packet until
its body came into range. Every visible fault the meteor had lived in that
handover (a rewind when the clocks disagreed, a rock hanging where the
stream stopped), and the owner's direction was that a meteor is a rigid
body like the cannonball and must be synced by the same netcode.

So fired projectiles — cannonball and meteor, both reserved id rings — are
**important bodies**: their metadata carries a `kind`, and a body whose kind
is not plain is exempt from the area of interest, never hot/cold-classified,
and sent to every client every snapshot from the tick it exists, in an
absolute-position record (`DynamicSphereAbsStateV2`: handle, position in
mm, velocity, angular velocity; 26 bytes). The snapshot header gained a
fifth count byte and the section follows the vehicles; the self state is a
fixed 33 bytes (the length sniff that admitted two older forms is gone).
Important bodies are budgeted FIRST, nearest first — never exempted from the
budget, because a strict datagram over the MTU is dropped whole; the live
cap of 24 projectiles is 624 bytes, which always fits, and everything after
absorbs the squeeze. The client evicts an important body it has not heard
of for 30 ticks (500 ms): silence means retired, where a plain body's
silence means out of range and gets four seconds.

Measured on an isolated server: the body reaches the shooter's client 50 ms
after the fire from 350 m out, and a second client 500 m away lists it in
the same frame; it stays streamed while rolling off to 450 m. Over the
netlab `lte` profile (90 ± 35 ms, 3% loss) the only visible step is the
impact itself, where the interpolator's linear extrapolation runs on for the
lost samples and snaps to the real post-impact state — the same behaviour
every dynamic body has.

The meteor fires once per trigger press; the rifle and cannonball keep their
held cadence. A click is longer than the rifle's 100 ms interval, and a
meteor per interval put two rocks on the same aimed point a tenth of a
second apart, which from the aiming end read as one rock flying in twice.

## Client

- `client/src/city/shotMode.ts` — rifle → cannonball → meteor, cycled by
  the overlay's SHOT button (`data-testid="city-cannonball-toggle"` kept),
  stored under `vibe.city.shotMode` (the old boolean key still reads as
  cannonball). `setShotMode` on the e2e bridge; `setCannonball` still works.
- `client/src/net/netcodeClient.ts` — applies the absolute section like
  the relative ones, carries `kind` on every `DynamicBodyStateMeters`, and
  evicts important bodies on the short window.
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
  stage. One rock per streamed body of the meteor kind, at the same rendered
  state the cannonball's mesh uses; nothing predicted, held or guessed. Fire
  fades three seconds after the rock stops moving. `GameWorld` skips the
  default sphere mesh for meteor bodies and brings the frame pipeline up
  while the meteor shot is selected. `meteorForensics.ts` publishes what was
  drawn for the e2e bridge's `meteors()`.

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
- Remote players see the rock (its body streams to everyone) but nothing
  at the shooter, since no `PKT_SHOT_FIRED` goes out for balls or meteors.
- Build and deploy against the pinned SDK: `PHYSX_DESTRUCTION_SDK=/root/workspace/physx-2-deployed`
  (the live `physx-2` tree is another session's moving target).
- The headless driver's fire used to be a level pulse that a busy frame could
  miss entirely (`NO LAUNCH` on a healthy server); `__VIBE_DRIVE__.fire` is
  now also an edge the next sampled frame is guaranteed to see.
