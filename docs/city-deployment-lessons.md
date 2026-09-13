# City deployment lessons

These practices come from the [September 13 Blast deployment](blast-return-deployment-2026-09-13.md). They apply to an existing checkout on a Vast host; historical URLs, branch tips, and process IDs are evidence, not current configuration.

## Identify the actual sources and destination

- Folder suffixes are checkout names, not solver versions. Compare Git ancestry, revisions, local changes, and dependency paths before choosing a game/solver pair. A newer game branch may implement a different physics integration.
- For the original Blast integration, align the Rust dependency in `destruction/Cargo.toml` with the native `BLAST_ROOT`. Inspect both the shell environment and saved deployment environment: a launcher can merge saved settings over explicit shell overrides.
- Select the PhysX SDK headers, static libraries, and loaded GPU module consistently. A successful build does not establish runtime library provenance. Inspect the serving process's library mappings and executable hash. Returning to Blast does not mean removing the original PhysX rigid-body backend.
- Discover the checkout-owned deployment using its deployment helper before relying on old documentation. If no server is running, inspect the saved scene, settings, and mapped ports before choosing defaults. The September 13 saved deployment was Minas Tirith on a different endpoint from the older downtown reports.
- Preserve existing tracked and untracked work. Record revisions plus source-content fingerprints, local changes, build configuration, and artifact hashes; a commit SHA alone cannot identify a dirty build. Keep environment/key backups private and out of Git.

## Qualify the exact candidate

Build and test before promotion. When isolated gameplay qualification is required, use unused loopback-only HTTP, HTTPS, and UDP ports and the intended deployment scene/settings. Check that the GPU is available. Pause a checkout-owned public server only after confirming it has no players; preserve a recovery path and never terminate unrelated processes.

Every validation attempt needs a fresh output directory or run identifier. Mark it incomplete at startup and bind its final result to the candidate executable hash and client fingerprint. Wait for the runner to exit successfully before reading a passing receipt. A previous run's `ok: true` file can survive until the new run writes its first event; neither that stale file nor a partial phase list authorizes promotion.

A gameplay gate should demonstrate all of the following:

- HTTPS response headers and `window.crossOriginIsolated`, then a real WebTransport join, bootstrap, and rendered chunks.
- Actual player displacement from input, not camera movement alone.
- Shots reaching the scene and fresh client evidence of broken bonds, not just an increasing shots-fired counter.
- Reset producing a fresh bootstrap and restored geometry, followed by a separate reconnect that receives all expected chunks.
- No JavaScript errors, orphaned chunks, topology sequence gaps, hash mismatches, or unexpected repair requests.

Use the binary manifest decoder for geometry/target selection. Derive shot targets from the current manifest rather than hardcoded coordinates or a different scene. Compare geometric diagnostics with authored geometry and their measurement thresholds before attributing below-ground coordinates to a simulation bug. Functional checks do not establish sustained frame rate, heavy-load performance, or endurance.

Closed test listeners may leave sockets in TIME_WAIT. If a bind probe refuses a recently used port, inspect listener ownership and choose another unused private port; do not kill an unrelated process to force reuse.

## Diagnose browser failures at their source

Capture the error's script URL and location, including redirect destinations. In this deployment, the external Vibe Jam widget raised a syntax error even though the game loaded and connected. Removing that broken optional script repaired the page. Do not filter out page errors to make the gate pass.

The standalone HTTPS listener must supply the same isolation headers as the reverse-proxy deployment:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Apply them after attaching the SPA/static-file fallback so that the document, assets, and API responses receive them. Verify both response headers and browser isolation. Successful rendering alone did not catch the missing native-listener headers in the first gameplay check.

## Promotion, rollback, and reporting

Before promotion, retain the previous executable, frontend, configuration, and certificate; confirm the target and player count again. Promote only the qualified artifact, then compare its hash with `/proc/<serving-pid>/exe` and confirm the loaded GPU module.

Verification must cover the live deployment, not just the private candidate. If startup, routing, headers, manifest, or browser checks fail, restore the previous executable and client with their matching settings. Check which failures the helper actually handles: the local helper used on September 13 rolled back startup failures, while the promotion wrapper explicitly added rollback for later verification failures. Do not assume the `up` command rolls back every failure.

For local WebTransport checks, rewrite only the advertised host and port to bypass NAT hairpin; retain the path and certificate pin. A localhost connection or an increased server connection counter is not evidence of external UDP reachability. Report public HTTPS and external UDP separately, and treat a third-party fetcher's failure as inconclusive unless other evidence establishes a deployment failure.

Commit source fixes and reusable documentation separately from private deployment receipts, keys, environment files, executables, and unrelated local work. If branch creation/committing is explicitly requested after deployment, it does not require restarting the immutable running artifact. Preserve the deployed source revision and dirty-source provenance in the historical report even when the checkout later moves to a documentation branch.
