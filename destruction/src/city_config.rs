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
        }]
    };
    let _ = from_pack;
    let mut settings = StressSolverSettings::default();
    settings.materials = materials;
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
