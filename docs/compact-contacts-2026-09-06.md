# Compact contact processing, 2026-09-06

Implemented as an **opt-in candidate, not deployed**. The live six-report
analysis found 92.68 ms of host contact work in the final heavy-collapse point
sample: sorting 39.76 ms, body-pair reduction 16.06 ms, routing 25.65 ms, plus
ownership and validation. The live city continues using its qualified streaming
build, Direct GPU physics, CUDA stress, native sleeping and existing freezing.

## Change and fidelity contract

The solver dependency adds reusable host scratch storage. Instead of sorting
roughly 80-byte contact payloads repeatedly, it sorts 24-byte keys and gathers
each complete payload once. The four existing unsigned keys retain all their
bits. No fifth key or stable-order rule is introduced. On the tested libstdc++
introsort implementation this preserves the legacy sequence even among equal
keys. The original canonicalized input remains available for same-batch audit.
This is a qualified implementation property, not a portable C++ guarantee:
requalify after standard-library/compiler changes. Non-libstdc++ builds reject
the opt-in path.

Reusable open-addressed tables replace per-pair unordered-map/set nodes in the
candidate. They retain full 64-bit keys, grow with the workload, and clear via
generations. Every float addition occurs in the same order, starting from the
same positive zero. Rehashing copies accumulated values rather than recomputing
sums. The live shape-ownership walk still rebuilds every drain; it also caches
actor GPU indices and report thresholds once per actor. Static actors retain
the solver world-body key. Retired/recycled shape indices still undergo full
ownership validation.

The game integrates the scratch path after the existing validation and
canonicalization. It retains every selected contact point, payload field, pair
order, entity/shape mapping and new-versus-persisting event flag. Existing native
report-threshold semantics remain identical. There are no new contact, force,
velocity, fracture, bond, or replay limits. Same-tick rollback/replay is unchanged.
This reduces host work around the current GPU simulation; fully device-resident
contact ownership and stress-load assembly remain separate work.

## Flags and audit

- `VIBE_PHYSX_COMPACT_CONTACTS=1`: enable the candidate; default off.
- `VIBE_PHYSX_COMPACT_CONTACTS_VERIFY=1`: require compact mode and run the legacy
  calculation on exactly the same canonical decoder batch.
- Compact and the held `VIBE_PHYSX_GPU_CONTACT_ORDER` experiment are mutually
  exclusive in the development branch. The qualified release branch contains
  no GPU ordering experiment.

The audit compares complete sorted contact payloads (including float signed
zero), cached actor keys and thresholds, every accumulated impulse bit pattern,
current pair membership, and every emitted point and deferred pair field.
Reference previous/current pair sets evolve independently across drains,
including empty drains. Any mismatch fails immediately. Counters record all
batches, verified records and emitted pairs; the world destructor prints the
`[compact-contact-audit]` totals.

`physics/compact_contact_verify_ms` records reference/audit overhead separately
from candidate sort/reduce/route spans. Full tick time still includes the audit:
verifier runs cannot establish a production tick speedup. The ordinary
`direct_contact_*` spans retain their existing scope.

## Completed validation

- CPU fixture: **3,910,872** exact order/payload comparisons, including large
  491,861-record batches, sort-size boundaries, random full-width keys, sorted,
  reverse, all-tied, mixed-tied, organ-pipe and alternating-extreme layouts.
- Reusable tables: **693,000** exact additions across 100 frames, with duplicate
  keys, zero/max keys, growth, signed zero, cancellation, clear/reuse and
  previous/current membership swaps against standard containers.
- AddressSanitizer and UndefinedBehaviorSanitizer: pass.
- Native CMake/CTest target `contact_scratch`: pass.
- Qualified release server and recorder: build passed after fixing a missing
  `<cstring>` include. The initial Make invocation needed CMake regeneration to
  discover the new test target. Both issues are resolved.
- Development bridge with its newer contact ABI: C++ syntax check passed.
  That held branch was not linked or deployed as a server in this step.

Compiler: Ubuntu GCC 13.3.0, libstdc++ header date 20240904. Solver commits:
`f1b931fa` (development), `887b4fa7` (qualified release branch).
Source hashes, executable hashes and compressed build/test logs are retained in
[CPU evidence](../bench-results/simulation-frontier/compact-contacts-cpu/summary.json).
Run its `verify.py` to validate the archive.

## Qualification still required

The player remained connected throughout implementation. No GPU test, public
restart, scene reset, or deployment occurred. The new server and recorder
binaries are built but not running in the public city.

Next, under exclusive GPU use when the city is empty:

1. Run the full 96,420-chunk live manifest and recorded exact shot inputs with
   the same-batch audit. Require all batches verified, zero mismatches, nonzero
   contact/event coverage and same-tick replay coverage.
2. Run repeated same-binary arms with verification disabled, including the
   5,000–6,000+ awake regime and the existing settling/quality gates. Identical
   external inputs can still yield differing GPU physics trajectories; report
   differences and do not claim equal workload from equal shot tapes alone.
3. Qualify actual multiplayer streaming and browser behavior, then deploy the
   immutable qualified binary with the flag enabled and verify the public city.

The synthetic compact-sort probe is not a city performance result. No new
full-city speedup, settling pass, or deployment is claimed by this commit.

The candidate was subsequently rebuilt with the [telemetry initialization fix](telemetry-initialization-2026-09-06.md). The prepared audit now rejects insufficient heavy-load/replay coverage through `scripts/perf/verify_compact_contact_audit.py`; the later evidence records the new binary hashes. It remains undeployed.
