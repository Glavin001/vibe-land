//! The per-tick chunk-stream encoder: classify → schedule → encode-once →
//! per-client interest filter → packetize.
//!
//! Orchestrates the ported codec core for the live server. Encode-once
//! discipline: body records are encoded against globally scheduled baselines
//! (never per-client acked state), so record bytes are identical across
//! clients and the stream stays MoQ-publishable later; only packet
//! composition differs per client.

use std::collections::HashMap;

use glam::Vec3;

use vibe_netcode::destruction_backend::DestructionTickOutput;

use crate::classify::{Classifier, ClassifierConfig, PhysicalClass};
use crate::ids;
use crate::interest::{InterestConfig, InterestTrack, InterestView, InterestViewTrack};
use crate::manifest::DestructionManifest;
use crate::quant::projected_error_pixels;
use crate::scheduler::{
    compute_priority, select_with_ceiling, BudgetCandidate, PriorityConfig, PriorityInput,
};
use crate::topology::CityLedger;
use crate::types::{BodyState, Camera, Pose, FLAG_CONTACT_BEGIN, FLAG_JOINT_BREAK, FLAG_WAKE_EVENT};
use crate::wire::{
    delta_fits, encode_baseline, encode_bootstrap, encode_chunks_datagrams, encode_topology,
    BaselineMessage, BaselineRecord, BodyRecord, RecordMode, TopologyMessage,
    RECORD_FLAG_SETTLED_HINT,
};

/// Kinematic input for one awake island body, produced by the physics half.
#[derive(Clone, Copy, Debug)]
pub struct BodySnapshotInput {
    pub body_entity: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub contacts: u16,
    /// `types::FLAG_*` event bits (contact begin, joint break, wake).
    pub flags: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct EncoderConfig {
    pub sim_hz: u32,
    /// Chunk stream rate divider: encode/send every N sim ticks.
    pub send_interval_ticks: u32,
    /// Global baseline cadence in sim ticks.
    pub baseline_interval_ticks: u32,
    /// Per-client byte ceiling per send (a cap, never a fill target).
    pub client_ceiling_bytes: usize,
    /// Screen-space error budget (pixels) that normalizes error ratios.
    pub error_budget_px: f32,
    pub classifier: ClassifierConfig,
    pub priority: PriorityConfig,
    pub interest: InterestConfig,
}

impl EncoderConfig {
    pub fn validated(sim_hz: u32) -> Self {
        Self {
            sim_hz,
            send_interval_ticks: 2,                       // 30 Hz at a 60 Hz sim
            baseline_interval_ticks: sim_hz,              // 1000 ms
            client_ceiling_bytes: 10_400,                 // ≈ 2.5 Mbps at 30 Hz
            error_budget_px: 2.0,
            classifier: ClassifierConfig::default(),
            priority: PriorityConfig::from_hz(sim_hz),
            interest: InterestConfig::validated(sim_hz),
        }
    }
}

#[derive(Clone, Debug)]
struct BodyTrack {
    classifier: Classifier,
    class: PhysicalClass,
    state: BodyState,
    /// Interest/error bounding radius for the island.
    radius: f32,
    last_velocity: Vec3,
    last_angular_velocity: Vec3,
    settled_hint: bool,
}

#[derive(Default)]
struct ClientState {
    view: InterestViewTrack,
    tracks: HashMap<u32, InterestTrack>,
    last_sent_tick: HashMap<u32, u32>,
    last_sent_pose: HashMap<u32, Pose>,
    sequence: u32,
}

/// One shared (client-independent) candidate produced by `encode_send`.
#[derive(Clone, Debug)]
pub struct SharedRecord {
    pub record: BodyRecord,
    pub class: PhysicalClass,
    pub contacts: u16,
    pub linear_speed: f32,
    pub angular_speed: f32,
    pub linear_innovation: f32,
    pub angular_innovation: f32,
    pub contact_begin: bool,
    pub joint_break: bool,
    pub wake: bool,
    pub radius: f32,
    pub position: Vec3,
    pub linear_velocity: Vec3,
}

#[derive(Clone, Debug, Default)]
pub struct SharedRecords {
    pub sim_tick: u32,
    pub records: Vec<SharedRecord>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EncoderStats {
    pub awake_bodies: usize,
    pub staged_topology_messages: usize,
    pub baseline_id: u16,
    pub topo_seq: u32,
    /// Records dropped because two bodies claimed the same entity id. Any
    /// non-zero value is a physics-side id-allocation bug.
    pub duplicate_body_records: u64,
}

pub struct ChunkStreamEncoder {
    config: EncoderConfig,
    manifest_hash: [u8; 32],
    /// Per-structure, per-node rest centroid + radius (for island radii).
    structure_chunks: HashMap<u32, Vec<(Vec3, f32)>>,
    ledger: CityLedger,
    bodies: HashMap<u32, BodyTrack>,
    active_order: Vec<u32>,
    baseline_id: u16,
    baseline_poses: HashMap<u32, Pose>,
    last_baseline_tick: Option<u32>,
    topo_seq: u32,
    staged_topology: Vec<Vec<u8>>,
    clients: HashMap<u64, ClientState>,
    duplicate_body_records: u64,
}

impl ChunkStreamEncoder {
    pub fn new(manifest: &DestructionManifest, config: EncoderConfig) -> Self {
        let structure_chunks = manifest
            .structures
            .iter()
            .map(|structure| {
                (
                    structure.structure_id,
                    structure
                        .chunks
                        .iter()
                        .map(|chunk| (Vec3::from_array(chunk.centroid), chunk.radius))
                        .collect(),
                )
            })
            .collect();
        Self {
            config,
            manifest_hash: manifest.hash(),
            structure_chunks,
            ledger: CityLedger::from_manifest(manifest),
            bodies: HashMap::new(),
            active_order: Vec::new(),
            baseline_id: 0,
            baseline_poses: HashMap::new(),
            last_baseline_tick: None,
            topo_seq: 0,
            staged_topology: Vec::new(),
            clients: HashMap::new(),
            duplicate_body_records: 0,
        }
    }

    pub fn ledger(&self) -> &CityLedger {
        &self.ledger
    }

    pub fn stats(&self) -> EncoderStats {
        EncoderStats {
            awake_bodies: self.active_order.len(),
            staged_topology_messages: self.staged_topology.len(),
            baseline_id: self.baseline_id,
            topo_seq: self.topo_seq,
            duplicate_body_records: self.duplicate_body_records,
        }
    }

    pub fn add_client(&mut self, client: u64) {
        self.clients.entry(client).or_default();
    }

    pub fn remove_client(&mut self, client: u64) {
        self.clients.remove(&client);
    }

    /// Island bounding radius: chunks keep their rest poses relative to each
    /// other inside a rigid island, so the spread of member rest centroids
    /// (plus per-chunk radius) bounds the island around the body origin.
    fn island_radius(&self, structure_id: u32, nodes: &[u32]) -> f32 {
        let Some(chunks) = self.structure_chunks.get(&structure_id) else {
            return 1.0;
        };
        let mut mean = Vec3::ZERO;
        let mut count = 0.0;
        for &node in nodes {
            if let Some((centroid, _)) = chunks.get(node as usize) {
                mean += *centroid;
                count += 1.0;
            }
        }
        if count == 0.0 {
            return 1.0;
        }
        mean /= count;
        let mut radius = 0.0_f32;
        for &node in nodes {
            if let Some((centroid, chunk_radius)) = chunks.get(node as usize) {
                radius = radius.max(centroid.distance(mean) + chunk_radius);
            }
        }
        radius.max(0.1)
    }

    /// 60 Hz ingest: apply topology output to the ledger, stage the reliable
    /// message, update classifiers from the active-body snapshots.
    pub fn ingest_tick(
        &mut self,
        sim_tick: u32,
        active: &[BodySnapshotInput],
        output: &DestructionTickOutput,
        wakes: &[(u32, u16)],
    ) {
        // Ledger + staged topology.
        if !output.batches.is_empty() || !output.settled.is_empty() || !wakes.is_empty() {
            for batch in &output.batches {
                self.ledger.apply_batch(batch);
                for promotion in &batch.promoted_islands {
                    let entity =
                        ids::body_entity(batch.structure_id, promotion.island_id as u16);
                    let nodes: Vec<u32> = promotion
                        .chunks
                        .iter()
                        .map(|&chunk| ids::chunk_id_parts(chunk).1)
                        .collect();
                    let radius = self.island_radius(batch.structure_id, &nodes);
                    self.bodies.insert(
                        entity,
                        BodyTrack {
                            classifier: Classifier::default(),
                            class: PhysicalClass::ImpactBurst,
                            state: BodyState::default(),
                            radius,
                            last_velocity: Vec3::from_array(promotion.linear_velocity),
                            last_angular_velocity: Vec3::from_array(promotion.angular_velocity),
                            settled_hint: false,
                        },
                    );
                }
                for &retired in &batch.retired_island_ids {
                    let entity = ids::body_entity(batch.structure_id, retired as u16);
                    self.bodies.remove(&entity);
                    for client in self.clients.values_mut() {
                        client.tracks.remove(&entity);
                        client.last_sent_tick.remove(&entity);
                        client.last_sent_pose.remove(&entity);
                    }
                    self.baseline_poses.remove(&entity);
                }
            }
            for settle in &output.settled {
                self.ledger.apply_settle(settle);
                let entity = ids::body_entity(settle.structure_id, settle.island_id as u16);
                if let Some(track) = self.bodies.get_mut(&entity) {
                    track.settled_hint = true;
                }
            }
            for &(structure_id, serial) in wakes {
                self.ledger.apply_wake(structure_id, serial);
                if let Some(track) = self.bodies.get_mut(&ids::body_entity(structure_id, serial))
                {
                    track.settled_hint = false;
                }
            }
            self.topo_seq += 1;
            let message = TopologyMessage {
                topo_seq: self.topo_seq,
                sim_tick,
                batches: output.batches.clone(),
                settled: output.settled.clone(),
                wakes: wakes.to_vec(),
            };
            self.staged_topology.push(encode_topology(&message));
        }

        // Classifier updates from the delta/active-only export.
        self.active_order.clear();
        for snapshot in active {
            let entity = snapshot.body_entity;
            let state = BodyState {
                pose: Pose {
                    position: Vec3::from_array(snapshot.position),
                    rotation: glam::Quat::from_array(snapshot.rotation),
                },
                linear_velocity: Vec3::from_array(snapshot.linear_velocity),
                angular_velocity: Vec3::from_array(snapshot.angular_velocity),
                contacts: snapshot.contacts,
                intact_joints: 0,
                flags: snapshot.flags,
            };
            let config = self.config.classifier;
            let track = self.bodies.entry(entity).or_insert_with(|| BodyTrack {
                classifier: Classifier::default(),
                class: PhysicalClass::ContactActive,
                state,
                radius: 1.0,
                last_velocity: Vec3::ZERO,
                last_angular_velocity: Vec3::ZERO,
                settled_hint: false,
            });
            track.class = track.classifier.update(state, config);
            track.state = state;
            self.active_order.push(entity);
            self.ledger.update_island_motion(
                entity,
                state.pose,
                state.linear_velocity,
                state.angular_velocity,
            );
        }
        self.active_order.sort_unstable();
        // `active_order` drives both the awake-body count and the baseline
        // record list, and the baseline wire format needs strictly increasing
        // ids just like the datagram one. One snapshot batch carrying the same
        // entity twice (a physics-side id-aliasing bug) would otherwise inflate
        // the count and make the baseline unencodable, killing the match loop.
        let before = self.active_order.len();
        self.active_order.dedup();
        if self.active_order.len() != before {
            self.duplicate_body_records += (before - self.active_order.len()) as u64;
        }
    }

    /// 30 Hz encode-once: build the shared candidate set (record contents are
    /// byte-identical for every client).
    pub fn encode_send(&mut self, sim_tick: u32) -> SharedRecords {
        let mut records = Vec::with_capacity(self.active_order.len());
        for &entity in &self.active_order {
            let Some(track) = self.bodies.get_mut(&entity) else {
                continue;
            };
            let state = track.state;
            let class = track.class;
            let linear_innovation = (state.linear_velocity - track.last_velocity).length();
            let angular_innovation =
                (state.angular_velocity - track.last_angular_velocity).length();
            track.last_velocity = state.linear_velocity;
            track.last_angular_velocity = state.angular_velocity;

            let moving = state.linear_velocity.length() > 0.01
                || state.angular_velocity.length() > 0.01;
            let baseline = self.baseline_poses.get(&entity);
            let mode = if class == PhysicalClass::Ballistic {
                RecordMode::Ballistic
            } else {
                match baseline {
                    Some(pose) if delta_fits(state.pose.position, pose.position) => {
                        if moving {
                            RecordMode::MotionDelta
                        } else {
                            RecordMode::Delta
                        }
                    }
                    _ => {
                        if moving {
                            RecordMode::MotionAbsolute
                        } else {
                            RecordMode::Absolute
                        }
                    }
                }
            };
            let flags = if track.settled_hint {
                RECORD_FLAG_SETTLED_HINT
            } else {
                0
            };
            records.push(SharedRecord {
                record: BodyRecord {
                    body_entity: entity,
                    mode,
                    flags,
                    pose: state.pose,
                    baseline_position: baseline.map_or(Vec3::ZERO, |pose| pose.position),
                    linear_velocity: state.linear_velocity,
                    angular_velocity: state.angular_velocity,
                },
                class,
                contacts: state.contacts,
                linear_speed: state.linear_velocity.length(),
                angular_speed: state.angular_velocity.length(),
                linear_innovation,
                angular_innovation,
                contact_begin: state.flags & FLAG_CONTACT_BEGIN != 0,
                joint_break: state.flags & FLAG_JOINT_BREAK != 0,
                wake: state.flags & FLAG_WAKE_EVENT != 0,
                radius: track.radius,
                position: state.pose.position,
                linear_velocity: state.linear_velocity,
            });
        }
        SharedRecords {
            sim_tick,
            records,
        }
    }

    /// Per-client selection + packet composition from the shared records.
    pub fn client_datagrams(
        &mut self,
        client: u64,
        camera: Camera,
        shared: &SharedRecords,
    ) -> Vec<Vec<u8>> {
        let config = self.config;
        let state = self.clients.entry(client).or_default();
        let view: InterestView = state.view.update(camera, config.interest);

        let mut candidates = Vec::new();
        for (index, shared_record) in shared.records.iter().enumerate() {
            let entity = shared_record.record.body_entity;
            let decision = state.tracks.entry(entity).or_default().update(
                shared.sim_tick,
                Pose {
                    position: shared_record.position,
                    rotation: glam::Quat::IDENTITY,
                },
                shared_record.linear_velocity,
                shared_record.radius,
                view,
                config.interest,
            );
            if !decision.relevant {
                continue;
            }
            let age_ticks = state
                .last_sent_tick
                .get(&entity)
                .map_or(u32::MAX / 2, |&last| shared.sim_tick.saturating_sub(last));
            let error_ratio = state.last_sent_pose.get(&entity).map_or(4.0, |last_pose| {
                projected_error_pixels(
                    Pose {
                        position: shared_record.position,
                        rotation: shared_record.record.pose.rotation,
                    },
                    *last_pose,
                    shared_record.radius,
                    view.current,
                    config.interest.pane_width,
                    config.interest.pane_height,
                ) / config.error_budget_px.max(0.01)
            });
            let priority = compute_priority(
                PriorityInput {
                    class: shared_record.class,
                    projected_error_ratio: error_ratio,
                    age_ticks,
                    contacts: shared_record.contacts,
                    linear_speed: shared_record.linear_speed,
                    angular_speed: shared_record.angular_speed,
                    linear_velocity_innovation: shared_record.linear_innovation,
                    angular_velocity_innovation: shared_record.angular_innovation,
                    contact_begin: shared_record.contact_begin,
                    joint_break: shared_record.joint_break,
                    wake: shared_record.wake,
                    interest_entry: decision.entering,
                },
                config.priority,
            );
            if !priority.should_send {
                continue;
            }
            // Packed cost estimate: logical bytes minus the 4-byte id plus a
            // typical 2-byte packet-local gap.
            let cost = shared_record.record.body_bytes() - 4 + 2;
            candidates.push(BudgetCandidate {
                index,
                cost_bytes: cost,
                priority: priority.score,
                required: priority.hard_deadline || decision.entering,
            });
        }

        let selection =
            select_with_ceiling(&candidates, Some(config.client_ceiling_bytes), 0);
        let mut selected: Vec<BodyRecord> = selection
            .selected_indices
            .iter()
            .map(|&index| shared.records[index].record)
            .collect();
        selected.sort_unstable_by_key(|record| record.body_entity);
        // The wire format LEB128-encodes strictly increasing body-id gaps, so a
        // duplicate entity is unencodable. A physics-side id-aliasing bug used
        // to send duplicates here, which tripped the encoder's debug assertion
        // and killed the whole match loop (and in release would have emitted a
        // zero gap that desyncs every client's record stream). Never let a bad
        // id upstream take the match down: drop the duplicate and carry on.
        let before = selected.len();
        selected.dedup_by_key(|record| record.body_entity);
        if selected.len() != before {
            self.duplicate_body_records += (before - selected.len()) as u64;
        }

        for record in &selected {
            state
                .last_sent_tick
                .insert(record.body_entity, shared.sim_tick);
            state
                .last_sent_pose
                .insert(record.body_entity, record.pose);
        }
        encode_chunks_datagrams(
            &selected,
            &mut state.sequence,
            self.baseline_id,
            shared.sim_tick,
        )
    }

    /// Reliable topology messages staged since the last take — identical
    /// bytes broadcast to every client.
    pub fn take_topology_messages(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.staged_topology)
    }

    /// Scheduled global baseline: on cadence, snapshot all awake body poses,
    /// advance the baseline generation, and emit the reliable broadcast parts.
    pub fn maybe_emit_baseline(&mut self, sim_tick: u32) -> Option<Vec<Vec<u8>>> {
        let due = self
            .last_baseline_tick
            .is_none_or(|last| sim_tick.saturating_sub(last) >= self.config.baseline_interval_ticks);
        if !due {
            return None;
        }
        self.last_baseline_tick = Some(sim_tick);
        self.baseline_id = self.baseline_id.wrapping_add(1);
        self.baseline_poses.clear();
        let mut records = Vec::with_capacity(self.active_order.len());
        for &entity in &self.active_order {
            if let Some(track) = self.bodies.get(&entity) {
                self.baseline_poses.insert(entity, track.state.pose);
                records.push(BaselineRecord {
                    body_entity: entity,
                    pose: track.state.pose,
                });
            }
        }
        // ≤ 32 KB parts to bound reliable-queue pressure (~17 B/record).
        const RECORDS_PER_PART: usize = 1_800;
        let part_count = records.len().div_ceil(RECORDS_PER_PART).max(1) as u16;
        let mut packets = Vec::new();
        for (part_index, chunk) in records
            .chunks(RECORDS_PER_PART)
            .enumerate()
            .map(|(i, c)| (i as u16, c))
        {
            packets.push(encode_baseline(&BaselineMessage {
                baseline_id: self.baseline_id,
                sim_tick,
                part_index,
                part_count,
                records: chunk.to_vec(),
            }));
        }
        if records.is_empty() {
            packets.push(encode_baseline(&BaselineMessage {
                baseline_id: self.baseline_id,
                sim_tick,
                part_index: 0,
                part_count: 1,
                records: Vec::new(),
            }));
        }
        Some(packets)
    }

    /// Late-join / resync payload.
    pub fn bootstrap_message(&self, sim_tick: u32) -> Vec<u8> {
        encode_bootstrap(&self.ledger.bootstrap(
            sim_tick,
            self.manifest_hash,
            self.baseline_id,
            self.topo_seq,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_netcode::destruction_backend::{FractureBatch, IslandPromotion};

    use crate::city::{build_city_scene, CitySceneDesc};
    use crate::scene_pack::parse_scene_pack;

    fn manifest() -> DestructionManifest {
        let pack = parse_scene_pack(
            r#"{
            "version": 1, "title": "tiny",
            "scenario": {
                "nodes": [
                    {"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0, "volume": 1},
                    {"centroid": {"x": 0, "y": 1, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 2, "z": 0}, "mass": 10, "volume": 1}
                ],
                "bonds": [
                    {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": 0.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 1, "node1": 2, "centroid": {"x": 0, "y": 1.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
                ],
                "nodeSizes": [
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}
                ],
                "nodeColliders": [
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
                ]
            }
        }"#,
        )
        .expect("pack");
        DestructionManifest::from_city(
            &build_city_scene(
                &pack,
                CitySceneDesc {
                    grid: 1,
                    pitch_m: 10.0,
                    varied_heights: false,
                },
            )
            .expect("city"),
        )
    }

    fn promotion_output() -> DestructionTickOutput {
        DestructionTickOutput {
            batches: vec![FractureBatch {
                structure_id: 0,
                broken_bond_ids: vec![ids::bond_id(0, 1)],
                promoted_islands: vec![IslandPromotion {
                    structure_id: 0,
                    island_id: 1,
                    chunks: vec![ids::chunk_id(0, 2)],
                    position: [0.0, 2.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    linear_velocity: [1.0, 0.0, 0.0],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            settled: Vec::new(),
        }
    }

    fn snapshot(tick_offset: f32) -> BodySnapshotInput {
        BodySnapshotInput {
            body_entity: ids::body_entity(0, 1),
            position: [1.0 + tick_offset, 2.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: [1.0, 0.0, 0.0],
            angular_velocity: [0.0, 0.0, 0.0],
            contacts: 0,
            flags: 0,
        }
    }

    fn close_camera() -> Camera {
        Camera {
            eye: Vec3::new(0.0, 2.0, -10.0),
            direction: Vec3::Z,
            fov_degrees: 70.0,
        }
    }

    /// A physics-side id-allocation bug once handed the encoder two records
    /// with the same body entity. The wire format LEB128-encodes strictly
    /// increasing id gaps, so that tripped `encode_chunks_datagrams`'s sorted
    /// assertion and took the entire match loop down with it. Duplicates must
    /// be dropped and counted, never fatal.
    #[test]
    fn duplicate_body_entities_are_dropped_not_fatal() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let _ = encoder.take_topology_messages();
        let _ = encoder.maybe_emit_baseline(10);

        // Same entity twice in one tick, as the aliasing bug produced.
        let duplicated = [snapshot(1.0), snapshot(1.0)];
        assert_eq!(duplicated[0].body_entity, duplicated[1].body_entity);
        encoder.ingest_tick(12, &duplicated, &DestructionTickOutput::default(), &[]);

        // The baseline path has the same strictly-increasing requirement.
        let baseline = encoder.maybe_emit_baseline(12 + 60).expect("baseline");
        assert!(!baseline.is_empty());

        let shared = encoder.encode_send(12);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        for packet in &packets {
            let decoded = crate::wire::decode_chunks_datagram(packet).expect("decodable");
            let entities: Vec<u32> = decoded.records.iter().map(|r| r.body_entity).collect();
            let mut sorted = entities.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(entities.len(), sorted.len(), "duplicate entity reached the wire");
        }
        assert!(
            encoder.stats().duplicate_body_records > 0,
            "the dropped duplicate should be counted so the physics bug stays visible"
        );
    }

    #[test]
    fn fracture_ingest_stages_topology_and_streams_the_island() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);

        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let topology = encoder.take_topology_messages();
        assert_eq!(topology.len(), 1);
        let decoded = crate::wire::decode_topology(&topology[0]).expect("topology");
        assert_eq!(decoded.topo_seq, 1);
        assert_eq!(decoded.batches[0].promoted_islands.len(), 1);

        // Baselines start on the first cadence check.
        let baseline = encoder.maybe_emit_baseline(10).expect("baseline");
        assert_eq!(baseline.len(), 1);

        let shared = encoder.encode_send(10);
        assert_eq!(shared.records.len(), 1);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        assert_eq!(packets.len(), 1);
        let datagram = crate::wire::decode_chunks_datagram(&packets[0]).expect("datagram");
        assert_eq!(datagram.records.len(), 1);
        assert_eq!(datagram.records[0].body_entity, ids::body_entity(0, 1));
    }

    #[test]
    fn irrelevant_bodies_are_not_sent() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);

        // Camera far away, looking away from the island, outside proximity.
        let away = Camera {
            eye: Vec3::new(500.0, 2.0, 500.0),
            direction: Vec3::X,
            fov_degrees: 70.0,
        };
        let shared = encoder.encode_send(10);
        let packets = encoder.client_datagrams(1, away, &shared);
        assert!(packets.is_empty());
    }

    #[test]
    fn deltas_flow_after_a_baseline_and_absolutes_before() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);

        // No baseline yet: records must be absolute-family.
        let shared = encoder.encode_send(10);
        assert!(matches!(
            shared.records[0].record.mode,
            RecordMode::MotionAbsolute | RecordMode::Absolute | RecordMode::Ballistic
        ));

        encoder.maybe_emit_baseline(10).expect("baseline");
        encoder.ingest_tick(12, &[snapshot(0.1)], &DestructionTickOutput::default(), &[]);
        let shared = encoder.encode_send(12);
        // With a baseline stored and the classifier not yet ballistic-stable,
        // moving bodies use motion-delta.
        assert!(matches!(
            shared.records[0].record.mode,
            RecordMode::MotionDelta | RecordMode::Ballistic
        ));
    }

    #[test]
    fn ceiling_bounds_selected_bytes() {
        let manifest = manifest();
        let mut config = EncoderConfig::validated(60);
        config.client_ceiling_bytes = 40; // Room for one ~31-byte motion record.
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);

        // Two islands from two batches.
        let mut output = promotion_output();
        output.batches[0].promoted_islands.push(IslandPromotion {
            structure_id: 0,
            island_id: 2,
            chunks: vec![ids::chunk_id(0, 1)],
            position: [0.0, 1.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: [0.5, 0.0, 0.0],
            ..Default::default()
        });
        let snapshots = [
            snapshot(0.0),
            BodySnapshotInput {
                body_entity: ids::body_entity(0, 2),
                position: [0.5, 1.0, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity: [0.5, 0.0, 0.0],
                angular_velocity: [0.0, 0.0, 0.0],
                contacts: 0,
                flags: 0,
            },
        ];
        encoder.ingest_tick(10, &snapshots, &output, &[]);
        let shared = encoder.encode_send(10);
        assert_eq!(shared.records.len(), 2);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        let total_records: usize = packets
            .iter()
            .map(|p| {
                crate::wire::decode_chunks_datagram(p)
                    .expect("decode")
                    .records
                    .len()
            })
            .sum();
        assert_eq!(total_records, 1, "ceiling must drop the lower-priority body");
    }

    #[test]
    fn bootstrap_reflects_ledger_state() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let bootstrap =
            crate::wire::decode_bootstrap(&encoder.bootstrap_message(11)).expect("bootstrap");
        assert_eq!(bootstrap.manifest_hash, manifest.hash());
        assert_eq!(bootstrap.topo_seq, 1);
        assert_eq!(bootstrap.islands.len(), 1);
        assert_eq!(bootstrap.islands[0].nodes, vec![2]);
        // Bond 1 broken -> alive bitset has only bond 0.
        assert_eq!(bootstrap.structures[0].alive_bonds, vec![0b0000_0001]);
    }
}
