# Contact wrench qualification evidence

This candidate is **ineligible and not deployed**. Read
`qualification-decision.json` and
[the qualification report](../../../docs/contact-wrench-fidelity-2026-09-05.md).

## Artifact stages

- `candidate-v1-artifacts.json`: the pre-sign-correction prototype. All city
  integration, heavy, settling and ordering-audit captures here used it.
- `candidate-v2-artifacts.json`: final signed-moment source, native binaries,
  and compiled game binaries. Final native tests passed 32/35; the game was
  compiled only. No final-sign city runtime result is claimed.
- `native-artifacts.json`: hashes of all retained native/build logs. Failed
  prototypes remain alongside final output. The earlier broad graph
  qualification used an obsolete fitted residual and does not prove accuracy.
- `conditioning/physical-residual.log`: the corrected absolute-residual sweep.
  `conditioning/gpu-jacobi-residual.log`: the unsuccessful existing Jacobi trial.
- `conditioning/pcg-reference.*` and `amg-reference.*`: initial anchored-only
  CPU experiments. Their timings are not GPU estimates.
- `conditioning/multilevel-*.log`: the subsequent free/anchored reference in
  the solver repo, `demos/blast-stress-demo/tests/multilevel_reference.py`.
  Its source hash is in the v2 artifact record.

The six player reports are a separate committed campaign. None of these
prototype traces reaches the reports' 5–6k-awake population.

## Recover and reproduce

`raw-traces.tar.gz` contains all CSV and JSONL captures, unchanged.
`raw-traces-index.json` records their uncompressed sizes and SHA-256 hashes,
and the compressed archive hash. Every member was checked byte-for-byte
before its redundant uncompressed copy was removed. Extract in this directory
before using `summarize-audit.py` or `summarize-performance.py`:

```bash
tar -xzf raw-traces.tar.gz
python3 summarize-audit.py
python3 summarize-performance.py
```

The native exported graph is independently compressed at
`conditioning/single-building.json.gz`; `conditioning/graph.json` records its
uncompressed hash and export command. From the solver repository:

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  python3 demos/blast-stress-demo/tests/multilevel_reference.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  python3 demos/blast-stress-demo/tests/multilevel_reference.py \
  --graph ../vibe-land-4/bench-results/simulation-frontier/contact-wrench/conditioning/single-building.json.gz \
  --release --loads random
```

Omit `--release` to keep anchors. `--loads gravity` is the default. These
commands require NumPy/SciPy and do not use CUDA or change the city. The
original anchored-only scripts require the graph decompressed to JSON first.

The `qualify.py`, `profile.py`, and `run-*.py` files preserve historical GPU
commands/configuration. They assume this machine's checkout/SDK layout and
**do not stop the live city themselves**. GPU runs require the ownership-aware
exclusive wrapper, no players, and exact binary/environment restoration. Use a
new output directory for any later candidate. `run-deep.py` was prepared but
never run because the candidate failed the physical-convergence gate.
