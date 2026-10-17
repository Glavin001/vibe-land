//! Server space to a renderer's space, in one place.
//!
//! Server space is right-handed, Y up, metres; yaw 0 faces +Z and positive yaw turns toward +X
//! (`shared/src/movement.rs`: forward = (sin yaw, 0, cos yaw)). Unreal is left-handed, Z up,
//! centimetres, forward +X, right +Y. The map is the linear isometry `M = 100 · [[0,0,1],[−1,0,0],[0,1,0]]`
//! (determinant −1, a change of handedness):
//!
//! | | server | Unreal |
//! |---|---|---|
//! | position, displacement | `(x, y, z)` m | `(100z, −100x, 100y)` cm |
//! | rotation (quaternion) | `(qx, qy, qz, qw)` | `(−qz, qx, −qy, qw)` |
//! | full extents (unsigned) | `(x, y, z)` m | `100 · (z, x, y)` cm |
//! | yaw / pitch | `ψ`, `φ` rad | `−deg ψ`, `deg φ` |
//!
//! A quaternion's vector part is an axial vector, so it maps as `det(M) · M · v`. Because `M` is an
//! isometry, composing poses commutes with it: `M(P + Q·v) = M(P) + q(Q)·M(v)`. Triangle winding
//! flips under the reflection (relevant once meshes are generated).

use glam::{Quat, Vec3};

/// The space the core writes positions and rotations in, chosen when it is created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Space {
    /// Server space unchanged (the web client: three.js is Y up and right-handed too).
    Server = 0,
    /// Unreal: left-handed, Z up, centimetres.
    Unreal = 1,
}

impl Space {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Space::Server),
            1 => Some(Space::Unreal),
            _ => None,
        }
    }

    /// A position or displacement.
    pub fn pos(self, p: Vec3) -> [f32; 3] {
        match self {
            Space::Server => p.to_array(),
            Space::Unreal => [100.0 * p.z, -100.0 * p.x, 100.0 * p.y],
        }
    }

    /// A rotation, as `[x, y, z, w]`.
    pub fn quat(self, q: Quat) -> [f32; 4] {
        match self {
            Space::Server => q.to_array(),
            Space::Unreal => [-q.z, q.x, -q.y, q.w],
        }
    }

    /// Unsigned full extents (box sizes).
    pub fn extents(self, e: Vec3) -> [f32; 3] {
        match self {
            Space::Server => e.to_array(),
            Space::Unreal => [100.0 * e.z, 100.0 * e.x, 100.0 * e.y],
        }
    }

    /// Yaw and pitch from server radians: radians for the server, degrees for Unreal.
    pub fn yaw_pitch(self, yaw_rad: f32, pitch_rad: f32) -> (f32, f32) {
        match self {
            Space::Server => (yaw_rad, pitch_rad),
            Space::Unreal => (-yaw_rad.to_degrees(), pitch_rad.to_degrees()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic unit quaternions and vectors (xorshift32).
    struct Gen(u32);
    impl Gen {
        fn f(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
        }
        fn vec(&mut self) -> Vec3 {
            Vec3::new(self.f(), self.f(), self.f()) * 50.0
        }
        fn quat(&mut self) -> Quat {
            Quat::from_xyzw(self.f(), self.f(), self.f(), self.f()).normalize()
        }
    }

    fn ue_vec(a: [f32; 3]) -> Vec3 {
        Vec3::from_array(a)
    }

    #[test]
    fn unreal_rotation_commutes_with_the_axis_map() {
        let mut g = Gen(0x9E37_79B9);
        for _ in 0..10_000 {
            let (q, v) = (g.quat(), g.vec());
            let expected = ue_vec(Space::Unreal.pos(q * v));
            let rotated = Quat::from_array(Space::Unreal.quat(q)) * ue_vec(Space::Unreal.pos(v));
            assert!(
                (expected - rotated).length() <= 1e-4 * expected.length().max(1.0),
                "q={q:?} v={v:?}: {expected:?} vs {rotated:?}"
            );
        }
    }

    #[test]
    fn unreal_pose_composition_commutes_with_the_axis_map() {
        let mut g = Gen(12345);
        for _ in 0..1000 {
            let (p, q, local) = (g.vec(), g.quat(), g.vec());
            let expected = ue_vec(Space::Unreal.pos(p + q * local));
            let composed = ue_vec(Space::Unreal.pos(p)) + Quat::from_array(Space::Unreal.quat(q)) * ue_vec(Space::Unreal.pos(local));
            // f32 keeps ~7 significant digits; a handful of operations stays within 1e-6 relative.
            assert!((expected - composed).length() <= 1e-6 * expected.length().max(100.0), "{expected:?} vs {composed:?}");
        }
    }

    #[test]
    fn unreal_converted_quaternions_stay_unit() {
        let mut g = Gen(777);
        for _ in 0..1000 {
            let q = Quat::from_array(Space::Unreal.quat(g.quat()));
            assert!((q.length() - 1.0).abs() < 1e-5);
        }
    }

    #[test]
    fn server_forward_maps_to_unreal_yaw() {
        for deg in [-170.0f32, -90.0, -30.0, 0.0, 45.0, 90.0, 135.0] {
            let yaw = deg.to_radians();
            let forward = Vec3::new(yaw.sin(), 0.0, yaw.cos());
            let ue = ue_vec(Space::Unreal.pos(forward)) / 100.0;
            let (ue_yaw, _) = Space::Unreal.yaw_pitch(yaw, 0.0);
            let from_yaw = Vec3::new(ue_yaw.to_radians().cos(), ue_yaw.to_radians().sin(), 0.0);
            assert!((ue - from_yaw).length() < 1e-5, "yaw {deg}: {ue:?} vs {from_yaw:?}");
        }
    }

    #[test]
    fn up_is_up_and_metres_are_centimetres() {
        assert_eq!(Space::Unreal.pos(Vec3::Y), [0.0, 0.0, 100.0]);
        assert_eq!(Space::Unreal.pos(Vec3::Z), [100.0, 0.0, 0.0]);
        assert_eq!(Space::Unreal.extents(Vec3::new(1.0, 2.0, 3.0)), [300.0, 100.0, 200.0]);
        assert_eq!(Space::Server.pos(Vec3::new(1.0, 2.0, 3.0)), [1.0, 2.0, 3.0]);
    }
}
