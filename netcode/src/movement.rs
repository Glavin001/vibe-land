pub type Vec3d = nalgebra::Vector3<f64>;

/// Configuration for kinematic character controller movement.
#[derive(Clone, Debug)]
pub struct MoveConfig {
    pub walk_speed: f64,
    pub sprint_speed: f64,
    pub crouch_speed: f64,
    pub ground_accel: f64,
    pub air_accel: f64,
    pub friction: f64,
    pub gravity: f64,
    pub jump_speed: f64,
    pub capsule_half_segment: f32,
    pub capsule_radius: f32,
    pub collision_offset: f32,
    pub max_step_height: f32,
    pub min_step_width: f32,
    pub snap_to_ground: f32,
    pub max_slope_radians: f32,
    pub min_slide_radians: f32,
}

impl Default for MoveConfig {
    fn default() -> Self {
        Self {
            walk_speed: 6.0,
            sprint_speed: 8.5,
            crouch_speed: 3.5,
            ground_accel: 80.0,
            air_accel: 18.0,
            friction: 10.0,
            gravity: 20.0,
            jump_speed: 6.5,
            capsule_half_segment: 0.45,
            capsule_radius: 0.35,
            collision_offset: 0.01,
            max_step_height: 0.55,
            min_step_width: 0.2,
            snap_to_ground: 0.2,
            max_slope_radians: 45_f32.to_radians(),
            min_slide_radians: 30_f32.to_radians(),
        }
    }
}

/// The world's gravity vector, in m/s^2, taken from the same constant the
/// player falls by.
///
/// One world, one gravity. The player runs at 20 m/s^2 -- roughly 2x Earth,
/// and almost exactly the Source engine's `sv_gravity 800` (800 in/s^2 =
/// 20.32 m/s^2) that Half-Life, Counter-Strike and Team Fortress all ship.
/// That is a deliberate, conventional choice: with `jump_speed` 6.5 it gives a
/// 1.06 m jump with 0.65 s of airtime, where real gravity would stretch the
/// same jump to 0.93 s of committed, un-steerable arc.
///
/// What is *not* conventional is applying it to only some of the world. Source
/// applies `sv_gravity` to players, props and ragdolls alike; a barrel in
/// Half-Life 2 falls at 20.3 m/s^2 too. Running the player at 20 and debris at
/// 9.81 leaves the player as the only reference frame the eye has, and
/// everything else reads as falling in slow motion -- an 84 m drop takes 2.9 s
/// at the player's gravity and 4.1 s at Earth's.
pub fn world_gravity(cfg: &MoveConfig) -> [f32; 3] {
    [0.0, -(cfg.gravity as f32), 0.0]
}

/// The default world gravity, for call sites with no config to hand.
pub fn default_world_gravity() -> [f32; 3] {
    world_gravity(&MoveConfig::default())
}

/// Apply ground friction to horizontal velocity.
pub fn apply_horizontal_friction(velocity: &mut Vec3d, friction: f64, dt: f64, on_ground: bool) {
    if !on_ground {
        return;
    }
    let speed = (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
    if speed <= 1e-6 {
        return;
    }
    let drop = speed * friction * dt;
    let new_speed = (speed - drop).max(0.0);
    let ratio = new_speed / speed;
    velocity.x *= ratio;
    velocity.z *= ratio;
}

/// Accelerate velocity toward wish direction at the given speed.
pub fn accelerate(velocity: &mut Vec3d, wish_dir: Vec3d, wish_speed: f64, accel: f64, dt: f64) {
    if wish_dir.norm_squared() <= 0.0001 {
        return;
    }
    let current_speed = velocity.x * wish_dir.x + velocity.z * wish_dir.z;
    let add_speed = (wish_speed - current_speed).max(0.0);
    if add_speed <= 0.0 {
        return;
    }
    let accel_speed = (accel * wish_speed * dt).min(add_speed);
    velocity.x += wish_dir.x * accel_speed;
    velocity.z += wish_dir.z * accel_speed;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friction_reduces_speed() {
        let mut vel = Vec3d::new(5.0, 0.0, 0.0);
        apply_horizontal_friction(&mut vel, 10.0, 1.0 / 60.0, true);
        assert!(vel.x < 5.0);
        assert!(vel.x > 0.0);
    }

    #[test]
    fn friction_no_effect_in_air() {
        let mut vel = Vec3d::new(5.0, 0.0, 0.0);
        apply_horizontal_friction(&mut vel, 10.0, 1.0 / 60.0, false);
        assert!((vel.x - 5.0).abs() < 1e-10);
    }

    #[test]
    fn accelerate_adds_speed() {
        let mut vel = Vec3d::new(0.0, 0.0, 0.0);
        let wish = Vec3d::new(0.0, 0.0, 1.0);
        accelerate(&mut vel, wish, 6.0, 80.0, 1.0 / 60.0);
        assert!(vel.z > 0.0);
    }
}
