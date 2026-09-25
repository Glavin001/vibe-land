//! `/city` destruction driven by PhysX's own GPU destruction stage.
//!
//! The other two backends drive a stress solver from the application: they
//! inject loads, run a solve, read verdicts back, apply fracture commands and
//! edit the scene. This one does none of that. The stage lives inside
//! `PxScene::simulate()`, where it assembles loads from the solver's own
//! contact impulses, evaluates the material model, splits connectivity, creates
//! the fragment bodies and re-runs one corrected rigid pass -- all before
//! `fetchResults()` returns.
//!
//! What is left for an application is genuinely small: author the asset once,
//! then each tick read the committed delta and hand it to the encoder. This
//! module is therefore mostly translation, and deliberately so -- the previous
//! attempt at this port kept the application-side machinery (freezing, resim,
//! support tracking) alive next to an engine that had taken over the same jobs.
//!
//! Three things the other backends do are *absent* here rather than disabled:
//! there is no force injection (the stage takes loads only from real contacts,
//! so a shot is a real body), no artificial freezing (sleep is the settle
//! signal: the engine's own, plus the bridge's island sleep for rubble that
//! has provably stopped going anywhere -- `sleep_resting_islands` in
//! physx-bridge/src/native_observation.cc), and no resimulation (the engine
//! owns correction).

use std::collections::HashMap;
use std::sync::Arc;

use vibe_land_physx_bridge::{NativeConfig, NativeStatus, RoundDesc, Vec3, World};
use vibe_netcode::destruction_backend::{
    DestructionStats, DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
    ShapeMigration, StressSolverSettings,
};

use crate::encoder::BodySnapshotInput;
use crate::ground_watch::{GroundVerdict, GroundWatch};
use crate::ids;
use crate::manifest::DestructionManifest;
use crate::types::NamedSpan;
use crate::bridge_authoring::{
    authored_structure, CityDestructionError, CHUNK_COLLISION_MASK, GROUP_CHUNK,
};

/// Stress iterations per evaluation.
///
/// The same kind of knob as the Blast backends' `VIBE_CITY_SOLVER_ITERATIONS`,
/// and now with the same meaning: a cap on the iterations one tick may spend,
/// not a demand that the solve finish inside that tick. The solver keeps its
/// warm-started iterate and refines the same solve on the next tick, so a tick
/// that runs out of budget loses time, not fidelity.
///
/// It did not use to mean that. The stage failed the entire simulation step
/// when the solve had not converged by the end of the budget, which is how a
/// hard-to-solve building became a frozen, teleporting city. That check is gone
/// from the engine; see the removal of `requireNativeConvergence` in physx-2's
/// PxgDestructionRuntime.cu.
///
/// This is the single most expensive setting in the game. PhysX's own
/// instrumentation puts `GpuDestruction.cuda.stress` at 94% of the simulation
/// step, and that phase is very close to linear in the budget. Measured under
/// sustained cannonball fire at fractured-downtown, 160 shots, mean of the
/// whole server tick:
///
/// | cap | whole tick | stress | bonds broken |
/// |----:|-----------:|-------:|-------------:|
/// |  16 |    10.3 ms |  7.3 ms|        4,359 |
/// |  24 |    15.3 ms | 12.2 ms|        4,245 |
/// |  32 |    20.2 ms | 16.0 ms|        5,792 |
/// |  48 |    28.2 ms | 24.8 ms|        4,940 |
/// |  64 |    29.0 ms | 25.5 ms|        5,971 |
///
/// 16 is the default because it is the only measured point that holds 60 Hz
/// while the city is coming apart, at roughly three quarters of the
/// destruction. Bond counts are chaotic rather than monotone: a slightly
/// different force field sends the collapse somewhere else, so read the column
/// as a rough scale, not a ranking.
///
/// Two cautions before tuning this. Raising it buys destruction and spends
/// frame time roughly proportionally. Lowering it below 16 has not been
/// qualified, and the budget also decides whether a large scene starts at all:
/// on skyline-stable the very first solve must converge or the stage's resident
/// stress topology update fails with error bit 64 and never recovers. On that
/// scene 16 starts and 32 and 64 do not, which is an engine defect rather than
/// a tuning rule, so re-measure rather than reasoning from this number.
fn stress_iterations() -> u32 {
    env_u32("VIBE_CITY_NATIVE_STRESS_ITERATIONS", 16)
}

/// The SDK's own default. It used to be 1e-5, and that number is why an idle
/// city cost 25 ms a tick: the stage's settled-component skip only engages
/// once a warm-started solve converges at iteration zero, and at 1e-5 a
/// 179k-bond graph never gets there inside the iteration cap (99.7% of frames
/// unconverged), so every component was re-solved in full every tick with
/// nothing moving. Measured on bayline-proven-36, idle, same binary: 1e-5 ->
/// 25.5 ms dyn, 4 iterations a tick; 1e-3 -> 4.1 ms, 0 iterations, skipped.
/// The stress this resolves is coarser by the same ratio; the owner accepted
/// that on 2026-09-21. VIBE_CITY_NATIVE_STRESS_TOLERANCE overrides.
fn stress_tolerance() -> f32 {
    std::env::var("VIBE_CITY_NATIVE_STRESS_TOLERANCE")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(1.0e-3)
}

/// Contact-pair storage touched up front.
///
/// Sized from the scene rather than fixed: the first impact on a city that has
/// never had one otherwise pages in this storage on the simulation thread,
/// which shows up as a single unexplained spike at the moment of first contact.
fn reserved_contact_pairs(chunks: usize) -> u32 {
    let scaled = (chunks.saturating_mul(3) / 2).min(1 << 20) as u32;
    env_u32("VIBE_CITY_NATIVE_RESERVED_PAIRS", scaled)
}

/// How often the whole-graph bond verdict read runs.
///
/// It is a device read proportional to bond count, so it runs on a cadence and
/// publishes its age; the stability gates set it to 1 because they are asking a
/// question about *this* tick.
fn verdict_sample_ticks() -> u32 {
    env_u32("VIBE_CITY_NATIVE_VERDICT_SAMPLE_TICKS", 60).max(1)
}

/// Speed of a fired round, m/s. With the round's momentum fixed by the weapon,
/// speed chooses the mass: faster is lighter and travels further per tick.
fn round_speed() -> f32 {
    std::env::var("VIBE_CITY_NATIVE_ROUND_SPEED")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(20.0)
}

/// Round radius, m. Kept above the per-tick travel distance at `round_speed`
/// so a round cannot pass through a chunk between steps -- the stage does not
/// support CCD, so the geometry has to be the guarantee.
fn round_radius() -> f32 {
    std::env::var("VIBE_CITY_NATIVE_ROUND_RADIUS")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(0.4)
}

fn round_ttl_ticks() -> u32 {
    env_u32("VIBE_CITY_NATIVE_ROUND_TTL_TICKS", 6).max(1)
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
}

/// Claim the stage is stuck, once, at a chosen tick.
///
/// The failure this exists to rehearse -- a rebuilt stage that comes up at
/// frame 0 and never produces another -- has not been reproduced on demand, in
/// thirty reset cycles at production scale, with cannonballs in the scene and
/// player churn across the reset. An unreproducible fault still needs its
/// recovery path exercised, or the recovery is only a belief. So:
///
///   VIBE_CITY_NATIVE_FAULT_AT_TICK=600
///
/// makes `needs_rebuild` report true once, ten seconds in, and the server
/// should then rebuild the city, re-bootstrap its clients, and carry on being
/// destructible. Fires once per process so the rebuilt city is not immediately
/// torn down again.
fn fault_injection_due(ticks: u64) -> bool {
    static FIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(at) = std::env::var("VIBE_CITY_NATIVE_FAULT_AT_TICK")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return false;
    };
    if ticks < at || FIRED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return false;
    }
    eprintln!("[native-destruction] FAULT INJECTION: reporting the stage stuck at tick {ticks}");
    true
}

/// Half-width of the box a streamed body may occupy, metres.
///
/// Sized against what the simulation can actually produce, not against what
/// the wire can encode. The cities this serves are 130-180 m across, and a
/// chunk launched at the cannonball's 60 m/s has a ballistic range of about
/// 180 m in this world's gravity. A kilometre is five times both.
///
/// It was four kilometres first, which sounded conservative and was useless: a
/// body at +4 km and the same body at -4 km are each inside the bound, and the
/// eight-kilometre step between them is drawn. The bound has to be tight
/// enough that a body inside it cannot produce a visible jump.
///
/// `VIBE_CITY_WORLD_BOUND_M` moves it for a scene that needs more room.
fn world_bound_m() -> f32 {
    std::env::var("VIBE_CITY_WORLD_BOUND_M")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(1000.0)
}

/// Snapshot flags the bridge sets on a sleep or wake edge.
const NATIVE_FLAG_SETTLED: u32 = 1;
const NATIVE_FLAG_WOKE: u32 = 2;

/// Events one tick committed, counted as `post_step` takes them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeTickCounts {
    /// Bond-broken events.
    pub bonds_broken: u32,
    /// Chunks that moved to another body.
    pub chunks_migrated: u32,
    /// New bodies (island promotions). A tick with any is a split tick.
    pub bodies_promoted: u32,
}

pub struct NativeCityDestruction {
    manifest: Arc<DestructionManifest>,
    encoder_input: Vec<BodySnapshotInput>,
    stats: DestructionStats,
    extra_spans: Vec<NamedSpan>,
    ticks: u64,
    /// Set when the engine reports that the scene cannot continue. The city is
    /// frozen from that point; it is reported rather than papered over.
    degraded: bool,
    last_status: NativeStatus,
    /// What the last `post_step` committed; see [`NativeTickCounts`].
    tick_counts: NativeTickCounts,
    /// Wakes staged by shots between ticks, drained into the next output.
    pending_wakes: Vec<(u32, u32)>,
    /// Cumulative, for the stats shape. The stage reports per-tick deltas.
    migrations_total: u64,
    resettled_wakes: u64,
    /// Incomplete steps already logged. Bounded so a persistent fault cannot
    /// drown the log; the count itself stays exact in the spans.
    error_frames_logged: u32,
    /// Bodies refused for being outside the world, cumulative. Should be 0.
    bodies_outside_world: u64,
    /// Where each live body was last seen inside the world, and when it first
    /// appeared. The point is the AGE at the moment a body escapes: the
    /// standing hypothesis is that fragments are created overlapping something
    /// and depenetration throws them, which predicts escapes in the first tick
    /// or two of a body's life. If they are instead old bodies, the cause is
    /// somewhere else entirely and the hypothesis is dead.
    tracked: HashMap<u32, TrackedBody>,
    /// First escape of each of the first few bodies to leave, with the state
    /// they left from. Bounded: this is evidence, not a log.
    escapes: Vec<EscapeSample>,
    /// This tick's awake bodies, by chunk count and by speed. Published as
    /// spans because "6,289 awake, none sleeping, nothing breaking" says
    /// nothing about WHICH bodies those are: a carpet of single chunks that
    /// jitter, or a few hundred large islands whose bond graphs the stress
    /// solve re-runs every tick. The two have different fixes.
    awake_by_nodes: [u32; 5],
    awake_by_speed: [u32; 5],
    awake_by_spin: [u32; 5],
    awake_nodes_total: u64,
    /// Distinct bodies that have escaped, cumulative.
    escaped_bodies: u64,
    /// Sum and worst age-at-escape, in ticks.
    escape_age_total: u64,
    escape_age_min: u64,
    escape_age_max: u64,
    /// Bodies whose speed jumped further in one tick than any contact could
    /// explain, cumulative, and the worst such jump seen.
    ///
    /// This is the fault caught at its source. The world-bound check only
    /// fires when a body crosses 1 km, which a live session showed happening
    /// a median of 1,237 ticks after the body was already travelling at a
    /// median of 1,275 m/s -- so it reports the consequence long after the
    /// cause. One body went from 0 m/s, at rest on the ground at
    /// (-36.8, 0.1, 64.8), to 50,298 m/s in a single tick.
    velocity_explosions: u64,
    worst_velocity_jump: f32,
    explosions: Vec<ExplosionSample>,
    /// Bodies first seen this tick, with where they appeared.
    ///
    /// The detector reports the body that FLIES, and every one of the first
    /// 41 was old, at rest, and lying within 2 m of the ground -- settled
    /// rubble, not a fresh fragment. That is the victim. Whatever ejects it
    /// has to have arrived; this is the list to look in.
    born_this_tick: Vec<(u32, [f32; 3])>,
    /// First below-ground tick of each body, and the retire floor under the
    /// ground. See `ground_watch`.
    ground: GroundWatch,
    /// Below-ground and retire lines already logged; bounded like the escapes.
    ground_logged: u32,
    /// Consecutive ticks the stage has rejected without ever reaching frame 1.
    ///
    /// The difference between "this tick did not complete" and "this stage
    /// never started" is the frame counter, and it is the difference between a
    /// hiccup and a match that is over. A stage stuck at frame 0 publishes
    /// nothing, ever: the city cannot be broken, `clearStress` refuses because
    /// of that state so it cannot be reset either, and every other reading --
    /// tick rate, player count, client agreement -- looks healthy. Twice on the
    /// live server this ran for 4,560 and 19,590 consecutive ticks before a
    /// human noticed the buildings had stopped falling down.
    stuck_at_frame_zero: u32,
}

/// Generic over the FFI vector type, which is private to the bridge crate.
fn speed_of(x: f32, y: f32, z: f32) -> f32 {
    (x * x + y * y + z * z).sqrt()
}

/// One escaped body, reported once.
///
/// eprintln rather than a logging macro: this crate is deliberately free of a
/// logging dependency, and the server captures the destruction runtime's
/// stderr anyway. Bounded by the caller to 32 bodies, so a scene that throws
/// everything cannot flood the log -- which it has done before, at 968,102
/// copies of one line.
#[allow(clippy::too_many_arguments)]
fn log_escape(
    entity: u32,
    age_ticks: u64,
    from: [f32; 3],
    from_speed: f32,
    to: [f32; 3],
    to_speed: f32,
) {
    eprintln!(
        "[destruction] body {entity:#x} left the world at age {age_ticks} ticks: \
         from ({:.1}, {:.1}, {:.1}) at {from_speed:.0} m/s \
         to ({:.0}, {:.0}, {:.0}) at {to_speed:.0} m/s",
        from[0], from[1], from[2], to[0], to[1], to[2]
    );
}

/// Last known good state of a live body, for escape forensics.
#[derive(Clone, Copy, Debug)]
struct TrackedBody {
    first_tick: u64,
    last_tick: u64,
    position: [f32; 3],
    speed: f32,
    /// Last tick's linear velocity: with this tick's, the vertical
    /// acceleration says whether the body still had support.
    velocity: [f32; 3],
}

/// The first tick a body's centre was through the ground, logged once per body
/// and bounded by the caller. What distinguishes the candidate causes: a body
/// that was resting (vertical velocity ~0 the tick before) and is now
/// accelerating at gravity lost its support in place; one that arrived fast
/// tunnelled; one that is young was created inside the ground. The stage's own
/// account of the tick (a corrected pass, bonds broken) goes with it.
#[allow(clippy::too_many_arguments)]
fn log_below_ground(
    entity: u32,
    age_ticks: Option<u64>,
    position: [f32; 3],
    velocity: [f32; 3],
    previous: Option<([f32; 3], [f32; 3])>,
    node_count: u32,
    ground_y: f32,
    status: &NativeStatus,
) {
    let (from, from_velocity) = match previous {
        Some((p, v)) => (
            format!("({:.2}, {:.2}, {:.2})", p[0], p[1], p[2]),
            format!("({:.2}, {:.2}, {:.2})", v[0], v[1], v[2]),
        ),
        None => ("unseen".to_string(), "unseen".to_string()),
    };
    let support = match previous {
        Some((_, v)) => {
            // One tick of gravity is 9.81/60 = 0.164 m/s.
            let dvy = velocity[1] - v[1];
            if v[1].abs() < 0.05 && dvy < -0.12 {
                "lost this tick (was at rest, now in free fall)"
            } else if dvy < -0.12 {
                "none (accelerating at gravity)"
            } else {
                "still pushing back"
            }
        }
        None => "unknown (first tick seen)",
    };
    eprintln!(
        "[destruction] body {entity:#x} went through the ground (y {ground_y:.1}) at age {age} ticks: \
         at ({:.2}, {:.2}, {:.2}) moving ({:.2}, {:.2}, {:.2}); the tick before at {from} moving \
         {from_velocity}; support {support}; {node_count} chunk(s); stage frame {} corrected passes {} \
         broken bonds {} contacts {}",
        position[0],
        position[1],
        position[2],
        velocity[0],
        velocity[1],
        velocity[2],
        status.frame,
        status.correction_passes,
        status.broken_bonds,
        status.normal_contacts,
        age = age_ticks.map_or("?".to_string(), |a| a.to_string()),
    );
}

/// The stage's own status on the tick a body was ejected.
fn log_explosion_stage(status: &NativeStatus) {
    eprintln!(
        "[destruction]   stage frame {} error {} converged {} iterations {} \
         correctionPasses {} stressPasses {} brokenBonds {} postCorrectionBroken {} \
         crushed {} clusters {} stressIslands {} contacts {}",
        status.frame,
        status.error,
        status.converged,
        status.iterations,
        status.correction_passes,
        status.stress_passes,
        status.broken_bonds,
        status.post_correction_broken_bonds,
        status.crushed_chunks,
        status.cluster_count,
        status.stress_island_count,
        status.normal_contacts,
    );
}

/// What appeared beside a body in the tick it was ejected.
fn log_explosion_cause(born: usize, nearest: Option<(u32, f32, [f32; 3])>) {
    match nearest {
        Some((entity, distance, at)) => eprintln!(
            "[destruction]   {born} bodies born this tick; nearest is {entity:#x} \
             at {distance:.2} m, position ({:.1}, {:.1}, {:.1})",
            at[0], at[1], at[2]
        ),
        None => eprintln!("[destruction]   {born} bodies born this tick, none near it"),
    }
}

/// One-tick speed increase beyond which the cause cannot be a collision.
///
/// A 1/60 s tick at this threshold is 15,000 m/s^2, seven hundred times the
/// scene's gravity. Nothing in a collapsing building accelerates like that.
const VELOCITY_EXPLOSION_MPS: f32 = 250.0;

/// One body's speed going somewhere physics cannot take it.
#[derive(Clone, Copy, Debug)]
struct ExplosionSample {
    entity: u32,
    age_ticks: u64,
    from: [f32; 3],
    from_speed: f32,
    to: [f32; 3],
    to_speed: f32,
}

fn log_explosion(
    entity: u32,
    age_ticks: u64,
    from: [f32; 3],
    from_speed: f32,
    to: [f32; 3],
    to_speed: f32,
) {
    eprintln!(
        "[destruction] body {entity:#x} velocity explosion at age {age_ticks} ticks: \
         ({:.1}, {:.1}, {:.1}) at {from_speed:.0} m/s -> \
         ({:.1}, {:.1}, {:.1}) at {to_speed:.0} m/s in one tick",
        from[0], from[1], from[2], to[0], to[1], to[2]
    );
}

/// One body's first departure from the world, and the state it left from.
#[derive(Clone, Copy, Debug)]
struct EscapeSample {
    entity: u32,
    age_ticks: u64,
    from: [f32; 3],
    from_speed: f32,
    to: [f32; 3],
    to_speed: f32,
}

impl NativeCityDestruction {
    /// Author every structure into the scene and configure the stage.
    ///
    /// The extra `world.step()` in here is required, not incidental: chunk
    /// shapes and bodies have no GPU identities until a step has completed, and
    /// those identities are exactly what the stage descriptor binds. It runs at
    /// match open, before the tick loop, so no gameplay tick is consumed.
    pub fn build(
        manifest: Arc<DestructionManifest>,
        world: &mut World,
        settings: StressSolverSettings,
        sim_hz: u32,
    ) -> Result<Self, CityDestructionError> {
        let _ = sim_hz;
        let ffi_settings = crate::bridge_authoring::ffi_settings(&settings);
        let material_count = ffi_settings.materials.len() as u32;
        if let Some(bad) = manifest
            .structures
            .iter()
            .flat_map(|structure| structure.bonds.iter())
            .find(|bond| bond.material >= material_count)
        {
            return Err(CityDestructionError::Bridge(format!(
                "bond material {} out of range ({material_count} materials)",
                bad.material
            )));
        }

        world
            .native_attach()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        let mut chunk_total = 0usize;
        for structure in &manifest.structures {
            let (pose, nodes, bonds) = authored_structure(&manifest, structure);
            chunk_total += nodes.len();
            world
                .native_create_destructible(
                    structure.structure_id,
                    pose,
                    &nodes,
                    &bonds,
                    ffi_settings.clone(),
                    GROUP_CHUNK,
                    CHUNK_COLLISION_MASK,
                )
                .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        }

        // The step that materialises GPU identities. Nothing observes it.
        world
            .step()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        let configured = world
            .native_configure(NativeConfig {
                max_iterations: stress_iterations(),
                tolerance: stress_tolerance(),
                warm_start: true,
                damage_rate: 2.0,
                bend_gain_max: 3.0,
                fibre_bending: true,
                reserved_contact_pairs: reserved_contact_pairs(chunk_total),
                preserve_unchanged_contact_pairs: true,
                gpu_island_repair: true,
                verdict_sample_ticks: verdict_sample_ticks(),
            })
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        eprintln!(
            "[native-destruction] structures={} chunks={} bonds={} clusters={} \
materials={} reserved_pairs={} iterations={} tolerance={:e}",
            manifest.structures.len(),
            configured.chunks,
            configured.bonds,
            configured.clusters,
            configured.materials,
            configured.reserved_pairs,
            stress_iterations(),
            stress_tolerance(),
        );

        Ok(Self {
            stats: DestructionStats {
                structures: manifest.structures.len() as u32,
                ..DestructionStats::default()
            },
            manifest,
            encoder_input: Vec::new(),
            extra_spans: Vec::new(),
            ticks: 0,
            degraded: false,
            last_status: NativeStatus::default(),
            tick_counts: NativeTickCounts::default(),
            pending_wakes: Vec::new(),
            migrations_total: 0,
            resettled_wakes: 0,
            error_frames_logged: 0,
            bodies_outside_world: 0,
            tracked: HashMap::new(),
            escapes: Vec::new(),
            awake_by_nodes: [0; 5],
            awake_by_speed: [0; 5],
            awake_by_spin: [0; 5],
            awake_nodes_total: 0,
            escaped_bodies: 0,
            escape_age_total: 0,
            escape_age_min: u64::MAX,
            escape_age_max: 0,
            velocity_explosions: 0,
            worst_velocity_jump: 0.0,
            explosions: Vec::new(),
            born_this_tick: Vec::new(),
            ground: GroundWatch::new(None, crate::ground_watch::retire_depth_m()),
            ground_logged: 0,
            stuck_at_frame_zero: 0,
        })
    }

    /// Tell the runtime where the ground is: the top of the scene's lowest
    /// static surface, or None for no ground. Bodies whose centre goes below
    /// it are logged once, and a body that falls a few metres further
    /// (`VIBE_RETIRE_FLOOR_DEPTH_M`, default 5) is retired: announced to
    /// clients as a retired island and never streamed again.
    ///
    /// The PhysX body itself is left alone. It belongs to the stage, and every
    /// way of taking a stage-owned body out of the simulation has broken the
    /// stage (see the bridge's `native_settle_ticks`). A retired body keeps
    /// falling where nothing can meet it.
    pub fn set_ground(&mut self, ground_y: Option<f32>) {
        self.ground.set_ground(ground_y, crate::ground_watch::retire_depth_m());
    }

    /// Observe the step the host just completed and produce the tick's events.
    ///
    /// Call after `fetchResults` and before the next `simulate`, exactly where
    /// the other backends run their solve.
    pub fn post_step(
        &mut self,
        world: &mut World,
        dt: f32,
    ) -> Result<DestructionTickOutput, CityDestructionError> {
        let _ = dt;
        self.ticks += 1;
        let started = std::time::Instant::now();
        self.tick_counts = NativeTickCounts::default();

        let status = world
            .native_tick()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        self.last_status = status;
        if status.degraded && !self.degraded {
            self.degraded = true;
            eprintln!(
                "[native-destruction] FATAL: the scene cannot continue (error bits \
{}); the city is frozen from here",
                status.error
            );
        }
        if status.error != 0 {
            if status.frame == 0 {
                self.stuck_at_frame_zero += 1;
            }
            // A step the engine did not complete publishes nothing, so there is
            // nothing to hand on. Reported through the spans and the log, never
            // smoothed into an empty-but-normal-looking tick.
            if self.error_frames_logged < 8 {
                self.error_frames_logged += 1;
                eprintln!(
                    "[native-destruction] step incomplete (error bits {}, frame {}); \
no observation this tick",
                    status.error, status.frame
                );
            }
            self.refresh_stats(world, started);
            return Ok(DestructionTickOutput::default());
        }
        self.stuck_at_frame_zero = 0;
        if !status.observed {
            self.refresh_stats(world, started);
            return Ok(DestructionTickOutput::default());
        }

        let broken = world
            .native_take_broken_bonds()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        let migrations = world
            .native_take_chunk_migrations()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        let islands = world
            .native_take_island_events()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        self.tick_counts = NativeTickCounts {
            bonds_broken: broken.len() as u32,
            chunks_migrated: migrations.len() as u32,
            bodies_promoted: islands.iter().filter(|event| event.kind == 0).count() as u32,
        };

        let mut batches: HashMap<u32, FractureBatch> = HashMap::new();
        let mut order: Vec<u32> = Vec::new();
        let batch = |batches: &mut HashMap<u32, FractureBatch>,
                         order: &mut Vec<u32>,
                         structure_id: u32| {
            if !batches.contains_key(&structure_id) {
                order.push(structure_id);
                batches.insert(
                    structure_id,
                    FractureBatch {
                        structure_id,
                        ..FractureBatch::default()
                    },
                );
            }
        };

        for event in &broken {
            batch(&mut batches, &mut order, event.structure_id);
            batches
                .get_mut(&event.structure_id)
                .expect("just inserted")
                .broken_bond_ids
                .push(event.bond_id);
        }
        self.migrations_total += migrations.len() as u64;
        for event in &migrations {
            batch(&mut batches, &mut order, event.structure_id);
            batches
                .get_mut(&event.structure_id)
                .expect("just inserted")
                .migrations
                .push(ShapeMigration {
                    chunk_id: event.chunk_id,
                    from_island_id: event.from_island,
                    to_island_id: event.to_island,
                });
        }
        for event in &islands {
            batch(&mut batches, &mut order, event.structure_id);
            let entry = batches
                .get_mut(&event.structure_id)
                .expect("just inserted");
            if event.kind == 0 {
                // A promotion restates the body to clients, so a body retired
                // at the floor under this id is judged afresh from here.
                self.ground
                    .forget(ids::body_entity(event.structure_id, event.island_id));
            }
            match event.kind {
                0 => entry.promoted_islands.push(IslandPromotion {
                    structure_id: event.structure_id,
                    island_id: event.island_id,
                    chunks: event.chunk_ids.clone(),
                    mass: event.mass,
                    // The bridge publishes centre-of-mass frame poses, which is
                    // the convention the wire documents: a client composes
                    // `rest_local - island_com` against this pose.
                    center_of_mass: [
                        event.position.x,
                        event.position.y,
                        event.position.z,
                    ],
                    position: [event.position.x, event.position.y, event.position.z],
                    rotation: [
                        event.rotation.x,
                        event.rotation.y,
                        event.rotation.z,
                        event.rotation.w,
                    ],
                    linear_velocity: [
                        event.linear_velocity.x,
                        event.linear_velocity.y,
                        event.linear_velocity.z,
                    ],
                    angular_velocity: [
                        event.angular_velocity.x,
                        event.angular_velocity.y,
                        event.angular_velocity.z,
                    ],
                    // Left zero deliberately. The stage does not publish a
                    // fragment inertia tensor or a split impulse, and a
                    // fabricated value is worse than an absent one. Neither
                    // field has a consumer today.
                    inertia_diagonal: [0.0; 3],
                    split_impulse: [0.0; 3],
                }),
                1 => entry.retired_island_ids.push(event.island_id),
                other => {
                    // Matched explicitly: a new event kind must be handled here
                    // rather than silently swallowed by a wildcard.
                    eprintln!("[native-destruction] unhandled island event kind {other}");
                }
            }
        }

        // Retired bodies would otherwise accumulate in `tracked` for the life
        // of the match. Swept on a cadence rather than per tick, because the
        // map is only forensics and an O(n) scan every tick to serve it would
        // be the diagnostic costing more than the fault.
        if self.ticks % 600 == 0 {
            let horizon = self.ticks.saturating_sub(600);
            self.tracked.retain(|_, body| body.last_tick >= horizon);
        }

        // Body rows, plus the settle and wake edges the stage reported.
        let snapshots = world
            .native_chunk_body_snapshots()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        self.encoder_input.clear();
        self.encoder_input.reserve(snapshots.len());
        let bound = world_bound_m();
        self.born_this_tick.clear();
        self.awake_by_nodes = [0; 5];
        self.awake_by_speed = [0; 5];
        self.awake_by_spin = [0; 5];
        self.awake_nodes_total = 0;
        let mut settled: Vec<SettleEvent> = Vec::new();
        let mut wakes: Vec<(u32, u32)> = std::mem::take(&mut self.pending_wakes);
        for snap in snapshots {
            // The anchored remnant is not an island and has no business on the
            // wire.
            //
            // It keeps island serial 0, which the client reserves for a
            // structure's static support body and draws from the manifest's
            // rest poses -- so its pose must never change. The settle and wake
            // pushes below used to run BEFORE the kinematic test a few lines
            // down, so every sleep edge of that remnant published a settle
            // record carrying the kinematic actor's centre of mass. That
            // centre wanders as the structure sheds chunks, and each record
            // teleported the client's whole anchored remnant to it.
            //
            // Measured on a single-tower capture: 393 of 400 tracked chunks
            // displaced by one identical vector within a single frame, body
            // 0x80000000, position [0,0,0] -> [2.25,0.32,0] -> [0,0,0] ->
            // [6.75,0.32,-4.67], with local offsets unchanged throughout. A
            // building stepping sideways and back, twice in a second.
            if snap.kinematic {
                continue;
            }
            // Retired at the floor: clients were told it is gone, and nothing
            // about it -- pose, settle or wake -- is news to anyone.
            if self
                .ground
                .is_retired(ids::body_entity(snap.structure_id, snap.island_id))
            {
                continue;
            }
            if snap.flags == NATIVE_FLAG_SETTLED {
                settled.push(SettleEvent {
                    structure_id: snap.structure_id,
                    island_id: snap.island_id,
                    position: [snap.position.x, snap.position.y, snap.position.z],
                    rotation: [
                        snap.rotation.x,
                        snap.rotation.y,
                        snap.rotation.z,
                        snap.rotation.w,
                    ],
                });
            } else if snap.flags == NATIVE_FLAG_WOKE {
                self.resettled_wakes += 1;
                wakes.push((snap.structure_id, snap.island_id));
            }
            // Sleeping bodies are not streamed: their settle record is the
            // client's authority until they wake. (Kinematic remnants are
            // already gone, above.)
            if snap.sleeping {
                continue;
            }
            // Through the ground: logged on the first tick, retired at the
            // floor. Checked before the world bound, which it replaces for
            // everything that leaves downwards.
            {
                let entity = ids::body_entity(snap.structure_id, snap.island_id);
                let position = [snap.position.x, snap.position.y, snap.position.z];
                let velocity = [
                    snap.linear_velocity.x,
                    snap.linear_velocity.y,
                    snap.linear_velocity.z,
                ];
                match self.ground.observe(entity, snap.position.y) {
                    GroundVerdict::Above | GroundVerdict::BelowGround { first: false } => {}
                    GroundVerdict::BelowGround { first: true } => {
                        if self.ground_logged < 32 {
                            self.ground_logged += 1;
                            let previous = self.tracked.get(&entity);
                            log_below_ground(
                                entity,
                                previous.map(|t| self.ticks.saturating_sub(t.first_tick)),
                                position,
                                velocity,
                                previous.map(|t| (t.position, t.velocity)),
                                snap.node_count,
                                self.ground.ground_y().unwrap_or(0.0),
                                &self.last_status,
                            );
                        }
                    }
                    GroundVerdict::Retire => {
                        if self.ground_logged < 64 {
                            self.ground_logged += 1;
                            eprintln!(
                                "[destruction] body {entity:#x} retired at the floor (y {:.1}): at \
                                 ({:.1}, {:.1}, {:.1}) moving ({:.1}, {:.1}, {:.1})",
                                self.ground.floor_y(),
                                position[0],
                                position[1],
                                position[2],
                                velocity[0],
                                velocity[1],
                                velocity[2],
                            );
                        }
                        self.tracked.remove(&entity);
                        batch(&mut batches, &mut order, snap.structure_id);
                        batches
                            .get_mut(&snap.structure_id)
                            .expect("just inserted")
                            .retired_island_ids
                            .push(snap.island_id);
                        continue;
                    }
                }
            }
            // A fragment that has left the world is not streamed.
            //
            // Something in the collapse throws fragments a very long way: a
            // report from a live session had a single-chunk island at
            // (-82 km, -33 km, +61 km), and a collapse here produces about six
            // hundred poses outside a four-kilometre box. Why is not
            // established -- the likeliest candidate is an unbounded
            // depenetration response where a fragment is created overlapping
            // something -- and this does not fix it.
            //
            // What it stops is the damage those bodies do to everything else.
            // A body moving at kilometres per second makes every consecutive
            // pair of its streamed poses impossible to interpolate, so the
            // client's presentation layer steps instead of blending, once per
            // sampled frame, for as long as the body exists. Refusing to stream
            // them cut a collapse's implausible-interpolation count by more
            // than an order of magnitude. They are counted, not silenced.
            let (px, py, pz) = (snap.position.x, snap.position.y, snap.position.z);
            let entity = ids::body_entity(snap.structure_id, snap.island_id);
            let escaped = !px.is_finite()
                || !py.is_finite()
                || !pz.is_finite()
                || px.abs() > bound
                || py.abs() > bound
                || pz.abs() > bound;
            if escaped {
                self.bodies_outside_world += 1;
                // Record the state it left FROM, once per body. A position
                // outside the world says nothing on its own; the previous
                // position and speed, and how old the body was, are what
                // distinguish "thrown at creation" from "drifted out".
                if let Some(previous) = self.tracked.remove(&entity) {
                    let age = self.ticks.saturating_sub(previous.first_tick);
                    self.escaped_bodies += 1;
                    self.escape_age_total += age;
                    self.escape_age_min = self.escape_age_min.min(age);
                    self.escape_age_max = self.escape_age_max.max(age);
                    if self.escapes.len() < 32 {
                        self.escapes.push(EscapeSample {
                            entity,
                            age_ticks: age,
                            from: previous.position,
                            from_speed: previous.speed,
                            to: [px, py, pz],
                            to_speed: speed_of(snap.linear_velocity.x, snap.linear_velocity.y, snap.linear_velocity.z),
                        });
                        log_escape(
                            entity,
                            age,
                            previous.position,
                            previous.speed,
                            [px, py, pz],
                            speed_of(snap.linear_velocity.x, snap.linear_velocity.y, snap.linear_velocity.z),
                        );
                    }
                }
                continue;
            }
            let speed = speed_of(
                snap.linear_velocity.x,
                snap.linear_velocity.y,
                snap.linear_velocity.z,
            );
            {
                let n = snap.node_count;
                let nb = if n <= 1 { 0 } else if n <= 4 { 1 } else if n <= 16 { 2 } else if n <= 64 { 3 } else { 4 };
                // 0.32 m/s is the 0.05 m^2/s^2 sleep threshold expressed as a
                // speed; a body under it for the wake counter's 0.4 s sleeps.
                let sb = if speed < 0.05 { 0 } else if speed < 0.32 { 1 } else if speed < 1.0 { 2 } else if speed < 5.0 { 3 } else { 4 };
                self.awake_by_nodes[nb] += 1;
                self.awake_by_speed[sb] += 1;
                let spin = speed_of(snap.angular_velocity.x, snap.angular_velocity.y, snap.angular_velocity.z);
                let wb = if spin < 0.05 { 0 } else if spin < 0.32 { 1 } else if spin < 1.0 { 2 } else if spin < 5.0 { 3 } else { 4 };
                self.awake_by_spin[wb] += 1;
                self.awake_nodes_total += u64::from(n);
            }
            match self.tracked.entry(entity) {
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    let slot = slot.get_mut();
                    // A tick is 1/60 s. Rubble hit by anything in this scene
                    // changes speed by tens of m/s, not thousands; a jump past
                    // this threshold is the solver, not the collision.
                    let jump = speed - slot.speed;
                    if jump > VELOCITY_EXPLOSION_MPS {
                        self.velocity_explosions += 1;
                        if jump > self.worst_velocity_jump {
                            self.worst_velocity_jump = jump;
                        }
                        if self.explosions.len() < 32 {
                            // Nearest body that appeared this tick. A fragment
                            // materialising inside a settled pile is the
                            // standing suspicion; this is what would show it,
                            // and equally what would rule it out.
                            let mut nearest: Option<(u32, f32, [f32; 3])> = None;
                            for (other, at) in &self.born_this_tick {
                                if *other == entity {
                                    continue;
                                }
                                let d = speed_of(
                                    at[0] - slot.position[0],
                                    at[1] - slot.position[1],
                                    at[2] - slot.position[2],
                                );
                                if nearest.is_none_or(|(_, best, _)| d < best) {
                                    nearest = Some((*other, d, *at));
                                }
                            }
                            log_explosion_cause(
                                self.born_this_tick.len(),
                                nearest,
                            );
                            // The stage's own account of the tick that did it.
                            //
                            // The victims are settled, spatially clustered,
                            // and nothing new appears within 39 m of them, so
                            // whatever ejects a whole pile at once is internal
                            // to the step rather than a body arriving. These
                            // are the levers that step has: an internal
                            // correction pass that restores and re-resolves
                            // the rigid scene, a stress solve that may not
                            // have converged, and the error bits.
                            log_explosion_stage(&self.last_status);
                            self.explosions.push(ExplosionSample {
                                entity,
                                age_ticks: self.ticks.saturating_sub(slot.first_tick),
                                from: slot.position,
                                from_speed: slot.speed,
                                to: [px, py, pz],
                                to_speed: speed,
                            });
                            log_explosion(
                                entity,
                                self.ticks.saturating_sub(slot.first_tick),
                                slot.position,
                                slot.speed,
                                [px, py, pz],
                                speed,
                            );
                        }
                    }
                    slot.position = [px, py, pz];
                    slot.speed = speed;
                    slot.velocity = [
                        snap.linear_velocity.x,
                        snap.linear_velocity.y,
                        snap.linear_velocity.z,
                    ];
                    slot.last_tick = self.ticks;
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    self.born_this_tick.push((entity, [px, py, pz]));
                    slot.insert(TrackedBody {
                        first_tick: self.ticks,
                        last_tick: self.ticks,
                        position: [px, py, pz],
                        speed,
                        velocity: [
                            snap.linear_velocity.x,
                            snap.linear_velocity.y,
                            snap.linear_velocity.z,
                        ],
                    });
                }
            }
            let mut flags = 0u8;
            if snap.flags == NATIVE_FLAG_WOKE {
                flags |= crate::types::FLAG_WAKE_EVENT;
            }
            self.encoder_input.push(BodySnapshotInput {
                body_entity: ids::body_entity(snap.structure_id, snap.island_id),
                position: [snap.position.x, snap.position.y, snap.position.z],
                rotation: [
                    snap.rotation.x,
                    snap.rotation.y,
                    snap.rotation.z,
                    snap.rotation.w,
                ],
                linear_velocity: [
                    snap.linear_velocity.x,
                    snap.linear_velocity.y,
                    snap.linear_velocity.z,
                ],
                angular_velocity: [
                    snap.angular_velocity.x,
                    snap.angular_velocity.y,
                    snap.angular_velocity.z,
                ],
                // The stage consumes contacts on the GPU and publishes no
                // per-body count. Zero here is "not reported", and the encoder
                // treats contacts as a scheduling hint rather than an input to
                // correctness.
                contacts: 0,
                flags,
            });
        }

        self.refresh_stats(world, started);

        let mut out = DestructionTickOutput {
            batches: order
                .into_iter()
                .filter_map(|id| batches.remove(&id))
                .collect(),
            settled,
            wakes,
        };
        out.batches.retain(|b| {
            !b.broken_bond_ids.is_empty()
                || !b.migrations.is_empty()
                || !b.promoted_islands.is_empty()
                || !b.retired_island_ids.is_empty()
        });
        Ok(out)
    }

    /// Deliver a shot as a physical round.
    ///
    /// The stage has no force injection: bonds break because PhysX solved a
    /// contact, so a hitscan hit becomes a real body carrying the round's
    /// momentum. It is owned by the bridge, never networked, and retires after
    /// a few ticks.
    pub fn fire_round(
        &mut self,
        world: &mut World,
        point: [f32; 3],
        direction: [f32; 3],
        momentum_ns: f32,
    ) -> Result<(), CityDestructionError> {
        world
            .native_fire_round(RoundDesc {
                position: Vec3::new(point[0], point[1], point[2]),
                direction: Vec3::new(direction[0], direction[1], direction[2]),
                momentum_ns,
                radius: round_radius(),
                speed: round_speed(),
                ttl_ticks: round_ttl_ticks(),
            })
            .map(|_| ())
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))
    }

    /// Copy the stage's own measurements into the shared stats shape.
    ///
    /// Only fields this backend can actually measure are assigned. The
    /// application-solve timings (`stress_solve_ms`, `begin/solve/end_ms`, every
    /// `blast_*`) stay at their defaults because no such phase exists here --
    /// leaving them zero is the truthful answer, and the `native_*` spans carry
    /// what there is to carry.
    fn refresh_stats(&mut self, world: &World, started: std::time::Instant) {
        let Ok(bridge) = world.native_stats() else {
            return;
        };
        let spans = world.take_destruction_spans();
        self.extra_spans = spans
            .into_iter()
            .map(|span| NamedSpan {
                name: span.name,
                value: span.value,
                kind: span.kind,
            })
            .collect();

        for (i, name) in ["1", "2_4", "5_16", "17_64", "65_plus"].iter().enumerate() {
            self.extra_spans.push(NamedSpan {
                name: format!("native_awake_nodes_{name}"),
                value: f64::from(self.awake_by_nodes[i]),
                kind: 2,
            });
        }
        for (i, name) in ["lt0.05", "lt0.32", "lt1", "lt5", "ge5"].iter().enumerate() {
            self.extra_spans.push(NamedSpan {
                name: format!("native_awake_speed_{name}"),
                value: f64::from(self.awake_by_speed[i]),
                kind: 2,
            });
        }
        for (i, name) in ["lt0.05", "lt0.32", "lt1", "lt5", "ge5"].iter().enumerate() {
            self.extra_spans.push(NamedSpan {
                name: format!("native_awake_spin_{name}"),
                value: f64::from(self.awake_by_spin[i]),
                kind: 2,
            });
        }
        self.extra_spans.push(NamedSpan {
            name: "native_awake_nodes_total".to_string(),
            value: self.awake_nodes_total as f64,
            kind: 2,
        });

        // Published so a deployment can see the runaway fragments this filters
        // out. Should read 0; anything else is a server-side fault the client
        // is being shielded from rather than one that has been fixed.
        self.extra_spans.push(NamedSpan {
            name: "native_velocity_explosions".to_string(),
            value: self.velocity_explosions as f64,
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_worst_velocity_jump_mps".to_string(),
            value: self.worst_velocity_jump as f64,
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_escaped_bodies".to_string(),
            value: self.escaped_bodies as f64,
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_escape_age_ticks_min".to_string(),
            value: if self.escape_age_min == u64::MAX {
                0.0
            } else {
                self.escape_age_min as f64
            },
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_escape_age_ticks_max".to_string(),
            value: self.escape_age_max as f64,
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_escape_age_ticks_avg".to_string(),
            value: if self.escaped_bodies == 0 {
                0.0
            } else {
                self.escape_age_total as f64 / self.escaped_bodies as f64
            },
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_escape_from_speed_max".to_string(),
            value: self
                .escapes
                .iter()
                .map(|sample| sample.from_speed as f64)
                .fold(0.0, f64::max),
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_bodies_outside_world".to_string(),
            value: self.bodies_outside_world as f64,
            kind: 2, // count
        });
        self.extra_spans.push(NamedSpan {
            name: "native_bodies_below_ground".to_string(),
            value: self.ground.below_ground_total as f64,
            kind: 2,
        });
        self.extra_spans.push(NamedSpan {
            name: "native_bodies_retired_below_floor".to_string(),
            value: self.ground.retired_total as f64,
            kind: 2,
        });
        let structures = self.manifest.structures.len() as u32;
        let total_ms = started.elapsed().as_secs_f32() * 1000.0;
        let tick_ffi_ms = self
            .extra_spans
            .iter()
            .find(|span| span.name == "native_tick_ms")
            .map(|span| span.value as f32)
            .unwrap_or(0.0);

        self.stats = DestructionStats {
            structures,
            chunk_bodies: bridge.chunk_bodies,
            awake_chunk_bodies: bridge.awake_chunk_bodies,
            sleeping_chunk_bodies: bridge.sleeping_chunk_bodies,
            broken_bonds: bridge.broken_bonds,
            overstressed_bonds: bridge.overstressed_bonds,
            bond_utilisation_max: bridge.bond_utilisation_max,
            bonds_above_half_utilisation: bridge.bonds_above_half_utilisation,
            contacts_processed: bridge.contacts_processed,
            solver_island_count: bridge.solver_island_count,
            solver_islands_skipped: bridge.solver_islands_skipped,
            gpu_stress_structures: bridge.gpu_stress_structures,
            readback_ms: bridge.readback_ms,
            events_ms: bridge.events_ms,
            tick_ffi_ms,
            post_step_total_ms: total_ms,
            post_step_ms: total_ms,
            post_step_residual_ms: (total_ms - tick_ffi_ms).max(0.0),
            chunk_migrations: self.migrations_total,
            resettled_wakes: self.resettled_wakes,
            ..DestructionStats::default()
        };
    }

    pub fn body_snapshots(&self) -> &[BodySnapshotInput] {
        &self.encoder_input
    }

    /// The host-side cost of feeding this tick's rows to the encoder. Timed by
    /// the caller because the encoder is not this backend's; recorded here so
    /// it rides the same stats row as the rest of the step and the overlay's
    /// "unattributed" bucket stops holding it (it was ~4.8 ms of an 11.3 ms
    /// step at 19k awake bodies, reported as 0.0).
    pub fn record_host_timings(&mut self, ingest_ms: f32) {
        self.stats.ingest_ms = ingest_ms;
    }

    pub fn stats(&self) -> DestructionStats {
        self.stats.clone()
    }

    pub fn extra_spans(&self) -> &[NamedSpan] {
        &self.extra_spans
    }

    pub fn is_degraded(&self) -> bool {
        self.degraded
    }

    /// True once the stage has been stuck at frame 0 long enough that it is not
    /// going to start on its own.
    ///
    /// Two seconds, because a stage that is going to produce a frame produces
    /// its first one immediately, and because the cure -- rebuilding the city
    /// and re-bootstrapping every client -- is disruptive enough that it should
    /// not fire on a transient. Why a rebuilt stage sometimes comes up this way
    /// is not established: it has not been reproduced in thirty reset cycles at
    /// production scale, mid-collapse, with cannonballs in the scene and player
    /// churn across the reset. So this does not pretend to be a fix. It is the
    /// difference between a match that recovers in a couple of seconds and one
    /// that is silently over.
    pub fn needs_rebuild(&self) -> bool {
        if fault_injection_due(self.ticks) {
            return true;
        }
        self.stuck_at_frame_zero >= 120
    }

    pub fn last_status(&self) -> NativeStatus {
        self.last_status
    }

    /// What the last `post_step` committed: zero on a tick the stage did not
    /// observe (rejected or already consumed).
    pub fn tick_counts(&self) -> NativeTickCounts {
        self.tick_counts
    }

    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    pub fn manifest(&self) -> &Arc<DestructionManifest> {
        &self.manifest
    }

    /// Per-bond stress for one structure: the surgical readout.
    ///
    /// Returned as (bond index, node0, node1, utilisation) so the structural
    /// audit can join it against the manifest without this crate re-exporting
    /// a bridge type. A snapshot of the last sampled solve; nothing is solved
    /// here.
    pub fn bond_stress_rows(
        &self,
        world: &World,
        structure_id: u32,
    ) -> Vec<(u32, u32, u32, f32)> {
        world
            .native_bond_stress_rows(structure_id)
            .map(|rows| {
                rows.into_iter()
                    .map(|r| (r.bond_index, r.node0, r.node1, r.utilisation))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whole-world GPU/CPU ownership audit. Heavy by design; for gates, not ticks.
    pub fn validate_mappings(&self, world: &World) -> bool {
        world.native_validate_mappings().unwrap_or(false)
    }

    /// Release the stage and every actor it owns, so a fresh city can be built.
    /// Release the stage and leave the scene ready to be authored again.
    ///
    /// The step is not optional and not a precaution. Releasing the authored
    /// parents and their chunk shapes does not reach the GPU broadphase until
    /// the scene next simulates, so authoring a new city first leaves it
    /// holding pairs against freed shapes. What that costs is a single illegal
    /// memory access inside GPU narrowphase, and CUDA does not forgive one:
    /// every later launch in the process fails with error 700, the stage never
    /// produces another frame, `clearStress` then refuses because of that
    /// state, and the match can be neither destroyed nor reset for as long as
    /// the process lives.
    ///
    /// Caught by driving a real collapse and resetting on top of it
    /// (`client/e2e/qa-reset-storm.mjs`), which fails in three or four cycles.
    /// It needs a big scene to show: the bridge-level cycle test does the same
    /// thing with sixteen chunks and has always passed, and so did thirty
    /// production-scale cycles that never had more than a few hundred bodies in
    /// the air. The hazard is the size of what the broadphase is holding, and
    /// `a_rebuilt_city_leaves_nothing_of_the_old_one` has stepped here since it
    /// was written, against "a crash in an earlier attempt at this port, where
    /// shapes released on reset were still referenced by the broadphase on the
    /// next build". That note was right; production simply never did it.
    ///
    /// One tick of the emptied scene is the whole cost, and only on a reset.
    pub fn clear(&mut self, world: &mut World) -> Result<(), CityDestructionError> {
        world
            .native_clear()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        world
            .step()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        Ok(())
    }
}
