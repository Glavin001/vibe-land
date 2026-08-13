//! Destructible-city match runtime: destruction backend + stream encoder.
//!
//! A match whose id starts with `city` gets a 4×4 grid of destructible
//! buildings. Default is the synthetic backend (CI-safe). With
//! `--features destruction` and a PhysX GPU arena, `CityDestruction` drives
//! real Blast/PhysX stress fracture unless `VIBE_CITY_SYNTHETIC=1`.

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

/// Stress limits declared by the scene pack, if it carries any.
///
/// The pack is calibrated against its own material band (the high-rise pack
/// reports safety factors of ~2.7 to ~39 under self-weight), so reading them
/// beats hardcoding a guess in the server.
fn scene_stress_limits() -> Option<vibe_land_destruction::scene_pack::StressLimits> {
    static LIMITS: OnceLock<Option<vibe_land_destruction::scene_pack::StressLimits>> =
        OnceLock::new();
    *LIMITS.get_or_init(|| {
        load_scene_pack_file(&asset_path())
            .ok()
            .and_then(|pack| pack.stress_limits)
    })
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
}

pub struct CityRuntime {
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
        config.client_ceiling_bytes =
            usize::from(vibe_land_shared::constants::CITY_CLIENT_CEILING_BYTES_PER_SEND);
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
        // ExtStressPhysX takes absolute stress limits (Pa-scale). The synthetic
        // defaults (0.008/0.01) are for the unitless Rapier path before
        // materialScale — using them here lets gravity shatter the city on
        // spawn. Take the band the scene pack was calibrated against, falling
        // back to the reference concrete numbers. VIBE_CITY_STRESS_LIMIT_SCALE
        // stays available as a sensitivity dial; 1.0 means "the concrete the
        // pack claims to be made of".
        let scale = std::env::var("VIBE_CITY_STRESS_LIMIT_SCALE")
            .ok()
            .and_then(|value| value.parse::<f32>().ok())
            .filter(|value| *value > 0.0)
            .unwrap_or(1.0);
        let limits = scene_stress_limits();
        let (ce, cf, te, tf, se, sf) = limits
            .map(|l| {
                (
                    l.compression_elastic,
                    l.compression_fatal,
                    l.tension_elastic,
                    l.tension_fatal,
                    l.shear_elastic,
                    l.shear_fatal,
                )
            })
            .unwrap_or((12e6, 30e6, 1.2e6, 3e6, 1.6e6, 4e6));
        tracing::info!(
            scene = %scene_file(),
            from_pack = limits.is_some(),
            scale,
            compression_fatal = cf * scale,
            "city stress limits"
        );
        let mut settings = StressSolverSettings::default();
        settings.material = vibe_netcode::destruction_backend::StressMaterial {
            compression_elastic_mpa: ce * scale,
            compression_fatal_mpa: cf * scale,
            tension_elastic_mpa: te * scale,
            tension_fatal_mpa: tf * scale,
            shear_elastic_mpa: se * scale,
            shear_fatal_mpa: sf * scale,
        };
        // City towers have ~150–200 chunks; the synthetic default of 48
        // truncates island promotions mid-collapse.
        // Stress-solve cost is the dominant term once a city is heavily
        // fractured: measured 17.8 ms of a ~30 ms city step at ~6000 broken
        // bonds. Iterations trade convergence for time, and graph reduction
        // coarsens the solved graph. Both are overridable while tuning.
        settings.max_solver_iterations_per_frame = std::env::var("VIBE_CITY_SOLVER_ITERATIONS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(8);
        settings.graph_reduction_level = std::env::var("VIBE_CITY_GRAPH_REDUCTION")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        // No body cap. The adapter treats maximumBodies as an opt-in quality
        // degradation (0 = unlimited): once a structure's live body count
        // reaches the cap, fracture() silently drops EVERY further fracture
        // command for it (NvBlastExtStressPhysX.cpp:1573) — the building still
        // takes impulses, so shots shove it around, but it never breaks again.
        // Presented in play as an indestructible severed slab.
        //
        // The 512 default this used to carry was a perf mitigation from when
        // 1700 awake bodies cost 16.6 ms of PhysX step. That cost was the
        // PERSISTS contact-report bug, since fixed: PhysX now simulates 4000
        // bodies in ~2-4 ms, so the cap's premise is gone and what remained
        // was only its failure mode. VIBE_CITY_MAX_BODIES stays as an escape
        // hatch for weaker hardware; unset or 0 means unlimited.
        settings.maximum_bodies = std::env::var("VIBE_CITY_MAX_BODIES")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        if settings.maximum_bodies > 0 {
            tracing::warn!(
                cap = settings.maximum_bodies,
                "VIBE_CITY_MAX_BODIES set: structures at the cap silently stop \
                 fracturing (adapter drops fracture commands with no telemetry)"
            );
        }
        // Same class of knob: caps how many bonds may break per actor per tick
        // (upstream default 0 = unlimited). At 32 a sustained beam visibly
        // stalled large fractures; the per-tick cost it guarded against is now
        // covered by the parallel + CUDA solve.
        settings.maximum_fractures_per_actor_per_tick = 0;
        // Excess forces off by default. The adapter's excess-force path applies
        // an UNBOUNDED impulse and torque at split time
        // (NvBlastExtStressPhysX.cpp:1914, addTorque(..., eIMPULSE)): the
        // leftover overstress is handed to the fragment as momentum with no cap
        // on the resulting velocity, and a small chunk has tiny inertia, so it
        // diverges. Measured A/B on the deterministic bench, identical input:
        //
        //   on   peak 946 m/s linear / 682 rad/s angular, bodies at -5605 m
        //   off  peak  24 m/s linear /  25 rad/s angular, min body y 0.05 m
        //
        // 24 m/s is free-fall from tower height -- with this path off, nothing
        // in the simulation exceeds plain physics. This unbounded injection is
        // what the old 12 m/s velocity clamp existed to suppress; real
        // fracture ejection is modest (fracture dissipates most energy), so
        // until the upstream path bounds the delivered velocity physically,
        // off is the physically accurate setting. VIBE_CITY_EXCESS_FORCES=1
        // re-enables for comparison. Fracture itself is unaffected (14.3k vs
        // 17.3k broken bonds on the bench run).
        settings.apply_excess_forces = std::env::var("VIBE_CITY_EXCESS_FORCES")
            .map(|value| value == "1")
            .unwrap_or(false);
        let backend = CityDestruction::build(manifest.clone(), world, settings, sim_hz)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        Ok(Self::from_parts(CityBackend::Physx(backend), manifest, sim_hz))
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
                    return Self::physx(sim_hz, world);
                }
            }
        }
        let _ = prefer_synthetic();
        Self::synthetic(sim_hz)
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
        }
    }

    pub fn send_interval_ticks(&self) -> u32 {
        self.send_interval_ticks
    }

    pub fn add_client(&mut self, client: u64) {
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
            CityBackend::Synthetic(backend) => match backend.tick_after_fetch(dt, gravity) {
                Ok(output) => {
                    let snapshots = backend.body_snapshots();
                    self.encoder.ingest_tick(sim_tick, &snapshots, &output, &[]);
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
                                self.encoder.ingest_tick(sim_tick, &snapshots, &output, &[]);
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
        if let Some(baselines) = self.encoder.maybe_emit_baseline(sim_tick) {
            reliable.extend(baselines);
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

    pub fn bootstrap(&self, sim_tick: u32) -> Vec<u8> {
        self.encoder.bootstrap_message(sim_tick)
    }

    pub fn stats(&self) -> DestructionStats {
        match &self.backend {
            CityBackend::Synthetic(backend) => backend.stats(),
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => backend.stats(),
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
        }
    }
}
