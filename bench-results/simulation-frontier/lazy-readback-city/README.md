# Paired lazy-readback demolition measurements

Six complete grid-2 trials, one frozen binary, eager/lazy observation, alternating
arm order. Each trial contains 2,700 ticks and 450 shots at production settings.
The frozen executable and uncompressed CSVs remain local and are not committed.
CSV SHA-256 hashes and deterministic gzip copies preserve all measurement rows.

Run `python3 summarize-raw.py` followed by `python3 standardize.py` from this
directory to reproduce the summaries from the compressed data. The scripts also
accept the artifact directory as their first argument. Standardization uses
500-body awake bands and replay/non-replay classes, requiring at least 20
samples of a class in every trial. Only the 4,500–5,000-awake classes meet that
criterion. This is a descriptive matched comparison, not randomized causal
identification. One matched trial has just 56 samples; p99 is weak evidence.

`run-campaign.py` and `scoped-test-wrapper.py` record the exact commands used;
they retain this workspace's paths. They are not portable deployment tooling.
The wrapper pauses only the idle, checkout-owned server and restores it after
each trial. `physics-env.sh` records the shared settings; the runtime environment
sample confirms them in a running eager arm. The manifest was captured before
the source changes were committed as dependency `cdf6c3ed` and game `02b73a9`.

See `docs/gpu-lazy-readback-2026-09-05.md` in the game repository for interpretation
and the outstanding fidelity and deployment gates.
