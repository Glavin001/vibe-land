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

The completed six-model GPU suite uses the derived ABI 22 SDK and saved
full-double convergence-gated runtime. The source and artifact integrity checks
pass. The heavy wheel-loss test and free-fall controls pass on **all six models**:
each targeted wheel separates on tick zero and remains disabled for 119 further
ticks under continued throttle. Heavy shots break 30/48/55/56/49/44 bonds on
buggy/trophy/rally/monster/derby/sprint (roughly 4.6–6.1% of each graph). Every
impact completes 120 converged steps. All six free-fall controls complete 30
steps without fracture.

The overall suite remains failed because nominal shots break 0/7/6/8/2/0 bonds;
buggy and sprint do not satisfy the unchanged nominal-fracture assertion. Their
wheel mounts reach only about 20–22% of the elastic compression limit. Both
nominal (30 kg / 55 m/s) and severe (300 kg / 120 m/s) loads are unchanged.
See `authored-report.json` and `authored-tests.log`.

Full raw reports are saved locally at the paths and hashes in
`raw-evidence.json`. The compressed repository copies explicitly select every
target interface, every broken bond and every interface with positive damage
or utilisation at least one, while retaining **all frames** and ownership /
functional observations. `selected-evidence-check.json` verifies the selected
copies produce exactly the original gate errors and frame summaries.

The new `scripts/inspect-vehicle-impact.py` reads completed native reports and
their exact fixture metadata, producing per-attachment break counts and each
target interface's peak compression/tension/shear relative to its elastic
strength. Missing verdicts remain unobserved. It validates identities, areas,
finite values and duplicate records; six tests plus the existing seven
qualification negative controls pass. The qualification gate is unchanged.
The native rows are sampled after the corrected solve. A bond broken during
the intact trial can already have cleared stress values at observation time.
The inspector excludes those post-break rows from stress peaks and reports
unavailable trial peaks as null, never as a zero fracture load. A dedicated
negative control covers this limitation; committed break events and ownership
separation remain independently available.

`preceding-heavy-inspection.json` explains the previous failed heavy shots:
the old combined-wheel bearing/spline connections remained below their elastic
limits across all six models. The new topology exposes the existing smaller
rim/hub interface instead of requiring the whole bearing to fail. The new topology now proves that the smaller mount separates under the same
severe impact without weakening material strengths.

```sh
python3 scripts/inspect-vehicle-impact.py \
  --fixtures /tmp/vehicle-separate-hub-fixtures.json \
  --report /tmp/vehicle-separate-hub-authored-verification/cannon-heavy.json \
  --output /tmp/separate-hub-heavy-inspection.json
```

Moving suspension geometry and mass frames, retained road handling after loss,
city append/reset, streamed fragments and live garage/city integration remain
unfinished. No performance or remote CUDA qualification is claimed.
