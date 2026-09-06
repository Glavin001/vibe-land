# Native physical graph integration

The multilevel CUDA test now consumes native graph assembly and native load
projection, rather than using Python-prepared matrices as its computational
input. Its independent fixture remains the reference for operator, force,
moment and bond-response checks. This is **not yet the production city solver**.
The live city retains the qualified rooted-fragment release (`ed9c2ad`, solver
`646a0f41`, Direct GPU enabled).

## Implemented

Solver commit `79e2c9a0` adds `NvBlastExtStressGpuPhysicalGraph.{h,cpp}`. The API
accepts physical node positions, masses and scalar inertias, plus current live
bonds and their compliance column scales. It constructs the physical `B B^T`
operator and bond transpose in double precision, retaining original input-node
mapping and six output rows per input bond. Sparse blocks accumulate contributions
in input-bond order; only exactly zero coefficients are omitted.

It recomputes exact dynamic components and anchoring from current bonds. A shared
fixed support does not incorrectly couple two independent dynamic components.
Free-component rigid modes use mass, scalar inertia and orbital inertia through
the mass-scaled coordinates. Native load projection separates rigid acceleration
from internal load, including force couples and the internal angular sign.

Every dynamic node remains represented. An isolated node has six unconstrained
rigid degrees of freedom, so its rigid projector is exactly identity and its
internal load is exactly zero. This case retains all applied loads as rigid
acceleration without constructing or solving an unnecessary hierarchy. It is
not a force threshold, a body cap, a freeze rule, or a gravity approximation.

An optional fixed normalization keeps numerical coordinates unchanged across
fracture. Tests verify that removing bonds removes exactly their six-column
stiffness contributions and leaves the surviving operator unchanged. This is
an integration invariant, **not an implemented hierarchy cache/update policy**.
Component matrix extraction uses the retained local-index table, avoiding a
full-node-map allocation for every fragment.

## Independent validation

The final CPU oracle covers 12 configurations: a signed anchored lever, shared
fixed support, mixed anchored/free components, release and split transitions,
isolated bodies, free fall, zero loads, loads scaled by 1e30 and 1e-30, and
rotated/translated coordinates. Checks include sparse operator agreement,
absolute physical input loads, exact component membership, dense minimum-norm
solutions, and independently calculated Newton/Euler rigid acceleration.
Deliberately halved loads, wrong rigid acceleration, and halved stiffness are
rejected. Both registered CTests pass. The Python oracle needs NumPy/SciPy; it
is test tooling, not a game dependency.

The full-source anchored/free checks also pass. The historical "single-building"
export contains **96,420 original city nodes**; its bonds select one building.
The native representation correctly identifies **88,705 components**, mostly
isolated nodes. Separate component inputs retain **5,936 dynamic nodes**, plus
36 fixed nodes in the anchored input, and preserve the full-source normalization.
These stress-node counts are not counts of awake PhysX bodies.

All **16** native-input CUDA solves pass; a deliberately incomplete one-iteration
solve fails. AddressSanitizer/UndefinedBehaviorSanitizer pass the native building
assembly, and CUDA Compute Sanitizer reports zero errors and zero leaked bytes
for the native free-building solve. The numerical kernels are unchanged; their
operator, basis and load inputs now come from the native graph path.

| Fixture / preconditioner | Iterations | Warm CUDA solve | Force / moment residual |
| --- | ---: | ---: | ---: |
| Anchored / float | 34 | 5.878 ms | 1.41e-11 / 1.69e-11 |
| Free / float | 31 | 6.284 ms | 9.01e-12 / 1.13e-11 |
| Anchored / double | 34 | 10.656 ms | 1.41e-11 / 1.70e-11 |
| Free / double | 31 | 10.639 ms | 9.00e-12 / 1.13e-11 |

Times are medians of the last three of four identical-input solves per process
on the RTX 4090, excluding setup/upload. Each solve starts from zero; "warm"
means allocated device state and graph, not a reused converged solution.
Native component operator assembly takes **32–37 ms**, and hierarchy construction
another **201–206 ms**, in these exclusive windows. File parsing, load projection,
CUDA initialization/upload and graph capture are separate. Repeating all this
setup on each fracture is not acceptable for the target real-time simulation.
No city/full-tick speedup is claimed from these measurements.

## Next production steps

1. Keep node/bond coupling and solve state resident; update exact live-bond
   membership and rigid components after fracture, without rebuilding all setup
   on every tick. Isolated components need no iterative internal-stress work.
2. Qualify hierarchy reuse/update against the **current** physical operator,
   including newly free rigid modes, stale-label negative controls, and damage
   sequences. A preconditioner may approximate; physical forces/topology may not.
3. Integrate the component solves into the production damage and same-tick
   replay path. Re-run physical quality, near-threshold fracture, settling and
   full streamed-server tests at the reports' 5–6k-awake-body load before release.

The existing physical-quality failures and GPU contact-ordering hold remain
open. This work does not change constitutive modeling, scalar inertia, contact
filters, the inherited bending/excess-force behavior, replay completeness,
moving-body bootstrap correctness, or stale drawn chunks.

## Reproduction and deployment state

From the solver checkout, configure the existing GPU-activity build and build
`physical_graph_test` and `multilevel_gpu_test`. Run the two CPU CTests with
`ctest --test-dir demos/blast-stress-demo/build-gpu-activity -R blast_stress_physical_graph --output-on-failure`.
Run `tests/physical_graph_reference.py` with `--binary`, `--out`, and optional
`--building` pointing to the retained conditioning graph. The input files for
CUDA `--native-graph` are the generated `building-*-component.input` files.
Use the existing scoped exclusive-GPU wrapper before executing CUDA commands.

Evidence, source/binary hashes, commands and input hashes are under
`bench-results/simulation-frontier/physical-graph/`. Large generated matrices
remain in `/tmp/physical-graph-final`; they are reproducible from the committed
conditioning graph and test script. The large reference run preceded the last
additional small-oracle negative controls; both logs are retained separately.

The final restoration check confirms the unchanged city binary SHA-256
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`, Direct GPU
on, GPU contact ordering unset/off, 32 solver iterations, one replay pass,
freeze enabled, and the same grid-2 fractured-downtown scene. No new runtime
build was deployed in this increment. Commits remain local; the earlier
private-source push approval rejection has not been bypassed or retried.
