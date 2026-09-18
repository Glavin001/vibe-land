---
name: vastai-deploy
description: Deploy and verify /city from the current checkout on an existing Vast.ai instance; discover public mappings, reuse current builds, renew TLS, and check WebTransport. Also covers renting and diagnosing fleet instances when requested.
---

# Deploy /city on the Vast instance you are already inside

Start here. Do not rent a box, switch branches, run Docker, or use `vibe-up`
(which can clone/switch refs) when the user supplied existing checkouts.

From the vibe-land checkout:

```bash
python3 scripts/vast-city.py status
python3 scripts/vast-city.py up --browser --public
```

`status` discovers this checkout's server, Caddy, PID-1 public IP and mapped
ports in one call. `up` builds against the sibling `blast-stress-solver-2/blast`
(or `--blast-root /path/to/blast`), preserves the running scene/settings,
renews a 12-day P-256 certificate, and starts only this deployment. It refuses
ambiguous ownership and a restart while players are connected. Builds finish
before that refusal; retry when empty. It never invokes broad `pkill`. It recognizes the checkout-owned legacy
`run-vl4-server.sh` loop and replaces it with its own scoped supervisor, so
resets and unexpected exits restart the current deployed binary.

Server/client builds run concurrently. Successful source-content fingerprints
include dirty files, the Blast tree, build configuration and toolchain versions.
Unchanged builds are skipped. Cargo builds only the server binary. `npm ci`
runs only when the lockfile changed or dependencies are missing. `--rebuild`
forces both builds. First use has no cached provenance, so it builds once.

If the user only wants the existing link checked, use:

```bash
python3 scripts/vast-city.py verify --browser --public
```

This does not rebuild or restart. Do not rebuild merely because a bundle is
older than a documentation commit. Read `.certs/vast-city/verification.json`
for the result; logs and private deployment state live alongside it (gitignored).
The client builds into a staging directory and publishes after the server
deployment succeeds, retaining old hashed assets for open tabs. A build failure
leaves the current server running. A failed new server startup
attempts to restore the previous binary. A proxy failure is reported separately.

## What verification actually proves

- Default verification checks GPU health, SPA/isolation headers, advertised
  public endpoint, certificate dates/SAN/P-256/hash, and decompressed VLCM
  manifest bytes. HTTP 200 alone is insufficient.
- `--browser` adds a disposable 480×270 FAST-profile Chromium connection and
  requires WebTransport, a bootstrap, rendered chunks, and no missing chunks,
  ledger hash mismatches or JavaScript errors. It does not fire or change public
  settings. Overall deadline: 85 seconds. This is functional verification, not
  visual-quality or performance certification.
- `--public` asks r.jina.ai to fetch the public health URL. Failure is
  **inconclusive**, since the external fetcher can fail independently. Its success
  proves public HTTPS, not UDP.
- Local Chromium rewrites only the advertised host/port to bypass NAT hairpin;
  it preserves the path and certificate hash. `udp_verified` from this test is
  **not external UDP proof**. Report that limit unless a remote browser has
  actually connected. Do not label public UDP working on loopback evidence.

Return the printed public `/city` link as soon as these checks complete. Mention
Chrome/Edge and the self-signed warning. Do not add an expensive screenshot,
PRETTY render, demolition benchmark or full test suite to this fast path unless
requested or needed to investigate a failure. A cached unchanged deployment
should need only the helper invocation and its result.

## When the fast path cannot apply

The helper needs Linux `/proc`, mapped TCP+UDP ports, Python 3.11+, curl-independent
HTTPS access, OpenSSL, the repo's Rust/Node/PhysX toolchains, and installed
Playwright Chromium for `--browser`. It uses an existing Caddy proxy when found;
fresh deployments use the server's native HTTPS listener on a free mapped port.
It does not install system tools, alter port mappings, or replace other checkouts.

For an ambiguous/missing mapping or failed browser test, read the single named
log first. For side-by-side layouts, unusual Caddy configs and manual diagnostic
commands, read [city-stack-run](../city-stack-run/SKILL.md).

For **renting, templates, SSH boot, Docker images or fleet teardown**, read
[the fleet/manual reference](references/fleet-and-manual.md). It retains the
historical troubleshooting detail; do not load it for ordinary in-place deploys.
