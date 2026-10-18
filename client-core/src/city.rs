//! The city: the manifest's chunk table and the wire 4 per-player stream.
//!
//! The stream is `perplayer::client::Client`, the same core the browser runs through WASM and the
//! server tests against, built from `destruction::per_player::structure_defs` exactly as the server
//! derives each client's structures. This module only turns its output into the frame's chunk
//! assignments and body poses, in the renderer's space.

use std::collections::HashMap;

use glam::{Quat, Vec3};
use sha2::{Digest, Sha256};
use vibe_land_destruction::manifest::{ChunkDef, ChunkGeometry, DestructionManifest};
use vibe_land_destruction::{manifest_binary, per_player::structure_defs};
use vibe_land_perplayer::client::{BodyChange, Client};
use vibe_land_perplayer::predict::Physics;
use vibe_land_perplayer::structure::REMOVED;
use vibe_land_perplayer::wire::{
    encode_ack, encode_ack_missing, BodyKey, PKT_PP_BOOTSTRAP, PKT_PP_EVENTS, PKT_PP_KEYFRAMES,
    VEHICLE_STRUCTURE_BASE,
};

use crate::coords::Space;
use crate::effects::{
    classify_motion_impact, MotionSample, Source, SourceKind, SourceState, SourceTable,
};
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
            ManifestError::HashMismatch { expected, actual } => write!(
                f,
                "city manifest hash {actual} is not the session's {expected}"
            ),
            ManifestError::Decode(e) => write!(f, "city manifest: {e}"),
        }
    }
}

/// Check the manifest's bytes against the session's hash and decode them.
pub fn decode_manifest(
    bytes: &[u8],
    expected_hash: Option<&str>,
) -> Result<DestructionManifest, ManifestError> {
    if let Some(expected) = expected_hash.filter(|h| !h.is_empty()) {
        let actual = hex::encode(Sha256::digest(bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(ManifestError::HashMismatch {
                expected: expected.to_string(),
                actual,
            });
        }
    }
    manifest_binary::decode(bytes).map_err(|e| ManifestError::Decode(format!("{e:?}")))
}

/// A city as a renderer draws it before any of it breaks, built from the manifest alone (no
/// session): its hash, the chunk table and every chunk's mesh, exactly as a client builds them when
/// the manifest arrives. An import step bakes it into a renderer's own assets, keyed by the hash.
pub struct CityModel {
    /// The manifest's sha256 (hex), as the session config's `city_manifest_hash` names it.
    pub hash: String,
    pub chunks: Vec<crate::frame::VlChunk>,
    pub surfaces: Vec<crate::materials::VlChunkSurface>,
    pub meshes: crate::geometry::ChunkMeshes,
}

impl CityModel {
    pub fn from_manifest(bytes: &[u8], space: Space) -> Result<Self, ManifestError> {
        let manifest = decode_manifest(bytes, None)?;
        let (chunks, surfaces, meshes) = city_tables(&manifest, space);
        Ok(Self {
            hash: hex::encode(Sha256::digest(bytes)),
            chunks,
            surfaces,
            meshes,
        })
    }
}

/// The chunk table, the chunks' catalog surfaces and their meshes, in chunk-table order.
pub fn city_tables(
    manifest: &DestructionManifest,
    space: Space,
) -> (
    Vec<crate::frame::VlChunk>,
    Vec<crate::materials::VlChunkSurface>,
    crate::geometry::ChunkMeshes,
) {
    let catalog = crate::materials::Catalog::get();
    let surfaces = crate::materials::chunk_surfaces(manifest, catalog);
    let meshes = crate::geometry::ChunkMeshes::build_with_surfaces(
        manifest,
        space,
        Some((&surfaces, catalog)),
    );
    let chunks = chunk_table(manifest, space);
    (chunks, surfaces, meshes)
}

fn appearance_colors(manifest: &DestructionManifest) -> Vec<u32> {
    manifest
        .material_appearance
        .iter()
        .map(|a| {
            a.color
                .as_deref()
                .and_then(parse_hex_color)
                .unwrap_or(DEFAULT_COLOR)
        })
        .collect()
}

fn chunk_record(
    structure: u32,
    c: &ChunkDef,
    world_p: Vec3,
    world_q: Quat,
    colors: &[u32],
    space: Space,
) -> VlChunk {
    let rest = world_p + world_q * Vec3::from_array(c.centroid);
    let mut flags = 0;
    if c.support {
        flags |= VL_CHUNK_SUPPORT;
    }
    if matches!(c.geometry, ChunkGeometry::ConvexHull { .. }) {
        flags |= VL_CHUNK_HULL;
    }
    VlChunk {
        structure,
        node: c.node_index,
        rest_pos: space.pos(rest),
        rest_quat: space.quat(world_q),
        extents: space.extents(Vec3::from_array(c.size)),
        color_rgba: colors
            .get(c.material as usize)
            .copied()
            .unwrap_or(DEFAULT_COLOR),
        flags,
    }
}

/// The chunk table (structures in manifest order, then their chunks), as `CityStream` builds it.
pub fn chunk_table(manifest: &DestructionManifest, space: Space) -> Vec<VlChunk> {
    let colors = appearance_colors(manifest);
    let mut chunks = Vec::new();
    for s in &manifest.structures {
        let world_p = Vec3::from_array(s.world_position);
        let world_q = Quat::from_array(s.world_rotation).normalize();
        for c in &s.chunks {
            chunks.push(chunk_record(
                s.structure_id,
                c,
                world_p,
                world_q,
                &colors,
                space,
            ));
        }
    }
    chunks
}

/// A chunk's rest box (server space).
struct Occluder {
    structure: u32,
    node: u32,
    centre: Vec3,
    rotation: Quat,
    half: Vec3,
}

pub struct CityStream {
    client: Client,
    space: Space,
    chunks: Vec<VlChunk>,
    chunk_index: HashMap<(u32, u32), u32>,
    /// Per structure, its chunks' indices in node order.
    structure_chunks: HashMap<u32, Vec<(u32, u32)>>,
    /// Every chunk's box at rest, server space, for sound occlusion while it stands.
    occluders: Vec<Occluder>,
    /// Last pose written per body, to send only bodies that moved.
    last_pose: HashMap<BodyKey, (Vec3, Quat, bool)>,
    last_ack_ms: f64,
    last_resync_ms: f64,
    mismatches_seen: u64,
    pub fractures: u64,
    pub resync_requests: u64,
    pub acks_sent: u64,
    /// Destruction sources (fractures, crushed chunks, impacts) since the last drain, server space.
    pub(crate) sources: Vec<Source>,
    source_table: SourceTable,
    /// Entry, shed and wave memory (quiet cells, recent shots, impact cells).
    pub(crate) source_state: SourceState,
    physics: Physics,
    sim_hz: u32,
    /// Per moving body: its last motion sample and when it last raised an impact (ms).
    motion: HashMap<BodyKey, (MotionSample, f64)>,
    /// Per moving body: its audible size and acoustic material (fixed while it moves).
    motion_shape: HashMap<BodyKey, (f32, crate::audio::AcousticMaterial)>,
    /// This advance's moving bodies, for the fly-by tracker (server space).
    pub(crate) motions: Vec<crate::audio::Motion>,
}

impl CityStream {
    pub fn new(manifest: &DestructionManifest, sim_hz: u32, space: Space) -> Self {
        let gravity_y = -(vibe_netcode::movement::GRAVITY as f32);
        let physics = Physics::at_hz(sim_hz, gravity_y);
        let client = Client::new(structure_defs(manifest), physics, sim_hz, CITY_DELAY_TICKS);

        let colors = appearance_colors(manifest);

        let mut chunks = Vec::new();
        let mut chunk_index = HashMap::new();
        let mut structure_chunks: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        let mut occluders = Vec::new();
        for s in &manifest.structures {
            let world_p = Vec3::from_array(s.world_position);
            let world_q = Quat::from_array(s.world_rotation).normalize();
            for c in &s.chunks {
                let index = chunks.len() as u32;
                let rest = world_p + world_q * Vec3::from_array(c.centroid);
                chunks.push(chunk_record(
                    s.structure_id,
                    c,
                    world_p,
                    world_q,
                    &colors,
                    space,
                ));
                chunk_index.insert((s.structure_id, c.node_index), index);
                occluders.push(Occluder {
                    structure: s.structure_id,
                    node: c.node_index,
                    centre: rest,
                    rotation: world_q,
                    half: Vec3::from_array(c.size) * 0.5,
                });
                structure_chunks
                    .entry(s.structure_id)
                    .or_default()
                    .push((c.node_index, index));
            }
        }

        Self {
            client,
            space,
            chunks,
            chunk_index,
            structure_chunks,
            occluders,
            last_pose: HashMap::new(),
            last_ack_ms: f64::NEG_INFINITY,
            last_resync_ms: f64::NEG_INFINITY,
            mismatches_seen: 0,
            fractures: 0,
            resync_requests: 0,
            acks_sent: 0,
            sources: Vec::new(),
            source_table: SourceTable::new(manifest),
            source_state: SourceState::default(),
            physics,
            sim_hz,
            motion: HashMap::new(),
            motion_shape: HashMap::new(),
            motions: Vec::new(),
        }
    }

    /// The manifest facts destruction sources are made from.
    pub(crate) fn source_table(&self) -> &SourceTable {
        &self.source_table
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
                BodyChange::Fracture {
                    tick,
                    structure,
                    broken_bonds,
                    removed_chunks,
                    changed,
                    ..
                } => {
                    self.fractures += 1;
                    // Where it broke and how much: bonds clustered by cell, crushed chunks. Parted =
                    // the bond's two chunks now ride different bodies (the fracture is applied).
                    // Where each involved chunk is now (on a moving body it is not at rest): the
                    // map from a rest-space point riding a chunk to where it is drawn.
                    let mut riders: HashMap<u32, (Vec3, Vec3, Quat)> = HashMap::new();
                    let nodes = broken_bonds
                        .iter()
                        .filter_map(|b| self.source_table.bond_nodes(structure, *b).map(|(n, _)| n))
                        .chain(
                            changed
                                .iter()
                                .filter_map(|(_, members)| members.first().copied()),
                        );
                    for node in nodes {
                        if let (Some(rest), Some((now, q))) = (
                            self.chunk_rest_server(structure, node),
                            self.chunk_world_server(structure, node),
                        ) {
                            let world_q = self
                                .client
                                .structures
                                .get(&structure)
                                .map_or(Quat::IDENTITY, |cs| cs.def.world_rotation);
                            riders.insert(node, (rest, now, q * world_q.inverse()));
                        }
                    }
                    let locate = move |node: u32, x: Vec3| {
                        riders
                            .get(&node)
                            .map_or(x, |&(rest, now, turn)| now + turn * (x - rest))
                    };
                    let client = &self.client;
                    let born: Vec<(Vec3, f32)> = changed
                        .iter()
                        .map(|(_, members)| {
                            let (centre, mass) = self.source_table.island(structure, members);
                            (members.first().map_or(centre, |&n| locate(n, centre)), mass)
                        })
                        .collect();
                    self.source_table.fracture_sources(
                        structure,
                        tick,
                        &broken_bonds,
                        &removed_chunks,
                        &born,
                        |a, b| client.chunk_body(structure, a) != client.chunk_body(structure, b),
                        &locate,
                        &mut self.source_state,
                        now_ms,
                        &mut self.sources,
                    );
                    let mut sum = [0.0f32; 3];
                    let mut count = 0u32;
                    let mut note = |this: &Self, node: u32| {
                        if let Some(&i) = this.chunk_index.get(&(structure, node)) {
                            let p = this.chunks[i as usize].rest_pos;
                            for k in 0..3 {
                                sum[k] += p[k];
                            }
                            count += 1;
                        }
                    };
                    for &node in &removed_chunks {
                        note(self, node);
                        self.assign(structure, node, frame);
                    }
                    for (_, members) in changed {
                        for node in members {
                            note(self, node);
                            self.assign(structure, node, frame);
                        }
                    }
                    if count > 0 {
                        let n = count as f32;
                        frame.events.push(VlEvent {
                            kind: VL_EVENT_FRACTURE,
                            id: structure,
                            a: count,
                            p0: [sum[0] / n, sum[1] / n, sum[2] / n],
                            ..Default::default()
                        });
                    }
                }
            }
        }

        let mut car_groups = Vec::new();
        for (key, p, q, settled) in self.client.body_poses() {
            if vibe_land_perplayer::wire::is_vehicle_structure(key.structure) {
                car_groups.push((key, p, q));
                continue;
            }
            if !self.structure_chunks.contains_key(&key.structure) {
                continue;
            }
            let settled = settled.is_some();
            if let (Some(r), false) = (render, settled) {
                self.note_motion(key, p, r);
            } else if settled {
                self.motion.remove(&key);
                self.motion_shape.remove(&key);
            }
            let moved = match self.last_pose.get(&key) {
                Some(&(lp, lq, ls)) => {
                    ls != settled || lp.distance_squared(p) > 1e-10 || lq.dot(q).abs() < 1.0 - 1e-9
                }
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
        // Cars' detached groups: each part maps its authored geometry through the group's pose
        // about the group's centre (the web's presentVehicleDebris).
        let (groups, _) = self.client.vehicle_groups();
        for (key, p, q) in car_groups {
            let Some(group) = groups
                .get(&key.structure)
                .and_then(|g| g.iter().find(|g| g.body == key.body))
            else {
                continue;
            };
            let translation = p - q * group.centre;
            for &part in &group.members {
                frame.car_parts.push(VlCarPart {
                    handle: key.structure.saturating_sub(VEHICLE_STRUCTURE_BASE),
                    part,
                    pos: self.space.pos(translation),
                    quat: self.space.quat(q),
                });
            }
        }
        render
    }

    /// Impacts off the body velocity stream (motion.ts `classifyMotionImpact`): a body whose
    /// velocity drops sharply between render samples hit something; at most one every 220 ms.
    /// Whether a standing chunk lies on the segment from `from` to within `margin` of `to` (server
    /// space): the scene ray the web's AcousticOcclusion casts (occlusion.ts), against the boxes of
    /// the chunks still standing.
    pub fn segment_blocked(&self, from: Vec3, to: Vec3, margin: f32) -> bool {
        let d = from.distance(to);
        if d <= margin {
            return false;
        }
        let dir = (to - from) / d;
        let reach = d - margin;
        self.occluders.iter().any(|o| {
            // Cheap reject by the box's bounding sphere first.
            let r = o.half.length();
            let along = (o.centre - from).dot(dir).clamp(0.0, reach);
            if (from + dir * along).distance_squared(o.centre) > r * r {
                return false;
            }
            if self.client.chunk_body(o.structure, o.node).is_some() {
                return false; // it has broken loose
            }
            // Slab test in the box's frame.
            let inv = o.rotation.inverse();
            let (p, v) = (inv * (from - o.centre), inv * dir);
            let (mut t0, mut t1) = (0.0f32, reach);
            for k in 0..3 {
                let (pk, vk, hk) = (p[k], v[k], o.half[k]);
                if vk.abs() < 1e-8 {
                    if pk.abs() > hk {
                        return false;
                    }
                } else {
                    let (a, b) = ((-hk - pk) / vk, (hk - pk) / vk);
                    t0 = t0.max(a.min(b));
                    t1 = t1.min(a.max(b));
                    if t0 > t1 {
                        return false;
                    }
                }
            }
            true
        })
    }

    /// The chunks (node indices) a body holds now.
    fn members_of(&self, key: BodyKey) -> Vec<u32> {
        self.structure_chunks
            .get(&key.structure)
            .map(|nodes| {
                nodes
                    .iter()
                    .filter(|(n, _)| self.client.chunk_body(key.structure, *n) == Some(key.body))
                    .map(|(n, _)| *n)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn note_motion(&mut self, key: BodyKey, position: Vec3, render_tick: f32) {
        let Some(track) = self.client.track(key) else {
            return;
        };
        let (velocity, _) = track.velocity_at(render_tick, self.physics);
        let time_ms = f64::from(render_tick) / f64::from(self.sim_hz) * 1000.0;
        let mass_guess = 1.0;
        let sample = MotionSample {
            position,
            velocity,
            time_ms,
            mass: mass_guess,
        };
        if self.motion_shape.len() > 8192 {
            self.motion_shape.clear(); // retired bodies' entries
        }
        if !self.motion_shape.contains_key(&key) {
            let members = self.members_of(key);
            let radius = self.source_table.radius_of(key.structure, &members);
            let material = self.source_table.acoustic(
                members
                    .first()
                    .map_or(0, |&n| self.source_table.material_of(key.structure, n)),
            );
            self.motion_shape.insert(key, (radius, material));
        }
        let (size, material) = self.motion_shape[&key];
        self.motions.push(crate::audio::Motion {
            id: (u64::from(key.structure) << 32) | u64::from(key.body),
            position,
            velocity,
            time_ms,
            material,
            size,
        });
        let Some((previous, last_impact_ms)) = self.motion.get(&key).copied() else {
            self.motion.insert(key, (sample, f64::NEG_INFINITY));
            return;
        };
        if time_ms <= previous.time_ms {
            return;
        }
        let mut impact_at = last_impact_ms;
        // Cheap test first (a real drop at all), then weigh the body.
        if velocity.length() < previous.velocity.length() * 0.85 && time_ms - last_impact_ms > 220.0
        {
            let members = self.members_of(key);
            let mass = self.source_table.mass_of(key.structure, &members);
            let weighed = MotionSample { mass, ..sample };
            let previous = MotionSample { mass, ..previous };
            if let Some((energy, intensity)) = classify_motion_impact(&previous, &weighed) {
                impact_at = time_ms;
                // Collapse fronts: impacts' impulse (mass × |Δv|) per 8 m cell (dustImpacts.ts).
                let impulse = mass * (weighed.velocity - previous.velocity).length();
                self.source_state.note_impact(
                    key.structure,
                    render_tick as u32,
                    position,
                    impulse,
                    time_ms,
                    &mut self.sources,
                );
                let material = members
                    .first()
                    .map_or(0, |&n| self.source_table.material_of(key.structure, n));
                self.sources.push(Source {
                    kind: SourceKind::Impact,
                    structure: key.structure,
                    tick: render_tick as u32,
                    ordinal: key.body,
                    position,
                    normal: Vec3::Y,
                    // destructionEvents.ts: impact dust units = kinetic energy lost / 5000 J.
                    magnitude: energy / 5000.0,
                    count: 1,
                    material,
                    intensity,
                });
            }
        }
        self.motion.insert(key, (sample, impact_at));
    }

    /// The cars, drawn at `car_tick`: the web draws them on the players' clock (its
    /// `setVehicleClock`, `renderTimeUs / SERVER_TICK_US`), so a driver sits in the car it drives.
    /// Advances the car clock (car-group events apply as it reaches them) and writes every car.
    pub fn cars(&mut self, car_tick: f32, out: &mut Vec<VlCar>) {
        if !car_tick.is_finite() {
            return;
        }
        self.client.advance_vehicles(car_tick);
        for car in self.client.car_states() {
            let mut record = VlCar {
                handle: car.structure.saturating_sub(VEHICLE_STRUCTURE_BASE),
                pos: self.space.pos(car.position),
                quat: self.space.quat(car.rotation),
                vel: self.space.pos(car.linear_velocity),
                ..Default::default()
            };
            if let Some(wheels) = car.wheels {
                record.flags |= VL_CAR_HAS_WHEELS;
                let scale = self.space.metres();
                for (out_wheel, w) in record.wheels.iter_mut().zip(wheels) {
                    *out_wheel = VlWheel {
                        travel: w.travel * scale,
                        steer: w.steer,
                        spin: w.angle,
                        grounded: u32::from(w.grounded),
                    };
                }
            }
            out.push(record);
        }
    }

    /// A car's part hulls (its asset's parts: part + shape + vertex, source frame): its detached
    /// groups then rest on the ground as the server's do (the web's `setVehicleParts`).
    pub fn set_vehicle_parts(&mut self, handle: u32, parts: Vec<Vec<Vec3>>) {
        self.client
            .set_vehicle_parts(VEHICLE_STRUCTURE_BASE + handle, parts);
    }

    /// Every chunk of `structure` from the client's current state (after a bootstrap).
    fn reassign_structure(&mut self, structure: u32, frame: &mut SceneFrame) {
        let nodes: Vec<u32> = self
            .structure_chunks
            .get(&structure)
            .map(|v| v.iter().map(|&(n, _)| n).collect())
            .unwrap_or_default();
        for node in nodes {
            self.assign(structure, node, frame);
        }
    }

    fn assign(&self, structure: u32, node: u32, frame: &mut SceneFrame) {
        let Some(&chunk) = self.chunk_index.get(&(structure, node)) else {
            return;
        };
        let (body, local) = match self.client.chunk_body(structure, node) {
            None => (VL_BODY_STANDING, [0.0; 3]),
            Some(REMOVED) => (VL_BODY_REMOVED, [0.0; 3]),
            Some(id) => (id, self.space.pos(self.client.chunk_local(structure, node))),
        };
        frame.assignments.push(VlChunkAssignment {
            chunk,
            structure,
            body,
            local_pos: local,
        });
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

    /// A chunk's rest position, server space.
    fn chunk_rest_server(&self, structure: u32, node: u32) -> Option<Vec3> {
        let cs = self.client.structures.get(&structure)?;
        Some(cs.def.world_position + cs.def.world_rotation * *cs.def.rest.get(node as usize)?)
    }

    /// For tests and debug views: the world pose of a chunk now, in server space.
    pub fn chunk_world_server(&self, structure: u32, node: u32) -> Option<(Vec3, Quat)> {
        let cs = self.client.structures.get(&structure)?;
        let world_q = cs.def.world_rotation;
        match self.client.chunk_body(structure, node) {
            None => Some((
                cs.def.world_position + world_q * cs.def.rest[node as usize],
                world_q,
            )),
            Some(REMOVED) => None,
            Some(id) => {
                let (p, q) = self
                    .client
                    .track(BodyKey {
                        structure,
                        body: id,
                    })?
                    .pose_at(self.client.render_tick(), self.client.physics);
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
        6 => u32::from_str_radix(hex, 16)
            .ok()
            .map(|rgb| (rgb << 8) | 0xFF),
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
