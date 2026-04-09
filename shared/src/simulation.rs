// Re-export the generic KCC collision world from the netcode library.
pub use vibe_netcode::sim_world::SimWorld;

use rapier3d::control::CharacterCollision;
use rapier3d::prelude::ColliderHandle;

use crate::constants::*;
use crate::movement::*;
use crate::protocol::InputCmd;

/// Run one simulation step for a single player using game-specific input.
///
/// This is the game-specific wrapper around `SimWorld::move_character`.  It
/// translates `InputCmd` (button flags, analog axes, yaw/pitch) into the
/// generic movement math, then delegates the KCC step to the library.
///
/// Updates `position`, `velocity`, `yaw`, `pitch`, and `on_ground` in place.
/// Returns the full collision list (needed by `solve_character_collision_impulses`).
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
) -> Vec<CharacterCollision> {
    let cfg = &sim.config;
    let dt64 = dt as f64;

    // Phase 1: orientation + movement math (all f64)
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

    // Phase 2: Rapier KCC (delegated to generic netcode)
    sim.move_character(collider_handle, position, velocity, on_ground, dt)
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
