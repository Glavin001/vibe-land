# Independent city datagrams and ordered reliable delivery

The September 6 player reports recorded a startup queue overflow: 565 outbound
packet drops, including reliable city state. One task awaited reliable writes
before submitting further datagrams, and both delivery types occupied the same
256-packet queue. The report's 273 energy warnings include retries of a value
that could not be admitted; they do not establish 273 unique energy changes.

The server now maintains separate bounded queues for ordered reliable state and
recoverable datagrams. The WebTransport writer polls both paths concurrently,
so a stalled reliable stream does not block datagram submission. Oversized
recoverable packets use a third, separate fallback queue: they cannot consume
capacity reserved for reliable state. The single stream writer prioritizes
queued reliable state, preserves its FIFO order, and completes each length
prefix and body before writing the next frame. Framing no longer copies the
whole packet into a second buffer.

A datagram queue overflow keeps the existing recoverable-drop behavior. A true
reliable-state queue overflow marks the session failed, interrupts a pending
write, rejects subsequent packets and closes the affected connection. A client
cannot continue indefinitely with an admitted reliable stream containing an
unreported hole. This is per-connection backpressure behavior; the authoritative
simulation never waits on a network write, and no physics interaction, force,
velocity, contact, fracture or bond limit changes.

WebSocket still serializes both queues onto its single ordered connection.
Reliable frames preserve FIFO order; recoverable snapshots can interleave. If
its reader or writer ends, the peer task is aborted and the match receives a
disconnect event. Previously a failed writer could leave the reader and player
alive indefinitely. Packet formats and client assets do not change.

## Tests

The release server's outbound tests cover:

- A deliberately blocked one-byte reliable stream while datagrams progress;
  resuming reads yields exact frame bytes in the original reliable order.
- Datagram pressure cannot evict reliable state.
- Recoverable fallback pressure cannot displace or fail reliable state.
- Reliable overflow wakes a blocked writer and rejects future submissions.
- WebSocket queue draining preserves reliable order and drains both queues.
- Actual loopback WebTransport with a pinned self-signed certificate: a 16 MiB
  reliable frame exceeds the default QUIC receive/send buffering, the peer
  leaves it unread, and eight datagrams still arrive before that frame can
  complete. Reading resumes and both the entire frame and the next frame match
  byte for byte.
- Main-server enqueue policy and drop telemetry route state/datagrams correctly
  and signal a genuine reliable overflow.

Seven outbound tests and ten existing snapshot/protocol tests pass with the
qualified CUDA release dependencies. These tests establish delivery behavior,
not a simulation tick-time speedup or public UDP reachability. No CUDA profiling
or held physical-solver change is enabled by this patch.

## Release status

Deployed at **2026-09-06 04:00 UTC** to
[the public city](https://209.121.195.117:40617/city): game `a4685b3`, solver
`bd71ce1b`, executable SHA-256
`7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee`.
The main game branch carries the same implementation as `a4eb15b`.

Before deployment, that exact immutable executable ran alone on the GPU on
private loopback ports, with the existing city settings and client bundle. The
browser bootstrap rendered all 96,420 chunks. Four aimed shots then produced
945 broken bonds visible in a fresh client snapshot, 364 received motion
datagrams and fresh hash checks. Server logs confirm three routed city hits. The client reports four fired shots;
this capture does not prove server delivery of all four. The periodic client
snapshot is also older than the final server bond count.
There were zero topology sequence gaps, repairs, hash mismatches, orphaned
chunks, settle rejects or JavaScript errors. Server telemetry reported zero
outbound queue drops, zero malformed packets and zero GPU warnings. This is
functional destruction/streaming coverage, not a heavy-load speed benchmark.

The same capture retained **two below-ground chunk centroids**, minimum Y
−0.753 m; the deeper provenance field remained null. That known issue is open.
Zero stale-drawn chunks in this capture does not establish a general fix for
previously reported stale rendering. The test uses the normal shot force and
fracture behavior; its four-shot script is a test input, not a runtime limit.

The private candidate was stopped and the previous public artifact restored
before deployment. Deployment then rechecked zero connected players, installed
the qualified immutable executable using the owned supervisor/helper, and
verified its live hash. Public HTTPS and a local WebTransport browser check
passed, again rendering all 96,420 chunks without topology errors. Local browser
checks do not prove external UDP reachability. The unchanged endpoint is ready
for human testing in Chrome/Edge with the existing self-signed certificate.

All VIBE/BLAST simulation settings compare equal before and after, excluding the
new release-provenance fields. Direct GPU remains enabled. The solver includes
the restore profiling/context-scope code, with **both flags disabled**; the held
physical multilevel solver and contact-ordering changes remain excluded. Client
assets are unchanged. The previous immutable executable remains available for
rollback. Commits remain local; no source push was attempted in this increment.

The [source-hashed evidence and verifier](../bench-results/simulation-frontier/outbound-streams/summary.json)
record the deployment, tests and remaining geometry issue. Next work remains
heavy-tick contact/restore costs, exact shot-input replay for comparisons, and
the report's below-ground pose provenance. The original analysis is in
[city-player-reports-2026-09-06.md](city-player-reports-2026-09-06.md).
