//! Destructible-city match runtime: destruction backend + stream encoder.
//!
//! A match whose id starts with `city` gets a 4×4 grid of destructible
//! buildings. Default is the synthetic backend (CI-safe). With
//! `--features destruction` and a PhysX GPU arena, `CityDestruction` drives
//! real Blast/PhysX stress fracture unless `VIBE_CITY_SYNTHETIC=1`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::Context;
use glam::Vec3;

use vibe_land_destruction::city::{build_city_scene, CityScene, CitySceneDesc};
use vibe_land_destruction::encoder::{ChunkStreamEncoder, EncoderConfig, SharedRecords};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::scene_pack::load_scene_pack_file;
use vibe_land_destruction::synthetic::SyntheticDestruction;
use vibe_land_destruction::types::Camera;
use vibe_land_destruction::wire::{encode_debris_datagram, DebrisCompressor};
use vibe_land_destruction::ids as city_ids;
use destruction_codec::debris_codec::{SleepPolicy as LiveSleepPolicy, Tolerances as LiveTolerances};
use destruction_codec::live::{LiveEncoder, LiveEncoderConfig, RateGovernor};
use destruction_codec::mask::MaskConfig as LiveMaskConfig;
use destruction_codec::trace::{ActorState as LiveActorState, Pose as LivePose};
use vibe_land_destruction::encoder::BodySnapshotInput;
use vibe_netcode::destruction_backend::DestructionTickOutput;
use vibe_netcode::destruction_backend::{DestructionBackend, DestructionStats, StressSolverSettings};

#[cfg(feature = "destruction")]
use vibe_land_destruction::runtime::CityDestruction;
#[cfg(feature = "destruction")]
use vibe_land_destruction::ids;
#[cfg(feature = "destruction")]
use vibe_land_destruction::runtime::GROUP_CHUNK;
#[cfg(feature = "destruction")]
use vibe_land_physx_bridge::{RaycastRequest, Vec3 as BridgeVec3, World};

pub const CITY_MATCH_PREFIX: &str = "city";
/// Impulse handed to the synthetic backend per rifle hit.
const SYNTHETIC_SHOT_IMPULSE: f32 = 400.0;
/// Blast stress contact magnitude for PhysX hitscan (breaks bonds locally).
/// Override with VIBE_CITY_SHOT_STRESS_IMPULSE.
fn physx_shot_stress_impulse() -> f32 {
    std::env::var("VIBE_CITY_SHOT_STRESS_IMPULSE")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| *value > 0.0)
        // Keep this below the old "nuke the whole tower" 5e9 / 8e7 band so a
        // hit opens a local crater instead of shredding every bond in radius.
        .unwrap_or(1.2e7)
}
/// Rigid-body push on dynamic debris after / during a hit (rocket feel), as a
/// velocity change in m/s at the blast centre, falling off quadratically.
/// Override with VIBE_CITY_SHOT_PUSH_SPEED.
///
/// This replaced an impulse (VIBE_CITY_SHOT_PUSH_IMPULSE, 4.0e5 N-s). An
/// impulse divides by mass, so a blast tuned to nudge a 5 t slab handed a 5 kg
/// fragment 4000 m/s -- and a global 12 m/s velocity clamp then existed to hide
/// that, which also forbade ordinary debris from free-falling faster than
/// 12 m/s. A bounded kick speed is a property of the weapon; everything past it
/// is unmodified physics, with speculative CCD (not clamps) keeping fast bodies
/// from tunnelling.
fn physx_shot_push_impulse() -> f32 {
    std::env::var("VIBE_CITY_SHOT_PUSH_SPEED")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(12.0)
}
/// How far from the raycast surface point a chunk may be and still be the one
/// that was hit.
///
/// This is a lookup tolerance, not a blast radius: it exists because the node
/// is a support-graph vertex at a chunk's centroid, so the nearest one to a
/// surface point is up to about half a chunk away. Anything beyond that means
/// the ray hit something that is not a live destructible chunk.
#[cfg(feature = "blast-core")]
const CITY_HIT_NODE_RADIUS_M: f32 = 3.0;

/// Momentum one round deposits where it strikes, in N-s.
///
/// Stated as momentum because that is what a projectile actually delivers, and
/// the solver converts it to a force over the tick. It replaces an opaque
/// `1.2e7` "stress impulse" spread over a 2.5 m sphere with a `1 - d/r`
/// falloff, a `0.85 * shot + 0.15 * radial` direction blend and a 0.5 m
/// push of the impact point inside the surface -- none of which were derived
/// from anything, and whose own comment admitted the magnitude was picked "so a
/// hit opens a local crater instead of shredding every bond in radius".
///
/// The default is emphatically not a rifle bullet: 4 g at 900 m/s is 3.6 N-s,
/// which against reinforced concrete does approximately nothing -- correctly.
/// A round that levels buildings is a game-design choice, and the point of
/// expressing it this way is that the choice is visible and physical. 3.0e5 N-s
/// is ordnance scale: a 300 kg mass at 1 km/s, or equivalently a 30 kg shell at
/// 10 km/s. That is a statement someone can argue with, unlike "1.2e7".
///
/// Calibrated, not guessed. Swept against the old path on the same scene and
/// the same 40 shots:
///
/// ```text
///   3e4 N-s ->   23 bonds,  0 fragments
///   3e5 N-s ->  586 bonds, 56 fragments      <- old path: 604 bonds
///   3e6 N-s -> 1294 bonds, 281 fragments
/// ```
///
/// Override with VIBE_CITY_ROUND_MOMENTUM_NS.
#[cfg(feature = "blast-core")]
fn city_round_momentum_ns() -> f32 {
    std::env::var("VIBE_CITY_ROUND_MOMENTUM_NS")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(3.0e5)
}

const SHOT_BLAST_RADIUS_M: f32 = 2.5;
/// Slightly larger than the stress radius so post-fracture debris near the
/// crater still gets the PhysX shove after kinematic → dynamic promotion.
const SHOT_PUSH_RADIUS_M: f32 = 4.0;
/// How far past the raycast surface point to seat the blast centre, so the
/// radius covers material instead of straddling the face.
const SHOT_BLAST_DEPTH_M: f32 = 0.5;
/// Hitscan range for city damage.
const SHOT_MAX_DISTANCE_M: f32 = 400.0;

pub fn is_city_match(match_id: &str) -> bool {
    match_id.starts_with(CITY_MATCH_PREFIX)
}

/// Match ids starting with this opt into the v3 wire regardless of the env
/// default, so a new codec can be exercised against real clients without
/// changing what every other match gets.
const CITY_V3_MATCH_PREFIX: &str = "cityv3";

/// Which city wire a match speaks.
///
/// Per match rather than per process: a v3 rollout wants one match on the new
/// encoding beside the fleet on the old one, and rollback to be a match id
/// rather than a deploy. `VIBE_CITY_WIRE` moves the default once v3 has soaked.
pub fn city_wire_version(match_id: &str) -> u8 {
    if match_id.starts_with(CITY_V3_MATCH_PREFIX) {
        return vibe_land_destruction::wire::CITY_WIRE_V3;
    }
    std::env::var("VIBE_CITY_WIRE")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|version| vibe_land_destruction::wire::is_supported_city_wire_version(*version))
        .unwrap_or(vibe_land_destruction::wire::CITY_WIRE_VERSION)
}


/// Drive /city through the standardized blast-stress-solver core.
///
/// Off by default: the old path stays authoritative until the two have been
/// compared against the same scene. Deliberately not inferred from anything --
/// an A/B is only worth running if you can be certain which side you got.
#[cfg(feature = "blast-core")]
fn prefer_blast_core() -> bool {
    std::env::var("VIBE_CITY_BLAST_CORE").is_ok_and(|v| v == "1")
}

fn prefer_synthetic() -> bool {
    matches!(
        std::env::var("VIBE_CITY_SYNTHETIC").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("on")
    )
}

/// The reference all-box building pack from blast-stress-solver.
///
/// Every chunk is an axis-aligned box, so the rendered box *is* the collider —
/// no AABB-vs-hull divergence and no visual interpenetration. `fractured-tower`
/// (a Voronoi fracture of irregular convex polyhedra) is still loadable via
/// `VIBE_CITY_SCENE`, but it renders as overlapping AABBs because the pieces
/// are not boxes. See destruction/tests/high_rise.rs.
const DEFAULT_SCENE_FILE: &str = "high-rise-3f-local.json";

fn scene_file() -> String {
    std::env::var("VIBE_CITY_SCENE").unwrap_or_else(|_| DEFAULT_SCENE_FILE.to_string())
}

fn asset_path() -> PathBuf {
    let file = scene_file();
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

fn build_scene() -> anyhow::Result<CityScene> {
    let path = asset_path();
    let pack = load_scene_pack_file(&path)
        .map_err(|error| anyhow::anyhow!("{error}"))
        .with_context(|| format!("loading city scene pack from {}", path.display()))?;
    // The client draws every chunk as an axis-aligned box of `node_sizes`.
    // That is exact for a box pack and wrong for a hull pack: the AABB of a
    // Voronoi cell is much larger than the cell, so neighbouring chunks render
    // as interpenetrating slabs even though the colliders tile cleanly. Warn
    // loudly rather than shipping a silently wrong scene.
    let hull_nodes = pack
        .node_colliders
        .iter()
        .filter(|collider| {
            matches!(
                collider,
                vibe_land_destruction::scene_pack::SceneCollider::ConvexHull { .. }
            )
        })
        .count();
    if hull_nodes > 0 {
        tracing::info!(
            scene = %scene_file(),
            hull_nodes,
            total_nodes = pack.node_colliders.len(),
            "scene pack contains convex-hull chunks; the client renders them as hulls"
        );
    }

    let mut desc = CitySceneDesc::default();
    // Floor truncation slices a pack at a Y cutoff. That is safe for a Voronoi
    // monolith but can leave a structural pack's facade panels hanging off a
    // removed slab. VIBE_CITY_VARIED_HEIGHTS=0 builds every tower at full
    // height so the authored load path is untouched.
    if matches!(
        std::env::var("VIBE_CITY_VARIED_HEIGHTS").as_deref(),
        Ok("0") | Ok("false") | Ok("no") | Ok("off")
    ) {
        desc.varied_heights = false;
    }
    // Grid edge length in buildings. The pitch is derived from the pack's own
    // footprint, so widening the grid grows the map without pushing buildings
    // into each other.
    if let Some(grid) = std::env::var("VIBE_CITY_GRID")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|grid| (1..=16).contains(grid))
    {
        desc.grid = grid;
    }
    build_city_scene(&pack, desc)
        .map_err(|error| anyhow::anyhow!("building city scene: {error}"))
}

/// Distance from the origin at which players should spawn: clear of the grid,
/// plus a margin so nobody lands against a facade. Derived from the scene so a
/// wider pack pushes the ring out instead of spawning players inside a tower.
pub fn spawn_ring_radius_m() -> f32 {
    static RADIUS: OnceLock<f32> = OnceLock::new();
    *RADIUS.get_or_init(|| {
        build_scene()
            .map(|scene| {
                let footprint = vibe_land_destruction::city::pack_footprint_m(
                    &scene.variants.last().expect("variant ladder").pack,
                );
                scene.grid_half_extent_m() + footprint * 0.5 + 12.0
            })
            .unwrap_or(45.0)
    })
}

/// Stress material table declared by the scene pack.
///
/// The pack is calibrated against its own material band (the high-rise pack
/// reports safety factors of ~2.7 to ~39 under self-weight), so reading them
/// beats hardcoding a guess in the server.
fn scene_stress_materials() -> Vec<vibe_land_destruction::scene_pack::StressLimits> {
    static MATERIALS: OnceLock<Vec<vibe_land_destruction::scene_pack::StressLimits>> =
        OnceLock::new();
    MATERIALS
        .get_or_init(|| {
            load_scene_pack_file(&asset_path())
                .ok()
                .map(|pack| pack.materials)
                .unwrap_or_default()
        })
        .clone()
}

pub fn manifest_asset() -> Option<&'static (String, Arc<DestructionManifest>, Vec<u8>)> {
    static ASSET: OnceLock<Option<(String, Arc<DestructionManifest>, Vec<u8>)>> = OnceLock::new();
    ASSET
        .get_or_init(|| match build_scene() {
            Ok(scene) => {
                let manifest = DestructionManifest::from_city(&scene);
                let json = manifest.to_json_bytes();
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                use std::io::Write;
                encoder.write_all(&json).ok()?;
                let gzipped = encoder.finish().ok()?;
                Some((manifest.hash_hex(), Arc::new(manifest), gzipped))
            }
            Err(error) => {
                tracing::warn!(%error, "city manifest asset unavailable");
                None
            }
        })
        .as_ref()
}

enum CityBackend {
    Synthetic(SyntheticDestruction),
    #[cfg(feature = "destruction")]
    Physx(CityDestruction),
    /// The standardized blast-stress-solver core, attached to the game's own
    /// PxScene. Selected by `VIBE_CITY_BLAST_CORE=1`.
    ///
    /// Lives beside `Physx` rather than replacing it so the two can be run
    /// against the same scene and compared before anything is deleted. The old
    /// path stays the default until that comparison is green.
    #[cfg(feature = "blast-core")]
    Core(vibe_land_destruction::core_runtime::CoreCityDestruction),
}

/// The wire-v3 pose stream: the live debris codec fed beside the v2 encoder.
///
/// Topology, bootstrap and settles keep flowing through `ChunkStreamEncoder`
/// unchanged -- fracture events must stay instant and reliable. What v3
/// replaces is the per-client ranked datagram stream, whose evaluation model
/// was measured leaving moving bodies 40+ seconds stale and shown on video
/// displaying a different scene than the simulation. Here every awake island
/// is encoded once per span and the same bytes go to every client.
struct V3Live {
    encoder: LiveEncoder,
    span_ticks: u32,
    span_first: u32,
    /// Holds the world-feed byte budget by stretching flush (100->250 ms)
    /// first and widening the masked bound second -- latency before
    /// precision, correctness never (the inverse of v2's failure mode).
    governor: RateGovernor,
    sim_hz: u32,
    /// Island reach per body key, kept so a body that settles (removed -- the
    /// reliable settle record owns its pose from then on) and later wakes is
    /// re-registered with the radius its members demand rather than a guess.
    radii: HashMap<u64, f32>,
    staged: Vec<Vec<u8>>,
    staged_reliable: Vec<Vec<u8>>,
    compressor: DebrisCompressor,
    /// Encode cost of the last closed span, for the perf gate.
    last_span_encode_ms: f32,
}

impl V3Live {
    fn new(sim_hz: u32, chunk_capacity: usize) -> Self {
        let span_ticks = (sim_hz / 10).max(1); // 100 ms floor: the measured knee
        // World-feed budget. 0 disables the governor (fixed 100 ms flush).
        let budget_mbps = std::env::var("VIBE_CITY_WORLD_BUDGET_MBPS")
            .ok()
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(5.0);
        let governor = RateGovernor::new(
            budget_mbps,
            span_ticks,
            (sim_hz * 250 / 1000).max(span_ticks), // 250 ms ceiling
            sim_hz,
        );
        let encoder = LiveEncoder::new(LiveEncoderConfig {
            dt: 1.0 / sim_hz as f32,
            gravity: glam::Vec3::new(0.0, -9.81, 0.0),
            // The same fidelity contract every offline number was measured
            // against: 0.5 cm shell, masked to 20 mm for fast movers.
            tolerances: LiveTolerances::new(
                0.005,
                3.0,
                0.15,
                0.5,
                LiveMaskConfig {
                    enabled: true,
                    base_m: 0.005,
                    cap_m: 0.020,
                    ..LiveMaskConfig::default()
                },
            ),
            // Modelled sleep: the offline harness read the trace's sleeping
            // flags; the live feed has none (only awake bodies are pushed), so
            // without this a near-still body streams sampled runs forever --
            // netlab measured 1.88 Mbps of "settled" traffic against a 0.5
            // gate. A body quiet for half a second emits one Rest and goes
            // silent; pose drift past the shell bound wakes it.
            sleep: LiveSleepPolicy {
                linear_mps: 0.15,
                angular_rps: 0.15,
                ticks: sim_hz / 2,
            },
            restate_period: 16,
            // Full capacity up front: islands never exceed chunks, and a
            // mid-collapse growth rebuilds the encoder (a visible spike).
            initial_capacity: chunk_capacity.clamp(64, 65_536),
        });
        Self {
            encoder,
            span_ticks,
            span_first: 0,
            governor,
            sim_hz,
            radii: HashMap::new(),
            staged: Vec::new(),
            staged_reliable: Vec::new(),
            compressor: DebrisCompressor::new(),
            last_span_encode_ms: 0.0,
        }
    }

    /// Reach of an island: how far any member chunk sits from the island's
    /// centre of mass, plus that chunk's own radius. This is the shell radius
    /// the codec must hold -- the root chunk's own size under-constrains the
    /// island (the wide-rotation lesson, measured as 249k shell violations).
    fn island_reach(manifest: &DestructionManifest, structure_id: u32, chunks: &[u32]) -> f32 {
        let Some(structure) = manifest
            .structures
            .iter()
            .find(|structure| structure.structure_id == structure_id)
        else {
            return 1.5;
        };
        let mut com = glam::Vec3::ZERO;
        let mut weight_total = 0.0f32;
        let mut members = Vec::with_capacity(chunks.len());
        for &chunk in chunks {
            let node = city_ids::chunk_id_parts(chunk).1 as usize;
            let Some(def) = structure.chunks.get(node) else {
                continue;
            };
            let centroid = glam::Vec3::from_array(def.centroid);
            let weight = if def.mass > 0.0 { def.mass } else { 1.0 };
            com += centroid * weight;
            weight_total += weight;
            members.push((centroid, def.radius));
        }
        if weight_total <= 0.0 {
            return 1.5;
        }
        com /= weight_total;
        members
            .iter()
            .map(|(centroid, radius)| centroid.distance(com) + radius)
            .fold(0.5f32, f32::max)
    }

    fn ingest(
        &mut self,
        manifest: &DestructionManifest,
        sim_tick: u32,
        snapshots: &[BodySnapshotInput],
        output: &DestructionTickOutput,
    ) {
        let started = std::time::Instant::now();
        for batch in &output.batches {
            for promotion in &batch.promoted_islands {
                let key =
                    u64::from(city_ids::body_entity(promotion.structure_id, promotion.island_id));
                let reach =
                    Self::island_reach(manifest, promotion.structure_id, &promotion.chunks);
                self.radii.insert(key, reach);
                self.encoder.add_body(key, reach);
            }
            for &retired in &batch.retired_island_ids {
                let key = u64::from(city_ids::body_entity(batch.structure_id, retired));
                self.radii.remove(&key);
                self.encoder.remove_body(key);
            }
        }
        // A settled body's pose is owned by the reliable settle record from
        // here on; streaming it further would only re-state what the client
        // already holds. Waking is detected below by reappearance.
        for settle in &output.settled {
            let key = u64::from(city_ids::body_entity(settle.structure_id, settle.island_id));
            self.encoder.remove_body(key);
        }
        for snapshot in snapshots {
            let key = u64::from(snapshot.body_entity);
            if !self.encoder.contains(key) {
                let reach = self.radii.get(&key).copied().unwrap_or(1.5);
                self.encoder.add_body(key, reach);
            }
            let rotation = glam::Quat::from_array(snapshot.rotation).normalize();
            self.encoder.push(
                key,
                sim_tick,
                &LiveActorState {
                    pose: LivePose {
                        position: glam::Vec3::from_array(snapshot.position),
                        rotation,
                    },
                    linear_velocity: glam::Vec3::from_array(snapshot.linear_velocity),
                    angular_velocity: glam::Vec3::from_array(snapshot.angular_velocity),
                    contacts: snapshot.contacts,
                    intact_joints: 0,
                    flags: 0,
                },
            );
        }
        let assignments = self.encoder.take_lane_assignments();
        if !assignments.is_empty() {
            self.staged_reliable
                .push(vibe_land_destruction::wire::encode_city_lanes(
                    &assignments,
                    self.encoder.epoch(),
                ));
        }
        // Span close by elapsed ticks since the span opened, not a modulo on
        // absolute tick -- the governor varies span length run-time, and a
        // phase-locked trigger would emit one mis-sized span per change.
        if sim_tick + 1 >= self.span_first + self.span_ticks {
            let push_ms = started.elapsed().as_secs_f32() * 1000.0;
            let span_first = self.span_first;
            let span_len = sim_tick + 1 - self.span_first;
            let finalize_started = std::time::Instant::now();
            let epoch = self.encoder.epoch();
            let packets = self.encoder.finalize_span(span_first);
            let finalize_ms = finalize_started.elapsed().as_secs_f32() * 1000.0;
            let compress_started = std::time::Instant::now();
            let mut wire_bytes = 0usize;
            for packet in packets {
                let (compression, body) = self.compressor.compress(&packet.payload);
                let datagram = encode_debris_datagram(packet.span_tick, compression, epoch, &body);
                wire_bytes += datagram.len();
                self.staged.push(datagram);
            }
            let compress_ms = compress_started.elapsed().as_secs_f32() * 1000.0;
            let decision = self.governor.after_span(span_len, wire_bytes);
            self.span_ticks = decision.span_ticks;
            self.encoder.set_rate_scale(decision.rate_scale);
            // Keep the loss-heal window ~1.6 s of wall clock as flush moves.
            let heal_spans = (self.sim_hz * 1600 / 1000 / self.span_ticks.max(1)).max(4);
            self.encoder.set_restate_period(heal_spans);
            if std::env::var("V3_PROFILE").is_ok() {
                eprintln!(
                    "V3SPAN push {push_ms:.2} finalize {finalize_ms:.2} compress {compress_ms:.2} \
                     span {span_len}t next {}t scale {:.2} ema {:.2} Mbps",
                    decision.span_ticks,
                    decision.rate_scale,
                    self.governor.ema_mbps()
                );
            }
            self.span_first = sim_tick + 1;
            self.last_span_encode_ms = started.elapsed().as_secs_f32() * 1000.0;
        }
    }
}

/// Min/avg/p95/max over every tick since the last telemetry publish. The
/// 1 Hz snapshot otherwise reports one tick's instantaneous values and hides
/// intra-second spikes (an 11.1 ms encoder-ingest spike was only ever seen
/// because a human screenshotted the right second).
#[derive(Default, Clone, serde::Serialize)]
pub struct WindowSummary {
    pub min: f32,
    pub avg: f32,
    pub p95: f32,
    pub max: f32,
    pub samples: u32,
}

#[derive(Default)]
pub struct CityTickWindow {
    step_ms: Vec<f32>,
    ingest_ms: Vec<f32>,
    span_encode_ms: Vec<f32>,
    awake: Vec<f32>,
}

fn summarize_window(values: &mut Vec<f32>) -> WindowSummary {
    if values.is_empty() {
        return WindowSummary::default();
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let count = values.len();
    let summary = WindowSummary {
        min: values[0],
        avg: values.iter().sum::<f32>() / count as f32,
        p95: values[((count - 1) as f32 * 0.95).round() as usize],
        max: values[count - 1],
        samples: count as u32,
    };
    values.clear();
    summary
}

impl CityTickWindow {
    pub fn drain(&mut self) -> (WindowSummary, WindowSummary, WindowSummary, WindowSummary) {
        (
            summarize_window(&mut self.step_ms),
            summarize_window(&mut self.ingest_ms),
            summarize_window(&mut self.span_encode_ms),
            summarize_window(&mut self.awake),
        )
    }
}

pub struct CityRuntime {
    /// Per-tick samples between telemetry publishes; drained at each publish.
    pub tick_window: CityTickWindow,
    /// Present when this match speaks wire v3; owns the live pose stream.
    live: Option<V3Live>,
    sim_hz: u32,
    backend: CityBackend,
    encoder: ChunkStreamEncoder,
    pub manifest: Arc<DestructionManifest>,
    send_interval_ticks: u32,
    pub last_encode_ms: f32,
    last_encode_shared_ms: f32,
    last_client_datagrams_ms: f32,
    structure_centers: Vec<(Vec3, f32)>,
    sent_records: u64,
    sent_bytes: u64,
    sent_packets: u64,
    last_stream_counters: (u64, u64, u64),
    /// Blasts that need a post-fracture PhysX push (first hit on kinematic
    /// support promotes islands only during `step`, so we re-apply push then).
    pending_pushes: Vec<(Vec3, Vec3, f32, f32)>,
}

impl CityRuntime {
    fn from_parts(
        backend: CityBackend,
        manifest: Arc<DestructionManifest>,
        sim_hz: u32,
    ) -> Self {
        let mut config = EncoderConfig::validated(sim_hz);
        config.send_interval_ticks = (sim_hz
            / u32::from(vibe_land_shared::constants::CITY_CHUNK_STREAM_HZ))
        .max(1);
        // VIBE_CITY_CEILING_BYTES overrides the per-client byte ceiling; 0
        // removes it entirely. Removing it is a diagnostic, not a shipping
        // setting: the ceiling is what keeps a client's downlink bounded when
        // the world has more motion than any link can carry.
        config.client_ceiling_bytes = match std::env::var("VIBE_CITY_CEILING_BYTES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
        {
            Some(0) => usize::MAX,
            Some(bytes) => bytes,
            None => usize::from(vibe_land_shared::constants::CITY_CLIENT_CEILING_BYTES_PER_SEND),
        };
        config.interest.proximity_meters = 120.0;
        let encoder = ChunkStreamEncoder::new(&manifest, config);
        let structure_centers = manifest
            .structures
            .iter()
            .map(|structure| {
                let center = Vec3::from_array(structure.world_position);
                let mut top = 0.0_f32;
                let mut footprint = 0.0_f32;
                for chunk in &structure.chunks {
                    let centroid = Vec3::from_array(chunk.centroid);
                    top = top.max(centroid.y);
                    let horizontal = (centroid.x * centroid.x + centroid.z * centroid.z).sqrt();
                    footprint = footprint.max(horizontal + chunk.radius);
                }
                let mid = center + Vec3::new(0.0, top * 0.5, 0.0);
                let radius = footprint.max(top * 0.55).max(2.0);
                (mid, radius)
            })
            .collect();
        Self {
            live: None,
            tick_window: CityTickWindow::default(),
            sim_hz,
            backend,
            encoder,
            manifest,
            send_interval_ticks: config.send_interval_ticks,
            last_encode_ms: 0.0,
            last_encode_shared_ms: 0.0,
            last_client_datagrams_ms: 0.0,
            structure_centers,
            sent_records: 0,
            sent_bytes: 0,
            sent_packets: 0,
            last_stream_counters: (0, 0, 0),
            pending_pushes: Vec::new(),
        }
    }

    pub fn synthetic(sim_hz: u32) -> anyhow::Result<Self> {
        let (_, manifest, _) = manifest_asset()
            .context("city scene asset unavailable (destruction/assets/scenes)")?;
        let manifest = manifest.clone();
        let backend = SyntheticDestruction::from_manifest(&manifest, sim_hz);
        Ok(Self::from_parts(CityBackend::Synthetic(backend), manifest, sim_hz))
    }

    #[cfg(feature = "destruction")]
    pub fn physx(sim_hz: u32, world: &mut World) -> anyhow::Result<Self> {
        let (_, manifest, _) = manifest_asset()
            .context("city scene asset unavailable (destruction/assets/scenes)")?;
        let manifest = manifest.clone();
        let pack_materials = scene_stress_materials();
        let settings = vibe_land_destruction::city_config::stress_settings(&pack_materials);
        tracing::info!(
            scene = %scene_file(),
            from_pack = !pack_materials.is_empty(),
            materials = settings.materials.len(),
            compression_fatal = settings.materials[0].compression_fatal_mpa,
            "city stress materials"
        );
        let backend = CityDestruction::build(manifest.clone(), world, settings, sim_hz)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        Ok(Self::from_parts(CityBackend::Physx(backend), manifest, sim_hz))
    }

    /// The same city, driven by the standardized core instead.
    ///
    /// Attaches to the world the game already owns -- players, vehicles and the
    /// city share one PxScene -- and never steps it; the server's own loop
    /// still does.
    #[cfg(feature = "blast-core")]
    pub fn blast_core(sim_hz: u32, world: &mut World) -> anyhow::Result<Self> {
        use vibe_land_destruction::core_runtime::CoreCityDestruction;
        let (_, manifest, _) = manifest_asset()
            .context("city scene asset unavailable (destruction/assets/scenes)")?;
        let manifest = manifest.clone();
        // Read from the same place `build_scene` does, and with the same grid
        // and height options, so the simulation and the manifest the client is
        // handed describe the same city.
        let scene = build_scene().context("building the city scene for the core path")?;
        let path = asset_path();
        let grid = scene.desc.grid;
        let varied_heights = scene.desc.varied_heights;
        let scene_ptr = world
            .scene_ptr()
            .map_err(|error| anyhow::anyhow!("host PhysX scene pointer unavailable: {error}"))?;
        let physics = world
            .physics_ptr()
            .map_err(|error| anyhow::anyhow!("host PhysX physics pointer unavailable: {error}"))?;
        // SAFETY: both pointers come from the World borrowed here, and the
        // caller keeps that World alive for at least as long as the backend.
        let backend = unsafe {
            CoreCityDestruction::attach_city(
                scene_ptr,
                physics,
                &path,
                [0.0, -9.81, 0.0],
                grid,
                varied_heights,
                // The host's own chunk group and mask, so its raycasts and its
                // collision filtering see library shapes exactly as they see
                // the ones the old path created.
                GROUP_CHUNK,
                crate::physx_runtime::ALL_GROUPS,
            )
        }
        .map_err(|error| anyhow::anyhow!("{error}"))?;
        tracing::info!(
            scene = %scene_file(),
            gpu = backend.gpu_active(),
            structures = backend.structure_count(),
            expected = scene.instances.len(),
            "city on blast core"
        );
        anyhow::ensure!(
            backend.structure_count() == scene.instances.len(),
            "core built {} structures but the manifest describes {}; the client \
             would be handed a city that does not exist",
            backend.structure_count(),
            scene.instances.len()
        );
        Ok(Self::from_parts(CityBackend::Core(backend), manifest, sim_hz))
    }

    /// Prefer PhysX when the feature is on and a world is supplied, unless
    /// `VIBE_CITY_SYNTHETIC=1`.
    pub fn open(
        sim_hz: u32,
        #[cfg(feature = "destruction")] world: Option<&mut World>,
        #[cfg(not(feature = "destruction"))] _world: Option<()>,
    ) -> anyhow::Result<Self> {
        #[cfg(feature = "destruction")]
        {
            if !prefer_synthetic() {
                if let Some(world) = world {
                    #[cfg(feature = "blast-core")]
                    if prefer_blast_core() {
                        // Opt-in, and it fails rather than falling back: a
                        // silent fall-through to the old path would make an A/B
                        // measure the same code twice and agree with itself.
                        return Self::blast_core(sim_hz, world);
                    }
                    return Self::physx(sim_hz, world);
                }
            }
        }
        let _ = prefer_synthetic();
        Self::synthetic(sim_hz)
    }

    /// Select the reliable-channel encoding for this match.
    ///
    /// Set once at match creation, before any client joins, because the version
    /// is announced in the session config and a mid-match change would leave
    /// joined clients decoding a layout they never agreed to.
    pub fn set_wire_version(&mut self, version: u8) {
        self.encoder.set_wire_version(version);
        self.live = if version == vibe_land_destruction::wire::CITY_WIRE_V3 {
            Some(V3Live::new(self.sim_hz, self.manifest.total_chunks()))
        } else {
            None
        };
    }

    pub fn wire_version(&self) -> u8 {
        self.encoder.wire_version()
    }

    /// Rebuild the city undamaged, preserving the client list.
    ///
    /// Every destructible and its PhysX actors are released before the scene is
    /// rebuilt, so this leaves nothing behind from the previous city. Callers
    /// must re-send a bootstrap afterwards: the client's ledger still describes
    /// the demolished city, and nothing in the incremental topology stream can
    /// express "start over".
    pub fn reset(
        &mut self,
        sim_hz: u32,
        #[cfg(feature = "destruction")] world: Option<&mut World>,
        #[cfg(not(feature = "destruction"))] world: Option<()>,
    ) -> anyhow::Result<()> {
        let clients = self.encoder.clients();
        #[cfg(feature = "destruction")]
        let world = {
            // The backend refers to structures by id, not by pointer, so
            // releasing the bridge's destructibles here cannot dangle: the old
            // backend is dropped below when self is replaced.
            if let Some(world) = world {
                world.clear_destructibles()?;
                Some(world)
            } else {
                None
            }
        };
        let mut rebuilt = Self::open(sim_hz, world)?;
        // The wire version is NOT part of `open`: it is chosen once at match
        // creation and announced in the session config. A rebuild that forgets
        // it silently downgrades the server to v2 while every joined client
        // stays in v3 -- and the failure is invisible from both ends. The
        // client discards stray v2 pose records by design, and v3 holds
        // topology back until the debris clock advances, which it never does
        // without a v3 stream. Destruction then happens server-side and is
        // never drawn: the city simply stops breaking, with no error, no
        // sequence gap and no dropped packet anywhere. Observed live.
        rebuilt.set_wire_version(self.wire_version());
        for client in clients {
            rebuilt.add_client(client);
        }
        *self = rebuilt;
        Ok(())
    }

    pub fn is_physx(&self) -> bool {
        match &self.backend {
            CityBackend::Synthetic(_) => false,
            #[cfg(feature = "destruction")]
            CityBackend::Physx(_) => true,
            #[cfg(feature = "blast-core")]
            CityBackend::Core(_) => true,
        }
    }

    pub fn send_interval_ticks(&self) -> u32 {
        self.send_interval_ticks
    }

    pub fn add_client(&mut self, client: u64) {
        // Wire v3: a joiner has the bootstrap and lane map but no poses for
        // long-parked lanes (their Rest budgets are exhausted by design).
        // Smear one absolute statement of every occupied lane over the next
        // spans; worst-case coverage is lanes/64 spans (~4 s at 4k lanes,
        // 100 ms flush), documented as the join convergence bound.
        if let Some(live) = self.live.as_mut() {
            live.encoder.begin_join_restate();
        }
        self.encoder.add_client(client);
    }

    pub fn remove_client(&mut self, client: u64) {
        self.encoder.remove_client(client);
    }

    /// Route a hitscan ray into city damage via building bounding spheres.
    ///
    /// Hitscan is not a rigid body, so PhysX never emits a contact callback.
    /// Damage is injected as Blast stress contacts (`queueContact`), the same
    /// path contact events use.
    pub fn apply_shot_ray(
        &mut self,
        origin: Vec3,
        direction: Vec3,
        #[cfg(feature = "destruction")] world: Option<&mut World>,
        #[cfg(not(feature = "destruction"))] _world: Option<()>,
    ) -> bool {
        let direction = direction.normalize_or_zero();
        if direction == Vec3::ZERO {
            return false;
        }

        // Bounding-sphere fallback, used only by the synthetic backend, which
        // has no colliders in the arena. It is an approximation: the sphere is
        // much larger than the building, so the entry point sits in open air
        // beside the facade. The PhysX path raycasts the real chunk colliders
        // instead - see `physx_shot_hit`.
        let sphere_hit = || -> Option<(f32, Vec3, usize)> {
            let mut best: Option<(f32, Vec3, usize)> = None;
            for (structure_index, (center, radius)) in self.structure_centers.iter().enumerate() {
                let to_center = *center - origin;
                let along = to_center.dot(direction);
                if along <= 0.0 {
                    continue;
                }
                let closest = origin + direction * along;
                let miss = closest.distance(*center);
                if miss > *radius {
                    continue;
                }
                let entry = along - (radius * radius - miss * miss).sqrt().max(0.0);
                let point = origin + direction * entry.max(0.0);
                if best.is_none_or(|(distance, _, _)| entry < distance) {
                    best = Some((entry, point, structure_index));
                }
            }
            best
        };

        match &mut self.backend {
            #[cfg(feature = "blast-core")]
            CityBackend::Core(backend) => {
                // The same real raycast the old path uses, for the same reason:
                // a bounding sphere puts the impact several metres off the
                // facade in open air, so shots that visually hit do nothing and
                // shots that visually miss damage the building.
                let hit = world
                    .as_ref()
                    .and_then(|world| {
                        world
                            .raycast(RaycastRequest {
                                origin: BridgeVec3::new(origin.x, origin.y, origin.z),
                                direction: BridgeVec3::new(direction.x, direction.y, direction.z),
                                max_distance: SHOT_MAX_DISTANCE_M,
                                collision_mask: GROUP_CHUNK,
                                ignore_entity_id: 0,
                                has_ignore_entity: false,
                            })
                            .ok()
                    })
                    .filter(|hit| hit.hit);
                let Some(hit) = hit else {
                    return false;
                };
                let at = [hit.position.x, hit.position.y, hit.position.z];

                // Resolved from the surface point rather than seated inside it.
                // The old path pushed the impact 0.5 m through the face so a
                // sphere would "cover material"; with no sphere there is
                // nothing to cover, and the surface is where the round hit.
                //
                // Bounded so a ray that grazes past everything is a miss rather
                // than a hit on whichever chunk is least far away.
                let Some((structure_id, node)) =
                    backend.nearest_node_within(at, CITY_HIT_NODE_RADIUS_M)
                else {
                    return false;
                };
                backend.deposit_momentum(
                    structure_id,
                    node,
                    at,
                    direction.to_array(),
                    city_round_momentum_ns(),
                    1.0 / 60.0,
                );
                true
            }
            CityBackend::Synthetic(backend) => {
                let Some((distance, point, structure_index)) = sphere_hit() else {
                    return false;
                };
                let affected = backend.apply_explosion(
                    point.to_array(),
                    SHOT_BLAST_RADIUS_M,
                    SYNTHETIC_SHOT_IMPULSE,
                );
                tracing::debug!(
                    structure_index,
                    distance,
                    hit = ?point.to_array(),
                    affected,
                    backend = "synthetic",
                    "city shot hit"
                );
                affected > 0
            }
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => {
                let Some(world) = world else {
                    tracing::warn!("city shot but PhysX world missing");
                    return false;
                };
                // Raycast the real chunk colliders. The old bounding-sphere
                // approximation put the blast centre several metres off the
                // facade in open air, so damage landed inconsistently: shots
                // that visually hit did nothing, shots that visually missed
                // damaged the building, and once a crater formed the sphere
                // kept reporting hits into the hole forever.
                let hit = world
                    .raycast(RaycastRequest {
                        origin: BridgeVec3::new(origin.x, origin.y, origin.z),
                        direction: BridgeVec3::new(direction.x, direction.y, direction.z),
                        max_distance: SHOT_MAX_DISTANCE_M,
                        collision_mask: GROUP_CHUNK,
                        ignore_entity_id: 0,
                        has_ignore_entity: false,
                    })
                    .ok()
                    .filter(|hit| hit.hit);
                let Some(hit) = hit else {
                    tracing::debug!(
                        origin = ?origin.to_array(),
                        direction = ?direction.to_array(),
                        "city shot miss (no chunk along ray)"
                    );
                    return false;
                };

                // Seat the blast just inside the surface so the radius covers
                // material rather than straddling the face.
                let surface = Vec3::new(hit.position.x, hit.position.y, hit.position.z);
                let point = surface + direction * SHOT_BLAST_DEPTH_M;
                let structure_id = ids::body_entity_parts(hit.entity_id).0;

                let stress = physx_shot_stress_impulse();
                let push = physx_shot_push_impulse();

                // Release frozen rubble around the impact BEFORE the blast.
                //
                // Order matters twice over: the blast's push pass skips
                // kinematic bodies, so anything still frozen would take the
                // stress but none of the motion; and the wake is what makes
                // the response local. The measured pathology is a single
                // rifle round waking 6,065 bodies because a settled city
                // block is one contact island -- waking only what the blast
                // reaches keeps the cost of a shot proportional to the shot.
                // The wider push radius is used so every body that will be
                // pushed is dynamic by the time the push arrives.
                match backend.wake_around(world, point.to_array(), SHOT_PUSH_RADIUS_M) {
                    Ok(0) => {}
                    Ok(woken) => tracing::debug!(woken, "city shot woke frozen rubble"),
                    Err(error) => tracing::warn!(%error, "city spatial wake failed"),
                }

                match backend.apply_blast(
                    world,
                    point.to_array(),
                    direction.to_array(),
                    SHOT_BLAST_RADIUS_M,
                    stress,
                    push,
                ) {
                    Ok(affected) => {
                        if affected > 0 && push > 0.0 {
                            // Re-apply push after this tick's bond breaks promote
                            // new dynamic islands (first pass often only stresses
                            // still-kinematic support bodies).
                            self.pending_pushes.push((
                                point,
                                direction,
                                SHOT_PUSH_RADIUS_M,
                                push,
                            ));
                        }
                        tracing::debug!(
                            structure_id,
                            body_entity = hit.entity_id,
                            distance = hit.distance,
                            hit = ?point.to_array(),
                            affected,
                            backend = "physx",
                            "city shot hit"
                        );
                        affected > 0
                    }
                    Err(error) => {
                        tracing::warn!(%error, structure_id, "city physx blast failed");
                        false
                    }
                }
            }
        }
    }

    /// 60 Hz step: destruction tick + encoder ingest.
    pub fn step(
        &mut self,
        sim_tick: u32,
        dt: f32,
        gravity: [f32; 3],
        #[cfg(feature = "destruction")] world: Option<&mut World>,
        #[cfg(not(feature = "destruction"))] _world: Option<()>,
    ) -> Vec<Vec<u8>> {
        let started = std::time::Instant::now();
        let mut reliable = Vec::new();
        let pending_pushes = std::mem::take(&mut self.pending_pushes);
        match &mut self.backend {
            #[cfg(feature = "blast-core")]
            CityBackend::Core(backend) => {
                // The whole point of the migration: the pipeline emits the
                // topology output natively, so this arm only feeds it onward.
                // The Physx arm below reconstructs the same thing by diffing
                // PhysX snapshots.
                let post_step_started = std::time::Instant::now();
                let (_, output, overflow) = backend.post_step_output(dt);
                let post_step_ms = post_step_started.elapsed().as_secs_f32() * 1000.0;
                if overflow.islands > 0 || overflow.chunks > 0 {
                    // Dropped, never truncated: truncating aliases a new island
                    // onto a live one and the client draws two chunk sets with
                    // one pose. Loud, because it means lost events.
                    tracing::error!(
                        islands = overflow.islands,
                        chunks = overflow.chunks,
                        "city ids exceeded the wire fields; events dropped"
                    );
                }
                let snapshots = backend.body_snapshots();
                self.encoder.ingest_tick(sim_tick, &snapshots, &output, &output.wakes);
                if let Some(live) = self.live.as_mut() {
                    live.ingest(&self.manifest, sim_tick, &snapshots, &output);
                }
                reliable.extend(self.encoder.take_topology_messages());
                let _ = post_step_ms;
            }
            CityBackend::Synthetic(backend) => match backend.tick_after_fetch(dt, gravity) {
                Ok(output) => {
                    let snapshots = backend.body_snapshots();
                    self.encoder.ingest_tick(sim_tick, &snapshots, &output, &output.wakes);
                    if let Some(live) = self.live.as_mut() {
                        live.ingest(&self.manifest, sim_tick, &snapshots, &output);
                    }
                    reliable.extend(self.encoder.take_topology_messages());
                }
                Err(error) => {
                    tracing::error!(%error, "city destruction tick failed; topology frozen");
                }
            },
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => {
                let Some(world) = world else {
                    tracing::error!("physx city step missing World");
                    return reliable;
                };
                let post_step_started = std::time::Instant::now();
                let post_step_result = backend.post_step(world, dt, gravity);
                let post_step_ms = post_step_started.elapsed().as_secs_f32() * 1000.0;
                match post_step_result {
                    Ok(output) => {
                        // Re-apply debris pushes now that islands may have been
                        // promoted from kinematic → dynamic by this tick.
                        for (point, direction, radius, push) in pending_pushes {
                            if let Err(error) = backend.apply_blast(
                                world,
                                point.to_array(),
                                direction.to_array(),
                                radius,
                                0.0,
                                push,
                            ) {
                                tracing::warn!(%error, "city post-fracture push failed");
                            }
                        }
                        let snapshot_started = std::time::Instant::now();
                        let snapshot_result = backend.body_snapshots(world);
                        let snapshot_ms =
                            snapshot_started.elapsed().as_secs_f32() * 1000.0;
                        match snapshot_result {
                            Ok(snapshots) => {
                                let ingest_started = std::time::Instant::now();
                                // The v2 encoder still owns the ledger and the
                                // reliable topology messages on every wire, so
                                // it always ingests -- but its per-awake-body
                                // classifier pass only feeds the v2 pose
                                // stream, and a v3 match never reads it.
                                if self.live.is_some() {
                                    self.encoder.ingest_tick_topology_only(
                                        sim_tick,
                                        &snapshots,
                                        &output,
                                        &output.wakes,
                                    );
                                } else {
                                    self.encoder.ingest_tick(
                                        sim_tick,
                                        &snapshots,
                                        &output,
                                        &output.wakes,
                                    );
                                }
                                if let Some(live) = self.live.as_mut() {
                                    live.ingest(&self.manifest, sim_tick, snapshots, &output);
                                }
                                reliable.extend(self.encoder.take_topology_messages());
                                backend.record_host_timings(
                                    post_step_ms,
                                    snapshot_ms,
                                    ingest_started.elapsed().as_secs_f32() * 1000.0,
                                );
                            }
                            Err(error) => {
                                tracing::error!(%error, "city body snapshot failed");
                            }
                        }
                    }
                    Err(error) => {
                        tracing::error!(%error, "city physx post_step failed; topology frozen");
                    }
                }
            }
        }
        if let Some(live) = self.live.as_mut() {
            reliable.append(&mut live.staged_reliable);
        }
        // Baselines exist only as the delta reference for the v2 record modes;
        // v3 records are self-contained or chain-tailed and never look one up.
        if self.live.is_none() {
            if let Some(baselines) = self.encoder.maybe_emit_baseline(sim_tick) {
                reliable.extend(baselines);
            }
        }
        self.last_encode_ms = started.elapsed().as_secs_f32() * 1000.0;
        reliable
    }

    /// Wall time of the last 30 Hz stream encode, split into the shared record
    /// build and the per-client interest/packing pass.
    pub fn record_encode_timings(&mut self, shared_ms: f32, datagrams_ms: f32) {
        self.last_encode_shared_ms = shared_ms;
        self.last_client_datagrams_ms = datagrams_ms;
    }

    pub fn last_encode_timings(&self) -> (f32, f32) {
        (self.last_encode_shared_ms, self.last_client_datagrams_ms)
    }

    pub fn encode_shared(&mut self, sim_tick: u32) -> SharedRecords {
        self.encoder.encode_send(sim_tick)
    }

    pub fn client_datagrams(
        &mut self,
        client: u64,
        camera: Camera,
        shared: &SharedRecords,
    ) -> Vec<Vec<u8>> {
        let packets = self.encoder.client_datagrams(client, camera, shared);
        self.sent_packets += packets.len() as u64;
        for packet in &packets {
            self.sent_bytes += packet.len() as u64;
        }
        self.sent_records += packets.len() as u64;
        packets
    }

    /// Drain the v3 pose datagrams staged since the last call. Encode-once:
    /// the caller broadcasts these same bytes to every client.
    pub fn take_v3_datagrams(&mut self) -> Vec<Vec<u8>> {
        self.live
            .as_mut()
            .map(|live| std::mem::take(&mut live.staged))
            .unwrap_or_default()
    }

    /// A client reported these bodies' chains poisoned by packet loss; restate
    /// them absolutely on the next span.
    /// Record one tick's samples into the telemetry window. Wall time comes
    /// from the caller (it brackets the whole city step); the rest reads the
    /// backend's per-tick stats so intra-second spikes survive to publish.
    pub fn record_tick_sample(&mut self, step_wall_ms: f32) {
        let stats = self.stats();
        self.tick_window.step_ms.push(step_wall_ms);
        self.tick_window.ingest_ms.push(stats.ingest_ms);
        self.tick_window.awake.push(stats.awake_chunk_bodies as f32);
        if let Some(live) = &self.live {
            self.tick_window.span_encode_ms.push(live.last_span_encode_ms);
        }
    }

    /// Wire v3 governor internals for telemetry:
    /// (span_ticks, rate_scale, ema_mbps, epoch, last_span_encode_ms).
    /// Zeros/identity on v2 matches.
    pub fn governor_snapshot(&self) -> (u32, f32, f32, u8, f32) {
        match &self.live {
            Some(live) => (
                live.governor.span_ticks(),
                live.governor.rate_scale(),
                live.governor.ema_mbps(),
                live.encoder.epoch(),
                live.last_span_encode_ms,
            ),
            None => (0, 1.0, 0.0, 0, 0.0),
        }
    }

    /// Wire v3: smear an absolute restate of every occupied lane (join /
    /// resync). No-op on v2 matches.
    pub fn begin_join_restate(&mut self) {
        if let Some(live) = self.live.as_mut() {
            live.encoder.begin_join_restate();
        }
    }

    pub fn restate_bodies(&mut self, bodies: &[u32]) {
        if let Some(live) = self.live.as_mut() {
            let keys: Vec<u64> = bodies.iter().map(|&body| u64::from(body)).collect();
            live.encoder.restate_keys(&keys);
        }
    }

    pub fn last_v3_span_encode_ms(&self) -> f32 {
        self.live
            .as_ref()
            .map(|live| live.last_span_encode_ms)
            .unwrap_or(0.0)
    }

    pub fn bootstrap(&self, sim_tick: u32) -> Vec<u8> {
        self.encoder.bootstrap_message(sim_tick)
    }

    /// Wire v3: the full lane->entity map, sent beside every bootstrap. An
    /// incremental assignment a client lost is never resent, and without the
    /// mapping every record the lane carries is uninterpretable.
    pub fn full_lane_map(&self) -> Option<Vec<u8>> {
        let live = self.live.as_ref()?;
        let assignments = live.encoder.all_assignments();
        if assignments.is_empty() {
            return None;
        }
        Some(vibe_land_destruction::wire::encode_city_lanes(
            &assignments,
            live.encoder.epoch(),
        ))
    }

    /// Per-body freeze states for the debug overlay (empty on synthetic).
    pub fn debug_body_states(&self) -> Vec<(u32, u8, u32, i32)> {
        match &self.backend {
            CityBackend::Synthetic(_) => Vec::new(),
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => backend.debug_body_states(),
            // Freeze has not been absorbed into the core yet, so there are no
            // per-body freeze states to show. Empty rather than invented.
            #[cfg(feature = "blast-core")]
            CityBackend::Core(_) => Vec::new(),
        }
    }

    pub fn stats(&self) -> DestructionStats {
        match &self.backend {
            CityBackend::Synthetic(backend) => backend.stats(),
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => backend.stats(),
            #[cfg(feature = "blast-core")]
            CityBackend::Core(backend) => {
                // Only the fields the core actually measures. The rest stay at
                // their defaults rather than being filled with plausible
                // numbers: this struct's own contract is that a stat which
                // cannot be produced is worse than no stat, because it is a
                // confident wrong answer.
                let totals = backend.totals();
                DestructionStats {
                    chunk_bodies: backend.body_count() as u32,
                    broken_bonds: totals.fractures as u32,
                    structures: 1,
                    ..DestructionStats::default()
                }
            }
        }
    }

    /// Override the freeze policy the environment configured at open.
    ///
    /// For benches that need to run both sides of the freeze A/B in one
    /// process, where an environment variable would make the result depend on
    /// which test ran first.
    #[cfg(feature = "destruction")]
    pub fn set_freeze_config(
        &mut self,
        config: vibe_land_destruction::freeze::FreezeConfig,
    ) {
        if let CityBackend::Physx(backend) = &mut self.backend {
            backend.set_freeze_config(config);
        }
    }

    pub fn encoder_stats(&self) -> vibe_land_destruction::encoder::EncoderStats {
        self.encoder.stats()
    }

    pub fn take_stream_counters(&mut self) -> (u64, u64, u64) {
        let counters = (self.sent_records, self.sent_bytes, self.sent_packets);
        self.last_stream_counters = counters;
        self.sent_records = 0;
        self.sent_bytes = 0;
        self.sent_packets = 0;
        counters
    }

    /// Last completed 1 Hz window, for read-only telemetry consumers (the
    /// in-page debug overlay) that must not reset the counters.
    pub fn last_stream_counters(&self) -> (u64, u64, u64) {
        self.last_stream_counters
    }

    pub fn is_degraded(&self) -> bool {
        match &self.backend {
            CityBackend::Synthetic(_) => false,
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => backend.degraded(),
            // The core path has no degraded mode: attach either succeeds or the
            // backend is never constructed.
            #[cfg(feature = "blast-core")]
            CityBackend::Core(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A rebuild must keep speaking the wire the session config announced.
    ///
    /// This is the regression for a failure with no error anywhere: reset
    /// dropped the v3 encoder, the server fell back to v2 pose records that
    /// v3 clients discard by design, and v3's topology hold-back then waited
    /// forever on a debris clock that had stopped. Destruction kept happening
    /// and was never drawn -- no gap, no drop, no warning, just a city that
    /// stopped breaking.
    #[test]
    fn reset_preserves_the_wire_version() {
        let mut city = CityRuntime::synthetic(60).expect("synthetic city");
        city.set_wire_version(vibe_land_destruction::wire::CITY_WIRE_V3);
        assert_eq!(city.wire_version(), vibe_land_destruction::wire::CITY_WIRE_V3);
        assert!(city.live.is_some(), "v3 needs its live encoder");

        city.reset(60, None).expect("synthetic reset");

        assert_eq!(
            city.wire_version(),
            vibe_land_destruction::wire::CITY_WIRE_V3,
            "reset silently downgraded the wire"
        );
        assert!(
            city.live.is_some(),
            "reset dropped the v3 live encoder, so no debris span can ever be sent"
        );
    }

    #[test]
    fn reset_keeps_a_v2_match_on_v2() {
        let mut city = CityRuntime::synthetic(60).expect("synthetic city");
        city.set_wire_version(vibe_land_destruction::wire::CITY_WIRE_VERSION);
        city.reset(60, None).expect("synthetic reset");
        assert_eq!(city.wire_version(), vibe_land_destruction::wire::CITY_WIRE_VERSION);
        assert!(city.live.is_none(), "v2 must not gain a v3 encoder");
    }
}
