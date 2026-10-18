//! The driven car's presentation: the web's `physics/vehiclePresentation.ts`, ported.
//!
//! The server simulates the car (PhysX Vehicle2) and acknowledges each input frame it applied. The
//! driver should not wait a round trip to see the car answer the stick, so the client replays its
//! unacknowledged inputs on a bounded proxy from the newest authoritative state: the same steering
//! slew, pedal acceleration, grip-limited yaw and braking as the web, swept against the static
//! world so it cannot drive through it, at most 0.4 s of inputs, and frozen (not invented) when the
//! server goes quiet for 500 ms. When a new authoritative state arrives the visual error is kept
//! and decays over 80 ms, unless it is an impact or teleport (over 0.35 m or 0.5 rad).
//!
//! Server space throughout (Y up, metres, forward +Z). The static world is the city's flat
//! terrain at y = 0: on `/city` the web sweeps against its terrain only (city colliders are an
//! opt-in it measured worse, `gameRuntime.ts`).

use glam::{Quat, Vec3};
use vibe_land_shared::constants::BTN_JUMP;
use vibe_land_shared::protocol::InputFrame;

const DT: f32 = 1.0 / 60.0;
pub const MAX_VEHICLE_LEAD_S: f32 = 0.25;
pub const MAX_DRIVER_LEAD_S: f32 = 0.4;
const MAX_PENDING: usize = 128;
const STALL_MS: f64 = 500.0;
const HARD_ERROR_M: f32 = 0.35;
const HARD_ERROR_RAD: f32 = 0.5;
const ERROR_DECAY_S: f32 = 0.08;

fn newer(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

/// The car as the proxy sees it (`vehicleProxy`).
#[derive(Clone, Debug, PartialEq)]
pub struct VehicleProxy {
    pub half: Vec3,
    pub wheels: Vec<Vec3>,
    pub radius: f32,
    pub wheelbase: f32,
    pub acceleration: f32,
    pub speed: f32,
    pub grip: f32,
    pub braking: f32,
    pub lock: f32,
    pub response: f32,
}

impl VehicleProxy {
    /// A stock car (`getSharedVehicleDefinition`): the shared definition, the web's constants.
    pub fn stock(vehicle_type: u8) -> Self {
        let d = vibe_land_shared::vehicle::vehicle_definition(vehicle_type);
        let wheels = d
            .wheel_offsets
            .iter()
            .map(|p| Vec3::new(p[0], -0.17 - d.suspension_travel_m * 2.0 / 3.0, p[2]))
            .collect();
        Self {
            half: Vec3::from_array(d.chassis_half_extents),
            wheels,
            radius: d.wheel_radius_m,
            wheelbase: (d.wheel_offsets[0][2] - d.wheel_offsets[2][2]).abs(),
            acceleration: 8.57,
            speed: 30.0,
            grip: 1.4,
            braking: 1.0,
            lock: 0.5,
            response: 1.0,
        }
    }

    /// A garage-built car: its configuration's dimensions, its prepared driving (the server's
    /// `PreparedDriving`, which the web resolves the same way) and its wheel centres (actor frame,
    /// from its metadata).
    pub fn custom(
        configuration: &serde_json::Value,
        driving: &serde_json::Value,
        wheel_centres: &[[f32; 3]; 4],
    ) -> Option<Self> {
        let num =
            |v: Option<&serde_json::Value>| v.and_then(serde_json::Value::as_f64).map(|x| x as f32);
        let dims = configuration.get("dimensions")?;
        let (track, wheelbase, tyre) = (
            num(dims.get("track"))?,
            num(dims.get("wheelbase"))?,
            num(dims.get("tireRadius"))?,
        );
        Some(Self {
            half: Vec3::new(track * 0.35, 0.2, wheelbase * 0.5),
            wheels: wheel_centres.iter().map(|w| Vec3::from_array(*w)).collect(),
            radius: tyre,
            wheelbase,
            acceleration: num(driving.get("acceleration"))?,
            speed: num(driving.get("topSpeed"))?,
            grip: num(driving.get("tyreFriction"))?,
            braking: num(configuration.get("driving").and_then(|d| d.get("braking")))
                .unwrap_or(1.0),
            lock: num(driving.get("maxSteerRadians"))?,
            response: num(driving.get("steeringResponse"))?,
        })
    }
}

/// A sweep against the static world: the fraction of `delta` before contact, and the normal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub fraction: f32,
    pub normal: Vec3,
}

/// The city's flat terrain at y = 0: an oriented box (`radius` 0) or a sphere (`radius` > 0) at
/// `position` moving by `delta`. Like parry's shape cast with stop-at-penetration: a shape already
/// touching and moving in is stopped at once.
pub fn sweep_ground(
    position: Vec3,
    rotation: Quat,
    delta: Vec3,
    half: Vec3,
    radius: f32,
) -> Option<Hit> {
    let lowest = if radius > 0.0 {
        position.y - radius
    } else {
        let mut low = f32::INFINITY;
        for sx in [-1.0, 1.0] {
            for sy in [-1.0, 1.0] {
                for sz in [-1.0, 1.0] {
                    low = low.min(
                        (position + rotation * Vec3::new(sx * half.x, sy * half.y, sz * half.z)).y,
                    );
                }
            }
        }
        low
    };
    if delta.y >= 0.0 {
        return None;
    }
    let fraction = if lowest <= 0.0 {
        0.0
    } else {
        lowest / -delta.y
    };
    (fraction <= 1.0).then_some(Hit {
        fraction,
        normal: Vec3::Y,
    })
}

/// Sweeps the chassis and four coarse wheel spheres; up to three contact planes (`moveVehicle`).
pub fn move_vehicle(
    position: Vec3,
    rotation: Quat,
    delta: Vec3,
    proxy: &VehicleProxy,
) -> (Vec3, Vec<Vec3>) {
    let mut at = position;
    let mut remaining = delta;
    let mut normals: Vec<Vec3> = Vec::new();
    let offsets: Vec<Vec3> = std::iter::once(Vec3::ZERO)
        .chain(proxy.wheels.iter().map(|w| rotation * *w))
        .collect();
    for _ in 0..3 {
        if remaining.length_squared() <= 1e-12 {
            break;
        }
        let mut first: Option<Hit> = None;
        for (i, offset) in offsets.iter().enumerate() {
            let mut hit = sweep_ground(
                at + *offset,
                rotation,
                remaining,
                proxy.half,
                if i == 0 { 0.0 } else { proxy.radius },
            );
            if let Some(h) = hit {
                if h.normal.y > 0.45 {
                    // Wheels roll over road features through the suspension: guard descending
                    // contact vertically, keep travel up a ramp.
                    hit = (remaining.y < 0.0).then_some(Hit {
                        fraction: h.fraction,
                        normal: Vec3::Y,
                    });
                } else if i > 0 {
                    // Nor does a wheel stop the car sideways: only the chassis collides.
                    hit = None;
                }
            }
            if let Some(h) = hit {
                if h.fraction.is_finite()
                    && (0.0..=1.0).contains(&h.fraction)
                    && h.normal.dot(remaining) < -1e-5
                    && !normals.iter().any(|n| n.dot(h.normal) > 0.995)
                    && first.is_none_or(|f| h.fraction < f.fraction)
                {
                    first = Some(h);
                }
            }
        }
        let Some(hit) = first else {
            at += remaining;
            break;
        };
        at += remaining * hit.fraction;
        remaining *= 1.0 - hit.fraction;
        let n = hit.normal.normalize();
        remaining -= n * remaining.dot(n).min(0.0);
        normals.push(n);
    }
    (at, normals)
}

/// An authoritative (or predicted) car state, server space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CarSample {
    pub server_time_us: f64,
    pub position: Vec3,
    pub rotation: Quat,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
}

#[derive(Clone, Copy, Debug)]
struct Motion {
    sample: CarSample,
    steering: f32,
}

fn step(m: Motion, dt: f32, proxy: &VehicleProxy, input: Option<&InputFrame>) -> Motion {
    let s = m.sample;
    let rotation = s.rotation.normalize();
    let mut velocity = s.linear_velocity;
    // Probe only a few cm: do not glue a jumping car to the road below it.
    let (_, support) = move_vehicle(s.position, rotation, Vec3::new(0.0, -0.04, 0.0), proxy);
    let grounded = support.iter().any(|n| n.y > 0.45);
    let forward = rotation * Vec3::Z;
    let speed = velocity.dot(forward);
    let mut steering = m.steering;
    let mut angular = s.angular_velocity;
    if let (Some(input), true) = (input, grounded) {
        let t = ((speed.abs() - 6.0) / 22.0).clamp(0.0, 1.0);
        let lock = 1.0 - 0.65 * t * t * (3.0 - 2.0 * t);
        let target = -(f32::from(input.move_x) / 127.0) * lock;
        let slew = (if target.abs() > steering.abs() {
            5.0
        } else {
            8.0
        }) * proxy.response
            * dt;
        steering += (target - steering).clamp(-slew, slew);
        let pedal = f32::from(input.move_y) / 127.0;
        let handbrake = input.buttons & BTN_JUMP != 0;
        let braking = handbrake || (pedal * speed < 0.0 && speed.abs() > 1.0);
        let acceleration = if braking {
            -speed.signum()
                * (speed.abs() / dt)
                    .min(proxy.grip * 9.81 * if handbrake { 0.5 } else { proxy.braking })
        } else {
            pedal
                * proxy.acceleration
                * (1.0 - speed.abs() / if pedal < 0.0 { 8.0 } else { proxy.speed }).max(0.0)
        };
        velocity += forward * (acceleration * dt);
        // Keep the authoritative slip, roll and pitch; only ease yaw toward the steering model.
        let limit = proxy.grip * 9.81 / speed.abs().max(2.0);
        let yaw = (speed * (steering * proxy.lock).tan() / proxy.wheelbase).clamp(-limit, limit);
        angular.y += (yaw - angular.y) * (1.0 - (-8.0 * dt).exp());
        let turn = Quat::from_axis_angle(Vec3::Y, angular.y * dt);
        let horizontal = turn * Vec3::new(velocity.x, 0.0, velocity.z);
        velocity.x = horizontal.x;
        velocity.z = horizontal.z;
    }
    let gravity_delta = if grounded { 0.0 } else { 9.81 * dt };
    velocity.y -= gravity_delta;
    let mut displacement = velocity * dt;
    displacement.y += gravity_delta * dt * 0.5;
    let (position, normals) = move_vehicle(s.position, rotation, displacement, proxy);
    for n in normals {
        velocity -= n * velocity.dot(n).min(0.0);
    }
    let angle = angular.length() * dt;
    let rotation = if angle > 0.0 {
        (Quat::from_axis_angle(angular.normalize(), angle) * rotation).normalize()
    } else {
        rotation
    };
    Motion {
        sample: CarSample {
            server_time_us: s.server_time_us + f64::from(dt) * 1e6,
            position,
            rotation,
            linear_velocity: velocity,
            angular_velocity: angular,
        },
        steering,
    }
}

/// Input-ack replay for the driver (`VehiclePresentationPredictor`).
#[derive(Default)]
pub struct VehiclePredictor {
    handle: Option<u32>,
    pending: Vec<InputFrame>,
    base: Option<CarSample>,
    raw: Option<CarSample>,
    offset: Vec3,
    rotation_offset: Quat,
    ack: Option<u16>,
    observed_ms: f64,
    steering: f32,
    stalled: bool,
    proxy: Option<VehicleProxy>,
}

impl VehiclePredictor {
    pub fn reset(&mut self) {
        *self = Self {
            rotation_offset: Quat::IDENTITY,
            ..Default::default()
        };
    }

    fn select(&mut self, handle: u32) {
        if self.handle != Some(handle) {
            self.reset();
            self.handle = Some(handle);
        }
    }

    /// Input frames just sent while driving `handle`.
    pub fn record(&mut self, handle: u32, inputs: &[InputFrame]) {
        self.select(handle);
        for input in inputs {
            if self.ack.is_none_or(|ack| newer(input.seq, ack)) {
                self.pending.push(input.clone());
            }
        }
        if self.pending.len() > MAX_PENDING {
            let excess = self.pending.len() - MAX_PENDING;
            self.pending.drain(..excess);
        }
    }

    /// A new authoritative state of the driven car, with the newest input the server applied.
    pub fn observe(
        &mut self,
        handle: u32,
        sample: CarSample,
        ack: u16,
        proxy: VehicleProxy,
        now_ms: f64,
    ) {
        self.select(handle);
        if self
            .base
            .is_some_and(|b| sample.server_time_us <= b.server_time_us)
        {
            return;
        }
        if self.ack.is_some_and(|a| ack != a && !newer(ack, a)) {
            return;
        }
        self.raw = self.replay();
        let previous = self.pose();
        self.pending.retain(|i| newer(i.seq, ack));
        self.ack = Some(ack);
        self.base = Some(sample);
        self.observed_ms = now_ms;
        self.stalled = false;
        let speed = sample.linear_velocity.length();
        self.steering = if speed > 1.0 {
            (sample.angular_velocity.y * proxy.wheelbase / speed).atan() / proxy.lock
        } else {
            0.0
        };
        self.proxy = Some(proxy);
        self.raw = self.replay();
        if let (Some((pp, pq)), Some(raw)) = (previous, self.raw) {
            self.offset = pp - raw.position;
            if self.offset.length() > HARD_ERROR_M {
                self.offset = Vec3::ZERO; // an impact or teleport: the server wins
            }
            self.rotation_offset = (pq * raw.rotation.inverse()).normalize();
            if self.rotation_offset.angle_between(Quat::IDENTITY) > HARD_ERROR_RAD {
                self.rotation_offset = Quat::IDENTITY;
            }
        }
    }

    /// Advance the presentation by `dt_s` (the error decays).
    pub fn update(&mut self, dt_s: f32, now_ms: f64) {
        self.stalled = now_ms - self.observed_ms > STALL_MS;
        if !self.stalled {
            self.raw = self.replay();
        }
        let decay = (-dt_s.max(0.0) / ERROR_DECAY_S).exp();
        self.offset *= decay;
        self.rotation_offset = self.rotation_offset.slerp(Quat::IDENTITY, 1.0 - decay);
    }

    fn replay(&self) -> Option<CarSample> {
        let (base, proxy) = (self.base?, self.proxy.as_ref()?);
        let count = ((MAX_DRIVER_LEAD_S / DT).round() as usize).min(self.pending.len());
        let mut motion = Motion {
            sample: base,
            steering: self.steering,
        };
        for input in &self.pending[..count] {
            motion = step(motion, DT, proxy, Some(input));
        }
        Some(motion.sample)
    }

    /// The car as drawn: the replayed state plus the decaying visual error (swept, so the error
    /// cannot drag the car through the ground). Server space.
    pub fn pose(&self) -> Option<(Vec3, Quat)> {
        let (raw, proxy) = (self.raw?, self.proxy.as_ref()?);
        let (position, _) = move_vehicle(raw.position, raw.rotation, self.offset, proxy);
        Some((position, (self.rotation_offset * raw.rotation).normalize()))
    }

    pub fn handle(&self) -> Option<u32> {
        self.handle
    }

    pub fn pending(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy() -> VehicleProxy {
        VehicleProxy::stock(0)
    }

    fn resting(proxy: &VehicleProxy) -> CarSample {
        // Wheels just touching the ground.
        let lowest_wheel = proxy
            .wheels
            .iter()
            .map(|w| w.y)
            .fold(f32::INFINITY, f32::min);
        CarSample {
            server_time_us: 0.0,
            position: Vec3::new(0.0, proxy.radius - lowest_wheel, 0.0),
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
        }
    }

    fn throttle(seq: u16) -> InputFrame {
        InputFrame {
            seq,
            move_y: 127,
            ..Default::default()
        }
    }

    #[test]
    fn the_ground_stops_a_falling_car_and_lets_it_drive_along() {
        let p = proxy();
        let s = resting(&p);
        let (at, normals) = move_vehicle(
            s.position + Vec3::Y,
            s.rotation,
            Vec3::new(0.0, -5.0, 0.0),
            &p,
        );
        assert!((at.y - s.position.y).abs() < 1e-4, "{at} vs {}", s.position);
        assert_eq!(normals, vec![Vec3::Y]);
        let (at, _) = move_vehicle(s.position, s.rotation, Vec3::new(0.0, -0.01, 2.0), &p);
        assert!(
            (at.z - 2.0).abs() < 1e-4 && (at.y - s.position.y).abs() < 1e-4,
            "{at}"
        );
    }

    #[test]
    fn throttle_accelerates_forward_and_the_replay_leads_the_server() {
        let p = proxy();
        let mut predictor = VehiclePredictor::default();
        predictor.reset();
        let inputs: Vec<InputFrame> = (1..=24).map(throttle).collect();
        predictor.record(7, &inputs);
        predictor.observe(7, resting(&p), 0, p.clone(), 0.0);
        let (at, _) = predictor.pose().unwrap();
        // 24 frames (0.4 s) at the proxy's 8.57 m/s^2: about 0.5 * 8.57 * 0.4^2 = 0.69 m.
        assert!(at.z > 0.5 && at.z < 0.8, "led to z = {}", at.z);
        assert!(at.x.abs() < 1e-3);
        // The server acks 12 of them and reports the car where the replay had it then: no jump.
        let mut acked = resting(&p);
        let mut m = Motion {
            sample: acked,
            steering: 0.0,
        };
        for input in &inputs[..12] {
            m = step(m, DT, &p, Some(input));
        }
        acked = m.sample;
        predictor.observe(7, acked, 12, p.clone(), 200.0);
        assert_eq!(predictor.pending(), 12);
        let (after, _) = predictor.pose().unwrap();
        assert!((after - at).length() < 1e-3, "{at} -> {after}");
    }

    #[test]
    fn a_large_correction_snaps_and_a_small_one_decays() {
        let p = proxy();
        let mut predictor = VehiclePredictor::default();
        predictor.reset();
        predictor.observe(1, resting(&p), 0, p.clone(), 0.0);
        let mut moved = resting(&p);
        moved.server_time_us = 1.0;
        moved.position.x += 0.2;
        predictor.observe(1, moved, 0, p.clone(), 16.0);
        let (drawn, _) = predictor.pose().unwrap();
        assert!(
            (drawn.x - 0.0).abs() < 1e-4,
            "small errors are kept, then decay"
        );
        predictor.update(0.08, 32.0);
        let (decayed, _) = predictor.pose().unwrap();
        assert!(
            (decayed.x - (0.2 - 0.2 / std::f32::consts::E)).abs() < 1e-3,
            "{decayed}"
        );
        let mut far = moved;
        far.server_time_us = 2.0;
        far.position.x += 3.0;
        predictor.observe(1, far, 0, p.clone(), 48.0);
        assert!(
            (predictor.pose().unwrap().0.x - far.position.x).abs() < 1e-4,
            "an impact snaps"
        );
    }

    #[test]
    fn steering_left_turns_left_and_a_quiet_server_freezes_the_replay() {
        let p = proxy();
        let mut predictor = VehiclePredictor::default();
        predictor.reset();
        let mut s = resting(&p);
        s.linear_velocity = Vec3::new(0.0, 0.0, 10.0);
        let inputs: Vec<InputFrame> = (1..=24)
            .map(|q| InputFrame {
                seq: q,
                move_x: -127,
                move_y: 60,
                ..Default::default()
            })
            .collect();
        predictor.record(2, &inputs);
        predictor.observe(2, s, 0, p.clone(), 0.0);
        let (_, rotation) = predictor.pose().unwrap();
        // Server space: positive yaw turns forward (+Z) toward +X, and the web's left (moveX < 0)
        // steers that way (target = -moveX).
        let heading = (rotation * Vec3::Z).x;
        assert!(heading > 0.01, "turned {heading}");
        predictor.update(0.016, 600.0);
        let frozen = predictor.pose().unwrap();
        predictor.record(
            2,
            &[InputFrame {
                seq: 25,
                move_y: 127,
                ..Default::default()
            }],
        );
        predictor.update(0.016, 700.0);
        assert_eq!(
            predictor.pose().unwrap().0,
            frozen.0,
            "no new inputs drawn while the server is quiet"
        );
    }
    /// The web's predictor (physics/vehiclePresentation.ts) on the same scenario, computed with tsx
    /// by client/scripts/vehicle-predictor-fixture.mts: a stock car at 8 m/s, 30 inputs (left then
    /// right, throttle then brake, handbrake), swept against the flat terrain.
    #[test]
    fn matches_the_web_predictor() {
        let p = proxy();
        let lowest = p.wheels.iter().map(|w| w.y).fold(f32::INFINITY, f32::min);
        let sample = CarSample {
            server_time_us: 0.0,
            position: Vec3::new(0.0, p.radius - lowest, 0.0),
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::new(0.0, 0.0, 8.0),
            angular_velocity: Vec3::ZERO,
        };
        let inputs: Vec<InputFrame> = (0..30u16)
            .map(|i| InputFrame {
                seq: i + 1,
                buttons: if i > 20 { BTN_JUMP } else { 0 },
                move_x: if i < 10 { -127 } else { 64 },
                move_y: if i < 15 { 127 } else { -90 },
                yaw: 0.0,
                pitch: 0.0,
            })
            .collect();
        let mut predictor = VehiclePredictor::default();
        predictor.reset();
        predictor.record(3, &inputs);
        predictor.observe(3, sample, 0, p, 0.0);
        let (position, rotation) = predictor.pose().unwrap();
        let web_position = Vec3::new(0.3322918747996268, 0.6533333361148834, 3.4476914461825596);
        let web_rotation = Quat::from_xyzw(0.0, 0.09733803773055195, 0.0, 0.9952513785023187);
        assert!(
            (position - web_position).length() < 1e-5,
            "{position} vs the web's {web_position}"
        );
        assert!(
            rotation.angle_between(web_rotation) < 1e-4,
            "{rotation} vs the web's {web_rotation}"
        );
    }
}
