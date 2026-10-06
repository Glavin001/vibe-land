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
- **Losing any part doubled the car's weight on its springs** (fixed
  2026-10-06, PhysX e58f080a9): the correction pass re-installed the Vehicle2
  carrier with PhysX gravity on, on top of Vehicle2's own, and a 5 kg mirror
  knocked off at 54 km/h left the monster truck 13 cm lower for good. Free
  fragments only now get fragment gravity (`nativeCandidateState`, GPU test
  `destruction_motion_slots_test --carrier-gravity`); `knock-mirror-driving`
  and `debris-wheel` keep the ride height.
- **A car coasted on undiminished** (fixed 2026-10-06): Vehicle2's direct
  drive has no engine braking, rolling resistance or drag, so a truck let go
  of at 31 m/s held 31 m/s for 10 s. With no pedal pressed the server now
  brakes the wheels by rolling resistance (0.015) and drag (Cd 0.45 over 80%
  of the chassis bounds' frontal area) -- `CoastResistance` in
  server/src/physx_runtime.rs, off with VIBE_VEHICLE_COAST_RESISTANCE=0.
  Trial `coast`: the monster truck 24.3 -> 22.3 m/s over 5 s (was 24.3 -> 24.3).
  Its floor is rolling resistance alone (0.010 g: 0.49 m/s in 5 s): a 5 t
  truck loses 0.3 m/s^2 at 24 m/s, half of it to the air, and a 1.5 m/s floor
  was a 1-3 t car's.
- **Half a car will not drive.** After the wall, the cars that keep their rear
  axle (wheel and drive masks 12, engine connected) creep 0.3-1 m in 4.5 s: two
  wheels carry half the AWD drive torque (customization.mjs splits it over four)
  against the nose dragging on the ground (~0.75 x half its weight). The derby
  and the circuit car (RWD: full torque on the rear) drive away.
- **The monster truck at its real weight** (2026-10-06): massed as modelled
  (a sand-rail cage under a pickup body on 57 x 22 in tyres) it weighed
  2794 kg on 217 kg wheels; a Monster Jam truck is 4500-5500 kg on 293 kg
  wheels. `client/src/vehicles/mass-budget.mjs` puts it at 5000 kg: each
  road wheel at 293 kg, everything else x1.99, every bond's area by the mass
  it joins (x1.41-1.99), so stress per joint is what the geometry gave. The
  drive setup is mass-derived (x1.79 torques, springs, dampers), and every
  drive trial matches to the tenth of a second; drift 1.78 rad/s, 23.5 deg,
  -76.8 deg (was 1.73, 21.1, -74.2). Rest, steps, ramps, debris, rubble and
  near misses break what they broke before or less. Into the wall it goes
  20 m past (was 12 m) and keeps two wheels; the house still stops it at the
  front wall (z 18.4, was 18.1). `VIBE_VEHICLE_MASS_BUDGET=0` masses it as
  modelled, for A/B.
- **Tried and rejected** for the wall: corner bonds x2-x3.4 (the wheels go with
  the front end, not at their mounts), the monster's real mass (x1.6) with and
  without sections to match, and wheel hulls inset so tyres meet walls and
  debris (it stalled on rubble and lost every wheel at the wall).
