# Experimental civic mortar joints — not promoted

The ordinary civic walls bond adjacent masonry chunks with the brick material's
4.4 MPa fatal tensile strength. This experiment assigns only masonry-to-masonry
bonds a separate mortar material (0.3 MPa fatal tension, 0.5 MPa fatal shear,
16 MPa fatal compression, 1 GPa elastic modulus). It does not change node mass,
geometry, contacts, foundations, gravity, solver settings, or acceptance gates.
These are candidate authoring values, not measured real-world material data.

Run from the kit directory:

```sh
node repros/civic-masonry/build.mjs
TOWN_KIT_COMPACT_GPU=1 node scripts/review.mjs cinema-mortar-review wall
```

The current script exports a **separate** candidate with three impact columns,
three heights and two rounds per point. The low rounds have a 0.26 m radius at
0.50 m height to clear the 0.18 m slab; the original low case had less floor
clearance than its round radius. Impacts cover the width of a prospective breach.
This is a geometry-based correction to the test, not proof that the original
rounds hit the floor. The intended opening must still admit the actual capsule,
retain 2.1 m headroom, and return to genuine converged physical rest.

Observed iterations, preserved in ordinary review history:

| Case | Result |
| --- | --- |
| Original six impacts, 2,000,000 Ns | Intact rest passed; breakup hit PhysX CUDA error 700 / fetchResults failure |
| Original six impacts, 200,000 Ns | Intact rest passed; no bonds broke |
| Original six impacts, 700,000 Ns | 121 bonds broke and debris settled; actual capsule remained blocked |
| Current 18 impacts, 700,000 Ns, 0.26 m radius | Detailed cinema intact rest passed; 383 bonds broke; debris did not settle within the gate |

All four candidates failed the complete wall gate. None is a release pass or a
change to the default cinema/town. Stronger destruction may expose native solver
or contact behavior; these observations do not establish a root cause. Review
artifacts record asset hashes, SDK revision, hardware snapshot, settings, and
body/chunk motion. The GPU is shared, so wall-clock timings are not exclusive
benchmarks. No shared SDK changes or service restarts were made.
