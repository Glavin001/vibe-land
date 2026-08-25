//! Quantization and perceptual-error primitives for the streaming codec.
//!
//! Ported from /root/workspace/destruction-codec/src/codec.rs (2026-08-10).
//! The byte model is deliberately explicit rather than an entropy estimate:
//! every record is serialized and packet headers are included in byte totals.
//! Validated offline: position round-trip ≤ 5.1 mm, rotation round-trip < 0.3°.

use glam::{Quat, Vec3};

use crate::types::{Camera, Pose};

pub const MAX_DATAGRAM: usize = 1150;
pub const DATAGRAM_HEADER: usize = 16;
pub const RELIABLE_HEADER: usize = 12;
pub const FIXED_BODY_ID_BYTES: usize = 4;
pub const ABSOLUTE_BYTES: usize = 21; // tag + id + region(3*i16) + pos(3*i16) + quat32
pub const DELTA_BYTES: usize = 15; // tag + id + baseline-relative pos(3*i16) + quat32
pub const MOTION_ABSOLUTE_BYTES: usize = ABSOLUTE_BYTES + 12; // + quantized linear/angular velocity
pub const MOTION_DELTA_BYTES: usize = DELTA_BYTES + 12; // + quantized linear/angular velocity
pub const BALLISTIC_BYTES: usize = 33; // absolute + quantized linear/angular velocity

pub const LINEAR_VELOCITY_QUANTUM: f32 = 0.01; // 1 cm/s
pub const ANGULAR_VELOCITY_QUANTUM: f32 = 0.001; // 0.001 rad/s

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

pub fn quantize_vec_i16_raw(value: Vec3, quantum: f32) -> [i16; 3] {
    let quantize = |component: f32| -> i16 {
        (component / quantum)
            .round()
            .clamp(i16::MIN as f32, i16::MAX as f32) as i16
    };
    [
        quantize(value.x),
        quantize(value.y),
        quantize(value.z),
    ]
}

pub fn dequantize_vec_i16_raw(value: [i16; 3], quantum: f32) -> Vec3 {
    Vec3::new(value[0] as f32, value[1] as f32, value[2] as f32) * quantum
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

/// The pose a client reconstructs from an absolute record — used server-side
/// to track projected error against ground truth.
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

/// Camera-independent error bound: any point on a rigid shell of `radius`
/// moves at most this many meters between the two poses.
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

/// Screen-space error of a reconstruction against truth for one camera, in
/// pixels: projected center distance plus rotational silhouette error.
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
    fn velocity_quantization_round_trips() {
        let v = Vec3::new(1.234, -0.05, 12.0);
        let raw = quantize_vec_i16_raw(v, LINEAR_VELOCITY_QUANTUM);
        let back = dequantize_vec_i16_raw(raw, LINEAR_VELOCITY_QUANTUM);
        assert!((back - v).abs().max_element() <= LINEAR_VELOCITY_QUANTUM * 0.5 + 1e-6);
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
