//! Running a structure on the native GPU destruction stage, at the shipping
//! solver settings.
//!
//! Every solve here uses what the game runs (destruction/src/native_runtime.rs,
//! with the destructible fleet's iteration cap): 64 stress iterations per
//! tick, tolerance 1e-3, warm start, damage rate 2, fibre bending, one
//! corrected pass, and PX_DESTRUCTION_ALLOW_UNCONVERGED=1. A static solve that
//! does not converge in one tick continues from its warm start the next tick,
//! as in the game; the suite reads the bonds once the stage reports the solve
//! converged and says how many ticks that took. Nothing here raises the
//! iteration cap or loosens the tolerance.

use super::model::{Graded, Structure, V3};
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StressMaterialDesc, Vec3, World,
    WorldConfig,
};

pub const GROUP_CHUNK: u32 = 1 << 5;
pub const GROUP_PLAIN: u32 = 1 << 0;

/// Production stress settings (native_runtime.rs): the fleet's cap of 64,
/// the SDK-default tolerance 1e-3, no force tolerance.
pub const STRESS_ITERATIONS: u32 = 64;
pub const STRESS_TOLERANCE: f32 = 1e-3;

fn v3(a: V3) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}

/// Author, configure and return the world ready to tick.
pub fn build(s: &Structure) -> World {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let nodes: Vec<ChunkNodeDesc> = s
        .chunks
        .iter()
        .enumerate()
        .map(|(i, c)| ChunkNodeDesc {
            node_index: i as u32,
            centroid: v3(c.center),
            mass: c.mass as f32,
            volume: c.volume() as f32,
            geom_kind: if c.hull.is_some() { 1 } else { 0 },
            half_extents: v3(c.half),
            convex_points: c.hull.as_ref().map(|h| h.iter().map(|p| v3(*p)).collect()).unwrap_or_default(),
            material: 0,
        })
        .collect();
    let bonds: Vec<ChunkBondDesc> = s
        .bonds
        .iter()
        .enumerate()
        .map(|(k, b)| ChunkBondDesc {
            bond_index: k as u32,
            node0: b.a as u32,
            node1: b.b as u32,
            centroid: v3(b.centroid),
            normal: v3(b.normal),
            area: super::model::section(b).area as f32,
            material: b.material as u32,
        })
        .collect();
    let materials = s
        .materials
        .iter()
        .map(|m| StressMaterialDesc {
            compression_elastic: m.compression as f32,
            compression_fatal: m.compression as f32,
            tension_elastic: m.tension as f32,
            tension_fatal: m.tension as f32,
            shear_elastic: m.shear as f32,
            shear_fatal: m.shear as f32,
            elastic_modulus: m.modulus as f32,
            residual_area_fraction: 0.0,
        })
        .collect();
    let defaults = DestructibleSettings::default();
    let settings = DestructibleSettings {
        linear_damping: s.linear_damping.map(|d| d as f32).unwrap_or(defaults.linear_damping),
        max_solver_iterations_per_frame: STRESS_ITERATIONS,
        materials,
        crush: s.crush.clone(),
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    let [x, y, z, w] = s.rotation;
    world
        .native_create_destructible(
            0,
            Pose { position: v3(s.origin), rotation: Quat { x: x as f32, y: y as f32, z: z as f32, w: w as f32 } },
            &nodes,
            &bonds,
            settings,
            GROUP_CHUNK,
            // Chunks meet everything: each other, plain bodies (the dynamics
            // cases' balls, blocks and ground) and the stage's rounds.
            u32::MAX,
        )
        .unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: STRESS_ITERATIONS,
            tolerance: STRESS_TOLERANCE,
            // VIBE_NATIVE_STRESS_FORCE_TOLERANCE, as the game reads it
            // (native_runtime.rs stress_force_tolerance): 0 = the residual
            // test alone (runtime); 1e-3 in the high-fidelity profile.
            force_tolerance: std::env::var("VIBE_NATIVE_STRESS_FORCE_TOLERANCE").ok().and_then(|v| v.parse::<f32>().ok()).filter(|v| *v >= 0.0 && v.is_finite()).unwrap_or(0.0),
            warm_start: true,
            damage_rate: 2.0,
            bend_gain_max: 3.0,
            fibre_bending: true,
            reserved_contact_pairs: (s.chunks.len() as u32 * 3 / 2).max(64),
            preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true,
            verdict_sample_ticks: 1,
        })
        .unwrap();
    world
}

/// Tick up to `max_ticks`, handing each tick's status and the bonds broken
/// in it to `on_tick`; stop when it returns true.
pub fn run_ticks(
    world: &mut World,
    max_ticks: u32,
    mut on_tick: impl FnMut(u32, &vibe_land_physx_bridge::NativeStatus, &[u32], &World) -> bool,
) -> u32 {
    for t in 1..=max_ticks {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected the step: {status:?}");
        let broken: Vec<u32> = world.native_take_broken_bonds().unwrap().iter().map(|b| b.bond_id).collect();
        if on_tick(t, &status, &broken, world) {
            return t;
        }
    }
    max_ticks
}

/// Load a structure and watch for the first fracture: Some((tick, bonds
/// broken that tick, how many of them broke in the tick's first (trial)
/// evaluation rather than in its corrected pass)) or None if it stood for
/// `max_ticks` (stopping early once the solve has reported converged for 10
/// ticks running).
pub fn first_break(s: &Structure, max_ticks: u32) -> Option<(u32, Vec<u32>, usize)> {
    let mut world = build(s);
    let mut found = None;
    let mut settled = 0;
    run_ticks(&mut world, max_ticks, |t, status, broken, _| {
        if !broken.is_empty() {
            let trial = (status.broken_bonds.saturating_sub(status.post_correction_broken_bonds) as usize).min(broken.len());
            found = Some((t, broken.to_vec(), if trial == 0 { broken.len() } else { trial }));
            return true;
        }
        settled = if status.converged && status.observed { settled + 1 } else { 0 };
        settled >= 10
    });
    found
}

/// Graded rows by bond index.
pub fn rows(world: &World, bonds: usize) -> Vec<Graded> {
    let mut rows = world.native_bond_stress_rows(0).unwrap();
    rows.sort_by_key(|r| r.bond_index);
    assert_eq!(rows.len(), bonds, "one row per bond");
    rows.iter()
        .map(|r| {
            let normal = r.stress_normal as f64;
            let bend = r.stress_bend as f64;
            Graded {
                normal,
                shear: r.shear as f64,
                bend,
                tension: r.tension as f64,
                compression: r.compression as f64,
                axial_force: normal * r.area as f64,
                shear_force: f64::NAN,
                twist: f64::NAN,
            }
        })
        .collect()
}

pub struct Solved {
    pub rows: Vec<Graded>,
    /// Ticks run: until the stage reported the solve converged, or the cap.
    pub ticks: u32,
    pub converged: bool,
    /// The tick the stage first reported the solve converged.
    pub converged_at: u32,
    /// The first tick whose bond stresses satisfied `accurate` (the exact
    /// answer of the model to 1e-3), however the stage's convergence flag
    /// read; None if never within the cap.
    pub accurate_at: Option<u32>,
}

/// Solve a structure to convergence and read every bond, checking every
/// tick when the stresses first reach `accurate`.
pub fn solve(s: &Structure, max_ticks: u32, accurate: impl Fn(&[Graded]) -> bool) -> Solved {
    let mut world = build(s);
    let mut out = Solved { rows: Vec::new(), ticks: 0, converged: false, converged_at: 0, accurate_at: None };
    for t in 1..=max_ticks {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected the step: {status:?}");
        let broken = world.native_take_broken_bonds().unwrap();
        assert!(broken.is_empty(), "a statics case broke bonds {broken:?}");
        out.ticks = t;
        out.rows = rows(&world, s.bonds.len());
        if std::env::var_os("VERIFY_VERBOSE").is_some() && (t <= 3 || t % 100 == 0) {
            let raw = world.native_bond_stress_rows(0).unwrap();
            let avail = raw.iter().filter(|r| r.native_verdict_available).count();
            println!("    tick {t}: {status:?}; verdicts {avail}/{}", raw.len());
        }
        if out.accurate_at.is_none() && accurate(&out.rows) {
            out.accurate_at = Some(t);
        }
        if status.converged && status.observed && !out.converged {
            out.converged = true;
            out.converged_at = t;
        }
        if out.converged && out.accurate_at.is_some() {
            break;
        }
    }
    out
}
