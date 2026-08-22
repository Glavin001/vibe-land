//! Browser decoder for the wire-v3 debris stream.
//!
//! One wasm module, three calls a frame at most: datagrams in, poses out.
//! The heavy machinery -- dictionary decompression, block decode, the chain
//! gap rule, per-body trajectory evaluation -- is the same Rust the server
//! encodes with and the offline harness verified, which is the point: a TS
//! port of this codec would be a second implementation of quaternion packing
//! and sampled-chain reconstruction, drifting from day one.
//!
//! The API is LANE-indexed (the wire's dense record ids). The caller owns the
//! lane -> body-entity map, fed by the reliable PKT_CITY_LANES stream, because
//! entity mapping belongs with the topology ledger that already lives in TS.

use std::collections::HashMap;

use glam::Vec3;
use wasm_bindgen::prelude::*;

use crate::debris_codec::Playback;
use crate::live::LiveDecoder;
use zstd::dict::DecoderDictionary;

#[wasm_bindgen]
pub struct DebrisDecoder {
    decoder: LiveDecoder,
    playbacks: HashMap<u32, Playback>,
    dictionary: DecoderDictionary<'static>,
    dt: f32,
    gravity: Vec3,
    /// Per-lane floor tick: records at or below it are dropped. Set on settle,
    /// retire and lane reassignment -- a recycled lane must not inherit its
    /// previous tenant's trajectory, and a body the reliable channel parked
    /// must not be resurrected by an in-flight span (netlab measured 402
    /// chunk teleports a minute from exactly these, worst 66.8 m).
    accept_after: HashMap<u32, u32>,
    /// Newest record tick applied per lane -- the latest-wins rule datagram
    /// transport demands. A reordered packet delivering an older span would
    /// otherwise yank every body it carries back in time for a frame, then
    /// snap forward when the next fresh span lands (measured as paired
    /// equal-magnitude teleports and one-frame multi-body bursts in netlab).
    newest: HashMap<u32, u32>,
    /// Lane-map epoch at which each lane's current tenant was assigned
    /// (u8 serial arithmetic). A record from a packet whose stamped epoch is
    /// OLDER than the lane's assignment belongs to the previous tenant --
    /// the packet was in flight when the lane changed hands -- and applying
    /// it would draw one body with another's trajectory (the 78 m
    /// cross-tenant excursions measured at 29k migrations/min).
    assigned_epoch: HashMap<u32, u8>,
    /// Newest epoch seen on any datagram -- the receiver's notion of "now"
    /// on the epoch counter. Needed because assignments are fixed points on
    /// a wrapping counter: without an age bound, a lane assigned 128+ bumps
    /// ago wraps into the "future" and its records are refused forever
    /// (measured: 541k excess steps -- the whole stream starved). The drop
    /// rule therefore only applies while the assignment is RECENT; races
    /// resolve within a second, ancient assignments accept everything.
    latest_epoch: u8,
    /// Diagnostic ring: last 8 applied records per lane as
    /// (tick, kind, x, y, z); read back by `lane_history` when the client's
    /// jump detector fires. Cheap enough to keep on always.
    history: HashMap<u32, std::collections::VecDeque<(u32, u8, [f32; 3])>>,
}

#[wasm_bindgen]
impl DebrisDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(dictionary: &[u8], max_lanes: u32, sim_hz: u32) -> DebrisDecoder {
        console_error_panic_hook::set_once();
        DebrisDecoder {
            decoder: LiveDecoder::new(max_lanes as usize),
            playbacks: HashMap::new(),
            // Digested once; per-packet dictionary creation measured 76 ms
            // per span server-side, and the browser pays the same digest.
            dictionary: DecoderDictionary::copy(dictionary),
            dt: 1.0 / sim_hz.max(1) as f32,
            gravity: Vec3::new(0.0, -9.81, 0.0),
            accept_after: HashMap::new(),
            newest: HashMap::new(),
            assigned_epoch: HashMap::new(),
            latest_epoch: 0,
            history: HashMap::new(),
        }
    }

    /// Apply one debris payload (framing already stripped by the caller).
    /// `compression`: 0 = raw, 1 = zstd with the shipped dictionary.
    /// `epoch`: the lane-map revision stamped in the datagram header.
    /// Returns how many records were applied.
    pub fn push_payload(&mut self, compression: u8, epoch: u8, body: &[u8]) -> Result<u32, JsError> {
        let payload: Vec<u8> = match compression {
            0 => body.to_vec(),
            1 => zstd::bulk::Decompressor::with_prepared_dictionary(&self.dictionary)
                .and_then(|mut decompressor| decompressor.decompress(body, 64 * 1024))
                .map_err(|error| JsError::new(&format!("decompress: {error}")))?,
            other => return Err(JsError::new(&format!("unknown compression tag {other}"))),
        };
        if (epoch.wrapping_sub(self.latest_epoch) as i8) > 0 {
            self.latest_epoch = epoch;
        }
        let records = self
            .decoder
            .push_packet(&payload)
            .map_err(|error| JsError::new(&format!("decode: {error}")))?;
        let mut applied = 0u32;
        let mut payload_newest: HashMap<u32, u32> = HashMap::new();
        for record in records {
            if let Some(&floor) = self.accept_after.get(&record.body()) {
                if record.tick() <= floor {
                    continue;
                }
            }
            // Epoch ordering: drop records encoded before this lane's current
            // assignment. Serial compare on a wrapping u8, valid only while
            // the assignment is recent (age < 64 bumps relative to the newest
            // epoch seen); older assignments have no live race to lose and
            // accept everything -- the age bound is what keeps a fixed
            // assignment from wrapping into the "future".
            if let Some(&assigned) = self.assigned_epoch.get(&record.body()) {
                let age = self.latest_epoch.wrapping_sub(assigned);
                if age < 64 && (epoch.wrapping_sub(assigned) as i8) < 0 {
                    continue;
                }
            }
            // Latest wins per lane. Spans arrive body-atomic (one packet per
            // body per span), so a record at or before a PREVIOUS payload's
            // newest tick for its lane is a reordered or duplicated datagram
            // -- applying it would yank the body back in time for a frame.
            // Records within this payload may legitimately share ticks, so
            // the high-water mark commits only after the loop.
            if let Some(&newest) = self.newest.get(&record.body()) {
                if record.tick() <= newest {
                    continue;
                }
            }
            let mark = payload_newest.entry(record.body()).or_insert(0);
            *mark = (*mark).max(record.tick());
            let ring = self.history.entry(record.body()).or_default();
            if ring.len() >= 8 {
                ring.pop_front();
            }
            ring.push_back((
                record.tick(),
                record.debug_kind(),
                record.debug_position().unwrap_or([f32::NAN; 3]),
            ));
            applied += 1;
            self.playbacks
                .entry(record.body())
                .or_default()
                .events
                .push(record);
        }
        for (lane, tick) in payload_newest {
            let entry = self.newest.entry(lane).or_insert(0);
            *entry = (*entry).max(tick);
        }
        Ok(applied)
    }

    /// Lanes whose chains a lost packet poisoned since the last drain; the
    /// caller maps them to entities and nacks the server.
    pub fn drain_poisoned(&mut self) -> Vec<u32> {
        self.decoder.drain_poisoned()
    }

    /// Sample every live lane at `render_tick` into flat arrays:
    /// `lanes_out[i]`, `poses_out[i*7..i*7+7]` = xyz + quat xyzw.
    /// Returns the number filled. One FFI call per frame.
    pub fn sample_into(
        &mut self,
        render_tick: u32,
        lanes_out: &mut [u32],
        poses_out: &mut [f32],
    ) -> u32 {
        let capacity = lanes_out.len().min(poses_out.len() / 7);
        let mut filled = 0usize;
        for (&lane, playback) in self.playbacks.iter_mut() {
            if filled >= capacity {
                break;
            }
            playback.advance_to(render_tick, self.dt, self.gravity);
            let Some(pose) = playback.pose_at(render_tick, self.dt, self.gravity) else {
                continue;
            };
            lanes_out[filled] = lane;
            let at = filled * 7;
            poses_out[at] = pose.position.x;
            poses_out[at + 1] = pose.position.y;
            poses_out[at + 2] = pose.position.z;
            poses_out[at + 3] = pose.rotation.x;
            poses_out[at + 4] = pose.rotation.y;
            poses_out[at + 5] = pose.rotation.z;
            poses_out[at + 6] = pose.rotation.w;
            filled += 1;
        }
        filled as u32
    }

    /// Forget a lane (its body settled or retired; the reliable channel owns
    /// its pose from here). Also bounds memory: consumed events are dropped.
    pub fn clear_lane(&mut self, lane: u32) {
        self.playbacks.remove(&lane);
    }

    /// Forget a lane AND refuse records at or before `tick` -- the settle /
    /// retire / reassignment guard.
    pub fn clear_lane_until(&mut self, lane: u32, tick: u32) {
        self.playbacks.remove(&lane);
        self.accept_after.insert(lane, tick);
    }

    /// Forget EVERY lane: the world was replaced (city reset / bootstrap).
    /// Lane ids are reused from zero by a rebuilt server encoder and its
    /// epoch restarts, so any surviving per-lane state would misroute the
    /// new world's records to the old world's bodies.
    pub fn reset_all_lanes(&mut self) {
        self.playbacks.clear();
        self.accept_after.clear();
        self.newest.clear();
        self.assigned_epoch.clear();
        self.history.clear();
        self.latest_epoch = 0;
    }

    /// Record that `lane` was (re)assigned at lane-map revision `epoch` and
    /// forget the previous tenant's trajectory. Records from packets stamped
    /// with an older epoch will be refused; records at or after it belong to
    /// the new tenant, including any that raced ahead of the reliable map.
    pub fn assign_lane(&mut self, lane: u32, epoch: u8) {
        self.playbacks.remove(&lane);
        self.newest.remove(&lane);
        self.assigned_epoch.insert(lane, epoch);
    }

    /// Diagnostic: last applied records for a lane, flattened as
    /// [tick, kind, x, y, z] per record. kind: 0 segment, 1 impulse,
    /// 2 sample run, 3 continuity rider, 4 rest.
    pub fn lane_history(&self, lane: u32) -> Vec<f32> {
        let mut out = Vec::new();
        if let Some(ring) = self.history.get(&lane) {
            for &(tick, kind, pos) in ring {
                out.push(tick as f32);
                out.push(kind as f32);
                out.extend_from_slice(&pos);
            }
        }
        out
    }

    pub fn lane_count(&self) -> u32 {
        self.playbacks.len() as u32
    }
}
