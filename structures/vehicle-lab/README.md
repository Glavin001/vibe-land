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
