# Wire v3 live-stack acceptance (C4)

2026-08-20. The debris codec running as the city's live pose wire, measured in
a real browser against a real server. Everything below is
`npm run netlab -- run --scenario city-demolition-v3 --stack dev` (grid 2,
`VIBE_CITY_STRESS_LIMIT_SCALE=0.10`, 90 s demolition drive, ~3k chunks, ~2.7k
peak awake bodies) unless labeled otherwise.

## Where it landed

Clean network, final run of the series: **0 fails**.

| metric | value | gate | note |
|---|---:|---|---|
| cityPeakMbps | 1.9–2.4 | ≤4 warn / ≤6 fail | v2 same scenario: ~2.5 |
| citySettledMbps | 0.01–0.40 | ≤0.1 warn / ≤0.5 fail | was **1.82 FAIL** before pose-anchored park |
| cityChunkTeleportsPerMin | 10–13 (warn) | ≤5 / ≤30 | was **1,929 FAIL** at series start |
| cityTopoSeqGaps / cityOrphanedChunks | 0 / 0 | 1 / 1 | |
| microReversalPct | 0.0–0.5 | ≤0.5 / ≤2.0 | |
| cityChunkUpdateP95MaxMs | 3.1–3.7 | ≤4 / ≤8 | |
| resync differential | 0–1 divergent chunks | — | end-state ledger vs server |
| span encode cost (`v3_span_encode_cost`, release) | p50 3.4 / p95 7.8 ms | p50≤5 / p95≤8 | earlier C4 gate |

E2E: `city-destruction-v3.spec.ts` **passes** in a real Chrome against a
`VIBE_CITY_WIRE=3` server — proves wireVersion 3 on the live stats bridge,
fracture raises brokenBonds, islands stay live, ledger gapless, zero orphans,
datagrams flowing. Run recipe (the spec had never actually been executed
before this; it also fired 9,000 shots — now 24):

```
# server
VIBE_CITY_WIRE=3 WT_HOST=127.0.0.1 VIBE_CITY_STRESS_LIMIT_SCALE=0.10 \
  LD_LIBRARY_PATH=$PHYSX_LIBS ./target/release/web-fps-server
# client
CLIENT_PORT=5555 npm run dev
# spec
DISPLAY=:99 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/google/chrome/chrome \
  E2E_SKIP_WEB_SERVER=1 E2E_CITY=1 E2E_CITY_WIRE=3 \
  E2E_CITY_URL_PARAMS='portal=true&match=cityv3-e2e' \
  npx playwright test --config e2e/playwright.config.ts city-destruction-v3
```

`E2E_CITY_URL_PARAMS` exists because plain `/city` joins through matchmaking,
which a locally-started stack does not run; portal mode is how netlab joins.
Playwright's bundled Chromium never completed the WebTransport handshake here
— real Chrome (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) does. The server must
announce `WT_HOST=127.0.0.1`, not `localhost` (IPv6 resolution vs an
IPv4-only bind reads as an infinite "connecting").

## What the campaign found and fixed (chronological)

Every defect below was found by instrumenting, not guessing: teleport events
carry the ledger pose source, and the wasm decoder keeps a ring of the last 8
applied records per lane, dumped into every jump event.

1. **Runs 2–3 measured a stale server.** The netlab dev stack reused a server
   process from a previous run, so two "fix verification" runs never ran the
   fix. Symptom in the artifacts: `serverBuild` timestamp older than the fix.
   Kill leftover listeners on :4051/:5599 before trusting a rerun.
2. **Velocity-based modelled sleep cannot park a pile** (settled 1.82 Mbps).
   PhysX never sleeps large contact piles — 2,283 bodies still "active" at
   settle time with 9,026 re-settle wakes, velocities fluttering above any
   threshold while poses go nowhere. Quiet is now also earned by pose: staying
   inside the rest shell of an anchor pose for the whole window parks the body
   (`debris_codec` sleep block; offline paths byte-inert, tripwire 13,814,930
   unchanged). Settled traffic: 1.82 → 0.01 Mbps.
3. **Compose-basis skew** (1,798 of 1,895 teleports): topology applied on
   arrival while sampled poses run at renderTick−6, so a migration's new
   membership/COM composed 100 ms of old-basis poses. v3 now holds topology
   in a queue drained when the sample clock reaches each message's tick
   (1 s wall-clock valve). v2 path untouched.
4. **Intra-span lane reuse**: `remove_body` freed a lane the same span it
   still held the departing tenant's frames; a wake-churn `add_body` could
   reclaim it and one lane id carried two bodies' records (20–50 m
   out-and-back teleports, proven by the record histories). Freed lanes now
   quarantine until `finalize_span` drains them.
5. **Reassignment race**: a recycled lane's new tenant emits records one span
   after the reliable lane map is staged; datagrams win under load. No chunk
   moves 5 m between spans, so the client treats a >5 m in-lane discontinuity
   as a reassignment marker and holds the lane 12 ticks or until the map
   lands. Plus per-lane latest-wins in the wasm decoder (reordered datagrams
   yanked bodies back a span).
6. **Loss made lane maps unhealable**: an incremental PKT_CITY_LANES entry
   that never arrives strands every record its lane carries. The server now
   sends the full lane map beside every bootstrap (join and resync), so the
   map heals through the same path topology does. Also: the client dropped
   held topology at bootstrap — messages newer than the bootstrap arrived
   reliably and are never resent, which manufactured a permanent seq gap and
   a resync loop; the queue now keeps them.

## Impairment (in-proc mode, which drops packets AFTER QUIC delivery —
## including "reliable" ones — so it is harsher than any real network)

| metric | v2 wifi-bad | v3 wifi-bad | v2 lte | v3 lte |
|---|---:|---:|---:|---:|
| fails | **6** | 4 | **5** | 3 |
| cityPeakMbps | **6.25 FAIL** | 3.78 | 2.72 | 3.34 |
| topo seq gaps | 529 | 259 | 641 | 187 |
| chunks below ground | 167 | 108 | 89 | 10 |
| teleports/min | 584 | 852 | 256 | **2,053** |
| end-state divergence (chunks) | 2,793 | **599** | 2,917 | **225** |
| settled Mbps | 0.00 | 0.01 | 0.00 | 0.01 |

Verdict: v3 degrades less than v2 on nearly every axis and its end-state
divergence is 5–13× smaller. The honest exception is teleports under high
RTT: the lane-reassignment race scales with latency and v2 has no lane
indirection. If lte-grade links matter before the next wire rev, the fix is a
lane generation tag (1 byte per packet) so a record can never be applied
under a stale mapping; the client-side hold is the mitigation until then.

Note on the model: gaps in the hundreds appear for BOTH wires only because
in-proc impairment drops post-QUIC reliable packets, which real transport
retransmits. The netem mode is the fair loss test; it needs root.

## Residual warns, named

- **Teleports 10–13/min**: reassignment-race residue during wake-churn;
  bounded at ≤12 ticks of hold each. Perceptually: occasional small pops in
  the rubble field, no wrong-body trajectories.
- **Below-ground 1–7**: physics verdict (islands hovering/pushed under),
  present in v2 runs of the same content.
- **citySettledMbps up to 0.40** on runs whose demolition ends late: the
  final pile is still parking when the settle window is sampled.

## Perceptual sign-off

**User verdict on the first render: both wire legs looked bad** (vanishing
chunks, teleporting) while the browser measured clean — both true. The
video's v2/v3 panes are Rust client models in `record_city_trace`, and they
still had the pre-fix behavior: topology applied on arrival against poses
sampled 6 ticks back (the compose-basis skew), and membership pointing at
bodies whose streams start a span later (rendered as missing chunks). The
models now hold topology until the presented clock reaches it (r2 render:
`viewer-videos/v3-final-r2-2026-08-20/`). Remaining instrument gap: the
models lack the client's lane-hold/nack machinery, so occasional islands
still freeze mid-air after migrations — the video overstates staleness
relative to the shipping client. The next instrument is the real thing:
record the browser (Playwright video capture) during a netlab run, beside a
truth render from the same match.

### Single-source resolution (final)

Per user directive, the stand-in models are superseded: the sign-off leg is
now generated by the SHIPPING client. `record-city-trace --packets-out`
dumps the exact client-bound bytes; `client/tools/replay-city-client.mts`
feeds them through the browser's own `CityClient` + wasm decoder under a
deterministic clock and writes the displayed poses as a towerstate. Full run
(grid 2, 45 s, 9,738 broken bonds): 1,350/1,350 frames, wireVersion 3, 0
topo gaps, 0 orphans, brokenBonds == truth exactly; mid-collapse frames
track truth pane-for-pane at the interpolation delay. Published:
`viewer-videos/v3-real-client-2026-08-20/compare-real.mp4` (truth | real
client). The live browser capture from the same day is
`viewer-videos/v3-browser-2026-08-20/client0-browser.mp4`
(`NETLAB_RECORD_VIDEO=1`). A fix in `cityClient.ts` now propagates to the
harness by construction.


Fresh three-way rendered AFTER all campaign fixes, from one GPU run
(grid 2, stress scale 0.10, 45 s, 40 shots × 3 targets: 10,002 broken bonds,
2,536 peak bodies, membership mismatches 0):
`viewer-videos/v3-final-2026-08-20/{truth,v2,v3,compare-3way}.mp4`, public at
`http://209.121.195.117:40616/viewer-videos/v3-final-2026-08-20/` (user
`viewer`, password in `recordings-server/password.txt`). Earlier C2 renders
remain at `viewer-videos/v3-live-2026-08-20/`. Regenerate:

```
VIBE_CITY_STRESS_LIMIT_SCALE=0.10 LD_LIBRARY_PATH=$PHYSX_LIBS \
  ./target/release/record-city-trace --grid 2 --hz 60 --seconds 45 \
  --settle-ticks 60 --shots 40 --targets 3 \
  --output truth.towertrace --v2-view v2.towerstate --v3-view v3.towerstate
./target/release/destruction-codec replay --trace truth.towertrace --output truth.towerstate
tower-demo render --state <each>.towerstate --output <each>.mp4   # + ffmpeg hstack
```

## State of the branch

All work is on `feat/blast-destruction-codec` in vibe-land-2. Upstream
(`origin/feat/auto-scale-deploys`) has 18 newer commits including a
chunk-id-overflow fix, a two-poses-at-once render fix on the v2 path, and the
dense-downtown content + scenarios — merge next, then re-run this scenario
plus the district scenario at that scale.
