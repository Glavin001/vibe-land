// Re-export the generic KCC collision world from the netcode library.
pub use vibe_netcode::sim_world::SimWorld;

use rapier3d::prelude::ColliderHandle;

use crate::constants::*;
use crate::movement::*;
use crate::protocol::InputCmd;

const MIN_PUSH_SPEED_MPS: f64 = 0.75;
const MAX_PUSHED_BODIES_PER_TICK: usize = 6;
const PLAYER_INTERACTION_MASS: f32 = 2.5;
const MIN_HORIZONTAL_RETAIN: f64 = 0.35;
const SUPPORT_CONTACT_EPSILON_M: f32 = 0.12;
const SUPPORT_CONTACT_MARGIN_M: f32 = 0.35;
const SUPPORT_SNAP_EXTRA_M: f32 = 0.06;
const SUPPORT_PLATFORM_VEL_EPSILON_MPS: f32 = 0.35;

#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

#[cfg(not(target_arch = "wasm32"))]
fn now_marker() -> Instant {
    Instant::now()
}

#[cfg(target_arch = "wasm32")]
fn now_marker() {}

#[cfg(not(target_arch = "wasm32"))]
fn elapsed_ms(started: Instant) -> f32 {
    started.elapsed().as_secs_f32() * 1000.0
}

#[cfg(target_arch = "wasm32")]
fn elapsed_ms(_: ()) -> f32 {
    0.0
}

#[derive(Clone, Debug, Default)]
pub struct PlayerTickTimings {
    pub move_math_ms: f32,
    pub kcc_query_ms: f32,
    pub collider_sync_ms: f32,
    pub dynamic_interaction_ms: f32,
}

#[derive(Clone, Debug, Default)]
pub struct DynamicBodyImpulse {
    pub body_id: u32,
    pub impulse: [f32; 3],
    pub contact_point: [f32; 3],
}

#[derive(Clone, Debug, Default)]
pub struct DynamicInteractionStats {
    pub considered_count: usize,
    pub pushed_count: usize,
    pub contacted_mass: f32,
}

#[derive(Clone, Debug, Default)]
pub struct PlayerTickResult {
    pub timings: PlayerTickTimings,
    pub dynamic_stats: DynamicInteractionStats,
    pub dynamic_impulses: Vec<DynamicBodyImpulse>,
}

fn update_player_motion(
    sim: &SimWorld,
    velocity: &mut Vec3d,
    yaw: &mut f64,
    pitch: &mut f64,
    on_ground: &mut bool,
    input: &InputCmd,
    dt: f32,
) {
    let cfg = &sim.config;
    let dt64 = dt as f64;

    *yaw = input.yaw as f64;
    *pitch = (input.pitch as f64).clamp(-1.55, 1.55);

    let wish = build_wish_dir(input, *yaw);
    let max_speed = pick_move_speed(cfg, input.buttons);

    apply_horizontal_friction(velocity, cfg.friction, dt64, *on_ground);
    accelerate(
        velocity,
        wish,
        max_speed,
        if *on_ground { cfg.ground_accel } else { cfg.air_accel },
        dt64,
    );

    if *on_ground && (input.buttons & BTN_JUMP != 0) {
        velocity.y = cfg.jump_speed;
        *on_ground = false;
    }

    velocity.y -= cfg.gravity * dt64;
}

fn apply_dynamic_interaction(
    sim: &SimWorld,
    collider_handle: ColliderHandle,
    start_position: Vec3d,
    position: &mut Vec3d,
    velocity: &mut Vec3d,
) -> (DynamicInteractionStats, Vec<DynamicBodyImpulse>) {
    let horizontal_delta = Vec3d::new(
        position.x - start_position.x,
        0.0,
        position.z - start_position.z,
    );
    let horizontal_speed =
        (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
    if horizontal_speed < MIN_PUSH_SPEED_MPS || horizontal_delta.norm_squared() < 1e-8 {
        return (DynamicInteractionStats::default(), Vec::new());
    }

    let move_dir = horizontal_delta.normalize();
    let player_bottom = position.y as f32
        - (sim.config.capsule_half_segment + sim.config.capsule_radius);

    let contacts = sim.intersect_pushable_dynamic_bodies(collider_handle, position);
    if contacts.is_empty() {
        return (DynamicInteractionStats::default(), Vec::new());
    }

    let mut filtered = Vec::new();
    let mut total_mass = 0.0f32;
    for contact in contacts {
        let support_like = player_bottom >= contact.aabb_max_y - SUPPORT_CONTACT_EPSILON_M
            && player_bottom <= contact.aabb_max_y + SUPPORT_CONTACT_MARGIN_M;
        if support_like {
            continue;
        }

        let to_body = Vec3d::new(
            contact.center[0] as f64 - position.x,
            0.0,
            contact.center[2] as f64 - position.z,
        );
        let in_front = to_body.norm_squared() < 1e-6
            || move_dir.dot(&to_body.normalize()) >= -0.25;
        if !in_front {
            continue;
        }

        total_mass += contact.mass.max(0.05);
        filtered.push(contact);
        if filtered.len() == MAX_PUSHED_BODIES_PER_TICK {
            break;
        }
    }

    let considered_count = filtered.len();
    if filtered.is_empty() || total_mass <= f32::EPSILON {
        return (
            DynamicInteractionStats {
                considered_count,
                ..DynamicInteractionStats::default()
            },
            Vec::new(),
        );
    }

    let resistance_scale = (PLAYER_INTERACTION_MASS as f64
        / (PLAYER_INTERACTION_MASS as f64 + total_mass as f64))
        .clamp(MIN_HORIZONTAL_RETAIN, 1.0);

    position.x = start_position.x + horizontal_delta.x * resistance_scale;
    position.z = start_position.z + horizontal_delta.z * resistance_scale;
    velocity.x *= resistance_scale;
    velocity.z *= resistance_scale;

    let total_impulse = (PLAYER_INTERACTION_MASS as f64
        * horizontal_speed
        * (1.0 - resistance_scale)) as f32;
    let mut total_weight = 0.0f32;
    let mut weights = Vec::with_capacity(filtered.len());
    for contact in &filtered {
        let weight = 1.0 / (0.5 + contact.horizontal_distance_sq.sqrt());
        total_weight += weight;
        weights.push(weight);
    }

    let move_dir_f32 = [move_dir.x as f32, 0.0, move_dir.z as f32];
    let impulses = filtered
        .into_iter()
        .zip(weights)
        .map(|(contact, weight)| {
            let share = if total_weight > f32::EPSILON {
                weight / total_weight
            } else {
                1.0
            };
            DynamicBodyImpulse {
                body_id: contact.body_id,
                impulse: [
                    move_dir_f32[0] * total_impulse * share,
                    0.0,
                    move_dir_f32[2] * total_impulse * share,
                ],
                contact_point: contact.contact_point,
            }
        })
        .collect::<Vec<_>>();

    (
        DynamicInteractionStats {
            considered_count,
            pushed_count: impulses.len(),
            contacted_mass: total_mass,
        },
        impulses,
    )
}

fn stabilize_dynamic_support(
    sim: &SimWorld,
    collider_handle: ColliderHandle,
    position: &mut Vec3d,
    velocity: &mut Vec3d,
    on_ground: bool,
    dt: f32,
) {
    if !on_ground || velocity.y > 0.0 {
        return;
    }
    let max_probe = sim.config.snap_to_ground + sim.config.collision_offset + SUPPORT_SNAP_EXTRA_M;
    let Some(support) = sim.probe_dynamic_support(collider_handle, position, max_probe) else {
        return;
    };
    let support_height = sim.config.capsule_half_segment + sim.config.capsule_radius;
    let desired_y = support.aabb_max_y as f64 + support_height as f64;
    let current_y = position.y;
    if (current_y - desired_y).abs() > (max_probe as f64 + 0.08) {
        return;
    }

    position.y = desired_y;
    if support.linvel[1].abs() <= SUPPORT_PLATFORM_VEL_EPSILON_MPS {
        velocity.y = 0.0;
    } else {
        velocity.y = support.linvel[1] as f64;
    }

    let platform_dx = support.linvel[0] as f64 * dt as f64;
    let platform_dz = support.linvel[2] as f64 * dt as f64;
    position.x += platform_dx;
    position.z += platform_dz;
}

/// Run one simulation step for a single player using game-specific input.
///
/// This is the game-specific wrapper around `SimWorld::move_character`.  It
/// translates `InputCmd` (button flags, analog axes, yaw/pitch) into the
/// generic movement math, then delegates the KCC step to the library.
///
/// Updates `position`, `velocity`, `yaw`, `pitch`, and `on_ground` in place.
/// Returns deterministic timing and dynamic-interaction data used by both the
/// authoritative server and client prediction.
pub fn simulate_player_tick(
    sim: &SimWorld,
    collider_handle: ColliderHandle,
    position: &mut Vec3d,
    velocity: &mut Vec3d,
    yaw: &mut f64,
    pitch: &mut f64,
    on_ground: &mut bool,
    input: &InputCmd,
    dt: f32,
) -> PlayerTickResult {
    let mut result = PlayerTickResult::default();

    let move_math_started = now_marker();
    update_player_motion(sim, velocity, yaw, pitch, on_ground, input, dt);
    result.timings.move_math_ms = elapsed_ms(move_math_started);

    let start_position = *position;
    let kcc_started = now_marker();

    let mut horizontal_position = *position;
    let mut horizontal_velocity = Vec3d::new(velocity.x, 0.0, velocity.z);
    let mut horizontal_ground = *on_ground;
    sim.move_character_horizontal(
        collider_handle,
        &mut horizontal_position,
        &mut horizontal_velocity,
        &mut horizontal_ground,
        dt,
    );
    position.x = horizontal_position.x;
    position.z = horizontal_position.z;
    velocity.x = horizontal_velocity.x;
    velocity.z = horizontal_velocity.z;

    let mut support_velocity = Vec3d::new(0.0, velocity.y, 0.0);
    let mut support_ground = *on_ground;
    sim.move_character_support(
        collider_handle,
        position,
        &mut support_velocity,
        &mut support_ground,
        dt,
    );
    velocity.y = support_velocity.y;
    *on_ground = support_ground;
    stabilize_dynamic_support(sim, collider_handle, position, velocity, *on_ground, dt);

    result.timings.kcc_query_ms = elapsed_ms(kcc_started);

    let dynamic_started = now_marker();
    let (dynamic_stats, dynamic_impulses) = apply_dynamic_interaction(
        sim,
        collider_handle,
        start_position,
        position,
        velocity,
    );
    result.timings.dynamic_interaction_ms = elapsed_ms(dynamic_started);
    result.dynamic_stats = dynamic_stats;
    result.dynamic_impulses = dynamic_impulses;

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::vector;
    use vibe_netcode::movement::MoveConfig;

    fn input() -> InputCmd {
        InputCmd {
            seq: 1,
            buttons: 0,
            move_x: 0,
            move_y: 0,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    fn sim_with_ground() -> SimWorld {
        let mut sim = SimWorld::new(MoveConfig::default());
        sim.add_static_cuboid(
            vector![0.0, -0.5, 0.0],
            vector![50.0, 0.5, 50.0],
            0,
        );
        sim.rebuild_broad_phase();
        sim
    }

    fn tick_player(
        sim: &mut SimWorld,
        collider: ColliderHandle,
        pos: &mut Vec3d,
        vel: &mut Vec3d,
        yaw: &mut f64,
        pitch: &mut f64,
        on_ground: &mut bool,
        input: &InputCmd,
        dt: f32,
    ) {
        simulate_player_tick(sim, collider, pos, vel, yaw, pitch, on_ground, input, dt);
        sim.sync_player_collider(collider, pos);
    }

    #[test]
    fn forward_movement() {
        let mut sim = sim_with_ground();
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        let idle = input();
        for _ in 0..60 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }
        assert!(on_ground, "should be grounded after settling");

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..30 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &fwd, 1.0 / 60.0);
        }
        assert!(pos.z > 0.5, "should have moved forward, got z={}", pos.z);
    }

    #[test]
    fn jump_and_gravity() {
        let mut sim = sim_with_ground();
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        let idle = input();
        for _ in 0..120 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }
        assert!(on_ground);
        let ground_y = pos.y;

        let mut jump = input();
        jump.buttons = BTN_JUMP;
        tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &jump, 1.0 / 60.0);
        assert!(vel.y > 0.0, "jump should give positive y velocity");

        let idle = input();
        for _ in 0..10 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }
        assert!(pos.y > ground_y, "should be above ground after jump");
    }

    #[test]
    fn determinism() {
        let run = || {
            let mut sim = sim_with_ground();
            let mut pos = Vec3d::new(0.0, 2.0, 0.0);
            let mut vel = Vec3d::zeros();
            let mut yaw = 0.0;
            let mut pitch = 0.0;
            let mut on_ground = false;
            let collider = sim.create_player_collider(pos, 1);
            sim.rebuild_broad_phase();

            let idle = input();
            for _ in 0..60 {
                tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
            }
            let mut fwd = input();
            fwd.move_y = 127;
            fwd.buttons = BTN_SPRINT;
            for _ in 0..60 {
                tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &fwd, 1.0 / 60.0);
            }
            pos
        };

        let p1 = run();
        let p2 = run();
        for i in 0..3 {
            assert!(
                (p1[i] - p2[i]).abs() < 1e-6,
                "position[{i}] diverged: {} vs {}",
                p1[i],
                p2[i],
            );
        }
    }

    #[test]
    fn wall_collision() {
        let mut sim = sim_with_ground();
        sim.add_static_cuboid(
            vector![0.0, 2.5, 3.0],
            vector![10.0, 5.0, 0.5],
            0,
        );
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        let idle = input();
        for _ in 0..60 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..120 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &fwd, 1.0 / 60.0);
        }

        assert!(pos.z < 3.0, "should be stopped by wall, got z={}", pos.z);
        assert!(pos.z > 0.5, "should have moved toward wall");
    }
}
