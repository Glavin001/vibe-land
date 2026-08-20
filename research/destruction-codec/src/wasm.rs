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

#[wasm_bindgen]
pub struct DebrisDecoder {
    decoder: LiveDecoder,
    playbacks: HashMap<u32, Playback>,
    dictionary: Vec<u8>,
    dt: f32,
    gravity: Vec3,
}

#[wasm_bindgen]
impl DebrisDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(dictionary: &[u8], max_lanes: u32, sim_hz: u32) -> DebrisDecoder {
        console_error_panic_hook::set_once();
        DebrisDecoder {
            decoder: LiveDecoder::new(max_lanes as usize),
            playbacks: HashMap::new(),
            dictionary: dictionary.to_vec(),
            dt: 1.0 / sim_hz.max(1) as f32,
            gravity: Vec3::new(0.0, -9.81, 0.0),
        }
    }

    /// Apply one debris payload (framing already stripped by the caller).
    /// `compression`: 0 = raw, 1 = zstd with the shipped dictionary.
    /// Returns how many records were applied.
    pub fn push_payload(&mut self, compression: u8, body: &[u8]) -> Result<u32, JsError> {
        let payload: Vec<u8> = match compression {
            0 => body.to_vec(),
            1 => zstd::bulk::Decompressor::with_dictionary(&self.dictionary)
                .and_then(|mut decompressor| decompressor.decompress(body, 64 * 1024))
                .map_err(|error| JsError::new(&format!("decompress: {error}")))?,
            other => return Err(JsError::new(&format!("unknown compression tag {other}"))),
        };
        let records = self
            .decoder
            .push_packet(&payload)
            .map_err(|error| JsError::new(&format!("decode: {error}")))?;
        let applied = records.len() as u32;
        for record in records {
            self.playbacks
                .entry(record.body())
                .or_default()
                .events
                .push(record);
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

    pub fn lane_count(&self) -> u32 {
        self.playbacks.len() as u32
    }
}
