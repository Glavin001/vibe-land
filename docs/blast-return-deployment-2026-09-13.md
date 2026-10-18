# Blast-based city deployment — 2026-09-13

Deployed and verified: [https://209.121.195.117:40613/city](https://209.121.195.117:40613/city). Use Chrome or Edge and accept the self-signed HTTPS certificate warning.

## Sources and runtime

- Game: `vibe-land-4`, `codex/simulation-frontier`, `b72d3e5c271cb2160dc7a7c6deb951b64a2c1b9b` plus preserved local changes and the two fixes below.
- Solver: `blast-stress-solver-2`, `codex/simulation-frontier`, `7c09837e7bea87099e85cccf81150f7811aa8346` plus preserved local authoring changes.
- Rust and native Blast sources both resolve to `blast-stress-solver-2/blast`.
- PhysX SDK/runtime: `/root/PhysX/physx/install/linux-clang/PhysX`. Runtime library mappings were inspected: **no `physx-2` integration or runtime is used**.
- Preserved saved scene/settings: `minas-tirith-rebuilt.json`, grid 1, 32 solver iterations, one fracture replay, existing shot/material settings and Direct GPU disabled. Compact contacts and experimental GPU contact ordering remain off.
- Server binary SHA-256: `41c7906de1d7135bdb5adfb33885c375257b3f8ad836255fc82b5e46acd39df9`.
- Deployment time: `2026-09-13T02:33:56.926136+00:00`.

## Required deployment fixes

1. Removed the external Vibe Jam widget from `client/index.html`: its redirected JavaScript raised a syntax error during browser validation.
2. Added `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to the native HTTPS listener, matching the previous Caddy configuration. This covers both the SPA and API responses.

The deployment preserved physics algorithms, scene assets, shot settings, existing branches, and pre-existing local edits. The subsequent documentation follow-up records these two fixes and the deployment lessons on `codex/blast-return-deployment`; unrelated local work remains uncommitted. No push was performed.

## Validation

- Server/client builds and client type check passed.
- 120 destruction tests passed, including authored scene validation, binary manifest round trips, rooted-fragment wire behavior, and Minas Tirith standing/shot response; 2 existing fixture/measurement tests remained ignored.
- 19 PhysX bridge tests passed: fracture/raycast, freeze/wake, GPU smoke, and velocity fidelity.
- 139 client control/city tests passed.
- Isolated test of the final executable: native HTTPS headers and browser isolation passed; all 64,734 chunks rendered; player moved 11.20 m; client observed 366 broken bonds after shots; reset returned to 0 broken bonds; reconnect loaded all chunks. No JavaScript errors, orphaned chunks, hash mismatches, topology gaps, settle rejects, or repair requests.
- Live executable hash matches the isolated candidate. Public HTTPS and local browser WebTransport checks passed, rendering all 64,734 chunks.
- Original tracked and untracked local edits were checked against the saved copies and preserved byte-for-byte.

The browser reports 249 below-ground chunk centroids at baseline (minimum Y −0.65 m). The deployed authored manifest itself includes below-ground geometry; this task did not change or qualify that geometry. These checks establish functional play and deployment, not a frame-rate or long-duration performance guarantee. External UDP reachability is **not verified**; the local browser preserves the advertised path/certificate but rewrites host/port to bypass NAT hairpin.

## Reusable lessons

See [City deployment lessons](city-deployment-lessons.md) for source/runtime provenance, fresh validation receipts, native HTTPS headers, browser error diagnosis, and complete rollback checks.

## Evidence and rollback

The following evidence is retained on the deployment host and is not committed. The private local receipt is [receipt.json](../.certs/vast-city/blast-return-20260913/receipt.json); [gameplay results](../.certs/vast-city/blast-return-20260913/gameplay.json) and [test results](../.certs/vast-city/blast-return-20260913/test-results.json) record the gates. Logs and replayable validation scripts are retained in the same directory.

The previous executable, client bundle, deployment settings and certificate were archived there before building. The first promotion was rolled back when missing HTTPS headers were detected. The final corrected build passed. The repository's `scripts/vast-city.py` helper owns the running deployment and supervisor; use its scoped deployment/rollback mechanisms rather than broad process termination. Environment and key backups contain private data and must remain local.
