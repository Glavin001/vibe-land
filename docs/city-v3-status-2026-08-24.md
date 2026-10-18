# Wire v3 status: built, measured, and NOT live

2026-08-24. Read this before `docs/city-v3-protocol-2026-08.md`. That
document is the protocol record and its offline numbers still stand; this
one says where v3 actually is, which is **rolled back on the live wire**.
The two were written three days apart and the gap between them is the
whole point of this file.

## State in one line

v3 is fully integrated into the shipping app -- server encoder, browser
wasm decoder, real WebTransport path, one implementation, no research
fork -- and the **live default is wire v2** (`CITY_WIRE_VERSION = 2`,
`destruction/src/wire.rs`). Any match id prefixed `cityv3-` negotiates v3
beside the fleet on v2; that per-match switch is how the rollback was
performed, and it is how v3 gets tried without a deploy.

## Why it was rolled back (2026-08-24, `a5a36e5`)

A visible flicker in play was pinned to the wire itself. Same collapse,
same spec, only the wire changed:

| | wire v3 | wire v2 |
|---|---:|---:|
| worst jump | **75.40 m** | 1.16 m |
| drawn off (worst) | 39.42 m | 1.36 m |
| bad frames | 181 / 894 | 62 / 900 |
| jump frames | 93 | 12 |
| bonds broken | 1,283 | **1,712** |

The last row is the one that forbids explaining this away: v2 did *more*
damage and still stayed clean. Rollback was `VIBE_CITY_WIRE` unset --
exactly what per-match wire selection exists for.

**This is not a contradiction of the protocol record.** Those offline
numbers were produced by the recorder + replayer pipeline, which is honest
about what it covers (packets in, ledger out) and blind to what it does
not: it drives the ledger, not the browser's render path, and it holds a
healthy 60 Hz throughout. Every defect below lived in exactly that blind
spot. The lesson is about instrument coverage, not about the codec's
arithmetic.

## What has been found and fixed since the rollback

Four defects, all v3-only, all in the live path rather than the codec:

1. **Settled bodies overwritten by parked lanes** (`6db097b`/`8c6409d`).
   A settled body is owned by the reliable channel, which carries the
   authoritative rest pose. The v2 record path has always dropped records
   at or before a body's settle tick; the v3 sampling path had no such
   guard, and a parked lane stays samplable indefinitely BY DESIGN, so
   every frame after a settle the sampled pose overwrote the settled one
   and the reliable message put it back. Measured `settleRejects` 118 on
   v3 vs **0** on v2, worst displacement 151 m vs 2.4 m. This is the
   leading candidate for the flicker itself.
2. **RESET CITY silently froze the client's world** (`08a3482`). A reset
   rebuilds the server encoder, restarting the reliable topology sequence
   at zero, while the client still held the destroyed world's sequence
   (75). W2's topology hold-back queue compared sequence numbers *across*
   that rebuild, kept 75 stale messages, and dragged `lastTopoSeq` back
   up; every message of the fresh world then hit duplicate-suppression,
   which returns silently. Symptom: the city renders intact and no shot
   ever changes it again, while the server logs the damage landing
   (2,314 bonds, `hits=1`). Only bites after heavy damage (high pre-reset
   seq), which is why light-damage resets looked fine.
3. **Client render clock assumed 60 Hz** (`e402c26`). The clock
   extrapolated the newest sim tick at a hardcoded 60 ticks/s while the
   server sheds rate under load (60 -> 20 Hz), so it ran 2-3x ahead
   between spans and was yanked back ~7-10 ticks per re-anchor: a ~4 Hz
   sawtooth, sampling flying debris back and forth along its own
   trajectory. This is the "rubber banding" from live play. It now
   measures the tick rate and follows a damped anchor. Invisible to every
   acceptance leg by construction, since those all hold 60 Hz.
4. **Full-world resyncs unthrottled** (`689d97e`). A migration naming an
   unknown island sets `needsResync`, and each resync is a complete
   ledger rebuild (every body, every lane, 24k chunks repainted). Faults
   arrive in streams during a collapse (22 in one building), so the
   client rebuilt the world 65 times where the expected count is 1. Now
   spaced >= 3 s; one bootstrap repairs every outstanding fault at once.

Two related reset hazards were fixed with (2): the client kept its
lane->entity maps and the decoder's per-lane state across a bootstrap
though the rebuilt server restarts lane ids AND the lane epoch
(`reset_all_lanes()` added); and the server's reset path never sent the
lane map or a restate, unlike join and resync.

## The gate: `scripts/city-wire-ab.sh`

Restarts the server on each wire, drives the same scripted collapse, and
prints both results side by side. **Every column must be at least as good
as v2's before v3 goes back on live.** "v3 is as good as v2" is a command
and a table, not an argument.

```
scripts/city-wire-ab.sh          # v2 then v3, one run each
RUNS=3 scripts/city-wire-ab.sh   # variance is real
```

## What is NOT yet established

**The A/B has not been re-run since the four fixes landed.** Nobody has
shown v3 clears the v2 gate. The fixes each carry their own measurement,
and the settle guard plausibly explains the flicker, but "plausibly
explains" is not the gate. Running it is the next action for anyone
picking this up, and it is one command.

Also open: the browser-path legs of the rigor matrix (impairment, late
join) remain blocked on task #23, and the perceptual sign-offs
(small-rubble tier, 250 ms governed-flush feel) still need user video
judgment.

## The instrument that found most of this

The panel's AGREEMENT section (`11f1e7f`) exists because every row in it
was missing while a bug hid behind its absence:

- **wire cli/srv** -- client and server choose the wire independently
  (server per match, client from session config), and a mismatch is
  invisible in play *by design*: the client discards the other wire's
  pose records, so the city silently stops being destroyed on screen
  while the server keeps fracturing -- no error, no gap, no dropped
  packet.
- **bonds cli/srv** -- does this client's ledger agree with the
  simulation? Server climbing while the client sits at zero is exactly
  "my shots do nothing" (defect 2 above), and it previously took
  server-side log archaeology to see.

The standing lesson from this week: **defects that live between the
server and the drawn frame are invisible to a pipeline that stops at the
ledger.** Offline gates prove the codec; only the browser, the panel, and
the A/B prove the wire.
