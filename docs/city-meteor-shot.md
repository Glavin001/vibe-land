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
handover is invisible. Past the aimed point with no body in sight, the rock
is held at the aimed point and the fire dies over six seconds.

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

## Not done

- No muzzle tracer or entry-dust registration for the meteor: the impact
  makes its own dust like any falling body (`dustImpacts.ts`), and the
  streamed rock is a dust mover.
- Remote players see the rock (the launch is broadcast) but nothing at the
  shooter, since no `PKT_SHOT_FIRED` goes out for balls or meteors.
- The server build could not be run on this box on 2026-09-20: the
  `/root/workspace/physx-2` SDK had been rebuilt out of band (manifest
  mismatch, and `PxDestructionStressDesc::reservedContactPairs` gone from
  the headers), which is a physx-2 problem, not this change. `meteor.rs`
  was tested standalone; the rest type-checks in the default-feature build
  apart from pre-existing `physx_world_mut` errors there.
