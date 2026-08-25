# The v2 A/B: what a shipping client actually displays, beside truth

2026-08-20. Videos: `viewer-videos/v2-ab-2026-08-20/`
(`compare-3way-barrage.mp4`, `compare-3way-heavy.mp4`; single-pane versions
alongside). Harness: `record-city-trace --v2-view` — the real
`ChunkStreamEncoder` runs beside the sim and a modelled client is fed its
emitted **bytes only**, through the same `wire::decode_*` the browser mirrors,
displayed through the same presentation model at the client's 6-tick delay.
All three legs of each comparison come from **one GPU run**.

## The two runs

| run | scene | peak bodies | v2 pose stream | v2 reliable share | island stream total |
|---|---|---:|---:|---:|---:|
| barrage | grid 3, 3 of 9 attacked, 60 s | 3,431 | 1.77 Mbps | 15.4% | 1.33 Mbps |
| heavy | grid 4, all 16 raked, 60 s | 7,103 | 2.10 Mbps | 24.9% | 3.24 Mbps |

Byte shares agree with the standalone bench — the cross-check that the modelled
client is receiving the real stream.

## Verdict

**The starvation is visible, and it scales with load.**

- **Barrage (3.4k bodies):** v2 is broadly plausible in motion, but the rubble
  field diverges from truth over the run — chunks hold stale poses while truth
  has moved on, and the final pile's shape is visibly different. The island
  stream is indistinguishable from truth.
- **Heavy (7.1k bodies, ~6,900 awake):** v2's divergence is unmistakable in a
  single frame: large slabs hang suspended mid-air where the server's bodies
  have long since fallen, and the pile geometry is substantially wrong. This is
  the 40–70 s moving-body staleness measured earlier, rendered: the priority
  function's two-pixel budget is evaluated at send time, and a body skipped
  while "slow" keeps falling on the server while the client's copy floats.
- The island stream passes its artifact gates on both runs and tracks truth
  closely at every scale tested, at comparable or lower bitrate.

So the server-side ambiguity is resolved: v2's per-client selection is not
"slightly stale but pixel-correct" — under sustained destruction it displays a
**different scene** than the simulation, and the failure mode (floating
buildings-sized slabs) is exactly the kind a player notices.

## Honest caveats

- The v2 client model omits datagram loss (perfect delivery) and network jitter
  — both would make v2 look *worse*, not better.
- One fixed camera (the interest camera is the rendered camera, so what you see
  is what the encoder was serving).
- The island-stream leg is the offline decoder; its live datagram form (Phase C)
  will pay a packetization overhead not shown here (quantified next, in C0).
- v2's heavy-run pose stream sat near its 2.5 Mbps ceiling (2.10 measured), so
  part of the heavy-run divergence may be budget as well as evaluation policy;
  at barrage scale the earlier controls showed budget irrelevant.

## Consequence

Phase C (the live debris codec) proceeds as an upgrade with a *visible-quality*
justification, not only a scaling one. The v2 A/B harness stays: it is the
acceptance instrument for C4 (render the v3 client the same way, beside the
same truth).


---

# C0: the flush-latency operating point

Same island-stream codec, 0.5 cm masked contract, both reference traces, all
gates PASS at every setting and error p95 flat (the bound holds regardless;
flush buys *bytes*, not accuracy):

| trace | 50 ms flush | 100 ms | 250 ms |
|---|---:|---:|---:|
| c9-barrage (70% of bonds broken) | 2.635 Mbps (+86%) | **1.786 (+26%)** | 1.415 |
| city25-wide | 1.904 (+67%) | **1.291 (+13%)** | 1.138 |

**Operating point: flush = 100 ms.** The 50 ms point pays 67–86% more bytes for
50 ms less refinement latency; the 250 ms point saves 13–26% but pushes
end-to-end refinement to ~350 ms. At 100 ms flush + the client's 100 ms
interpolation, refinement latency is ~200 ms against today's ~135 ms — and
fracture *events* stay at today's latency via reliable promotions + glide.
Worst measured case at the operating point is 1.79 Mbps, inside the 2.5 Mbps
per-client ceiling.

Still owed by C0 (needs C1 code to measure honestly): the self-contained-packet
compression penalty and the smeared-restatement (K) overhead. Both land with the
LiveEncoder and gate C1.
