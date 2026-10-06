# Vehicle test bed

A scene of lanes and pads (`build-lab.mjs`, from `trials.mjs`), trials run on
every fleet build inside the real city stage, and criteria each car is held to
(`criteria.mjs`: the rules, their order and why each threshold is what it is).

```bash
scripts/vehicle-testbed.sh                         # every fleet build, every lab trial (~6 min, GPU)
scripts/vehicle-testbed.sh --build monster         # one build
scripts/vehicle-testbed.sh --build monster --trials debris,graze --label mine
scripts/vehicle-testbed.sh --build monster --scene town   # the chase replay in Vibe Town
node structures/vehicle-lab/report.mjs target/vehicle-testbed/mine.json --baseline target/vehicle-testbed/report.json
```

Headless (`server/src/vehicle_testbed.rs`): one fresh production arena and
city stage per car and trial, the native app's settings, 64 stress
iterations, FP32, the correction pass on. Each run measures speed, progress,
stalls, ride height, wheels lost (Vehicle2's wheel mask), bonds broken (and
which, first), parts off, what the scene lost, a drive-away after hits, and
the handbrake turn's yaw rate, slip angle and heading change. Writes
`target/vehicle-testbed/<label>.json` and `<label>-verdict.json`.

Diagnosis switches: `VIBE_TESTBED_TRACE=1` (per-tick car trace),
`VIBE_TESTBED_AUDIT=1` (every break explained: the bond's load the tick
before as a fraction of fatal, and both chunks' stress input on the breaking
step by source -- Vehicle2's wheel loads, the suspension-limit constraint,
contact -- from the native solve report), `VIBE_TESTBED_SCALE_WHEEL_MOUNT=k`,
`VIBE_TESTBED_SCALE_CORNER=k` (strength what-ifs; the fix belongs in the
authoring).

In the app: `FILM_CHECK=1 scripts/native-mac.sh film chase-probe --scene town`
runs the chase film with the truck's server state logged every 0.05 s
(`probe {...}` lines: wheel mask, bonds broken and which, parts off, ride
height, wheel loads).

## Trials

| trial | what | why |
|---|---|---|
| rest | parked 10 s | it stands |
| accel | floored on a flat paved street | top speed, 0-20 m/s |
| step-15/30/50 | 15/30/50 cm step up onto a deck and off, 22 km/h | kerbs, loading docks, low walls |
| ramp-10/20/30 | up to 1.5 m at 10/20/30 deg and down, 29 km/h | climbing |
| debris, debris-fast | 36 loose pieces sized from Vibe Town's chunks (18-684 kg) at 36 km/h, and floored | rubble on a street |
| rubble | a 1 m heap of wall blocks and slabs | climbing a pile |
| wall, house | floored from 50 m into a masonry wall / a one-storey house | hitting things at speed |
| near-miss, blast-*, graze-*, debris-wheel/cab, knock-mirror* | meteors that miss, a meteor clipping the roof, a 700 kg piece of house thrown into it, a mirror knocked off | nearby blasts and debris (the chase report) |
| cannonball, meteor | the city's cannonball into its side, the city's meteor on it | the weapons |
| drift | 1.2 s of full lock and handbrake from 15 m/s | the handbrake feel |
| town-chase (`--scene town`) | the trailer's chase replayed headless | the report itself |

## The criteria, in priority order

`criteria.mjs` holds them with the reason for each threshold; in short:

1. **It stands.** Parked 10 s: no bond breaks.
2. **It drives.** It reaches 90% of its tune's top speed (Vehicle2's drive
   torque fades to zero at it); it clears every obstacle its own geometry says
   it can -- a step up to 0.7x its tyre radius and under its belly, a ramp
   under its approach angle and its traction and power limits, rubble if its
   belly clears the tallest piece, the 1 m pile if tyre radius + clearance
   reach over it -- without stalling, losing a wheel or breaking a corner bond.
   The monster truck must clear all of them.
3. **Near misses and debris cost bodywork, not wheels.** Meteors that miss, a
   roof graze, 700 kg of house thrown at it, a mirror knocked off: all four
   wheels kept, ride height within 10 cm (a clean run: 2 cm; the chase: 13-55
   cm), at most a 2% dent unless the rock touched it.
4. **It can hurt things.** Floored from 50 m (a Vibe Town street): the wall
   and the car both break; it keeps an axle and drives away. The monster truck
   goes through the wall.
5. **The weapons mean something.** A cannonball leaves it damaged but still a
   car (an axle, and it drives away); a meteor wrecks it (half its parts or
   30% of its bonds).
6. **The handbrake turn feels as it does today** (yaw rate within 15%, slip
   25%, heading 15 deg of the 2026-10-06 reference).

Damage priority, by design: glass and trim, then panels, then cage and frame,
then the suspension, the wheels last. The car is the piece with its rear frame
crossmember (the chassis anchor Vehicle2 drives), so a car that loses its cab
or its front end still drives on what it has.

## What the test bed found (2026-10-06)

- **Wheel mounts were the weakest link.** Rated as a generic steel joint
  (300 MPa), a wheel came off whenever the car was jolted: a roof graze put
  666 kN on a 665 kN mount (the wheel's inertia as the body was spun, plus the
  suspension limit). Now lug studs, class 10.9 (1040 MPa).
- **The car went with its seats.** The chassis anchor (what Vehicle2 keeps
  driving) was the seat crossmember; a cannonball sheared the floor and seats
  off and the car became a 103 kg seat module. Now the rear frame crossmember.
- **Losing any part doubles the car's weight on its springs** (open, in
  PhysX): the correction pass re-installs the Vehicle2 carrier with PhysX
  gravity on, on top of Vehicle2's own. A 5 kg mirror knocked off at 54 km/h
  leaves the monster truck 13 cm lower for good. Trial `knock-mirror-driving`
  fails until it is fixed (physx/source/gpudestruction/src/PxgDestructionMotionState.cuh,
  `nativeCandidateState`: enable gravity only when `id != candidate.sourceBody`).
- **Tried and rejected** for the wall: corner bonds x2-x3.4 (the wheels go with
  the front end, not at their mounts), the monster's real mass (x1.6) with and
  without sections to match, and wheel hulls inset so tyres meet walls and
  debris (it stalled on rubble and lost every wheel at the wall).
