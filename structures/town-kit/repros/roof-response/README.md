# Roof and frame response, 2026-09-21

**Historical investigation notes.** For the subsequent SDK fix, production-path
results, and remaining failures, read the [September 22 handoff](../../../../docs/bayline-handoff-2026-09-22.md).
The experimental residential profiles remain undeployed and are not qualified.

An opt-in `impactProfile: 'residential-v1'` is implemented for the framed porch
house and bungalow. It improves meteor penetration in the tested cases, but is
**not destruction-qualified and has not replaced the public town**. Cannonball
response and damaged-state collision/rest still fail. Defaults remain unchanged.

```js
buildFramedPorchHouse({impactProfile: 'residential-v1', palette: 'sage'});
buildFramedBungalow({impactProfile: 'residential-v1', palette: 'blue'});
```

## Construction change

The old roof had 100 mm stone-strength covering and a continuous 180 mm timber
ceiling deck. The candidate has 30 mm slate/sheathing covering, 180 mm ceiling
plates/joists, and 25 mm ceiling panels between joists. Rafters and king posts bear
directly on structural members; ceiling panels are not in their vertical load
path. The building envelope, stairs, openings, furnishings and navigation stay
unchanged. Both mirrored layouts pass geometry and structural connectivity tests.

Structural connections, including authored member subdivisions, use the existing
`timber-joint` material instead of full bulk timber. Roof/panel attachments use
`cladding-fastener`. Joint compression/tension/shear fatal limits are 16/1/2 MPa;
bulk timber was 90/36/25.2 MPa. This is an experimental connection model, not a
claim to have calibrated every real timber failure mode. Geometry/contact areas
are calculated normally; no invented bond areas, fixed above-ground members,
gravity changes, disabled collisions or suppressed destruction were introduced.

## Native results

Each case uses the private native harness with gravity 9.81 m/s², correction limit
1, 16 stress iterations, tolerance 0.001, the real city cannonball/meteor planner,
and a fresh scene. Launch is forbidden until 1,800 consecutive steps have observed
convergence, physical rest and zero spontaneous damage. All 22 completed cases
in this review passed that intact gate. GPU cases ran sequentially; the public
server also ran, so timings are not exclusive-GPU benchmarks.

The main comparison uses the deployed Juniper porch-house options (sage, mirrored,
paired windows) and Veranda bungalow options (blue, unmirrored, full porch, paired
windows). The earlier Garden bungalow candidate is separately identified below.

| Matched meteor case | Initial vertical velocity after impact | Construction mass displaced >0.5 m at 15 s | Escaped debris bodies | Final rest/solver gate |
| --- | ---: | ---: | ---: | --- |
| Existing Juniper porch house | +16.15 m/s (rebound) | 0.74% | 0 | Pass |
| Candidate Juniper porch house | -113.44 m/s (penetrates) | 85.72% | 3 | **Fail** |
| Existing Veranda bungalow | +7.43 m/s (rebound) | 20.41% | 0 | Pass |
| Candidate Veranda bungalow | -113.37 m/s (penetrates) | 59.98% | 3 | **Fail** |

Here displacement is a review metric, not a literal percentage of the building
material destroyed. It measures native chunk-center movement from the intact
recording and weights by mass, excluding buried anchors and separately authored
props. Detached mass and chunk percentages are also recorded. Rotation alone
need not move a chunk center. A large broken-bond count is not sufficient.

A second meteor trajectory, seed 20260922 aimed at the roof, also penetrated both
initial candidate styles: Juniper displaced 80.65% of construction mass; the cream,
mirrored, entry-porch/wide-window **Garden bungalow** displaced 49.61% (50.31% of
chunks). That bungalow is a different variant from the deployed blue Veranda.
These are not proof that all roof locations or all town variants meet 50% damage.

Direct side-post cannon hits at z=-0.93 break the frame. Juniper continues into
the wall at +15.89 m/s, the Garden bungalow at +59.50 m/s; partial structural
collapse follows. Ordinary z=0 wall shots remain inconsistent and can rebound.
Shifting the cannon start from x=-9 to -9.5 m, keeping the building/strengths
unchanged, changes Juniper's broken bonds from 1,883 to 116. The very small change
in gravitational drop does not explain the whole effect, but these are not a
continuous-contact instrumented proof of the precise SDK mechanism.

## Rejected probes and remaining work

- Using joint strength throughout the original solid roof/frame gives 59.36%
  displaced construction mass but still rebounds initially and loses three debris
  bodies through collision. Lowering roofing material limits alone did not fix it.
- Blanket 10x/100x reductions to timber/roof strength cause uncontrolled collapse
  and many escaped bodies. They are diagnostic JSON variants only.
- Weaker cosmetic attachments alone do not consistently allow penetration.
- Holding siding strongly to backing while releasing weak frame clips is also
  unreliable: one cannon case collapses most of Juniper while another rebounds
  with almost no movement. This probe is not the candidate's authoring policy.
- Candidate meteor debris still includes bodies falling below the static ground;
  affected types include siding, trim, rafters and, in the second trajectory,
  frame posts and ceiling panels. Hundreds of bodies remain awake and stress does
  not settle within the 15 s observation. This fails qualification even though
  the intact building passed and the meteor now penetrates.

The remaining work needs collision/contact investigation alongside authoring.
The bridge explicitly rejects scene CCD for native destruction; that alone does
not prove the cause of every escaped piece. Earlier native recordings also show
contact loss after detachment from near rest. Do not describe all these failures
as high-speed tunnelling, fix them by freezing debris, or deploy a blanket strength
reduction as the solution. The public correction limit remains 1.

## Reproduce

From the repository root:

```sh
node structures/town-kit/repros/roof-response/build.mjs NEW_LABEL
VIBE_CITY_NATIVE_CORRECTION_LIMIT=1 python3 structures/town-kit/repros/house-cannonball/run.py roof-response-NEW_LABEL-porch-meteor roof-response-NEW_LABEL-bungalow-meteor roof-response-NEW_LABEL-porch-cannonball roof-response-NEW_LABEL-bungalow-cannonball
python3 structures/town-kit/repros/roof-response/measure.py CASE_NAME
node structures/town-kit/repros/roof-response/test-authoring.mjs
node structures/town-kit/repros/house-cannonball/test-authoring.mjs
```

Build/run refuses existing case directories/results. `prepare-probes.py` and
`prepare-cassettes.py` reproduce controlled material-only probes using preserved
input assets; their named case directories must not already exist.

Start the private kit preview using `node structures/town-kit/scripts/preview.mjs`,
then `node structures/town-kit/repros/roof-response/screenshots.mjs CASE_NAME ...`.
The script renders native recordings and measured projectile positions with the
same camera/lighting. It waits for textures and records browser errors. Images
were opened and inspected; they show roof penetration followed by collapse,
while the old porch roof loses just a small patch. Software-rendered stills are
not a framerate or smooth-motion benchmark. Native recordings retain measured
poses and velocities; normal sampling is every 12 ticks (5 samples/s).

Raw case inputs, settings, hashes, events, measurements and compressed recordings:
`out/reviews/house-cannonball/roof-response-*`. The matched porch asset is
byte-identical to `roof-response-residential-v1-porch-meteor/asset.json`; its existing
measurements are reused. Rendered comparisons and review provenance are in
`out/reviews/roof-response/`. Large generated files remain ignored by Git.
