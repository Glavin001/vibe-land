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

The source change is ready for final server build and city browser qualification.
Deployment evidence will be recorded separately with its actual executable hash.
The original report analysis is in [city-player-reports-2026-09-06.md](city-player-reports-2026-09-06.md).
