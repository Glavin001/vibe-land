# Authored mass correction — local GPU evidence

PhysX checkpoint `a9aeae50` replaces native stress's equalized node weights
with the authored inverse square-root mass and scalar inertia weights. The
native producer supplies actual chunk accelerations, so equalized weights
gave incorrect physical forces. Material strengths, geometry, tolerance,
iteration budget and timestep are unchanged. The legacy reference path is
unchanged. The exact patch and runtime hashes accompany this report.

The independent analytical GPU test swaps 1 kg and 100 kg in a supported
cantilever. The old double-precision runtime returned 196.20 N at the root
instead of 990.81 N. With the correction, both arrangements meet the existing
0.01% force-balance tolerance. All 14 bridge regressions pass with the corrected
double-precision runtime, including the six-chunk wheel-detachment fixture and
its strong-material control. Raw red/green logs and bridge proof are retained.

## Complete vehicle results

Actual 30 kg, 0.20 m cannonball, 55 m/s, ray-verified wheel contact, full authored
graphs, unchanged strengths, 120 aftermath steps, tolerance 1e-5:

| Model | Broken bonds / total | Converged all steps | Target wheel detached |
| --- | --- | --- | --- |
| Buggy | 0 / 626 | Yes | No |
| Trophy | 9 / 1072 | Yes | No |
| Rally | 6 / 1102 | Yes | No |
| Monster | 8 / 1039 | Yes | No |
| Derby | 2 / 1016 | Yes | No |
| Sprint | 0 / 754 | Yes | No |

All six also pass the 30-step free-fall/no-fracture test. The impact gate remains
**failed** because buggy and sprint break no bonds. Some joints accumulate
partial area damage; this is not wheel separation. Per-contact bond verdicts,
projectile velocities and per-frame iteration counts are in the compressed
JSON reports.

## Single precision and qualification limits

The same mass correction with normal single-precision working storage fails
convergence in the unequal-mass cantilever and at the first impact step of all
six vehicles. It passes the bending readout and all six free-fall cases. It
also exposes an existing bug: unconverged solves still commit material damage
(including nine trophy bonds), despite documentation saying verdicts are
withheld. These results do not qualify damage from unconverged solves.

This is a physical equation correction with local analytical and fixture
validation, **not** completed vehicle destruction or a performance claim.
No frozen penetration audit, CUDA/Vast validation, road-load qualification,
moving suspension, full-model wheel detachment, lifecycle/streaming or browser
qualification is included. The live ABI 18 SDK remains unchanged. Saved
isolated runtimes contain the correction; the ordinary build cache has been
restored to single precision.
