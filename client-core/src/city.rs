//! The city: the manifest's chunk table and the wire 4 per-player stream.
//!
//! The stream is `perplayer::client::Client`, the same core the browser runs through WASM and the
//! server tests against, built from `destruction::per_player::structure_defs` exactly as the server
//! derives each client's structures. This module only turns its output into the frame's chunk
//! assignments and body poses, in the renderer's space.

use std::collections::HashMap;

use glam::{Quat, Vec3};
use sha2::{Digest, Sha256};
use vibe_land_destruction::manifest::{ChunkGeometry, DestructionManifest};
use vibe_land_destruction::{manifest_binary, per_player::structure_defs};
use vibe_land_perplayer::client::{BodyChange, Client};
use vibe_land_perplayer::predict::Physics;
use vibe_land_perplayer::structure::REMOVED;
use vibe_land_perplayer::wire::{encode_ack, encode_ack_missing, BodyKey, PKT_PP_BOOTSTRAP, PKT_PP_EVENTS, PKT_PP_KEYFRAMES};

use crate::coords::Space;
use crate::frame::*;

/// Playout delay of the city stream, ticks (the browser's `delayTicks`).
pub const CITY_DELAY_TICKS: f32 = 5.0;
/// How often the client acks keyframe datagrams (the browser: 33 ms).
pub const ACK_INTERVAL_MS: f64 = 33.0;
/// The least time between resync requests while hashes keep disagreeing (the browser: 3 s).
pub const RESYNC_INTERVAL_MS: f64 = 3000.0;
/// Chunks whose world centre is below this are drawn nowhere (the browser hides them too).
const HIDE_BELOW_Y_M: f32 = -4.0;
const DEFAULT_COLOR: u32 = 0x9A9A9AFF;

/// Is `kind` a wire 4 city packet for [`CityStream::ingest`]?
pub fn is_city_packet(kind: u8) -> bool {
    matches!(kind, PKT_PP_KEYFRAMES | PKT_PP_EVENTS | PKT_PP_BOOTSTRAP)
}

#[derive(Debug, PartialEq, Eq)]
pub enum ManifestError {
    HashMismatch { expected: String, actual: String },
    Decode(String),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::HashMismatch { expected, actual } => write!(f, "city manifest hash {actual} is not the session's {expected}"),
            ManifestError::Decode(e) => write!(f, "city manifest: {e}"),
        }
    }
}

/// Check the manifest's bytes against the session's hash and decode them.
pub fn decode_manifest(bytes: &[u8], expected_hash: Option<&str>) -> Result<DestructionManifest, ManifestError> {
    if let Some(expected) = expected_hash.filter(|h| !h.is_empty()) {
        let actual = hex::encode(Sha256::digest(bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(ManifestError::HashMismatch { expected: expected.to_string(), actual });
        }
    }
    manifest_binary::decode(bytes).map_err(|e| ManifestError::Decode(format!("{e:?}")))
}

pub struct CityStream {
    client: Client,
    space: Space,
    chunks: Vec<VlChunk>,
    chunk_index: HashMap<(u32, u32), u32>,
    /// Per structure, its chunks' indices in node order.
    structure_chunks: HashMap<u32, Vec<(u32, u32)>>,
    /// Last pose written per body, to send only bodies that moved.
    last_pose: HashMap<BodyKey, (Vec3, Quat, bool)>,
    last_ack_ms: f64,
    last_resync_ms: f64,
    mismatches_seen: u64,
    pub fractures: u64,
    pub resync_requests: u64,
    pub acks_sent: u64,
}

impl CityStream {
    pub fn new(manifest: &DestructionManifest, sim_hz: u32, space: Space) -> Self {
        let gravity_y = -(vibe_netcode::movement::GRAVITY as f32);
        let client = Client::new(structure_defs(manifest), Physics::at_hz(sim_hz, gravity_y), sim_hz, CITY_DELAY_TICKS);

        let colors: Vec<u32> = manifest
            .material_appearance
            .iter()
            .map(|a| a.color.as_deref().and_then(parse_hex_color).unwrap_or(DEFAULT_COLOR))
            .collect();

        let mut chunks = Vec::new();
        let mut chunk_index = HashMap::new();
        let mut structure_chunks: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        for s in &manifest.structures {
            let world_p = Vec3::from_array(s.world_position);
            let world_q = Quat::from_array(s.world_rotation).normalize();
            for c in &s.chunks {
                let index = chunks.len() as u32;
                let rest = world_p + world_q * Vec3::from_array(c.centroid);
                let mut flags = 0;
                if c.support {
                    flags |= VL_CHUNK_SUPPORT;
                }
                if matches!(c.geometry, ChunkGeometry::ConvexHull { .. }) {
                    flags |= VL_CHUNK_HULL;
                }
                chunks.push(VlChunk {
                    structure: s.structure_id,
                    node: c.node_index,
                    rest_pos: space.pos(rest),
                    rest_quat: space.quat(world_q),
                    extents: space.extents(Vec3::from_array(c.size)),
                    color_rgba: colors.get(c.material as usize).copied().unwrap_or(DEFAULT_COLOR),
                    flags,
                });
                chunk_index.insert((s.structure_id, c.node_index), index);
                structure_chunks.entry(s.structure_id).or_default().push((c.node_index, index));
            }
        }

        Self {
            client,
            space,
            chunks,
            chunk_index,
            structure_chunks,
            last_pose: HashMap::new(),
            last_ack_ms: f64::NEG_INFINITY,
            last_resync_ms: f64::NEG_INFINITY,
            mismatches_seen: 0,
            fractures: 0,
            resync_requests: 0,
            acks_sent: 0,
        }
    }

    pub fn chunks(&self) -> &[VlChunk] {
        &self.chunks
    }

    pub fn ingest(&mut self, bytes: &[u8], arrival_ms: f64) {
        self.client.ingest(bytes, arrival_ms);
    }

    /// Advance the stream to `now_ms` and write what changed into `frame`. Returns the render tick.
    pub fn advance(&mut self, now_ms: f64, frame: &mut SceneFrame) -> Option<f32> {
        let render = self.client.advance(now_ms);

        for change in self.client.drain_body_changes() {
            match change {
                BodyChange::Reset => {
                    self.last_pose.clear();
                    let structures: Vec<u32> = self.structure_chunks.keys().copied().collect();
                    for structure in structures {
                        self.reassign_structure(structure, frame);
                    }
                }
                BodyChange::Fracture { structure, removed_chunks, changed, .. } => {
                    self.fractures += 1;
                    for node in removed_chunks {
                        self.assign(structure, node, frame);
                    }
                    for (_, members) in changed {
                        for node in members {
                            self.assign(structure, node, frame);
                        }
                    }
                }
            }
        }

        for (key, p, q, settled) in self.client.body_poses() {
            if !self.structure_chunks.contains_key(&key.structure) {
                continue; // a car's detached group: vehicles come later
            }
            let settled = settled.is_some();
            let moved = match self.last_pose.get(&key) {
                Some(&(lp, lq, ls)) => ls != settled || lp.distance_squared(p) > 1e-10 || lq.dot(q).abs() < 1.0 - 1e-9,
                None => true,
            };
            if moved {
                self.last_pose.insert(key, (p, q, settled));
                frame.body_poses.push(VlBodyPose {
                    structure: key.structure,
                    body: key.body,
                    pos: self.space.pos(p),
                    quat: self.space.quat(q),
                    flags: if settled { VL_POSE_SETTLED } else { 0 },
                });
            }
        }
        render
    }

    /// Every chunk of `structure` from the client's current state (after a bootstrap).
    fn reassign_structure(&mut self, structure: u32, frame: &mut SceneFrame) {
        let nodes: Vec<u32> = self.structure_chunks.get(&structure).map(|v| v.iter().map(|&(n, _)| n).collect()).unwrap_or_default();
        for node in nodes {
            self.assign(structure, node, frame);
        }
    }

    fn assign(&self, structure: u32, node: u32, frame: &mut SceneFrame) {
        let Some(&chunk) = self.chunk_index.get(&(structure, node)) else { return };
        let (body, local) = match self.client.chunk_body(structure, node) {
            None => (VL_BODY_STANDING, [0.0; 3]),
            Some(REMOVED) => (VL_BODY_REMOVED, [0.0; 3]),
            Some(id) => (id, self.space.pos(self.client.chunk_local(structure, node))),
        };
        frame.assignments.push(VlChunkAssignment { chunk, structure, body, local_pos: local });
    }

    /// The keyframe ack, every [`ACK_INTERVAL_MS`].
    pub fn ack(&mut self, now_ms: f64) -> Option<Vec<u8>> {
        if now_ms - self.last_ack_ms < ACK_INTERVAL_MS {
            return None;
        }
        let (newest, mask) = self.client.ack()?;
        self.last_ack_ms = now_ms;
        let missing = self.client.take_missing_baselines();
        let events_through = self.client.events_through();
        self.acks_sent += 1;
        Some(if missing.is_empty() {
            encode_ack(newest, mask, Some(events_through))
        } else {
            encode_ack_missing(newest, mask, events_through, &missing)
        })
    }

    /// A resync request when the structure hashes disagree, at most every [`RESYNC_INTERVAL_MS`].
    pub fn resync(&mut self, now_ms: f64) -> Option<Vec<u8>> {
        let mismatches = self.client.stats.hash_mismatches;
        if mismatches <= self.mismatches_seen || now_ms - self.last_resync_ms < RESYNC_INTERVAL_MS {
            return None;
        }
        self.mismatches_seen = mismatches;
        self.last_resync_ms = now_ms;
        self.resync_requests += 1;
        Some(vibe_land_shared::net_client::encode_city_resync_request(0))
    }

    pub fn write_stats(&self, stats: &mut VlStats) {
        let s = &self.client.stats;
        stats.chunks = self.chunks.len() as u32;
        stats.live_bodies = self.last_pose.len() as u32;
        stats.decode_errors = s.decode_errors;
        stats.keyframes = s.keyframes;
        stats.late_keyframes = s.late_keyframes;
        stats.events_applied = s.events_applied;
        stats.hash_checks = s.hash_checks;
        stats.hash_mismatches = s.hash_mismatches;
        stats.bootstraps = s.bootstraps;
        stats.fractures = self.fractures;
        stats.resync_requests = self.resync_requests;
        stats.acks_sent = self.acks_sent;
    }

    /// For tests and debug views: the world pose of a chunk now, in server space.
    pub fn chunk_world_server(&self, structure: u32, node: u32) -> Option<(Vec3, Quat)> {
        let cs = self.client.structures.get(&structure)?;
        let world_q = cs.def.world_rotation;
        match self.client.chunk_body(structure, node) {
            None => Some((cs.def.world_position + world_q * cs.def.rest[node as usize], world_q)),
            Some(REMOVED) => None,
            Some(id) => {
                let (p, q) = self.client.track(BodyKey { structure, body: id })?.pose_at(self.client.render_tick(), self.client.physics);
                Some((p + q * self.client.chunk_local(structure, node), q))
            }
        }
    }

    pub fn hidden_below_y_m() -> f32 {
        HIDE_BELOW_Y_M
    }
}

/// `#rrggbb` or `rrggbb` (optionally `#rrggbbaa`) to 0xRRGGBBAA.
fn parse_hex_color(text: &str) -> Option<u32> {
    let hex = text.trim().trim_start_matches('#');
    match hex.len() {
        6 => u32::from_str_radix(hex, 16).ok().map(|rgb| (rgb << 8) | 0xFF),
        8 => u32::from_str_radix(hex, 16).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_parse() {
        assert_eq!(parse_hex_color("#ff8000"), Some(0xFF8000FF));
        assert_eq!(parse_hex_color("11223344"), Some(0x11223344));
        assert_eq!(parse_hex_color("nope"), None);
    }

    #[test]
    fn a_manifest_with_the_wrong_hash_is_refused() {
        let err = decode_manifest(b"not a manifest", Some("00")).unwrap_err();
        assert!(matches!(err, ManifestError::HashMismatch { .. }));
    }
}
