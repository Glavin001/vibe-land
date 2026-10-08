# Calibration 6: the bungalow's headers and plate, bays knocked out beside the door

Status (2026-10-08): **revision 2 authored.** On the high profile, the intact house and one bay out break nothing. Two bays out open one cripple-to-lintel joint and nothing falls. A sudden 4.3 m removal still unzips the wall: that comes from an engine limit, see below.

The monster truck (5 t, 21.7 m/s) in the vehicle test bed's framed-house
trial knocks a hole in the bungalow's front wall. In some runs the house then
came down under its own weight long after the truck had stopped: 989 to
2,143 joints broken, the frame down to 36% anchored. Solved to convergence,
the captured pass (eval 1290) still broke the same joints, so the solver was
not the cause. The first joints past capacity were king stud to header
(utilisation 19.2 and 9.7: V 2.5 to 7.4 kN, M 1.3 to 1.8 kN m on a 0.038 m2
interface), king to jack, the veneer lintel's ties, and then the roof's load
path.

A real light-frame house with a bay or two knocked out stands. This write-up
asks which side is wrong, the engine or the authoring, and fixes the
authoring where the evidence says it is wrong.

Sources:

- `structures/town-kit/src/veneer-houses.mjs` (`revision: 2`) and
  `materials.mjs` (`REVISION_2_CONNECTIONS`, `DOUBLE_TOP_PLATE`, `NAIL_8D`).
- `structures/calibration/src/house-headers.mjs`: the hand calculation.
- `structures/calibration/scenarios/house-headers.mjs`: the cases.
- `structures/town-kit/scripts/static-cascade.py`: progressive failure on
  the CPU oracle (stress-share.py's converged min-norm solve, high-profile
  model; each round breaks every bond past fatal and drops what is cut free).

## The evidence: authoring, not engine

1. **The collapse is static.** The CPU oracle reproduces it with no truck
   and no dynamics. Take out the truck's hole and the door's left jack and
   king (case `truck-door` below) from revision 1, and the static cascade
   breaks 1,162 bonds. The repeated high-profile trials broke 989 to 1,163.
2. **The first failures are levers the authoring built:**
   - a top plate made of rigid 2.4 m chunks, so a chunk over the gap pries
     up the studs and the header beyond it;
   - a header glued to the plate by 9x the nails a framer drives, so the two
     act as one 0.5 m deep beam;
   - the header's ends rated as a stud beside a plate, at 1.0 kN.
3. **Joint stiffnesses were authored for another engine law.** Under
   `VIBE_SECTION_ROTATION` the bridge uses a spring length L equal to the
   chunks' separation along the bond normal, at least sqrt(A). Revision 1
   computed every modulus from the median centre distance (`k L / A`). Under
   the high profile, revision 1's joints were therefore too stiff by these
   factors (the oracle, the bridge's own rule):

   | Joint | Too stiff by |
   |---|---|
   | ceiling joist seats | 16.9x |
   | heels | 5.4x |
   | drywall screws | 3.5x (1.5-9x per bond) |
   | anchors | 3.2x |
   | wall ties | 3x |
   | rafter seats | 2.3x |

   A stiff joint draws load it cannot carry. At rest under revision 1, the
   ceiling joists held 0.71 of their seats' capacity, and the gypsum board
   behaved as structure.
4. **One bug in the bearing joints.** The radius that sets a bearing
   joint's twist stiffness, scaled by sqrt(slip / bearing), was also the
   radius the stage grades twist strength with (`twistModulus = A g^2 /
   reach`). A stud end-nailed to its plate was 23x weak in twist: 1.3 N m
   against its nails' 30 N m.

None of these is the solver. The engine did what the authored graph asked
of it.

## The connection chain, by hand

Values are characteristic, short-term. That is the high profile's
`VIBE_STRENGTH_SHORT_TERM`: a bond holds below its fatal limit. Nails follow
the kit's convention (EN 1995-1-1 Johansen, C24 with rho_k 350 kg/m3):

- **16d (3.15 x 90 mm):** lateral 0.77 kN, withdrawal 0.35 kN.
- **8d common (3.33 x 63.5 mm):** lateral 0.85 kN. Toe-nailed it reaches
  L cos 30 - L/3 = 34 mm into the second member (NDS 2018 Fig. 12A), so its
  withdrawal is 0.28 kN.
- **Factors:** end-grain lateral 0.67; toe nails 0.83 lateral and 0.67
  withdrawal (NDS 12.5).

Demand is from the eval-1290 capture, or from the static oracle and hand
calculation for the cases below.

| Connection | Revision 1 (authored) | Code value | Demand | Verdict, revision 2 |
|---|---|---|---|---|
| Header to king stud | stud beside a plate: 2 end-grain nails, V 1.0 kN, T 0.47 kN, over the 0.42 x 0.09 m face | IRC 2021 R602.3(1) item 11, "header to stud", 4-8d toe nails: V 2.8 kN, T 0.74 kN, M ~0.16 kN m (nails against bearing, lever 0.21 m) | eval 1290: V 2.5-7.4 kN, M 1.3-1.8 kN m. Static, revision 2: <= 0.12 at rest, 0.32 with two bays out | Capacity was 2.7x low (fixed: `header-king`). The demand was a lever, 3-10x even the code capacity; it is gone once the plate bends (below). |
| Header on jack studs (bearing) | stud on plate: bearing f_c,90,k 2.5 MPa x 90 x 45 = 10.1 kN; nails V 1.0 kN; twist 1/23 of its nails' | R602.7 / AS 1684: the header bears on its jacks | <= 4.8 kN (two bays out) | Bearing right. Twist strength fixed (revision 2 keeps the nails' 30 N m). |
| Double top plate | one solid 90 x 90 C24, f_m,k 24 MPa: M_Rk 2.92 kN m, EI 6.0e4 N m2; rigid chunks 2.4 m long | two 45 x 90 plies, R602.3(1) item 12 (16d at 16 in.) and item 13 (splices 8-16d each side, offset >= 24 in., R602.3.2). EN 1995-1-1 Annex B gamma 0.01-0.07 at these spans: M_Rk = 2 f_m,k b t^2 / 6 = 1.46 kN m, EI 1.5e4 N m2 | gaps 1.36 / 1.96 / 3.33 / 4.32 m: M 0.39-0.63 / 0.81-1.18 / 2.43-3.63 / 3.99-5.97 kN m (clamped / pinned) | Strength was 2x high, stiffness 4x high, and the chunks were rigid levers. Revision 2 cuts it at every bay and gives it the plies' strength (`DOUBLE_TOP_PLATE`, 12 MPa on the 90 x 90). Its stiffness stays the solid section's: see "What the engine cannot do". |
| Top plate on a header built up to it | "lap": one nail per 40 cm2, so 20 nails along a 0.89 m door head: V 15.4 kN, T 6.9 kN, as stiff | face nails one per 406 mm (the plates' own nailing, R602.3(1) item 12): 2.2 nails, V 1.7 kN, T 0.76 kN | | 9x overrated, which made plate and header one 0.5 m deep beam. Revision 2 frames each opening as a 190 mm lintel with cripple studs to the plate (AS 1684.2 jack studs over a lintel; IRC R602.7 cripples). The plate bears on cripples, pinned at both ends (stud to plate). (`header-plate` rates a header that does reach the plate; the bungalow has none.) |
| Top plate to ceiling joist | 3 toe nails + an H2.5A tie: V 3.1 kN, T 6.0 kN; stiffness 16.9x its fasteners' (spring length) | R602.3(1) roof item 2 (3-8d toe nails), R802.11 tie-down | at rest: 0.71 (revision 1), 0.16 (revision 2) | Capacity right; stiffness fixed. |
| Top plate to rafter (seat) | 3 toe nails + tie; 2.3x stiff | roof item 6 (3-10d toe nails) | 0.21 at rest | Stiffness fixed. |
| Rafter heel to ceiling joist | M12 bolt, 7 kN; 5.4x stiff | R802.5.2 heel joint | 0.17 at rest | Stiffness fixed. The tie force now runs through the joist splice (0.40), as it should. |
| Stud to plates | 2 end nails (item 17); twist 1/23 | item 17 | | Twist fixed. |
| Gypsum board (skin) | screws at 300 mm, 0.35 kN each; 3.5x stiff | GA-216, AS/NZS 2589 | 0.61 at rest (revision 1), 0.63 (revision 2) | Stiffness fixed. It stays a skin and may crack around a hole. |
| Wall ties (skin) | 0.9 kN; 3x stiff in plane | BS EN 845-1 | | Stiffness fixed. |
| Sheathing diaphragm | none | Brick veneer on a timber frame (AS 1684) carries no structural wall sheathing. It is braced by discrete panels and straps, and the tiles hang on battens with no roof deck. | | Not added: not this construction, and not what failed. |

## The engineering check

The plate spans the gap left by the removal, between the supports either
side of it:

- a stud, king or junction stud that remains;
- or a header on its jacks. The plate bears on the header and the header on
  its jacks. A header that has lost a jack hangs from the jack it keeps and
  supports nothing at that end.

It carries the rafter seats and joist ends over it and its own weight, from
the pack's masses: a line load of 2.67 kN/m as built. Its ends lie between
pinned and clamped, and both bounds are taken.

| Case | Removed | Gap | M (kN m) | Plate u (plies) | Bearing u at the gap's ends | Prediction (as built) |
|---|---|---|---|---|---|---|
| intact | nothing | stud bays (0.6 m) | ~0 | ~0 | 0.08 | holds |
| bay1 | the door's left jack and king | 1.36 m | 0.39-0.63 | 0.27-0.43 | 0.31 | **holds** |
| bay2 | and the stud beside them | 1.96 m | 0.81-1.18 | 0.56-0.81 | 0.39 | **holds** |
| truck | the truck's five studs | 3.33 m | 2.43-3.63 | 1.66-2.49 | 0.49 | either: the plate alone fails, but the board, lining and ridge are paths an engineer does not count |
| truck-door | and the door's left jack and king | 4.32 m | 3.99-5.97 | 2.74-4.09 | 0.68 | either (same) |

So one or two bays out (the bays a car takes) must stand with nothing
structural broken; skin joints may crack. With the truck's 3.3 m hole, the
plate alone is past its strength. What follows is local: the plate and the
roof edge over the hole. It is not the rest of the house, because the plate
breaks over the gap before it can pry up the walls beyond it.

## The static oracle (CPU), revision 1 against revision 2

`static-cascade.py`, high-profile model:

| Case | Revision 1 | Revision 2 |
|---|---|---|
| intact | 0 past fatal; joist seats 0.71 | 0; worst 0.51 |
| bay1 | 0 | 0 |
| bay2 | 0 | 1 board screw (skin) |
| truck | 18, the frame stands | 26, the frame stands |
| truck-door | **1,162, cascading** | 638, cascading (first: the king stud and stud beyond each end of the gap lifted off the plate, 7-8x their end nails) |

On the CPU, revision 2's plate over the truck's hole carries 0.7 kN m. The
rest of the gap's load goes into the ridge board, the ceiling and the board,
which the min-norm solve shares by stiffness. The static cascade is no
judge of collapse extent past its first rounds: it has no inertia and drops
nothing that falls. The GPU runs below are the judge.

Why cripples and not the solid header rated right: a plate on a solid
header is stiff in bearing, but the stage gives a bond one stiffness in
every direction. Both ways of rating it went wrong on the oracle:

- **Rated by its 2-3 face nails:** the plate over each opening sat on the
  king studs and the gypsum board, and in the runtime model 6-11 board
  screws were past their sustained limit at rest.
- **Rated in bearing:** plate and header became one glued beam, and its
  nails failed in shear at rest (9x).

Cripples bear the plate and are pinned at both ends, so no glued beam
forms. At rest on the high-profile oracle, the worst joint is then 0.51 of
fatal.

## What the engine cannot do (reported, not worked around)

- **One stiffness per bond, in every direction.** A double plate needs its
  plies stiff in bearing and soft in slip, and a header the same under the
  plate. Two-ply versions were built and tried on the oracle:
  - nail-slip stiffness throughout: the plies bear on each other 23x too
    softly, and the gypsum board carries the roof (86 screws past fatal at
    rest);
  - bearing stiffness throughout: the plies act as one glued beam, and their
    face nails "fail" in shear at rest (3.3x).

  Revision 2 therefore keeps one 90 x 90 member with the plies' strength.
  Its bending stiffness is 4x the plies'.
- **A bearing joint broken in tension never bears again.** A stud end lifted
  off its plate (its nails, 0.47 kN) loses its compression support for
  good, where a real one would sit back down. Beside a long gap this is how
  revision 1's wall unzipped (a king stud 0.33 m from the junction stud,
  lifted at 4.6x).
- **No friction on a compressed joint's shear.** A header bearing 0.9 kN on
  its jack resists sliding by mu x 0.9 kN plus its nails. The stage grades
  the nails alone.

## GPU results

### Calibration (`run.mjs house-headers`, 600 ticks, 64 iterations, FP32, correction limit 1)

`high` (garage-hifi 89527822a, high-profile packs). Held to the engineering
prediction:

| Case | Predicted | Engine | Notes |
|---|---|---|---|
| intact | holds | **holds, 0 broken** | |
| bay1 | holds | **holds, 0 broken** | |
| bay2 | holds | damaged: 1 frame joint + 1 board screw, nothing free, no drop (MISS) | The joint is a cripple on the door lintel that lost its jack. The hand check takes that lintel as no support, so its cripple's nails carry nothing there. The stage shares load elastically, puts some through them, and they open. Physically right; the check omits that joint. |
| truck | either (plate past its strength, uncounted paths) | fractured: 25 broken, 2 pieces free, drop 0.81 m | Local. First breaks: the cripples and king beyond the gap, lifted off the plate in tension (u 2.4-2.6). |
| truck-door | either | collapses: 2,394 broken | The same uplift beyond both ends of the 4.3 m gap (cripple uplift u 1.2-7.8 on tick 1). The wall unzips. |

Every tick was unconverged at 64 iterations: five houses in one scene.

`runtime` (garage-roof):

- No frame joint breaks in any case: intact, bays, truck, truck-door.
- Gypsum-board screws break at rest: 10 in the intact house, 7-31 in the
  others.
- Revision 2's joint moduli are authored for the high profile's engine law,
  and under the runtime profile's capped bending the board picks up load.
- So the lab builds revision 2 only for high-profile packs
  (`FRAMED_HOUSE_REVISION`, by `VIBE_SECTION_ROTATION`), and runtime packs
  keep revision 1.

### The truck trial (`impact-arms.sh --arms high --trials framed-house --repeats 3`)

Same SDK (89527822a), revision 2 against revision 1. Revision 1 uses a
separate pack set built with `VIBE_LAB_HOUSE_REVISION=1`.

| | gates (enters, slows, held) | broken | frame joints beyond reach | frame members fallen beyond reach | frame anchored | roof members down | speed at 4 s / 5 s |
|---|---|---|---|---|---|---|---|
| revision 2 (cripples) | 3/3, 3/3, 3/3 | 1,207-1,462 | 4-21 | 4-8 | 0.82-0.85 | 0-1 | 18.9 / 6.3-8.0 m/s |
| revision 2 (solid header, superseded) | 3/3 | 853-1,357 | 2-10 | 0-2 | 0.85-0.93 | 0 | 18.4 / 0.0-6.7 m/s |
| revision 1 | 3/3 | 1,238-1,300 | 6-15 | 0-7 | 0.82-0.83 | 0 | 18.6-18.9 / 3.9-6.9 m/s |

On this SDK the truck goes through the house in both revisions. It loses
about 3 m/s inside it, about what momentum predicts: it carries roughly
1.2 t of veneer with it from each wall. The earlier revision-1 runs (SDK
fc77bf97a) instead stopped it dead in one tick, 21.7 to -1.5 m/s at 142 g.

Neither revision's roof came down within the trial, and the frame stayed
82-93% anchored. The late dead-load collapse (2,143 broken, 36% anchored)
did not recur in six runs. The trial ends 4-5 s after impact.

The trial cannot separate the two revisions: their damage spreads overlap.
The count of members fallen beyond reach also depends on chunk size.
Revision 2's chunks are finer (a plate chunk per bay, 0.23 m cripples), so
the same damage counts more members.

### What remains, and whose it is

The unzip that remains (calibration truck-door, static cascade truck-door)
starts the same way every time. The plate over the gap hogs over the last
support, and the uplift it puts on the next upright breaks that upright's
end nails (0.47 kN) in tension on the first tick.

A real plate lifts a millimetre there and sits back down. The real plate is
also past its own strength over 4.3 m, so it breaks over the gap rather
than pry its neighbours up. The stage has neither:

- a bearing joint whose nails failed in tension can never bear again;
- every past-capacity bond breaks in the same tick, so there is no
  sequence in which the plate yields first.

The authoring cannot fix this without inventing hold-downs that the
construction does not have. Under AS 1684.2 Section 9, a tiled roof's dead
load needs no stud-to-plate tie-down in N1-N2 wind. It is reported as an
engine gap: unilateral re-bearing of bearing joints whose fasteners have
failed.

## Joint stiffness against the fasteners, and the explicit impact step (2026-10-08)

The perf agent suspected that the 7% of joints setting the explicit impact
step's time step were fastened joints authored with the wood's E. They are
not. Below is every fastened timber kind's engine stiffness k = E A / L
(high profile; spring length per the bridge), medians over the lab house,
against n x K_ser. K_ser comes from EN 1995-1-1 Table 7.1 at rho_m 420:
nails 3.15 mm 0.72 kN/mm, 8d 0.75 kN/mm, M12 bolts 4.49 kN/mm, gypsum
screws 0.5 kN/mm.

| Kind | Engine k (kN/mm) | n x K_ser (kN/mm) |
|---|---|---|
| rafter seat (3 nails) | 2.16 | 2.16 |
| joist seat (3 nails) | 1.76 | 2.16 (area spread) |
| ridge (4) | 3.0 | 2.9 |
| joist splice (4) | 3.1 | 2.9 |
| header-king (4 x 8d) | 3.2 | 3.0 |
| heel (M12) | 4.2 | 4.5 |
| plate lap, stud-plate side (2) | 1.4 | 1.44 |
| anchors (M12 per 0.108 m2) | 10.3 | 10.2 |
| stud lap (1 per 0.054 m2) | 0.88 | 0.93 |
| board screws (1 per 0.0135 m2) | 1.1 | 1.06 |

The stiff 7% are the members' own wood. A stud or jack is two chunks, and
the bond between its halves is E A / L of C24 over half its length:
3.7e7 N/m for a stud, 4.5e7 N/m for a jack. A stud end bearing on its plate
is E90 A / t: 3.3e7 N/m, correct in compression; its nails govern only in
tension and shear, which the stage's one stiffness per bond cannot
separate (FIDELITY_AUDIT C9).

Revision 2's plate chunks a bay long, though, had become the stiffest
elements: 1.7 kg each, 1.5e8 N/m across each cut. They doubled the bound.
Measured with the perf agent's `IMPACT_EXPLICIT_LOCAL=1` replay
(perf/explicit-step) on cannonball captures:

| Authoring | Bound omega (rad/s) | Joints over omega/2 | Stiff set |
|---|---|---|---|
| revision 1 (old SDK capture) | 2.6-2.9e4 | 7% | stud and jack halves, area 0.004, 2 kg |
| revision 2, plate a bay per chunk | 5.3-5.6e4 | 3% | plate cuts, area 0.0081, 1.7 kg, 1.5e8 N/m |
| revision 2, plate two bays per chunk (now) | **2.7-2.9e4** | 9-12% | stud and jack halves again |

So the plate is now cut every two bays (chunks 0.3-1.4 m, median 1.1 m).
On the high profile, the calibration and the static cascade are unchanged
in kind:

- intact and one bay: 0 broken;
- two bays: one frame joint (the stud next to the gap) plus one board screw;
- the truck's hole: local (24 broken, 0.81 m drop);
- truck-door: still unzips, 880 broken (C9/C10).

In an impact, fastened joints now take K_u = 2/3 K_ser (EN 1995-1-1
2.2.2(2): an ultimate state), through `impactElasticModulus`. Bearing
joints keep their wood's stiffness. This applies to high-profile packs
only. The other joints' median impact k is 2.16e6 -> 1.44e6 N/m. It does
not move the bound, which the wood sets.

## Re-bearing (C9), measured 2026-10-08

PhysX feat/rebearing (SDK garage-rebearing 402e7eb58, which carries
integration/high-fidelity ccfb4ebed), `VIBE_REBEARING=1`, now in the high
profile. A bearing joint whose fasteners fail stays as a unilateral contact:
compression to its bearing capacity (its material's, f_c,90,k for timber),
shear by friction only (mu 0.23, EN 1995-2:2004 Table 6.2, sawn softwood
parallel to the grain), no tension. It lifts off when the solve pulls it and
re-bears when the solve's displacement presses its chunks together; it breaks
only by crushing, by sliding (|V| > mu C), or when what it held has no path
left to a support (that region splits, as before).

`run.mjs house-headers --configs high`, 600 ticks, 64 iterations, FP32,
correction limit 1, the same SDK (402e7eb58) with the flag off and on, 3
runs each (the stage is not deterministic run to run). "Frame beyond" counts
frame joints broken more than one stud bay (0.6 m) outside the knocked-out
bay; "front" those in the front wall.

| Case | Off: broken / frame beyond / front frame beyond | On: broken / frame beyond / front frame beyond |
|---|---|---|
| intact | 0 / 0 / 0 (x3) | 0 / 0 / 0 (x5) |
| bay1 | 0 (x3) | 0 (x5) |
| bay2 | 2: a cripple-to-lintel joint and a board screw (x3) | 1 board screw, no frame joint (x5) |
| truck | 25 / 6 / 6 (x3) | 9 / 1 / 1 (x5) |
| truck-door | 1,166-1,241 / 120-159 / 72-78 | 1,301-1,483 / 88-104 / 39-48 |

Re-bearing does what C9 asked: the uprights beyond the gap that the plate
lifts no longer break, so truck stays local and bay2 holds (it was the MISS).
It does not stop truck-door. There the plate over the 4.3 m gap and the
joints at and beyond both ends of it (the door header's king and jack, the
next opening's cripples, jacks and headers) all fail in ticks 1-3 together,
each from one elastic snapshot: C10. Re-bearing roughly halves the front-wall
frame broken beyond the gap and cuts all frame beyond it by a third; the
total rises 10-20%, in the board and brick skins of the side and back walls
(the remains stay attached longer and load them). The calibration's verdict
is unchanged (`either`: the plate alone is past its strength over the gap);
the hand calculation's local answer needs C10's sequence as well.

On the earlier integration SDK (ec95655d5, before feat/impact-capacity's last
commits) the same comparison gave truck-door 1,708-2,295 off and 2,216-2,583
on, and one of five on-runs collapsed bay1 (343 broken, from the roof over the
bay) and truck (2,295); none did on 402e7eb58.

At rest (`qualify_structures.py`, the high packs): veneer-bungalow--frame and
veneer-house--frame 0.00% broken (0.17% / 0.18% off); the as-built houses
0.00% either way, and with the flag off the SDK reproduces the base SDK's
qualification exactly (unconverged shares and median residuals equal to the
digit). The studless variants still collapse (10% broken); the two-storey with
only its ground-floor front studs out breaks 0.45% (0.84% off), below the
acceptance's 2% collapse share either way.

## Reproduce

```sh
node --test structures/calibration/tests/hand.test.mjs structures/town-kit/tests/veneer-houses.test.mjs
uv run structures/town-kit/scripts/static-cascade.py PACK               # CPU progressive failure
CALIB_SRC=. node structures/calibration/run.mjs house-headers --configs high,runtime
scripts/fidelity/build-packs.sh high && scripts/fidelity/provenance.sh high
scripts/verify/impact-arms.sh --arms high --trials framed-house --repeats 3 target/verify/house-headers-arms
```
