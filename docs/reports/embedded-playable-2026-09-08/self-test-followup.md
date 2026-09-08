# Browser retest and reset crash fix

The requested retest **found a crash**, reproduced it in a small native fixture,
fixed its cause, and then passed two complete browser cycles on the deployed server.
The earlier deployment report was insufficient to establish reset/re-impact safety.

## Cause and fix

Native correction and sleep rollback write GPU bounds-update flags. Ordinary
native ticks did not consume them when Direct GPU API was disabled. After deletion
and recreation, a later correction submitted stale shape handles to SAP and wrote
through invalid endpoint indices. CUDA-GDB located `markUpdatedPairsLaunch`;
filtered Compute Sanitizer confirmed invalid writes in that kernel.

Consume the flags on ordinary native ticks as well as correction, clear each flag
in its existing merge kernel, refresh the borrowed descriptor/pointer dependencies,
and size the update storage for the complete bitmap. No collision or stress work
is suppressed. Clearing flags only during correction was tried and was insufficient.

Engine fix: `72a672709b1327add0d39a745e9a321a00c5806c`. No diagnostic printf instrumentation remains.

## Results

Both browser cycles use **444 chunks / 896 bonds**, physical demolition spheres
of **18,000 kg at 40 m/s**, timestep **1/60 s**, Direct GPU API **off**, native sleep
**on**, max **one correction/tick**. Browser-timed inputs differ between runs, so
these are functionality tests, not deterministic performance comparisons.

| Check | Work exercised | Outcome |
|---|---|---|
| ✅ Browser cycle 1 | 8 accepted shots, 249 broken bonds, 49 detached motion groups, 6 corrected ticks | 49 sleeping groups after 30 one-second samples; reset to 0 broken bonds / 0 detached groups |
| ✅ Browser cycle 2 | 6 accepted shots, 201 broken bonds, 37 detached motion groups, 2 corrected ticks | 37 sleeping groups after 30 one-second samples; reset to 0 broken bonds / 0 detached groups |
| ✅ Native lifecycle regression | 36 chunks / 60 bonds; initial impact, then three reset/reconnect/re-impact cycles; 545 physics steps | Previously reproduced the GPU crash; now passes mapping, query and fracture checks |
| ✅ Existing ordinary-scene suite | Seven native tests | All pass |
| ✅ Frozen penetration | 444 chunks / 896 bonds; ten simulated seconds | 398 retained, 46 detached, 199 broken bonds; exact topology signature unchanged; convergence passes and correction ≤1 |
| ✅ Targeted GPU memory audit | Same lifecycle fixture; `--kernel-name kns=markUpdatedPairs` | Zero errors in the previously crashing kernel; this is not a claim of whole-pipeline memcheck coverage |

I inspected the browser screenshot: the projectile opened the wall and the frame
remained standing. Both runs had zero topology hash mismatches, orphaned chunks,
and stale-drawn-chunk diagnostics at the captured post-shot observations. Neither
run showed below-ground debris during its 30-sample settling window. This does not
close the earlier intermittent debris report or substitute for endurance testing.

The service was left running with an intact reset scene, no connected test players,
native backend health OK, and its UDP reachability self-test passing. Local browser
WebTransport was verified; public-IP HTTPS hairpin timed out from this instance,
so an external browser connection is still not independently verified here.

[Inspected screenshot](retest/after.png) · [Native quality](retest/native-quality.json)

The raw browser inputs/observations, settling samples, reset observations, build
receipt and test logs are in [retest/](retest/). No performance claim is made from
these tests. Full GPU sanitizer initially encountered tool/hardware-exception
handling failures; kernel-filtered checking was used to isolate and verify this fix.
