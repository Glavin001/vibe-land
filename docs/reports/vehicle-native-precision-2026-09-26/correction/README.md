# Exact motion arithmetic: local GPU correction

The six complete drivable models now register and complete 30 native GPU
free-fall steps each without solver errors, broken bonds or lost hull ownership.
The original failing authored values are preserved. No geometry snapping,
strength changes, convergence relaxation or extra correction passes were used.

The old Apple motion forest stored three non-overlapping floats but rejected
values outside a single binary64 significand. Removing that restriction fixed
the tiny-COM reproduction; the full buggy still exceeded the three-term
capacity. The correction retains eight exact terms and compares closure
products through error-free expansions. It never collapses those predicates
to a rounded double. Pair arithmetic for the solver's projection is unchanged.

The product comparison uses the grow-expansion technique described by
[Shewchuk](https://www.cs.cmu.edu/~quake/robust.html). Tests compare the actual
production arithmetic against Python exact rationals and separately execute
the predicates on the GPU.

Passed on the local CuMetal GPU:

- 90,100 exact-rational arithmetic checks, including long walks, low-term
  cancellation, product comparisons and unsupported-range rejection.
- 12 device arithmetic predicates, including preservation of a fourth term.
- All six full models, 30 free-fall steps apiece.
- 12 native vehicle/constraint/compound/fracture regressions.
- 12 bridge regressions: ten city/reset tests, the tiny-COM test, and the
  controlled wheel-impact test. A 300 kg shot breaks one 20 MPa wheel mount,
  disables that wheel for 119 ticks, and does not break the 1 GPa control.

| Full model | Chunks | Hulls | Bonds |
|---|---:|---:|---:|
| Buggy | 190 | 384 | 626 |
| Trophy | 332 | 674 | 1,072 |
| Rally | 327 | 664 | 1,102 |
| Monster | 328 | 622 | 1,039 |
| Derby | 326 | 639 | 1,016 |
| Sprint | 222 | 461 | 754 |

This is a correctness checkpoint, **not completed garage destruction**.
Full-model moving suspension/fracture, nominal 30 kg gameplay impacts, client
fragment rendering and reset/city integration remain unfinished. The live
SDK and garage server were not changed.

The NVIDIA motion forest still uses checked binary64 sums; this correction
currently applies to the Apple expansion path. CUDA qualification is deferred.
The larger legacy motion-mode parity test also fails to compile in the current
FP32 CuMetal configuration because several test helpers assume double-valued
solver storage and a different cooperative-launch signature. Its build log is
retained. The frozen penetration harness depends on Linux `/proc` inspection
and an unavailable demo binary; it was not qualified here. Eight-term storage
increases transient forest memory, so complete-step performance qualification
is still required before claiming this is ready for the main city workload.

Evidence: [full-model pass](full-model-green.log),
[three-term intermediate failure](three-term-full-model-red.log),
[arithmetic oracle](arithmetic-oracle.log), [device predicates](gpu-predicates.log),
[bridge proof](bridge/report.json), [native tests](native/tests.log),
[legacy parity build limitation](legacy-parity-build.log),
[artifact hashes and qualification limits](report.json).

Reproduce the bridge qualification without replacing the installed SDK:

```sh
python3 scripts/verify-vehicle-bridge-fracture.py \
  --sdk /tmp/vehicle-fracture-sdk22 \
  --target-dir /tmp/vibe-vehicle-abi22-target \
  --runtime-overlay /tmp/vehicle-motion-wide-libs \
  --output /tmp/vehicle-motion-repeat-proof
```

The verifier records and verifies hashes for the explicitly selected runtime
overlay. It rejects an unrecorded `DYLD_LIBRARY_PATH` override.
