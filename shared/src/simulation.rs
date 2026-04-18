// Re-export the generic KCC collision world from the netcode library.
pub use vibe_netcode::sim_world::SimWorld;

use rapier3d::control::CharacterCollision;
use rapier3d::prelude::{Collider, ColliderHandle};

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
    pub query_ctx_ms: f32,
    pub kcc_horizontal_ms: f32,
    pub kcc_support_ms: f32,
    pub kcc_merged_ms: f32,
    pub support_probe_ms: f32,
    pub kcc_query_ms: f32,
    pub collider_sync_ms: f32,
    pub dynamic_contact_query_ms: f32,
    pub dynamic_interaction_ms: f32,
    pub dynamic_impulse_apply_ms: f32,
    pub history_record_ms: f32,
}

#[derive(Clone, Debug, Default)]
pub struct DynamicBodyImpulse {
    pub body_id: u32,
    pub impulse: [f32; 3],
    pub contact_point: [f32; 3],
}

#[derive(Clone, Debug, Default)]
pub struct DynamicInteractionStats {
    pub raw_contact_count: usize,
    pub considered_count: usize,
    pub kept_contact_count: usize,
    pub pushed_count: usize,
    pub contacted_mass: f32,
    pub support_probe_count: usize,
    pub support_probe_hit_count: usize,
    pub impulses_applied_count: usize,
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
        if *on_ground {
            cfg.ground_accel
        } else {
            cfg.air_accel
        },
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
    query_ctx: &vibe_netcode::sim_world::PlayerQueryContext<'_>,
    start_position: Vec3d,
    position: &mut Vec3d,
    velocity: &mut Vec3d,
    contacts: &mut Vec<vibe_netcode::sim_world::DynamicBodyContact>,
    timings: &mut PlayerTickTimings,
) -> (DynamicInteractionStats, Vec<DynamicBodyImpulse>) {
    let horizontal_delta = Vec3d::new(
        position.x - start_position.x,
        0.0,
        position.z - start_position.z,
    );
    let horizontal_speed = (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
    if horizontal_speed < MIN_PUSH_SPEED_MPS || horizontal_delta.norm_squared() < 1e-8 {
        return (DynamicInteractionStats::default(), Vec::new());
    }

    let move_dir = horizontal_delta.normalize();
    let player_bottom =
        position.y as f32 - (sim.config.capsule_half_segment + sim.config.capsule_radius);

    let contact_query_started = now_marker();
    query_ctx.intersect_pushable_dynamic_bodies(position, contacts);
    timings.dynamic_contact_query_ms = elapsed_ms(contact_query_started);
    let raw_contact_count = contacts.len();
    if contacts.is_empty() {
        return (DynamicInteractionStats::default(), Vec::new());
    }

    let mut total_mass = 0.0f32;
    let mut kept = 0usize;
    for index in 0..contacts.len() {
        let support_like = {
            let contact = &contacts[index];
            player_bottom >= contact.aabb_max_y - SUPPORT_CONTACT_EPSILON_M
                && player_bottom <= contact.aabb_max_y + SUPPORT_CONTACT_MARGIN_M
        };
        if support_like {
            continue;
        }

        let to_body = {
            let contact = &contacts[index];
            Vec3d::new(
                contact.center[0] as f64 - position.x,
                0.0,
                contact.center[2] as f64 - position.z,
            )
        };
        let in_front = to_body.norm_squared() < 1e-6 || move_dir.dot(&to_body.normalize()) >= -0.25;
        if !in_front {
            continue;
        }

        if kept != index {
            contacts.swap(kept, index);
        }
        total_mass += contacts[kept].mass.max(0.05);
        kept += 1;
        if kept == MAX_PUSHED_BODIES_PER_TICK {
            break;
        }
    }
    contacts.truncate(kept);

    let kept_contact_count = contacts.len();
    let considered_count = raw_contact_count;
    if contacts.is_empty() || total_mass <= f32::EPSILON {
        return (
            DynamicInteractionStats {
                raw_contact_count,
                considered_count,
                kept_contact_count,
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

    let total_impulse =
        (PLAYER_INTERACTION_MASS as f64 * horizontal_speed * (1.0 - resistance_scale)) as f32;
    let mut weights = Vec::with_capacity(contacts.len());
    let mut total_weight = 0.0f32;
    for contact in contacts.iter() {
        let weight = 1.0 / (0.5 + contact.horizontal_distance_sq.sqrt());
        total_weight += weight;
        weights.push(weight);
    }

    let move_dir_f32 = [move_dir.x as f32, 0.0, move_dir.z as f32];
    let impulses = contacts
        .iter()
        .zip(weights.iter().copied())
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
            raw_contact_count,
            considered_count,
            kept_contact_count,
            pushed_count: impulses.len(),
            contacted_mass: total_mass,
            support_probe_count: 0,
            support_probe_hit_count: 0,
            impulses_applied_count: 0,
        },
        impulses,
    )
}

fn support_pass_hit_dynamic_body(sim: &SimWorld, collisions: &[CharacterCollision]) -> bool {
    collisions
        .iter()
        .any(|collision| sim.is_pushable_dynamic_collider(collision.handle))
}

fn merged_support_filter_allows_dynamic_collider(
    sim: &SimWorld,
    position: &Vec3d,
    vertical_velocity: f64,
    dt: f32,
    handle: ColliderHandle,
    collider: &Collider,
) -> bool {
    if !sim.is_pushable_dynamic_collider(handle) {
        return true;
    }

    let player_bottom =
        position.y as f32 - (sim.config.capsule_half_segment + sim.config.capsule_radius);
    let projected_bottom = player_bottom + (vertical_velocity * dt as f64) as f32;
    let support_probe_slack =
        sim.config.snap_to_ground + sim.config.collision_offset + SUPPORT_SNAP_EXTRA_M;
    let support_window_min = projected_bottom.min(player_bottom) - support_probe_slack;
    let support_window_max = player_bottom + SUPPORT_CONTACT_MARGIN_M;
    let aabb = collider.compute_aabb();
    if aabb.maxs.y < support_window_min - SUPPORT_CONTACT_EPSILON_M
        || aabb.maxs.y > support_window_max
    {
        return false;
    }

    let px = position.x as f32;
    let pz = position.z as f32;
    let dx = if px < aabb.mins.x {
        aabb.mins.x - px
    } else if px > aabb.maxs.x {
        px - aabb.maxs.x
    } else {
        0.0
    };
    let dz = if pz < aabb.mins.z {
        aabb.mins.z - pz
    } else if pz > aabb.maxs.z {
        pz - aabb.maxs.z
    } else {
        0.0
    };
    let horizontal_margin = sim.config.capsule_radius + sim.config.collision_offset + 0.2;
    dx * dx + dz * dz <= horizontal_margin * horizontal_margin
}

fn merged_support_candidate_bounds(
    sim: &SimWorld,
    position: &Vec3d,
    vertical_velocity: f64,
    dt: f32,
) -> ([f32; 3], [f32; 3]) {
    let player_bottom =
        position.y as f32 - (sim.config.capsule_half_segment + sim.config.capsule_radius);
    let projected_bottom = player_bottom + (vertical_velocity * dt as f64) as f32;
    let support_probe_slack =
        sim.config.snap_to_ground + sim.config.collision_offset + SUPPORT_SNAP_EXTRA_M;
    let support_window_min = projected_bottom.min(player_bottom) - support_probe_slack;
    let support_window_max = player_bottom + SUPPORT_CONTACT_MARGIN_M;
    let horizontal_margin = sim.config.capsule_radius + sim.config.collision_offset + 0.2;
    let px = position.x as f32;
    let pz = position.z as f32;
    (
        [
            px - horizontal_margin,
            support_window_min - SUPPORT_CONTACT_EPSILON_M,
            pz - horizontal_margin,
        ],
        [
            px + horizontal_margin,
            support_window_max,
            pz + horizontal_margin,
        ],
    )
}

fn merged_support_filter_needs_dynamic_support(
    sim: &SimWorld,
    query_ctx: &vibe_netcode::sim_world::PlayerQueryContext<'_>,
    position: &Vec3d,
    vertical_velocity: f64,
    dt: f32,
) -> bool {
    let (mins, maxs) = merged_support_candidate_bounds(sim, position, vertical_velocity, dt);
    let predicate = |handle: ColliderHandle, collider: &Collider| {
        merged_support_filter_allows_dynamic_collider(
            sim,
            position,
            vertical_velocity,
            dt,
            handle,
            collider,
        )
    };
    query_ctx.any_pushable_dynamic_body_in_aabb(mins, maxs, &predicate)
}

fn stabilize_dynamic_support(
    sim: &SimWorld,
    query_ctx: &vibe_netcode::sim_world::PlayerQueryContext<'_>,
    position: &mut Vec3d,
    velocity: &mut Vec3d,
    dt: f32,
    should_probe: bool,
) -> bool {
    if !should_probe || velocity.y > 0.0 {
        return false;
    }
    let max_probe = sim.config.snap_to_ground + sim.config.collision_offset + SUPPORT_SNAP_EXTRA_M;
    let Some(support) = query_ctx.probe_dynamic_support(position, max_probe) else {
        return false;
    };
    let support_height = sim.config.capsule_half_segment + sim.config.capsule_radius;
    let desired_y = support.aabb_max_y as f64 + support_height as f64;
    let current_y = position.y;
    if (current_y - desired_y).abs() > (max_probe as f64 + 0.08) {
        return true;
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
    true
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
    let query_ctx_started = now_marker();
    let query_ctx = sim.player_query_context(collider_handle);
    result.timings.query_ctx_ms = elapsed_ms(query_ctx_started);

    let capture_support_collisions = velocity.y <= 0.0;
    let vertical_velocity = velocity.y;
    let should_use_dynamic_support_filter = capture_support_collisions
        && merged_support_filter_needs_dynamic_support(
            sim,
            &query_ctx,
            position,
            vertical_velocity,
            dt,
        );
    let mut merged_collisions = Vec::new();
    let merged_started = now_marker();
    if should_use_dynamic_support_filter {
        let filter_position = *position;
        let predicate = |handle: ColliderHandle, collider: &Collider| {
            merged_support_filter_allows_dynamic_collider(
                sim,
                &filter_position,
                vertical_velocity,
                dt,
                handle,
                collider,
            )
        };
        query_ctx.move_character_with_support_predicate(
            position,
            velocity,
            on_ground,
            dt,
            &predicate,
            Some(&mut merged_collisions),
        );
    } else {
        query_ctx.move_character_horizontal(position, velocity, on_ground, dt);
    }
    result.timings.kcc_merged_ms = elapsed_ms(merged_started);
    let touched_dynamic_support = should_use_dynamic_support_filter
        && *on_ground
        && support_pass_hit_dynamic_body(sim, &merged_collisions);
    let used_dynamic_support_filter = should_use_dynamic_support_filter;

    let support_probe_started = now_marker();
    let should_probe_dynamic_support =
        touched_dynamic_support || used_dynamic_support_filter && velocity.y <= 0.0;
    let support_probe_hit = stabilize_dynamic_support(
        sim,
        &query_ctx,
        position,
        velocity,
        dt,
        should_probe_dynamic_support,
    );
    if support_probe_hit {
        *on_ground = true;
    }
    if should_probe_dynamic_support {
        result.dynamic_stats.support_probe_count = 1;
        if support_probe_hit {
            result.dynamic_stats.support_probe_hit_count = 1;
        }
        result.timings.support_probe_ms = elapsed_ms(support_probe_started);
    }
    result.timings.kcc_query_ms = result.timings.query_ctx_ms
        + result.timings.kcc_horizontal_ms
        + result.timings.kcc_support_ms
        + result.timings.kcc_merged_ms
        + result.timings.support_probe_ms;

    let dynamic_started = now_marker();
    let mut dynamic_contacts = Vec::new();
    let (mut dynamic_stats, dynamic_impulses) = apply_dynamic_interaction(
        sim,
        &query_ctx,
        start_position,
        position,
        velocity,
        &mut dynamic_contacts,
        &mut result.timings,
    );
    dynamic_stats.support_probe_count = result.dynamic_stats.support_probe_count;
    dynamic_stats.support_probe_hit_count = result.dynamic_stats.support_probe_hit_count;
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
        sim.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![50.0, 0.5, 50.0], 0);
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
            tick_player(
                &mut sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &idle,
                1.0 / 60.0,
            );
        }
        assert!(on_ground, "should be grounded after settling");

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..30 {
            tick_player(
                &mut sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &fwd,
                1.0 / 60.0,
            );
        }
        assert!(pos.z > 0.5, "should have moved forward, got z={}", pos.z);
    }

    #[test]
    fn one_pass_without_dynamic_support_skips_support_probe() {
        let mut sim = sim_with_ground();
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        for _ in 0..120 {
            simulate_player_tick(
                &sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &input(),
                1.0 / 60.0,
            );
            sim.sync_player_collider(collider, &pos);
        }

        let result = simulate_player_tick(
            &sim,
            collider,
            &mut pos,
            &mut vel,
            &mut yaw,
            &mut pitch,
            &mut on_ground,
            &input(),
            1.0 / 60.0,
        );

        assert!(on_ground, "player should remain grounded on static floor");
        assert_eq!(
            result.dynamic_stats.support_probe_count, 0,
            "one-pass KCC should skip dynamic support probing when no dynamic body qualifies"
        );
        assert_eq!(result.dynamic_stats.support_probe_hit_count, 0);
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
            tick_player(
                &mut sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &idle,
                1.0 / 60.0,
            );
        }
        assert!(on_ground);
        let ground_y = pos.y;

        let mut jump = input();
        jump.buttons = BTN_JUMP;
        tick_player(
            &mut sim,
            collider,
            &mut pos,
            &mut vel,
            &mut yaw,
            &mut pitch,
            &mut on_ground,
            &jump,
            1.0 / 60.0,
        );
        assert!(vel.y > 0.0, "jump should give positive y velocity");

        let idle = input();
        for _ in 0..10 {
            tick_player(
                &mut sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &idle,
                1.0 / 60.0,
            );
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
                tick_player(
                    &mut sim,
                    collider,
                    &mut pos,
                    &mut vel,
                    &mut yaw,
                    &mut pitch,
                    &mut on_ground,
                    &idle,
                    1.0 / 60.0,
                );
            }
            let mut fwd = input();
            fwd.move_y = 127;
            fwd.buttons = BTN_SPRINT;
            for _ in 0..60 {
                tick_player(
                    &mut sim,
                    collider,
                    &mut pos,
                    &mut vel,
                    &mut yaw,
                    &mut pitch,
                    &mut on_ground,
                    &fwd,
                    1.0 / 60.0,
                );
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
        sim.add_static_cuboid(vector![0.0, 2.5, 3.0], vector![10.0, 5.0, 0.5], 0);
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        let idle = input();
        for _ in 0..60 {
            tick_player(
                &mut sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &idle,
                1.0 / 60.0,
            );
        }

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..120 {
            tick_player(
                &mut sim,
                collider,
                &mut pos,
                &mut vel,
                &mut yaw,
                &mut pitch,
                &mut on_ground,
                &fwd,
                1.0 / 60.0,
            );
        }

        assert!(pos.z < 3.0, "should be stopped by wall, got z={}", pos.z);
        assert!(pos.z > 0.5, "should have moved toward wall");
    }
}
