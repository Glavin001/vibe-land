//! How a body moves between keyframes: the one predictor the server's error
//! model and the client both run.
//!
//! It follows the physics the server runs, not a textbook: PhysX integrates
//! velocity then position each step (semi-implicit Euler), so after `n` ticks
//! of free flight a body is at `p + v t + g dt^2 n (n + 1) / 2`, not `+ g t^2
//! / 2` (they differ by about a centimetre over 8 ticks). Spin is constant:
//! the server runs without gyroscopic forces and with no damping, so angular
//! velocity does not change in flight (docs/netcode-lab.md, deviation 2).

use glam::{Quat, Vec3};

/// How the client predicts a body from a keyframe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Mode {
    /// Free flight: gravity, constant spin.
    #[default]
    Ballistic = 0,
    /// Sliding or rolling on a surface: constant velocity, no gravity.
    Sliding = 1,
    /// Momentarily still: the pose held.
    Resting = 2,
    /// Sliding to a stop: slowing along its velocity at `decel` until it
    /// stops, spin slowing with it; no gravity (it is supported).
    Friction = 3,
    /// A car driving: its velocity held in its own frame, so it turns with
    /// its spin (a steady turn is an arc); no gravity. IEEE 1278.1 dead
    /// reckoning DRM (R,P,B), algorithm 7. Car records only: on the wire it is Sliding
    /// with a bit in the car's wheel block.
    Turning = 4,
}

impl Mode {
    /// The two bits the wire's flags carry (Turning rides as Sliding).
    pub fn wire_bits(self) -> u8 {
        match self {
            Mode::Turning => Mode::Sliding as u8,
            m => m as u8,
        }
    }

    pub fn from_u8(value: u8) -> Self {
        match value & 3 {
            1 => Mode::Sliding,
            2 => Mode::Resting,
            3 => Mode::Friction,
            _ => Mode::Ballistic,
        }
    }
}

/// A body's state at a tick, as the stream carries it.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Keyframe {
    pub tick: u32,
    pub position: Vec3,
    pub rotation: Quat,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub mode: Mode,
    /// Friction mode: how fast the body slows along its velocity, m/s^2.
    pub decel: f32,
    /// How far the body's centre can fall from `position` before its lowest
    /// corner reaches the ground (y = 0); None when unknown. Not on the
    /// wire: the client and the server's model of it each derive it from
    /// the body's chunks at the keyframe's pose (`structure::floor_drop`),
    /// so a late keyframe never draws a body through the ground.
    pub floor_drop: Option<f32>,
}

/// The simulation's step and gravity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Physics {
    pub dt: f32,
    pub gravity: Vec3,
}

impl Physics {
    pub fn at_hz(hz: u32, gravity_y: f32) -> Self {
        Self { dt: 1.0 / hz.max(1) as f32, gravity: Vec3::new(0.0, gravity_y, 0.0) }
    }
}

/// The pose `ticks` after the keyframe (fractional ticks interpolate the
/// same polynomial, which passes through every whole tick exactly).
pub fn predict(keyframe: &Keyframe, ticks: f32, physics: Physics) -> (Vec3, Quat) {
    let (mut p, q) = predict_free(keyframe, ticks, physics);
    if let Some(floor) = floor_y(keyframe) {
        p.y = p.y.max(floor);
    }
    (p, q)
}

/// The lowest the body's centre may be drawn: resting on the ground.
fn floor_y(keyframe: &Keyframe) -> Option<f32> {
    keyframe.floor_drop.map(|d| keyframe.position.y - d.max(0.0))
}

fn predict_free(keyframe: &Keyframe, ticks: f32, physics: Physics) -> (Vec3, Quat) {
    let n = ticks.max(0.0);
    let t = n * physics.dt;
    match keyframe.mode {
        Mode::Resting => (keyframe.position, keyframe.rotation),
        Mode::Sliding => (keyframe.position + keyframe.linear_velocity * t, spin(keyframe, t)),
        Mode::Turning => (keyframe.position + turned(keyframe.linear_velocity, keyframe.angular_velocity, t), spin(keyframe, t)),
        Mode::Friction => {
            let (travel, spun) = friction(keyframe, t);
            (keyframe.position + keyframe.linear_velocity.normalize_or_zero() * travel, spin(keyframe, spun))
        }
        Mode::Ballistic => {
            let fall = physics.gravity * (physics.dt * physics.dt * n * (n + 1.0) * 0.5);
            (keyframe.position + keyframe.linear_velocity * t + fall, spin(keyframe, t))
        }
    }
}

/// The velocity `ticks` after the keyframe.
pub fn predict_velocity(keyframe: &Keyframe, ticks: f32, physics: Physics) -> Vec3 {
    let mut v = predict_velocity_free(keyframe, ticks, physics);
    // On the ground: no longer falling.
    if let Some(floor) = floor_y(keyframe) {
        if predict_free(keyframe, ticks, physics).0.y <= floor {
            v.y = v.y.max(0.0);
        }
    }
    v
}

fn predict_velocity_free(keyframe: &Keyframe, ticks: f32, physics: Physics) -> Vec3 {
    match keyframe.mode {
        Mode::Resting => Vec3::ZERO,
        Mode::Sliding => keyframe.linear_velocity,
        Mode::Turning => turn(keyframe.linear_velocity, keyframe.angular_velocity, ticks.max(0.0) * physics.dt),
        Mode::Friction => {
            let speed = keyframe.linear_velocity.length();
            let left = (speed - keyframe.decel.max(0.0) * ticks.max(0.0) * physics.dt).max(0.0);
            keyframe.linear_velocity.normalize_or_zero() * left
        }
        Mode::Ballistic => keyframe.linear_velocity + physics.gravity * (ticks.max(0.0) * physics.dt),
    }
}

/// Distance slid and the equivalent time at the initial spin after `t`
/// seconds of slowing at `decel` (stopped once the speed is spent).
fn friction(keyframe: &Keyframe, t: f32) -> (f32, f32) {
    let speed = keyframe.linear_velocity.length();
    let decel = keyframe.decel.max(1e-3);
    let stop = speed / decel;
    let t = t.min(stop);
    let travel = speed * t - 0.5 * decel * t * t;
    // Spin slows in proportion (rolling): the angle turned is the initial
    // rate over the same "effective" time the distance implies.
    let spun = if speed > 1e-4 { travel / speed } else { t.min(stop) };
    (travel, spun)
}

/// How far a velocity `v` held in a body spinning at `w` carries it in `t`
/// seconds: the integral of `v` turned by the spin so far (Rodrigues), the
/// (R,P,B) position term of IEEE 1278.1.
fn turned(v: Vec3, w: Vec3, t: f32) -> Vec3 {
    let omega = w.length();
    let theta = omega * t;
    if theta < 1e-4 {
        return v * t + w.cross(v) * (0.5 * t * t);
    }
    let n = w / omega;
    let along = n * n.dot(v);
    along * t + ((v - along) * theta.sin() + n.cross(v) * (1.0 - theta.cos())) / omega
}

/// `v` turned by the spin `w` over `t` seconds.
fn turn(v: Vec3, w: Vec3, t: f32) -> Vec3 {
    let theta = w.length() * t;
    if theta < 1e-7 {
        return v;
    }
    Quat::from_axis_angle(w.normalize(), theta) * v
}

fn spin(keyframe: &Keyframe, t: f32) -> Quat {
    let w = keyframe.angular_velocity;
    let angle = w.length() * t;
    if angle < 1e-7 {
        return keyframe.rotation;
    }
    (Quat::from_axis_angle(w.normalize(), angle) * keyframe.rotation).normalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PhysX's step, literally: velocity first, then position.
    fn step(mut p: Vec3, mut v: Vec3, physics: Physics, n: u32) -> Vec3 {
        for _ in 0..n {
            v += physics.gravity * physics.dt;
            p += v * physics.dt;
        }
        p
    }

    #[test]
    fn ballistic_prediction_lands_on_every_physics_step() {
        let physics = Physics::at_hz(60, -9.81);
        let kf = Keyframe {
            tick: 100,
            position: Vec3::new(1.0, 20.0, -3.0),
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::new(4.0, 6.0, 0.5),
            angular_velocity: Vec3::ZERO,
            mode: Mode::Ballistic, decel: 0.0, floor_drop: None,
        };
        for n in [1u32, 8, 60, 240] {
            let stepped = step(kf.position, kf.linear_velocity, physics, n);
            let predicted = predict(&kf, n as f32, physics).0;
            assert!((stepped - predicted).length() < 1e-3, "n {n}: {stepped} vs {predicted}");
        }
        // The textbook parabola is off by g dt t / 2: about a centimetre at 8 ticks.
        let t = 8.0 * physics.dt;
        let textbook = kf.position + kf.linear_velocity * t + 0.5 * physics.gravity * t * t;
        let off = (textbook - predict(&kf, 8.0, physics).0).length();
        assert!((0.005..0.02).contains(&off), "{off}");
    }

    #[test]
    fn a_falling_body_stops_on_the_ground_and_stops_falling() {
        let physics = Physics::at_hz(60, -9.81);
        // Centre 2 m up, lowest corner 1.5 m up: it may fall 1.5 m.
        let kf = Keyframe {
            tick: 0,
            position: Vec3::new(0.0, 2.0, 0.0),
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::new(3.0, -4.0, 0.0),
            angular_velocity: Vec3::ZERO,
            mode: Mode::Ballistic,
            decel: 0.0,
            floor_drop: Some(1.5),
        };
        for n in [0.0f32, 5.0, 20.0, 60.0, 240.0] {
            let (p, _) = predict(&kf, n, physics);
            assert!(p.y >= 0.5 - 1e-6, "tick {n}: {p}");
        }
        assert!((predict(&kf, 60.0, physics).0.y - 0.5).abs() < 1e-6);
        // Horizontal motion carries on; the fall does not.
        assert!(predict(&kf, 60.0, physics).0.x > 2.9);
        assert_eq!(predict_velocity(&kf, 60.0, physics).y, 0.0);
        // Unknown floor: free flight as before.
        let free = Keyframe { floor_drop: None, ..kf };
        assert!(predict(&free, 60.0, physics).0.y < -5.0);
    }

    #[test]
    fn spin_is_constant_and_resting_holds() {
        let physics = Physics::at_hz(60, -9.81);
        let mut kf = Keyframe {
            tick: 0,
            position: Vec3::ZERO,
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::X,
            angular_velocity: Vec3::new(0.0, std::f32::consts::PI, 0.0),
            mode: Mode::Sliding, decel: 0.0, floor_drop: None,
        };
        let (p, q) = predict(&kf, 60.0, physics);
        assert!((p - Vec3::X).length() < 1e-5, "no gravity while sliding");
        assert!((q.dot(Quat::from_rotation_y(std::f32::consts::PI))).abs() > 0.9999);
        kf.mode = Mode::Resting;
        assert_eq!(predict(&kf, 60.0, physics), (Vec3::ZERO, Quat::IDENTITY));
    }
}
