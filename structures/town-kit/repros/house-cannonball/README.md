# Bayline / Fractured Town cannonball comparison

**Experimental authoring, deployed to `/city` for user-directed testing.** The
opt-in framed builders have not passed the full destruction qualification campaign.
The default builders remain unchanged. `test-authoring.mjs` compares both legacy house
builders against the prior committed implementation, including mirrored and
unfurnished variants.

## Reproduced problem

The test extracts the actual houses from `fractured-town.json`, including the
scene's extra bonds. It verifies the standalone house geometry identifies the
extracted range and rejects any bond crossing that range. Bayline inputs are
exact previously audited placements, translated to the origin.

All four original inputs passed gravity, convergence, physical rest, and 1,800
subsequent idle steps with no spontaneous breaks. Then one ordinary city
cannonball was launched against the side wall: 10,650 kg, radius 0.68674755 m,
60 m/s, TTL 360 ticks. This uses `World::launch_dynamic_ball`, the actual city
weapon path, rather than a manually injected bond break or the small-round
helper. Shot start is the physical sphere position, clear of the wall; no player
muzzle is simulated.

| Exact isolated asset | Chunks | Bonds | Broken after 30 s | Awake bodies after 30 s | Solver converged at 30 s |
|---|---:|---:|---:|---:|---|
| Fractured Town one-storey | 319 | 904 | 527 | 0 | No |
| Fractured Town two-storey | 599 | 1,714 | 57 | 0 | Yes |
| Bayline bungalow | 1,886 | 3,820 | 2,203 | 622 | No |
| Bayline porch house | 3,374 | 6,931 | 5,114 | 1,805 | No |

The one-storey reference is not a universal passing control: it comes physically
to rest, but its stress solver remains unconverged after this hit. Do not equate
sleeping bodies with a valid settled stress certificate.

Bayline's porch house contains 2,070 chunks below 5 kg (median 3.29 kg), compared
with nine in the reference two-storey house (median 214.10 kg). Bayline also
routes bearing through a separate 12 mm floor finish bonded to its structural
floor. Within the first six steps, 116 floor/finish connections break in the
porch house. Many building junctions use a 1 MPa tensile / 2 MPa shear joint;
the reference's timber-frame bonds use the existing bulk timber material.
The reference carries its skin on posts and beams, whereas the original Bayline
wall panels are also the supporting structure.

## Controlled checks

`candidates.py` changes one aspect at a time, leaving originals intact:

- Combining the two floor layers into full-thickness timber fragments preserves
  the world-space solid, mass and material strengths. Side-wall damage in the
  porch house falls from 5,114 breaks / 1,805 awake bodies to 549 / zero, with a
  converged final solver. Doing this to floors alone also succeeds on that hit;
  doing it only to the ceiling does not.
- The same combined-floor candidate does **not** qualify generally. A front hit
  leaves 138 bodies awake; an upper-storey hit leaves 279. The bungalow also
  retains active rubble. This is evidence of a faulty load path, not a complete
  fix.
- Replacing all timber-joint strengths by bulk timber was a diagnostic only.
  It helped one house, but the bungalow produced three escaped bodies. This
  broad-strength change is **not** a production change.

## Skeleton-first prototypes

New opt-in exports live in `src/framed-houses.mjs`:

- `buildFramedPorchHouse(options)`
- `buildFramedBungalow(options)`

They reuse the existing rooms, openings, stairs, doors, furniture, fencing and
palettes. New parts provide actual posts, headers, an internal footing,
180 mm structural timber decks, roof rafters with bearing seats, ridge and king
posts. Wall infill has 6 mm clearance above and below, with lateral weak
attachments. Structural timber strength applies only at frame-to-frame/deck
connections; siding, infill, glazing and furniture retain their own weaker
attachments. The latest candidate uses longer siding boards to reduce needless
fragmentation. Authoring metadata labels the structural and cosmetic roles.

The bare-frame test removes the cosmetic envelope while retaining roof
covering, floors, stairs, furnishings and fencing. Both rebased v4 bare frames
passed real convergence/rest and 30 subsequent idle seconds, with no breaks or
crushing. They took roughly 49–53 simulated seconds to establish equilibrium;
these are not claims of instantaneous initialization.

Measured v5 porch-house side shot: 668 breaks, 44 awake bodies at 30 s, solver
still unconverged. The house remains standing with a localized wall breach.
A direct wall-post shot breaks 41 structural connections, releases five post
chunks and a beam, and returns to zero awake bodies / a converged solver. The
roof-post-direction shot also settles, but breaks gable attachments, **not**
structural frame joints; it does not qualify support-loss collapse.

The v4 framed bungalow side shot returns to zero awake bodies and convergence;
the later v5 board layout sleeps physically but does not converge after damage.
These results remain shot-specific. No prototype is town-release qualified.

## Native numerical failure exposed by the frame

Centered hulls in the new roof triggered native stage error 64 on the first
unaccepted step. A read-only C++ device-view probe identified stress-topology
error 8. A private print-only runtime copy then identified:

```
hierarchy=0 initialized=1
modes=16 modesInitialized=0
```

`StressMotionForest.cuh::exactMotionAdd` rejects representational loss when
summing the rigid-motion offsets. This is distinct from an ordinary iteration
budget timeout or spontaneous material failure. No shared SDK code was changed.

An equivalent local-origin representation avoids this failure in the tested
frames: convex hulls use their local AABB corner as their reference point.
PhysX still calculates the actual COM. World-space vertices differ by at most
1.71e-15 m in the JS equivalence check; masses, bonds, materials, support flags
and geometry remain unchanged. `parts/hull-origins.mjs` applies this only to the
experimental frame path. This does **not** claim the general SDK numerical issue
is fixed; additional placements and damage trajectories still need review.

## Evidence and reproduction

Raw inputs, per-step series, broken-bond events, chunk poses/body membership,
reports, saved-camera images and diagnostic logs are in:

```
structures/town-kit/out/reviews/house-cannonball/
```

`results.json` is the compact measured summary. `comparison-sheet.jpg` in the
raw review directory shows actual intact/30-second recorded views. The existing
kit viewer is used through read-only Playwright request routing; it does not
publish or overwrite staged assets. Software rendering avoids extra GPU rendering
work during the diagnostic campaign.

From the repository root:

```sh
python3 structures/town-kit/repros/house-cannonball/prepare.py
CARGO_HOME=$PWD/structures/town-kit/out/cargo-home \
CARGO_TARGET_DIR=$PWD/structures/town-kit/native/target \
CUDA_HOME=/usr/local/cuda-12.8 \
cargo build --offline --locked --release \
  --manifest-path structures/town-kit/warm-start/native/Cargo.toml \
  --bin house-impact-review
python3 structures/town-kit/repros/house-cannonball/run.py CASE_NAME
node structures/town-kit/repros/house-cannonball/test-authoring.mjs
```

`run.py` refuses to overwrite completed cases and holds the kit GPU review lock.
Use a fresh named case directory for any revision; preserve failed reports.
The recorded settings are gravity 9.81, 60 Hz, 16 stress iterations, tolerance
1e-3, native correction limit 2, no added damping, default native sleep and
stabilization thresholds. Runtime and asset hashes, SDK/repo revisions and GPU
hardware are recorded. The live server continued running on the shared GPU:
**timings are diagnostic and cannot establish an exclusive performance result.**

Remaining gates: reliable post-impact convergence/rest across hit locations,
true support-loss collapse, furnishings falling with destroyed floors, actual
capsule traversal, physical repeated/rotated instances, and final visual review.
Do not promote based on intact stability or a single successful shot.

An additional collider-representation test (`panel-hulls.mjs`) preserves solid
geometry and bonds but converts eligible architectural boxes into equivalent
convex hulls. The porch-house side hit then ends with 644 breaks, zero awake
bodies and a converged solver. The bungalow counterpart loses one body below the
world and fails. That conversion is retained **only as a diagnostic candidate**;
it is not enabled in the builders. Primitive/contact representation is therefore
another measured contributor, not a reason to globally strengthen the materials.

## Dense cannonball / meteor motion follow-up

See [MOTION-FINDINGS.md](MOTION-FINDINGS.md) for the four exact-deployed-template
native tests, continuous MP4 recordings, measured contact jitter and ground
collision failure, and the controlled ground-gap probe. These findings supersede
any inference of correct damaged motion from an intact startup smoke check.
