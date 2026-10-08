//! Flat ground built from pieces, as the bridge's GPU scene meets it.
//!
//! The ghost collision (internal edge): a body sliding over the seam between
//! two flush static boxes meets the next box's edge and is thrown up and back.
//! Stock PhysX does it on CPU and GPU alike (docs/destruction/INTERNAL_EDGES.md:
//! a ball at 20 m/s thrown up 5.3 m/s, a 1.5 t box snagged to a stop). The
//! standard fix is one triangle mesh whose coplanar triangles share edges
//! (PhysX active edges; Bullet btAdjustInternalEdgeContacts; Jolt active
//! edges): `ground_mesh::from_boxes` builds it from the same boxes.
//!
//! What a flat road does: a body sliding or rolling over it at road speed moves
//! exactly as over one seamless slab. The tolerance is one tick of gravity, g dt
//! = 0.16 m/s: the resolution of a discrete step's resting contact. A real step
//! (a piece 35 mm proud: paving beside a road) is still an edge.
//!
//! Lane: 10 rows of 4 m, two columns of 2 m, 25 mm of asphalt on the world's
//! static ground (top y = 0), as the lab's paved lanes; friction 0.5,
//! restitution 0.1 (WorldConfig).
//!
//! VIBE_GPU_SHARED=1 PHYSX_ROOT=... cargo test -p vibe-land-physx-bridge \
//!   --features gpu --test static_ground -- --ignored --test-threads=1 --nocapture

use vibe_land_physx_bridge::ground_mesh::{from_boxes, GroundBox};
use vibe_land_physx_bridge::{
    DynamicBoxDesc, LaunchedBallDesc, Pose, Quat, StaticBoxDesc, StaticMeshDesc, Vec3, World, WorldConfig,
};

const ALL: u32 = u32::MAX;
const GROUP_STATIC: u32 = 1;
const GROUP_BODY: u32 = 1 << 3;
const BODY: u32 = 0x0300_0001;
const DT: f32 = 1.0 / 60.0;
const TOL: f32 = 9.81 * DT;
const TOP: f32 = 0.025;
const ROWS: u32 = 10;

fn identity() -> Quat { Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }

#[derive(Clone, Copy, PartialEq, Debug)]
enum Ground { Boxes, OneBox, Mesh, MeshStep }

/// The lane's pieces: rows along z (centres 0, 4, ...), two columns.
fn pieces(step: bool) -> Vec<GroundBox> {
    let mut out = Vec::new();
    for r in 0..ROWS {
        let z = 4.0 * r as f32;
        for x in [-2.0f32, 0.0] {
            // The step: the second row's right-hand piece is paving, 60 mm.
            let top = if step && r == 1 && x == 0.0 { 0.06 } else { TOP };
            out.push(([x, 0.0, z - 2.0], [x + 2.0, top, z + 2.0]));
        }
    }
    out
}

fn build(world: &mut World, ground: Ground) {
    world.add_static_box(StaticBoxDesc { entity_id: 0x0100_0001, user_id: 1, pose: Pose { position: Vec3::new(0.0, -5.0, 0.0), rotation: identity() },
        half_extents: Vec3::new(500.0, 5.0, 500.0), collision_group: GROUP_STATIC, collision_mask: ALL }).unwrap();
    let mut id = 0x0100_0002;
    match ground {
        Ground::Boxes => for (lo, hi) in pieces(false) {
            let c = Vec3::new(0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2]));
            let h = Vec3::new(0.5 * (hi[0] - lo[0]), 0.5 * (hi[1] - lo[1]), 0.5 * (hi[2] - lo[2]));
            world.add_static_box(StaticBoxDesc { entity_id: id, user_id: 1, pose: Pose { position: c, rotation: identity() }, half_extents: h,
                collision_group: GROUP_STATIC, collision_mask: ALL }).unwrap();
            id += 1;
        },
        Ground::OneBox => {
            let z1 = 4.0 * (ROWS - 1) as f32 + 2.0;
            world.add_static_box(StaticBoxDesc { entity_id: id, user_id: 1, pose: Pose { position: Vec3::new(-1.0 + 1.0, 0.5 * TOP, 0.5 * (z1 - 2.0)), rotation: identity() },
                half_extents: Vec3::new(2.0, 0.5 * TOP, 0.5 * (z1 + 2.0)), collision_group: GROUP_STATIC, collision_mask: ALL }).unwrap();
        }
        Ground::Mesh | Ground::MeshStep => {
            let mesh = from_boxes(&pieces(ground == Ground::MeshStep));
            world.add_static_mesh(StaticMeshDesc { entity_id: id, user_id: 1, pose: Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: identity() },
                friction: -1.0, restitution: 0.0, collision_group: GROUP_STATIC, collision_mask: ALL }, &mesh.vertices, &mesh.indices).unwrap();
        }
    }
}

/// The body at rest on the lane at z 0.5 (x on the right-hand column's centre,
/// or the box across the lane's long seam), sent along +z at `speed`:
/// its [z, along, up, |spin|] each tick.
fn run(ground: Ground, ball: bool, speed: f32, ticks: u32) -> Vec<[f32; 4]> {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    build(&mut world, ground);
    if ball {
        let r = 0.35;
        world.launch_dynamic_ball(LaunchedBallDesc { entity_id: BODY, user_id: 1, pose: Pose { position: Vec3::new(1.0, TOP + r, 0.0), rotation: identity() },
            radius: r, mass: 20.0, linear_velocity: Vec3::new(0.0, 0.0, speed), collision_group: GROUP_BODY, collision_mask: ALL }).unwrap();
    } else {
        let h = Vec3::new(0.9, 0.75, 2.25);
        world.add_dynamic_box(DynamicBoxDesc { entity_id: BODY, user_id: 1, pose: Pose { position: Vec3::new(0.3, TOP + h.y, 0.5), rotation: identity() },
            half_extents: h, mass: 1500.0, collision_group: GROUP_BODY, collision_mask: ALL }).unwrap();
        world.apply_impulse(BODY, Vec3::new(0.0, 0.0, 1500.0 * speed)).unwrap();
    }
    (0..ticks).map(|_| {
        world.step().unwrap();
        let b = world.body_snapshots().unwrap().into_iter().find(|b| b.entity_id == BODY).expect("body");
        let w = b.angular_velocity;
        [b.pose.position.z, b.linear_velocity.z, b.linear_velocity.y, (w.x * w.x + w.y * w.y + w.z * w.z).sqrt()]
    }).collect()
}

fn summary(t: &[[f32; 4]]) -> (f32, f32) {
    (t.iter().map(|x| x[2]).fold(f32::MIN, f32::max), t.last().unwrap()[1])
}

/// Over the lane's pieces as one mesh, a car-scale box sliding and a
/// wheel-scale ball rolling at 20 m/s move as over one seamless box, within
/// g dt; as separate boxes they do not (the case still sees the ghost).
#[test]
#[ignore = "requires the GPU"]
fn mesh_ground_has_no_seams() {
    let mut failures = Vec::new();
    for ball in [false, true] {
        let name = if ball { "ball" } else { "box" };
        let (up0, along0) = summary(&run(Ground::OneBox, ball, 20.0, 75));
        let (up_b, along_b) = summary(&run(Ground::Boxes, ball, 20.0, 75));
        let (up_m, along_m) = summary(&run(Ground::Mesh, ball, 20.0, 75));
        println!("{name}: one box up {up0:.3} along {along0:.3}; flush boxes up {up_b:.3} along {along_b:.3}; mesh up {up_m:.3} along {along_m:.3}");
        if !(up_b > up0 + TOL || (along_b - along0).abs() > TOL) { failures.push(format!("{name}: flush boxes show no ghost: the case no longer tests seams")); }
        if up_m > up0 + TOL || (along_m - along0).abs() > TOL {
            failures.push(format!("{name}: the mesh lane is not seamless: up {up_m:.3} vs {up0:.3}, along {along_m:.3} vs {along0:.3}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A real step is still an edge: the 35 mm lip of paving beside the road
/// lifts a ball rolling into it at 5 m/s. After the contact the ball cannot be
/// moving into the lip's edge, so its lift is at least its speed times the
/// edge normal's tangent at the latest it can first touch (centre one tick,
/// 83 mm, past first touch).
#[test]
#[ignore = "requires the GPU"]
fn mesh_step_is_an_edge() {
    let (r, h, v) = (0.35f32, 0.035f32, 5.0f32);
    let t = run(Ground::MeshStep, true, v, 60);
    let (up, _) = summary(&t);
    let flat = summary(&run(Ground::Mesh, true, v, 60)).0;
    let d = (r * r - (r - h) * (r - h)).sqrt() - v * DT;
    let along = t.iter().find(|x| x[0] > 2.0 - 0.5).map_or(v, |x| x[1]);
    let bound = along * d / (r - h);
    println!("step: up {up:.3} (flat {flat:.3}), the edge's lift >= {bound:.3} at {along:.2} m/s");
    assert!(up >= bound, "the 35 mm lip lifted the ball {up:.3} m/s, its edge needs at least {bound:.3}");
}
