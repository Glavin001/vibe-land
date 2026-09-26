# Reject unconverged native material transactions

PhysX commit `6938aa7d` restores native convergence error 4096 and prevents
unconverged bond damage, crush verdicts and topology changes. Diagnostic mode
retains its existing reporting behavior. This does not make failing solves
converge or qualify driving; the caller receives a rejected simulation step.

The real-GPU regression first failed against the previous runtime: a one-iteration
weak cantilever broke a joint, committed four chunk changes and created a second
body despite non-convergence. The corrected runtime rejects that case without
publishing changes. The identical weak fixture with 2048 iterations converges
and fractures, ensuring the fix does not simply suppress destruction.

The standalone native test reads GPU accepted bond health, trial verdicts and
accepted crush state directly after rejection, and verifies diagnostic-mode
compatibility. It passes. It shares the fixture with the larger resimulation
suite; the latter currently cannot compile on this CuMetal package because an
unrelated observer requires unavailable CUDA stream-value APIs. Its full suite
was not claimed as passing.

All **15 bridge regressions pass**, including analytical unequal-mass loads,
bending readout, fracture/reset/membership, and actual Vehicle2 wheel loss with
a strong-material control. The verifier forces sampled result polling on every
step. The bridge now distinguishes a rejected fetch from an unfinished fetch,
preventing an infinite polling loop on rejected sampled steps. A separate run
also passed the ordinary blocking fetch path.

Runtime is the isolated double-precision mass-corrected candidate. Source and
artifact stability checks pass. No installed SDK replacement, performance
qualification, frozen penetration audit, full-model wheel detachment or
CUDA/Vast run is included. The original vehicle acceptance gates remain open.
