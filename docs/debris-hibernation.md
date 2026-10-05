# Debris hibernation (opt-in proof of concept)

Settled stage fragments are frozen in place as kinematic bodies and thawed
locally, just before something would move them. A rubble pile stops being one
contact island that a few rocking chunks keep simulating, and a disturbance
wakes only what it reaches.

- **Enable:** `VIBE_CITY_NATIVE_HIBERNATE=1` (server), or
  `World::native_set_hibernation`. It is off by default.
- **Optional:** `VIBE_CITY_NATIVE_HIBERNATE_WAKE_DV` (m/s, default 0.31).
- **Needs:** PhysX destruction scene v25, branch `feature/debris-hibernation`
  (`PxDestructionScene::setFragmentsHibernated`). The bridge still builds
  against v15–v24, with hibernation unavailable.
- **Telemetry:** `native_hibernate_*` stats spans (frozen, froze, thaws by
  cause, freeze/thaw ms).
- **Code:**
  - `physx-bridge/src/native_hibernation.cc`: policy.
  - PhysX `NpDestructionBodyAllocator.h`: transaction.
- **Tests:** `scripts/test-hibernation.sh`, plus the two `native_hibernation`
  vehicle tests in `native_vehicle_fracture.rs` (run with `--ignored`).

## The transaction (PhysX)

`setFragmentsHibernated(bodies, n, frozen)` is the stage's own device-owner
kinematic switch, the same one `applyBindings` uses for supported remnants:

- No broadphase reinsertion, so element IDs and the stage's contact map survive.
- The contact island keeps its sleep state.
- Mass is resident on the GPU and host uploads normally preserve it. For this
  one upload the host value is authoritative:
  - frozen: zero;
  - thawed: the kinematic backup, which is the mass the stage last published.
- A pending GPU sleep is committed first.
- A topology change (fracture) that names a frozen body thaws it inside the
  transaction, and the stage's freshly installed GPU mass is authoritative.
- Eligible bodies: a free cluster body the stage owns, outside aggregates.
- The call is all-or-nothing.

## The policy (bridge)

**Freeze:** at each rest-window boundary (every 120 ticks). A free fragment
freezes when all of these hold:

- It is at rest: either engine-asleep, or awake and through the rest-sleep
  test (no net drift over three windows, inside a 5 cm envelope).
- It is not a vehicle's.
- It is not in thaw cooldown.
- Bottom up: it rests only on static ground or bodies already frozen. It
  touches no anchored structure in any direction.

The last rule exists because a frozen body cannot pass its weight on. Rubble on
a floor stays simulated, so the floor keeps feeling it (subject to the known gap
below).

**Thaw:** before the step that would move the body.

| Cause | Rule |
|---|---|
| approach | A mover's swept bounds reach it, and it would receive v·n·m/(m+M) > `wake_dv` along the contact normal. The contact normal is the bounds' separating axis, not the line of centres. The struck body becomes a predicted mover carrying that velocity, so a hit through a packed pile thaws the chain until the momentum runs out. `wake_dv` = √(2·μ·g·1 cm), the speed below which a body sliding to a stop moves less than about a centimetre. |
| support | It rests on the top face of a body moving faster than `wake_dv`. |
| push | A slow body that is not at rest touches it. |
| vehicle | An awake vehicle touches it. |
| query | `wake_bodies_near` (shots, blasts). |
| topology | The stage changes its cluster. |

**Wire:** a frozen body is a settled dynamic body to clients: a settle edge
when it freezes while moving, a wake edge when it thaws. It is never shown as
an anchored remnant.

## Evidence (Metal, 2026-10-05)

Every test runs against the real engine.

| Property | Result |
|---|---|
| Off by default | Nothing freezes. |
| A freeze moves nothing and wakes nothing | Positions bit-identical; every neighbour still asleep. |
| Frozen debris collides as an immovable body | A 2 t box lands on a frozen cube; the cube does not move. |
| A thaw restores the body | It falls 1.267 m in 0.5 s (½gt² = 1.226 m). |
| Authored body: mass restored | Freeze/thaw of a whole pile, then an impact: 2 mm from never frozen. |
| Fracture fragment: mass restored | Round trip, then struck: bit-identical to the same fragment never frozen. |
| Momentum exchange | Box into a frozen cube: 1.650 / 1.350 m/s, identical to never frozen. |
| Chain through a packed row | Every cube within 0.06 m/s of the unfrozen row. |
| Edge hit | Box clipping a frozen edge lands 1.2 cm from the asleep control; chunks within 2.3 mm. |
| Large impact (2 t block, 6×6×2 pile) | Detail below. |
| Support loss | Cube knocked out from under a frozen cube; the top falls to the ground. |
| Query | Thaws exactly the bodies inside the radius. |
| Fracture of a frozen fragment | Thawed inside the stage transaction; mappings valid. |
| City debris (shot wall) | Ground debris freezes; debris on the foundation does not; a second shot thaws locally. |
| Rocking rubble (bench neighbourhoods) | The 8-tick panel that never sleeps natively is at rest at tick 360 (rest sleep: 479). Within baseline + envelope; no cycling. |
| Rubble on a structure | Stays simulated; bond stresses identical with and without hibernation. |
| Vehicles | A parked car never freezes and drives exactly as without hibernation. A car driven into frozen rubble ends within 2 mm of the control; cubes within 10 cm. |
| Wire | Settle and wake edges as specified. |
| Off / clear | Leave nothing frozen; the setting survives a city rebuild. |

The large-impact case:

- It thaws 8 bodies locally.
- Every body more than one cube away ends within 2 mm.
- The pile refreezes afterwards.
- Hibernated deviation from an asleep pile: block 5.7 cm, worst chunk 9.8 cm.
  PhysX's own difference between hitting the same pile awake and asleep is
  11 cm and 24 cm, which is the yardstick.

Cost on an 800-body pile:

| Pass | Cost |
|---|---|
| Freeze pass (all 800 in one window) | 1.2 ms |
| Idle step | frozen ≈ asleep (0.72 vs 0.77 ms) |
| Pre-step thaw test with ten movers | 4 µs mean, 52 µs max |

Regression: `native_gameplay`, `rubble_rest` and the vehicle suite give
identical results on the v24 and v25 SDKs. Their failing tests fail the same
way on both: the convergence-rejection test fails under
`ALLOW_UNCONVERGED=1`, and the axle/driving tests fail.

## City-scale result: it does not pay yet (2026-10-05)

`scenarios/perf/audit/hibernate-g5.json` is the 5×5 ten-storey city felled by
50 meteors. Medians over the last 30 s of a settled ~22k-body pile, on the same
binary, with exclusive GPU:

| Arm | Tick | Awake bodies |
|---|---|---|
| Production (GPU island repair on) | 18.7 ms | 21,975 |
| Island repair off | 17.9 ms | 21,669 |
| Hibernation on (implies repair off) | 21.7 ms | 20,186 |

Only ~1,800 bodies (8%) are frozen at any time, with ~300 freezing and
thawing every pass. That costs 3.8 ms against repair off:

- about 2 ms in the pre-step thaw scan, which visits all ~20k awake bodies;
- about 1.5 ms more in the PhysX step, from the churn.

**Why so few freeze.** The pile is not at rest; it creeps. The rest-test
trace (`VIBE_CITY_NATIVE_HIBERNATE_TRACE=1`), about 75 s after the collapse,
per 2 s window:

| Measure | Median | p90 | Failing |
|---|---|---|---|
| Drift of a body's mean position | 10–12 mm | 70–95 mm | ~15,000 of 20,000 bodies |
| Envelope inside a window | 6 mm | 60–95 mm | |
| Rotation | 0.25° | | |

So most of the pile is sliding slowly (about 5 mm/s typical, 35–45 mm/s at the
90th percentile) rather than rocking in place. Hibernation cannot freeze what
keeps moving.

What would have to change before it pays:

1. The pile has to settle. Find why a 22k-body heap creeps forever. Likely
   candidates: under-converged friction in a 200k-contact island at 4/1
   iterations, depenetration, stabilization. This also decides whether native
   sleep could ever work on piles.
2. The pre-step thaw scan must cost O(awake bodies near frozen ones), not
   O(awake).
3. The bottom-up and no-structure rules limit coverage until resting loads exist.

## Limits and known gaps

- **Sleeping bodies stop loading structures. This predates hibernation.** The
  stage takes loads only from solved contacts, and a sleeping body's contacts
  are not solved. Two cubes on a table double its middle-bond stress while
  awake (8.4 to 16.7 kPa). Once asleep, the table stops feeling them. Rubble
  piling up on a floor therefore cannot bring it down once it settles.
  `sleeping_rubble_still_loads_the_structure_under_it` (`#[ignore]`d, fails)
  records it. Fix: the stage keeps resting contact loads, or welds and cached
  loads. Once that is fixed, frozen rubble on structures can be allowed.
- **Debris resting on structures does not hibernate yet**, so its cost remains.
- **Freezing a rocking body stops it inside its envelope** (at most 5 cm), the
  same contract as rest sleep.
- **A struck body thaws a step or two before contact.** It is then awake when
  hit, unlike a sleeping body woken by the hit. The difference is PhysX's own
  awake-vs-asleep variance (see the large-impact case above).
- **GPU island repair.** Hibernation needs it off (PhysX refuses otherwise), and
  island repair off is a small saving on this scene anyway (18.7 to 17.9 ms).
