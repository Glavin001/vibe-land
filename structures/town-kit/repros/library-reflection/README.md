# Unfurnished library: exact reflection changes native convergence

The 1,034-chunk library shell passes the kit's native intact test. An exact X
reflection of the same exported pack is rejected at native frame 1:
`error: 64`, 16 iterations, unconverged, unobserved. Both cases have zero external
contacts, no furniture, no impacts and the same gravity, foundations and materials.
The reflected control intentionally reflects the lettering too: it does not
re-author readable mirrored glyphs or otherwise change the physical assembly.

The original furnished mirror and a no-books mirror fail in the same way. This
narrows the issue beyond loose book stacking. It does not establish whether the
cause is the exported reflected graph or the native solver. No SDK/runtime fix is
made in the town kit, and the failing mirror remains unqualified.

Run after any other kit native/capture work finishes:

```sh
node structures/town-kit/repros/library-reflection/reproduce.mjs
```

The script runs the two cases sequentially through the ordinary isolated native
runner. Each report records raw asset hash, harness binary hash, dependency and
SDK revisions, buffers, gravity and solver settings. Results are retained at
`out/reviews/diag-library-shell-stability/` and
`out/reviews/diag-library-shell-reflection-stability/`.
`reproduced: true` describes the failure pattern; it is not an acceptance pass.
