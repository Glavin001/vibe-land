//! Server port of `client/src/vehicles/dune/pose-deltas.mjs`: the physical
//! source-frame motion of every authored suspension role, driven by Vehicle2
//! wheel state. A golden exported from the JS rig (`export-rig-golden.mjs`)
//! pins the two implementations together; change them only as a pair.
use nalgebra::{Matrix3, Matrix4, Unit, UnitQuaternion, Vector3};
use serde::Deserialize;
use std::collections::BTreeMap;

pub const CORNER_IDS: [&str; 4] = ["fl", "fr", "rl", "rr"];
/// Vehicle2 wheel index -> source corner (`configuration.mjs`).
pub const SOURCE_CORNER_FOR_WHEEL: [usize; 4] = [1, 0, 3, 2];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Motion {
    LowerArm,
    UpperArm,
    Steer,
    Wheel,
    Damper,
    Piston,
    TieRod,
    Axle,
}
pub const MOTIONS: [Motion; 8] = [
    Motion::LowerArm,
    Motion::UpperArm,
    Motion::Steer,
    Motion::Wheel,
    Motion::Damper,
    Motion::Piston,
    Motion::TieRod,
    Motion::Axle,
];
impl Motion {
    pub fn name(self) -> &'static str {
        match self {
            Motion::LowerArm => "lowerArm",
            Motion::UpperArm => "upperArm",
            Motion::Steer => "steer",
            Motion::Wheel => "wheel",
            Motion::Damper => "damper",
            Motion::Piston => "piston",
            Motion::TieRod => "tieRod",
            Motion::Axle => "axle",
        }
    }
    pub fn for_role(role: &str) -> Option<Motion> {
        Some(match role {
            "lowerArm" | "shockEye" => Motion::LowerArm,
            "upperArm" => Motion::UpperArm,
            "upright" | "knuckle" => Motion::Steer,
            "hub" | "wheel" => Motion::Wheel,
            // The coil-over rides with its damper about the top mount.
            "damper" | "topSeat" | "spring" => Motion::Damper,
            "piston" | "bottomSeat" => Motion::Piston,
            "tieRod" => Motion::TieRod,
            // Rubber bellows ribs grip the plunging shaft and telescope with it.
            "axle" | "cvBoot" => Motion::Axle,
            _ => return None,
        })
    }
}

/// A part's binding: a corner motion, the steering column, or fixed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binding {
    Fixed,
    Steering,
    Corner(usize, Motion),
}
impl Binding {
    pub fn from_motion(motion: Option<&serde_json::Value>) -> Result<Binding, String> {
        let Some(role) = motion.and_then(|m| m["role"].as_str()) else {
            return Ok(Binding::Fixed);
        };
        if role == "steering" {
            return Ok(Binding::Steering);
        }
        let kind = Motion::for_role(role).ok_or_else(|| format!("no physical motion for role {role}"))?;
        let corner = motion.and_then(|m| m["corner"].as_str()).ok_or("moving part has no corner")?;
        let index = CORNER_IDS.iter().position(|c| *c == corner).ok_or("unknown corner")?;
        Ok(Binding::Corner(index, kind))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RigCorner {
    pub front: bool,
    pub side: f64,
    pub radius: f64,
    pub lower_pivot: [f64; 3],
    pub upper_pivot: [f64; 3],
    pub lower: [f64; 3],
    pub upper: [f64; 3],
    pub hub: [f64; 3],
    pub shock_top: [f64; 3],
    pub shock_bottom: [f64; 3],
    pub axle_inner: [f64; 3],
    pub tie_inner: [f64; 3],
    pub tie_outer: [f64; 3],
    pub neutral_angle: f64,
    pub min_angle: f64,
    pub max_angle: f64,
    pub min_travel: f64,
    pub max_travel: f64,
    pub z: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RigSteering {
    pub column_start: [f64; 3],
    pub column_end: [f64; 3],
    pub ratio: f64,
}
/// The source-frame rig definition emitted by asset preparation.
#[derive(Clone, Debug, Deserialize)]
pub struct AssetRig {
    pub corners: BTreeMap<String, RigCorner>,
    pub steering: RigSteering,
}

/// Rig input for one source corner: travel from neutral (m, + = bump),
/// steer (rad, + = left) and spin (rad), in the visual rig's convention.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CornerInput {
    pub travel: f64,
    pub steering: f64,
    pub rotation: f64,
}
/// Map Vehicle2 `[jounce - neutral, steer, rotation, grounded]` (see
/// `PhysxArena::vehicle_rig`) to source corners, as `VehicleVisual` does.
pub fn inputs_from_vehicle2(wheels: &[[f32; 4]; 4]) -> [CornerInput; 4] {
    let mut out = [CornerInput::default(); 4];
    for (wheel, &corner) in SOURCE_CORNER_FOR_WHEEL.iter().enumerate() {
        out[corner] = CornerInput {
            travel: wheels[wheel][0] as f64,
            steering: wheels[wheel][1] as f64,
            rotation: -(wheels[wheel][2] as f64),
        };
    }
    out
}

type V = Vector3<f64>;
fn v(a: [f64; 3]) -> V {
    V::from(a)
}
fn translation(p: &V) -> Matrix4<f64> {
    Matrix4::new_translation(p)
}
fn rotation(q: &UnitQuaternion<f64>) -> Matrix4<f64> {
    q.to_homogeneous()
}
fn about(point: &V, q: &UnitQuaternion<f64>) -> Matrix4<f64> {
    translation(point) * rotation(q) * translation(&-point)
}
fn axis_angle(axis: &V, angle: f64) -> UnitQuaternion<f64> {
    UnitQuaternion::from_axis_angle(&Unit::new_normalize(*axis), angle)
}
/// three.js `Quaternion.setFromUnitVectors`, including its antiparallel branch.
fn between(a: &V, b: &V) -> UnitQuaternion<f64> {
    let r = a.dot(b) + 1.0;
    let (x, y, z, w) = if r < f64::EPSILON {
        if a.x.abs() > a.z.abs() {
            (-a.y, a.x, 0.0, 0.0)
        } else {
            (0.0, -a.z, a.y, 0.0)
        }
    } else {
        let c = a.cross(b);
        (c.x, c.y, c.z, r)
    };
    UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(w, x, y, z))
}
fn carry(from: &V, to: &V, a: &V, b: &V) -> Matrix4<f64> {
    translation(to) * rotation(&between(a, b)) * translation(&-from)
}
fn apply(m: &Matrix4<f64>, p: &V) -> V {
    m.transform_point(&(*p).into()).coords
}

struct Linkage {
    lower: V,
    upper: V,
    hub: V,
    camber: f64,
    angle: f64,
}
fn linkage(h: &RigCorner, angle: f64) -> Option<Linkage> {
    let (ax, ay, bx, by) = (h.lower_pivot[0].abs(), h.lower_pivot[1], h.lower_pivot[0].abs(), h.upper_pivot[1]);
    let ll = (h.lower[0].abs() - ax).hypot(h.lower[1] - ay);
    let ul = (h.upper[0].abs() - bx).hypot(h.upper[1] - by);
    let kl = (h.upper[0] - h.lower[0]).hypot(h.upper[1] - h.lower[1]);
    let (x, y) = (ax + ll * angle.cos(), ay + ll * angle.sin());
    let (dx, dy) = (bx - x, by - y);
    let d = dx.hypot(dy);
    if d >= ul + kl - 1e-5 || d <= (ul - kl).abs() + 1e-5 {
        return None;
    }
    let a = (kl * kl - ul * ul + d * d) / (2.0 * d);
    let vv = (kl * kl - a * a).max(0.0).sqrt();
    let (ux, uy) = (x + a * dx / d + vv * dy / d, y + a * dy / d - vv * dx / d);
    let camber = (uy - y).atan2(ux - x)
        - (h.upper[1] - h.lower[1]).atan2(h.upper[0].abs() - h.lower[0].abs());
    let hx = x + 0.15 * camber.cos() - 0.1 * camber.sin();
    let hy = y + 0.15 * camber.sin() + 0.1 * camber.cos();
    Some(Linkage {
        lower: V::new(h.side * x, y, h.z),
        upper: V::new(h.side * ux, uy, h.z),
        hub: V::new(h.side * hx, hy, h.z),
        camber: camber * h.side,
        angle,
    })
}
/// Rodrigues rotation of the hub about the inclined kingpin.
fn steered_hub(k: &Linkage, steering: f64) -> V {
    if steering == 0.0 {
        return k.hub;
    }
    let r = k.hub - k.lower;
    let a = (k.upper - k.lower).normalize();
    let (c, s) = (steering.cos(), steering.sin());
    k.lower + r * c + a.cross(&r) * s + a * a.dot(&r) * (1.0 - c)
}
fn solve_corner(h: &RigCorner, travel: f64, steering: f64) -> Result<Linkage, String> {
    let steering = if h.front { steering } else { 0.0 };
    let target = h.radius + travel.clamp(h.min_travel, h.max_travel);
    let (mut a, mut b) = (h.min_angle, h.max_angle);
    for _ in 0..22 {
        let mid = (a + b) / 2.0;
        let k = linkage(h, mid).ok_or("rig angle left the linkage range")?;
        if steered_hub(&k, steering).y < target {
            a = mid;
        } else {
            b = mid;
        }
    }
    let angle = if travel.abs() < 1e-10 && steering.abs() < 1e-10 {
        h.neutral_angle
    } else {
        (a + b) / 2.0
    };
    linkage(h, angle).ok_or_else(|| "rig angle left the linkage range".into())
}

/// Posed kinematic state, as `VisualRig.applyPose` computes it.
struct CornerState {
    k: Linkage,
    steer: Matrix4<f64>,
    wheel: Matrix4<f64>,
    hub: V,
    top: V,
    bottom: V,
    shock_dir: V,
    tie_inner: V,
    tie_outer: V,
    rotation: f64,
}
fn corner_state(h: &RigCorner, input: CornerInput) -> Result<CornerState, String> {
    let k = solve_corner(h, input.travel, input.steering)?;
    let camber_q = axis_angle(&V::z(), k.camber);
    let camber = translation(&k.lower) * rotation(&camber_q) * translation(&-v(h.lower));
    let axis = (k.upper - k.lower).normalize();
    let steer_q = axis_angle(&axis, if h.front { input.steering } else { 0.0 });
    let steer = about(&k.lower, &steer_q) * camber;
    let hub = apply(&steer, &v(h.hub));
    let wheel_axis = steer_q * (camber_q * V::x());
    let wheel = about(&hub, &axis_angle(&wheel_axis, input.rotation)) * steer;
    let arm = (k.angle - h.neutral_angle) * h.side;
    let bottom = axis_angle(&V::z(), arm) * (v(h.shock_bottom) - v(h.lower_pivot)) + v(h.lower_pivot);
    let top = v(h.shock_top);
    let tie_outer = apply(&steer, &v(h.tie_outer));
    let mut tie_inner = v(h.tie_inner);
    let rod = (v(h.tie_outer) - tie_inner).norm();
    tie_inner.x = tie_outer.x
        - h.side * (rod * rod - (tie_outer.y - tie_inner.y).powi(2) - (tie_outer.z - tie_inner.z).powi(2)).max(1e-4).sqrt();
    Ok(CornerState {
        steer,
        wheel,
        hub,
        top,
        bottom,
        shock_dir: (bottom - top).normalize(),
        tie_inner,
        tie_outer,
        rotation: input.rotation,
        k,
    })
}

/// Source-frame maps from each neutral solid to its posed solid.
#[derive(Clone, Debug)]
pub struct PoseDeltas {
    pub corners: [[Matrix4<f64>; 8]; 4],
    pub steering: Matrix4<f64>,
}
impl PoseDeltas {
    pub fn get(&self, binding: Binding) -> Matrix4<f64> {
        match binding {
            Binding::Fixed => Matrix4::identity(),
            Binding::Steering => self.steering,
            Binding::Corner(corner, motion) => self.corners[corner][motion as usize],
        }
    }
}

impl AssetRig {
    fn corner(&self, id: &str) -> Result<&RigCorner, String> {
        self.corners.get(id).ok_or_else(|| format!("rig has no {id} corner"))
    }
    fn column(&self, fl: f64, fr: f64, wheel: Option<f64>) -> Matrix4<f64> {
        let s = &self.steering;
        let angle = wheel.unwrap_or((fl + fr) * 0.5 * s.ratio);
        about(&v(s.column_end), &axis_angle(&(v(s.column_end) - v(s.column_start)), angle))
    }
    /// `inputs` are in `CORNER_IDS` order. `steering_wheel` overrides the
    /// column angle derived from the front wheels, as the visual pose does.
    pub fn deltas(&self, inputs: &[CornerInput; 4], steering_wheel: Option<f64>) -> Result<PoseDeltas, String> {
        if inputs.iter().any(|i| !(i.travel.is_finite() && i.steering.is_finite() && i.rotation.is_finite())) {
            return Err("non-finite rig input".into());
        }
        let mut corners = [[Matrix4::identity(); 8]; 4];
        for (index, id) in CORNER_IDS.iter().enumerate() {
            let h = self.corner(id)?;
            let s = corner_state(h, inputs[index])?;
            let n = corner_state(h, CornerInput::default())?;
            let side = h.side;
            let lower = about(&v(h.lower_pivot), &axis_angle(&V::z(), side * (s.k.angle - h.neutral_angle)));
            let planar = |p: &V| (p.y - h.upper_pivot[1]).atan2(side * (p.x - h.upper_pivot[0]));
            let upper_turn = side * (planar(&s.k.upper) - planar(&v(h.upper)));
            let upper = about(&v(h.upper_pivot), &axis_angle(&V::z(), upper_turn));
            let inverse = |m: &Matrix4<f64>| m.try_inverse().ok_or("singular rig pose");
            let steer = s.steer * inverse(&n.steer)?;
            let wheel = s.wheel * inverse(&n.wheel)?;
            let damper = carry(&n.top, &s.top, &n.shock_dir, &s.shock_dir);
            let piston = carry(&n.bottom, &s.bottom, &n.shock_dir, &s.shock_dir);
            let rod = |x: &CornerState| (x.tie_outer - x.tie_inner).normalize();
            let tie_rod = carry(&n.tie_inner, &s.tie_inner, &rod(&n), &rod(&s));
            let inner = v(h.axle_inner);
            let axle_dir0 = (n.hub - inner).normalize();
            let axle = carry(&inner, &inner, &axle_dir0, &(s.hub - inner).normalize())
                * about(&inner, &axis_angle(&axle_dir0, s.rotation * side));
            corners[index] = [lower, upper, steer, wheel, damper, piston, tie_rod, axle];
        }
        let neutral = self.column(0.0, 0.0, None);
        let steering = self.column(inputs[0].steering, inputs[1].steering, steering_wheel)
            * neutral.try_inverse().ok_or("singular steering column")?;
        Ok(PoseDeltas { corners, steering })
    }
}

/// Source-to-actor is a proper Y half-turn plus the origin height; conjugate
/// a source-frame map into the actor frame the collider and mass data use.
pub fn source_to_actor(m: &Matrix4<f64>, origin_height: f64) -> Matrix4<f64> {
    let p = Matrix4::new_translation(&V::new(0.0, -origin_height, 0.0))
        * Matrix4::from_diagonal(&nalgebra::Vector4::new(-1.0, 1.0, -1.0, 1.0));
    p * m * p.try_inverse().expect("proper rigid frame")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenPose {
        name: String,
        inputs: Vec<[f64; 3]>,
        steering_wheel: Option<f64>,
        deltas: BTreeMap<String, BTreeMap<String, Vec<f64>>>,
        steering: Vec<f64>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Golden {
        rig: Option<AssetRig>,
        poses: Vec<GoldenPose>,
    }
    fn inputs(pose: &GoldenPose) -> [CornerInput; 4] {
        std::array::from_fn(|c| CornerInput { travel: pose.inputs[c][0], steering: pose.inputs[c][1], rotation: pose.inputs[c][2] })
    }
    fn gap(m: &Matrix4<f64>, expected: &[f64]) -> f64 {
        (m - Matrix4::from_column_slice(expected)).abs().max()
    }
    fn checked_in() -> Golden {
        serde_json::from_str(include_str!("testdata/rig-golden-buggy.json")).unwrap()
    }
    fn worst_delta_gap(rig: &AssetRig, golden: &Golden) -> f64 {
        let mut worst = 0.0f64;
        for pose in &golden.poses {
            let d = rig.deltas(&inputs(pose), pose.steering_wheel).unwrap();
            for (c, id) in CORNER_IDS.iter().enumerate() {
                for motion in MOTIONS {
                    let e = gap(&d.corners[c][motion as usize], &pose.deltas[*id][motion.name()]);
                    assert!(e < 1e-9, "{} {id}/{}: {e}", pose.name, motion.name());
                    worst = worst.max(e);
                }
            }
            worst = worst.max(gap(&d.steering, &pose.steering));
            assert!(gap(&d.steering, &pose.steering) < 1e-9, "{} steering", pose.name);
        }
        worst
    }

    #[test]
    fn matches_the_js_rig_golden() {
        let golden = checked_in();
        let worst = worst_delta_gap(golden.rig.as_ref().unwrap(), &golden);
        eprintln!("worst Rust/JS rig delta element gap: {worst:.2e}");
    }

    #[test]
    fn neutral_pose_is_identity_and_rigid_roles_stay_rigid() {
        let golden = checked_in();
        let rig = golden.rig.as_ref().unwrap();
        let neutral = rig.deltas(&[CornerInput::default(); 4], None).unwrap();
        for m in neutral.corners.iter().flatten().chain([&neutral.steering]) {
            assert!((m - Matrix4::identity()).abs().max() < 1e-12);
        }
        for pose in &golden.poses {
            let d = rig.deltas(&inputs(pose), pose.steering_wheel).unwrap();
            for corner in &d.corners {
                for motion in MOTIONS {
                    let l = corner[motion as usize].fixed_view::<3, 3>(0, 0).into_owned();
                    assert!((l.transpose() * l - Matrix3::identity()).abs().max() < 1e-12);
                    assert!((l.determinant() - 1.0).abs() < 1e-12);
                }
            }
        }
    }

    #[test]
    fn maps_vehicle2_wheels_to_source_corners_like_the_client() {
        let wheels = [[0.01, 0.1, 1.0, 1.0], [0.02, 0.2, 2.0, 1.0], [0.03, 0.0, 3.0, 0.0], [0.04, 0.0, 4.0, 1.0]];
        let out = inputs_from_vehicle2(&wheels);
        // Vehicle2 0..3 = fr, fl, rr, rl; the visual negates the spin angle.
        assert_eq!(out[1], CornerInput { travel: 0.01f32 as f64, steering: 0.1f32 as f64, rotation: -1.0 });
        assert_eq!(out[0].rotation, -2.0);
        assert_eq!(out[3].travel, 0.03f32 as f64);
        assert_eq!(out[2].rotation, -4.0);
    }

    #[test]
    fn rig_rates_give_the_hub_and_wheel_their_physical_velocities() {
        let golden = checked_in();
        let rig = golden.rig.as_ref().unwrap();
        let h = 1e-6;
        let at = |input: CornerInput| rig.deltas(&[input, CornerInput::default(), CornerInput::default(), CornerInput::default()], None).unwrap();
        let hub = V::from(rig.corners["fl"].hub);
        let wheel = |d: &PoseDeltas| d.corners[0][Motion::Wheel as usize];
        // Travel is defined as the steered hub height, so bump rate = hub rise
        // rate. The 22-step bisection quantizes travel near 1e-7 m (as in the
        // JS rig), so difference over 1 mm rather than at round-off scale.
        let dt = 1e-3;
        for (travel, steering) in [(0.0, 0.0), (0.08, 0.3), (-0.06, -0.4)] {
            let (a, b) = (at(CornerInput { travel: travel - dt, steering, rotation: 0.0 }), at(CornerInput { travel: travel + dt, steering, rotation: 0.0 }));
            let velocity = (apply(&wheel(&b), &hub) - apply(&wheel(&a), &hub)) / (2.0 * dt);
            assert!((velocity.y - 1.0).abs() < 1e-3, "{travel}/{steering}: {velocity}");
        }
        // Spin at neutral: the hub stays put and the wheel turns about the axle.
        let (a, b) = (at(CornerInput { rotation: -h, ..Default::default() }), at(CornerInput { rotation: h, ..Default::default() }));
        assert!((apply(&wheel(&b), &hub) - apply(&wheel(&a), &hub)).norm() / (2.0 * h) < 1e-6);
        let rate = (wheel(&b) - wheel(&a)).fixed_view::<3, 3>(0, 0) / (2.0 * h);
        let omega = V::new(rate[(2, 1)], rate[(0, 2)], rate[(1, 0)]);
        assert!((omega - V::x()).norm() < 1e-6, "{omega}");
    }

    #[test]
    fn rejects_non_finite_input() {
        let golden = checked_in();
        let rig = golden.rig.as_ref().unwrap();
        assert!(rig.deltas(&[CornerInput { travel: f64::NAN, ..Default::default() }; 4], None).is_err());
    }
}
