# GPU contact ordering — 2026-09-05

The six [player reports](city-player-reports-2026-09-05.md) showed CPU contact
processing becoming a major Direct GPU bottleneck: one captured pass spent
22.5 ms in ownership, validation, sorting, reduction and routing, with 8.85 ms
in sorting alone. This change replaces that CPU sort with CUDA ordering in
the Blast contact drain. It preserves every contact and its point of
application, normal, separation, impulse and original scalar normal impulse.
It adds no force, velocity, fracture, bond or interaction budget.

## Implementation and rejected approach

The first GPU implementation used the existing CPU comparator's four fields:
canonical shape IDs, friction and point index. Real PhysX output contained
multiple pair-buffer entries with those same keys. To preserve the original
behavior, that prototype fell back to the CPU for ambiguous input, which
happened on 564 of its 900 audited ticks. It was rejected.

The final implementation retains the source pair-buffer ordinal as a fifth
key. Three stable CUB radix passes order indices, then gather and canonicalize
complete records. Keys retain all their bits; persistent device buffers grow
with observed demand. The ordinal is provenance for this copy, not a
persistent physics identity. No force reduction happens on the GPU in this
change. If the full five-key sequence is ambiguous, the complete original raw
input goes to the legacy CPU sort. Copy errors and overflow remain explicit
failures, never successful truncated batches.

`VIBE_PHYSX_GPU_CONTACT_ORDER=1` explicitly enables the experimental path.
Unset or `0` keeps the old CPU comparator. The default was changed to opt-in
after the settling qualification below; benchmark arms explicitly set `0` or
`1` and are unaffected by that launch-default guard. Optional
`VIBE_PHYSX_GPU_CONTACT_ORDER_VERIFY=1` copies the exact raw input from the
same drain operation, compares every output field against the CPU five-key
sort, and compares body-pair force-report threshold decisions against the old
four-key sort. Verification is disabled in performance runs and deployment.
New spans separate GPU ordering wall time from contact-copy and CPU phase time.

## Fidelity qualification

Six native CTests passed, including large and colliding keys, payload bit
patterns and signed zero, zero-impulse support points, growth/reuse,
non-default stream ordering, duplicate detection, a real sliding impact,
contact couples, shared-context GPU stress loads, overflow and empty frames.
The physical contact-to-stress fixture's maximum momentum error was
2.68247e-7 kg m/s. All 176 release integration tests passed; 27 were ignored by
the existing suite. All four authored-structure tests passed.

The final 900- and 1,200-tick city audits checked 2,802 contact batches against
exact-input CPU ordering and 32,502,353 legacy body-pair threshold decisions:
zero mismatches and zero ambiguous batches. They exercised 826 replay passes.
The existing bond-membership and fracture-candidate verifiers also reported
zero mismatches. Their scoped restoration checks do not prove a complete
GPU-resident replay checkpoint across every topology transition.

Defining previously unspecified ties can alter floating-point summation
order. The largest observed legacy body-pair normal-impulse sum difference was
two ULPs, with no threshold decision changes in these audits. The change is
not a promise of bit-identical long-running trajectories against legacy
`std::sort`; no forces are clipped or contacts omitted to force agreement.

The unchanged scenario suite passed facade response, collapse/spread,
retirement fraction, escape/patch headroom and its performance band. It failed
T4 awake decline: 0.146 of peak awake bodies versus a maximum of 0.10 at
40 seconds. The at-rest test passed its existing band with one broken bond,
occurring in the final third; that is not proof of zero spontaneous damage.

The first three 60-second controls per arm gave 40-second awake ratios
CPU 0.001 / 0.063 / 0.000 versus GPU 0.123 / 0.198 / 0.017. One GPU run still
had ratio 0.154 at 60 seconds. Those results triggered a predeclared expansion to nine trials per arm.
At 40 seconds, 4/9 GPU runs missed the original 0.10 gate versus 1/9 CPU runs;
at 60 seconds, 3/9 GPU runs were still above it versus 0/9 CPU runs. This is
concerning evidence, not proof of a particular causal mechanism. The candidate
is withheld from deployment and made opt-in. The original failed gate is
retained and not recalibrated.

The normal-impulse threshold checks above do not cover every downstream
stress/supporter/wake aggregate. The bridge still accumulates vector loads,
weighted contact positions and supporter loads in floating point; those sums
can depend on the newly defined tie order. Identifying the first consequential
load or decision difference is the next diagnostic step. Contact payload
preservation alone did not establish end-to-end behavior qualification.

## Performance evidence

These are medians of three trial means per arm on the same candidate binary.
Both arms use Direct GPU, the same physics settings and adaptive shot policy.
The exact rays and later scene states vary with the destruction trajectories.

| Workload | CPU ordering | GPU ordering | CPU simulation | GPU simulation |
| --- | ---: | ---: | ---: | ---: |
| Grid 2, 600 ticks, 100 shots | 3.60 ms | 0.23 ms | 42.58 ms | 36.29 ms |
| Grid 2, 1,200 ticks, 200 shots | 4.98 ms | 0.27 ms | 46.22 ms | 58.12 ms |

Ordering wall time fell about 94–95% in these campaigns, including launch,
completion and allocation when required. The regular campaign's whole
simulation mean fell about 15%, but this is not a controlled identical-state
speedup. In the heavy campaign the GPU runs produced more destruction:
median mean awake bodies were 4,206 versus 3,065 on the CPU, and median mean
contact records were 101,550 versus 57,469. The differing whole-simulation
means cannot isolate the effect of ordering. The largest GPU run reached
6,422 awake bodies and 184,414 contact records.

The regular campaign's complete observed contact pipeline mean decreased
from 9.00 to 5.50 ms. Those spans cover the first physics pass; full simulation
timings include replay. These trace benchmarks omit encoding and transport,
so they do not establish a full streamed-server tick or client-FPS improvement.
Raw distributions, population counts, trial metadata and scripts are in the
[reproducible evidence](../bench-results/simulation-frontier/gpu-contact-order/README.md).

## Deployment and remaining work

**Not deployed.** The existing city was restored after every exclusive GPU
window and remains on the previous observation-optimized Direct GPU build:
server SHA-256 `51efeb841976fe88eb5f52b1a2d84e4227ee2612d784463f82138315073a2f79`.
The URL remains <https://209.121.195.117:40617/city>. Direct GPU physics is
still enabled there; experimental GPU contact ordering is not enabled.
No map, solver, replay, freezing, CCD or material settings were changed by
this investigation. The held candidate uses the same PhysX 5.10 SDK.

The solver implementation is committed as `89e5f398`. The evidence retains
the exact measured candidate patches/binary hashes, plus the final game patch
that makes the feature opt-in. A compiled guarded-default server is recorded
separately from the measured candidate; neither is installed in the live city.

The next substantial opportunities are GPU ownership and stress-load
assembly, reducing replay restoration cost, and fixing the repeated structure
repair requests found in the player reports. CPU contact ownership, validation,
reduction and routing still remain; this is not an end-to-end GPU-resident
contact/stress pipeline. The open limits and quality defects in the
[simulation fidelity contract](simulation-fidelity-contract.md) remain open.
