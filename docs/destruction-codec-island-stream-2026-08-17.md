# Island streaming on Blast traces: the win is real, and it is blocked by rotation precision

2026-08-17. Reference: `codec-results/blast-one-building-60hz-30s/collapse.towertrace`
(10-floor high-rise, 1032 chunks, 3624 bonds, 30 s at 60 Hz, 2180 broken bonds,
peak 518 dynamic bodies), recorded by `record-city-trace` from the production
PhysX GPU + Blast CPU stress solver.

## Why this line exists

The codec's traces used to come from a sim that welded rigid bodies with fully
locked D6 joints. Those joints are soft, so chunks drift inside their "island",
and the island hierarchy had to ship per-chunk repairs (24% of child samples)
to hold its error bound -- which is why it lost to the hierarchy-free per-body
debris codec by 2.39x.

The Blast model removes the assumption. An intact structure is **one kinematic
body** holding every chunk shape; fracture migrates shapes onto child bodies
only when the bond graph actually disconnects. Chunks sharing an island are
therefore rigid with respect to each other **by construction**, so one pose per
island reproduces every chunk under it and an untouched building costs nothing.

## What was built

- `record-city-trace` (`server/src/bin/record_city_trace.rs`) -- writes TWTRACE1
  v3 with `kind=2` exact bonds from the real city sim. Chunk poses are composed
  the way a client composes them, `body_pose ∘ (rest_local - island_com)`, so
  the trace is what a viewer can actually rebuild.
- `island.rs` + `debris-codec --island-stream` (default off) -- pose records for
  island roots only, plus a reliable topology track naming which chunk belongs
  to which island.

## Result 1: the byte win is real

Same trace, same 0.5 cm masked fidelity contract, island members **derived**
from their root with no precision guard:

| | per-chunk | island stream |
|---|---:|---:|
| pose bytes | 1,203,144 | 763,674 |
| topology track | -- | 9,486 (0.003 Mbps, reliable) |
| **total** | **1,203,144** | **773,160** |
| average | 0.321 Mbps | 0.206 Mbps |
| bytes/body/tick | 0.6477 | 0.4111 |

**1.56x fewer bytes**, and the topology track is 1.2% of the total -- naming
membership is essentially free next to streaming poses. Half the chunks (519 of
1032 at peak) carry records at all; the rest are implied.

## Result 2: it does not hold the error bound, and the reason is arithmetic

That run **fails the artifact gates**: reversal p99 33.5 against a threshold of
2.0, and 243,693 shell violations at up to 6.2 cm against a 0.5 cm bound.

Every violation was on a *member*, never a root, and concentrated in one large
island (radius 31.2 m). The cause is not the fitter -- it is the wire:

> Rotation is a 32-bit smallest-three quaternion, 10 bits per component at
> scale `511*sqrt(2)`. Worst-case angular step **2.77 mrad**. A member at radius
> `r` inherits `r * step` of position error from a single quantum no matter how
> well the root is fitted.

| island radius | error floor from one rotation quantum |
|---:|---:|
| 1.8 m | 0.50 cm |
| 7.2 m | 1.99 cm |
| 31.2 m | 8.63 cm |

Equivalently, the largest island whose members can stay inside the bound:

| shell bound | max derivable island radius |
|---:|---:|
| 0.5 cm | 1.81 m |
| 2 cm (mask cap) | 7.23 m |
| 20 cm (far tier) | 72.3 m |

This is a floor of the representation, not of the encoder. Fitting the root
harder cannot cross it, and neither can more bytes.

## Result 3: guarded, it passes -- and wins nothing at the near-field bound

`--island-stream` now derives members only where precision allows
(`IslandView::derivable`), and streams them per-chunk otherwise. Gates pass
(reversal 0.000, 4 residual violations, max 2.30 cm under the masked bound),
but at the 0.5 cm reference bound the derivable radius is 1.81 m, so almost
nothing qualifies:

| | bytes | gates |
|---|---:|---|
| per-chunk | 1,203,144 | PASS |
| island, guarded | 1,235,439 | PASS |

**+2.7% -- a small loss**, being the topology track paid for with almost no
derivation earned. At this bound the mechanism is inert by its own safety rule.

## Result 4: the far field is where this pays

At the far tier's 20 cm bound, islands up to 72 m are derivable, so the whole
collapsing structure derives from a handful of roots:

| far-tier config (20 cm, 2 s flush, 128 mm grid) | bytes |
|---|---:|
| per-chunk | 468,414 |
| island stream | 336,293 |
| | **1.39x** |

Both modes fail the gates at a 20 cm bound, equally and for the same
coarse-quantization reason -- that is a property of the bound, not of island
streaming, and it is the same regime the 6.60 Mbps far-field floor lives in.

This is the connection worth following: the far-field floor was measured as
"set by how many bodies are colliding at once, insensitive to precision,
cadence and stride". Island streaming is the first mechanism that changes the
*number of bodies* rather than the cost per body, and it is precision-safe
exactly where that floor is.

## What this says to do next

1. **Widen the rotation field for island roots.** To derive a 31 m island at
   0.5 cm needs a quantum of 1.6e-4 rad, about 4 more bits per component (10 ->
   14, so 6 bytes rather than 4). Rotation is 28% of payload today, and only
   roots would pay, so a 1.5x-ish win at near-field fidelity looks reachable --
   but that is a projection, not a measurement, and the wire change touches
   every record type and all four rotation modes.
2. **Take the far-field win now.** It needs no wire change; it needs the tracks
   layer to feed island-stream input into the coarse tier (Phase 3, not done).
3. Do not tune the derivable threshold. It is derived from the quantum and the
   bound; if it looks wrong, the wire is wrong.

## Verification

Flag off is byte-inert against both incumbent wires:

- `cargo test --release` 103 passing (96 + 7 island tests)
- archive `hierarchy.compressed_bytes` **36,646,007** (unchanged)
- `debris-codec` **13,814,930** (unchanged)

Recorder invariants on the reference: broken bonds 2180 = the adapter's own
count, and the membership ledger matched the adapter's `node_count` on every
tick (0 mismatches) across 762 chunk migrations.

## Caveat worth carrying

Every number here is 60 Hz Blast content and is **not** comparable per-tick with
the 120 Hz D6 references (8.82 Mbps live, 3.68 Mbps debris). Different content,
different cadence, different physics. Compare within this document only.
