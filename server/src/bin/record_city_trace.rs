//! Record a TWTRACE1 trace from the PhysX GPU + Blast city simulation.
//!
//! The destruction codec has until now measured traces recorded from a sim that
//! welded independent rigid bodies together with fully locked D6 joints. Those
//! joints are soft: chunks drift inside an "island", so the codec had to ship
//! per-chunk repairs to hold the error bound, and the island hierarchy lost to
//! a hierarchy-free per-body codec. This recorder captures the model we ship
//! instead, where the hierarchy is true by construction:
//!
//!   * an intact structure is ONE kinematic body holding every chunk shape,
//!   * fracture migrates shapes onto child bodies when the bond graph actually
//!     disconnects, so a body's chunks are rigid with respect to each other,
//!   * therefore one pose per island body reproduces every chunk under it
//!     exactly, and an untouched building costs nothing per tick.
//!
//! The trace stays TWTRACE1 v3 (`--kind 2` exact bonds) rather than growing a
//! new version. The world is pre-fractured, so the chunk set is fixed for the
//! whole run, which is exactly the fixed actor table the format already
//! assumes; bodies come and go underneath it as `changed_roots`.
//!
//! Chunk poses are not read back from PhysX per shape. They are composed the
//! way a client composes them -- `chunk_world = body_pose ∘ (rest_local - com)`
//! -- so the trace holds what a viewer can actually reconstruct from an island
//! stream, and a codec measured against it is measured against a reachable
//! target rather than an internal state no client ever sees.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use destruction_codec::codec::PhysicalClass;
use destruction_codec::presentation::{MotionSnapshot, PresentationConfig, PresentationTrack};
use destruction_codec::replay::ReplayWriter;
use destruction_codec::trace::{
    ActorDef, ActorState, Camera, Header, Pose as TracePose, Shape, Tick, TopologyEdge,
    TopologyTick, TraceTopology, TraceWriter,
};
use vibe_land_destruction::encoder::{BodySnapshotInput, ChunkStreamEncoder, EncoderConfig};
use vibe_land_destruction::wire::{
    decode_baseline, decode_chunks_datagram, decode_topology, RecordMode, PKT_CITY_BASELINE,
    PKT_CITY_TOPOLOGY, RECORD_FLAG_SETTLED_HINT,
};
use glam::{Quat, Vec3};
use vibe_land_destruction::city::{build_city_scene, CitySceneDesc};
use vibe_land_destruction::city_config::stress_settings;
use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::{ChunkGeometry, DestructionManifest};
use vibe_land_destruction::runtime::CityDestruction;
use vibe_land_destruction::scene_pack::load_scene_pack_file;
use vibe_land_physx_bridge::{
    Pose as BridgePose, Quat as BridgeQuat, StaticBoxDesc, Vec3 as BridgeVec3, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const ALL_GROUPS: u32 = u32::MAX;
const GRAVITY: [f32; 3] = [0.0, -9.81, 0.0];

/// Matches the match server's shot energy so fracture looks like play, not like
/// a synthetic impulse tuned to make the codec look good.
const SHOT_STRESS_IMPULSE: f32 = 1.2e7;
const SHOT_PUSH_SPEED: f32 = 12.0;
const SHOT_BLAST_RADIUS_M: f32 = 2.5;
const SHOT_BLAST_DEPTH_M: f32 = 0.5;

struct Args {
    scene: PathBuf,
    grid: u32,
    hz: u32,
    seconds: f32,
    settle_ticks: u32,
    shot_interval_ticks: u32,
    shots: u32,
    /// How many structures to attack (0 = all). The rest stand untouched,
    /// which is the case the island model is built for: an intact structure is
    /// one kinematic body and costs nothing per tick no matter how many chunks
    /// it was authored from.
    targets: u32,
    output: PathBuf,
    /// Also record what a wire-v2 client would DISPLAY, as a renderable
    /// towerstate, by running the real ChunkStreamEncoder and modelling the
    /// client from its decoded bytes.
    v2_view: Option<PathBuf>,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut scene = default_scene_path();
        let mut grid = 1u32;
        let mut hz = 60u32;
        let mut seconds = 30.0f32;
        let mut settle_ticks = 60u32;
        let mut shot_interval_ticks = 14u32;
        let mut shots = 48u32;
        let mut targets = 0u32;
        let mut output = PathBuf::from("city.towertrace");
        let mut v2_view = None;

        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let mut value = || -> Result<String> {
                args.next()
                    .with_context(|| format!("{flag} needs a value"))
            };
            match flag.as_str() {
                "--scene" => scene = PathBuf::from(value()?),
                "--grid" => grid = value()?.parse()?,
                "--hz" => hz = value()?.parse()?,
                "--seconds" => seconds = value()?.parse()?,
                "--settle-ticks" => settle_ticks = value()?.parse()?,
                "--shot-interval-ticks" => shot_interval_ticks = value()?.parse()?,
                "--shots" => shots = value()?.parse()?,
                "--targets" => targets = value()?.parse()?,
                "--output" => output = PathBuf::from(value()?),
                "--v2-view" => v2_view = Some(PathBuf::from(value()?)),
                "--help" | "-h" => {
                    println!(
                        "record-city-trace --output <path> [--scene <pack.json>] \
                         [--grid N] [--hz 60] [--seconds 30] [--settle-ticks 60] \
                         [--shots N] [--targets N] [--shot-interval-ticks N]"
                    );
                    std::process::exit(0);
                }
                other => bail!("unknown flag {other}"),
            }
        }
        if grid == 0 || grid > 8 {
            // 6 structure-id bits; grid 8 is 64 structures, the packing limit.
            bail!("--grid must be 1..=8 ({} structures max)", ids::MAX_STRUCTURES);
        }
        Ok(Self {
            scene,
            grid,
            hz,
            seconds,
            settle_ticks,
            shot_interval_ticks,
            shots,
            targets,
            output,
            v2_view,
        })
    }
}

fn default_scene_path() -> PathBuf {
    let file = std::env::var("VIBE_CITY_SCENE")
        .unwrap_or_else(|_| "high-rise-10f-local.json".to_string());
    if let Ok(dir) = std::env::var("VIBE_DESTRUCTION_ASSET_DIR") {
        return PathBuf::from(dir).join(&file);
    }
    let candidates = [
        PathBuf::from("destruction/assets/scenes").join(&file),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../destruction/assets/scenes")
            .join(&file),
    ];
    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }
    candidates[0].clone()
}

/// Dense actor table over every chunk in the scene.
///
/// TWTRACE1 requires contiguous actor ids, so the packed `chunk_id` lives in
/// the topology manifest's `actor_global_ids` and the dense index is the wire
/// identity. Both sides of the codec key on the dense index; the packed id is
/// what ties a row back to the shared manifest a client already downloaded.
struct ChunkTable {
    /// Dense index -> packed chunk id.
    global_ids: Vec<u32>,
    /// Dense index -> rest centroid in its structure's frame.
    rest: Vec<Vec3>,
    /// Dense index -> mass (0.0 marks a world-support anchor).
    mass: Vec<f32>,
    /// Dense index -> owning structure.
    structure: Vec<u32>,
    /// Dense index -> its structure's world transform.
    ///
    /// Needed because the adapter excludes kinematic bodies from the snapshot
    /// stream (an intact structure never moves, so the network has nothing to
    /// say about it). Those chunks still need a world pose in the trace, and it
    /// is exactly the structure transform applied to the rest centroid.
    structure_pose: Vec<(Vec3, Quat)>,
    /// Packed chunk id -> dense index.
    by_global: HashMap<u32, u32>,
    actors: Vec<ActorDef>,
    edges: Vec<TopologyEdge>,
}

fn build_chunk_table(manifest: &DestructionManifest) -> ChunkTable {
    let total: usize = manifest.structures.iter().map(|s| s.chunks.len()).sum();
    let mut table = ChunkTable {
        global_ids: Vec::with_capacity(total),
        rest: Vec::with_capacity(total),
        mass: Vec::with_capacity(total),
        structure: Vec::with_capacity(total),
        structure_pose: Vec::with_capacity(total),
        by_global: HashMap::with_capacity(total),
        actors: Vec::with_capacity(total),
        edges: Vec::new(),
    };

    for structure in &manifest.structures {
        let structure_pose = (
            Vec3::from_array(structure.world_position),
            Quat::from_xyzw(
                structure.world_rotation[0],
                structure.world_rotation[1],
                structure.world_rotation[2],
                structure.world_rotation[3],
            )
            .normalize(),
        );
        for chunk in &structure.chunks {
            let index = table.actors.len() as u32;
            let global = ids::chunk_id(structure.structure_id, chunk.node_index);
            table.by_global.insert(global, index);
            table.global_ids.push(global);
            table
                .rest
                .push(Vec3::from_array(chunk.centroid));
            table.mass.push(chunk.mass);
            table.structure.push(structure.structure_id);
            table.structure_pose.push(structure_pose);
            // The client draws every chunk as a box of `size`, including hull
            // packs, so the trace carries the same proxy the viewer sees rather
            // than a hull the renderer would not draw.
            let half = Vec3::from_array(chunk.size) * 0.5;
            let params = match &chunk.geometry {
                ChunkGeometry::Cuboid { half_extents } => Vec3::from_array(*half_extents),
                ChunkGeometry::ConvexHull { .. } => half,
            };
            table.actors.push(ActorDef {
                id: index,
                part: if chunk.support { 6 } else { 0 },
                linear_damping: 0.0,
                angular_damping: 0.0,
                shapes: vec![Shape {
                    kind: 1,
                    params,
                    local: TracePose::default(),
                }],
                bounding_radius: chunk.radius.max(params.length()),
            });
        }
    }

    for structure in &manifest.structures {
        for bond in &structure.bonds {
            let a = ids::chunk_id(structure.structure_id, bond.node0);
            let b = ids::chunk_id(structure.structure_id, bond.node1);
            let (Some(&first), Some(&second)) =
                (table.by_global.get(&a), table.by_global.get(&b))
            else {
                continue;
            };
            if first == second {
                continue;
            }
            table.edges.push(TopologyEdge {
                global_id: ids::bond_id(structure.structure_id, bond.bond_index) as u64,
                // The format requires ordered endpoints; a bond is undirected,
                // and its global id already identifies it.
                first: first.min(second),
                second: first.max(second),
                // kind 2 = exact Blast bond: the codec keeps the manifest rest
                // locals instead of re-baking them at every topology epoch,
                // which is the whole point of moving off D6.
                kind: 2,
            });
        }
    }
    // The format requires strictly increasing global ids.
    table.edges.sort_unstable_by_key(|edge| edge.global_id);
    table.edges.dedup_by_key(|edge| edge.global_id);
    table
}

/// Which island body owns each chunk, and each body's centre of mass.
///
/// This mirrors the client ledger exactly (`client/src/city/topology.ts`),
/// because the poses written to the trace have to be the poses a client can
/// rebuild. Membership moves on promotions and migrations; the centre of mass
/// is recomputed only for bodies whose membership actually changed.
struct Membership {
    /// Dense chunk index -> owning body entity.
    body_of: Vec<u32>,
    /// Body entity -> dense chunk indices.
    members: HashMap<u32, BTreeSet<u32>>,
    /// Body entity -> centre of mass in structure-rest coordinates.
    com: HashMap<u32, Vec3>,
}

impl Membership {
    fn new(table: &ChunkTable) -> Self {
        let mut body_of = vec![0u32; table.actors.len()];
        let mut members: HashMap<u32, BTreeSet<u32>> = HashMap::new();
        for index in 0..table.actors.len() as u32 {
            // Everything starts on its structure's intact support body, which
            // is serial 0 by convention and the only body that exists before
            // the first fracture.
            let body = ids::body_entity(table.structure[index as usize], ids::SUPPORT_ISLAND_SERIAL);
            body_of[index as usize] = body;
            members.entry(body).or_default().insert(index);
        }
        let mut this = Self {
            body_of,
            members,
            com: HashMap::new(),
        };
        let bodies: Vec<u32> = this.members.keys().copied().collect();
        for body in bodies {
            this.recompute_com(body, table);
        }
        this
    }

    fn recompute_com(&mut self, body: u32, table: &ChunkTable) {
        let Some(set) = self.members.get(&body) else {
            self.com.remove(&body);
            return;
        };
        if set.is_empty() {
            self.com.remove(&body);
            return;
        }
        let mut sum = Vec3::ZERO;
        let mut weight_total = 0.0f32;
        for &index in set {
            // Support anchors carry zero mass; the client weights them 1 so a
            // body made only of anchors still has a defined frame.
            let mass = table.mass[index as usize];
            let weight = if mass > 0.0 { mass } else { 1.0 };
            sum += table.rest[index as usize] * weight;
            weight_total += weight;
        }
        if weight_total > 0.0 {
            self.com.insert(body, sum / weight_total);
        } else {
            self.com.remove(&body);
        }
    }

    fn move_chunk(&mut self, index: u32, to: u32) -> Option<u32> {
        let from = self.body_of[index as usize];
        if from == to {
            return None;
        }
        if let Some(set) = self.members.get_mut(&from) {
            set.remove(&index);
        }
        self.members.entry(to).or_default().insert(index);
        self.body_of[index as usize] = to;
        Some(from)
    }

    /// Body-local offset for a chunk.
    ///
    /// The intact support body is the one exception to the centre-of-mass
    /// frame: it is created at the structure transform with every shape at its
    /// authored local pose, so its offsets are the rest centroids themselves.
    /// `reoffsetBody` in the client skips the support serial for the same
    /// reason.
    fn local_offset(&self, index: u32, table: &ChunkTable) -> Vec3 {
        let body = self.body_of[index as usize];
        let rest = table.rest[index as usize];
        if ids::body_entity_parts(body).1 == ids::SUPPORT_ISLAND_SERIAL {
            return rest;
        }
        match self.com.get(&body) {
            Some(com) => rest - *com,
            None => rest,
        }
    }
}


/// What a wire-v2 client would display, reconstructed from bytes alone.
///
/// The starvation measurements ended at a question server-side metrics cannot
/// answer: v2 leaves slow-moving bodies 40+ seconds stale *on purpose*, judging
/// them inside its two-pixel error budget -- and whether that is fine or awful
/// is a property of the picture, not of a percentile. So this models the client
/// and renders the picture.
///
/// Honesty rule: the model consumes only the byte packets the real encoder
/// emits, through the same `wire::decode_*` the browser mirrors. It never reads
/// encoder internals. A body the client was never told about is simply never
/// drawn differently from bootstrap state, exactly like the real ledger.
struct V2ClientModel {
    encoder: ChunkStreamEncoder,
    camera: vibe_land_destruction::types::Camera,
    writer: ReplayWriter,
    /// Client-side membership ledger, driven by DECODED topology.
    membership: Membership,
    /// Delta reference poses per baseline generation (keep 2, like the client).
    baselines: std::collections::HashMap<u16, HashMap<u32, Vec3>>,
    tracks: HashMap<u32, PresentationTrack>,
    /// Bodies parked by a settle record; pose is authoritative until records
    /// resume for the body.
    settled: HashMap<u32, TracePose>,
    presentation: PresentationConfig,
    actor_template: ActorDef,
    pose_bytes: u64,
    topology_bytes: u64,
    baseline_bytes: u64,
}

impl V2ClientModel {
    fn new(
        manifest: &vibe_land_destruction::manifest::DestructionManifest,
        table: &ChunkTable,
        header: &Header,
        actors: &[ActorDef],
        path: &std::path::Path,
        hz: u32,
    ) -> Result<Self> {
        let mut config = EncoderConfig::validated(hz);
        // Mirror CityRuntime::from_parts: 30 Hz sends, wide proximity.
        config.send_interval_ticks = (hz / 30).max(1);
        config.interest.proximity_meters = 120.0;
        let mut encoder = ChunkStreamEncoder::new(manifest, config);
        encoder.add_client(1);
        // Interest is evaluated from the pane-0 camera, so the pane the video
        // shows is the view the encoder was actually serving.
        let hero = header.cameras[0];
        let camera = vibe_land_destruction::types::Camera {
            eye: glam::Vec3::new(hero.eye.x, hero.eye.y, hero.eye.z),
            direction: glam::Vec3::new(hero.direction.x, hero.direction.y, hero.direction.z),
            fov_degrees: 80.0,
        };
        let mut writer = ReplayWriter::create(path, header, actors, 30)?;
        // Frame 0 = bootstrap state: every chunk at its structure rest pose.
        let mut initial = Vec::with_capacity(actors.len());
        for index in 0..actors.len() as u32 {
            let (origin, rotation) = table.structure_pose[index as usize];
            initial.push((
                index,
                TracePose {
                    position: origin + rotation * table.rest[index as usize],
                    rotation,
                },
                true,
            ));
        }
        writer.write_frame_subset(&initial)?;
        Ok(Self {
            encoder,
            camera,
            writer,
            membership: Membership::new(table),
            baselines: std::collections::HashMap::new(),
            tracks: HashMap::new(),
            settled: HashMap::new(),
            presentation: PresentationConfig {
                // The browser client's presentationConfig60Hz.
                interpolation_delay_ticks: 6,
                max_extrapolation_ticks: 8,
                correction_seconds: 0.1,
                dt: 1.0 / hz as f32,
                gravity: Vec3::from_array(GRAVITY),
                snap_distance_meters: 5.0,
            },
            actor_template: ActorDef {
                id: 0,
                part: 0,
                linear_damping: 0.05,
                angular_damping: 0.05,
                shapes: Vec::new(),
                bounding_radius: 1.0,
            },
            pose_bytes: 0,
            topology_bytes: 0,
            baseline_bytes: 0,
        })
    }

    /// Server side of the tick: feed the real encoder, then hand every emitted
    /// packet straight back to the client half as bytes.
    fn server_tick(
        &mut self,
        tick: u32,
        snapshots: &[BodySnapshotInput],
        output: &vibe_netcode::destruction_backend::DestructionTickOutput,
        table: &ChunkTable,
    ) -> Result<()> {
        self.encoder.ingest_tick(tick, snapshots, output, &[]);
        let mut reliable = self.encoder.take_topology_messages();
        if let Some(baselines) = self.encoder.maybe_emit_baseline(tick) {
            reliable.extend(baselines);
        }
        for packet in reliable {
            self.apply_reliable(&packet, table)?;
        }
        if tick % self.encoder_send_interval() == 0 {
            let shared = self.encoder.encode_send(tick);
            if !shared.records.is_empty() {
                for packet in self.encoder.client_datagrams(1, self.camera, &shared) {
                    self.apply_datagram(&packet)?;
                }
            }
        }
        Ok(())
    }

    fn encoder_send_interval(&self) -> u32 {
        2
    }

    fn apply_reliable(&mut self, packet: &[u8], table: &ChunkTable) -> Result<()> {
        match packet.first().copied() {
            Some(PKT_CITY_TOPOLOGY) => {
                self.topology_bytes += packet.len() as u64;
                let message =
                    decode_topology(packet).map_err(|error| anyhow::anyhow!("{error:?}"))?;
                for batch in &message.batches {
                    for promotion in &batch.promoted_islands {
                        let body = ids::body_entity(promotion.structure_id, promotion.island_id);
                        for &chunk in &promotion.chunks {
                            if let Some(&index) = table.by_global.get(&chunk) {
                                self.membership.move_chunk(index, body);
                            }
                        }
                        self.membership.recompute_com(body, table);
                        // Promotions carry pose + velocity on the reliable
                        // channel, so a fresh island is visible immediately --
                        // this is the promotion-glide seed.
                        let snapshot = MotionSnapshot {
                            tick: message.sim_tick,
                            pose: TracePose {
                                position: Vec3::from_array(promotion.position),
                                rotation: glam::Quat::from_array(promotion.rotation).normalize(),
                            },
                            linear_velocity: Vec3::from_array(promotion.linear_velocity),
                            angular_velocity: Vec3::from_array(promotion.angular_velocity),
                            class: PhysicalClass::ContactActive,
                        };
                        self.settled.remove(&body);
                        self.track_for(body).push(snapshot);
                    }
                    for migration in &batch.migrations {
                        if let Some(&index) = table.by_global.get(&migration.chunk_id) {
                            let to = ids::body_entity(batch.structure_id, migration.to_island_id);
                            if let Some(from) = self.membership.move_chunk(index, to) {
                                self.membership.recompute_com(from, table);
                            }
                            self.membership.recompute_com(to, table);
                        }
                    }
                    for &retired in &batch.retired_island_ids {
                        let body = ids::body_entity(batch.structure_id, retired);
                        self.tracks.remove(&body);
                        self.settled.remove(&body);
                        // Chunks still mapped to the body keep their last drawn
                        // pose -- the real ledger's stale-orphan behaviour.
                    }
                }
                for settle in &message.settled {
                    let body = ids::body_entity(settle.structure_id, settle.island_id);
                    self.tracks.remove(&body);
                    self.settled.insert(
                        body,
                        TracePose {
                            position: Vec3::from_array(settle.position),
                            rotation: glam::Quat::from_array(settle.rotation).normalize(),
                        },
                    );
                }
            }
            Some(PKT_CITY_BASELINE) => {
                self.baseline_bytes += packet.len() as u64;
                let message =
                    decode_baseline(packet).map_err(|error| anyhow::anyhow!("{error:?}"))?;
                let poses = self.baselines.entry(message.baseline_id).or_default();
                for record in &message.records {
                    poses.insert(record.body_entity, record.pose.position);
                }
                // Keep two generations, like the browser ledger: the one being
                // replaced still has deltas in flight against it.
                if self.baselines.len() > 2 {
                    let newest = message.baseline_id;
                    self.baselines
                        .retain(|&id, _| id == newest || id.wrapping_add(1) == newest);
                }
            }
            other => anyhow::bail!("unexpected reliable packet kind {other:?}"),
        }
        Ok(())
    }

    fn apply_datagram(&mut self, packet: &[u8]) -> Result<()> {
        self.pose_bytes += packet.len() as u64;
        let datagram =
            decode_chunks_datagram(packet).map_err(|error| anyhow::anyhow!("{error:?}"))?;
        for record in &datagram.records {
            let position = match record.mode {
                RecordMode::Delta | RecordMode::MotionDelta => {
                    // Delta against a baseline generation the client may not
                    // have yet; the real ledger defers such records, and the
                    // honest equivalent here is to drop them.
                    match self
                        .baselines
                        .get(&datagram.baseline_id)
                        .and_then(|poses| poses.get(&record.body_entity))
                    {
                        Some(base) => *base + record.position,
                        None => continue,
                    }
                }
                _ => record.position,
            };
            let class = match record.mode {
                RecordMode::Ballistic => PhysicalClass::Ballistic,
                _ if record.flags & RECORD_FLAG_SETTLED_HINT != 0 => PhysicalClass::Quiescent,
                _ => PhysicalClass::ContactActive,
            };
            let snapshot = MotionSnapshot {
                tick: datagram.sim_tick,
                pose: TracePose {
                    position,
                    rotation: record.rotation.normalize(),
                },
                linear_velocity: record.linear_velocity,
                angular_velocity: record.angular_velocity,
                class,
            };
            self.settled.remove(&record.body_entity);
            self.track_for(record.body_entity).push(snapshot);
        }
        Ok(())
    }

    fn track_for(&mut self, body: u32) -> &mut PresentationTrack {
        let (template, config) = (&self.actor_template, self.presentation);
        self.tracks
            .entry(body)
            .or_insert_with(|| PresentationTrack::new(template, config))
    }

    /// One displayed frame: sample every live track, compose member chunks.
    fn write_frame(&mut self, tick: u32, table: &ChunkTable) -> Result<()> {
        let mut updates: Vec<(u32, TracePose, bool)> = Vec::new();
        let sampled: Vec<(u32, TracePose)> = self
            .tracks
            .iter_mut()
            .map(|(&body, track)| {
                let state = track.sample(tick as f32);
                (body, state.pose)
            })
            .collect();
        for (body, pose) in sampled {
            self.compose_members(body, pose, false, table, &mut updates);
        }
        let parked: Vec<(u32, TracePose)> =
            self.settled.iter().map(|(&body, &pose)| (body, pose)).collect();
        for (body, pose) in parked {
            self.compose_members(body, pose, true, table, &mut updates);
        }
        updates.sort_by_key(|(index, _, _)| *index);
        updates.dedup_by_key(|(index, _, _)| *index);
        self.writer.write_frame_subset(&updates)?;
        Ok(())
    }

    fn compose_members(
        &self,
        body: u32,
        body_pose: TracePose,
        sleeping: bool,
        table: &ChunkTable,
        updates: &mut Vec<(u32, TracePose, bool)>,
    ) {
        let Some(members) = self.membership.members.get(&body) else {
            return;
        };
        for &index in members {
            let local = self.membership.local_offset(index, table);
            updates.push((
                index,
                TracePose {
                    position: body_pose.position + body_pose.rotation * local,
                    rotation: body_pose.rotation,
                },
                // The renderer darkens sleeping bodies; matching truth's
                // semantics is what makes the panes comparable.
                sleeping,
            ));
        }
    }

    fn finish(mut self) -> Result<(u64, u64, u64)> {
        self.writer.finish()?;
        Ok((self.pose_bytes, self.topology_bytes, self.baseline_bytes))
    }
}

fn main() -> Result<()> {
    let args = Args::parse()?;

    let pack = load_scene_pack_file(&args.scene)
        .map_err(|error| anyhow::anyhow!("{error}"))
        .with_context(|| format!("loading scene pack {}", args.scene.display()))?;
    let scene = build_city_scene(
        &pack,
        CitySceneDesc {
            grid: args.grid,
            ..CitySceneDesc::default()
        },
    )
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    let manifest = Arc::new(DestructionManifest::from_city(&scene));
    let table = build_chunk_table(&manifest);
    println!(
        "scene {} | structures {} | chunks {} | bonds {}",
        args.scene.display(),
        manifest.structures.len(),
        table.actors.len(),
        table.edges.len()
    );

    let mut world = World::new(WorldConfig::default()).context("PhysX GPU world")?;
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: BridgePose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: BridgeQuat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .context("ground plane")?;

    let settings = stress_settings(&pack.materials);
    let mut destruction = CityDestruction::build(manifest.clone(), &mut world, settings, args.hz)
        .map_err(|error| anyhow::anyhow!("{error}"))?;

    let dt = 1.0 / args.hz as f32;
    let total_ticks = (args.seconds * args.hz as f32).round() as u32;
    let extent = scene_extent(&manifest);
    let header = Header {
        physics_hz: args.hz,
        tick_count: total_ticks,
        pane_width: 960,
        pane_height: 540,
        gravity: Vec3::from_array(GRAVITY),
        cameras: overview_cameras(extent),
    };

    let topology = TraceTopology {
        actor_global_ids: table.global_ids.iter().map(|&id| id as u64).collect(),
        edges: table.edges.clone(),
    };
    let mut writer = TraceWriter::create_with_topology(&args.output, &header, &table.actors, &topology)
        .context("open trace for writing")?;

    let mut membership = Membership::new(&table);
    let mut v2 = match &args.v2_view {
        Some(path) => Some(V2ClientModel::new(
            &manifest,
            &table,
            &header,
            &table.actors,
            path,
            args.hz,
        )?),
        None => None,
    };
    let view_step = (args.hz / 30).max(1);
    let shot_plan = build_shot_plan(&manifest, args.shots, args.targets);
    let mut epoch = 0u32;
    // Sentinel, so every actor counts as changed on tick 0: the format
    // requires the first tick to carry a complete island map rather than a
    // delta against an implied state.
    let mut roots = vec![u32::MAX; table.actors.len()];
    let mut broken_total = 0u64;
    let mut migrations_total = 0u64;
    let mut mismatch_ticks = 0u64;
    let mut peak_bodies = 0usize;
    let mut next_shot = 0usize;

    for tick_index in 0..total_ticks {
        if tick_index >= args.settle_ticks
            && next_shot < shot_plan.len()
            && (tick_index - args.settle_ticks) % args.shot_interval_ticks == 0
        {
            let (origin, direction) = shot_plan[next_shot];
            fire(&mut destruction, &mut world, origin, direction);
            next_shot += 1;
        }

        world.step().map_err(|error| anyhow::anyhow!("{error}"))?;
        let output = destruction
            .post_step(&mut world, dt, GRAVITY)
            .map_err(|error| anyhow::anyhow!("{error}"))?;

        if let Some(v2) = v2.as_mut() {
            let snapshots = destruction
                .body_snapshots(&world)
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            v2.server_tick(tick_index, snapshots, &output, &table)?;
            if tick_index % view_step == 0 && tick_index > 0 {
                v2.write_frame(tick_index, &table)?;
            }
        }

        // Apply topology deltas before reading poses: a chunk promoted this
        // tick must be composed against its NEW body's frame, or it draws one
        // centre-of-mass height off for exactly one frame.
        let mut broken_edges: Vec<u64> = Vec::new();
        let mut touched: BTreeSet<u32> = BTreeSet::new();
        for batch in &output.batches {
            for &bond in &batch.broken_bond_ids {
                broken_edges.push(bond as u64);
            }
            for promotion in &batch.promoted_islands {
                let body = ids::body_entity(promotion.structure_id, promotion.island_id);
                for &chunk in &promotion.chunks {
                    let Some(&index) = table.by_global.get(&chunk) else {
                        continue;
                    };
                    if let Some(from) = membership.move_chunk(index, body) {
                        touched.insert(from);
                    }
                    touched.insert(body);
                }
            }
            for migration in &batch.migrations {
                let Some(&index) = table.by_global.get(&migration.chunk_id) else {
                    continue;
                };
                let to = ids::body_entity(batch.structure_id, migration.to_island_id);
                if let Some(from) = membership.move_chunk(index, to) {
                    touched.insert(from);
                }
                touched.insert(to);
                migrations_total += 1;
            }
        }
        broken_total += broken_edges.len() as u64;
        broken_edges.sort_unstable();
        for body in &touched {
            membership.recompute_com(*body, &table);
        }

        let snapshots = world
            .chunk_body_snapshots()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let mut by_entity: HashMap<u32, &_> = HashMap::with_capacity(snapshots.len());
        for snapshot in snapshots {
            by_entity.insert(snapshot.entity_id, snapshot);
        }
        peak_bodies = peak_bodies.max(snapshots.len());

        // The adapter is the authority on how many shapes a body carries. If
        // our ledger disagrees, membership has drifted and every pose composed
        // against that body's frame is wrong -- count it rather than writing a
        // trace that silently encodes the drift.
        for (entity, members) in &membership.members {
            if members.is_empty() {
                continue;
            }
            if let Some(snapshot) = by_entity.get(entity) {
                if snapshot.node_count as usize != members.len() {
                    mismatch_ticks += 1;
                    break;
                }
            }
        }

        let mut states = Vec::with_capacity(table.actors.len());
        for index in 0..table.actors.len() as u32 {
            let body = membership.body_of[index as usize];
            let local = membership.local_offset(index, &table);
            let state = match by_entity.get(&body) {
                Some(snapshot) => {
                    let rotation = Quat::from_xyzw(
                        snapshot.rotation.x,
                        snapshot.rotation.y,
                        snapshot.rotation.z,
                        snapshot.rotation.w,
                    )
                    .normalize();
                    let body_position = Vec3::new(
                        snapshot.position.x,
                        snapshot.position.y,
                        snapshot.position.z,
                    );
                    let offset = rotation * local;
                    let angular = Vec3::new(
                        snapshot.angular_velocity.x,
                        snapshot.angular_velocity.y,
                        snapshot.angular_velocity.z,
                    );
                    let linear = Vec3::new(
                        snapshot.linear_velocity.x,
                        snapshot.linear_velocity.y,
                        snapshot.linear_velocity.z,
                    );
                    let mut flags = 0u8;
                    if snapshot.sleeping {
                        flags |= 1;
                    }
                    if snapshot.kinematic {
                        flags |= 2;
                    }
                    ActorState {
                        pose: TracePose {
                            position: body_position + offset,
                            rotation,
                        },
                        // A rigid body's member chunk moves with the body:
                        // v = v_com + w x r. Writing the body's own velocity
                        // would understate a chunk far from the axis and make
                        // the codec's ballistic fits reject good segments.
                        linear_velocity: linear + angular.cross(offset),
                        angular_velocity: angular,
                        contacts: 0,
                        // No joints in this model. The codec reads a nonzero
                        // count as "still attached", which for a Blast island
                        // is what membership already says.
                        intact_joints: 0,
                        flags,
                    }
                }
                None => {
                    // No dynamic snapshot: this chunk is still carried by its
                    // structure's kinematic support body, which the adapter
                    // omits precisely because it never moves.
                    let (origin, rotation) = table.structure_pose[index as usize];
                    ActorState {
                    pose: TracePose {
                        position: origin + rotation * table.rest[index as usize],
                        rotation,
                    },
                    linear_velocity: Vec3::ZERO,
                    angular_velocity: Vec3::ZERO,
                    contacts: 0,
                    intact_joints: 0,
                    flags: 1 | 2,
                    }
                }
            };
            states.push(state);
        }

        let new_roots = compute_roots(&membership, &table);
        let mut changed_roots = Vec::new();
        for index in 0..new_roots.len() {
            if new_roots[index] != roots[index] {
                changed_roots.push((index as u32, new_roots[index]));
            }
        }
        if !broken_edges.is_empty() || !changed_roots.is_empty() {
            epoch += 1;
        }
        roots = new_roots;

        writer
            .write_tick(&Tick {
                index: tick_index,
                simulation_time: tick_index as f32 * dt,
                states,
                contact_pairs: Vec::new(),
                topology: TopologyTick {
                    epoch,
                    broken_edges,
                    changed_roots,
                    island_roots: roots.clone(),
                },
            })
            .context("write tick")?;

        if tick_index % (args.hz * 5) == 0 {
            let stats = destruction.stats();
            println!(
                "tick {:>6}  bodies {:>6}  awake {:>6}  broken {:>7}  solve {:.2} ms",
                tick_index,
                stats.chunk_bodies,
                stats.awake_chunk_bodies,
                stats.broken_bonds,
                stats.stress_solve_ms
            );
        }
    }

    writer.finish().context("finalise trace")?;
    if let Some(v2) = v2.take() {
        let (pose_bytes, topology_bytes, baseline_bytes) = v2.finish()?;
        let seconds = f64::from(total_ticks) / f64::from(args.hz);
        let mbps = |bytes: u64| bytes as f64 * 8.0 / seconds / 1.0e6;
        let reliable = topology_bytes + baseline_bytes;
        println!(
            "v2 view: poses {} B ({:.3} Mbps) | topology {} B ({:.3}) | baseline {} B ({:.3}) | reliable share {:.1}%",
            pose_bytes,
            mbps(pose_bytes),
            topology_bytes,
            mbps(topology_bytes),
            baseline_bytes,
            mbps(baseline_bytes),
            100.0 * reliable as f64 / (reliable + pose_bytes).max(1) as f64
        );
    }

    let stats = destruction.stats();
    if mismatch_ticks > 0 {
        // Loud, but not fatal: the trace is still the client-reconstructable
        // truth, and the count is the measurement of how far the shape ledger
        // and the adapter disagree.
        eprintln!(
            "warning: membership disagreed with adapter node_count on {mismatch_ticks} ticks"
        );
    }
    println!(
        "\nwrote {}\n  ticks {}  chunks {}  bonds {}\n  broken bonds {} (adapter {})\n  \
         migrations {}  peak bodies {}  membership mismatches {}",
        args.output.display(),
        total_ticks,
        table.actors.len(),
        table.edges.len(),
        broken_total,
        stats.broken_bonds,
        migrations_total,
        peak_bodies,
        mismatch_ticks
    );

    let sidecar = args.output.with_extension("sidecar.json");
    let per_structure: Vec<serde_json::Value> = manifest
        .structures
        .iter()
        .map(|structure| {
            serde_json::json!({
                "structureId": structure.structure_id,
                "chunks": structure.chunks.len(),
                "bonds": structure.bonds.len(),
                // What a wire format needs to size its id fields: both sides
                // hold the manifest, so ids never need more bits than this.
                "chunkIdBits": bits_for(structure.chunks.len()),
                "bondIdBits": bits_for(structure.bonds.len()),
            })
        })
        .collect();
    std::fs::write(
        &sidecar,
        serde_json::to_vec_pretty(&serde_json::json!({
            "manifestHash": manifest.hash_hex(),
            "scene": args.scene.display().to_string(),
            "grid": args.grid,
            "physicsHz": args.hz,
            "ticks": total_ticks,
            "chunks": table.actors.len(),
            "bonds": table.edges.len(),
            "brokenBonds": broken_total,
            "chunkMigrations": migrations_total,
            "peakBodies": peak_bodies,
            "membershipMismatchTicks": mismatch_ticks,
            "structures": per_structure,
        }))?,
    )?;
    println!("wrote {}", sidecar.display());
    Ok(())
}

fn bits_for(count: usize) -> u32 {
    if count <= 1 {
        return 1;
    }
    (count as u64 - 1).ilog2() + 1
}

/// Island root per chunk: the lowest dense index sharing its body.
///
/// One definition, used for both the trace's `island_roots` and anything that
/// later recomputes membership from the bond graph, so the two cannot drift.
fn compute_roots(membership: &Membership, table: &ChunkTable) -> Vec<u32> {
    let mut roots = vec![0u32; table.actors.len()];
    for (_, members) in &membership.members {
        let Some(&root) = members.iter().next() else {
            continue;
        };
        for &index in members {
            roots[index as usize] = root;
        }
    }
    roots
}

fn scene_extent(manifest: &DestructionManifest) -> f32 {
    let mut extent: f32 = 20.0;
    for structure in &manifest.structures {
        let p = structure.world_position;
        extent = extent.max(p[0].abs().max(p[2].abs()) + 20.0);
    }
    extent
}

fn overview_cameras(extent: f32) -> [Camera; 4] {
    let d = extent * 1.6;
    let make = |eye: Vec3, fov: f32| Camera {
        eye,
        direction: (Vec3::new(0.0, 8.0, 0.0) - eye).normalize(),
        fov_degrees: fov,
    };
    [
        // Hero pane: low and close, on the side the shots come from.
        make(Vec3::new(0.0, 0.22 * d, 0.72 * d), 60.0),
        make(Vec3::new(d, 0.5 * d, 0.0), 60.0),
        make(Vec3::new(-0.7 * d, 0.25 * d, -0.7 * d), 60.0),
        make(Vec3::new(0.0, 1.4 * d, 0.01), 60.0),
    ]
}

/// Shots that rake each building around a height band, cycling structures so a
/// multi-building scene collapses broadly instead of felling one tower while
/// the rest stand untouched.
fn build_shot_plan(
    manifest: &DestructionManifest,
    shots: u32,
    targets: u32,
) -> Vec<(Vec3, Vec3)> {
    let mut plan = Vec::with_capacity(shots as usize);
    if manifest.structures.is_empty() {
        return plan;
    }
    // Order by distance from the camera, which sits on +Z looking back at the
    // origin. Shooting the nearest row means the damage is the thing on screen
    // rather than something hidden behind an intact facade -- an earlier plan
    // fired from -Z and every recording showed the undamaged back of the city.
    let mut order: Vec<&_> = manifest.structures.iter().collect();
    order.sort_by(|a, b| {
        b.world_position[2]
            .partial_cmp(&a.world_position[2])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.world_position[0]
                    .abs()
                    .partial_cmp(&b.world_position[0].abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let pool = if targets == 0 {
        order.len()
    } else {
        (targets as usize).min(order.len())
    };

    for shot in 0..shots {
        let structure = order[shot as usize % pool];
        let centre = Vec3::from_array(structure.world_position);
        let round = shot / pool.max(1) as u32;
        // Rake across the facade and climb, so a sustained barrage cuts a band
        // rather than drilling one hole.
        let sweep = -4.0 + (round % 17) as f32 * 0.5;
        let aim_y = 2.0 + (round % 11) as f32 * 2.0;
        // Same side as the camera.
        let origin = centre + Vec3::new(sweep * 0.4, 1.8, 30.0);
        let target = centre + Vec3::new(sweep, aim_y, 0.0);
        plan.push((origin, (target - origin).normalize()));
    }
    plan
}

fn fire(destruction: &mut CityDestruction, world: &mut World, origin: Vec3, direction: Vec3) {
    use vibe_land_physx_bridge::RaycastRequest;
    let hit = world
        .raycast(RaycastRequest {
            origin: BridgeVec3::new(origin.x, origin.y, origin.z),
            direction: BridgeVec3::new(direction.x, direction.y, direction.z),
            max_distance: 200.0,
            collision_mask: vibe_land_destruction::runtime::GROUP_CHUNK,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .ok()
        .filter(|hit| hit.hit);
    let Some(hit) = hit else {
        return;
    };
    let surface = Vec3::new(hit.position.x, hit.position.y, hit.position.z);
    let point = surface + direction * SHOT_BLAST_DEPTH_M;
    let _ = destruction.apply_blast(
        world,
        point.to_array(),
        direction.to_array(),
        SHOT_BLAST_RADIUS_M,
        SHOT_STRESS_IMPULSE,
        SHOT_PUSH_SPEED,
    );
}
