//! Per-client send log: every packet the server handed each client while a
//! session capture is running, with the tick that produced it, when it was
//! queued and when it actually went out, on which lane, and what became of it
//! (sent, sent on the reliable fallback, dropped on a full queue, ...).
//!
//! The decisions live in three places and all three report here: the tick
//! thread's enqueue (`outbound::Sender::enqueue` -- a full datagram queue drops,
//! a full reliable queue fails the connection), and the per-connection writer
//! tasks (a WebTransport datagram is sent, falls back to the reliable stream,
//! or is dropped under the strict-snapshot rule; the WebSocket writer sends
//! everything in order). Interest and byte-budget decisions are made before a
//! packet exists and are recorded separately, per tick, by the session capture.
//!
//! Cost when no capture is running: one relaxed atomic load per packet. While
//! one is: a CRC32 of the packet on the writer task (so a client tape can be
//! joined packet for packet against this log), and a `try_send` of a 36-byte
//! record into a bounded channel drained by a writer thread. A full channel
//! drops the record and counts it -- the log never back-pressures a send.
//!
//! File (`sendlog.bin`), little-endian: magic `VLSEND01`; u32 header length;
//! JSON header (`epoch_unix_us` puts the microsecond clocks on the wall
//! clock); then fixed 36-byte records:
//!   [u32 player][u32 tick][u64 queued_us][u64 sent_us][u32 size][u32 crc32]
//!   [u8 kind][u8 lane][u8 outcome][u8 reserved]
//! `queued_us` / `sent_us` are microseconds since the capture epoch;
//! `queued_us` is `u64::MAX` when the packet was queued before the capture
//! started. `tick` is the server tick during which the packet was queued.

use std::io::{BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

pub const MAGIC: &[u8; 8] = b"VLSEND01";
pub const RECORD_BYTES: usize = 36;
/// Records the writer may lag before new ones are dropped: at a few thousand
/// packets a second across all clients, tens of seconds of disk stall.
pub const QUEUE_RECORDS: usize = 1 << 17;
pub const QUEUED_BEFORE_CAPTURE: u64 = u64::MAX;

/// Where a packet went (or was meant to go).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Lane {
    WtReliable = 0,
    WtDatagram = 1,
    WebSocket = 2,
}

pub const LANE_NAMES: [&str; 3] = ["wt-reliable", "wt-datagram", "websocket"];

/// What became of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Outcome {
    /// Written to the transport on its own lane.
    Sent = 0,
    /// A datagram the transport refused (too large), written to the reliable
    /// stream instead.
    SentFallback = 1,
    /// Dropped at enqueue: the client's datagram queue was full.
    QueueFull = 2,
    /// The reliable queue overflowed; the connection is being closed.
    ReliableOverflow = 3,
    /// The connection had already failed or closed.
    Closed = 4,
    /// A snapshot datagram the transport refused, dropped (strict datagrams).
    StrictDrop = 5,
    /// A datagram refused by the transport whose reliable fallback queue was
    /// full; dropped.
    FallbackDropped = 6,
}

pub const OUTCOME_NAMES: [&str; 7] = [
    "sent",
    "sent-fallback",
    "queue-full",
    "reliable-overflow",
    "closed",
    "strict-drop",
    "fallback-dropped",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SendRecord {
    pub player: u32,
    pub tick: u32,
    pub queued_us: u64,
    pub sent_us: u64,
    pub size: u32,
    pub crc32: u32,
    pub kind: u8,
    pub lane: u8,
    pub outcome: u8,
}

impl SendRecord {
    pub fn encode(&self) -> [u8; RECORD_BYTES] {
        let mut out = [0u8; RECORD_BYTES];
        out[0..4].copy_from_slice(&self.player.to_le_bytes());
        out[4..8].copy_from_slice(&self.tick.to_le_bytes());
        out[8..16].copy_from_slice(&self.queued_us.to_le_bytes());
        out[16..24].copy_from_slice(&self.sent_us.to_le_bytes());
        out[24..28].copy_from_slice(&self.size.to_le_bytes());
        out[28..32].copy_from_slice(&self.crc32.to_le_bytes());
        out[32] = self.kind;
        out[33] = self.lane;
        out[34] = self.outcome;
        out
    }

    // The reference reader for the format; the server itself only writes.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn decode(bytes: &[u8; RECORD_BYTES]) -> Self {
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        Self {
            player: u32_at(0),
            tick: u32_at(4),
            queued_us: u64_at(8),
            sent_us: u64_at(16),
            size: u32_at(24),
            crc32: u32_at(28),
            kind: bytes[32],
            lane: bytes[33],
            outcome: bytes[34],
        }
    }
}

enum Message {
    Record(SendRecord),
    Finish,
}

/// The capture's end of the log, installed into a match's hub while a
/// capture runs.
#[derive(Clone)]
pub struct SendLogSink {
    tx: SyncSender<Message>,
    epoch: Instant,
    dropped: Arc<AtomicU64>,
}

/// One per match, shared by the tick thread and every connection of the
/// match. Carries the current server tick (so a packet can be stamped with
/// the tick that queued it) and, while a capture runs, the sink.
#[derive(Default)]
pub struct SendLogHub {
    tick: AtomicU32,
    active: AtomicBool,
    sink: Mutex<Option<SendLogSink>>,
}

impl SendLogHub {
    pub fn set_tick(&self, tick: u32) {
        self.tick.store(tick, Ordering::Relaxed);
    }

    pub fn tick(&self) -> u32 {
        self.tick.load(Ordering::Relaxed)
    }

    pub fn active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    pub fn attach(&self, sink: SendLogSink) {
        if let Ok(mut slot) = self.sink.lock() {
            *slot = Some(sink);
            self.active.store(true, Ordering::Relaxed);
        }
    }

    /// Stop logging. After this returns no record reaches the old sink, so
    /// its writer can be finished.
    pub fn detach(&self) {
        self.active.store(false, Ordering::Relaxed);
        if let Ok(mut slot) = self.sink.lock() {
            *slot = None;
        }
    }

    /// Microseconds since the running capture's epoch, if one is running.
    pub fn now_us(&self) -> Option<u64> {
        if !self.active() {
            return None;
        }
        let slot = self.sink.lock().ok()?;
        slot.as_ref().map(|sink| micros_since(sink.epoch, Instant::now()))
    }

    fn log(&self, mut record: SendRecord, queued: Option<Instant>) {
        let Ok(slot) = self.sink.lock() else { return };
        let Some(sink) = slot.as_ref() else { return };
        let now = Instant::now();
        record.sent_us = micros_since(sink.epoch, now);
        record.queued_us = match queued {
            Some(at) if at >= sink.epoch => micros_since(sink.epoch, at),
            _ => QUEUED_BEFORE_CAPTURE,
        };
        match sink.tx.try_send(Message::Record(record)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                sink.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn micros_since(epoch: Instant, at: Instant) -> u64 {
    at.saturating_duration_since(epoch).as_micros() as u64
}

/// A connection's view of its match's hub.
pub struct Tap {
    pub player: u32,
    pub websocket: bool,
    pub hub: Arc<SendLogHub>,
}

/// A packet's identity, taken before its bytes are handed to the transport.
pub struct Pending<'a> {
    tap: &'a Tap,
    record: SendRecord,
    queued: Option<Instant>,
}

impl Tap {
    pub fn new(player: u32, websocket: bool, hub: Arc<SendLogHub>) -> Self {
        Self { player, websocket, hub }
    }

    /// None (and no hashing) unless a capture is running.
    pub fn prepare(&self, bytes: &[u8], tick: u32, queued: Option<Instant>) -> Option<Pending<'_>> {
        if !self.hub.active() {
            return None;
        }
        Some(Pending {
            tap: self,
            record: SendRecord {
                player: self.player,
                tick,
                queued_us: 0,
                sent_us: 0,
                size: bytes.len() as u32,
                crc32: crc32fast::hash(bytes),
                kind: bytes.first().copied().unwrap_or_default(),
                lane: 0,
                outcome: 0,
            },
            queued,
        })
    }

    /// The lane a packet was meant for, for decisions taken before a lane
    /// was chosen (enqueue drops).
    pub fn intended_lane(&self, unreliable: bool) -> Lane {
        if self.websocket {
            Lane::WebSocket
        } else if unreliable {
            Lane::WtDatagram
        } else {
            Lane::WtReliable
        }
    }
}

impl Pending<'_> {
    pub fn finish(mut self, lane: Lane, outcome: Outcome) {
        self.record.lane = lane as u8;
        self.record.outcome = outcome as u8;
        self.tap.hub.log(self.record, self.queued);
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SendLogSummary {
    pub records: u64,
    pub dropped_records: u64,
}

/// The writer thread behind `sendlog.bin`.
pub struct SendLogWriter {
    tx: SyncSender<Message>,
    worker: Option<JoinHandle<std::io::Result<u64>>>,
    dropped: Arc<AtomicU64>,
}

impl SendLogWriter {
    pub fn open(
        path: &Path,
        epoch: Instant,
        epoch_unix_us: u64,
        capacity: usize,
    ) -> std::io::Result<(Self, SendLogSink)> {
        let mut out = BufWriter::new(std::fs::File::create(path)?);
        let header = serde_json::json!({
            "version": 1,
            "epoch_unix_us": epoch_unix_us,
            "record_bytes": RECORD_BYTES,
            "fields": "u32 player, u32 tick, u64 queued_us, u64 sent_us, u32 size, u32 crc32, u8 kind, u8 lane, u8 outcome, u8 reserved",
            "lanes": LANE_NAMES,
            "outcomes": OUTCOME_NAMES,
            "queued_before_capture": QUEUED_BEFORE_CAPTURE,
        });
        let header = serde_json::to_vec(&header)?;
        out.write_all(MAGIC)?;
        out.write_all(&(header.len() as u32).to_le_bytes())?;
        out.write_all(&header)?;
        let (tx, rx) = sync_channel::<Message>(capacity.max(1));
        let worker = std::thread::Builder::new()
            .name("send-log".into())
            .spawn(move || run_writer(out, rx))?;
        let dropped = Arc::new(AtomicU64::new(0));
        let sink = SendLogSink { tx: tx.clone(), epoch, dropped: dropped.clone() };
        Ok((Self { tx, worker: Some(worker), dropped }, sink))
    }

    /// Drain and close. Call after the sink is detached from every hub.
    pub fn finish(mut self) -> std::io::Result<SendLogSummary> {
        let _ = self.tx.send(Message::Finish);
        let records = match self.worker.take() {
            Some(worker) => worker
                .join()
                .map_err(|_| std::io::Error::other("send log writer panicked"))??,
            None => 0,
        };
        Ok(SendLogSummary { records, dropped_records: self.dropped.load(Ordering::Relaxed) })
    }
}

fn run_writer(mut out: BufWriter<std::fs::File>, rx: Receiver<Message>) -> std::io::Result<u64> {
    let mut written = 0u64;
    while let Ok(message) = rx.recv() {
        match message {
            Message::Record(record) => {
                out.write_all(&record.encode())?;
                written += 1;
            }
            Message::Finish => break,
        }
    }
    out.flush()?;
    Ok(written)
}

/// Reads a whole log; a trailing partial record (a log still being written)
/// is ignored.
// The reference reader for the format; the server itself only writes.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_send_log(path: &Path) -> std::io::Result<(serde_json::Value, Vec<SendRecord>)> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.read_to_end(&mut bytes)?;
    if bytes.len() < 12 || &bytes[..8] != MAGIC {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a VLSEND01 log"));
    }
    let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let body = 12 + header_len;
    if body > bytes.len() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "short send log header"));
    }
    let header: serde_json::Value = serde_json::from_slice(&bytes[12..body])?;
    let records = bytes[body..]
        .chunks_exact(RECORD_BYTES)
        .map(|chunk| SendRecord::decode(chunk.try_into().unwrap()))
        .collect();
    Ok((header, records))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vl-sendlog-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_round_trip_through_the_fixed_layout() {
        let record = SendRecord {
            player: 7,
            tick: 1234,
            queued_us: 99,
            sent_us: 101,
            size: 1100,
            crc32: 0xdead_beef,
            kind: 123,
            lane: Lane::WtDatagram as u8,
            outcome: Outcome::StrictDrop as u8,
        };
        assert_eq!(SendRecord::decode(&record.encode()), record);
    }

    #[test]
    fn a_hub_logs_only_while_attached_and_stamps_times_against_the_epoch() {
        let dir = temp("attach");
        let hub = Arc::new(SendLogHub::default());
        let tap = Tap::new(3, false, hub.clone());
        hub.set_tick(10);
        // Before a capture: nothing is prepared, nothing hashed.
        assert!(tap.prepare(&[1, 2, 3], hub.tick(), None).is_none());
        assert_eq!(hub.now_us(), None);

        let epoch = Instant::now();
        let (writer, sink) =
            SendLogWriter::open(&dir.join("sendlog.bin"), epoch, 1_700_000_000_000_000, 16).unwrap();
        hub.attach(sink);
        assert!(hub.now_us().is_some());
        let queued_before = epoch.checked_sub(std::time::Duration::from_millis(5));
        tap.prepare(&[121, 9], 10, queued_before)
            .unwrap()
            .finish(Lane::WtReliable, Outcome::Sent);
        hub.set_tick(11);
        tap.prepare(&[123, 1, 2, 3], 11, Some(Instant::now()))
            .unwrap()
            .finish(tap.intended_lane(true), Outcome::QueueFull);
        hub.detach();
        // After detach: back to free.
        assert!(tap.prepare(&[1], 12, None).is_none());
        let summary = writer.finish().unwrap();
        assert_eq!(summary, SendLogSummary { records: 2, dropped_records: 0 });

        let (header, records) = read_send_log(&dir.join("sendlog.bin")).unwrap();
        assert_eq!(header["epoch_unix_us"], 1_700_000_000_000_000u64);
        assert_eq!(header["outcomes"][2], "queue-full");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].player, 3);
        assert_eq!(records[0].tick, 10);
        assert_eq!(records[0].queued_us, QUEUED_BEFORE_CAPTURE);
        assert_eq!(records[0].crc32, crc32fast::hash(&[121, 9]));
        assert_eq!(records[0].kind, 121);
        assert_eq!(records[1].lane, Lane::WtDatagram as u8);
        assert_eq!(records[1].outcome, Outcome::QueueFull as u8);
        assert!(records[1].queued_us <= records[1].sent_us);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_log_drops_and_counts_instead_of_blocking() {
        let dir = temp("full");
        let hub = Arc::new(SendLogHub::default());
        let tap = Tap::new(1, true, hub.clone());
        let (writer, sink) =
            SendLogWriter::open(&dir.join("sendlog.bin"), Instant::now(), 0, 1).unwrap();
        // A one-record queue, flooded faster than the writer can drain it:
        // every record is either written or counted as dropped.
        hub.attach(sink);
        let started = Instant::now();
        for _ in 0..50_000 {
            tap.prepare(&[5; 64], 0, None).unwrap().finish(Lane::WebSocket, Outcome::Sent);
        }
        // Never waited on the disk: 50k try_sends are far under a second.
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        hub.detach();
        let summary = writer.finish().unwrap();
        assert_eq!(summary.records + summary.dropped_records, 50_000);
        let (_, records) = read_send_log(&dir.join("sendlog.bin")).unwrap();
        assert_eq!(records.len() as u64, summary.records);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
