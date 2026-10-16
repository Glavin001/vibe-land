#![cfg(feature = "native-destruction")]

//! Per-material surfaces (VIBE_SURFACE_MATERIALS=1; AGENTS.md: friction and
//! restitution are each surface's own standard PxMaterial, never one world-wide
//! value). Each chunk shape takes its material's PxMaterial; PhysX combines two
//! surfaces by its documented rule (PxCombineMode::eAVERAGE by default).
//!
//! Three textbook checks, each built as its own structure: an anchored slab
//! (mass 0) and a free block on it, no bond between them, so the block is a
//! body of its own resting on the slab.
//! - The incline (Coulomb friction): a block on a slope of angle theta holds
//!   while tan theta < mu_s and slides with a = g (sin theta - mu_k cos theta)
//!   once tan theta > mu_s. Built at tan theta = 0.9, 1.1 and 1.5 mu (mu_s = mu_k):
//!   the first must hold, the second move, and the third slide at the
//!   closed-form a = g mu cos theta / 2 to within a tenth of the friction term,
//!   g mu cos theta / 10 -- the same +-10% bracket on mu as the hold/move pair.
//! - The drop (Newton's restitution): a block dropped from h onto the slab
//!   leaves at e times its impact speed, to within one tick of gravity's change
//!   in speed, g dt (the contact tick's own integration).
//! - Two materials: a block of mu_A on a slab of mu_B holds and slides about
//!   their average (PhysX's eAVERAGE), at 0.9, 1.1 and 1.5 of (mu_A + mu_B) / 2.
//!
//! Without VIBE_SURFACE_MATERIALS every shape takes the world's material
//! (friction 0.5, restitution 0.1) and the cases fail: the drops rebound at 0.1.
//!
//! VIBE_GPU_SHARED=1 VIBE_SURFACE_MATERIALS=1 cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test surface_materials -- --ignored --test-threads=1 --nocapture

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = u32::MAX;
const DT: f64 = 1.0 / 60.0;

fn g() -> f64 {
    -(WorldConfig::default().gravity.y as f64)
}
fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}
/// Strong in every mode: nothing here breaks.
fn rigid() -> StressMaterialDesc {
    StressMaterialDesc {
        compression_elastic: 1e12, compression_fatal: 1e12, tension_elastic: 1e12, tension_fatal: 1e12,
        shear_elastic: 1e12, shear_fatal: 1e12, elastic_modulus: 30e9, residual_area_fraction: 0.0,
    }
}
#[derive(Clone, Copy)]
struct Surface {
    mu: f64,
    e: f64,
}
struct Case {
    label: String,
    theta: f64,        // slope, rad
    block: Surface,    // the free block's surface
    slab: Surface,     // the anchored slab's surface
    drop: f64,         // the block's height above the slab (m); 0 resting
    expect: Expect,
}
enum Expect {
    Holds,
    /// Moves: faster than one tick of gravity along the slope.
    Moves,
    Slides { a: f64, tol: f64 },
    Rebounds { e: f64 },
}

fn build(world: &mut World, id: u32, case: &Case) {
    let (slab_half, block_half) = ([1.5, 0.1, 0.5], 0.1);
    let nodes = [
        ChunkNodeDesc { node_index: 0, centroid: v3([0.0, 0.0, 0.0]), mass: 0.0, volume: 0.3, geom_kind: 0,
            half_extents: v3(slab_half), convex_points: Vec::new(), material: 1 },
        ChunkNodeDesc { node_index: 1, centroid: v3([0.0, slab_half[1] + block_half + 0.002 + case.drop, 0.0]), mass: 20.0,
            volume: 0.008, geom_kind: 0, half_extents: v3([block_half; 3]), convex_points: Vec::new(), material: 0 },
    ];
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: 64,
        materials: vec![rigid(), rigid()],
        surface_static_friction: vec![case.block.mu as f32, case.slab.mu as f32],
        surface_dynamic_friction: vec![case.block.mu as f32, case.slab.mu as f32],
        surface_restitution: vec![case.block.e as f32, case.slab.e as f32],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    // The slope: the structure turned theta about z, so its local +x runs downhill.
    let half = -0.5 * case.theta;
    let rotation = Quat { x: 0.0, y: 0.0, z: half.sin() as f32, w: half.cos() as f32 };
    world
        .native_create_destructible(id, Pose { position: Vec3::new(6.0 * id as f32, 20.0, 0.0), rotation }, &nodes, &[], settings,
            GROUP_CHUNK, ALL)
        .unwrap();
}

#[test]
#[ignore = "requires a native GPU destruction SDK and VIBE_SURFACE_MATERIALS=1"]
fn surfaces_are_their_own_pxmaterials() {
    stage_env::product();
    let on = std::env::var("VIBE_SURFACE_MATERIALS").map(|v| v == "1").unwrap_or(false);
    let mu: f64 = 0.6;
    let mut cases = Vec::new();
    // 0.9 holds, 1.1 slides; at 1.5 the acceleration is half the friction
    // term, so +-10% of mu is a sharp bracket on it.
    for (k, factor) in [0.9f64, 1.1, 1.5].into_iter().enumerate() {
        let theta = (factor * mu).atan();
        let s = Surface { mu, e: 0.0 };
        let expect = if factor < 1.0 { Expect::Holds } else if factor < 1.2 { Expect::Moves } else {
            Expect::Slides { a: g() * (theta.sin() - mu * theta.cos()), tol: g() * mu * theta.cos() / 10.0 }
        };
        cases.push(Case { label: format!("incline tan = {factor} mu ({mu})"), theta, block: s, slab: s, drop: 0.0, expect });
        let _ = k;
    }
    for e in [0.2, 0.5, 0.8] {
        let s = Surface { mu: 0.6, e };
        cases.push(Case { label: format!("drop, e = {e}"), theta: 0.0, block: s, slab: s, drop: 1.0, expect: Expect::Rebounds { e } });
    }
    let (mu_a, mu_b): (f64, f64) = (0.4, 0.8);
    let avg = 0.5 * (mu_a + mu_b);
    for factor in [0.9f64, 1.1, 1.5] {
        let theta = (factor * avg).atan();
        let expect = if factor < 1.0 { Expect::Holds } else if factor < 1.2 { Expect::Moves } else {
            Expect::Slides { a: g() * (theta.sin() - avg * theta.cos()), tol: g() * avg * theta.cos() / 10.0 }
        };
        cases.push(Case { label: format!("mu {mu_a} on mu {mu_b}, tan = {factor} x average"), theta,
            block: Surface { mu: mu_a, e: 0.0 }, slab: Surface { mu: mu_b, e: 0.0 }, drop: 0.0, expect });
    }

    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    for (id, case) in cases.iter().enumerate() {
        build(&mut world, id as u32, case);
    }
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: 64, tolerance: 1e-3, force_tolerance: 0.0, warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true,
            reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
    // Per case: the block's velocity along the slope (downhill +) and vertically, every tick.
    let ticks = 90;
    let mut along = vec![Vec::with_capacity(ticks); cases.len()];
    let mut vertical = vec![Vec::with_capacity(ticks); cases.len()];
    for _ in 0..ticks {
        world.step().unwrap();
        world.native_tick().unwrap();
        let mut seen = vec![false; cases.len()];
        for b in world.native_chunk_body_snapshots().unwrap() {
            let id = b.structure_id as usize;
            if id >= cases.len() || b.kinematic || b.node_count != 1 || seen[id] {
                continue;
            }
            seen[id] = true;
            let t = cases[id].theta;
            let v = &b.linear_velocity;
            // Downhill: the structure's local +x turned -theta about z.
            along[id].push(v.x as f64 * t.cos() - v.y as f64 * t.sin());
            vertical[id].push(v.y as f64);
        }
        for (id, s) in seen.iter().enumerate() {
            if !s {
                along[id].push(f64::NAN);
                vertical[id].push(f64::NAN);
            }
        }
    }
    println!("surface materials {}", if on { "on" } else { "OFF (world material: friction 0.5, restitution 0.1)" });
    let mut failures = Vec::new();
    for (id, case) in cases.iter().enumerate() {
        let (ok, what) = match case.expect {
            Expect::Holds => {
                // After the first quarter second (the block settles 2 mm onto the slab).
                let speed = along[id][15..].iter().cloned().filter(|v| v.is_finite()).fold(0.0f64, |m, v| m.max(v.abs()));
                (speed < g() * DT, format!("peak speed along the slope after 0.25 s {speed:.4} m/s (holds below g dt = {:.4})", g() * DT))
            }
            Expect::Moves => {
                let speed = along[id].iter().cloned().filter(|v| v.is_finite()).fold(0.0f64, |m, v| m.max(v));
                (speed > g() * DT, format!("peak speed along the slope {speed:.4} m/s (moves above g dt = {:.4})", g() * DT))
            }
            Expect::Slides { a, tol } => {
                // The mean acceleration from 0.25 s to 0.75 s, from the speed along
                // the slope: on the slab throughout (1/2 a t^2 < 0.7 m of its 1.5 m
                // half-length for every case here), after the 2 mm settle.
                let (v0, v1) = (along[id][15], along[id][45]);
                let measured = (v1 - v0) / (30.0 * DT);
                ((measured - a).abs() <= tol, format!("a {measured:.3} m/s^2 vs closed form {a:.3} (+- {tol:.3})"))
            }
            Expect::Rebounds { e } => {
                // Impact speed: the fastest fall; rebound: the fastest rise after it.
                let vy = &vertical[id];
                let (k, v_in) = vy.iter().enumerate().filter(|(_, v)| v.is_finite())
                    .fold((0, 0.0f64), |(bk, bv), (k, &v)| if -v > bv { (k, -v) } else { (bk, bv) });
                let v_out = vy[k..].iter().cloned().filter(|v| v.is_finite()).fold(0.0f64, f64::max);
                let ratio = if v_in > 0.0 { v_out / v_in } else { f64::NAN };
                let tol = g() * DT / v_in;
                ((ratio - e).abs() <= tol, format!("impact {v_in:.3} m/s, rebound {v_out:.3} m/s: e {ratio:.3} vs {e} (+- {tol:.3})"))
            }
        };
        println!("  {:<40} {} {what}", case.label, if ok { "ok  " } else { "FAIL" });
        if !ok {
            failures.push(case.label.clone());
        }
    }
    assert!(failures.is_empty(), "surfaces off their PxMaterials' closed forms: {failures:?}");
}
