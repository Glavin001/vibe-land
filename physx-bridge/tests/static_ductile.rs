#![cfg(feature = "native-destruction")]
//! Steel joints are ductile in the static verdict (PX_DESTRUCTION_STATIC_DUCTILE,
//! PhysX fix/static-ductile-steel): a metal joint with an ultimate slip yields
//! and strain-hardens between its elastic and fatal limits, and past fatal it
//! necks by the slip of the excess and ruptures only once that slip reaches its
//! ultimate slip. Timber stays brittle.
//!
//! A block hangs under an anchored footing on one bond (tension = its weight
//! over the bond's area). Arms:
//! - steel, weight between yield and fatal: holds 3 s with the flag; without it
//!   the damage law's section loss (2 /s past the elastic limit) breaks it;
//! - steel, weight 1.5x fatal: without the flag it snaps on the first tick;
//!   with it, it necks over several ticks first and still breaks (a held
//!   overload past capacity is a mechanism: real steel cannot hold it);
//! - timber (E 11 GPa) with the same slip, 1.5x fatal: snaps on the first tick
//!   either way (the rule is for metals; EN 338 C24 joints are brittle).
//!
//! VIBE_GPU_SHARED=1 PHYSX_ROOT=... cargo test -p vibe-land-physx-bridge \
//!   --features native-destruction --test static_ductile -- --ignored --nocapture --test-threads=1
#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StressMaterialDesc, Vec3, World, WorldConfig};

const GROUP_CHUNK: u32 = 1 << 5;
const Y: f32 = 20.0;
const MASS: f32 = 1000.0;
const AREA: f32 = 1e-3;
const G: f32 = 9.81;

/// Ticks until the hanging block's bond breaks (None: it held for `ticks`).
fn hang(ductile_flag: bool, modulus: f32, load_over_fatal: f32, elastic_over_fatal: f32, ticks: u32) -> Option<u32> {
    stage_env::product();
    if ductile_flag { std::env::set_var("PX_DESTRUCTION_STATIC_DUCTILE", "1"); } else { std::env::remove_var("PX_DESTRUCTION_STATIC_DUCTILE"); }
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let node = |i: u32, y: f32, m: f32| ChunkNodeDesc { node_index: i, centroid: Vec3::new(0.0, y, 0.0), mass: m, volume: 0.125,
        geom_kind: 0, half_extents: Vec3::new(0.25, 0.25, 0.25), convex_points: Vec::new(), material: 0 };
    let nodes = vec![node(0, Y, 0.0), node(1, Y - 0.5, MASS)];
    let bonds = vec![ChunkBondDesc { bond_index: 0, node0: 0, node1: 1, centroid: Vec3::new(0.0, Y - 0.25, 0.0), normal: Vec3::new(0.0, 1.0, 0.0), area: AREA, material: 0 }];
    let fatal = MASS * G / AREA / load_over_fatal;
    let material = StressMaterialDesc { compression_elastic: fatal * elastic_over_fatal, compression_fatal: fatal, tension_elastic: fatal * elastic_over_fatal,
        tension_fatal: fatal, shear_elastic: fatal * elastic_over_fatal, shear_fatal: fatal, elastic_modulus: modulus, residual_area_fraction: 0.0 };
    // Steel's ultimate slip as the vehicles author it: A 5.65 sqrt(S), A 15% (EN 1993-1-1 3.2.2).
    let slip = 0.15 * 5.65 * AREA.sqrt();
    let settings = DestructibleSettings { materials: vec![material], ductile_slip: vec![slip], linear_damping: 0.0, angular_damping: 0.0, ..DestructibleSettings::default() };
    world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }, &nodes, &bonds, settings, GROUP_CHUNK, u32::MAX).unwrap();
    world.step().unwrap();
    world.native_configure(NativeConfig { max_iterations: 64, tolerance: 1e-4, force_tolerance: 0.0, warm_start: true, damage_rate: 2.0, bend_gain_max: 3.0,
        fibre_bending: true, reserved_contact_pairs: 16, preserve_unchanged_contact_pairs: true, gpu_island_repair: true, verdict_sample_ticks: 1 }).unwrap();
    for t in 0..ticks {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage error on tick {t}");
        if !world.native_take_broken_bonds().unwrap().is_empty() { return Some(t); }
    }
    None
}

#[test]
#[ignore = "requires the native-destruction GPU SDK with PX_DESTRUCTION_STATIC_DUCTILE (PhysX fix/static-ductile-steel)"]
fn steel_joints_yield_and_neck_timber_snaps() {
    // S355: f_y/f_u = 355/490 (EN 10025-2), loaded at 0.9 f_u: past yield, under fatal.
    let yielded = (hang(true, 200e9, 0.9, 0.725, 180), hang(false, 200e9, 0.9, 0.725, 180));
    println!("steel at 0.9 f_u: with the flag {:?}, without {:?}", yielded.0, yielded.1);
    assert_eq!(yielded.0, None, "steel between yield and fatal holds (strain hardening; no section loss)");
    assert!(yielded.1.is_some(), "without the flag the damage law's section loss breaks it (the old model)");
    let over = (hang(true, 200e9, 1.5, 0.725, 180), hang(false, 200e9, 1.5, 0.725, 180));
    println!("steel at 1.5 f_u: with the flag {:?}, without {:?}", over.0, over.1);
    assert_eq!(over.1, Some(0), "brittle at fatal without the flag: the first tick");
    let necked = over.0.expect("a held overload past capacity still ruptures");
    assert!(necked > 0, "steel necks before it ruptures");
    let timber = hang(true, 11e9, 1.5, 0.725, 180);
    println!("timber at 1.5 f: {timber:?}");
    assert_eq!(timber, Some(0), "timber stays brittle");
}
