# Native stress-budget discrepancy: 14-chunk chair

No impacts, player, construction anchors, furniture attachments, or damaged
building are needed. The same physical chair (14 chunks, 14 bonds) and identical
metadata pass normal-gravity intact stability at 16 stress iterations, but break
8 bonds at the first observed tick at 2048 iterations. The latter is the budget
used by the existing `physx-bridge/tests/native_gameplay.rs` test setup.

The 2048 result is `observed: true`, `error: 0`, `degraded: false`, and
`converged: false`. This deserves investigation: the public configuration comment
says unconverged steps are rejected rather than publishing residual-driven
fractures. These observations do not establish whether the cause is solver,
contact handling, or an unsupported authoring pattern.

Both cases used the identical native harness binary and asset bytes. Gravity is
9.81 m/s²; contact/sleep settings are unchanged; freezing and debris parking are
disabled. Hardware, shared-GPU status, SDK revisions and hashes, all settings and
source provenance are in the adjacent files. The full furnished grocery also
shows the discrepancy, but this chair is sufficient to reproduce it.

From the repository root:

```sh
node structures/town-kit/repros/native-budget/reproduce.mjs
```

The command verifies the immutable snapshot hashes and runs the two GPU cases
sequentially using the kit's own Cargo workspace, build directory and offline
cache. It writes only kit-local diagnostic outputs and leaves source assets,
SDK, bridge, main application, and running services unchanged. Run it after any
kit capture/native job finishes. `reproduced: true` means the documented failure
was observed; a passing 2048 case is a potentially useful change to investigate,
not something the script will conceal. Detailed results are saved under
`structures/town-kit/out/reviews/repro-budget-chair-*/`.


Ground-size control: the same chair also breaks eight bonds at tick one with
32 m ground tiles instead of the single 10 km ground box. That rules out the
large box extent as the sole cause in this setup. The separate control report
and full provenance are included. The standard packaged rerun was verified
end to end and reproduced the 16/2048 difference.
