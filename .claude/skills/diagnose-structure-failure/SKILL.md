---
name: diagnose-structure-failure
description: Read a structural audit and turn it into a fix — which line of the failure card matters, what each failure signature means, and why adding material usually makes it worse. Use when a structure fails its stability gate, sheds bonds, never settles, or stands when it should collapse.
---

# Diagnosing a structure

The audit produces a verdict, not a number to interpret. Read the card top to
bottom; each line answers a different question, and the common mistake is fixing
the one that is loudest rather than the one that is failing.

```bash
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release"

# The gate, with the full card on failure
cargo test -p vibe-land-destruction --features cuda-stress --release \
  --test structural_stability -- --ignored --test-threads=1 <name> --nocapture

# The same verdict as data, for tabulating or sweeping
./target/release/structure-audit <name> [max-secs] | jq
```

`--test-threads=1` is not optional: parallel runs share the GPU and SIGSEGV.

## Reading the card

```
minas-tirith: never settles: 126 bonds broken, most recently at 6 s
  peak 2.82 -> 2.02, sag 11.53 m (beam)
  #151291 BROKE at 1 s, tension wall<->beam at y=5m over 0.015 m2, last seen at 2.30x
  #149249 BROKE at 1 s, shear wall<->parapet at y=83m over 0.026 m2, last seen at 2.55x
  joint classes by time overloaded: wall<->beam (2035), beam<->roof (594), ...
  #8927 96% of run, mean 2.48, shear slab<->column at y=17m over 0.070 m2
```

| line | question it answers |
|---|---|
| verdict | settled? intact? how late? |
| `peak a -> b` | early vs late peak — the **direction** is the diagnosis |
| `sag` | deflection, and which role moved |
| `BROKE` lines | **what actually failed, and where** |
| joint classes | which population owns the problem |
| `% of run, mean` | what is merely working hard |

**The bonds that break and the bonds that are most overloaded are different
populations.** A joint can sit at 2.4× all run and never go, while the one that
goes was fine until load shifted onto it. Read the `BROKE` lines first; the
persistent list is context, not the answer.

## Failure signatures

| signature | meaning | what to change |
|---|---|---|
| broke > 0, **large sag** | stiffness, not strength — the member passes its stress check and deflects enough to crack what sits on it | more depth, shorter span. Watch weight |
| broke = **0**, never settles, peak pinned ~2.95 | damage-arrest ceiling: joints held just below fatal, load never resolving | the load path, not the material. Nothing is failing and nothing is resolving |
| breaks at `last seen at` **< 1.0x** | not a stress failure at all — impact, or a merge/solver-scale effect | look for contact, overlap, or whether it only happens merged |
| areas **< 0.05 m²** on the breaks | sliver bonds; the section-modulus term `6/sqrt(area)` amplifies bending hard on small seams | thicker members, coarser fracture, or the sliver filter |
| `slab<->slab` dominant | deck seams, usually span or seam area rather than slab strength | secondary spacing; thickness only upward |
| settles but sheds a few bonds | genuinely marginal; peak will be ~2.96 against fatal 3.00 | expect ~1% margin, and expect unrelated changes to tip it |

Two structures with identical verdict lines can have opposite problems.
`minas-tirith` deflects 11.5 m and breaks 126 sliver bonds; `petronas` breaks
**nothing** and pins at 2.95. Same "never settles", opposite fixes.

## Before adding material, check which regime you are in

The build gate prints:

```
self-weight share of what each role delivers: stair 48%, ramp 25%,
  beam 25% (2772 t), slab 23% (5452 t), parapet 10%
```

Above roughly 30%, a member is carrying mostly itself and added section costs
more in weight than it returns in capacity. **This is the single most expensive
thing that used to go unmeasured here.** The parking garage, at a 16 m span:

| change | intent | result |
|---|---|---|
| mains 1.5 → **1.7 m** | more bending capacity | 9 broken bonds → **2,235** |
| deck 300 → **250 mm** | lighter deck for the beams | 9 → **165** |
| secondaries 0.5 → **0.7 m** | stiffen the deck | 3 → **126** |
| top flange on the mains | bigger beam-to-slab interface | 3 → **4,339** |
| mains 1.5 → **1.1 m** (prestressed) | strength check said 1.0 m suffices | 3 → **116** (deflection) |
| **prestress** the mains | raise cracking stress at the same size | worked |
| **remove a level** | less load | worked |

Four of six attempts to strengthen it made it worse. Everything that worked
removed load or moved it onto a stiffer path. If a member is mass-limited, the
levers are **span, load, or a stronger material at the same size** — which for a
long span in concrete means prestress, and is exactly why real garages use it.

## Standing when it should collapse

The opposite failure, and it is a *loading* problem far more often than a
strength one. Check utilisation first: the garage sat at **6%** on a grid that
put a column in the drive aisle, so six columns held the building and cutting
90% left survivors at 60% of capacity. Nothing could fail because nothing was
working. Correcting the bay to a real 16 m span took it to 44% and it now
collapses at 50% column loss.

Ask in order: what is it carrying, over what span, on how many supports — before
touching a single material constant.

**Measure over a long enough window.** A collapse that starts at 4 s is invisible
to a probe reading deck drop at 6 s; that once produced two confident reports of
"it does not collapse" about a structure that did. Pass `max-secs` and look at
the whole curve.

## Traps

- **Non-determinism.** GPU rigid-body simulation is not bit-reproducible;
  measured damage swings 10–15% between identical runs. A change from 9 to 45
  broken bonds is noise. A change from 9 to 2,235 is not. Re-run before
  believing a small delta, and for anything closer than that use the paired
  method in `perf-ab-measure` rather than two single runs.
- **Stale packs.** `assert_pack_fresh` panics if an authoring source is newer
  than the pack, but only where `blast-stress-solver` is visible. If a result
  looks impossible, confirm the pack was rebuilt.
- **Alone is not together.** Five buildings that each shed zero bonds shed 943
  merged, some breaking at 0.31 of their elastic limit. Audit the scene you are
  shipping, not just its parts.
- **Never bench while `/city` is serving.** GPU contention kills the server, and
  a dead server looks exactly like a client crash.

## Related

`author-structures` for the build/sweep loop, `city-physics-tuning` before
changing a material constant, `city-stack-run` for serving a scene,
`perf-ab-measure` when a difference is small enough that run-to-run swing could
explain it.

`blast-stress-solver` when the diagnosis points at the solver rather than the
building. Several signatures above are solver behaviour, not structural: the
`6/sqrt(area)` bending amplification on small seams, the damage-arrest ceiling
that pins joints just under fatal, and anything that only appears once
structures are merged into one graph. Confirm which backend actually ran before
concluding anything -- the CPU solver reports its iteration residual as stress
and breaks bonds that are not overloaded.
