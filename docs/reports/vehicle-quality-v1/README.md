# Vehicle quality v1 baseline — 2026-09-26

This is a **data-quality baseline**, not a runtime benchmark. No GPU or browser was
started for these measurements. The pre-existing native Vehicle2 tape was replayed
through shipping presentation and CPU/WASM static collision queries.

Eight receive schedules × three seeds × driver/observer = **48 quality verdicts**:
16 pass and 32 fail. Every case was run twice and its complete pose/correction and
packet evidence matched byte-for-byte. This validates repeatability on the current
runtime; it does not promise bitwise physics determinism across platforms.

Thirteen additional physical/functional scenario contracts remain **blocked on
native evidence**, including correct landings, two-car collisions and wheel loss.
Their detector logic is covered by analytic fault-injection tests; that does not
qualify the product's corresponding behavior.

Representative witnesses, seed 42:

| Case / role | Metric | Value | Limit | Witness tick |
| --- | --- | ---: | ---: | ---: |
| Clean / driver | Global position p95 | 0.082 m | 0.15 m | 602 |
| Clean / driver | Worst rolling second p95 | 0.255 m | 0.25 m | 578 |
| Mobile receive delay / driver | Position p95 | 0.269 m | 0.15 m | 601 |
| Mobile receive delay / driver | Extra visual displacement | 0.486 m/tick | 0.20 m/tick | 349 |
| Turning outage / driver | Maximum trajectory disagreement | 10.178 m | 0.50 m | 408 |
| Turning outage / observer | Extra visual displacement | 8.570 m/tick | 0.20 m/tick | 409 |

The clean case illustrates why the worst maneuver matters: a global p95 passes
while a braking segment misses its budget. The 48-tick outage illustrates graceful
recovery work, not a demand for unlimited speculation during disconnection.
Frequency metrics normalized to a minute use only this short 11.8-second evaluation
window; they are deterministic severity indicators, not statistically established
population rates. Inspect the actual counts/events and repeat longer captures for
release qualification.

`quality.json` pins the limits, reference/WASM hashes, proxy and individual results.
`provenance.json` identifies the candidate. The replay script regenerates the
per-case evidence filenames listed in the report; raw artifacts from this run are
in `/tmp/vehicle-quality-final/`. The replay has **receive-channel scope**; it cannot
measure how a different uplink would change server inputs or closed-loop impacts.

See [the qualification guide](../../vehicle-netcode-quality.md) for primary research,
measurement definitions, scenario contracts, limitations and the developer workflow.

Validation: 136 focused tests passed; client and qualification-tool TypeScript
checks passed. The strict qualification and evidence-scoring commands returned
failure for the known failing baseline, while comparison of the baseline with
itself passed without regressions.
