# Separate tire/rim and rotating hub chunks

Implementation checkpoint: `fec6bafd`. The shared authoring pipeline now keeps
each tire/rim/spoke/tread assembly separate from its rotating hub/rotor. Both
remain coherent chunks; the change adds four chunks and four measured wheel
mounts per model. Axles, calipers, uprights and suspension remain independent.
The visual rig rotates the hub with the wheel and leaves the caliper unspun.
Exploded-view groups use the same physical ownership.

All 11 driving builds prepare and pass eight server layout/conversion tests.
`geometry-comparison.json` compares them with the preceding mechanical assets:
world-space hulls agree to 1 nm, aggregate mass/COM/inertia agree within numeric
roundoff, all visuals are retained, and the existing interfaces keep exactly
the same area, centroid, normal and strength. No collision geometry, material
strength or projectile settings were changed. Cache recipe is
`vehicle-physics-functional-4`, topology `mechanical-mounts-2`.

The 14 all-model clearance/ownership checks pass in `initial-client-tests.log`.
That first run also exposed an obsolete exploded-view assertion requiring 149
visuals in one wheel (including its hub/rotor). It was replaced with explicit
checks for four independent two-visual hub groups and coherent tire groups.
The corrected validation/explosion checks, grouping, material, simple-shape,
mechanical-interface and hub-animation tests pass: 35 tests in
`client-regressions.log`. Together these are 49 passing client tests. TypeScript
compilation also passes. This is geometry/ownership evidence, not live gameplay.

## Impact evidence

The full six-model GPU suite is running in
`/tmp/vehicle-separate-hub-authored-verification`, using the derived ABI 22 SDK
and saved full-double convergence-gated runtime. It uses the unchanged 30 kg /
55 m/s nominal and 300 kg / 120 m/s heavy shots. Qualification is pending;
do not treat chunk separation in the authoring model as proved impact fracture.

The new `scripts/inspect-vehicle-impact.py` reads completed native reports and
their exact fixture metadata, producing per-attachment break counts and each
target interface's peak compression/tension/shear relative to its elastic
strength. Missing verdicts remain unobserved. It validates identities, areas,
finite values and duplicate records; five tests plus the existing seven
qualification negative controls pass. The qualification gate is unchanged.

`preceding-heavy-inspection.json` explains the previous failed heavy shots:
the old combined-wheel bearing/spline connections remained below their elastic
limits across all six models. The new topology exposes the existing smaller
rim/hub interface instead of requiring the whole bearing to fail. This is a
physical attachment correction, not proof that the new wheel mount will break.

```sh
python3 scripts/inspect-vehicle-impact.py \
  --fixtures /tmp/vehicle-separate-hub-fixtures.json \
  --report /tmp/vehicle-separate-hub-authored-verification/cannon-heavy.json \
  --output /tmp/separate-hub-heavy-inspection.json
```

Moving suspension geometry and mass frames, retained road handling after loss,
city append/reset, streamed fragments and live garage/city integration remain
unfinished. No performance or remote CUDA qualification is claimed.
