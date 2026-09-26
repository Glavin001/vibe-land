# Rejected: double solution accumulation with float hierarchy

The candidate kept the accumulated node solution, bond reconstruction and
physical residual verification in binary64, leaving iteration vectors, local
inverses, hierarchy and convergence tolerance unchanged. This isolates part of
the precision difference without enabling binary64 for the entire hierarchy.
It includes the committed authored-mass and convergence-rejection corrections.

Both analytical GPU tests pass (unequal-mass force balance and bending). All six
complete vehicles pass free fall and their first cannon-impact solve. However,
the subsequent impact gate fails: buggy/trophy/monster/derby/sprint reject at
impact aftermath ticks 4/1/12/46/16 respectively. Only rally completes all 120
steps. Rejected steps report no material commands or committed changes. This is
insufficient as a replacement for the converged full-double candidate, so the
production experiment was reverted. The exact patch is retained here.

The initial run accidentally used a stale server test consumer without the
committed sampled-fetch rejection fix. It hung while repeatedly rejecting an
already-fetched result. That isolated process was terminated and its repetitive
2+ GB temporary log reduced to a recorded byte/line count, SHA-256 and prefix.
The partial report is retained separately. The server consumer was rebuilt and
the complete run repeated with sampled polling every tick; that run exits
normally with the failures above. Do not compare these two runs as numerical
repeatability or performance evidence.

Runtime and new server binary hashes are included. The saved runtime overlay
is an experiment, not installed SDK output. No performance or CUDA qualification
is claimed. The ordinary isolated build directory also still contains this
rejected compiled artifact; use an explicitly identified saved overlay or
rebuild from the reverted source before any subsequent execution.

A separate observational attachment audit records the buggy wheel's 11 measured
interfaces (about 0.0652 m²) to arms, axle, shock eye, boot and upright. Several
are not plausible direct mechanical wheel attachments. Geometry-derived
interfaces require mechanical review before wheel-separation tuning; no
materials, contact graph, mass or geometry were changed in this experiment.
