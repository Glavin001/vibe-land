//! Car meshes from a prepared vehicle's `metadata.json` (`GET /vehicle-assets/<geometryHash>/
//! metadata.json`; the server's `vehicle_assets::PreparedGeometry`), for clients that draw cars
//! from the same parts the physics simulates.
//!
//! Every part is the convex hulls of its shapes, flat-shaded, in the car's actor frame (the frame
//! the server simulates the car in): a shape's vertex sits at `part.position + shape.position + v`
//! (`vehicle_assets/fracture.rs`), already in that frame. The rig (`rig.corners`, the suspension
//! hardpoints) is authored in the source frame (+Y up, -Z front); source to actor is a half-turn
//! about Y less `originHeight` (the server's `vehicle_assets::rig::source_to_actor`), so every rig
//! hub and frame is carried into the actor frame before it meets the parts.
//!
//! Parts with a suspension role (wheel, hub, knuckle, arms, upright, damper, piston, spring and its
//! seats, shock eye, tie rod, axle, CV boot, steering wheel) are posed from the stream's wheel
//! states (`VlCar::wheels`; stream wheel `i` is corner `["fr","fl","rr","rl"][i]`, the web's
//! `sourceCornerForWheel`) by the web's rig: each corner's double-wishbone linkage solved for the
//! wheel's travel and steer (`dune/vehicle-rig.mjs` `solveCorner`), each part placed as
//! `dune/visual-rig.mjs` places it ([`VehicleMesh::pose`]). A renderer draws each posed part in its
//! own frame ([`VlPosedPart`]) and moves that frame each frame ([`VlPartPose`]).
//!
//! Colours are the web's palette (`dune/buggy.mjs` `materials`) with the car's configured paint
//! (`configuration.appearance`) applied as `VehicleVisual.ts` does.

use glam::Vec3;
use serde_json::Value;

use crate::coords::Space;
use crate::geometry::{convex_hull_triangles, flips_handedness};

/// Stream wheel index to rig corner (`configuration.mjs` `sourceCornerForWheel`).
pub const WHEEL_CORNERS: [&str; 4] = ["fr", "fl", "rr", "rl"];

/// [`VlVehicleVertex::section`]: the chassis (everything the rig does not move).
pub const VL_VEHICLE_SECTION_CHASSIS: u32 = 0;
/// [`VlVehicleVertex::section`]: a posed part (moved by the rig: see [`VehicleMesh::posed`]).
pub const VL_VEHICLE_SECTION_POSED: u32 = 1;

/// A part the rig moves, and its frame at rest (the wheels neutral). Renderer space, actor frame: a
/// vertex `v` of the part (as built, at rest) sits at `rest_pos + rest_quat * (rest_scale * l)` for
/// its local coordinates `l`; drawn posed at `pose.pos + pose.quat * (pose.scale * l)`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlPosedPart {
    pub part: u32,
    pub rest_pos: [f32; 3],
    pub rest_quat: [f32; 4],
    pub rest_scale: [f32; 3],
}

/// A posed part's frame now (see [`VlPosedPart`]).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlPartPose {
    pub part: u32,
    pub pos: [f32; 3],
    pub quat: [f32; 4],
    pub scale: [f32; 3],
}

/// One vertex of a car mesh, in the renderer's space and the car's actor frame. Three per triangle.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlVehicleVertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    /// 0xRRGGBBAA.
    pub color_rgba: u32,
    /// `VL_VEHICLE_SECTION_*`.
    pub section: u32,
    /// The part's index in the asset's `parts` (a detached part is drawn on its own: `VlCarPart`).
    pub part: u32,
}

/// A car mesh: triangles, and each wheel's hub (the pivot its sections turn about), actor frame.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VehicleMesh {
    pub vertices: Vec<VlVehicleVertex>,
    pub hubs: [[f32; 3]; 4],
    /// Tyre radius in the renderer's units.
    pub wheel_radius: f32,
    /// Always 0: the parts are in the actor frame, the frame a detached part's transform
    /// (`VlCarPart`) maps from, so a renderer adds nothing to their vertices. (Kept so the layout
    /// does not change.)
    pub origin_height: f32,
    /// The parts the rig moves, with their rest frames.
    pub posed: Vec<VlPosedPart>,
    rig: Option<rig::Rig>,
    space: Option<Space>,
}

impl VehicleMesh {
    /// The posed parts' frames for the car's wheels as drawn (`VlCar::wheels`, renderer units; spin
    /// as the stream reports it). Same order as [`posed`](Self::posed).
    pub fn pose(&self, wheels: &[crate::frame::VlWheel; 4]) -> Vec<VlPartPose> {
        let (Some(rig), Some(space)) = (self.rig.as_ref(), self.space) else {
            return Vec::new();
        };
        let m = space.metres();
        let inputs = wheels.map(|w| rig::WheelInput {
            travel: w.travel / m,
            steer: w.steer,
            spin: w.spin,
        });
        let state = rig.solve(&inputs);
        self.posed
            .iter()
            .map(|p| {
                let f = rig.frame(&state, p.part as usize).unwrap_or_default();
                frame_out(p.part, f, rig.origin_height, space)
            })
            .collect()
    }
}

/// A rig frame (source frame) carried into the actor frame (a half-turn about Y, less the origin
/// height: `source_to_actor`) and the renderer's space.
fn frame_out(part: u32, f: rig::Frame, origin_height: f32, space: Space) -> VlPartPose {
    VlPartPose {
        part,
        pos: space.pos(Vec3::new(-f.t.x, f.t.y - origin_height, -f.t.z)),
        quat: space.quat(glam::Quat::from_rotation_y(std::f32::consts::PI) * f.r),
        scale: {
            let s = space.extents(f.s);
            let m = space.metres();
            [s[0] / m, s[1] / m, s[2] / m]
        },
    }
}

/// The web's suspension rig (`dune/vehicle-rig.mjs`, `dune/visual-rig.mjs`), source frame, metres.
mod rig {
    use glam::{Mat4, Quat, Vec3};
    use serde_json::Value;

    use super::WHEEL_CORNERS;

    fn v3(v: Option<&Value>) -> Option<Vec3> {
        let a = v?.as_array()?;
        Some(Vec3::new(
            a.first()?.as_f64()? as f32,
            a.get(1)?.as_f64()? as f32,
            a.get(2)?.as_f64()? as f32,
        ))
    }
    fn num(v: Option<&Value>) -> Option<f32> {
        v.and_then(Value::as_f64).map(|x| x as f32)
    }

    /// A corner's hardpoints (`createRigDefinition`'s corners, as metadata.json carries them).
    #[derive(Clone, Debug, PartialEq)]
    pub struct Corner {
        front: bool,
        side: f32,
        z: f32,
        radius: f32,
        lower_pivot: Vec3,
        upper_pivot: Vec3,
        lower: Vec3,
        upper: Vec3,
        hub: Vec3,
        shock_top: Vec3,
        shock_bottom: Vec3,
        axle_inner: Vec3,
        tie_inner: Vec3,
        tie_outer: Vec3,
        neutral_angle: f32,
        min_angle: f32,
        max_angle: f32,
        min_travel: f32,
        max_travel: f32,
        shock_length: f32,
    }

    impl Corner {
        fn parse(c: &Value) -> Option<Self> {
            Some(Self {
                front: c.get("front")?.as_bool()?,
                side: num(c.get("side"))?,
                z: num(c.get("z"))?,
                radius: num(c.get("radius"))?,
                lower_pivot: v3(c.get("lowerPivot"))?,
                upper_pivot: v3(c.get("upperPivot"))?,
                lower: v3(c.get("lower"))?,
                upper: v3(c.get("upper"))?,
                hub: v3(c.get("hub"))?,
                shock_top: v3(c.get("shockTop"))?,
                shock_bottom: v3(c.get("shockBottom"))?,
                axle_inner: v3(c.get("axleInner"))?,
                tie_inner: v3(c.get("tieInner"))?,
                tie_outer: v3(c.get("tieOuter"))?,
                neutral_angle: num(c.get("neutralAngle"))?,
                min_angle: num(c.get("minAngle"))?,
                max_angle: num(c.get("maxAngle"))?,
                min_travel: num(c.get("minTravel"))?,
                max_travel: num(c.get("maxTravel"))?,
                shock_length: num(c.get("shockLength"))?,
            })
        }
    }

    #[derive(Clone, Copy, Debug)]
    struct Linkage {
        lower: Vec3,
        upper: Vec3,
        hub: Vec3,
        camber: f32,
        angle: f32,
    }

    /// The four-bar in an outboard-positive XY plane (`linkage`).
    fn linkage(h: &Corner, angle: f32) -> Option<Linkage> {
        let (ax, ay) = (h.lower_pivot.x.abs(), h.lower_pivot.y);
        let (bx, by) = (ax, h.upper_pivot.y);
        let ll = (h.lower.x.abs() - ax).hypot(h.lower.y - ay);
        let ul = (h.upper.x.abs() - bx).hypot(h.upper.y - by);
        let kl = (h.upper.x - h.lower.x).hypot(h.upper.y - h.lower.y);
        let (x, y) = (ax + ll * angle.cos(), ay + ll * angle.sin());
        let (dx, dy) = (bx - x, by - y);
        let d = dx.hypot(dy);
        if d >= ul + kl - 1e-5 || d <= (ul - kl).abs() + 1e-5 {
            return None;
        }
        let a = (kl * kl - ul * ul + d * d) / (2.0 * d);
        let v = (kl * kl - a * a).max(0.0).sqrt();
        let (ux, uy) = (x + a * dx / d + v * dy / d, y + a * dy / d - v * dx / d);
        let camber = (uy - y).atan2(ux - x)
            - (h.upper.y - h.lower.y).atan2(h.upper.x.abs() - h.lower.x.abs());
        let (hx, hy) = (
            x + 0.15 * camber.cos() - 0.1 * camber.sin(),
            y + 0.15 * camber.sin() + 0.1 * camber.cos(),
        );
        Some(Linkage {
            lower: Vec3::new(h.side * x, y, h.z),
            upper: Vec3::new(h.side * ux, uy, h.z),
            hub: Vec3::new(h.side * hx, hy, h.z),
            camber: camber * h.side,
            angle,
        })
    }

    /// Rodrigues rotation about the kingpin (`steeredHub`).
    fn steered_hub(k: &Linkage, steering: f32) -> Vec3 {
        if steering == 0.0 {
            return k.hub;
        }
        let r = k.hub - k.lower;
        let a = (k.upper - k.lower).normalize();
        let (c, s) = (steering.cos(), steering.sin());
        k.lower + r * c + a.cross(r) * s + a * a.dot(r) * (1.0 - c)
    }

    fn solve_corner(h: &Corner, travel: f32, steering: f32) -> Option<Linkage> {
        let steering = if h.front { steering } else { 0.0 };
        let target = h.radius + travel.clamp(h.min_travel, h.max_travel);
        let (mut a, mut b) = (h.min_angle, h.max_angle);
        for _ in 0..22 {
            let mid = (a + b) / 2.0;
            if steered_hub(&linkage(h, mid)?, steering).y < target {
                a = mid;
            } else {
                b = mid;
            }
        }
        // Exact identity at neutral.
        let neutral = travel.abs() < 1e-10 && steering.abs() < 1e-10;
        linkage(
            h,
            if neutral {
                h.neutral_angle
            } else {
                (a + b) / 2.0
            },
        )
    }

    pub struct WheelInput {
        pub travel: f32,
        pub steer: f32,
        pub spin: f32,
    }

    #[derive(Clone, Copy, Debug)]
    struct CornerState {
        lower: Vec3,
        upper: Vec3,
        hub: Vec3,
        steer: Mat4,
        wheel: Mat4,
        top: Vec3,
        bottom: Vec3,
        shock_dir: Vec3,
        coil_length: f32,
        tie_outer: Vec3,
        tie_inner: Vec3,
        rotation: f32,
    }

    pub struct State {
        corners: Vec<Option<CornerState>>,
        steering_delta: Mat4,
    }

    #[derive(Clone, Copy, Debug)]
    pub struct Frame {
        pub t: Vec3,
        pub r: Quat,
        pub s: Vec3,
    }

    impl Default for Frame {
        fn default() -> Self {
            Self {
                t: Vec3::ZERO,
                r: Quat::IDENTITY,
                s: Vec3::ONE,
            }
        }
    }

    fn pivot(point: Vec3, q: Quat) -> Mat4 {
        Mat4::from_translation(point) * Mat4::from_quat(q) * Mat4::from_translation(-point)
    }

    fn rigid(m: Mat4) -> Frame {
        let (_, r, t) = m.to_scale_rotation_translation();
        Frame { t, r, s: Vec3::ONE }
    }

    /// The web's `beam(a, b)`: a frame at the midpoint, Z along the beam, stretched to its length.
    fn beam(a: Vec3, b: Vec3) -> Frame {
        let d = b - a;
        let len = d.length().max(1e-6);
        Frame {
            t: (a + b) * 0.5,
            r: Quat::from_rotation_arc(Vec3::Z, d / len),
            s: Vec3::new(1.0, 1.0, len),
        }
    }

    #[derive(Clone, Debug, PartialEq)]
    enum Role {
        Wheel(usize),
        Knuckle(usize),
        LowerArm(usize, Vec3),
        UpperArm(usize, Vec3),
        Upright(usize),
        Damper(usize),
        Piston(usize),
        Spring(usize),
        Seat(usize, bool),
        ShockEye(usize),
        TieRod(usize),
        Axle(usize),
        CvBoot(usize),
        Steering,
    }

    #[derive(Clone, Debug, PartialEq)]
    pub struct Rig {
        corners: Vec<Option<Corner>>,
        roles: Vec<Option<Role>>,
        column_start: Vec3,
        column_end: Vec3,
        ratio: f32,
        pub origin_height: f32,
    }

    impl Rig {
        pub fn parse(meta: &Value, origin_height: f32) -> Option<Self> {
            let rig = meta.get("rig")?;
            let corners_json = rig.get("corners")?;
            let corners: Vec<Option<Corner>> = WHEEL_CORNERS
                .iter()
                .map(|id| corners_json.get(*id).and_then(Corner::parse))
                .collect();
            let steering = rig.get("steering");
            let roles = meta
                .get("parts")?
                .as_array()?
                .iter()
                .map(|part| {
                    let m = part.get("motion")?;
                    let role = m.get("role")?.as_str()?;
                    let corner = m
                        .get("corner")
                        .and_then(Value::as_str)
                        .and_then(|c| WHEEL_CORNERS.iter().position(|w| *w == c));
                    let endpoint = || v3(m.get("endpoints").and_then(|e| e.get(0)));
                    Some(match (role, corner) {
                        ("hub" | "wheel", Some(c)) => Role::Wheel(c),
                        ("knuckle", Some(c)) => Role::Knuckle(c),
                        ("lowerArm", Some(c)) => Role::LowerArm(c, endpoint()?),
                        ("upperArm", Some(c)) => Role::UpperArm(c, endpoint()?),
                        ("upright", Some(c)) => Role::Upright(c),
                        ("damper", Some(c)) => Role::Damper(c),
                        ("piston", Some(c)) => Role::Piston(c),
                        ("spring", Some(c)) => Role::Spring(c),
                        ("topSeat", Some(c)) => Role::Seat(c, true),
                        ("bottomSeat", Some(c)) => Role::Seat(c, false),
                        ("shockEye", Some(c)) => Role::ShockEye(c),
                        ("tieRod", Some(c)) => Role::TieRod(c),
                        ("axle", Some(c)) => Role::Axle(c),
                        ("cvBoot", Some(c)) => Role::CvBoot(c),
                        ("steering", _) if steering.is_some() => Role::Steering,
                        _ => return None,
                    })
                })
                .collect();
            Some(Self {
                corners,
                roles,
                column_start: v3(steering.and_then(|s| s.get("columnStart"))).unwrap_or(Vec3::ZERO),
                column_end: v3(steering.and_then(|s| s.get("columnEnd"))).unwrap_or(Vec3::Y),
                ratio: num(steering.and_then(|s| s.get("ratio"))).unwrap_or(1.0),
                origin_height,
            })
        }

        /// `VisualRig.applyPose`: wheel `i` drives corner `WHEEL_CORNERS[i]`, spin negated as the
        /// web's VehicleVisual does.
        pub fn solve(&self, wheels: &[WheelInput; 4]) -> State {
            let mut corners = Vec::with_capacity(4);
            for (i, corner) in self.corners.iter().enumerate() {
                let Some(h) = corner else {
                    corners.push(None);
                    continue;
                };
                let w = &wheels[i];
                let travel = if w.travel.is_finite() {
                    w.travel.clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                let rotation = -w.spin;
                let Some(k) = solve_corner(h, travel, w.steer) else {
                    corners.push(None);
                    continue;
                };
                let camber_q = Quat::from_axis_angle(Vec3::Z, k.camber);
                let camber = Mat4::from_rotation_translation(camber_q, k.lower)
                    * Mat4::from_translation(-h.lower);
                let axis = (k.upper - k.lower).normalize();
                let steer_q = Quat::from_axis_angle(axis, if h.front { w.steer } else { 0.0 });
                let steer = pivot(k.lower, steer_q) * camber;
                let hub = steer.transform_point3(h.hub);
                let wheel_axis = steer_q * (camber_q * Vec3::X);
                let wheel = pivot(hub, Quat::from_axis_angle(wheel_axis, rotation)) * steer;
                let arm = (k.angle - h.neutral_angle) * h.side;
                let bottom = Quat::from_axis_angle(Vec3::Z, arm) * (h.shock_bottom - h.lower_pivot)
                    + h.lower_pivot;
                let top = h.shock_top;
                let length = top.distance(bottom);
                let shock_dir = (bottom - top) / length.max(1e-6);
                let tie_outer = steer.transform_point3(h.tie_outer);
                let mut tie_inner = h.tie_inner;
                let rod = h.tie_outer.distance(h.tie_inner);
                tie_inner.x = tie_outer.x
                    - h.side
                        * (rod * rod
                            - (tie_outer.y - tie_inner.y).powi(2)
                            - (tie_outer.z - tie_inner.z).powi(2))
                        .max(0.0001)
                        .sqrt();
                corners.push(Some(CornerState {
                    lower: k.lower,
                    upper: k.upper,
                    hub,
                    steer,
                    wheel,
                    top,
                    bottom,
                    shock_dir,
                    coil_length: length - 0.32 * h.shock_length,
                    tie_outer,
                    tie_inner,
                    rotation,
                }));
            }
            // fl, fr are wheels 1 and 0.
            let centre = (wheels[1].steer + wheels[0].steer) * 0.5 * self.ratio;
            let column = (self.column_end - self.column_start).normalize_or_zero();
            State {
                corners,
                steering_delta: pivot(self.column_end, Quat::from_axis_angle(column, centre)),
            }
        }

        /// `VisualRig.matrixFor`, as a frame for the part's own geometry (see `VlPosedPart`).
        pub fn frame(&self, state: &State, part: usize) -> Option<Frame> {
            let role = self.roles.get(part)?.as_ref()?;
            if let Role::Steering = role {
                return Some(rigid(state.steering_delta));
            }
            let c = match role {
                Role::Wheel(c)
                | Role::Knuckle(c)
                | Role::LowerArm(c, _)
                | Role::UpperArm(c, _)
                | Role::Upright(c)
                | Role::Damper(c)
                | Role::Piston(c)
                | Role::Spring(c)
                | Role::Seat(c, _)
                | Role::ShockEye(c)
                | Role::TieRod(c)
                | Role::Axle(c)
                | Role::CvBoot(c) => *c,
                Role::Steering => unreachable!(),
            };
            let s = state.corners.get(c)?.as_ref()?;
            let h = self.corners.get(c)?.as_ref()?;
            Some(match role {
                Role::Wheel(_) => rigid(s.wheel),
                Role::Knuckle(_) => rigid(s.steer),
                Role::LowerArm(_, inner) => beam(*inner, s.lower),
                Role::UpperArm(_, inner) => beam(*inner, s.upper),
                Role::Upright(_) => beam(s.lower, s.upper),
                Role::Damper(_) => beam(s.top, s.top + s.shock_dir * h.shock_length * 0.67),
                Role::Piston(_) => beam(s.top + s.shock_dir * h.shock_length * 0.6, s.bottom),
                // The web regenerates the coil at its length; here the coil is stretched to it.
                Role::Spring(_) => beam(s.top, s.top + s.shock_dir * s.coil_length),
                Role::Seat(_, top) => {
                    let t = if *top { 0.02 } else { s.coil_length };
                    beam(
                        s.top + s.shock_dir * (t - 0.012),
                        s.top + s.shock_dir * (t + 0.012),
                    )
                }
                Role::ShockEye(_) => beam(s.bottom - s.shock_dir * 0.06, s.lower),
                Role::TieRod(_) => beam(s.tie_inner, s.tie_outer),
                Role::Axle(_) => {
                    let mut f = beam(h.axle_inner, s.hub);
                    f.r *= Quat::from_rotation_z(s.rotation * h.side);
                    f
                }
                // The boot follows its half-shaft and spins with it.
                Role::CvBoot(_) => {
                    let f = beam(h.axle_inner, s.hub);
                    Frame {
                        t: f.t,
                        r: f.r * Quat::from_rotation_z(s.rotation * h.side),
                        s: Vec3::ONE,
                    }
                }
                Role::Steering => unreachable!(),
            })
        }
    }

    impl State {
        pub fn empty() -> Self {
            Self {
                corners: Vec::new(),
                steering_delta: Mat4::IDENTITY,
            }
        }
    }

    pub(super) fn neutral() -> [WheelInput; 4] {
        [0, 1, 2, 3].map(|_| WheelInput {
            travel: 0.0,
            steer: 0.0,
            spin: 0.0,
        })
    }
    #[cfg(test)]
    pub(super) fn corner_target(rig: &Rig, c: usize, travel: f32) -> Option<f32> {
        rig.corners
            .get(c)?
            .as_ref()
            .map(|h| h.radius + travel.clamp(h.min_travel, h.max_travel))
    }
    #[cfg(test)]
    pub(super) fn corner_hub_y(rig: &Rig, state: &State, c: usize) -> Option<f32> {
        let _ = rig;
        state.corners.get(c)?.as_ref().map(|s| s.hub.y)
    }
}

#[derive(Debug, PartialEq)]
pub enum VehicleMeshError {
    Json(String),
    Missing(&'static str),
}

impl std::fmt::Display for VehicleMeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VehicleMeshError::Json(e) => write!(f, "vehicle metadata is not valid JSON: {e}"),
            VehicleMeshError::Missing(what) => write!(f, "vehicle metadata has no {what}"),
        }
    }
}

impl std::error::Error for VehicleMeshError {}

/// The web's palette (`dune/buggy.mjs` `materials`), 0xRRGGBB.
fn palette(material: &str) -> u32 {
    match material {
        "frame" => 0x344a4b,
        "orange" => 0xf36b29,
        "rubber" => 0x202224,
        "alloy" => 0xb0afa4,
        "steel" => 0x69737a,
        "dark" | "housing" => 0x242a2d,
        "seat" => 0x242729,
        "belt" => 0xd96b35,
        "red" => 0xb62e25,
        "glass" => 0x203c47,
        "race" => 0xeee7d4,
        "lens" => 0xe7e3c7,
        _ => 0x808080,
    }
}

fn hex_color(value: Option<&Value>) -> Option<u32> {
    let s = value?.as_str()?.trim_start_matches('#');
    (s.len() == 6)
        .then(|| u32::from_str_radix(s, 16).ok())
        .flatten()
}

/// A part's colour: the palette, then the configured paint (`VehicleVisual.ts`: finish on frame,
/// body paint on the Body system's frame parts, accent on orange/belt/race, wheel paint on the
/// Wheels system's alloy, seats on seat).
fn part_color(material: &str, system: &str, configuration: Option<&Value>) -> u32 {
    let appearance = configuration.and_then(|c| c.get("appearance"));
    let paint = |key: &str| hex_color(appearance.and_then(|a| a.get(key)));
    let rgb = match material {
        "frame" if system == "Body" => {
            paint("body").or_else(|| hex_color(configuration.and_then(|c| c.get("finish"))))
        }
        "frame" => hex_color(configuration.and_then(|c| c.get("finish"))),
        "orange" | "belt" | "race" => paint("accent"),
        "alloy" if system == "Wheels" => paint("wheels"),
        "seat" => paint("seats"),
        _ => None,
    }
    .unwrap_or_else(|| palette(material));
    (rgb << 8) | 0xFF
}

fn vec3(v: Option<&Value>) -> Option<Vec3> {
    let a = v?.as_array()?;
    Some(Vec3::new(
        a.first()?.as_f64()? as f32,
        a.get(1)?.as_f64()? as f32,
        a.get(2)?.as_f64()? as f32,
    ))
}

/// Build a car's mesh from its `metadata.json`, with its `configuration` (the vehicle asset's, for
/// paint; optional).
pub fn build_vehicle_mesh(
    metadata: &[u8],
    configuration: Option<&Value>,
    space: Space,
) -> Result<VehicleMesh, VehicleMeshError> {
    let meta: Value =
        serde_json::from_slice(metadata).map_err(|e| VehicleMeshError::Json(e.to_string()))?;
    let origin_height = meta
        .get("originHeight")
        .and_then(Value::as_f64)
        .ok_or(VehicleMeshError::Missing("originHeight"))? as f32;
    let parts = meta
        .get("parts")
        .and_then(Value::as_array)
        .ok_or(VehicleMeshError::Missing("parts"))?;
    let corners = meta.get("rig").and_then(|r| r.get("corners"));
    // The rig's points are in the source frame: into the actor frame the parts are in.
    let source_to_actor = |p: Vec3| Vec3::new(-p.x, p.y - origin_height, -p.z);

    let mut hubs = [[0.0f32; 3]; 4];
    for (i, corner) in WHEEL_CORNERS.iter().enumerate() {
        let hub = vec3(
            corners
                .and_then(|c| c.get(*corner))
                .and_then(|c| c.get("hub")),
        )
        .ok_or(VehicleMeshError::Missing("rig hubs"))?;
        hubs[i] = space.pos(source_to_actor(hub));
    }
    let radius = meta
        .get("dimensions")
        .and_then(|d| d.get("tireRadius"))
        .and_then(Value::as_f64)
        .unwrap_or(f64::from(origin_height) - 0.25) as f32;

    let rig = rig::Rig::parse(&meta, origin_height);
    let rest = rig
        .as_ref()
        .map(|r| r.solve(&rig::neutral()))
        .unwrap_or_else(rig::State::empty);
    let mut posed = Vec::new();
    let flip = flips_handedness(space);
    let mut vertices = Vec::new();
    let mut triangles = Vec::new();
    for (part_index, part) in parts.iter().enumerate() {
        let Some(position) = vec3(part.get("position")) else {
            continue;
        };
        let material = part.get("material").and_then(Value::as_str).unwrap_or("");
        let system = part.get("system").and_then(Value::as_str).unwrap_or("");
        let color = part_color(material, system, configuration);
        let motion = part.get("motion");
        let role = motion.and_then(|m| m.get("role")).and_then(Value::as_str);
        let corner = motion.and_then(|m| m.get("corner")).and_then(Value::as_str);
        let wheel = corner
            .and_then(|c| WHEEL_CORNERS.iter().position(|w| *w == c))
            .map(|i| i as u32);
        let _ = (role, wheel);
        let posed_part = rig
            .as_ref()
            .and_then(|r| r.frame(&rest, part_index).map(|f| (r, f)));
        let section = if posed_part.is_some() {
            VL_VEHICLE_SECTION_POSED
        } else {
            VL_VEHICLE_SECTION_CHASSIS
        };
        let mut has_geometry = false;
        for shape in part
            .get("shapes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(offset) = vec3(shape.get("position")) else {
                continue;
            };
            let base = position + offset;
            let mut points = Vec::new();
            for v in shape
                .get("vertices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(v) = vec3(Some(v)) {
                    let p = base + v;
                    points.extend_from_slice(&[p.x, p.y, p.z]);
                }
            }
            triangles.clear();
            if !convex_hull_triangles(&points, &mut triangles) {
                continue;
            }
            for [a, b, c] in &triangles {
                let n = (*b - *a).cross(*c - *a).normalize_or_zero();
                let normal = {
                    let m = space.pos(n);
                    let l = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt().max(1e-12);
                    [m[0] / l, m[1] / l, m[2] / l]
                };
                let corners = if flip { [*a, *c, *b] } else { [*a, *b, *c] };
                for p in corners {
                    vertices.push(VlVehicleVertex {
                        pos: space.pos(p),
                        normal,
                        color_rgba: color,
                        section,
                        part: part_index as u32,
                    });
                }
                has_geometry = true;
            }
        }
        if let (Some((r, f)), true) = (posed_part, has_geometry) {
            let o = frame_out(part_index as u32, f, r.origin_height, space);
            posed.push(VlPosedPart {
                part: o.part,
                rest_pos: o.pos,
                rest_quat: o.quat,
                rest_scale: o.scale,
            });
        }
    }
    if vertices.is_empty() {
        return Err(VehicleMeshError::Missing("shapes with volume"));
    }
    Ok(VehicleMesh {
        vertices,
        hubs,
        wheel_radius: radius * space.metres(),
        origin_height: 0.0,
        posed,
        rig,
        space: Some(space),
    })
}

/// A car's wheel centres in its actor frame, stream wheel order (fr, fl, rr, rl): the rig's hubs
/// as the web's `resolveVehicleGeometry` gives them (`sourceToActorPoint`: x and z negated, less the
/// origin height). The driver's presentation proxy rolls on these (vehicle_predictor.rs).
pub fn wheel_centres(metadata: &[u8]) -> Option<[[f32; 3]; 4]> {
    let meta: Value = serde_json::from_slice(metadata).ok()?;
    let origin_height = meta.get("originHeight")?.as_f64()? as f32;
    let corners = meta.get("rig")?.get("corners")?;
    let mut out = [[0.0; 3]; 4];
    for (i, id) in WHEEL_CORNERS.iter().enumerate() {
        let hub = vec3(corners.get(*id)?.get("hub"))?;
        out[i] = [-hub.x, hub.y - origin_height, -hub.z];
    }
    Some(out)
}

/// Each part's hull points in the source frame (part + shape + vertex, metres), in `parts` order:
/// what the wire 4 client needs to rest a car's detached groups on the ground.
pub fn part_hull_points(metadata: &[u8]) -> Result<Vec<Vec<Vec3>>, VehicleMeshError> {
    let meta: Value =
        serde_json::from_slice(metadata).map_err(|e| VehicleMeshError::Json(e.to_string()))?;
    let parts = meta
        .get("parts")
        .and_then(Value::as_array)
        .ok_or(VehicleMeshError::Missing("parts"))?;
    Ok(parts
        .iter()
        .map(|part| {
            let base = vec3(part.get("position")).unwrap_or(Vec3::ZERO);
            let mut points = Vec::new();
            for shape in part
                .get("shapes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let offset = vec3(shape.get("position")).unwrap_or(Vec3::ZERO);
                for v in shape
                    .get("vertices")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(v) = vec3(Some(v)) {
                        // f32 sums in the server's order (the web's Math.fround chain).
                        points.push((base + offset) + v);
                    }
                }
            }
            points
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A two-part car: a chassis box and the front-right wheel (a box standing in for its tyre).
    fn tiny_car() -> Vec<u8> {
        let cube = |h: f32| {
            let mut v = Vec::new();
            for x in [-h, h] {
                for y in [-h, h] {
                    for z in [-h, h] {
                        v.push(serde_json::json!([x, y, z]));
                    }
                }
            }
            v
        };
        let corner = |hub: [f32; 3]| serde_json::json!({ "hub": hub });
        serde_json::to_vec(&serde_json::json!({
            "originHeight": 1.0,
            "dimensions": { "tireRadius": 0.5 },
            "rig": { "corners": {
                "fr": corner([1.0, 0.5, -1.5]), "fl": corner([-1.0, 0.5, -1.5]),
                "rr": corner([1.0, 0.5, 1.5]), "rl": corner([-1.0, 0.5, 1.5]),
            }},
            "parts": [
                { "position": [0.0, 1.0, 0.0], "material": "frame", "system": "Body", "motion": null,
                  "shapes": [{ "position": [0.0, 0.0, 0.0], "vertices": cube(0.5) }] },
                // At the fr hub carried into the actor frame (the parts' frame).
                { "position": [-1.0, -0.5, 1.5], "material": "rubber", "system": "Wheels",
                  "motion": { "corner": "fr", "role": "wheel" },
                  "shapes": [{ "position": [0.0, 0.0, 0.0], "vertices": cube(0.25) }] },
            ],
        }))
        .unwrap()
    }

    #[test]
    fn parts_become_closed_hulls_in_the_actor_frame() {
        let mesh = build_vehicle_mesh(&tiny_car(), None, Space::Server).unwrap();
        assert_eq!(mesh.vertices.len() % 3, 0);
        // A cube's hull is 12 triangles: two cubes, 72 vertices.
        assert_eq!(mesh.vertices.len(), 72);
        // Parts are in the actor frame already: the chassis cube stays centred at y 1.0.
        let chassis: Vec<_> = mesh.vertices.iter().filter(|v| v.part == 0).collect();
        let mean_y = chassis.iter().map(|v| v.pos[1]).sum::<f32>() / chassis.len() as f32;
        assert!((mean_y - 1.0).abs() < 1e-5, "{mean_y}");
        // Each closed hull has zero net signed area: sum of normal * area per face is 0.
        let mut sum = Vec3::ZERO;
        for t in mesh.vertices.chunks_exact(3) {
            let (a, b, c) = (
                Vec3::from_array(t[0].pos),
                Vec3::from_array(t[1].pos),
                Vec3::from_array(t[2].pos),
            );
            sum += (b - a).cross(c - a);
        }
        assert!(sum.length() < 1e-4, "{sum}");
        // The fr hub (source [1, 0.5, -1.5]) in the actor frame: a half-turn less the origin height.
        assert_eq!(mesh.hubs[0], [-1.0, -0.5, 1.5]);
        assert_eq!(mesh.origin_height, 0.0);
        assert_eq!(mesh.wheel_radius, 0.5);
    }

    #[test]
    fn the_wheel_part_rides_its_stream_wheel_and_paint_applies() {
        let config = serde_json::json!({ "appearance": { "body": "#112233" } });
        let mesh = build_vehicle_mesh(&tiny_car(), Some(&config), Space::Server).unwrap();
        let wheel: Vec<_> = mesh.vertices.iter().filter(|v| v.part == 1).collect();
        assert_eq!(wheel.len(), 36);
        assert!(
            mesh.vertices.iter().any(|v| v.color_rgba == 0x112233FF),
            "body paint on the Body frame part"
        );
        assert!(
            wheel.iter().all(|v| v.color_rgba == 0x202224FF),
            "rubber from the palette"
        );
    }

    #[test]
    fn unreal_space_keeps_faces_outward() {
        let mesh = build_vehicle_mesh(&tiny_car(), None, Space::Unreal).unwrap();
        // Outward: each face's normal points away from its hull's centre.
        let chassis: Vec<_> = mesh.vertices.iter().filter(|v| v.part == 0).collect();
        let centre = chassis
            .iter()
            .fold(Vec3::ZERO, |s, v| s + Vec3::from_array(v.pos))
            / chassis.len() as f32;
        for t in chassis.chunks_exact(3) {
            let (a, b, c) = (
                Vec3::from_array(t[0].pos),
                Vec3::from_array(t[1].pos),
                Vec3::from_array(t[2].pos),
            );
            let face = (a + b + c) / 3.0;
            // The chunk meshes' convention (geometry.rs, drawn front-facing by Unreal): wound so
            // (b - a) x (c - a), computed in Unreal's coordinates, points outward, like the normal.
            assert!(Vec3::from_array(t[0].normal).dot(face - centre) > 0.0);
            assert!((b - a).cross(c - a).dot(face - centre) > 0.0);
        }
    }

    fn cached_cars() -> Vec<(std::path::PathBuf, Vec<u8>)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/vehicle-assets");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|e| {
                Some((
                    e.path(),
                    std::fs::read(e.path().join("metadata.json")).ok()?,
                ))
            })
            .collect()
    }

    fn wheels(travel: f32, steer: f32, spin: f32) -> [crate::frame::VlWheel; 4] {
        [crate::frame::VlWheel {
            travel,
            steer,
            spin,
            grounded: 1,
        }; 4]
    }

    fn roles(bytes: &[u8]) -> Vec<String> {
        let meta: Value = serde_json::from_slice(bytes).unwrap();
        meta["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["motion"]["role"].as_str().unwrap_or("").to_string())
            .collect()
    }

    /// The rig at neutral wheels draws every posed part exactly where it was built.
    #[test]
    fn neutral_wheels_pose_every_part_at_rest() {
        for (path, bytes) in cached_cars() {
            for space in [Space::Server, Space::Unreal] {
                let mesh = build_vehicle_mesh(&bytes, None, space).unwrap();
                let pose = mesh.pose(&wheels(0.0, 0.0, 0.0));
                assert_eq!(pose.len(), mesh.posed.len());
                for (r, p) in mesh.posed.iter().zip(&pose) {
                    let d = Vec3::from_array(r.rest_pos).distance(Vec3::from_array(p.pos));
                    let q = glam::Quat::from_array(r.rest_quat)
                        .dot(glam::Quat::from_array(p.quat))
                        .abs();
                    assert!(
                        d < 1e-6 * space.metres() && q > 1.0 - 1e-6,
                        "{path:?} part {}: {d} {q}",
                        r.part
                    );
                    assert_eq!(r.rest_scale, p.scale);
                }
            }
        }
    }

    /// Travel and steer move the linkage as a mechanism: the hub sits at the tyre radius plus the
    /// travel (`solveCorner`'s target), and every rigid link (wishbones, kingpin, tie rod) keeps its
    /// length.
    #[test]
    fn the_linkage_keeps_its_links_rigid_and_the_hub_follows_travel() {
        let cars = cached_cars();
        for (path, bytes) in &cars {
            let mesh = build_vehicle_mesh(bytes, None, Space::Server).unwrap();
            let roles = roles(bytes);
            let rig = mesh.rig.as_ref().unwrap();
            for (travel, steer) in [(-0.2, 0.0), (0.15, 0.0), (0.2, 0.3), (-0.1, -0.35)] {
                let pose = mesh.pose(&wheels(travel, steer, 0.0));
                for (r, p) in mesh.posed.iter().zip(&pose) {
                    if matches!(
                        roles[r.part as usize].as_str(),
                        "lowerArm" | "upperArm" | "upright" | "tieRod"
                    ) {
                        assert!(
                            (r.rest_scale[2] - p.scale[2]).abs() < 1e-4,
                            "{path:?} {} length {} -> {}",
                            roles[r.part as usize],
                            r.rest_scale[2],
                            p.scale[2]
                        );
                    }
                }
                let state = rig.solve(&wheels(travel, steer, 0.0).map(|w| rig::WheelInput {
                    travel: w.travel,
                    steer: w.steer,
                    spin: w.spin,
                }));
                for c in 0..4 {
                    let y = rig::corner_hub_y(rig, &state, c).unwrap();
                    // The travel is limited to the corner's (`solveCorner`).
                    let target = rig::corner_target(rig, c, travel).unwrap();
                    assert!(
                        (y - target).abs() < 1e-4,
                        "{path:?} corner {c}: hub y {y}, target {target}"
                    );
                }
            }
        }
        eprintln!("checked {} cars", cars.len());
    }

    /// What a renderer draws for a posed part (its vertex taken from the rest frame to the pose,
    /// as `VlPosedPart` documents) is the same car in either space: posing in server space and
    /// converting equals posing in Unreal space, for wheels travelling, steering and spinning.
    #[test]
    fn posing_agrees_across_spaces() {
        fn posed_vertex(v: Vec3, r: &VlPosedPart, p: &VlPartPose) -> Vec3 {
            let (rt, rq, rs) = (
                Vec3::from_array(r.rest_pos),
                glam::Quat::from_array(r.rest_quat),
                Vec3::from_array(r.rest_scale),
            );
            let (pt, pq, ps) = (
                Vec3::from_array(p.pos),
                glam::Quat::from_array(p.quat),
                Vec3::from_array(p.scale),
            );
            let local = (rq.inverse() * (v - rt)) / rs;
            pt + pq * (ps * local)
        }
        let cars = cached_cars();
        let mut checked = 0;
        for (path, bytes) in &cars {
            let server = build_vehicle_mesh(bytes, None, Space::Server).unwrap();
            let unreal = build_vehicle_mesh(bytes, None, Space::Unreal).unwrap();
            for (travel, steer, spin) in [
                (0.12, 0.0, 0.0),
                (0.0, 0.35, 0.0),
                (0.0, 0.0, 1.3),
                (-0.1, -0.3, 2.5),
            ] {
                let ws = wheels(travel, steer, spin);
                let wu = wheels(travel * Space::Unreal.metres(), steer, spin);
                let (ps, pu) = (server.pose(&ws), unreal.pose(&wu));
                // The same vertex in each space (Unreal reverses each triangle's winding, so its
                // vertex order differs): the server vertex converted.
                for (i, vs) in server.vertices.iter().enumerate() {
                    if vs.section != VL_VEHICLE_SECTION_POSED {
                        continue;
                    }
                    let k = server.posed.iter().position(|r| r.part == vs.part).unwrap();
                    let a = Vec3::from_array(Space::Unreal.pos(posed_vertex(
                        Vec3::from_array(vs.pos),
                        &server.posed[k],
                        &ps[k],
                    )));
                    let vu = Vec3::from_array(Space::Unreal.pos(Vec3::from_array(vs.pos)));
                    let b = posed_vertex(vu, &unreal.posed[k], &pu[k]);
                    assert!(a.distance(b) < 0.05, "{path:?} vertex {i} (part {}), wheels {travel} {steer} {spin}: server->unreal {a} vs unreal {b}", vs.part);
                    checked += 1;
                }
            }
        }
        assert!(checked > 0);
    }

    /// However far the wheels have turned, every posed vertex stays on the car: within the car's
    /// own extent (its rest vertices' farthest reach) of the actor origin.
    #[test]
    fn spinning_wheels_stay_on_the_car() {
        for (path, bytes) in cached_cars() {
            let mesh = build_vehicle_mesh(&bytes, None, Space::Server).unwrap();
            let reach = mesh
                .vertices
                .iter()
                .map(|v| Vec3::from_array(v.pos).length())
                .fold(0.0f32, f32::max);
            for spin in [0.5f32, 1.0, 2.4, 3.1, 5.0, 40.0] {
                let pose = mesh.pose(&wheels(0.0, 0.0, spin));
                for v in mesh
                    .vertices
                    .iter()
                    .filter(|v| v.section == VL_VEHICLE_SECTION_POSED)
                {
                    let k = mesh.posed.iter().position(|r| r.part == v.part).unwrap();
                    let (r, p) = (&mesh.posed[k], &pose[k]);
                    let local = (glam::Quat::from_array(r.rest_quat).inverse()
                        * (Vec3::from_array(v.pos) - Vec3::from_array(r.rest_pos)))
                        / Vec3::from_array(r.rest_scale);
                    let posed = Vec3::from_array(p.pos)
                        + glam::Quat::from_array(p.quat) * (Vec3::from_array(p.scale) * local);
                    assert!(posed.length() <= reach + 0.01, "{path:?} part {} at spin {spin}: posed vertex {posed} beyond the car's reach {reach}", v.part);
                }
            }
        }
    }

    /// A wheel's spin turns its wheel and hub about the axle by that angle and nothing else.
    #[test]
    fn spin_turns_the_wheel_about_its_axle() {
        for (path, bytes) in cached_cars() {
            let mesh = build_vehicle_mesh(&bytes, None, Space::Server).unwrap();
            let roles = roles(&bytes);
            let pose = mesh.pose(&wheels(0.0, 0.0, 0.7));
            for (r, p) in mesh.posed.iter().zip(&pose) {
                let delta =
                    glam::Quat::from_array(p.quat) * glam::Quat::from_array(r.rest_quat).inverse();
                let (axis, angle) = delta.to_axis_angle();
                match roles[r.part as usize].as_str() {
                    "wheel" | "hub" => assert!(
                        (angle - 0.7).abs() < 1e-4 && axis.x.abs() > 0.99,
                        "{path:?} {axis} {angle}"
                    ),
                    "lowerArm" | "upperArm" | "upright" | "knuckle" | "tieRod" | "steering" => {
                        assert!(angle < 1e-4, "{path:?} {}", roles[r.part as usize])
                    }
                    _ => {}
                }
            }
        }
    }

    #[test]
    fn every_cached_car_builds() {
        // The prepared assets in the repo's cache (present on dev machines; skipped elsewhere).
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/vehicle-assets");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut built = 0;
        for entry in entries.flatten() {
            let Ok(bytes) = std::fs::read(entry.path().join("metadata.json")) else {
                continue;
            };
            let mesh = build_vehicle_mesh(&bytes, None, Space::Unreal)
                .unwrap_or_else(|e| panic!("{:?}: {e}", entry.path()));
            assert!(mesh.vertices.len() > 1000);
            assert!(mesh.posed.len() >= 4, "every car has its wheels posed");
            built += 1;
        }
        eprintln!("built {built} cached cars");
    }
}
