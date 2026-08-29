//! Solver configuration shared by the match server and offline tools.

use vibe_netcode::destruction_backend::{StressMaterial, StressSolverSettings};

use crate::scene_pack::StressLimits;

/// The solver configuration the city runs.
///
/// Split out of `CityRuntime::physx` so anything driving `CityDestruction`
/// directly -- the trace recorder -- gets the same tuning the match server
/// uses instead of a second copy that drifts. `pack_materials` is the scene
/// pack's own material table; empty falls back to reference concrete.
/// The sensitivity dial on authored stress limits; 1.0 means "the concrete the
/// pack claims to be made of".
///
/// Read from one place so every backend is configured identically -- the core
/// path and the old path have to agree on this or a comparison between them is
/// measuring the dial rather than the pipeline.
pub fn stress_limit_scale() -> f32 {
    std::env::var("VIBE_CITY_STRESS_LIMIT_SCALE")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(1.0)
}

/// Debris velocity damping, per second.
///
/// Zero by default, and that is the physical answer: damping is air drag on a
/// body moving through empty space, and a concrete slab the size of a washing
/// machine does not meaningfully feel it. The shipped 0.25 capped debris
/// terminal velocity at 39 m/s and slowed every fall by roughly 20% -- a
/// velocity sink with no source, standing in for the energy loss that should
/// happen when the slab actually *hits* something.
///
/// Energy loss on impact is restitution and friction on the contact material,
/// not damping. See `VIBE_WORLD_RESTITUTION` / `VIBE_WORLD_FRICTION`.
///
/// Override with VIBE_CITY_DEBRIS_LINEAR_DAMPING / _ANGULAR_DAMPING.
pub fn debris_damping() -> (f32, f32) {
    let read = |name: &str| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .filter(|v| *v >= 0.0)
            .unwrap_or(0.0)
    };
    (
        read("VIBE_CITY_DEBRIS_LINEAR_DAMPING"),
        read("VIBE_CITY_DEBRIS_ANGULAR_DAMPING"),
    )
}

pub fn stress_settings(pack_materials: &[StressLimits]) -> StressSolverSettings {
    // ExtStressPhysX takes absolute stress limits (Pa-scale). The synthetic
    // defaults (0.008/0.01) are for the unitless Rapier path before
    // materialScale — using them here lets gravity shatter the city on
    // spawn. Take the band the scene pack was calibrated against, falling
    // back to the reference concrete numbers. VIBE_CITY_STRESS_LIMIT_SCALE
    // stays available as a sensitivity dial; 1.0 means "the concrete the
    // pack claims to be made of".
    let scale = stress_limit_scale();
    let from_pack = !pack_materials.is_empty();
    // The whole table scales together. Scaling only the first entry would
    // silently change the RATIO between frame, slab and cladding -- the
    // very thing the pack authors -- so the dial stays a uniform
    // sensitivity control rather than a shape-changing one.
    let materials: Vec<StressMaterial> = if from_pack {
        pack_materials
            .iter()
            .map(|l| StressMaterial {
                compression_elastic_mpa: l.compression_elastic * scale,
                compression_fatal_mpa: l.compression_fatal * scale,
                tension_elastic_mpa: l.tension_elastic * scale,
                tension_fatal_mpa: l.tension_fatal * scale,
                shear_elastic_mpa: l.shear_elastic * scale,
                shear_fatal_mpa: l.shear_fatal * scale,
                // Deliberately NOT multiplied by the strength scale: modulus
                // is stiffness, and scaling it would change how load is
                // SHARED, not how much it takes to break -- a different and
                // unwanted knob.
                elastic_modulus_pa: l.elastic_modulus,
            })
            .collect()
    } else {
        vec![StressMaterial {
            compression_elastic_mpa: 12e6 * scale,
            compression_fatal_mpa: 30e6 * scale,
            tension_elastic_mpa: 1.2e6 * scale,
            tension_fatal_mpa: 3e6 * scale,
            shear_elastic_mpa: 1.6e6 * scale,
            shear_fatal_mpa: 4e6 * scale,
            elastic_modulus_pa: 30.0e9,
        }]
    };
    let _ = from_pack;
    let mut settings = StressSolverSettings::default();
    settings.materials = materials;
    // City towers have ~150–200 chunks; the synthetic default of 48
    // truncates island promotions mid-collapse.
    // Iterations are not a quality dial. Below convergence the solver reports
    // a stress that is simply wrong, and wrong in the flattering direction --
    // a structure looks sound because the sum stopped early.
    //
    // Measured on 432 Park (48,763 bonds), peak bond utilisation after three
    // seconds of gravity:
    //
    //     4 iterations   0.89       32 iterations   2.98
    //     8 iterations   1.14       64 iterations   2.99
    //    16 iterations   2.62
    //
    // The answer converges at 32; 64 agrees to within 0.3%. At the old default
    // of 8 that tower reported 1.14 against a true 2.98, understating what it
    // carries by a factor of 2.6 -- which is why buildings kept looking stable
    // while sitting at three times their limit.
    //
    // The cost is not the 3x it looks like, because iterations are only paid
    // while a structure is MOVING. Ten seconds of the parking garage costs
    // 1.48 s at 8 and 1.24 s at 32 -- flat, because it settles in 1.2 s and
    // the settled-island skip then makes iteration count irrelevant. Petronas
    // costs 1.8x more because it never settles, which is it telling us it is
    // failing rather than the solver being slow.
    //
    // So: solve properly, and let settling -- not truncation -- be what makes
    // it cheap.
    settings.max_solver_iterations_per_frame = std::env::var("VIBE_CITY_SOLVER_ITERATIONS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(32);
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
        // eprintln rather than tracing: this crate stays dependency-light so the
        // core builds for wasm and CI without a log backend. The warning still
        // has to be loud -- at the cap the adapter drops every further fracture
        // command with no telemetry.
        eprintln!(
            "warning: VIBE_CITY_MAX_BODIES={} set: structures at the cap silently \
             stop fracturing (adapter drops fracture commands with no telemetry)",
            settings.maximum_bodies
        );
    }
    // Same class of knob: caps how many bonds may break per actor per tick
    // (upstream default 0 = unlimited). At 32 a sustained beam visibly
    // stalled large fractures; the per-tick cost it guarded against is now
    // covered by the parallel + CUDA solve.
    settings.maximum_fractures_per_actor_per_tick = 0;
    let (linear, angular) = debris_damping();
    settings.linear_damping = linear;
    settings.angular_damping = angular;
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
    // Spin is the only load a free island generates for itself: gravity
    // reaches it as a uniform per-node acceleration, which is a rigid
    // translation and so leaves every bond unstressed. On by default;
    // VIBE_CITY_CENTRIFUGAL=0 disables for comparison.
    settings.apply_centrifugal = std::env::var("VIBE_CITY_CENTRIFUGAL")
        .map(|value| value != "0")
        .unwrap_or(true);
    settings
}

/// Gravity the destructible city runs under, m/s^2.
///
/// Delegates to the movement config rather than restating a number, which is
/// the whole point: this was a hardcoded -9.81 and the world had been raised to
/// -20. Everything structural measured against it was measured at half the load
/// production applies. Anything production decides, this must CALL rather than
/// copy -- the same rule the bench learned when it fed 9.81 into a 20 m/s^2
/// PhysX scene, a combination that never runs.
pub fn city_gravity() -> [f32; 3] {
    vibe_netcode::movement::default_world_gravity()
}

/// What one shot does to a structure.
///
/// The match server, the trace recorder and the structural rig all fire "a
/// shot", and until this existed each carried its own copy of the numbers --
/// so a test could assert a building survived a hit that the server no longer
/// fired. The profile is the weapon; the three callers only choose where to
/// point it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShotProfile {
    /// Blast stress contact magnitude, N-s. This is what breaks bonds: it is
    /// queued as a contact impulse, the same channel a real collision uses.
    pub stress_impulse: f32,
    /// Rigid-body push on debris, as a velocity change in m/s at the centre,
    /// falling off quadratically.
    pub push_speed: f32,
    pub blast_radius_m: f32,
    /// Slightly larger than the stress radius so post-fracture debris near the
    /// crater still gets the shove after kinematic -> dynamic promotion.
    pub push_radius_m: f32,
    /// How far past the raycast surface point to seat the blast centre, so the
    /// radius covers material instead of straddling the face.
    pub blast_depth_m: f32,
    /// Hitscan range for city damage.
    pub max_distance_m: f32,
}

impl ShotProfile {
    /// Matched to the 2.5 m radius below, and to the AUTHORED buildings.
    ///
    /// Upstream retuned this to 4.0e5 against a 0.4 m radius, calibrated on the
    /// fractured-* scenes. Measured against the authored packs those values do
    /// nothing at all -- a shot at a timber house facade broke zero bonds, and
    /// so did every combination tried between them. Those scenes are fractured
    /// far finer, so a 0.4 m sphere still contains chunks; an authored house
    /// wall is a handful of half-metre pieces and the same sphere reaches
    /// almost nothing.
    ///
    /// The tuning therefore belongs to the CONTENT, not to the weapon, which
    /// is an argument for it living in this profile rather than as constants
    /// in the server. Set VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e5 and
    /// VIBE_CITY_SHOT_BLAST_RADIUS=0.4 to get upstream's values back for the
    /// fractured-* scenes.
    pub const DEFAULT_STRESS_IMPULSE: f32 = 1.2e7;
    pub const DEFAULT_PUSH_SPEED: f32 = 12.0;

    /// The city's shot, including its env overrides.
    ///
    /// Retuned from artillery to rifle scale, which is what the weapon
    /// actually is. 2.5 m of blast radius is an artillery footprint -- a single
    /// burst removed most of a building because every round drove load into
    /// every bond within a five-metre diameter. A rifle round against concrete
    /// spalls a crater measured in centimetres, and this gun is full-auto, so
    /// the destruction budget should come from many small precise hits rather
    /// than one enormous one.
    ///
    /// The stress impulse falls with it: at 0.4 m the old 1.2e7 would
    /// concentrate roughly forty times the load density into the bonds it does
    /// reach.
    pub fn city() -> Self {
        let env_f32 = |name: &str, fallback: f32| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.parse::<f32>().ok())
                .filter(|value| *value > 0.0)
                .unwrap_or(fallback)
        };
        Self {
            stress_impulse: env_f32(
                "VIBE_CITY_SHOT_STRESS_IMPULSE",
                Self::DEFAULT_STRESS_IMPULSE,
            ),
            // A velocity change rather than an impulse: an impulse divides by
            // mass, so a blast tuned to nudge a 5 t slab handed a 5 kg fragment
            // 4000 m/s. A bounded kick speed is a property of the weapon;
            // everything past it is unmodified physics.
            push_speed: env_f32("VIBE_CITY_SHOT_PUSH_SPEED", Self::DEFAULT_PUSH_SPEED),
            blast_radius_m: env_f32("VIBE_CITY_SHOT_BLAST_RADIUS", 2.5),
            push_radius_m: env_f32("VIBE_CITY_SHOT_PUSH_RADIUS", 4.0),
            // Derived from the radius rather than fixed, which is what the
            // server does: seat the centre a fraction of the radius past the
            // surface so the blast covers material instead of straddling the
            // face. Fixed at 0.5 against a 0.4 m radius it would sit entirely
            // behind the crater it is supposed to make.
            blast_depth_m: env_f32(
                "VIBE_CITY_SHOT_BLAST_DEPTH",
                env_f32("VIBE_CITY_SHOT_BLAST_RADIUS", 2.5) * 0.2,
            ),
            max_distance_m: 400.0,
        }
    }
}

impl Default for ShotProfile {
    fn default() -> Self {
        Self::city()
    }
}
