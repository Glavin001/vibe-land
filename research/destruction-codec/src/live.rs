//! The debris codec as a live server would drive it.
//!
//! `Encoder` was built for an offline harness: a fixed body table, records
//! accumulated into blocks, statefulness carried across those blocks. A match
//! server has none of those luxuries -- islands appear and retire every tick,
//! packets are UDP datagrams that may never arrive, and a client can join at
//! any moment. This wraps the encoder with exactly the three properties the
//! wire needs and nothing else:
//!
//!   * **dynamic bodies** -- island body keys map onto encoder lanes through a
//!     free-list, so a retiring island's lane is recycled (with a restart, so
//!     the next tenant cannot inherit its state);
//!   * **self-contained packets** -- records are packed into datagram-sized
//!     payloads that each decode with no carried state; losing one loses one
//!     span of the bodies inside it and nothing else;
//!   * **smeared restatement** -- every body is re-stated absolutely once per
//!     `restate_period` spans, one cohort per span, so any loss heals within a
//!     bounded, byte-smooth window instead of via retransmission.
//!
//! Fidelity comes from the wrapped encoder unchanged; this file never touches
//! how a trajectory is fitted, only which bodies exist and how their records
//! are framed for a lossy wire.

use std::collections::HashMap;

use glam::Vec3;

use crate::debris_codec::{
    decode_block, encode_block, placeholder_tail, Encoder, Record, SleepPolicy, Tolerances,
    DEFAULT_STRIDE_LADDER,
};
use crate::trace::ActorState;

/// Datagram budget for one packet's payload, matching the transport MTU the
/// production wire already assumes (`quant::MAX_DATAGRAM = 1150`) minus the
/// live header the server prepends.
pub const PACKET_PAYLOAD_BUDGET: usize = 1120;

/// Rest repeats per parked episode. At 10% independent packet loss, four
/// sendings leave a 1e-4 chance the body freezes mid-air until it next moves.
const REST_RESTATES: u8 = 4;

pub struct LiveEncoderConfig {
    pub dt: f32,
    pub gravity: Vec3,
    pub tolerances: Tolerances,
    pub sleep: SleepPolicy,
    /// Spans between absolute restatements of any given body.
    pub restate_period: u32,
    /// Initial lane capacity; grows as islands exceed it.
    pub initial_capacity: usize,
}

/// One self-contained wire packet: decodes alone, drops alone.
pub struct LivePacket {
    /// First tick of the span whose records this packet carries.
    pub span_tick: u32,
    pub payload: Vec<u8>,
    /// How many bodies' records are inside (telemetry, not framing).
    pub bodies: u32,
}

struct Lane {
    key: u64,
    radius: f32,
    /// Remaining Rest re-statements for the current parked episode.
    ///
    /// A parked body's Rest exists to survive packet loss, and a handful of
    /// repeats already drives the frozen-forever probability below one in ten
    /// thousand at 10% loss. Re-stating 6k parked rubble chunks forever on the
    /// moving cadence measured 0.5+ Mbps of pure repetition -- the single
    /// largest avoidable cost in the first live measurement.
    rest_restates_left: u8,
    was_parked: bool,
}

pub struct LiveEncoder {
    encoder: Encoder,
    config_dt: f32,
    gravity: Vec3,
    tolerances: Tolerances,
    sleep: SleepPolicy,
    restate_period: u32,
    lanes: Vec<Option<Lane>>,
    free: Vec<usize>,
    by_key: HashMap<u64, usize>,
    span_index: u32,
    pending: Vec<Record>,
    nack_restates: Vec<usize>,
    /// (lane, key) assignments since the last drain. The wire's record ids are
    /// LANE indices -- dense, cheap varints -- so the receiver needs this map,
    /// and it must arrive reliably: a lost mapping strands every record the
    /// lane ever carries. Found by rendering: the first v3 video showed intact
    /// buildings standing in a rubble field, because every sampled body's
    /// records were keyed by a number the client had no way to interpret.
    assignments: Vec<(u32, u64)>,
    /// Chain tails as the wire has evolved them. Chains are BOUNDED: the
    /// restatement rotation force-restarts every body once per
    /// `restate_period` spans, so a chain never lives longer than the heal
    /// window. Fully self-contained packets were measured first and cost
    /// 2.5x the block wire -- an absolute opening frame for every body every
    /// span. Bounded chains keep block-mode bytes and bound the loss blast
    /// radius instead of eliminating it.
    wire_tails: Vec<Option<([i32; 3], u64)>>,
}

impl LiveEncoder {
    pub fn new(config: LiveEncoderConfig) -> Self {
        let capacity = config.initial_capacity.max(1);
        let mut encoder = Self::build_encoder(&config, capacity);
        encoder.enable_wire_v2();
        Self {
            encoder,
            config_dt: config.dt,
            gravity: config.gravity,
            tolerances: config.tolerances,
            sleep: config.sleep,
            restate_period: config.restate_period.max(1),
            lanes: (0..capacity).map(|_| None).collect(),
            free: (0..capacity).rev().collect(),
            by_key: HashMap::new(),
            span_index: 0,
            pending: Vec::new(),
            nack_restates: Vec::new(),
            assignments: Vec::new(),
            wire_tails: vec![None; capacity],
        }
    }

    fn build_encoder(config: &LiveEncoderConfig, capacity: usize) -> Encoder {
        Encoder::new(
            capacity,
            config.dt,
            config.gravity,
            vec![1.0; capacity],
            config.tolerances,
            config.sleep,
            2,
            DEFAULT_STRIDE_LADDER.to_vec(),
            false,
            0.0,
            // Parallel span finalization; degrades to serial where unavailable.
            true,
        )
    }

    /// Register an island body. `radius` bounds its shell error (the island's
    /// reach, not the root chunk's size -- the wide-rotation lesson).
    pub fn add_body(&mut self, key: u64, radius: f32) {
        if self.by_key.contains_key(&key) {
            return;
        }
        let lane = match self.free.pop() {
            Some(lane) => lane,
            None => {
                self.grow();
                self.free.pop().expect("grow produced free lanes")
            }
        };
        // The lane may have belonged to a retired island; the restart is what
        // keeps its fitter state from leaking into the new tenant.
        self.encoder.force_restart(lane);
        self.lanes[lane] = Some(Lane {
            key,
            radius,
            rest_restates_left: REST_RESTATES,
            was_parked: false,
        });
        self.by_key.insert(key, lane);
        self.assignments.push((lane as u32, key));
        self.refresh_radii();
    }

    pub fn remove_body(&mut self, key: u64) {
        if let Some(lane) = self.by_key.remove(&key) {
            self.encoder.force_restart(lane);
            self.lanes[lane] = None;
            self.free.push(lane);
        }
    }

    pub fn contains(&self, key: u64) -> bool {
        self.by_key.contains_key(&key)
    }

    pub fn body_count(&self) -> usize {
        self.by_key.len()
    }

    fn grow(&mut self) {
        let old = self.lanes.len();
        let new = (old * 2).max(old + 1);
        // Encoder lanes are fixed at construction, so growth rebuilds it. The
        // restart this implies for every body is correct -- self-contained
        // records mean a restart costs one absolute, not a resync.
        let config = LiveEncoderConfig {
            dt: self.config_dt,
            gravity: self.gravity,
            tolerances: self.tolerances,
            sleep: self.sleep,
            restate_period: self.restate_period,
            initial_capacity: new,
        };
        let mut encoder = Self::build_encoder(&config, new);
        encoder.enable_wire_v2();
        self.encoder = encoder;
        self.lanes.resize_with(new, || None);
        self.wire_tails = vec![None; new];
        for lane in (old..new).rev() {
            self.free.push(lane);
        }
        self.refresh_radii();
    }

    fn refresh_radii(&mut self) {
        let radii: Vec<f32> = self
            .lanes
            .iter()
            .map(|lane| lane.as_ref().map_or(1.0, |lane| lane.radius.max(0.01)))
            .collect();
        self.encoder.set_radii(&radii);
    }

    /// One body, one tick.
    pub fn push(&mut self, key: u64, tick: u32, state: &ActorState) {
        if let Some(&lane) = self.by_key.get(&key) {
            self.encoder.push(lane, tick, state);
        }
    }

    /// Lane->key assignments made since the last drain. Must be delivered
    /// reliably and in order, ahead of use; a datagram referencing a lane the
    /// receiver has no mapping for yet is dropped and healed by restatement.
    pub fn take_lane_assignments(&mut self) -> Vec<(u32, u64)> {
        std::mem::take(&mut self.assignments)
    }

    /// Restate specific bodies absolutely on the next span.
    ///
    /// This is the loss-heal path. Periodic restatement of every moving body
    /// was measured at +5.4 MB per minute-long barrage (each restate cascades
    /// 2-3 broken spans of chain re-establishment), against a no-restatement
    /// wire of 2.53 Mbps -- paying for losses that mostly never happened. The
    /// decoder already KNOWS which chains a lost packet poisoned (its gap
    /// rule), so it reports exactly those bodies on the existing uplink and
    /// the cost scales with actual loss. Parked bodies keep their budgeted
    /// Rest rotation: a lost Rest leaves no chain gap to detect.
    pub fn restate_keys(&mut self, keys: &[u64]) {
        for &key in keys {
            if let Some(&lane) = self.by_key.get(&key) {
                self.nack_restates.push(lane);
            }
        }
    }

    /// `finalize_span`, also returning the records for measurement harnesses.
    pub fn finalize_span_tapped(
        &mut self,
        span_first_tick: u32,
    ) -> (Vec<LivePacket>, Vec<Record>) {
        let records = self.close_span(span_first_tick);
        let packets = self.packetize(span_first_tick, records.clone());
        (packets, records)
    }

    /// Close the span and return self-contained datagram payloads.
    ///
    /// `span_first_tick` is the tick the span opened at; every packet is
    /// stamped with it so the client can drop stale packets per body without
    /// any sequence state.
    pub fn finalize_span(&mut self, span_first_tick: u32) -> Vec<LivePacket> {
        let records = self.close_span(span_first_tick);
        self.packetize(span_first_tick, records)
    }

    fn close_span(&mut self, span_first_tick: u32) -> Vec<Record> {
        // Restatement cohort for this span: every body whose lane index lands
        // on the rotation gets a forced absolute restart, so any packet loss
        // affecting it heals within `restate_period` spans. Parked bodies get
        // their Rest re-emitted by the same mechanism.
        let mut restated = Vec::new();
        // Nack-driven restatement: exactly the bodies whose chains a lost
        // packet poisoned, reported by the decoder.
        let nacked = std::mem::take(&mut self.nack_restates);
        for lane in nacked {
            if self.lanes[lane].is_some() {
                self.wire_tails[lane] = None;
                self.restate_lane(lane, span_first_tick, &mut restated);
            }
        }
        // Parked-Rest insurance rotation: a lost Rest leaves no chain gap for
        // the decoder to detect, so it is repeated a budgeted number of times.
        let cohort = self.span_index % self.restate_period;
        for lane in 0..self.lanes.len() {
            let Some(slot) = self.lanes[lane].as_ref() else {
                continue;
            };
            if (lane as u32) % self.restate_period != cohort {
                continue;
            }
            let parked = self.encoder.is_parked(lane);
            let (was_parked, budget) = (slot.was_parked, slot.rest_restates_left);
            if parked && !was_parked {
                if let Some(slot) = self.lanes[lane].as_mut() {
                    slot.rest_restates_left = REST_RESTATES;
                    slot.was_parked = true;
                }
            } else if !parked {
                if let Some(slot) = self.lanes[lane].as_mut() {
                    slot.was_parked = false;
                }
                continue;
            }
            if was_parked && budget == 0 {
                continue;
            }
            let before = restated.len();
            self.wire_tails[lane] = None;
            self.restate_lane(lane, span_first_tick, &mut restated);
            if restated.len() > before {
                if let Some(slot) = self.lanes[lane].as_mut() {
                    slot.rest_restates_left = slot.rest_restates_left.saturating_sub(1);
                }
            }
        }
        self.pending.extend(restated);
        self.span_index = self.span_index.wrapping_add(1);

        self.encoder.finalize_span(span_first_tick, &mut self.pending);
        std::mem::take(&mut self.pending)
    }

    fn restate_lane(&mut self, lane: usize, tick: u32, out: &mut Vec<Record>) {
        let mut all = Vec::new();
        self.encoder.restate_body_live(lane, tick, &mut all);
        out.extend(all);
    }

    /// Map lane-indexed record bodies back to island keys.
    pub fn key_of_lane(&self, lane: u32) -> Option<u64> {
        self.lanes
            .get(lane as usize)
            .and_then(|slot| slot.as_ref().map(|lane| lane.key))
    }

    pub fn lane_of_key(&self, key: u64) -> Option<u32> {
        self.by_key.get(&key).map(|&lane| lane as u32)
    }

    fn packetize(&mut self, span_tick: u32, records: Vec<Record>) -> Vec<LivePacket> {
        let mut packets = Vec::new();
        let mut group: Vec<Record> = Vec::new();
        let mut group_bodies = 0u32;
        let mut group_cost = 0usize;

        // Records arrive sorted by body from finalize_span; keep one body's
        // records in one packet so a drop loses whole bodies, never half of
        // one body's span. Packets are encoded in order against the evolving
        // wire tails -- the state an in-order decoder reconstructs.
        let mut index = 0;
        while index < records.len() {
            let body = records[index].body();
            let mut end = index + 1;
            while end < records.len() && records[end].body() == body {
                end += 1;
            }
            let body_records = &records[index..end];
            let cost: usize = body_records
                .iter()
                .map(|record| record.encoded_len(span_tick, &self.wire_tails, true))
                .sum();
            if !group.is_empty() && group_cost + cost > PACKET_PAYLOAD_BUDGET {
                let payload = encode_block(&mut group, span_tick, &mut self.wire_tails, true);
                packets.push(LivePacket {
                    span_tick,
                    payload,
                    bodies: group_bodies,
                });
                group.clear();
                group_bodies = 0;
                group_cost = 0;
            }
            group.extend_from_slice(body_records);
            group_bodies += 1;
            group_cost += cost;
            index = end;
        }
        if !group.is_empty() {
            let payload = encode_block(&mut group, span_tick, &mut self.wire_tails, true);
            packets.push(LivePacket {
                span_tick,
                payload,
                bodies: group_bodies,
            });
        }
        // Hand the evolved tails back so the NEXT span's continuity candidates
        // are priced correctly (see Encoder::sync_encode_tails).
        self.encoder.sync_encode_tails(&self.wire_tails);
        packets
    }
}

/// In-order packet decoder with per-body chain state and the gap rule.
///
/// A continuity run decodes against the tail its chain left behind. When the
/// packet carrying part of a chain was lost, the tail's tick no longer lines
/// up -- the decoder detects that, discards the body's records until its next
/// absolute (restatement guarantees one within the heal window), and keeps
/// every other body in the packet.
pub struct LiveDecoder {
    tails: Vec<Option<([i32; 3], u64)>>,
    /// Tick each body's chain is expected to resume at; None = no live chain.
    expected: Vec<Option<u32>>,
    poisoned: Vec<u32>,
}

impl LiveDecoder {
    pub fn new(max_lanes: usize) -> Self {
        Self {
            // Placeholder tails, not None: a packet must PARSE even when this
            // decoder never saw the lane's history (it was in a lost packet).
            // Record lengths are seed-independent, so parsing against the
            // placeholder is safe, and the gap rule discards the results.
            tails: vec![Some(placeholder_tail()); max_lanes],
            expected: vec![None; max_lanes],
            poisoned: Vec::new(),
        }
    }

    /// Bodies whose chains a lost packet poisoned since the last drain. The
    /// caller sends these upstream as a restate request.
    pub fn drain_poisoned(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.poisoned)
    }

    /// Decode one packet, returning only records that are safe to apply.
    pub fn push_packet(&mut self, payload: &[u8]) -> anyhow::Result<Vec<Record>> {
        let records = decode_block(payload, &mut self.tails, true)?;
        let mut applied = Vec::with_capacity(records.len());
        for record in records {
            let body = record.body() as usize;
            if body >= self.expected.len() {
                continue;
            }
            match &record {
                Record::SampleRun {
                    tick,
                    continuity,
                    stride,
                    last_offset,
                    frames,
                    ..
                } => {
                    if *continuity {
                        // Chain link: valid only if it resumes exactly where
                        // the previous run ended.
                        if self.expected[body] != Some(*tick) {
                            // Lost link. The tail is now poisoned; drop the
                            // chain until an absolute arrives, and report the
                            // body so the caller can nack it upstream.
                            self.expected[body] = None;
                            self.tails[body] = Some(placeholder_tail());
                            if !self.poisoned.contains(&(body as u32)) {
                                self.poisoned.push(body as u32);
                            }
                            continue;
                        }
                    }
                    // `last_offset` is the TOTAL tick span of the run
                    // (frames[last].tick - frames[0].tick), not a final hop --
                    // computing it from the stride double-counted and made the
                    // decoder poison healthy chains, which then cleared parse
                    // tails mid-stream and corrupted every later packet.
                    let _ = stride;
                    let _ = frames;
                    self.expected[body] = Some(tick + u32::from(*last_offset) + 1);
                    applied.push(record);
                }
                _ => {
                    // Segments, impulses and rests are self-contained.
                    self.expected[body] = None;
                    applied.push(record);
                }
            }
        }
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::MaskConfig;
    use crate::trace::Pose;
    use glam::Quat;

    fn config() -> LiveEncoderConfig {
        LiveEncoderConfig {
            dt: 1.0 / 60.0,
            gravity: Vec3::new(0.0, -9.81, 0.0),
            tolerances: Tolerances::new(0.005, 3.0, 0.15, 0.5, MaskConfig::default()),
            sleep: SleepPolicy {
                linear_mps: 0.0,
                angular_rps: 0.0,
                ticks: 0,
            },
            restate_period: 4,
            initial_capacity: 2,
        }
    }

    /// Tumbling contact-like motion: no analytic fits it, so every span emits
    /// a sampled run and chains actually form -- the state the loss machinery
    /// exists for. A clean ballistic body would open one Segment and go silent,
    /// which tests nothing.
    fn falling(tick: u32, key_offset: f32) -> ActorState {
        let t = tick as f32 / 60.0;
        // Deterministic jitter with per-tick sign churn.
        let n1 = ((tick * 2654435761) >> 16) as f32 / 65536.0 - 0.5;
        let n2 = ((tick.wrapping_mul(97) * 2246822519) >> 16) as f32 / 65536.0 - 0.5;
        ActorState {
            pose: Pose {
                position: Vec3::new(
                    key_offset + n1 * 0.4,
                    (50.0 - 6.0 * t + n2 * 0.3).max(0.5),
                    n1 * n2,
                ),
                rotation: (Quat::from_rotation_z(n1 * 0.8) * Quat::from_rotation_x(t))
                    .normalize(),
            },
            linear_velocity: Vec3::new(n1 * 3.0, -6.0 + n2 * 4.0, n2 * 3.0),
            angular_velocity: Vec3::new(n2, n1, 0.3),
            contacts: 1,
            intact_joints: 0,
            flags: 0,
        }
    }

    /// Bisect helper: same records, mono-block, no packetize.
    #[test]
    fn jitter_stream_mono_roundtrip() {
        let mut live = LiveEncoder::new(config());
        for body in 0..16u64 {
            live.add_body(body, 1.0);
        }
        let mut enc_tails = vec![None; 64];
        let mut dec_tails = vec![None; 64];
        let span = 6u32;
        for span_start in (0..60).step_by(span as usize) {
            for tick in span_start..span_start + span {
                for body in 0..16u64 {
                    live.push(body, tick, &falling(tick, body as f32 * 3.0));
                }
            }
            let (_, mut records) = live.finalize_span_tapped(span_start);
            let payload = encode_block(&mut records, span_start, &mut enc_tails, true);
            let decoded = decode_block(&payload, &mut dec_tails, true).expect("mono decode");
            assert_eq!(decoded.len(), records.len());
        }
    }

    /// Packets decode strictly in order through a stateful decoder; sizes
    /// respect the datagram budget.
    #[test]
    fn packets_decode_in_order_within_budget() {
        let mut live = LiveEncoder::new(config());
        for body in 0..16u64 {
            live.add_body(body, 1.0);
        }
        let mut decoder = LiveDecoder::new(64);
        let span = 6u32;
        let mut applied = 0usize;
        for span_start in (0..60).step_by(span as usize) {
            for tick in span_start..span_start + span {
                for body in 0..16u64 {
                    live.push(body, tick, &falling(tick, body as f32 * 3.0));
                }
            }
            for packet in live.finalize_span(span_start) {
                assert!(
                    packet.payload.len() <= PACKET_PAYLOAD_BUDGET + 64,
                    "packet {} B exceeds budget",
                    packet.payload.len()
                );
                applied += decoder.push_packet(&packet.payload).expect("decode").len();
            }
        }
        assert!(applied > 0);
    }

    /// Dropping a whole span must poison only the affected chains, and every
    /// body must produce an APPLIED record again within the restatement
    /// period -- the decoder's gap rule plus the encoder's smeared restarts.
    #[test]
    fn loss_heals_within_the_restatement_period() {
        let span = 6u32;
        // The nack loop: encoder and decoder run against each other, spans
        // encoded one step ahead of decode so a nack lands before the next
        // span closes -- the shape of the real server round trip.
        let mut live = LiveEncoder::new(config());
        live.add_body(7, 1.0);
        let mut decoder = LiveDecoder::new(16);
        let dropped_end = span * 3;
        let mut first_heal: Option<u32> = None;
        for span_index in 0..12u32 {
            let span_start = span_index * span;
            for tick in span_start..span_start + span {
                live.push(7, tick, &falling(tick, 0.0));
            }
            let packets = live.finalize_span(span_start);
            if span_index == 2 {
                continue; // the loss -- decoder never sees this span
            }
            for packet in &packets {
                for record in decoder.push_packet(&packet.payload).expect("decode") {
                    if record.tick() >= dropped_end {
                        first_heal =
                            Some(first_heal.map_or(record.tick(), |t| t.min(record.tick())));
                    }
                }
            }
            // Poisoned chains go back upstream, exactly like the client nack.
            let poisoned = decoder.drain_poisoned();
            let keys: Vec<u64> = poisoned.iter().map(|_| 7u64).collect();
            live.restate_keys(&keys);
        }
        let heal_tick = first_heal.expect("no record ever applied after the loss");
        // Heal bound: the nack lands after the first post-loss span, and the
        // restated absolute arrives in the span after that.
        let bound = dropped_end + 3 * span;
        assert!(
            heal_tick <= bound,
            "healed at tick {heal_tick}, nack bound is {bound}"
        );
    }

    #[test]
    fn lanes_recycle_without_leaking_state() {
        let mut live = LiveEncoder::new(config());
        live.add_body(1, 1.0);
        live.add_body(2, 1.0);
        assert_eq!(live.body_count(), 2);
        live.remove_body(1);
        live.add_body(3, 2.0);
        assert_eq!(live.body_count(), 2);
        assert!(live.contains(3));
        assert!(!live.contains(1));
        // Growth past initial capacity keeps every key addressable.
        for key in 10..30u64 {
            live.add_body(key, 1.0);
        }
        assert_eq!(live.body_count(), 22);
        for key in 10..30u64 {
            assert!(live.contains(key));
        }
    }
}

#[cfg(test)]
mod fixture {
    use super::*;
    use crate::mask::MaskConfig;

    /// Write a golden datagram-payload fixture for the wasm decoder's vitest.
    ///
    /// Run when the wire changes:
    ///   cargo test --release -p destruction-codec write_debris_fixture -- --ignored
    /// then re-run the client tests; they assert against these exact bytes.
    #[test]
    #[ignore = "writes client/src/city/__fixtures__/debris-v3-packets.json"]
    fn write_debris_fixture() {
        let mut live = LiveEncoder::new(LiveEncoderConfig {
            dt: 1.0 / 60.0,
            gravity: Vec3::new(0.0, -9.81, 0.0),
            tolerances: Tolerances::new(0.005, 3.0, 0.15, 0.5, MaskConfig::default()),
            sleep: SleepPolicy {
                linear_mps: 0.0,
                angular_rps: 0.0,
                ticks: 0,
            },
            restate_period: 16,
            initial_capacity: 8,
        });
        for body in 0..4u64 {
            live.add_body(body, 1.0);
        }
        let mut spans: Vec<serde_json::Value> = Vec::new();
        for span_start in (0..30u32).step_by(6) {
            for tick in span_start..span_start + 6 {
                for body in 0..4u64 {
                    // Deterministic tumbling motion (no clock, no rng).
                    let t = tick as f32 / 60.0;
                    let n = ((tick * 2654435761u32.wrapping_add(body as u32 * 97)) >> 16) as f32
                        / 65536.0
                        - 0.5;
                    live.push(
                        body,
                        tick,
                        &crate::trace::ActorState {
                            pose: crate::trace::Pose {
                                position: Vec3::new(body as f32 * 3.0 + n * 0.4, 20.0 - 5.0 * t, n),
                                rotation: glam::Quat::from_rotation_z(n).normalize(),
                            },
                            linear_velocity: Vec3::new(n * 2.0, -5.0, 0.0),
                            angular_velocity: Vec3::new(0.0, n, 0.2),
                            contacts: 1,
                            intact_joints: 0,
                            flags: 0,
                        },
                    );
                }
            }
            let packets: Vec<serde_json::Value> = live
                .finalize_span(span_start)
                .into_iter()
                .map(|packet| {
                    serde_json::json!({
                        "spanTick": packet.span_tick,
                        "payloadHex": packet
                            .payload
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>(),
                    })
                })
                .collect();
            spans.push(serde_json::json!({ "spanStart": span_start, "packets": packets }));
        }
        let assignments: Vec<serde_json::Value> = (0..4u32)
            .map(|lane| serde_json::json!({ "lane": lane, "key": lane }))
            .collect();
        let out = serde_json::json!({
            "simHz": 60,
            "assignments": assignments,
            "spans": spans,
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../client/src/city/__fixtures__/debris-v3-packets.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
        println!("fixture written to {}", path.display());
    }
}

#[cfg(test)]
mod overhead {
    use super::*;
    use crate::mask::MaskConfig;
    use crate::trace::TraceReader;

    /// The C0 numbers the plan owes: what do self-contained packets +
    /// restatement + per-packet compression cost against the offline block
    /// wire, on a real trace?
    ///
    /// Run:
    ///   LIVE_OVERHEAD_TRACE=/root/workspace/codec-results/blast-multi/c9-barrage.towertrace \
    ///   cargo test --release -p destruction-codec live_packet_overhead -- --nocapture --ignored
    #[test]
    #[ignore = "measurement: needs a reference trace path in LIVE_OVERHEAD_TRACE"]
    fn live_packet_overhead() {
        let Ok(path) = std::env::var("LIVE_OVERHEAD_TRACE") else {
            panic!("set LIVE_OVERHEAD_TRACE");
        };
        let mut reader = TraceReader::open(std::path::Path::new(&path)).expect("trace opens");
        let hz = reader.header.physics_hz;
        let span = (hz / 10).max(1); // 100 ms flush, the C0 operating point
        let body_count = reader.actors.len();
        let radii: Vec<f32> = reader
            .actors
            .iter()
            .map(|actor| actor.bounding_radius.max(0.01))
            .collect();

        // Offline-mimic arm: raw Encoder, no restatement, exactly run()'s
        // mechanics, to isolate LiveEncoder's own contributions.
        {
            let mut reader = TraceReader::open(std::path::Path::new(&path)).expect("trace opens");
            let mask = MaskConfig {
                enabled: true,
                base_m: 0.005,
                cap_m: 0.020,
                ..MaskConfig::default()
            };
            let mut encoder = Encoder::new(
                body_count,
                1.0 / hz as f32,
                reader.header.gravity,
                radii.clone(),
                Tolerances::new(0.005, 3.0, 0.15, 0.5, mask),
                SleepPolicy {
                    linear_mps: 0.0,
                    angular_rps: 0.0,
                    ticks: 0,
                },
                2,
                DEFAULT_STRIDE_LADDER.to_vec(),
                false,
                0.0,
                true,
            );
            let mut tails: Vec<Option<([i32; 3], u64)>> = vec![None; body_count];
            let mut pending: Vec<Record> = Vec::new();
            let (mut bytes, mut runs, mut chained, mut ticks) = (0u64, 0u64, 0u64, 0u32);
            let mut block_start = 0u32;
            let mut span_count = 0u32;
            while let Some(tick) = reader.next_tick().expect("tick") {
                encoder.push_tick_public(tick.index, &tick.states);
                ticks = tick.index + 1;
                if (tick.index + 1) % span == 0 {
                    let before = pending.len();
                    encoder.finalize_span(block_start, &mut pending);
                    if let Ok(dump) = std::env::var("MIMIC_DUMP_RECORDS") {
                        use std::io::Write;
                        let mut file = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(dump)
                            .expect("dump file");
                        for record in &pending[before..] {
                            let (kind, extra) = match record {
                                Record::Segment { gravity, .. } => ("seg", i64::from(*gravity)),
                                Record::Impulse { .. } => ("imp", 0),
                                Record::SampleRun {
                                    continuity,
                                    stride,
                                    frames,
                                    ..
                                } => ("run", i64::from(*continuity) * 1000 + i64::from(*stride) * 100 + frames.len() as i64),
                                Record::Rest { .. } => ("rest", 0),
                            };
                            writeln!(file, "{},{},{},{}", record.tick(), record.body(), kind, extra)
                                .expect("dump write");
                        }
                    }
                    span_count += 1;
                    // run() keeps block_ms at 250 over 100 ms spans: two spans
                    // share one encoded block. Mirror that exactly.
                    if span_count % 2 == 0 {
                        for record in &pending {
                            if let Record::SampleRun { continuity, .. } = record {
                                runs += 1;
                                if *continuity {
                                    chained += 1;
                                }
                            }
                        }
                        let mut block = std::mem::take(&mut pending);
                        bytes +=
                            encode_block(&mut block, block_start, &mut tails, false).len() as u64;
                        encoder.sync_encode_tails(&tails);
                        block_start = tick.index + 1;
                    }
                }
            }
            let seconds = f64::from(ticks) / f64::from(hz);
            println!(
                "offline-mimic       mono {:>9} B ({:.3} Mbps)  continuity {}/{} ({:.1}%)",
                bytes,
                bytes as f64 * 8.0 / seconds / 1.0e6,
                chained,
                runs,
                100.0 * chained as f64 / runs.max(1) as f64
            );
        }

        // Cross-trace dictionary: train on LIVE_DICT_TRACE's packets, apply
        // to this trace's. Training and evaluating on the same content would
        // flatter the dictionary; production ships one dict for all matches.
        let dictionary: Option<Vec<u8>> = std::env::var("LIVE_DICT_TRACE").ok().map(|train| {
            let mut reader =
                TraceReader::open(std::path::Path::new(&train)).expect("dict trace opens");
            let hz = reader.header.physics_hz;
            let span = (hz / 10).max(1);
            let count = reader.actors.len();
            let radii: Vec<f32> = reader
                .actors
                .iter()
                .map(|actor| actor.bounding_radius.max(0.01))
                .collect();
            let mask = MaskConfig {
                enabled: true,
                base_m: 0.005,
                cap_m: 0.020,
                ..MaskConfig::default()
            };
            let mut live = LiveEncoder::new(LiveEncoderConfig {
                dt: 1.0 / hz as f32,
                gravity: reader.header.gravity,
                tolerances: Tolerances::new(0.005, 3.0, 0.15, 0.5, mask),
                sleep: SleepPolicy {
                    linear_mps: 0.0,
                    angular_rps: 0.0,
                    ticks: 0,
                },
                restate_period: 16,
                initial_capacity: count,
            });
            for body in 0..count as u64 {
                live.add_body(body, radii[body as usize]);
            }
            let mut samples: Vec<Vec<u8>> = Vec::new();
            let mut span_start = 0u32;
            while let Some(tick) = reader.next_tick().expect("tick") {
                for (body, state) in tick.states.iter().enumerate() {
                    live.push(body as u64, tick.index, state);
                }
                if (tick.index + 1) % span == 0 {
                    for packet in live.finalize_span(span_start) {
                        samples.push(packet.payload);
                    }
                    span_start = tick.index + 1;
                }
            }
            let dict = zstd::dict::from_samples(&samples, 64 * 1024).expect("dict trains");
            println!(
                "dictionary: trained on {} packets from {train}, {} B",
                samples.len(),
                dict.len()
            );
            if let Ok(out) = std::env::var("LIVE_DICT_OUT") {
                std::fs::write(&out, &dict).expect("write dict");
                println!("dictionary written to {out}");
            }
            dict
        });

        for restate_period in [16u32, 32] {
            let mut reader = TraceReader::open(std::path::Path::new(&path)).expect("trace opens");
            // The same fidelity contract every offline comparison uses:
            // 0.5 cm masked, cap 20 mm.
            let mask = MaskConfig {
                enabled: true,
                base_m: 0.005,
                cap_m: 0.020,
                ..MaskConfig::default()
            };
            let mut live = LiveEncoder::new(LiveEncoderConfig {
                dt: 1.0 / hz as f32,
                gravity: reader.header.gravity,
                tolerances: Tolerances::new(0.005, 3.0, 0.15, 0.5, mask),
                sleep: SleepPolicy {
                    linear_mps: 0.0,
                    angular_rps: 0.0,
                    ticks: 0,
                },
                restate_period,
                initial_capacity: body_count,
            });
            for body in 0..body_count as u64 {
                live.add_body(body, radii[body as usize]);
            }
            let (mut raw, mut zstd_bytes, mut packets, mut ticks) = (0u64, 0u64, 0u64, 0u32);
            let mut dict_bytes = 0u64;
            let mut span_start = 0u32;
            // Per-kind census: counts + encoded bytes, to diff against the
            // block wire's debris_report on the identical trace/config.
            let mut kind_counts = [0u64; 5]; // seg-g, imp, run, rest, seg-nog
            let mut kind_bytes = [0u64; 5];
            let mut frames_total = 0u64;
            let mut chained_runs = 0u64;
            let empty_tails: Vec<Option<([i32; 3], u64)>> = vec![None; body_count];
            // Decomposition: the same records encoded as one v1 block per span
            // (the offline wire), one v2 block per span (wire version cost),
            // and the real packetized form (framing + grouping cost).
            let mut mono_v1 = 0u64;
            let mut mono_v2 = 0u64;
            let mut mono_v1_tails: Vec<Option<([i32; 3], u64)>> = vec![None; body_count];
            let mut mono_v2_tails: Vec<Option<([i32; 3], u64)>> = vec![None; body_count];
            while let Some(tick) = reader.next_tick().expect("tick") {
                for (body, state) in tick.states.iter().enumerate() {
                    live.push(body as u64, tick.index, state);
                }
                ticks = tick.index + 1;
                if (tick.index + 1) % span == 0 {
                    let (packets_out, span_records) =
                        live.finalize_span_tapped(span_start);
                    for record in &span_records {
                        let slot = match record {
                            Record::Segment { gravity: true, .. } => 0,
                            Record::Impulse { .. } => 1,
                            Record::SampleRun {
                                frames, continuity, ..
                            } => {
                                frames_total += frames.len() as u64;
                                if *continuity {
                                    chained_runs += 1;
                                }
                                2
                            }
                            Record::Rest { .. } => 3,
                            Record::Segment { gravity: false, .. } => 4,
                        };
                        kind_counts[slot] += 1;
                        kind_bytes[slot] +=
                            record.encoded_len(span_start, &empty_tails, true) as u64;
                    }
                    let mut clone_v1 = span_records.clone();
                    mono_v1 += encode_block(&mut clone_v1, span_start, &mut mono_v1_tails, false)
                        .len() as u64;
                    let mut clone_v2 = span_records.clone();
                    mono_v2 += encode_block(&mut clone_v2, span_start, &mut mono_v2_tails, true)
                        .len() as u64;
                    for packet in packets_out {
                        raw += packet.payload.len() as u64 + 8; // live header
                        zstd_bytes += zstd::bulk::compress(&packet.payload, 3)
                            .expect("zstd")
                            .len() as u64
                            + 8;
                        if let Some(dict) = &dictionary {
                            dict_bytes += zstd::bulk::Compressor::with_dictionary(3, dict)
                                .expect("dict compressor")
                                .compress(&packet.payload)
                                .expect("dict compress")
                                .len() as u64
                                + 8;
                        }
                        packets += 1;
                    }
                    span_start = tick.index + 1;
                }
            }
            let seconds = f64::from(ticks) / f64::from(hz);
            println!(
                "restate_period={restate_period:>2}  packets {packets:>7}  raw {:>9} B ({:.3} Mbps)  zstd {:>9} B ({:.3} Mbps)",
                raw,
                raw as f64 * 8.0 / seconds / 1.0e6,
                zstd_bytes,
                zstd_bytes as f64 * 8.0 / seconds / 1.0e6
            );
            if dictionary.is_some() {
                println!(
                    "  with dictionary {:>9} B ({:.3} Mbps)",
                    dict_bytes,
                    dict_bytes as f64 * 8.0 / seconds / 1.0e6
                );
            }
            println!(
                "  mono-block v1 {:>9} B ({:.3} Mbps) | mono v2 {:>9} B | packetized raw {:>9} B",
                mono_v1,
                mono_v1 as f64 * 8.0 / seconds / 1.0e6,
                mono_v2,
                raw
            );
            println!(
                "  continuity runs {chained_runs} of {} ({:.1}%)",
                kind_counts[2],
                100.0 * chained_runs as f64 / kind_counts[2].max(1) as f64
            );
            println!(
                "  segments {} ({} B) | impulses {} ({} B) | sample-runs {} ({} frames, {} B) | rests {} ({} B) | seg-nog {} ({} B)",
                kind_counts[0], kind_bytes[0],
                kind_counts[1], kind_bytes[1],
                kind_counts[2], frames_total, kind_bytes[2],
                kind_counts[3], kind_bytes[3],
                kind_counts[4], kind_bytes[4]
            );
        }
    }
}
