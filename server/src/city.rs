//! Destructible-city match runtime: destruction backend + stream encoder.
//!
//! A match whose id starts with `city` gets a 4×4 grid of destructible
//! buildings. The city needs PhysX: a `physx-city` build running
//! `VIBE_PHYSICS_BACKEND=physx_gpu` drives real stress fracture. Anything else
//! refuses city matches (see `city_unavailable_reason`) unless
//! `VIBE_CITY_SYNTHETIC=1` asks for the physics-free synthetic backend, which
//! streams the protocol for CI but has no colliders: shots, meteors and walls
//! do nothing in it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::Context;
use glam::Vec3;

use destruction_codec::debris_codec::{
    SleepPolicy as LiveSleepPolicy, Tolerances as LiveTolerances,
};
use destruction_codec::live::{LiveEncoder, LiveEncoderConfig, RateGovernor};
use destruction_codec::mask::MaskConfig as LiveMaskConfig;
use destruction_codec::trace::{ActorState as LiveActorState, Pose as LivePose};
use vibe_land_destruction::city::{build_city_scene, CityScene, CitySceneDesc};
use vibe_land_destruction::encoder::BodySnapshotInput;
use vibe_land_destruction::encoder::{ChunkStreamEncoder, EncoderConfig, SharedRecords};
use vibe_land_destruction::ids as city_ids;
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::capture::{NetlabCapture, TickStats};
use vibe_land_destruction::scene_pack::load_scene_pack_file;
use vibe_land_destruction::synthetic::SyntheticDestruction;
use vibe_land_destruction::types::Camera;
use vibe_land_destruction::wire::{encode_debris_datagram, DebrisCompressor};
use vibe_netcode::destruction_backend::DestructionTickOutput;
use vibe_netcode::destruction_backend::{DestructionBackend, DestructionStats};

#[cfg(feature = "destruction")]
use vibe_land_destruction::ids;
#[cfg(feature = "physx-city")]
use vibe_land_destruction::bridge_authoring::GROUP_CHUNK;
#[cfg(feature = "destruction")]
use vibe_land_destruction::runtime::CityDestruction;
#[cfg(feature = "physx-city")]
use vibe_land_physx_bridge::{RaycastRequest, Vec3 as BridgeVec3, World};

pub const CITY_MATCH_PREFIX: &str = "city";
/// Impulse handed to the synthetic backend per rifle hit.
const SYNTHETIC_SHOT_IMPULSE: f32 = 400.0;
/// Blast stress contact magnitude for PhysX hitscan (breaks bonds locally).
/// Override with VIBE_CITY_SHOT_STRESS_IMPULSE.
fn physx_shot_stress_impulse() -> f32 {
    vibe_land_destruction::city_config::ShotProfile::city().stress_impulse
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
    vibe_land_destruction::city_config::ShotProfile::city().push_speed
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
#[cfg(any(feature = "blast-core", feature = "native-destruction"))]
fn city_round_momentum_ns() -> f32 {
    std::env::var("VIBE_CITY_ROUND_MOMENTUM_NS")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(3.0e5)
}

/// Shape of the ball fired by the cannonball weapon: radius m, mass kg, speed
/// m/s, lifetime in ticks.
///
/// 0.3 m radius and 10.65 tonnes, set by hand rather than derived: that is
/// about forty times the density of steel, so this ball is deliberately not a
/// physical object. Smaller and heavier makes it punch rather than shove.
///
/// The radius carries a risk worth knowing. The stage forbids CCD, so geometry
/// is the only thing stopping a projectile passing through a wall between
/// ticks, and at 60 m/s a ball travels exactly one metre per 60 Hz tick
/// against a diameter of 0.6 m. Anything thinner than a metre can be tunnelled.
/// Raise VIBE_CITY_BALL_RADIUS_M or lower VIBE_CITY_BALL_SPEED_MS if shots
/// start passing through.
///
/// Mass is the dial that matters, and it was chosen by measurement. One shot at
/// the same facade from the same 26 m stand-off:
///
/// ```text
///    1,500 kg ->    7 bonds   (a scuff; the demo's interactive default)
///    5,000 kg ->   56 bonds
///    7,100 kg ->  249 bonds   (solid steel at 0.6 m, the previous default)
///   10,000 kg ->  323 bonds
///   20,000 kg ->  492 bonds   (the demo's bombardment ball: punches clean
///                              through and flies on for 123 m)
/// ```
///
/// Those were all measured at 0.6 m radius. The current 0.3 m ball concentrates
/// the same impulse on fewer bonds, and a narrower ball broke *more* at equal
/// mass in the one direction already tested (1,500 kg: 0.6 m broke 7, 1.2 m
/// broke 1), so expect a deeper, narrower hole rather than a wider one.
///
/// A wider ball is worse, not better, at the same mass: 1.2 m spreads the same
/// impulse over more bonds and breaks fewer of them (1,500 kg: 7 -> 1).
///
/// Override with VIBE_CITY_BALL_RADIUS_M, VIBE_CITY_BALL_MASS_KG,
/// VIBE_CITY_BALL_SPEED_MS and VIBE_CITY_BALL_TTL_TICKS.
/// Density of the material the cannonball is made of, kg/m^3. Steel.
///
/// The ball's radius is DERIVED from its mass and this, rather than set
/// independently, because the two were independent and drifted into a sphere
/// that could not exist: 10,650 kg at a radius of 0.3 m is 94,167 kg/m^3,
/// four times the density of osmium.
///
/// That is not a cosmetic wrongness. A contact between a body and another a
/// hundred times its mass is ill-conditioned, and when such a ball was found
/// overlapping settled rubble the separation solved to speeds nothing in the
/// scene could reach. Measured on the live server, always in the tick after a
/// shot: 26 bodies went from rest on the ground to 277, 4,717, 8,596, 21,581
/// and 29,690 m/s in one tick, then left the world and took the GPU context
/// with them.
///
/// The fix is the density, not a clamp on the consequence. Mass and speed are
/// unchanged, so the momentum a shot delivers -- and what it knocks down -- is
/// exactly what it was.
pub fn city_ball_density_kg_m3() -> f32 {
    env_positive_f32("VIBE_CITY_BALL_DENSITY_KGM3", 7850.0)
}

/// Radius of a sphere of `city_ball_mass_kg` at `city_ball_density_kg_m3`.
///
/// `VIBE_CITY_BALL_RADIUS_M` still overrides it, for deliberately unphysical
/// experiments. Nothing sets it in production.
pub fn city_ball_radius_m() -> f32 {
    if let Some(explicit) = std::env::var("VIBE_CITY_BALL_RADIUS_M")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| *value > 0.0 && value.is_finite())
    {
        return explicit;
    }
    let volume = city_ball_mass_kg() / city_ball_density_kg_m3();
    (volume * 3.0 / (4.0 * std::f32::consts::PI)).cbrt()
}

pub fn city_ball_mass_kg() -> f32 {
    env_positive_f32("VIBE_CITY_BALL_MASS_KG", 10650.0)
}

pub fn city_ball_speed_ms() -> f32 {
    env_positive_f32("VIBE_CITY_BALL_SPEED_MS", 60.0)
}

pub fn city_ball_ttl_ticks() -> u32 {
    std::env::var("VIBE_CITY_BALL_TTL_TICKS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(360)
}

fn env_positive_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(default)
}

/// Radius of the stress load a single round deposits.
///
/// Bullet-scale, not shell-scale. This was 2.5 m, which is an artillery
/// footprint: a single burst removed most of a building because every round
/// drove load into every bond within a 5 m diameter. A rifle round against
/// concrete spalls a crater measured in centimetres, and the weapon here is
/// full-auto, so the destruction budget wants to come from *many* small
/// precise hits rather than one enormous one.
///
/// Override with VIBE_CITY_SHOT_BLAST_RADIUS.
fn shot_blast_radius_m() -> f32 {
    vibe_land_destruction::city_config::ShotProfile::city().blast_radius_m
}

/// Radius of the rigid-body shove on already-loose debris. Slightly wider than
/// the stress radius so fragments right at the crater still get pushed.
///
/// Override with VIBE_CITY_SHOT_PUSH_RADIUS.
fn shot_push_radius_m() -> f32 {
    vibe_land_destruction::city_config::ShotProfile::city().push_radius_m
}

/// How far past the surface to seat the blast centre.
///
/// Scaled to the radius rather than fixed. The old 0.5 m was half the old
/// radius; against a 0.4 m radius it would bury the entire load inside the
/// slab and never touch the face that was actually hit.
fn shot_blast_depth_m() -> f32 {
    shot_blast_radius_m() * 0.4
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

/// The shot range, for a test that needs to trace the same ray a shot does.
pub fn shot_max_distance_m() -> f32 {
    SHOT_MAX_DISTANCE_M
}

pub fn is_city_match(match_id: &str) -> bool {
    match_id.starts_with(CITY_MATCH_PREFIX)
}

/// Why this server cannot host a real city, or None when it can (or when the
/// synthetic city was asked for). Checked before a player joins a city match
/// so a misconfigured server refuses loudly instead of serving a city with no
/// physics behind it.
pub fn city_unavailable_reason(
    backend: vibe_netcode::physics_backend::PhysicsBackendKind,
) -> Option<String> {
    unavailable_reason(backend, prefer_synthetic(), cfg!(feature = "physx-city"))
}

fn unavailable_reason(
    backend: vibe_netcode::physics_backend::PhysicsBackendKind,
    synthetic: bool,
    physx_city_built: bool,
) -> Option<String> {
    use vibe_netcode::physics_backend::PhysicsBackendKind;
    if synthetic {
        return None;
    }
    if !physx_city_built {
        return Some(
            "the destructible city needs a server built with PhysX city support \
             (--features native-destruction, destruction or physx-city); \
             set VIBE_CITY_SYNTHETIC=1 for the physics-free test city"
                .to_string(),
        );
    }
    if backend != PhysicsBackendKind::PhysxGpu {
        return Some(format!(
            "the destructible city needs VIBE_PHYSICS_BACKEND=physx_gpu, but this \
             server runs {}; start it with scripts/run-city-server.sh or \
             scripts/perf/play-server.sh, or set VIBE_CITY_SYNTHETIC=1 for the \
             physics-free test city",
            backend.name()
        ));
    }
    None
}

/// Match ids starting with this opt into the v3 wire regardless of the env
/// default, so a new codec can be exercised against real clients without
/// changing what every other match gets.
const CITY_V3_MATCH_PREFIX: &str = "cityv3";

/// Cadence of the per-structure ledger-hash broadcast, in sim ticks (2 s at
/// 60 Hz). 54 bytes per emission at GRID=2 — the cost is negligible; the
/// cadence exists so a silently diverged client discovers it within seconds
/// rather than never (`city_desync_repairs` was 0 while a client visibly
/// desynced, because only server-side send drops were detectable).
const TOPO_HASH_INTERVAL_TICKS: u32 = 120;

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
    matches!(selected_backend(), Ok(DestructionBackendKind::BlastCore))
}

/// Which destruction engine drives `/city`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestructionBackendKind {
    /// The original `ExtStressPhysXDestructible` path.
    Blast,
    /// The standardized blast-stress-solver core.
    BlastCore,
    /// PhysX's own GPU destruction stage, inside `simulate()`.
    Native,
}

impl DestructionBackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blast => "blast",
            Self::BlastCore => "blast-core",
            Self::Native => "native",
        }
    }
}

/// Read the selected backend from the environment.
///
/// Explicit and failing, never inferred: an A/B is only worth running when you
/// can be certain which side you got, and a silent fall-through would make the
/// comparison measure the same code twice and agree with itself. The older
/// `VIBE_CITY_BLAST_CORE=1` still works and is checked for agreement rather
/// than quietly losing to the newer variable.
pub fn selected_backend() -> anyhow::Result<DestructionBackendKind> {
    let legacy = std::env::var("VIBE_CITY_BLAST_CORE").ok();
    let legacy_core = legacy.as_deref() == Some("1");
    let selected = match std::env::var("VIBE_CITY_DESTRUCTION").ok().as_deref() {
        None => {
            return Ok(if legacy_core {
                DestructionBackendKind::BlastCore
            } else if cfg!(feature = "destruction") || !cfg!(feature = "native-destruction") {
                DestructionBackendKind::Blast
            } else {
                // Built without Blast: the native stage is the only PhysX
                // backend there is, so it is the default rather than an error.
                DestructionBackendKind::Native
            })
        }
        Some("blast") => DestructionBackendKind::Blast,
        Some("blast-core") | Some("blast_core") => DestructionBackendKind::BlastCore,
        Some("native") => DestructionBackendKind::Native,
        Some(other) => anyhow::bail!(
            "VIBE_CITY_DESTRUCTION={other} is not a destruction backend \
             (expected blast, blast-core or native)"
        ),
    };
    if legacy_core && selected != DestructionBackendKind::BlastCore {
        anyhow::bail!(
            "VIBE_CITY_BLAST_CORE=1 and VIBE_CITY_DESTRUCTION={} disagree; set one",
            selected.as_str()
        );
    }
    Ok(selected)
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

fn scene_payload() -> anyhow::Result<&'static Vec<u8>> {
    static PAYLOAD: OnceLock<Result<Vec<u8>, String>> = OnceLock::new();
    PAYLOAD.get_or_init(|| std::fs::read(asset_path()).map_err(|e| e.to_string()))
        .as_ref().map_err(|e| anyhow::anyhow!("reading city scene: {e}"))
}

fn build_scene() -> anyhow::Result<CityScene> {
    let path = asset_path();
    // Binary bundles already contain the complete placement recipe. Preserve
    // instance boundaries instead of treating the whole town as one building.
    let payload = scene_payload()?;
    if payload.starts_with(b"VLSP") || payload.starts_with(b"VLSW") {
        anyhow::ensure!(
            std::env::var("VIBE_CITY_GRID").map_or(true, |grid| grid == "1"),
            "VLSP town bundles already contain placements; use VIBE_CITY_GRID=1"
        );
        return vibe_land_destruction::scene_binary::decode_city(&payload)
            .map_err(|error| anyhow::anyhow!("loading city bundle {}: {error}", path.display()));
    }
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
    desc.varied_heights = vibe_land_destruction::city_config::city_varied_heights();
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
    build_city_scene(&pack, desc).map_err(|error| anyhow::anyhow!("building city scene: {error}"))
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
            let parsed = scene_payload().ok().and_then(|payload| {
                if payload.starts_with(b"VLSP") || payload.starts_with(b"VLSW") {
                    vibe_land_destruction::scene_binary::decode(payload).ok()
                } else { load_scene_pack_file(&asset_path()).ok() }
            });
            parsed.map(|pack| pack.materials).unwrap_or_default()
        })
        .clone()
}

pub fn manifest_asset() -> Option<&'static (String, Arc<DestructionManifest>, Vec<u8>)> {
    static ASSET: OnceLock<Option<(String, Arc<DestructionManifest>, Vec<u8>)>> = OnceLock::new();
    ASSET
        .get_or_init(|| match build_scene() {
            Ok(scene) => {
                let manifest = DestructionManifest::from_city(&scene);
                // to_bytes, not to_json_bytes: the binary VLCM payload.
                //
                // This regressed silently in the merge -- no conflict marker,
                // upstream's older line simply won -- and the symptom was an
                // empty world. 60 MB of JSON where 16 MB of binary belongs,
                // which a browser has to hold as bytes, as a string, and as a
                // parsed object graph all at once.
                let json = manifest.to_bytes();
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

/// One tick's deferred observer work (VIBE_CITY_OBSERVER_PIPELINE=1): the
/// destruction output retained between step_stage() and flush_staged().
/// Snapshots are NOT copied — the backend's capture buffer holds tick N's
/// rows untouched until tick N+1's post_step, and the flush runs before that.
pub struct StagedCityTick {
    pub sim_tick: u32,
    output: DestructionTickOutput,
    post_step_ms: f32,
    snapshot_ms: f32,
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
    /// PhysX's own GPU destruction stage, selected by
    /// `VIBE_CITY_DESTRUCTION=native`.
    ///
    /// Beside the other two rather than replacing them, so all three can be run
    /// against the same scene in the same binary. Under this backend there is
    /// no freeze tracker, no resimulation and no support-set ingest: the engine
    /// owns correction and its own sleep, and duplicating those here is what
    /// made the previous attempt at this port impossible to reason about.
    #[cfg(feature = "native-destruction")]
    Native(vibe_land_destruction::native_runtime::NativeCityDestruction),
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
            gravity: {
                let g = vibe_netcode::movement::default_world_gravity();
                glam::Vec3::new(g[0], g[1], g[2])
            },
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
                let key = u64::from(city_ids::body_entity(
                    promotion.structure_id,
                    promotion.island_id,
                ));
                let reach = Self::island_reach(manifest, promotion.structure_id, &promotion.chunks);
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

/// Every span timer in the destruction tick, sampled EVERY tick and summarised
/// at publish.
///
/// The 1 Hz snapshot publishes one tick's instantaneous values, and that single
/// sample is not neutral: the publish fires every `SIM_HZ` (60) ticks while the
/// bond-utilisation scan fires every 30, so `60 % 30 == 0` and the published
/// tick is ALWAYS one of the expensive ones. Measured: `bond_sample_ms` came
/// back non-zero in 6 of 6 consecutive snapshots for a scan that runs on 1 tick
/// in 30. Any per-tick cost read off the endpoint inherited that bias.
///
/// Windowing removes it -- p95 and max also surface the spikes a single sample
/// can only catch by luck.
pub const PHASE_NAMES: [&str; 25] = [
    "stress_solve_ms",
    "begin_ms",
    "solve_ms",
    "end_ms",
    "readback_ms",
    "events_ms",
    "filters_ms",
    "ccd_ms",
    "support_loads_ms",
    "shape_readback_ms",
    "slot_dispatch_ms",
    "bond_sample_ms",
    "gpu_stress_solve_ms",
    "blast_contact_processing_ms",
    "blast_gravity_ms",
    "blast_stress_solve_cpu_ms",
    // The topology phases. end_ms was the largest phase mid-collapse (9.8 ms at
    // 7k awake) and had no p95 at all, because these two were collected and
    // never windowed -- so the spikiest thing in the tick was the one thing
    // only ever seen as a 1 Hz point sample.
    //
    // These two OVERLAP and must not be summed. validateMappings() is called
    // from fracture()'s return statement, and fractureTopologyMilliseconds
    // brackets the whole fracture() call, so mapping validation is counted
    // inside fracture topology AND again on its own. The _excl_ series below is
    // the part of fracture() that is not mapping validation.
    "blast_fracture_topology_ms",
    "blast_mapping_validation_ms",
    "blast_fracture_topology_excl_validation_ms",
    // The fracture SUB-phases and settle. Added after a live report caught an
    // 89 ms tick whose city side was 71 ms while the windowed phases
    // accounted for only ~33 of it: the worst tick in the game was mostly
    // unattributed, because these were published as 1 Hz point samples only —
    // and a point sample of a spiky phase is the one thing that cannot see a
    // spike. `window_ingest_ms` (already windowed) carried the other half at
    // 32.75 ms max, which is what pointed here.
    "blast_fracture_generate_ms",
    "blast_fracture_prep_ms",
    "blast_fracture_apply_ms",
    "blast_fracture_scene_ms",
    "blast_fracture_rebuild_ms",
    "settle_ms",
];

#[derive(Default)]
pub struct PhaseWindows {
    series: Vec<Vec<f32>>,
}

impl PhaseWindows {
    fn push(&mut self, values: [f32; PHASE_NAMES.len()]) {
        if self.series.len() != PHASE_NAMES.len() {
            self.series = vec![Vec::new(); PHASE_NAMES.len()];
        }
        for (slot, value) in self.series.iter_mut().zip(values) {
            slot.push(value);
        }
    }

    /// Summaries by phase name. Empty until the first tick is recorded.
    pub fn drain(&mut self) -> std::collections::BTreeMap<String, WindowSummary> {
        self.series
            .iter_mut()
            .enumerate()
            .map(|(index, values)| {
                (PHASE_NAMES[index].to_string(), summarize_window(values))
            })
            .collect()
    }
}

#[derive(Default)]
pub struct CityTickWindow {
    step_ms: Vec<f32>,
    ingest_ms: Vec<f32>,
    span_encode_ms: Vec<f32>,
    awake: Vec<f32>,
    pub phases: PhaseWindows,
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

/// The one place the encoder is fed, on every backend and both pipelines.
///
/// The v2 encoder always owns the ledger and the reliable topology messages,
/// so it always ingests; its per-awake-body classifier pass only feeds the v2
/// pose stream, and a v3 match skips it. The capture, when present, sees the
/// identical input first -- what it records is by construction what the
/// encoder was given.
fn feed_encoder(
    capture: &mut Option<NetlabCapture>,
    encoder: &mut ChunkStreamEncoder,
    live: &mut Option<V3Live>,
    manifest: &DestructionManifest,
    sim_tick: u32,
    snapshots: &[BodySnapshotInput],
    output: &DestructionTickOutput,
) {
    if let Some(capture) = capture.as_mut() {
        // Immediately before the first captured tick: the encoder's whole
        // state, so an offline replay of a capture that began mid-match
        // resumes the encoder exactly instead of starting it from nothing.
        if capture.needs_checkpoint() {
            capture.push_checkpoint(encoder.checkpoint());
        }
        capture.push_tick(sim_tick, snapshots, output);
    }
    if live.is_some() {
        encoder.ingest_tick_topology_only(sim_tick, snapshots, output, &output.wakes);
    } else {
        encoder.ingest_tick(sim_tick, snapshots, output, &output.wakes);
    }
    if let Some(live) = live.as_mut() {
        live.ingest(manifest, sim_tick, snapshots, output);
    }
}

fn backend_name_of(backend: &CityBackend) -> &'static str {
    match backend {
        CityBackend::Synthetic(_) => "synthetic",
        #[cfg(feature = "destruction")]
        CityBackend::Physx(_) => "blast",
        #[cfg(feature = "blast-core")]
        CityBackend::Core(_) => "blast-core",
        #[cfg(feature = "native-destruction")]
        CityBackend::Native(_) => "native",
    }
}

/// `VIBE_CITY_TAPE_OUT=<dir>` turns a match into its own recorder.
fn open_capture(
    manifest: &DestructionManifest,
    sim_hz: u32,
    backend: &'static str,
) -> Option<NetlabCapture> {
    let dir = std::env::var("VIBE_CITY_TAPE_OUT").ok()?;
    if dir.trim().is_empty() {
        return None;
    }
    let wire = std::env::var("VIBE_CITY_WIRE")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(2);
    let fingerprint = serde_json::to_value(
        vibe_land_destruction::fingerprint::capture_with_build(cfg!(feature = "cuda-stress")),
    )
    .unwrap_or(serde_json::Value::Null);
    match NetlabCapture::open(
        std::path::Path::new(&dir),
        sim_hz,
        manifest,
        &scene_file(),
        backend,
        wire,
        fingerprint,
    ) {
        Ok(capture) => {
            tracing::info!(dir = %dir, backend, "netlab capture recording");
            Some(capture)
        }
        Err(error) => {
            tracing::error!(%error, dir = %dir, "netlab capture could not open; not recording");
            None
        }
    }
}

/// What opening an encoder capture needs from a running city, so it can be
/// opened off the tick thread (it writes the whole manifest to disk first).
#[derive(Clone)]
pub struct CaptureSpec {
    manifest: Arc<DestructionManifest>,
    sim_hz: u32,
    backend: &'static str,
    wire: u8,
}

/// Open an encoder capture at `dir` for a city described by `spec`. Slow
/// (manifest write); call it off the tick thread and hand the result to
/// `CityRuntime::install_capture`.
pub fn open_capture_at(spec: &CaptureSpec, dir: &std::path::Path) -> std::io::Result<NetlabCapture> {
    let fingerprint = serde_json::to_value(
        vibe_land_destruction::fingerprint::capture_with_build(cfg!(feature = "cuda-stress")),
    )
    .unwrap_or(serde_json::Value::Null);
    NetlabCapture::open(
        dir,
        spec.sim_hz,
        &spec.manifest,
        &scene_file(),
        spec.backend,
        spec.wire,
        fingerprint,
    )
}

pub struct CityRuntime {
    /// Queued demolition targets, released a few per tick by
    /// `drain_demolition` so a building fails progressively rather than being
    /// cut cleanly in two.
    pending_demolition: Vec<[f32; 3]>,
    demolition_centre: [f32; 2],
    demolition_heading_deg: f32,
    demolition_wedge_deg: f32,
    demolition_jitter: f32,
    demolition_seed: u64,
    /// Per-tick samples between telemetry publishes; drained at each publish.
    pub tick_window: CityTickWindow,
    /// Present when this match speaks wire v3; owns the live pose stream.
    live: Option<V3Live>,
    /// Present when `VIBE_CITY_TAPE_OUT` is set: the match records its own
    /// encoder input so the stream can be replayed offline against exactly
    /// what happened here.
    capture: Option<NetlabCapture>,
    sim_hz: u32,
    backend: CityBackend,
    encoder: ChunkStreamEncoder,
    pub manifest: Arc<DestructionManifest>,
    send_interval_ticks: u32,
    pub last_encode_ms: f32,
    /// Post-fracture push re-apply: the blast pushes deferred from the
    /// fracture that produced them, replayed after post_step. Previously part
    /// of the `step_ms` unattributed remainder.
    pub last_push_reapply_ms: f32,
    /// `step_ms` minus post_step, push re-apply and snapshot. Published so an
    /// untimed block cannot hide in a subtraction nobody performs.
    pub last_step_residual_ms: f32,
    last_encode_shared_ms: f32,
    last_client_datagrams_ms: f32,
    structure_centers: Vec<(Vec3, f32)>,
    sent_records: u64,
    sent_bytes: u64,
    sent_packets: u64,
    /// Never reset: the capture's per-tick stats line reports totals so a
    /// window's rate is a difference, not a drained counter's remainder.
    total_sent_records: u64,
    total_sent_bytes: u64,
    last_stream_counters: (u64, u64, u64),
    /// Blasts that need a post-fracture PhysX push (first hit on kinematic
    /// support promotes islands only during `step`, so we re-apply push then).
    pending_pushes: Vec<(Vec3, Vec3, f32, f32)>,
}

impl CityRuntime {
    fn from_parts(backend: CityBackend, manifest: Arc<DestructionManifest>, sim_hz: u32) -> Self {
        let mut config = EncoderConfig::validated(sim_hz);
        config.send_interval_ticks =
            (sim_hz / u32::from(vibe_land_shared::constants::CITY_CHUNK_STREAM_HZ)).max(1);
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
        let capture = open_capture(&manifest, sim_hz, backend_name_of(&backend));
        Self {
            live: None,
            capture,
            pending_demolition: Vec::new(),
            demolition_centre: [0.0, 0.0],
            demolition_heading_deg: 0.0,
            demolition_wedge_deg: 0.0,
            demolition_jitter: 0.0,
            demolition_seed: 0x5eed_1234_abcd_ef01,
            tick_window: CityTickWindow::default(),
            sim_hz,
            backend,
            encoder,
            manifest,
            send_interval_ticks: config.send_interval_ticks,
            last_encode_ms: 0.0,
            last_push_reapply_ms: 0.0,
            last_step_residual_ms: 0.0,
            last_encode_shared_ms: 0.0,
            last_client_datagrams_ms: 0.0,
            structure_centers,
            sent_records: 0,
            sent_bytes: 0,
            sent_packets: 0,
            total_sent_records: 0,
            total_sent_bytes: 0,
            last_stream_counters: (0, 0, 0),
            pending_pushes: Vec::new(),
        }
    }

    pub fn synthetic(sim_hz: u32) -> anyhow::Result<Self> {
        let (_, manifest, _) =
            manifest_asset().context("city scene asset unavailable (destruction/assets/scenes)")?;
        let manifest = manifest.clone();
        let backend = SyntheticDestruction::from_manifest(&manifest, sim_hz);
        Ok(Self::from_parts(
            CityBackend::Synthetic(backend),
            manifest,
            sim_hz,
        ))
    }

    #[cfg(feature = "destruction")]
    pub fn physx(sim_hz: u32, world: &mut World) -> anyhow::Result<Self> {
        let (_, manifest, _) =
            manifest_asset().context("city scene asset unavailable (destruction/assets/scenes)")?;
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
        Ok(Self::from_parts(
            CityBackend::Physx(backend),
            manifest,
            sim_hz,
        ))
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
        let settings =
            vibe_land_destruction::city_config::stress_settings(&scene_stress_materials());
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
                vibe_netcode::movement::default_world_gravity(),
                grid,
                varied_heights,
                // The host's own chunk group and mask, so its raycasts and its
                // collision filtering see library shapes exactly as they see
                // the ones the old path created.
                GROUP_CHUNK,
                crate::physx_runtime::ALL_GROUPS,
                // Same knob the old path reads, so the two are configured
                // identically and a comparison between them is meaningful.
                vibe_land_destruction::city_config::stress_limit_scale(),
                // Every remaining knob read from the same place the old path
                // reads it. A backend comparison is only meaningful if the two
                // are configured identically, and solver iterations in
                // particular are physics: below convergence the solver reports
                // residual as stress, and residual breaks bonds.
                settings.max_solver_iterations_per_frame,
                settings.apply_excess_forces,
                settings.excess_force_scale,
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

    /// The same city, driven by PhysX's own GPU destruction stage.
    ///
    /// Authored from the same manifest and the same material table as the other
    /// backends -- a comparison between them means nothing unless both are
    /// handed identical inputs.
    #[cfg(feature = "native-destruction")]
    pub fn native(sim_hz: u32, world: &mut World) -> anyhow::Result<Self> {
        use vibe_land_destruction::native_runtime::NativeCityDestruction;
        let (_, manifest, _) =
            manifest_asset().context("city scene asset unavailable (destruction/assets/scenes)")?;
        let manifest = manifest.clone();
        let pack_materials = scene_stress_materials();
        let settings = vibe_land_destruction::city_config::stress_settings(&pack_materials);
        tracing::info!(
            scene = %scene_file(),
            from_pack = !pack_materials.is_empty(),
            materials = settings.materials.len(),
            structures = manifest.structures.len(),
            "city on PhysX native destruction"
        );
        let backend = NativeCityDestruction::build(manifest.clone(), world, settings, sim_hz)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let payload = scene_payload()?;
        if payload.starts_with(b"VLSW") {
            use vibe_land_destruction::scene_warm;
            let warm = scene_warm::decode(payload).map_err(|e| anyhow::anyhow!("{e}"))?;
            let runtime = world.native_warm_runtime_path()
                .ok().and_then(|path| std::fs::read(path).ok()).map(|bytes| scene_warm::sha256(&bytes));
            let tolerance = std::env::var("VIBE_CITY_NATIVE_STRESS_TOLERANCE").ok()
                .and_then(|s| s.parse::<f32>().ok()).filter(|v| *v > 0.).unwrap_or(1e-5);
            if runtime.as_deref().map_or(false, |hash| warm.compatible(hash, [0.,-9.81,0.], 1./sim_hz as f32, tolerance)) {
                anyhow::ensure!(manifest.structures.len() == warm.descriptor.structures.len(), "warm structure count mismatch");
                world.native_import_warm_start(&warm.values).map_err(|e| anyhow::anyhow!("{e}"))?;
                tracing::info!(baked_structures = warm.descriptor.structures.iter().filter(|r| r.baked).count(),
                    complete = warm.descriptor.complete, "imported warm guesses; native convergence remains unverified until simulation");
            } else {
                tracing::warn!("warm cache runtime/settings mismatch or extension unavailable; starting scene cold");
            }
        }
        Ok(Self::from_parts(
            CityBackend::Native(backend),
            manifest,
            sim_hz,
        ))
    }

    /// Open the PhysX-backed city, or the synthetic one when
    /// `VIBE_CITY_SYNTHETIC=1`. Without a PhysX world (or a build without city
    /// support) this fails rather than quietly serving a city with no physics.
    pub fn open(
        sim_hz: u32,
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] _world: Option<()>,
    ) -> anyhow::Result<Self> {
        #[cfg(feature = "physx-city")]
        {
            if !prefer_synthetic() {
                if let Some(world) = world {
                    // Fails rather than falling back, in both directions: an
                    // unbuilt backend is a configuration error, not a reason to
                    // quietly run a different engine than the one asked for.
                    match selected_backend()? {
                        DestructionBackendKind::Blast => {
                            #[cfg(feature = "destruction")]
                            return Self::physx(sim_hz, world);
                            #[cfg(not(feature = "destruction"))]
                            anyhow::bail!(
                                "VIBE_CITY_DESTRUCTION=blast needs the destruction feature"
                            );
                        }
                        DestructionBackendKind::BlastCore => {
                            #[cfg(feature = "blast-core")]
                            return Self::blast_core(sim_hz, world);
                            #[cfg(not(feature = "blast-core"))]
                            anyhow::bail!(
                                "VIBE_CITY_DESTRUCTION=blast-core needs the blast-core feature"
                            );
                        }
                        DestructionBackendKind::Native => {
                            #[cfg(feature = "native-destruction")]
                            return Self::native(sim_hz, world);
                            #[cfg(not(feature = "native-destruction"))]
                            anyhow::bail!(
                                "VIBE_CITY_DESTRUCTION=native needs the native-destruction feature"
                            );
                        }
                    }
                } else {
                    anyhow::bail!(
                        "the destructible city needs a PhysX world \
                         (VIBE_PHYSICS_BACKEND=physx_gpu); set VIBE_CITY_SYNTHETIC=1 \
                         for the physics-free test city"
                    );
                }
            }
        }
        if !prefer_synthetic() {
            anyhow::bail!(
                "this server was built without PhysX city support; set \
                 VIBE_CITY_SYNTHETIC=1 for the physics-free test city"
            );
        }
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
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] world: Option<()>,
    ) -> anyhow::Result<()> {
        let clients = self.encoder.clients();
        #[cfg(feature = "physx-city")]
        let world = {
            // Each backend owns its own actors, so the release has to match the
            // one that built them. The native stage additionally owns the
            // fragment bodies it created, and `clearStress` is the only thing
            // that can destroy them -- calling the wrong release would leave a
            // scene full of orphaned chunks that the rebuilt city then collides
            // with.
            if let Some(world) = world {
                match &mut self.backend {
                    #[cfg(feature = "native-destruction")]
                    CityBackend::Native(backend) => {
                        // A failed clear must NOT abort the reset. `clearStress`
                        // refuses while the stage is in an error state, which is
                        // exactly the state a reset is being asked to repair --
                        // so returning here made the one available repair
                        // unavailable precisely when it was needed, and the
                        // match stayed indestructible until the process was
                        // restarted. Observed live: three reset attempts, all
                        // refused, 19,590 rejected ticks between them.
                        //
                        // Rebuilding over a stage that would not release leaks
                        // its actors for the life of the process. That is a bad
                        // trade to make casually and a good one to make here:
                        // the alternative is a match nobody can play.
                        if let Err(error) = backend.clear(world) {
                            tracing::error!(
                                %error,
                                "the native stage refused to release its topology; rebuilding anyway and leaking what it kept"
                            );
                        }
                    }
                    #[cfg(feature = "blast-core")]
                    CityBackend::Core(_) => {}
                    #[cfg(feature = "destruction")]
                    _ => world.clear_destructibles()?,
                    #[cfg(not(feature = "destruction"))]
                    _ => {}
                }
                Some(world)
            } else {
                None
            }
        };
        // A synthetic city was asked for when it was opened; it rebuilds as
        // one rather than re-deciding (and refusing) from the environment.
        let mut rebuilt = if matches!(self.backend, CityBackend::Synthetic(_)) {
            Self::synthetic(sim_hz)?
        } else {
            Self::open(sim_hz, world)?
        };
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
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(_) => true,
        }
    }

    /// The destruction engine this match is actually running.
    pub fn backend_name(&self) -> &'static str {
        backend_name_of(&self.backend)
    }

    /// True when this match is recording an encoder tape.
    pub fn capturing(&self) -> bool {
        self.capture.is_some()
    }

    pub fn capture_spec(&self) -> CaptureSpec {
        CaptureSpec {
            manifest: self.manifest.clone(),
            sim_hz: self.sim_hz,
            backend: self.backend_name(),
            wire: self.wire_version(),
        }
    }

    /// Start recording into a capture opened by `open_capture_at`. Refused
    /// (and handed back) when a capture is already running.
    pub fn install_capture(&mut self, capture: NetlabCapture) -> Result<(), NetlabCapture> {
        if self.capture.is_some() {
            return Err(capture);
        }
        tracing::info!(dir = %capture.dir().display(), "netlab capture recording (session)");
        self.capture = Some(capture);
        Ok(())
    }

    /// Stop recording and hand the capture back unfinished, so the caller can
    /// finish it (drain the writer) off the tick thread.
    pub fn take_capture(&mut self) -> Option<NetlabCapture> {
        self.capture.take()
    }

    /// What the last `client_datagrams` call decided, per gate.
    pub fn last_client_selection(&self) -> vibe_land_destruction::encoder::ClientSelectionSummary {
        self.encoder.last_client_selection()
    }

    pub fn capture_cameras(&mut self, sim_tick: u32, cameras: &[(u32, Camera)]) {
        if let Some(capture) = self.capture.as_mut() {
            capture.push_cameras(sim_tick, cameras);
        }
    }

    pub fn capture_event(&mut self, sim_tick: u32, value: serde_json::Value) {
        if let Some(capture) = self.capture.as_mut() {
            capture.push_event(sim_tick, value);
        }
    }

    pub fn capture_stats(&mut self, stats: &TickStats) {
        if let Some(capture) = self.capture.as_mut() {
            capture.push_stats(stats);
        }
    }

    /// Close the tape cleanly (the writer drains, then the metadata is
    /// finalised). Also happens on drop; explicit so a reset can log it.
    pub fn finish_capture(&mut self) {
        if let Some(capture) = self.capture.take() {
            match capture.finish() {
                Ok(meta) => tracing::info!(
                    ticks = meta.ticks,
                    dropped = meta.dropped_ticks,
                    "netlab capture finished"
                ),
                Err(error) => tracing::error!(%error, "netlab capture finish failed"),
            }
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
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] _world: Option<()>,
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
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(backend) => {
                // The same real raycast as the other backends, then the shot is
                // delivered as a physical round. The stage has no force to
                // inject -- bonds break because PhysX solved a contact -- so a
                // hitscan hit becomes a real body carrying the round's momentum
                // for the few ticks it takes to strike.
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
                let Some(world) = world else {
                    return false;
                };
                let at = [hit.position.x, hit.position.y, hit.position.z];
                match backend.fire_round(
                    world,
                    at,
                    direction.to_array(),
                    city_round_momentum_ns(),
                ) {
                    Ok(()) => true,
                    Err(error) => {
                        tracing::warn!(%error, "native round could not be fired");
                        false
                    }
                }
            }
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
                    shot_blast_radius_m(),
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
                let point = surface + direction * shot_blast_depth_m();
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
                match backend.wake_around(world, point.to_array(), shot_push_radius_m()) {
                    Ok(0) => {}
                    Ok(woken) => tracing::debug!(woken, "city shot woke frozen rubble"),
                    Err(error) => tracing::warn!(%error, "city spatial wake failed"),
                }

                match backend.apply_blast(
                    world,
                    point.to_array(),
                    direction.to_array(),
                    shot_blast_radius_m(),
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
                                shot_push_radius_m(),
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
    /// Take the fracture-frame resimulation capture, immediately before the
    /// host steps PhysX. No-op unless VIBE_CITY_RESIM_PASSES > 0.
    #[cfg(feature = "physx-city")]
    pub fn pre_step(&mut self, world: Option<&mut World>) {
        #[cfg(feature = "destruction")]
        if let (CityBackend::Physx(backend), Some(world)) = (&mut self.backend, world) {
            backend.pre_step(world);
        }
        #[cfg(not(feature = "destruction"))]
        let _ = world;
    }

    pub fn step(
        &mut self,
        sim_tick: u32,
        dt: f32,
        gravity: [f32; 3],
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] _world: Option<()>,
    ) -> Vec<Vec<u8>> {
        let started = std::time::Instant::now();
        let mut reliable = Vec::new();
        let pending_pushes = std::mem::take(&mut self.pending_pushes);
        match &mut self.backend {
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(backend) => {
                // The engine already solved, fractured and corrected inside the
                // step the host just finished. This arm only reads the
                // committed result and feeds it onward; there is no solve to
                // drive and nothing to replay.
                let Some(world) = world else {
                    tracing::error!("native city step missing World");
                    return reliable;
                };
                let post_step_started = std::time::Instant::now();
                let post_step_result = backend.post_step(world, dt);
                let post_step_ms = post_step_started.elapsed().as_secs_f32() * 1000.0;
                match post_step_result {
                    Ok(output) => {
                        // Timed, as the Physx arm's ingest is: this was the
                        // one child of the native step with no span, and at
                        // 19k awake bodies it was the largest one.
                        let ingest_started = std::time::Instant::now();
                        let snapshots = backend.body_snapshots();
                        feed_encoder(
                            &mut self.capture,
                            &mut self.encoder,
                            &mut self.live,
                            &self.manifest,
                            sim_tick,
                            snapshots,
                            &output,
                        );
                        reliable.extend(self.encoder.take_topology_messages());
                        let ingest_ms = ingest_started.elapsed().as_secs_f32() * 1000.0;
                        backend.record_host_timings(ingest_ms);
                        // What the step spent that neither the backend's
                        // post_step nor the ingest claims.
                        self.last_step_residual_ms =
                            started.elapsed().as_secs_f32() * 1000.0 - post_step_ms - ingest_ms;
                    }
                    Err(error) => {
                        tracing::error!(%error, "native city tick failed; topology frozen");
                    }
                }
                let _ = pending_pushes;
            }
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
                feed_encoder(
                    &mut self.capture,
                    &mut self.encoder,
                    &mut self.live,
                    &self.manifest,
                    sim_tick,
                    &snapshots,
                    &output,
                );
                reliable.extend(self.encoder.take_topology_messages());
                let _ = post_step_ms;
            }
            CityBackend::Synthetic(backend) => match backend.tick_after_fetch(dt, gravity) {
                Ok(output) => {
                    let snapshots = backend.body_snapshots();
                    feed_encoder(
                        &mut self.capture,
                        &mut self.encoder,
                        &mut self.live,
                        &self.manifest,
                        sim_tick,
                        &snapshots,
                        &output,
                    );
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
                        let snapshot_ms = snapshot_started.elapsed().as_secs_f32() * 1000.0;
                        match snapshot_result {
                            Ok(snapshots) => {
                                let ingest_started = std::time::Instant::now();
                                feed_encoder(
                                    &mut self.capture,
                                    &mut self.encoder,
                                    &mut self.live,
                                    &self.manifest,
                                    sim_tick,
                                    snapshots,
                                    &output,
                                );
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
        // Periodic ledger hashes: the client-side divergence detector. Rides
        // the ordered reliable channel AFTER this tick's topology messages, so
        // a gap-free client compares at exactly the seq the hashes describe.
        if sim_tick % TOPO_HASH_INTERVAL_TICKS == 0 {
            reliable.push(self.encoder.topology_hash_message());
        }
        self.last_encode_ms = started.elapsed().as_secs_f32() * 1000.0;
        reliable
    }

    /// Sim half of the observer pipeline (VIBE_CITY_OBSERVER_PIPELINE=1):
    /// exactly step()'s simulation-side work — destruction tick, re-applied
    /// pushes, snapshot capture — with every encoder/ledger byte deferred
    /// into the returned ticket, which flush_staged() consumes next tick
    /// inside the GPU wait. Only the Physx arm stages; the other backends
    /// (and any error path) fall back to the combined step() so no tick ever
    /// loses its baseline/hash cadence.
    pub fn step_stage(
        &mut self,
        sim_tick: u32,
        dt: f32,
        gravity: [f32; 3],
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] world: Option<()>,
    ) -> (Vec<Vec<u8>>, Option<StagedCityTick>) {
        #[cfg(feature = "destruction")]
        {
            // Staging needs BOTH a Physx backend and a world; anything else
            // takes the combined path. Decided before the borrow so `world`
            // survives into the fallback.
            let stageable =
                matches!(self.backend, CityBackend::Physx(_)) && world.is_some();
            if !stageable {
                return (self.step(sim_tick, dt, gravity, world), None);
            }
            let world = world.expect("checked by stageable");
            if let CityBackend::Physx(backend) = &mut self.backend {
                let started = std::time::Instant::now();
                let pending_pushes = std::mem::take(&mut self.pending_pushes);
                let post_step_started = std::time::Instant::now();
                let post_step_result = backend.post_step(world, dt, gravity);
                let post_step_ms =
                    post_step_started.elapsed().as_secs_f32() * 1000.0;
                match post_step_result {
                    Ok(output) => {
                        // Named because `step_ms` minus its children was
                        // running 1-3.6 ms and this loop was the documented
                        // reason. An "unattributed" bucket that everyone knows
                        // the contents of is just a span nobody added yet.
                        let push_started = std::time::Instant::now();
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
                        self.last_push_reapply_ms =
                            push_started.elapsed().as_secs_f32() * 1000.0;
                        let snapshot_started = std::time::Instant::now();
                        let snapshot_ms = match backend.body_snapshots(world) {
                            Ok(_) => {
                                snapshot_started.elapsed().as_secs_f32() * 1000.0
                            }
                            Err(error) => {
                                tracing::error!(%error, "city body snapshot failed");
                                self.last_encode_ms =
                                    started.elapsed().as_secs_f32() * 1000.0;
                                return (Vec::new(), None);
                            }
                        };
                        self.last_encode_ms =
                            started.elapsed().as_secs_f32() * 1000.0;
                        // Same closure discipline as post_step_residual_ms:
                        // what the step spent that none of its children claim.
                        self.last_step_residual_ms = self.last_encode_ms
                            - post_step_ms
                            - self.last_push_reapply_ms
                            - snapshot_ms;
                        return (
                            Vec::new(),
                            Some(StagedCityTick {
                                sim_tick,
                                output,
                                post_step_ms,
                                snapshot_ms,
                            }),
                        );
                    }
                    Err(error) => {
                        tracing::error!(%error, "city physx post_step failed; topology frozen");
                        self.last_encode_ms =
                            started.elapsed().as_secs_f32() * 1000.0;
                        return (Vec::new(), None);
                    }
                }
            }
            unreachable!("stageable implies a Physx backend")
        }
        #[cfg(not(feature = "destruction"))]
        {
            (self.step(sim_tick, dt, gravity, world), None)
        }
    }

    /// Observer half: everything step() runs after the snapshot capture —
    /// encoder ingest, topology/baseline/hash messages — in the same order,
    /// one tick later, against the ticket's retained output and the
    /// backend's still-untouched snapshot buffer. Makes no World calls by
    /// construction: it takes none.
    #[cfg(feature = "physx-city")]
    pub fn flush_staged(&mut self, staged: StagedCityTick) -> Vec<Vec<u8>> {
        let started = std::time::Instant::now();
        let mut reliable = Vec::new();
        let sim_tick = staged.sim_tick;
        // Only the Blast backend stages; the others never produce a ticket.
        #[cfg(feature = "destruction")]
        if let CityBackend::Physx(backend) = &mut self.backend {
            let output = staged.output;
            let ingest_started = std::time::Instant::now();
            match backend.staged_snapshots() {
                Ok(snapshots) => {
                    feed_encoder(
                        &mut self.capture,
                        &mut self.encoder,
                        &mut self.live,
                        &self.manifest,
                        sim_tick,
                        snapshots,
                        &output,
                    );
                    reliable.extend(self.encoder.take_topology_messages());
                }
                Err(error) => {
                    tracing::error!(%error, "city staged snapshot flush failed");
                }
            }
            backend.record_host_timings(
                staged.post_step_ms,
                staged.snapshot_ms,
                ingest_started.elapsed().as_secs_f32() * 1000.0,
            );
        }
        if let Some(live) = self.live.as_mut() {
            reliable.append(&mut live.staged_reliable);
        }
        if self.live.is_none() {
            if let Some(baselines) = self.encoder.maybe_emit_baseline(sim_tick) {
                reliable.extend(baselines);
            }
        }
        if sim_tick % TOPO_HASH_INTERVAL_TICKS == 0 {
            reliable.push(self.encoder.topology_hash_message());
        }
        self.last_encode_ms += started.elapsed().as_secs_f32() * 1000.0;
        reliable
    }

    /// A bootstrap scoped to the named structures — the targeted repair a
    /// topology-hash mismatch drives.
    pub fn structure_bootstrap(&self, sim_tick: u32, structures: &[u32]) -> Vec<u8> {
        self.encoder.structure_bootstrap_message(sim_tick, structures)
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
        let mut bytes = 0u64;
        let mut records = 0u64;
        for packet in &packets {
            bytes += packet.len() as u64;
            records += u64::from(vibe_land_destruction::wire::datagram_record_count(packet));
        }
        self.sent_bytes += bytes;
        self.sent_records += records;
        self.total_sent_bytes += bytes;
        self.total_sent_records += records;
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
        // Order must match PHASE_NAMES.
        self.tick_window.phases.push([
            stats.stress_solve_ms,
            stats.begin_ms,
            stats.solve_ms,
            stats.end_ms,
            stats.readback_ms,
            stats.events_ms,
            stats.filters_ms,
            stats.ccd_ms,
            stats.support_loads_ms,
            stats.shape_readback_ms,
            stats.slot_dispatch_ms,
            stats.bond_sample_ms,
            stats.gpu_stress_solve_ms,
            stats.blast_contact_processing_ms,
            stats.blast_gravity_ms,
            stats.blast_stress_solve_cpu_ms,
            stats.blast_fracture_topology_ms,
            stats.blast_mapping_validation_ms,
            // Traced, not assumed: validateMappings() has three callers --
            // initialisation, the crush-drain path, and fracture()'s return.
            // Crush is inert (no material sets crushCapPressure > 0), so in
            // production the validation delta comes only from fracture() and is
            // always contained by the fracture delta. The clamp is defensive:
            // if crush is ever enabled, the crush-drain caller would make this
            // go negative rather than merely wrong.
            (stats.blast_fracture_topology_ms - stats.blast_mapping_validation_ms).max(0.0),
            stats.blast_fracture_generate_ms,
            stats.blast_fracture_prep_ms,
            stats.blast_fracture_apply_ms,
            stats.blast_fracture_scene_ms,
            stats.blast_fracture_rebuild_ms,
            stats.settle_ms,
        ]);
        if let Some(live) = &self.live {
            self.tick_window
                .span_encode_ms
                .push(live.last_span_encode_ms);
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
            // The stage's fragment bodies are scene-owned and not in the public
            // actor list; the snapshot stream is the observation channel.
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(_) => Vec::new(),
        }
    }

    /// This tick's generic bridge spans (see NamedSpan); empty off physx.
    pub fn extra_spans(&self) -> Vec<vibe_land_destruction::types::NamedSpan> {
        match &self.backend {
            #[cfg(feature = "destruction")]
            CityBackend::Physx(backend) => backend.extra_spans().to_vec(),
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(backend) => backend.extra_spans().to_vec(),
            _ => Vec::new(),
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
            // The stage measures its own work, so this forwards rather than
            // reconstructing. Phases that do not exist on this backend stay at
            // their defaults; `native_*` spans carry what it can actually see.
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(backend) => backend.stats(),
        }
    }

    /// Override the freeze policy the environment configured at open.
    ///
    /// For benches that need to run both sides of the freeze A/B in one
    /// process, where an environment variable would make the result depend on
    /// which test ran first.
    #[cfg(feature = "destruction")]
    pub fn set_freeze_config(&mut self, config: vibe_land_destruction::freeze::FreezeConfig) {
        if let CityBackend::Physx(backend) = &mut self.backend {
            backend.set_freeze_config(config);
        }
    }

    pub fn encoder_stats(&self) -> vibe_land_destruction::encoder::EncoderStats {
        self.encoder.stats()
    }

    /// Cumulative (records, bytes) sent on the pose stream since the match
    /// opened; never drained.
    pub fn stream_totals(&self) -> (u64, u64) {
        (self.total_sent_records, self.total_sent_bytes)
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
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(backend) => backend.is_degraded(),
        }
    }

    /// The stage has stopped producing frames and will not restart itself.
    ///
    /// Only the native backend can be in this state; see
    /// `NativeCityDestruction::needs_rebuild`. The caller's answer is a reset,
    /// which is the same repair a player would have asked for if they could
    /// have seen what was wrong.
    /// Fire rounds at the support chunks under a point, to bring a building down.
    ///
    /// The engine has no way to break a bond on command -- `PxDestructionScene`
    /// exposes configure, clear, a device view and a status, and nothing else;
    /// bonds break from real contact impulses or not at all. So "demolish this
    /// building" has to be spelled as impulses, and this spells it the way a
    /// player does: at the footing, from outside, several at once.
    ///
    /// It exists because the flicker people report happens during a whole
    /// building's collapse, and driving that through the browser is neither
    /// repeatable nor quick -- the shots wander with the spawn point and the
    /// same sixty rounds break anywhere between 900 and 7,700 bonds. Given a
    /// point and a radius this hits the same chunks every time.
    ///
    /// Returns how many rounds it fired.
    /// The tallest place in the city, as world XZ.
    ///
    /// "Knock over a tall building" needs one, and the scene is authored as a
    /// single structure, so a building is not a thing the manifest names -- it
    /// is a column of chunks that happens to be tall. This bins chunks into
    /// 8 m cells and returns the centre of whichever has the greatest height
    /// extent.
    /// The tallest 8 m footprint in the scene, for aiming a scripted collapse.
    ///
    /// Delegates: the ranking and its tie-break live in one place, because the
    /// first version of this ranked over a HashMap and picked a different
    /// building on every process start.
    pub fn tallest_footprint(&self) -> Option<([f32; 2], f32)> {
        let (_, manifest, _) = manifest_asset()?;
        vibe_land_destruction::demolition::tallest_footprint(&manifest)
    }

    /// Queue rounds at the support chunks under a point, optionally as a wedge.
    ///
    /// `wedge_deg` cuts only the chunks within that half-angle of `heading_deg`
    /// as seen from the centre, and ramps the height limit across the wedge, so
    /// the footing is taken out asymmetrically and the building goes over
    /// sideways instead of dropping straight down. `jitter` drops that fraction
    /// of the targets at random, because a clean cut breaks a building into two
    /// rigid pieces and a real collapse is hundreds of fractures -- which is
    /// the regime the artefacts being chased live in.
    ///
    /// Targets are QUEUED, not fired: `drain_demolition` releases a few per
    /// tick so the structure fails progressively.
    #[allow(clippy::too_many_arguments)]
    pub fn demolish_supports(
        &mut self,
        centre: [f32; 2],
        radius_m: f32,
        below_y: f32,
        max_rounds: usize,
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] _world: Option<()>,
    ) -> usize {
        #[cfg(feature = "native-destruction")]
        {
            let CityBackend::Native(backend) = &mut self.backend else {
                return 0;
            };
            let Some(world) = world else { return 0 };
            let Some((_, manifest, _)) = manifest_asset() else {
                return 0;
            };
            // Targets are the chunks themselves, so the round is spawned just
            // outside one and driven through it. Sorted by height so the lowest
            // supports go first: taking a column out from the bottom is what
            // drops a building, and taking it out from the middle is not.
            let _ = world;
            // One implementation of the attack shape, shared with the offline
            // recorder's --demolish. They were two copies, and the copies had
            // already drifted; a fixture that does not reproduce what a player
            // triggers is worth nothing.
            let plan = vibe_land_destruction::demolition::DemolitionPlan {
                centre,
                radius_m,
                below_y,
                heading_deg: self.demolition_heading_deg,
                wedge_deg: self.demolition_wedge_deg,
                jitter: self.demolition_jitter,
                max_rounds,
                seed: self.demolition_seed,
            };
            let targets = vibe_land_destruction::demolition::wedge_targets(&manifest, &plan);
            // Advance the seed so a second request on the same building cuts
            // somewhere else rather than repeating the identical pattern.
            self.demolition_seed = self.demolition_seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let queued = targets.len();
            self.demolition_centre = centre;
            self.pending_demolition.extend(targets);
            return queued;
        }
        #[cfg(not(feature = "native-destruction"))]
        {
            let _ = (centre, radius_m, below_y, max_rounds);
            0
        }
    }

    /// Release a few queued demolition rounds. Called once per tick.
    ///
    /// Progressive on purpose. Firing every round in one tick cuts a building
    /// cleanly in half and it falls as two rigid pieces; a real collapse is
    /// hundreds of fractures propagating, which is the regime the visual
    /// artefacts live in, and a clean cut does not reproduce them.
    pub fn drain_demolition(
        &mut self,
        per_tick: usize,
        #[cfg(feature = "physx-city")] world: Option<&mut World>,
        #[cfg(not(feature = "physx-city"))] _world: Option<()>,
    ) -> usize {
        #[cfg(feature = "native-destruction")]
        {
            if self.pending_demolition.is_empty() {
                return 0;
            }
            let CityBackend::Native(backend) = &mut self.backend else {
                self.pending_demolition.clear();
                return 0;
            };
            let Some(world) = world else { return 0 };
            let centre = self.demolition_centre;
            let take = per_tick.min(self.pending_demolition.len());
            let mut fired = 0usize;
            for at in self.pending_demolition.drain(..take).collect::<Vec<_>>() {
                let (dx, dz) = (at[0] - centre[0], at[2] - centre[1]);
                let len = (dx * dx + dz * dz).sqrt().max(0.001);
                let direction = [-dx / len, 0.0, -dz / len];
                let spawn = [at[0] + direction[0] * -1.2, at[1], at[2] + direction[2] * -1.2];
                if backend
                    .fire_round(world, spawn, direction, city_round_momentum_ns())
                    .is_ok()
                {
                    fired += 1;
                }
            }
            return fired;
        }
        #[cfg(not(feature = "native-destruction"))]
        {
            let _ = per_tick;
            0
        }
    }

    /// Wedge shape and randomness for the next `demolish_supports`.
    pub fn set_demolition_shape(&mut self, heading_deg: f32, wedge_deg: f32, jitter: f32) {
        self.demolition_heading_deg = heading_deg;
        self.demolition_wedge_deg = wedge_deg;
        self.demolition_jitter = jitter.clamp(0.0, 0.95);
    }

    pub fn needs_rebuild(&self) -> bool {
        match &self.backend {
            #[cfg(feature = "native-destruction")]
            CityBackend::Native(backend) => backend.needs_rebuild(),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A city on Rapier has no colliders: shots, meteors and walls silently
    /// do nothing. It must be refused, not served.
    #[test]
    fn a_city_without_physx_is_refused_unless_synthetic_is_asked_for() {
        use vibe_netcode::physics_backend::PhysicsBackendKind::{PhysxGpu, Rapier};
        let rapier = unavailable_reason(Rapier, false, true).expect("rapier refused");
        assert!(rapier.contains("VIBE_PHYSICS_BACKEND=physx_gpu"), "{rapier}");
        assert!(rapier.contains("rapier"), "{rapier}");
        let unbuilt = unavailable_reason(PhysxGpu, false, false).expect("no city build refused");
        assert!(unbuilt.contains("VIBE_CITY_SYNTHETIC=1"), "{unbuilt}");
        assert_eq!(unavailable_reason(PhysxGpu, false, true), None);
        assert_eq!(unavailable_reason(Rapier, true, true), None);
        assert_eq!(unavailable_reason(Rapier, true, false), None);
    }

    /// Opening the city with no PhysX world fails instead of falling back to
    /// the synthetic backend.
    #[test]
    fn opening_a_city_without_a_physx_world_fails() {
        if prefer_synthetic() {
            return;
        }
        let error = CityRuntime::open(60, None).err().expect("open without a world fails");
        assert!(error.to_string().contains("VIBE_CITY_SYNTHETIC=1"), "{error}");
    }

    /// A sphere denser than any element is not a physics simulation.
    ///
    /// The ball's mass and radius used to be independent settings, and the
    /// shipped pair described 94,167 kg/m^3.
    #[test]
    fn the_cannonball_is_made_of_something_that_exists() {
        let radius = city_ball_radius_m();
        let mass = city_ball_mass_kg();
        let volume = 4.0 / 3.0 * std::f32::consts::PI * radius.powi(3);
        let density = mass / volume;
        assert!(
            (density - city_ball_density_kg_m3()).abs() < 1.0,
            "radius {radius} m and mass {mass} kg give {density} kg/m^3, not steel"
        );
        // Osmium, the densest element. Nothing in a city is denser.
        assert!(density < 22_590.0, "density {density} kg/m^3 exceeds osmium");
    }

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
        assert_eq!(
            city.wire_version(),
            vibe_land_destruction::wire::CITY_WIRE_V3
        );
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
        assert_eq!(
            city.wire_version(),
            vibe_land_destruction::wire::CITY_WIRE_VERSION
        );
        assert!(city.live.is_none(), "v2 must not gain a v3 encoder");
    }
}
