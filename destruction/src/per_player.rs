//! The per-player destruction stream (city wire 4): the destruction netcode
//! spec's Part A, as a `ReplicationStrategy` beside the shared-world stream.
//!
//! - **Structure.** Each fracture goes out once, reliably, as its outcome:
//!   the bonds that broke and the chunks the physics removed
//!   (`perplayer::structure`). Every end derives the bodies from that, named
//!   by their lowest chunk; the server checks its derivation against the
//!   physics' islands as it goes (`stats.derive_mismatches`).
//! - **Motion.** For each client, the server keeps that client's own drawing
//!   of every body: `perplayer::client::BodyTrack`, the client's code, over
//!   the keyframes the client is believed to have. A body costs bytes only
//!   when that drawing would visibly drift from the truth. It is judged in
//!   the client's camera, a short horizon ahead (a contact shows up at once as
//!   a velocity the drawing does not have), and ranked by the perceptual
//!   penalty it removes per byte (`perception::PerceptualModel`, the same
//!   model the lab scores with).
//! - **Loss.** Keyframes are presumed received until the client's acks say a
//!   datagram was lost. Then they leave the server's model of that client,
//!   and the error that reappears gets the body resent.
//! - **Precision.** Each keyframe is quantised at the coarsest grid whose
//!   step stays under half the tolerance in that client's view.
//! - **No view culling.** A body behind the camera still counts at half
//!   weight (a 180 degree flick takes under 100 ms).
//!
//! Not yet: datagram copies of the events (D6), delta coding against acked
//! baselines, group keyframes, occlusion.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use glam::{Quat, Vec3};

use vibe_land_perplayer::client::{apply_spawns, parent_states, BodyTrack};
use vibe_land_perplayer::predict::{Keyframe, Mode, Physics};
use vibe_land_perplayer::structure::{StructureDef, StructureState, ANCHORED, REMOVED};
use vibe_land_perplayer::wire::{
    encode_bootstrap, encode_events, encode_keyframes, quantised, BodyKey, Bootstrap, BootstrapStructure, Event,
    KeyframePacket, KeyframeRecord, POSITION_STEPS,
};
use vibe_netcode::destruction_backend::DestructionTickOutput;

use crate::encoder::BodySnapshotInput;
use crate::ids;
use crate::manifest::DestructionManifest;
use crate::perception::{ArtifactClass, PerceptualModel};
use crate::replication::{ClientFeedback, ClientSend, ClientView, Outgoing, ReplicationStrategy, SendBudget};
use crate::topology::CityLedger;

/// The shared derivation's view of a manifest.
pub fn structure_defs(manifest: &DestructionManifest) -> Vec<StructureDef> {
    manifest
        .structures
        .iter()
        .map(|s| {
            let n = s.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0) as usize;
            let (mut rest, mut mass_center, mut mass, mut support) =
                (vec![Vec3::ZERO; n], vec![Vec3::ZERO; n], vec![0.0; n], vec![false; n]);
            for c in &s.chunks {
                let i = c.node_index as usize;
                rest[i] = Vec3::from_array(c.centroid);
                mass_center[i] = Vec3::from_array(c.mass_center());
                mass[i] = c.mass;
                support[i] = c.support;
            }
            let mut bonds = vec![(0u32, 0u32); s.bonds.iter().map(|b| b.bond_index + 1).max().unwrap_or(0) as usize];
            for b in &s.bonds {
                bonds[b.bond_index as usize] = (b.node0, b.node1);
            }
            StructureDef::new(
                s.structure_id,
                Vec3::from_array(s.world_position),
                Quat::from_array(s.world_rotation).normalize(),
                rest,
                mass_center,
                mass,
                support,
                bonds,
            )
        })
        .collect()
}

/// Per-player body ids in the city's body-entity space: the serial field
/// carries bit 19 plus the lowest chunk, so they never collide with the
/// physics' serials (small counters) and a scorer can tell them apart.
pub const PER_PLAYER_SERIAL_BIT: u32 = 1 << 19;

pub fn body_entity(key: BodyKey) -> u32 {
    if key.body == ANCHORED {
        ids::body_entity(key.structure, 0)
    } else {
        ids::body_entity(key.structure, PER_PLAYER_SERIAL_BIT | key.body)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PerPlayerConfig {
    pub sim_hz: u32,
    pub send_interval_ticks: u32,
    /// The most record bytes one send may carry, as wire v2's ceiling.
    pub ceiling_bytes: usize,
    /// The drawn error, in the client's pixels, worth a keyframe.
    pub tolerance_px: f32,
    pub pane: (u32, u32),
    /// How far ahead the drawing's error is judged (contacts show at once).
    pub horizon_ticks: f32,
    /// The client's playout delay (`perplayer::client::RenderClock`).
    pub delay_ticks: f32,
    pub hash_interval_ticks: u32,
    /// An empty keyframe packet at least this often, for the clock and acks.
    pub heartbeat_sends: u32,
    pub max_datagram: usize,
    pub gravity_y: f32,
}

impl PerPlayerConfig {
    pub fn validated(sim_hz: u32) -> Self {
        Self {
            sim_hz,
            send_interval_ticks: (sim_hz / 60).max(1),
            ceiling_bytes: 5_200,
            tolerance_px: 1.0,
            pane: (1920, 1080),
            horizon_ticks: 6.0,
            delay_ticks: 5.0,
            hash_interval_ticks: 120,
            heartbeat_sends: 6,
            max_datagram: 1_150,
            gravity_y: -(vibe_netcode::movement::GRAVITY as f32),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Truth {
    keyframe: Keyframe,
    radius: f32,
    settled: bool,
}

#[derive(Default)]
struct ClientState {
    ordinal: u32,
    believed: HashMap<BodyKey, BodyTrack>,
    /// Ordinal -> the keyframes it carried and how many acks have not
    /// named it, until acked or known lost.
    sent: VecDeque<(u32, Vec<(BodyKey, u32)>, u8)>,
    /// Bodies this client has never been sent.
    unsent: HashSet<BodyKey>,
    sends_since_datagram: u32,
    rtt_ms: f32,
}

/// Counters for reports.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct PerPlayerStats {
    pub fractures: u64,
    pub removed_chunks: u64,
    /// Physics islands whose members differ from the derived body.
    pub derive_mismatches: u64,
    pub keyframes_sent: u64,
    pub keyframes_lost: u64,
    pub heartbeats: u64,
}

pub struct PerPlayer {
    config: PerPlayerConfig,
    model: PerceptualModel,
    physics: Physics,
    defs: BTreeMap<u32, StructureDef>,
    states: BTreeMap<u32, StructureState>,
    chunk_radius: BTreeMap<u32, Vec<f32>>,
    ledger: CityLedger,
    serial_body: HashMap<(u32, u32), u32>,
    truth: HashMap<BodyKey, Truth>,
    event_seq: u32,
    clients: BTreeMap<u64, ClientState>,
    tick: u32,
    pub stats: PerPlayerStats,
}

impl PerPlayer {
    /// From the manifest and the ledger at the start (a capture's
    /// checkpoint, or the intact city).
    pub fn new(manifest: &DestructionManifest, ledger: CityLedger, config: PerPlayerConfig) -> Self {
        let defs: BTreeMap<u32, StructureDef> = structure_defs(manifest).into_iter().map(|d| (d.id, d)).collect();
        let chunk_radius = manifest
            .structures
            .iter()
            .map(|s| {
                let n = s.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0) as usize;
                let mut r = vec![0.0; n];
                for c in &s.chunks {
                    r[c.node_index as usize] = c.radius;
                }
                (s.structure_id, r)
            })
            .collect();
        let mut states: BTreeMap<u32, StructureState> =
            defs.values().map(|d| (d.id, StructureState::new(d))).collect();
        let mut this = Self {
            config,
            model: PerceptualModel::literature(),
            physics: Physics::at_hz(config.sim_hz, config.gravity_y),
            defs,
            states: BTreeMap::new(),
            chunk_radius,
            ledger,
            serial_body: HashMap::new(),
            truth: HashMap::new(),
            event_seq: 0,
            clients: BTreeMap::new(),
            tick: 0,
            stats: PerPlayerStats::default(),
        };
        // A capture that starts mid-match: derive the structure from the
        // ledger's bonds and islands, as a joining client would from bits.
        for (&id, def) in &this.defs {
            let state = states.get_mut(&id).unwrap();
            let broken: Vec<u32> = (0..def.bonds.len() as u32).filter(|&b| !this.ledger_bond_alive(id, b)).collect();
            state.apply(def, &broken, &[]);
            let removed = this.removed_nodes(id, state);
            state.apply(def, &[], &removed);
            for (_, island) in this.ledger.structure_islands(id).into_iter().flatten() {
                if let Some(&min) = island.nodes.first() {
                    let key = BodyKey { structure: id, body: min };
                    let radius = this.radius_of(id, state, min);
                    this.truth.insert(
                        key,
                        Truth {
                            keyframe: Keyframe {
                                tick: 0,
                                position: island.pose.position,
                                rotation: island.pose.rotation,
                                linear_velocity: island.linear_velocity,
                                angular_velocity: island.angular_velocity,
                                mode: if island.settled { Mode::Resting } else { Mode::Ballistic },
                            },
                            radius,
                            settled: island.settled,
                        },
                    );
                }
            }
        }
        this.states = states;
        this.refresh_serials_all();
        this
    }

    pub fn config(&self) -> PerPlayerConfig {
        self.config
    }

    fn ledger_bond_alive(&self, structure: u32, bond: u32) -> bool {
        self.ledger.bond_alive(structure, bond)
    }

    /// Nodes on a dynamic derived body that are on no physics island: the
    /// physics removed them without breaking their bonds.
    fn removed_nodes(&self, structure: u32, state: &StructureState) -> Vec<u32> {
        let mut on_island: HashSet<u32> = HashSet::new();
        for island in self.ledger.structure_islands(structure).into_iter().flat_map(|m| m.values()) {
            on_island.extend(island.nodes.iter().copied());
        }
        let n = self.defs[&structure].node_count();
        (0..n)
            .filter(|&node| {
                let body = state.body_of(node);
                body != ANCHORED && body != REMOVED && !on_island.contains(&node)
            })
            .collect()
    }

    fn radius_of(&self, structure: u32, state: &StructureState, body: u32) -> f32 {
        let def = &self.defs[&structure];
        let com = state.centre_of_mass(def, body);
        let radii = &self.chunk_radius[&structure];
        state
            .members(body)
            .map(|m| m.iter().map(|&n| (def.rest[n as usize] - com).length() + radii[n as usize]).fold(0.0, f32::max))
            .unwrap_or(0.5)
    }

    fn refresh_serials_all(&mut self) {
        let ids: Vec<u32> = self.defs.keys().copied().collect();
        for id in ids {
            self.refresh_serials(id);
        }
    }

    /// Map the physics' island serials to derived body ids, and count any
    /// island the derivation disagrees with.
    fn refresh_serials(&mut self, structure: u32) {
        let state = &self.states[&structure];
        self.serial_body.retain(|(s, _), _| *s != structure);
        for (&serial, island) in self.ledger.structure_islands(structure).into_iter().flatten() {
            let Some(&min) = island.nodes.first() else { continue };
            if state.members(min) != Some(island.nodes.as_slice()) {
                self.stats.derive_mismatches += 1;
            }
            self.serial_body.insert((structure, serial), min);
        }
    }

    /// How the client should predict a body from its state now: ballistic
    /// only in free flight (its acceleration since the last tick is g),
    /// resting when still, and sliding (constant velocity, no gravity) in
    /// any contact. A supported body predicted ballistic falls through what
    /// holds it within a few ticks; one predicted sliding drifts slowly.
    fn mode_of(&self, previous: Option<&Truth>, velocity: Vec3, spin: Vec3, tick: u32) -> Mode {
        if velocity.length() < 0.05 && spin.length() < 0.05 {
            return Mode::Resting;
        }
        match previous {
            Some(prev) if prev.keyframe.tick + 1 == tick => {
                let accel = (velocity - prev.keyframe.linear_velocity) * self.config.sim_hz as f32;
                let g = self.physics.gravity;
                if (accel - g).length() <= 0.15 * g.length() {
                    Mode::Ballistic
                } else {
                    Mode::Sliding
                }
            }
            // No previous tick to tell: a body just freed or just woken is
            // most likely falling.
            _ => Mode::Ballistic,
        }
    }
}

impl ReplicationStrategy for PerPlayer {
    fn name(&self) -> &'static str {
        "per-player"
    }

    fn wire_version(&self) -> u8 {
        4
    }

    fn send_interval_ticks(&self) -> u32 {
        self.config.send_interval_ticks.max(1)
    }

    fn ceiling_bytes(&self) -> usize {
        self.config.ceiling_bytes
    }

    fn add_client(&mut self, client: u64) {
        self.clients.entry(client).or_default();
    }

    fn remove_client(&mut self, client: u64) {
        self.clients.remove(&client);
    }

    fn join(&mut self, client: u64, tick: u32) -> Vec<Outgoing> {
        let mut state = ClientState::default();
        let mut boot = Bootstrap {
            tick,
            next_event_seq: self.event_seq,
            structures: Vec::new(),
            settled: Vec::new(),
            awake: Vec::new(),
        };
        for (&id, s) in &self.states {
            boot.structures.push(BootstrapStructure {
                structure: id,
                alive_bonds: s.alive_bits().to_vec(),
                removed_chunks: s.removed_bits().to_vec(),
            });
        }
        let mut keys: Vec<&BodyKey> = self.truth.keys().collect();
        keys.sort();
        for key in keys {
            let truth = &self.truth[key];
            let kf = quantised(&Keyframe { tick, ..truth.keyframe }, 0);
            let mut track = BodyTrack::default();
            if truth.settled {
                boot.settled.push((*key, kf.position, kf.rotation));
                track.restart(Keyframe { mode: Mode::Resting, ..kf });
                track.settle(tick, kf.position, kf.rotation);
            } else {
                boot.awake.push((*key, kf));
                track.add(kf, f32::MIN, self.physics);
            }
            state.believed.insert(*key, track);
        }
        self.clients.insert(client, state);
        vec![Outgoing::reliable(encode_bootstrap(&boot))]
    }

    fn ingest_tick(&mut self, tick: u32, active: &[BodySnapshotInput], output: &DestructionTickOutput) -> Vec<Outgoing> {
        self.tick = tick;
        let mut events: Vec<Event> = Vec::new();
        for batch in &output.batches {
            self.ledger.apply_batch(batch);
            let structure = batch.structure_id;
            let Some(def) = self.defs.get(&structure) else { continue };
            let broken: Vec<u32> = batch
                .broken_bond_ids
                .iter()
                .map(|&b| ids::bond_id_parts(b))
                .filter(|&(s, _)| s == structure)
                .map(|(_, i)| i)
                .collect();
            // Every client's drawn parents before the split (each client's
            // model spawns from its own drawing).
            let mut state = self.states.remove(&structure).unwrap();
            let parents: Vec<(u64, HashMap<u32, vibe_land_perplayer::client::ParentState>)> = self
                .clients
                .iter()
                .map(|(&c, cs)| (c, parent_states(def, &state, structure, tick, &cs.believed, self.physics)))
                .collect();
            let truth_parents: HashMap<u32, Truth> =
                state.bodies().keys().filter_map(|&b| self.truth.get(&BodyKey { structure, body: b }).map(|t| (b, *t))).collect();
            let parent_coms: HashMap<u32, Vec3> =
                state.bodies().keys().map(|&b| (b, state.centre_of_mass(def, b))).collect();
            let mut change = state.apply(def, &broken, &[]);
            let removed = self.removed_nodes(structure, &state);
            if !removed.is_empty() {
                let more = state.apply(def, &[], &removed);
                change.changed_bodies.extend(more.changed_bodies);
                change.retired_bodies.extend(more.retired_bodies);
                change.moved_chunks.extend(more.moved_chunks);
                for (id, parent) in more.parent_of {
                    // A body split again by a removal still spawns from the
                    // body it was part of before this tick.
                    let original = change.parent_of.iter().find(|(c, _)| *c == parent).map_or(parent, |&(_, p)| p);
                    change.parent_of.retain(|(c, _)| *c != id);
                    change.parent_of.push((id, original));
                }
                change.parent_of.retain(|(c, _)| state.members(*c).is_some());
                change.retired_bodies.retain(|b| state.members(*b).is_none());
            }
            if broken.is_empty() && removed.is_empty() {
                self.states.insert(structure, state);
                self.refresh_serials(structure);
                continue;
            }
            self.stats.fractures += 1;
            self.stats.removed_chunks += removed.len() as u64;
            events.push(Event::Fracture { tick, structure, broken_bonds: broken, removed_chunks: removed });
            for id in &change.retired_bodies {
                self.truth.remove(&BodyKey { structure, body: *id });
            }
            // The new bodies' truth: the physics' own promotion (pose and
            // velocities in the new body's centre-of-mass frame), from the
            // ledger. A body the physics did not promote this tick (asleep,
            // re-keyed) is where its chunks were: its parent's frame moved to
            // its own centre of mass.
            let islands: HashMap<u32, (Vec3, Quat, Vec3, Vec3, bool)> = self
                .ledger
                .structure_islands(structure)
                .into_iter()
                .flatten()
                .filter_map(|(_, i)| {
                    i.nodes.first().map(|&min| (min, (i.pose.position, i.pose.rotation, i.linear_velocity, i.angular_velocity, i.settled)))
                })
                .collect();
            for &(id, parent) in &change.parent_of {
                let key = BodyKey { structure, body: id };
                let radius = self.radius_of(structure, &state, id);
                let com = state.centre_of_mass(def, id);
                let (keyframe, settled) = match islands.get(&id) {
                    Some(&(p, q, v, w, settled)) => (
                        Keyframe {
                            tick,
                            position: p,
                            rotation: q,
                            linear_velocity: v,
                            angular_velocity: w,
                            mode: if settled { Mode::Resting } else { Mode::Ballistic },
                        },
                        settled,
                    ),
                    None => match truth_parents.get(&parent) {
                        Some(t) if parent != ANCHORED => {
                            let parent_com = parent_coms.get(&parent).copied().unwrap_or(com);
                            let arm = t.keyframe.rotation * (com - parent_com);
                            (
                                Keyframe {
                                    tick,
                                    position: t.keyframe.position + arm,
                                    linear_velocity: t.keyframe.linear_velocity + t.keyframe.angular_velocity.cross(arm),
                                    ..t.keyframe
                                },
                                false,
                            )
                        }
                        _ => (
                            Keyframe {
                                tick,
                                position: def.world_position + def.world_rotation * com,
                                rotation: def.world_rotation,
                                linear_velocity: Vec3::ZERO,
                                angular_velocity: Vec3::ZERO,
                                mode: Mode::Resting,
                            },
                            false,
                        ),
                    },
                };
                self.truth.insert(key, Truth { keyframe, radius, settled });
            }
            for (client, parents) in parents {
                if let Some(cs) = self.clients.get_mut(&client) {
                    apply_spawns(def, &state, structure, tick, &change, &parents, &mut cs.believed);
                    for &(id, _) in &change.parent_of {
                        cs.unsent.insert(BodyKey { structure, body: id });
                    }
                }
            }
            self.states.insert(structure, state);
            self.refresh_serials(structure);
        }
        // A body the physics put to sleep has no snapshot: it lies where it
        // was last seen. (Without this its last awake velocity carried on,
        // and the server kept sending a falling body that lay still.)
        let mut seen: HashSet<BodyKey> = HashSet::with_capacity(active.len());
        for snapshot in active {
            let (structure, serial) = ids::body_entity_parts(snapshot.body_entity);
            if let Some(&body) = self.serial_body.get(&(structure, serial)) {
                seen.insert(BodyKey { structure, body });
            }
        }
        for (key, truth) in self.truth.iter_mut() {
            if !truth.settled && !seen.contains(key) && truth.keyframe.tick < tick {
                truth.keyframe = Keyframe {
                    tick,
                    linear_velocity: Vec3::ZERO,
                    angular_velocity: Vec3::ZERO,
                    mode: Mode::Resting,
                    ..truth.keyframe
                };
            }
        }
        for snapshot in active {
            let (structure, serial) = ids::body_entity_parts(snapshot.body_entity);
            let Some(&body) = self.serial_body.get(&(structure, serial)) else { continue };
            let key = BodyKey { structure, body };
            let velocity = Vec3::from_array(snapshot.linear_velocity);
            let spin = Vec3::from_array(snapshot.angular_velocity);
            let previous = self.truth.get(&key).copied();
            let mode = self.mode_of(previous.as_ref(), velocity, spin, tick);
            let radius = previous.map_or(0.5, |p| p.radius);
            self.truth.insert(
                key,
                Truth {
                    keyframe: Keyframe {
                        tick,
                        position: Vec3::from_array(snapshot.position),
                        rotation: Quat::from_array(snapshot.rotation).normalize(),
                        linear_velocity: velocity,
                        angular_velocity: spin,
                        mode,
                    },
                    radius,
                    settled: false,
                },
            );
        }
        for settle in &output.settled {
            self.ledger.apply_settle(settle);
            let Some(&body) = self.serial_body.get(&(settle.structure_id, settle.island_id)) else { continue };
            let key = BodyKey { structure: settle.structure_id, body };
            let position = Vec3::from_array(settle.position);
            let rotation = Quat::from_array(settle.rotation).normalize();
            if let Some(t) = self.truth.get_mut(&key) {
                t.settled = true;
                t.keyframe = Keyframe { tick, position, rotation, linear_velocity: Vec3::ZERO, angular_velocity: Vec3::ZERO, mode: Mode::Resting };
            }
            // Settles ride the reliable stream: every client holds the pose
            // from this tick (rounded as the wire carries it).
            let q = quantised(&Keyframe { tick, position, rotation, linear_velocity: Vec3::ZERO, angular_velocity: Vec3::ZERO, mode: Mode::Resting }, 0);
            for cs in self.clients.values_mut() {
                cs.believed.entry(key).or_default().settle(tick, q.position, q.rotation);
            }
            events.push(Event::Settle { tick, key, position, rotation });
        }
        for &(structure, serial) in &output.wakes {
            self.ledger.apply_wake(structure, serial);
            let Some(&body) = self.serial_body.get(&(structure, serial)) else { continue };
            let key = BodyKey { structure, body };
            if let Some(t) = self.truth.get_mut(&key) {
                t.settled = false;
            }
            for cs in self.clients.values_mut() {
                if let Some(track) = cs.believed.get_mut(&key) {
                    track.wake(tick);
                }
            }
            events.push(Event::Wake { tick, key });
        }
        if tick % self.config.hash_interval_ticks.max(1) == 0 {
            for (&structure, state) in &self.states {
                events.push(Event::Hash { tick, structure, hash: state.hash() });
            }
        }
        if events.is_empty() {
            return Vec::new();
        }
        let packet = encode_events(self.event_seq, &events);
        self.event_seq += 1;
        vec![Outgoing::reliable(packet)]
    }

    fn begin_send(&mut self, _tick: u32) {}

    fn has_pending(&self, _client: u64) -> bool {
        true
    }

    fn has_records(&self) -> bool {
        true
    }

    fn note_link_rtt(&mut self, client: u64, rtt_ms: f32) {
        if let Some(cs) = self.clients.get_mut(&client) {
            cs.rtt_ms = rtt_ms;
        }
    }

    fn client_send(&mut self, client: u64, view: &ClientView, tick: u32, budget: Option<SendBudget>) -> ClientSend {
        let config = self.config;
        let physics = self.physics;
        let Some(cs) = self.clients.get_mut(&client) else { return ClientSend::default() };
        let camera = view.camera;
        let forward = camera.direction.normalize_or_zero();
        let focal = config.pane.1 as f32 * 0.5 / (camera.fov_degrees.max(1.0).to_radians() * 0.5).tan();
        let horizon_s = config.horizon_ticks / config.sim_hz as f32;
        let r = tick as f32;
        // When this keyframe lands, the client's drawing is at about
        // `tick - delay + one-way latency`.
        let latency_ticks = cs.rtt_ms * 0.5 / 1000.0 * config.sim_hz as f32;
        let arrival_render = r - config.delay_ticks + latency_ticks;
        struct Candidate {
            key: BodyKey,
            tier: u8,
            bytes: usize,
            priority: f32,
        }
        let mut candidates: Vec<Candidate> = Vec::new();
        for (key, truth) in &self.truth {
            if truth.settled {
                continue;
            }
            let required = cs.unsent.contains(key);
            let rel = truth.keyframe.position - camera.eye;
            let depth = rel.dot(forward);
            let distance = rel.length().max(0.5);
            // In view: pixels at its depth. Behind or beside: half weight at
            // its distance -- never culled.
            let (px_per_m, weight) =
                if depth > 0.5 { (focal / depth, 1.0f32) } else { (focal / distance, 0.5) };
            let error_px = match cs.believed.get(key) {
                Some(track) if !track.keyframes().is_empty() => {
                    let (p, q) = track.pose_at(r, physics);
                    let (v, w) = track.velocity_at(r, physics);
                    let angle = 2.0 * q.dot(truth.keyframe.rotation).abs().min(1.0).acos();
                    let spin_gap = (w - truth.keyframe.angular_velocity).length() * horizon_s;
                    let now = (p - truth.keyframe.position).length() + truth.radius * (angle + spin_gap).min(1.0);
                    let ahead = now + (v - truth.keyframe.linear_velocity).length() * horizon_s;
                    ahead * px_per_m
                }
                _ => f32::INFINITY,
            };
            if !required && error_px < config.tolerance_px {
                continue;
            }
            // The coarsest grid whose step stays under half the tolerance.
            let mut tier = 0u8;
            for t in (0..4u8).rev() {
                if POSITION_STEPS[t as usize] * px_per_m <= 0.5 * config.tolerance_px {
                    tier = t;
                    break;
                }
            }
            let moving = truth.keyframe.mode != Mode::Resting;
            let bytes = 3 + 9 - tier as usize + 4 + if moving { 12 } else { 0 };
            let gain = if error_px.is_finite() {
                self.model.penalty(ArtifactClass::ScreenError, f64::from(error_px), f64::from(weight)) as f32
            } else {
                f32::MAX
            };
            let priority = if required { f32::MAX } else { gain.max(1e-9) / bytes as f32 };
            candidates.push(Candidate { key: *key, tier, bytes, priority });
        }
        candidates.sort_by(|a, b| b.priority.total_cmp(&a.priority).then(a.key.cmp(&b.key)));
        let allowance = match budget {
            Some(SendBudget::Skip) => 0,
            Some(b) => b
                .allowance()
                .unwrap_or(config.ceiling_bytes * b.ceiling_sends() as usize)
                .min(config.ceiling_bytes * b.ceiling_sends() as usize),
            None => config.ceiling_bytes,
        };
        let mut chosen: Vec<KeyframeRecord> = Vec::new();
        let mut used = 0usize;
        for c in &candidates {
            if used + c.bytes > allowance && c.priority < f32::MAX {
                continue;
            }
            if used + c.bytes > allowance {
                break;
            }
            used += c.bytes;
            let truth = &self.truth[&c.key];
            chosen.push(KeyframeRecord { key: c.key, tier: c.tier, keyframe: Keyframe { tick, ..truth.keyframe } });
        }
        let mut out = ClientSend::default();
        cs.sends_since_datagram += 1;
        if chosen.is_empty() {
            if cs.sends_since_datagram < config.heartbeat_sends {
                return out;
            }
            self.stats.heartbeats += 1;
        }
        // Pack into datagrams under the MTU.
        let mut start = 0;
        loop {
            let mut end = start;
            let mut bytes = 13;
            while end < chosen.len() && bytes + 30 <= config.max_datagram {
                bytes += 30;
                end += 1;
            }
            let records = chosen[start..end].to_vec();
            let ordinal = cs.ordinal;
            cs.ordinal += 1;
            let packet = encode_keyframes(&KeyframePacket { server_tick: tick, ordinal, records: records.clone() });
            out.record_bytes += packet.len();
            out.packets.push(Outgoing::datagram(packet));
            let mut carried = Vec::with_capacity(records.len());
            for record in &records {
                let decoded = quantised(&record.keyframe, record.tier);
                cs.believed.entry(record.key).or_default().add(decoded, arrival_render, physics);
                cs.unsent.remove(&record.key);
                carried.push((record.key, record.keyframe.tick));
                self.stats.keyframes_sent += 1;
            }
            cs.sent.push_back((ordinal, carried, 0));
            start = end;
            if start >= chosen.len() {
                break;
            }
        }
        cs.sends_since_datagram = 0;
        out
    }

    fn report(&self) -> String {
        format!("{:?}", self.stats)
    }

    fn on_feedback(&mut self, client: u64, feedback: ClientFeedback) {
        let ClientFeedback::DatagramAcks { newest, mask } = feedback;
        let Some(cs) = self.clients.get_mut(&client) else { return };
        let acked = |o: u32| o == newest || (o < newest && newest - o <= 64 && mask & (1 << (newest - o - 1)) != 0);
        // A datagram an ack does not name may still be in flight: links
        // reorder (a third of datagrams on the lab's LTE). It is lost when
        // three acks in a row have not named it, or it fell out of the
        // window.
        const MISSES_TO_LOSE: u8 = 3;
        let mut lost: Vec<(BodyKey, u32)> = Vec::new();
        cs.sent.retain_mut(|(ordinal, carried, misses)| {
            if *ordinal > newest {
                return true;
            }
            if acked(*ordinal) {
                return false;
            }
            *misses += 1;
            if *misses >= MISSES_TO_LOSE || newest - *ordinal > 64 {
                lost.append(carried);
                return false;
            }
            true
        });
        for (key, tick) in lost {
            if let Some(track) = cs.believed.get_mut(&key) {
                track.remove_keyframe(tick);
            }
            self.stats.keyframes_lost += 1;
        }
    }
}
