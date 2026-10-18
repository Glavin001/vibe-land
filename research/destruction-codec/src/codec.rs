//! Codec primitives. The wire model here is deliberately explicit rather than
//! an entropy estimate: every record is serialized and packet headers are
//! included in reported byte totals.

use glam::{Quat, Vec3};
use serde::Serialize;

use crate::trace::{ActorDef, ActorState, Camera, Pose};

pub const MAX_DATAGRAM: usize = 1150;
pub const DATAGRAM_HEADER: usize = 16;
pub const RELIABLE_HEADER: usize = 12;
pub const FIXED_ACTOR_ID_BYTES: usize = 4;
pub const ABSOLUTE_BYTES: usize = 21; // tag + id + region(3*i16) + pos(3*i16) + quat32
pub const DELTA_BYTES: usize = 15; // tag + id + baseline-relative pos(3*i16) + quat32
pub const MOTION_ABSOLUTE_BYTES: usize = ABSOLUTE_BYTES + 12; // + quantized linear/angular velocity
pub const MOTION_DELTA_BYTES: usize = DELTA_BYTES + 12; // + quantized linear/angular velocity
pub const BALLISTIC_BYTES: usize = 33; // absolute + quantized linear/angular velocity
pub const RAW_STATE_BYTES: usize = 61; // id + pose7 + velocity6 + contacts/joints + flags

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PhysicalClass {
    Quiescent,
    Ballistic,
    ContactActive,
    ImpactBurst,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WireChoice {
    Raw,
    Absolute,
    Delta,
}

#[derive(Clone, Copy, Debug)]
pub struct ClassifierConfig {
    pub enter_ticks: u16,
    pub exit_ticks: u16,
    pub linear_enter: f32,
    pub angular_enter: f32,
    pub linear_exit: f32,
    pub angular_exit: f32,
    pub impact_burst_ticks: u8,
}

impl Default for ClassifierConfig {
    fn default() -> Self {
        Self {
            enter_ticks: 20,
            exit_ticks: 2,
            linear_enter: 0.03,
            angular_enter: 0.04,
            linear_exit: 0.08,
            angular_exit: 0.10,
            impact_burst_ticks: 6,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Classifier {
    class: PhysicalClass,
    quiet_ticks: u16,
    active_ticks: u16,
    free_ticks: u16,
    stable_contacts: u16,
    previous_contacts: u16,
    burst_left: u8,
}

impl Default for Classifier {
    fn default() -> Self {
        Self {
            class: PhysicalClass::ContactActive,
            quiet_ticks: 0,
            active_ticks: 0,
            free_ticks: 0,
            stable_contacts: 0,
            previous_contacts: u16::MAX,
            burst_left: 0,
        }
    }
}

impl Classifier {
    pub fn update(&mut self, state: ActorState, cfg: ClassifierConfig) -> PhysicalClass {
        let contacts_stable =
            state.contacts == self.previous_contacts && state.flags & (4 | 8 | 16 | 32 | 64) == 0;
        self.previous_contacts = state.contacts;
        self.stable_contacts = if contacts_stable {
            self.stable_contacts.saturating_add(1)
        } else {
            0
        };
        if state.flags & (4 | 16 | 64) != 0 {
            self.burst_left = cfg.impact_burst_ticks;
        }

        let speed = state.linear_velocity.length();
        let angular = state.angular_velocity.length();
        let quiet = speed <= cfg.linear_enter
            && angular <= cfg.angular_enter
            && self.stable_contacts >= cfg.enter_ticks
            && !state.kinematic();
        self.quiet_ticks = if quiet {
            self.quiet_ticks.saturating_add(1)
        } else {
            0
        };
        let clearly_active = speed > cfg.linear_exit
            || angular > cfg.angular_exit
            || !contacts_stable
            || state.kinematic();
        self.active_ticks = if clearly_active {
            self.active_ticks.saturating_add(1)
        } else {
            0
        };

        let ballistic_eligible =
            state.contacts == 0 && state.intact_joints == 0 && !state.kinematic();
        self.free_ticks = if ballistic_eligible {
            self.free_ticks.saturating_add(1)
        } else {
            0
        };
        self.class = if self.burst_left > 0 {
            self.burst_left -= 1;
            PhysicalClass::ImpactBurst
        } else if (self.class == PhysicalClass::Quiescent && self.active_ticks < cfg.exit_ticks)
            || self.quiet_ticks >= cfg.enter_ticks
        {
            PhysicalClass::Quiescent
        } else if ballistic_eligible
            && (self.class == PhysicalClass::Ballistic || self.free_ticks >= cfg.exit_ticks)
        {
            PhysicalClass::Ballistic
        } else {
            PhysicalClass::ContactActive
        };
        self.class
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PredictorParams {
    pub gravity: Vec3,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub dt: f32,
    pub steps: u32,
}

pub fn predict_ballistic(
    pose: Pose,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    params: PredictorParams,
) -> (Pose, Vec3, Vec3) {
    let mut pose = pose;
    let mut lv = linear_velocity;
    let mut av = angular_velocity;
    for _ in 0..params.steps {
        // Mirrors common discrete rigid-body integration: acceleration, then
        // rational damping, then semi-implicit position/orientation update.
        lv += params.gravity * params.dt;
        lv *= 1.0 / (1.0 + params.linear_damping * params.dt);
        av *= 1.0 / (1.0 + params.angular_damping * params.dt);
        pose.position += lv * params.dt;
        let angle = av.length() * params.dt;
        if angle > 1e-8 {
            pose.rotation =
                (Quat::from_axis_angle(av.normalize(), angle) * pose.rotation).normalize();
        }
    }
    (pose, lv, av)
}

pub fn quantize_position_cm(value: Vec3) -> [i32; 3] {
    [
        (value.x * 100.0).round() as i32,
        (value.y * 100.0).round() as i32,
        (value.z * 100.0).round() as i32,
    ]
}

pub fn dequantize_position_cm(value: [i32; 3]) -> Vec3 {
    Vec3::new(value[0] as f32, value[1] as f32, value[2] as f32) * 0.01
}

pub fn quantize_vec_i16(value: Vec3, quantum: f32) -> Vec3 {
    let quantize = |component: f32| {
        (component / quantum)
            .round()
            .clamp(i16::MIN as f32, i16::MAX as f32)
            * quantum
    };
    Vec3::new(quantize(value.x), quantize(value.y), quantize(value.z))
}

pub fn region_and_local(position: Vec3) -> ([i16; 3], [i16; 3]) {
    let cm = quantize_position_cm(position);
    let mut region = [0_i16; 3];
    let mut local = [0_i16; 3];
    for axis in 0..3 {
        // 320 m regions keep local centimeters representable in signed i16.
        let r = cm[axis].div_euclid(32_000);
        region[axis] = r.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        local[axis] = (cm[axis] - r * 32_000) as i16;
    }
    (region, local)
}

pub fn decode_region_position(region: [i16; 3], local: [i16; 3]) -> Vec3 {
    dequantize_position_cm([
        region[0] as i32 * 32_000 + local[0] as i32,
        region[1] as i32 * 32_000 + local[1] as i32,
        region[2] as i32 * 32_000 + local[2] as i32,
    ])
}

/// 32-bit smallest-three quaternion: 2-bit omitted index and three signed
/// 10-bit components. The quaternion is sign-flipped so the omitted component
/// is positive. Components are scaled over [-1/sqrt(2), +1/sqrt(2)].
pub fn encode_quat32(input: Quat) -> u32 {
    let q = input.normalize();
    let mut values = [q.x, q.y, q.z, q.w];
    let mut largest = 0;
    for i in 1..4 {
        if values[i].abs() > values[largest].abs() {
            largest = i;
        }
    }
    if values[largest] < 0.0 {
        for value in &mut values {
            *value = -*value;
        }
    }
    let scale = 511.0 * std::f32::consts::SQRT_2;
    let mut packed = largest as u32;
    let mut shift = 2;
    for (i, value) in values.into_iter().enumerate() {
        if i == largest {
            continue;
        }
        let signed = (value * scale).round().clamp(-511.0, 511.0) as i32;
        packed |= ((signed & 0x3ff) as u32) << shift;
        shift += 10;
    }
    packed
}

pub fn decode_quat32(packed: u32) -> Quat {
    let largest = (packed & 3) as usize;
    let mut values = [0.0_f32; 4];
    let mut shift = 2;
    let mut sum = 0.0;
    for (i, value) in values.iter_mut().enumerate() {
        if i == largest {
            continue;
        }
        let raw = ((packed >> shift) & 0x3ff) as i32;
        let signed = if raw & 0x200 != 0 { raw - 0x400 } else { raw };
        *value = signed as f32 / (511.0 * std::f32::consts::SQRT_2);
        sum += *value * *value;
        shift += 10;
    }
    values[largest] = (1.0 - sum).max(0.0).sqrt();
    Quat::from_xyzw(values[0], values[1], values[2], values[3]).normalize()
}

pub fn quantized_absolute_pose(pose: Pose) -> Pose {
    let (region, local) = region_and_local(pose.position);
    Pose {
        position: decode_region_position(region, local),
        rotation: decode_quat32(encode_quat32(pose.rotation)),
    }
}

pub fn angular_error_degrees(a: Quat, b: Quat) -> f32 {
    quaternion_angle_radians(a, b).to_degrees()
}

pub fn rigid_shell_error_meters(truth: Pose, reconstruction: Pose, radius: f32) -> f32 {
    let center_error = truth.position.distance(reconstruction.position);
    let angle = quaternion_angle_radians(truth.rotation, reconstruction.rotation);
    center_error + 2.0 * radius * (angle * 0.5).sin().abs()
}

fn quaternion_angle_radians(a: Quat, b: Quat) -> f32 {
    let a = a.normalize();
    let b = b.normalize();
    let component_delta = (a - b).length_squared().min((a + b).length_squared());
    if component_delta <= 1e-12 {
        0.0
    } else {
        2.0 * a.dot(b).abs().clamp(0.0, 1.0).acos()
    }
}

pub fn projected_error_pixels(
    truth: Pose,
    reconstruction: Pose,
    radius: f32,
    camera: Camera,
    pane_width: u32,
    pane_height: u32,
) -> f32 {
    let direction = camera.direction.normalize();
    let reference_up = if direction.dot(Vec3::Y).abs() > 0.99 {
        Vec3::X
    } else {
        Vec3::Y
    };
    let right = direction.cross(reference_up).normalize();
    let up = right.cross(direction).normalize();
    let truth_relative = truth.position - camera.eye;
    let reconstructed_relative = reconstruction.position - camera.eye;
    let truth_depth = truth_relative.dot(direction);
    if truth_depth + radius <= 0.1 {
        return 0.0;
    }
    let focal_pixels = pane_height as f32 * 0.5 / (camera.fov_degrees.to_radians() * 0.5).tan();
    if truth_depth <= radius {
        return rigid_shell_error_meters(truth, reconstruction, radius) * focal_pixels
            / radius.max(0.1);
    }
    let half_vertical = (camera.fov_degrees.to_radians() * 0.5).tan();
    let aspect = pane_width as f32 / pane_height.max(1) as f32;
    let angular_radius = radius / truth_depth.max(0.1);
    let truth_x = truth_relative.dot(right) / truth_depth.max(0.1);
    let truth_y = truth_relative.dot(up) / truth_depth.max(0.1);
    if truth_x.abs() > half_vertical * aspect + angular_radius
        || truth_y.abs() > half_vertical + angular_radius
    {
        return 0.0;
    }
    let reconstructed_depth = reconstructed_relative.dot(direction);
    if reconstructed_depth <= 0.1 {
        return ((pane_width * pane_width + pane_height * pane_height) as f32).sqrt();
    }
    let depth = truth_depth.min(reconstructed_depth);
    let truth_screen = glam::Vec2::new(
        truth_relative.dot(right) / truth_depth,
        truth_relative.dot(up) / truth_depth,
    ) * focal_pixels;
    let reconstructed_screen = glam::Vec2::new(
        reconstructed_relative.dot(right) / reconstructed_depth,
        reconstructed_relative.dot(up) / reconstructed_depth,
    ) * focal_pixels;
    let center = truth_screen.distance(reconstructed_screen);
    let angle = quaternion_angle_radians(truth.rotation, reconstruction.rotation);
    let silhouette = radius * angle.sin().abs() * focal_pixels / depth;
    center + silhouette
}

pub fn worst_camera_error(
    truth: Pose,
    reconstruction: Pose,
    actor: &ActorDef,
    cameras: &[Camera; 4],
    pane_width: u32,
    pane_height: u32,
) -> f32 {
    cameras
        .iter()
        .map(|camera| {
            projected_error_pixels(
                truth,
                reconstruction,
                actor.bounding_radius,
                *camera,
                pane_width,
                pane_height,
            )
        })
        .fold(0.0, f32::max)
}

#[derive(Clone, Copy, Debug)]
pub struct DatagramRecord {
    pub actor: u32,
    pub choice: WireChoice,
    pub bytes: usize,
}

#[derive(Clone, Debug)]
pub struct Datagram {
    pub sequence: u32,
    pub baseline_id: u32,
    pub tick: u32,
    pub records: Vec<DatagramRecord>,
    pub bytes: usize,
}

pub fn relative_actor_id_bytes(actor: u32, previous_actor: Option<u32>) -> usize {
    let value = previous_actor.map_or(actor, |previous| actor.saturating_sub(previous));
    let bits = 32 - value.leading_zeros();
    bits.max(1).div_ceil(7) as usize
}

pub fn packed_record_bytes(logical_bytes: usize, actor: u32, previous_actor: Option<u32>) -> usize {
    debug_assert!(logical_bytes >= FIXED_ACTOR_ID_BYTES);
    logical_bytes - FIXED_ACTOR_ID_BYTES + relative_actor_id_bytes(actor, previous_actor)
}

pub fn packetize(
    records: &[DatagramRecord],
    sequence: &mut u32,
    baseline_id: u32,
    tick: u32,
) -> Vec<Datagram> {
    let mut packets = Vec::new();
    let mut current = Datagram {
        sequence: *sequence,
        baseline_id,
        tick,
        records: Vec::new(),
        bytes: DATAGRAM_HEADER,
    };
    for record in records {
        let previous_actor = current.records.last().map(|previous| previous.actor);
        let mut record_bytes = packed_record_bytes(record.bytes, record.actor, previous_actor);
        if current.bytes + record_bytes > MAX_DATAGRAM && !current.records.is_empty() {
            debug_assert!(current.bytes <= MAX_DATAGRAM);
            packets.push(current);
            *sequence += 1;
            current = Datagram {
                sequence: *sequence,
                baseline_id,
                tick,
                records: Vec::new(),
                bytes: DATAGRAM_HEADER,
            };
            record_bytes = packed_record_bytes(record.bytes, record.actor, None);
        }
        current.bytes += record_bytes;
        current.records.push(*record);
    }
    if !current.records.is_empty() {
        debug_assert!(current.bytes <= MAX_DATAGRAM);
        packets.push(current);
        *sequence += 1;
    }
    packets
}

#[derive(Clone, Copy, Debug)]
pub struct LossRng(u64);

impl LossRng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / ((1_u64 << 53) as f64)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum LossModel {
    Random(f64),
    Burst { start_tick: u32, length_ticks: u32 },
}

impl LossModel {
    pub fn dropped(self, tick: u32, rng: &mut LossRng) -> bool {
        match self {
            Self::Random(rate) => rng.unit() < rate,
            Self::Burst {
                start_tick,
                length_ticks,
            } => tick >= start_tick && tick < start_tick.saturating_add(length_ticks),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centimeter_quantization_is_bounded() {
        let p = Vec3::new(-321.234, 2.345, 999.999);
        let (r, l) = region_and_local(p);
        assert!((decode_region_position(r, l) - p).abs().max_element() <= 0.0051);
    }

    #[test]
    fn quaternion_round_trip_is_small() {
        let q = Quat::from_euler(glam::EulerRot::XYZ, 0.7, -1.1, 2.2);
        assert!(angular_error_degrees(q, decode_quat32(encode_quat32(q))) < 0.3);
    }

    #[test]
    fn classifier_ballistic_is_conservative() {
        let base = ActorState {
            pose: Pose::default(),
            linear_velocity: Vec3::Y,
            angular_velocity: Vec3::ZERO,
            contacts: 0,
            intact_joints: 0,
            flags: 0,
        };
        let mut free = Classifier::default();
        assert_eq!(
            free.update(base, ClassifierConfig::default()),
            PhysicalClass::ContactActive
        );
        assert_eq!(
            free.update(base, ClassifierConfig::default()),
            PhysicalClass::Ballistic
        );
        let constrained = ActorState {
            intact_joints: 1,
            ..base
        };
        assert_eq!(
            Classifier::default().update(constrained, ClassifierConfig::default()),
            PhysicalClass::ContactActive
        );
    }

    #[test]
    fn packet_size_never_exceeds_mtu() {
        let records: Vec<_> = (0..1000)
            .map(|actor| DatagramRecord {
                actor,
                choice: WireChoice::Absolute,
                bytes: ABSOLUTE_BYTES,
            })
            .collect();
        let mut sequence = 0;
        let packets = packetize(&records, &mut sequence, 1, 2);
        assert!(packets.iter().all(|p| p.bytes <= MAX_DATAGRAM));
        assert_eq!(packets.iter().map(|p| p.records.len()).sum::<usize>(), 1000);
        let packed_bytes: usize = packets.iter().map(|packet| packet.bytes).sum();
        let fixed_bytes = records.len() * ABSOLUTE_BYTES + packets.len() * DATAGRAM_HEADER;
        assert!(packed_bytes < fixed_bytes);
    }

    #[test]
    fn relative_actor_ids_use_leb128_sized_gaps() {
        assert_eq!(relative_actor_id_bytes(7, None), 1);
        assert_eq!(relative_actor_id_bytes(200, None), 2);
        assert_eq!(relative_actor_id_bytes(101, Some(100)), 1);
        assert_eq!(relative_actor_id_bytes(10_000, Some(100)), 2);
    }

    #[test]
    fn predictor_applies_gravity_and_damping() {
        let (pose, velocity, _) = predict_ballistic(
            Pose::default(),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::ZERO,
            PredictorParams {
                gravity: Vec3::new(0.0, -10.0, 0.0),
                linear_damping: 0.0,
                angular_damping: 0.0,
                dt: 0.1,
                steps: 1,
            },
        );
        assert!((pose.position - Vec3::new(0.1, -0.1, 0.0)).length() < 1e-6);
        assert_eq!(velocity, Vec3::new(1.0, -1.0, 0.0));
    }

    #[test]
    fn loss_is_deterministic() {
        let mut a = LossRng::new(42);
        let mut b = LossRng::new(42);
        let model = LossModel::Random(0.2);
        let aa: Vec<_> = (0..100).map(|t| model.dropped(t, &mut a)).collect();
        let bb: Vec<_> = (0..100).map(|t| model.dropped(t, &mut b)).collect();
        assert_eq!(aa, bb);
    }

    #[test]
    fn projection_scales_with_distance() {
        let camera = Camera {
            eye: Vec3::ZERO,
            direction: Vec3::Z,
            fov_degrees: 60.0,
        };
        let near = projected_error_pixels(
            Pose {
                position: Vec3::new(0.0, 0.0, 10.0),
                rotation: Quat::IDENTITY,
            },
            Pose {
                position: Vec3::new(1.0, 0.0, 10.0),
                rotation: Quat::IDENTITY,
            },
            1.0,
            camera,
            1920,
            1080,
        );
        let far = projected_error_pixels(
            Pose {
                position: Vec3::new(0.0, 0.0, 20.0),
                rotation: Quat::IDENTITY,
            },
            Pose {
                position: Vec3::new(1.0, 0.0, 20.0),
                rotation: Quat::IDENTITY,
            },
            1.0,
            camera,
            1920,
            1080,
        );
        assert!(near > far * 1.9);
    }

    #[test]
    fn rigid_shell_error_combines_translation_and_rotation() {
        let truth = Pose::default();
        let translated = Pose {
            position: Vec3::new(0.01, 0.0, 0.0),
            rotation: Quat::IDENTITY,
        };
        assert!((rigid_shell_error_meters(truth, translated, 1.0) - 0.01).abs() < 1e-6);

        let rotated = Pose {
            position: Vec3::ZERO,
            rotation: Quat::from_rotation_y(std::f32::consts::FRAC_PI_2),
        };
        assert!((rigid_shell_error_meters(truth, rotated, 1.0) - 2.0_f32.sqrt()).abs() < 1e-5);
    }
}
