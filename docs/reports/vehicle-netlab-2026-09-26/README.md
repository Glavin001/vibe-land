# First paired Vehicle2 netlab measurements

Local macOS PhysX GPU server, native Vehicle2 open-frame buggy, built client on
port 5564, two independent Chrome/Metal clients, approximately 47 seconds each.
The compact course includes idle, acceleration, alternating steering, braking and
handbrake. Both roles have over 30 seconds of data and 5 seconds moving. Zero
recorder frame/event loss. These are single runs on a shared development machine,
not a statistically qualified performance comparison. No Vast/CUDA validation.

| Measurement | Baseline | LTE (+180 ms RTT, ±35 ms/direction, 3% packet loss) |
| --- | ---: | ---: |
| Driver reconciliation displacement p95 | 0.098 m | 0.280 m |
| Driver hard corrections | 10 (12.6/min) | 54 (68.6/min) |
| Input tick → predicted pose p95 | 33.7 ms | 17.2 ms |
| Driver prediction frozen | 0% | 0% |
| Spectator held while received velocity says moving | 0.64% | 2.49% |
| Spectator moving buffer underrun | 0% | 0% |
| Driver frame time p95 | 31.0 ms | 17.3 ms |
| Driver verdict | Needs work | Needs work |
| Spectator verdict | Within provisional targets | Needs work |

The lower LTE input-processing time is not a latency benefit: the two runs have
different observed frame times. The experiment separates responsive local inputs
from accurate prediction. Local response can remain fast while authoritative
corrections repeatedly interrupt driving. Hard corrections include orientation
resets and may coincide with real impacts; video/markers are needed for attribution.
The scores do not prove the suspension/landing simulation is correct.

`Render buffer delay` was named `Presentation delay` in these initial JSON captures.
It is computed in the client's estimated server-clock domain, excludes unknown
clock bias, and is not the total age of the spectator's view.

Full local artifacts (ignored by Git, including video, pose events, frame CSV,
server stats, build/config provenance and browser logs):

- `client/netlab/results/2026-09-26T07-54-00_vehicle-driver_baseline/iter1/`
- `client/netlab/results/2026-09-26T07-56-08_vehicle-driver_lte/iter1/`

The preceding broad course lost observer interest coverage and is deliberately
excluded. An earlier development-server run was invalidated by HMR. The runner
now detects recorder counter rollback and reports loss; production preview avoids
that source of interference.

Next netcode work should reduce correction frequency through turns and impacts,
using these same captures and maneuver markers. Keep the responsive input path;
a simple increase in smoothing can hide snaps by making steering feel delayed.
Re-run multiple seeds/builds and actual remote hosts before treating targets as a
shipping quality bar.
