# Vehicle net lab

The garage now has a Vehicle net lab entry. `/garage?vehicleNetlab=1&netlab=1&impairSeed=42`
opens the lab with no added impairment. Choose network conditions, then Test drive.
The driver still uses the real multiplayer transport, server Vehicle2 simulation,
customized assembly and shipping renderer. No alternate vehicle physics is used
for this lab.

## Interactive capture

1. Choose the same build and setup for each comparison. Select baseline,
   wifi-good, wifi-bad, LTE, or poor-mobile. The dropdown labels **added round-trip**
   delay: LTE adds 90 ms in each direction, poor-mobile 150 ms in each direction.
2. Test drive, enter with E, then New capture in the Vehicle net lab panel. Esc
   releases the pointer for controls. Capture at least 30 seconds, including
   at least five seconds moving. Try idle, acceleration, slalom, brake/handbrake,
   uneven ground and a landing. Segment buttons place telemetry/video markers.
3. Open observer client to join the **same prepared session and world**. Capture
   there too. It is a separate connected player, not a second view of the driver's
   prediction. Stay near the driver so the vehicle stays in the observer's interest
   region. Keep the original driver session open; Back to garage closes it.
4. Stop and Export JSON. The capture includes the existing recorder's frame data,
   vehicle transforms, per-reconciliation events, input presentation events,
   markers, profile/seed, and custom configuration notes (including live tune changes).
   Capture auto-stops after 120 seconds or 60,000 events. Missing evidence is never
   treated as zero error. Event loss invalidates the capture.

Network profiles apply on connection, so changing conditions reloads the garage.
Configuration is saved before navigation. In-process impairment reuses the existing
seeded packet callback queues, with independent loss/jitter in each direction.
It does **not** implement bandwidth, burst-loss models, or QUIC congestion effects,
including when those fields exist in the profile table. Blackhole is a failed-join
probe (100% loss), not an automatically recovering mid-drive outage.

## What we measure

| Role | Measurement | Provisional target |
| --- | --- | --- |
| Driver | Reconciliation displacement p95, before smoothing or hard reset | ≤ 0.15 m |
| Driver | Hard position/orientation corrections, counted once per accepted snapshot | ≤ 1/minute |
| Driver | Input tick to first renderer-facing predicted pose containing it, p95 | ≤ 50 ms |
| Driver | Exposure with owner prediction frozen awaiting authority | ≤ 1% |
| Observer | Moving exposure beyond the latest buffered vehicle timestamp | ≤ 5% |
| Observer | Stationary rendered pose while received velocity says moving | ≤ 1% |
| Both | Render-frame duration p95 | ≤ 33.4 ms |

Spectator presentation delay is displayed separately, without a pass/fail gate:
intentional buffering is useful. Motion residual estimates changes in frame-to-frame
velocity and is diagnostic, not a gate: genuine terrain and impact reactions also
produce it. Poses are captured at the vehicle renderer's placement callback,
not from the camera or player capsule. Corrections come directly from accepted
owner reconciliation, so a decaying offset is not counted as repeated snaps.
Stale snapshots do not generate correction events.

Input timing is **input tick to predicted pose**, not key-to-photon latency or time
until tires generate force. Inputs never presented because authority acknowledged
them first do not yield a latency sample. Freezes and missing response evidence
remain separate gates. This first scorecard does not claim to measure geometric
penetration, suspension accuracy, or dynamic collision correctness. Use the native
trace regression in `vehicle-netcode.md` for time-aligned trajectory error; comparing
a present driver pose to a delayed spectator pose would produce misleading error.

Targets are engineering starting points, not perceptual validation. Review video
and individual maneuver segments alongside the score. A run passing this suite is
not evidence that international-latency driving or vehicle destruction is solved.

## Repeatable two-client run

The existing netlab runner supports `vehicleBuild` (an id from `garageBuilds`). It
prepares one real garage session, loads the same course in both clients, waits for
the driver's vehicle entry to succeed, runs the existing input timeline/watch bridge,
and deletes only that test session when done. `vehicle-driver` keeps acceleration,
slalom, braking and handbrake maneuvers compact enough for the nearby observer.
It does not assert that a specific ramp or impact was reached.

Use a built client to isolate measurements from Vite HMR and other editing:

```sh
cd client
SERVER_PORT=4173 SERVER_HOST=127.0.0.1 npx vite build --outDir /tmp/vehicle-lab-client-dist
SERVER_PORT=4173 SERVER_HOST=127.0.0.1 npx vite preview --outDir /tmp/vehicle-lab-client-dist --host 127.0.0.1 --port 5564
# In another terminal; backend must already be running with PhysX GPU:
NETLAB_RECORD_VIDEO=1 npm run netlab -- run --scenario vehicle-driver --stack attach \
  --client-url http://127.0.0.1:5564 --server-url http://127.0.0.1:4173 --headless
# Repeat with --impair lte, then --impair poor-mobile, using the same seed.
```

Artifacts live under `client/netlab/results/<run>/iter1/`: existing frame CSVs,
event JSONL, browser logs, videos when enabled, server stats and provenance,
plus **vehicle-scores.json**. Its `withinTargets` requires the expected driver and
observer roles, sufficient evidence, no lost recorder data, and all vehicle gates.
The older generic player report is separate and is not the vehicle verdict.
A recorder restart from navigation/HMR marks data lost rather than silently resetting
its cursors. The runner now uses native macOS/Metal when testing on macOS; Linux
retains its existing Xvfb/Vulkan path.

The same scorer is used by the interactive UI and CLI:

```sh
node --import tsx scripts/score-vehicle-netlab.mts vehicle-netlab-export.json --check
node --import tsx scripts/score-vehicle-netlab.mts netlab/results/<run>/iter1/events.client0.jsonl --check
```

`--check` returns nonzero for insufficient or failing measurements. For raw JSONL,
check `run.json` for lost frames/events too (the JSONL itself cannot report dropped
records). For the paired run use `vehicle-scores.json` to require both roles.
