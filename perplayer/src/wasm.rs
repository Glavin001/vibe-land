//! The per-player client for the browser: `client::Client` behind
//! wasm-bindgen, with flat typed-array exchange so a frame costs one call
//! and one copy, not one per body.

use glam::{Quat, Vec3};
use wasm_bindgen::prelude::*;

use crate::client::{BodyChange, Client};
use crate::predict::Physics;
use crate::structure::StructureDef;

/// Floats per node in `PerPlayerClient::new`'s `nodes`.
const NODE_STRIDE: usize = 11;

#[wasm_bindgen]
pub struct PerPlayerClient {
    inner: Client,
}

#[wasm_bindgen]
impl PerPlayerClient {
    /// The structures, flattened: per structure its id, world position (3),
    /// world rotation (4), node count and bond count; per node (all
    /// structures in order) rest (3), mass centre (3), mass, support (0/1)
    /// and the chunk box's half extents (3); per bond its two nodes.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ids: &[u32],
        poses: &[f32],
        node_counts: &[u32],
        bond_counts: &[u32],
        nodes: &[f32],
        bonds: &[u32],
        hz: u32,
        gravity_y: f32,
        delay_ticks: f32,
    ) -> PerPlayerClient {
        let mut defs = Vec::with_capacity(ids.len());
        let (mut n_at, mut b_at) = (0usize, 0usize);
        for (i, &id) in ids.iter().enumerate() {
            let p = &poses[i * 7..i * 7 + 7];
            let n = node_counts[i] as usize;
            let (mut rest, mut mass_center, mut mass, mut support, mut half) =
                (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
            for k in 0..n {
                let v = &nodes[(n_at + k) * NODE_STRIDE..(n_at + k) * NODE_STRIDE + NODE_STRIDE];
                rest.push(Vec3::new(v[0], v[1], v[2]));
                mass_center.push(Vec3::new(v[3], v[4], v[5]));
                mass.push(v[6]);
                support.push(v[7] != 0.0);
                half.push(Vec3::new(v[8], v[9], v[10]));
            }
            n_at += n;
            let b = bond_counts[i] as usize;
            let list = (0..b).map(|k| (bonds[(b_at + k) * 2], bonds[(b_at + k) * 2 + 1])).collect();
            b_at += b;
            defs.push(StructureDef::new(
                id,
                Vec3::new(p[0], p[1], p[2]),
                Quat::from_xyzw(p[3], p[4], p[5], p[6]).normalize(),
                rest,
                mass_center,
                mass,
                support,
                list,
            )
            .with_half_extents(half));
        }
        PerPlayerClient { inner: Client::new(defs, Physics::at_hz(hz, gravity_y), hz, delay_ticks) }
    }

    pub fn ingest(&mut self, bytes: &[u8], arrival_ms: f64) {
        self.inner.ingest(bytes, arrival_ms);
    }

    /// Apply what the render tick has reached; the render tick, or NaN
    /// before the clock has a sample.
    pub fn advance(&mut self, now_ms: f64) -> f32 {
        self.inner.advance(now_ms).unwrap_or(f32::NAN)
    }

    pub fn started(&self) -> bool {
        self.inner.started()
    }

    /// Every live dynamic body: [structure, body, px, py, pz, qx, qy, qz,
    /// qw, settled] each.
    pub fn body_poses(&self) -> Vec<f32> {
        let poses = self.inner.body_poses();
        let mut out = Vec::with_capacity(poses.len() * 10);
        for (key, p, q, settled) in poses {
            // Last: 0 while it moves; at rest, 1 + the tick it settled at.
            let rest = settled.map_or(0.0, |t| t as f32 + 1.0);
            out.extend_from_slice(&[key.structure as f32, key.body as f32, p.x, p.y, p.z, q.x, q.y, q.z, q.w, rest]);
        }
        out
    }

    /// Structural changes since the last drain, flattened: per change a kind
    /// (0 fracture, 1 reset); a fracture continues with tick, structure, then
    /// counted lists: broken bonds, removed chunks, retired bodies, and
    /// changed bodies as (id, member count, members...).
    pub fn drain_changes(&mut self) -> Vec<u32> {
        let mut out = Vec::new();
        for change in self.inner.drain_body_changes() {
            match change {
                BodyChange::Reset => out.push(1),
                BodyChange::Fracture { tick, structure, broken_bonds, removed_chunks, retired, changed } => {
                    out.extend_from_slice(&[0, tick, structure]);
                    for list in [&broken_bonds, &removed_chunks, &retired] {
                        out.push(list.len() as u32);
                        out.extend_from_slice(list);
                    }
                    out.push(changed.len() as u32);
                    for (id, members) in changed {
                        out.push(id);
                        out.push(members.len() as u32);
                        out.extend_from_slice(&members);
                    }
                }
            }
        }
        out
    }

    /// The whole structural state, for a ledger rebuilt after a bootstrap:
    /// per dynamic body [structure, id, member count, members...], then
    /// u32::MAX, then per removed chunk [structure, node].
    pub fn structure_flat(&self) -> Vec<u32> {
        let mut out = Vec::new();
        for (&id, cs) in &self.inner.structures {
            for (&body, members) in cs.state.bodies() {
                out.extend_from_slice(&[id, body, members.len() as u32]);
                out.extend_from_slice(members);
            }
        }
        out.push(u32::MAX);
        for (&id, cs) in &self.inner.structures {
            for node in 0..cs.def.node_count() {
                if cs.state.is_removed(node) {
                    out.extend_from_slice(&[id, node]);
                }
            }
        }
        out
    }

    /// A chunk's body (u32::MAX: standing) and offset on it.
    pub fn chunk_body(&self, structure: u32, node: u32) -> u32 {
        self.inner.chunk_body(structure, node).unwrap_or(u32::MAX)
    }

    /// [newest, mask low 32, mask high 32], or empty before any datagram.
    pub fn ack(&mut self) -> Vec<u32> {
        match self.inner.ack() {
            Some((newest, mask)) => vec![newest, mask as u32, (mask >> 32) as u32, self.inner.events_through()],
            None => Vec::new(),
        }
    }

    pub fn render_tick(&self) -> f32 {
        self.inner.render_tick()
    }

    /// The structure-hash disagreements so far (`stats_json`'s
    /// hashMismatches), read every frame without building the JSON.
    pub fn hash_mismatches(&self) -> u32 {
        self.inner.stats.hash_mismatches as u32
    }

    pub fn stats_json(&self) -> String {
        let s = &self.inner.stats;
        format!(
            "{{\"keyframes\":{},\"lateKeyframes\":{},\"eventsApplied\":{},\"eventsLate\":{},\"hashChecks\":{},\"hashMismatches\":{},\"decodeErrors\":{},\"bootstraps\":{},\"missingBaselines\":{}}}",
            s.keyframes, s.late_keyframes, s.events_applied, s.events_late, s.hash_checks, s.hash_mismatches, s.decode_errors, s.bootstraps, s.missing_baselines
        )
    }
}
