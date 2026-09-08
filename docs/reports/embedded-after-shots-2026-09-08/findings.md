# After-shot slowdown reproduced

[Two submitted reports](report.md) and [my live browser reproduction](browser/report.md) confirm that modest local destruction still causes severe server hitches. The quiet rows in the submitted reports are now around five milliseconds; the prior idle fix worked, while active destruction remains too slow.

The browser capture used five trigger actions and six server-accepted projectiles in the 27-building / 24,105-chunk / 74,543-bond city. Its worst sampled physics step was 613.577 ms with only nine awake fragments. Once the debris settled, sampled physics returned near 4.5 ms. Software browser rendering/input delivery differs from the user's client, so this is observational reproduction, not isolated performance qualification.

A [separate native phase replay](../../../../physx-2/qualification/vibe-after-shots-phases-20260908/interpretation.md) proves that a subsequent step with no fracture and no correction spends 118.113 of 119.804 ms in GPU stress (same city, three recorded projectiles, 29 fragments / 25 awake). The actual rigid-body replay at the fracture peak is small. Some large enclosing scopes still need finer attribution; they must not be mislabeled CPU work.

No new performance fix is claimed in this investigation. The next target is active stress work and fracture-time hierarchy/solver work, using these captures as regressions. Reusing settled results alone does not solve incoming impacts and changing loads.
