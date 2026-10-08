#![cfg(feature = "native-destruction")]

//! Re-bearing (VIBE_REBEARING=1, PhysX PX_DESTRUCTION_REBEARING; FIDELITY_AUDIT C9):
//! a bearing joint whose fasteners fail is a unilateral contact. It bears in
//! compression, resists shear by friction, carries no tension, and is not
//! broken while it bears. A region it held that is left with no path to a
//! support still splits.
//!
//! `plate_rebears_after_uplift` (the textbook case): a plate on two posts A
//! and B, a 1 m span, symmetric, its joints equally stiff. At rest each post
//! carries half its weight. A block set on the plate's overhang beyond A pries
//! it up off B (statics of the rigid plate on two supports: R_B = (W_P L/2 -
//! W_b a) / L < 0) past B's two end nails in withdrawal; the block is then
//! lifted off, and the plate's own weight returns. A real plate sits back down
//! on B: B's reaction is W_P / 2 again and nothing has broken. Without
//! re-bearing B's joint is gone for good and the plate hangs from A.
//!
//! `hanging_stud_falls_free`: a stud hung under its plate by its end nails,
//! pulled past them by its own weight, has no compression path: it must split
//! and fall, as it does without re-bearing.
//!
//! VIBE_GPU_SHARED=1 VIBE_REBEARING=1 cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test rebearing -- --ignored --test-threads=1 --nocapture
//! (VIBE_REBEARING unset: the same test fails, B's reaction stays 0.)

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, DynamicBoxDesc, NativeConfig, Pose, Quat, StressMaterialDesc,
    Vec3, World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = u32::MAX;
const STUD: (f64, f64) = (0.09, 0.045); // a 45 x 90 mm stud: depth along the span, width
const HEIGHT: f64 = 0.5;
const SPAN: f64 = 1.0; // A at -SPAN/2, B at +SPAN/2
const OVERHANG: f64 = 0.5; // the plate runs 0.5 m past each post
const PLATE_MASS: f64 = 100.0;
const BLOCK_MASS: f64 = 300.0;
const BLOCK_ARM: f64 = 0.4; // the block's centre beyond A
/// Two end nails (16d, 3.15 x 90 mm) in withdrawal from end grain: town-kit
/// `stud-plate`, 0.47 kN (EN 1995-1-1 8.3.2 with the end-grain rule).
const NAILS_TENSION: f64 = 470.0;
/// Their lateral capacity: 2 x 0.77 kN x 0.67 end grain (town-kit convention).
const NAILS_SHEAR: f64 = 1032.0;
/// C24 compression perpendicular to the grain, f_c,90,k (EN 338): the plate
/// bearing on the post's end.
const FC90: f64 = 2.5e6;
const E_TIMBER: f64 = 11e9; // C24 E_0,mean (EN 338)

fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}
fn g() -> f64 {
    -(WorldConfig::default().gravity.y as f64)
}
fn strong() -> StressMaterialDesc {
    StressMaterialDesc {
        compression_elastic: 1e12, compression_fatal: 1e12, tension_elastic: 1e12, tension_fatal: 1e12,
        shear_elastic: 1e12, shear_fatal: 1e12, elastic_modulus: E_TIMBER as f32, residual_area_fraction: 0.0,
    }
}
/// A stud end-nailed to a plate, as stresses over the bearing patch.
fn nailed() -> StressMaterialDesc {
    let area = STUD.0 * STUD.1;
    StressMaterialDesc {
        compression_elastic: FC90 as f32, compression_fatal: FC90 as f32,
        tension_elastic: (NAILS_TENSION / area) as f32, tension_fatal: (NAILS_TENSION / area) as f32,
        shear_elastic: (NAILS_SHEAR / area) as f32, shear_fatal: (NAILS_SHEAR / area) as f32,
        elastic_modulus: E_TIMBER as f32, residual_area_fraction: 0.0,
    }
}
fn profile() {
    stage_env::product();
    // The high-fidelity structural model the capability is for: real sections
    // (bearing joints need them), their rotational stiffness, short-term strength.
    std::env::set_var("VIBE_SECTION_ROTATION", "1");
    std::env::set_var("VIBE_STRENGTH_SHORT_TERM", "1");
}
fn rebearing_on() -> bool {
    std::env::var("VIBE_REBEARING").map(|v| v == "1").unwrap_or(false)
}
fn node(i: u32, c: [f64; 3], h: [f64; 3], m: f64) -> ChunkNodeDesc {
    ChunkNodeDesc {
        node_index: i, centroid: v3(c), mass: m as f32, volume: (8.0 * h[0] * h[1] * h[2]) as f32, geom_kind: 0,
        half_extents: v3(h), convex_points: Vec::new(), material: 0,
    }
}
fn bond(k: u32, a: u32, b: u32, c: [f64; 3], n: [f64; 3], area: f64, material: u32) -> ChunkBondDesc {
    ChunkBondDesc { bond_index: k, node0: a, node1: b, centroid: v3(c), normal: v3(n), area: area as f32, material }
}
fn configure(world: &mut World, nodes: &[ChunkNodeDesc], bonds: &[ChunkBondDesc], materials: Vec<StressMaterialDesc>, bearing: Vec<f32>) {
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: 64,
        materials,
        bearing_joint: bearing,
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    world
        .native_create_destructible(0, Pose { position: Vec3::new(0.0, 10.0, 0.0), rotation: Quat::IDENTITY },
            nodes, bonds, settings, GROUP_CHUNK, GROUP_CHUNK)
        .unwrap();
    world.step().unwrap();
    // The product's solve: 64 iterations, FP32.
    world
        .native_configure(NativeConfig {
            max_iterations: 64, tolerance: 1e-3, force_tolerance: 1e-3, warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true,
            reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
}
/// The normal force across `bond` (N; negative in compression), 0 once broken.
fn normal_force(world: &World, bond: u32) -> (f64, bool) {
    let rows = world.native_bond_stress_rows(0).unwrap();
    match rows.iter().find(|r| r.bond_index == bond) {
        Some(r) if !r.broken => (r.stress_normal as f64 * r.remaining_area as f64, false),
        Some(_) => (0.0, true),
        None => (0.0, true),
    }
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_REBEARING and VIBE_REBEARING=1"]
fn plate_rebears_after_uplift() {
    profile();
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let (sd, sw) = STUD;
    let stud_mass = 420.0 * sd * sw * HEIGHT;
    let plate_half = [SPAN / 2.0 + OVERHANG, 0.045, 0.1];
    let plate_y = HEIGHT + plate_half[1];
    let nodes = [
        node(0, [0.0, -0.025, 0.0], [SPAN, 0.025, 0.15], 0.0), // sill: the support
        node(1, [-SPAN / 2.0, HEIGHT / 2.0, 0.0], [sd / 2.0, HEIGHT / 2.0, sw / 2.0], stud_mass), // A
        node(2, [SPAN / 2.0, HEIGHT / 2.0, 0.0], [sd / 2.0, HEIGHT / 2.0, sw / 2.0], stud_mass), // B
        node(3, [0.0, plate_y, 0.0], plate_half, PLATE_MASS), // the plate
    ];
    let area = sd * sw;
    let up = [0.0, 1.0, 0.0];
    let bonds = vec![
        bond(0, 0, 1, [-SPAN / 2.0, 0.0, 0.0], up, area, 0),
        bond(1, 0, 2, [SPAN / 2.0, 0.0, 0.0], up, area, 0),
        bond(2, 1, 3, [-SPAN / 2.0, HEIGHT, 0.0], up, area, 0), // A: held down (strong)
        bond(3, 2, 3, [SPAN / 2.0, HEIGHT, 0.0], up, area, 1),  // B: end-nailed, the joint under test
    ];
    configure(&mut world, &nodes, &bonds, vec![strong(), nailed()], vec![0.0, 1.0]);
    let half = PLATE_MASS * g() / 2.0;
    let uplift = (BLOCK_MASS * g() * BLOCK_ARM - PLATE_MASS * g() * SPAN / 2.0) / SPAN;
    println!("plate {PLATE_MASS} kg on posts {SPAN} m apart: B carries {half:.1} N; the block pries B up by {uplift:.1} N statically \
              (its nails hold {NAILS_TENSION} N); re-bearing {}", if rebearing_on() { "on" } else { "OFF" });
    assert!(uplift > NAILS_TENSION, "the case must lift B past its nails");
    let mut broken = Vec::new();
    let mut tick = |world: &mut World, label: &str, n: u32| -> (f64, f64, bool) {
        let mut lifted = false;
        let mut last = (0.0, 0.0);
        for t in 0..n {
            world.step().unwrap();
            world.native_tick().unwrap();
            broken.extend(world.native_take_broken_bonds().unwrap().iter().map(|e| e.bond_id));
            let (fb, gone) = normal_force(world, 3);
            let (fa, _) = normal_force(world, 2);
            lifted |= gone || fb >= 0.0;
            last = (fa, fb);
            if std::env::var_os("REBEARING_TRACE").is_some() {
                println!("    {label} tick {t}: A {fa:.1} N, B {fb:.1} N{}", if gone { " (broken)" } else { "" });
            }
        }
        (last.0, last.1, lifted)
    };
    let (a0, b0, _) = tick(&mut world, "rest", 30);
    println!("  at rest: A {a0:.1} N, B {b0:.1} N (textbook -{half:.1} each)");
    assert!((b0 + half).abs() < 0.02 * half, "at rest B carries {b0:.1} N, not -{half:.1} N");
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 9100, user_id: 9100,
            pose: Pose {
                position: Vec3::new((-SPAN / 2.0 - BLOCK_ARM) as f32, (plate_y + plate_half[1] + 0.1 + 0.001) as f32, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: Vec3::new(0.1, 0.1, 0.1), mass: BLOCK_MASS as f32,
            collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    let (a1, b1, lifted) = tick(&mut world, "block", 60);
    println!("  block on the overhang: A {a1:.1} N, B {b1:.1} N, B lifted off: {lifted}");
    assert!(lifted, "the block never lifted the plate off B (B {b1:.1} N)");
    world.remove_actor(9100).unwrap();
    let (a2, b2, _) = tick(&mut world, "after", 90);
    println!("  block lifted off: A {a2:.1} N, B {b2:.1} N (textbook -{half:.1} each); broken bonds {broken:?}");
    assert!(broken.is_empty(), "bonds broke: {broken:?} (B's joint should re-bear, not break)");
    assert!((b2 + half).abs() < 0.02 * half, "B did not re-bear: it carries {b2:.1} N, the plate's half weight is -{half:.1} N");
    assert!((a2 + half).abs() < 0.02 * half, "A carries {a2:.1} N, not -{half:.1} N");
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_BEARING_JOINTS (and PX_DESTRUCTION_REBEARING with VIBE_REBEARING=1)"]
fn hanging_stud_falls_free() {
    profile();
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let (sd, sw) = STUD;
    let hanging = 80.0; // kg below the nails: 785 N pulls on 470 N of nails
    let nodes = [
        node(0, [0.0, 0.01, 0.0], [0.2, 0.01, 0.1], 0.0), // the plate above: the support
        node(1, [0.0, -HEIGHT / 2.0, 0.0], [sd / 2.0, HEIGHT / 2.0, sw / 2.0], hanging),
    ];
    let bonds = vec![bond(0, 0, 1, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0], sd * sw, 1)];
    configure(&mut world, &nodes, &bonds, vec![strong(), nailed()], vec![0.0, 1.0]);
    let mut broke = false;
    let mut low = f64::INFINITY;
    for _ in 0..40 {
        world.step().unwrap();
        world.native_tick().unwrap();
        broke |= world.native_take_broken_bonds().unwrap().iter().any(|e| e.bond_id == 0);
        for s in world.native_chunk_body_snapshots().unwrap() {
            if !s.kinematic && s.node_count == 1 {
                low = low.min(s.position.y as f64);
            }
        }
    }
    println!("hanging stud ({:.0} N on {NAILS_TENSION} N of nails): broke {broke}, lowest free body at y {low:.3} m (it hung at {:.3})",
        hanging * g(), 10.0 - HEIGHT / 2.0);
    assert!(broke, "the stud hung on with no compression path (re-bearing must still split)");
    assert!(low < 10.0 - HEIGHT / 2.0 - 0.05, "the stud did not fall (lowest {low:.3} m)");
}
