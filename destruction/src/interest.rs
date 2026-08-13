//! Per-client replication interest with predictive entry and hysteresis.
//!
//! Ported from /root/workspace/destruction-codec/src/interest.rs (2026-08-10).
//! This is deliberately separate from rendering visibility. A body remains
//! relevant briefly after leaving the view, may be prefetched before entering,
//! and can stay relevant when close enough to affect the viewer physically.
//!
//! Winning offline config: 5° fov margin, 200 ms lookahead, 250 ms grace,
//! 10 m proximity (all visual gates passing at 1% loss, 7.42 Mbps avg).

use glam::{Quat, Vec3};

use crate::types::{Camera, Pose};

#[derive(Clone, Copy, Debug)]
pub struct InterestConfig {
    pub fov_margin_degrees: f32,
    pub lookahead_ticks: u32,
    pub grace_ticks: u32,
    pub proximity_meters: f32,
    pub dt: f32,
    pub pane_width: u32,
    pub pane_height: u32,
}

impl InterestConfig {
    /// The offline-validated configuration at a given tick rate.
    pub fn validated(hz: u32) -> Self {
        Self {
            fov_margin_degrees: 5.0,
            lookahead_ticks: (hz / 5).max(1),      // 200 ms
            grace_ticks: (hz / 4).max(1),          // 250 ms
            proximity_meters: 10.0,
            dt: 1.0 / hz.max(1) as f32,
            pane_width: 1920,
            pane_height: 1080,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InterestDecision {
    pub relevant: bool,
    pub entering: bool,
    pub visible_now: bool,
    pub prefetched: bool,
    pub nearby: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct InterestView {
    pub current: Camera,
    pub predicted: Camera,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct InterestTrack {
    relevant_until_tick: u32,
    was_relevant: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct InterestViewTrack {
    previous: Option<Camera>,
}

impl InterestViewTrack {
    pub fn update(&mut self, camera: Camera, config: InterestConfig) -> InterestView {
        let Some(previous) = self.previous.replace(camera) else {
            return InterestView {
                current: camera,
                predicted: camera,
            };
        };
        let lookahead_seconds = config.lookahead_ticks as f32 * config.dt;
        let eye_velocity = (camera.eye - previous.eye) / config.dt.max(1e-6);
        let previous_direction = previous.direction.normalize_or_zero();
        let current_direction = camera.direction.normalize_or_zero();
        let predicted_direction =
            if previous_direction == Vec3::ZERO || current_direction == Vec3::ZERO {
                current_direction
            } else {
                let delta = Quat::from_rotation_arc(previous_direction, current_direction);
                let scaled_axis = delta.to_scaled_axis();
                let multiplier = (lookahead_seconds / config.dt.max(1e-6)).min(8.0);
                let predicted_rotation = Quat::from_scaled_axis(scaled_axis * multiplier);
                (predicted_rotation * current_direction).normalize_or_zero()
            };
        InterestView {
            current: camera,
            predicted: Camera {
                eye: camera.eye + eye_velocity * lookahead_seconds,
                direction: predicted_direction,
                fov_degrees: camera.fov_degrees,
            },
        }
    }
}

impl InterestTrack {
    /// Prefer `update_with_frusta` in loops: this rebuilds the camera basis on
    /// every call, which the packing loop does thousands of times per send.
    pub fn update(
        &mut self,
        tick: u32,
        pose: Pose,
        linear_velocity: Vec3,
        radius: f32,
        view: InterestView,
        config: InterestConfig,
    ) -> InterestDecision {
        let frusta = ViewFrusta::for_view(view, config);
        self.update_with_frusta(tick, pose, linear_velocity, radius, frusta, config)
    }

    /// As `update`, with the camera basis supplied by the caller.
    pub fn update_with_frusta(
        &mut self,
        tick: u32,
        pose: Pose,
        linear_velocity: Vec3,
        radius: f32,
        frusta: ViewFrusta,
        config: InterestConfig,
    ) -> InterestDecision {
        let visible_now = frusta.current.contains_sphere(pose.position, radius);
        let lookahead_seconds = config.lookahead_ticks as f32 * config.dt;
        let predicted_position = pose.position + linear_velocity * lookahead_seconds;
        let prefetched = !visible_now
            && (frusta.current.contains_sphere(predicted_position, radius)
                || frusta.predicted.contains_sphere(predicted_position, radius));
        let nearby =
            pose.position.distance(frusta.current.eye()) - radius <= config.proximity_meters;
        let directly_relevant = visible_now || prefetched || nearby;
        if directly_relevant {
            self.relevant_until_tick = tick.saturating_add(config.grace_ticks);
        }
        let relevant = directly_relevant || tick <= self.relevant_until_tick;
        let entering = relevant && !self.was_relevant;
        self.was_relevant = relevant;
        InterestDecision {
            relevant,
            entering,
            visible_now,
            prefetched,
            nearby,
        }
    }
}

/// Camera basis and frustum constants, computed once per view.
///
/// sphere_in_view used to derive all of this per call: two normalize()s, two
/// cross products, a tan() and a to_radians(). It is called up to three times
/// per body per client, so at ~6000 bodies and 2 clients that was ~36k
/// recomputations per send of values that do not change within the loop.
#[derive(Clone, Copy, Debug)]
pub struct ViewFrustum {
    eye: Vec3,
    direction: Vec3,
    right: Vec3,
    up: Vec3,
    half_vertical: f32,
    half_horizontal: f32,
    valid: bool,
}

impl ViewFrustum {
    pub fn new(
        camera: Camera,
        pane_width: u32,
        pane_height: u32,
        fov_margin_degrees: f32,
    ) -> Self {
        let direction = camera.direction.normalize_or_zero();
        if direction == Vec3::ZERO {
            return Self {
                eye: camera.eye,
                direction: Vec3::Z,
                right: Vec3::X,
                up: Vec3::Y,
                half_vertical: 0.0,
                half_horizontal: 0.0,
                valid: false,
            };
        }
        let reference_up = if direction.dot(Vec3::Y).abs() > 0.99 {
            Vec3::X
        } else {
            Vec3::Y
        };
        let right = direction.cross(reference_up).normalize();
        let up = right.cross(direction).normalize();
        let expanded_fov = (camera.fov_degrees + 2.0 * fov_margin_degrees)
            .clamp(1.0, 179.0)
            .to_radians();
        let half_vertical = (expanded_fov * 0.5).tan();
        let aspect = pane_width as f32 / pane_height.max(1) as f32;
        Self {
            eye: camera.eye,
            direction,
            right,
            up,
            half_vertical,
            half_horizontal: half_vertical * aspect,
            valid: true,
        }
    }

    /// Camera position this frustum was built from.
    #[inline]
    pub fn eye(&self) -> Vec3 {
        self.eye
    }

    #[inline]
    pub fn contains_sphere(&self, position: Vec3, radius: f32) -> bool {
        if !self.valid {
            return false;
        }
        let relative = position - self.eye;
        let depth = relative.dot(self.direction);
        if depth + radius <= 0.1 {
            return false;
        }
        let inv_depth = 1.0 / depth.max(0.1);
        let angular_radius = radius * inv_depth;
        let x = relative.dot(self.right) * inv_depth;
        let y = relative.dot(self.up) * inv_depth;
        x.abs() <= self.half_horizontal + angular_radius
            && y.abs() <= self.half_vertical + angular_radius
    }
}

/// Both frusta a body is tested against, built once per client per send.
#[derive(Clone, Copy, Debug)]
pub struct ViewFrusta {
    pub current: ViewFrustum,
    pub predicted: ViewFrustum,
}

impl ViewFrusta {
    pub fn for_view(view: InterestView, config: InterestConfig) -> Self {
        Self {
            current: ViewFrustum::new(
                view.current,
                config.pane_width,
                config.pane_height,
                config.fov_margin_degrees,
            ),
            predicted: ViewFrustum::new(
                view.predicted,
                config.pane_width,
                config.pane_height,
                config.fov_margin_degrees,
            ),
        }
    }
}

pub fn sphere_in_view(
    position: Vec3,
    radius: f32,
    camera: Camera,
    pane_width: u32,
    pane_height: u32,
    fov_margin_degrees: f32,
) -> bool {
    ViewFrustum::new(camera, pane_width, pane_height, fov_margin_degrees)
        .contains_sphere(position, radius)
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Quat;

    fn camera() -> Camera {
        Camera {
            eye: Vec3::ZERO,
            direction: Vec3::Z,
            fov_degrees: 60.0,
        }
    }

    fn config() -> InterestConfig {
        InterestConfig {
            fov_margin_degrees: 0.0,
            lookahead_ticks: 10,
            grace_ticks: 5,
            proximity_meters: 2.0,
            dt: 0.1,
            pane_width: 1920,
            pane_height: 1080,
        }
    }

    fn static_view() -> InterestView {
        InterestView {
            current: camera(),
            predicted: camera(),
        }
    }

    fn pose(position: Vec3) -> Pose {
        Pose {
            position,
            rotation: Quat::IDENTITY,
        }
    }

    #[test]
    fn visible_body_enters_then_receives_exit_grace() {
        let mut track = InterestTrack::default();
        let entered = track.update(
            10,
            pose(Vec3::Z * 10.0),
            Vec3::ZERO,
            0.5,
            static_view(),
            config(),
        );
        assert!(entered.visible_now);
        assert!(entered.entering);

        let grace = track.update(
            12,
            pose(Vec3::new(100.0, 0.0, 10.0)),
            Vec3::ZERO,
            0.5,
            static_view(),
            config(),
        );
        assert!(grace.relevant);
        assert!(!grace.entering);

        let expired = track.update(
            16,
            pose(Vec3::new(100.0, 0.0, 10.0)),
            Vec3::ZERO,
            0.5,
            static_view(),
            config(),
        );
        assert!(!expired.relevant);
    }

    #[test]
    fn velocity_lookahead_prefetches_before_frustum_entry() {
        let mut track = InterestTrack::default();
        let decision = track.update(
            1,
            pose(Vec3::new(20.0, 0.0, 10.0)),
            Vec3::new(-20.0, 0.0, 0.0),
            0.5,
            static_view(),
            config(),
        );
        assert!(!decision.visible_now);
        assert!(decision.prefetched);
        assert!(decision.relevant);
    }

    #[test]
    fn camera_motion_prefetches_future_view() {
        let mut view = InterestViewTrack::default();
        view.update(camera(), config());
        let turning = Camera {
            direction: Vec3::new(0.1, 0.0, 1.0).normalize(),
            ..camera()
        };
        let moving_view = view.update(turning, config());
        let mut track = InterestTrack::default();
        let decision = track.update(
            1,
            pose(Vec3::new(15.0, 0.0, 10.0)),
            Vec3::ZERO,
            0.1,
            moving_view,
            config(),
        );
        assert!(!decision.visible_now);
        assert!(decision.prefetched);
    }

    #[test]
    fn proximity_keeps_body_relevant_behind_camera() {
        let mut track = InterestTrack::default();
        let decision = track.update(
            1,
            pose(Vec3::new(0.0, 0.0, -1.0)),
            Vec3::ZERO,
            0.25,
            static_view(),
            config(),
        );
        assert!(!decision.visible_now);
        assert!(decision.nearby);
        assert!(decision.relevant);
    }

    #[test]
    fn margin_prevents_edge_churn() {
        let point = Vec3::new(12.0, 0.0, 10.0);
        assert!(!sphere_in_view(point, 0.1, camera(), 1920, 1080, 0.0));
        assert!(sphere_in_view(point, 0.1, camera(), 1920, 1080, 10.0));
    }
}

/// A conservative bounding cone over several clients' view frusta.
///
/// Per-client visibility is the dominant cost of the stream: every client
/// tests every candidate body, so the work is O(bodies x players) even though
/// most bodies are behind most players. Players in a match are not
/// independently oriented, though -- they cluster around objectives and look
/// at the same fight -- so the same bodies get rejected over and over by
/// nearly identical tests.
///
/// This cone bounds a group of those frusta so the rejection happens once for
/// the group. It is deliberately a *superset* of every member frustum, and it
/// only ever prefilters: a body the cone accepts is still tested exactly by
/// each client. So this cannot change what any client receives, only how much
/// work was needed to conclude it. Widening the cone costs speed, never
/// correctness -- which is the property that makes the grouping heuristic
/// safe to tune freely.
#[derive(Clone, Copy, Debug)]
pub struct ClusterCone {
    apex: Vec3,
    /// Distance from `apex` covering every member's eye.
    eye_radius: f32,
    axis: Vec3,
    /// Widest member corner ray plus the spread of member directions.
    half_angle: f32,
    valid: bool,
}

impl ClusterCone {
    /// Bound every frustum in `frusta`. Returns an always-accepting cone for
    /// an empty or degenerate group, so a caller can never silently drop a
    /// client by mis-grouping it.
    pub fn bounding(frusta: &[ViewFrustum]) -> Self {
        let live: Vec<&ViewFrustum> = frusta.iter().filter(|f| f.valid).collect();
        if live.is_empty() {
            return Self {
                apex: Vec3::ZERO,
                eye_radius: 0.0,
                axis: Vec3::Z,
                half_angle: 0.0,
                valid: false,
            };
        }
        let apex = live.iter().map(|f| f.eye).fold(Vec3::ZERO, |a, b| a + b)
            / live.len() as f32;
        let eye_radius = live
            .iter()
            .map(|f| (f.eye - apex).length())
            .fold(0.0f32, f32::max);
        let axis = live
            .iter()
            .map(|f| f.direction)
            .fold(Vec3::ZERO, |a, b| a + b)
            .normalize_or_zero();
        if axis == Vec3::ZERO {
            // Members face opposite ways and average to nothing; no cone is
            // tighter than "everything".
            return Self {
                apex,
                eye_radius,
                axis: Vec3::Z,
                half_angle: std::f32::consts::PI,
                valid: true,
            };
        }
        // Each frustum's widest ray is its corner, not its face centre.
        let half_angle = live
            .iter()
            .map(|f| {
                let corner = (f.half_horizontal * f.half_horizontal
                    + f.half_vertical * f.half_vertical)
                    .sqrt()
                    .atan();
                let deviation = f.direction.dot(axis).clamp(-1.0, 1.0).acos();
                corner + deviation
            })
            .fold(0.0f32, f32::max)
            .min(std::f32::consts::PI);
        Self { apex, eye_radius, axis, half_angle, valid: true }
    }

    /// Widest member half-angle, in radians. A cone approaching PI bounds
    /// nothing useful and the caller should split the group.
    #[inline]
    pub fn half_angle(&self) -> f32 {
        self.half_angle
    }

    /// Could this sphere be visible to ANY member? False is a proof that no
    /// member can see it; true is permission to test them individually.
    #[inline]
    pub fn may_contain_sphere(&self, position: Vec3, radius: f32) -> bool {
        if !self.valid {
            return true;
        }
        if self.half_angle >= std::f32::consts::PI {
            return true;
        }
        let relative = position - self.apex;
        let distance = relative.length();
        // Inside the ball holding every member eye: some member may be right
        // on top of it, at any orientation.
        let slack_radius = self.eye_radius + radius;
        if distance <= slack_radius {
            return true;
        }
        // Offsetting the apex to the far side of the eye ball, and inflating
        // by the body radius, both widen the cone by the same angular slack.
        let slack = (slack_radius / distance).clamp(-1.0, 1.0).asin();
        let angle = (relative / distance).dot(self.axis).clamp(-1.0, 1.0).acos();
        angle <= self.half_angle + slack
    }
}

#[cfg(test)]
mod cluster_cone_tests {
    use super::*;
    use crate::types::Camera;

    fn camera(eye: Vec3, direction: Vec3) -> Camera {
        Camera { eye, direction, fov_degrees: 75.0 }
    }

    fn frustum(eye: Vec3, direction: Vec3) -> ViewFrustum {
        ViewFrustum::new(camera(eye, direction), 1600, 900, 5.0)
    }

    /// The one property the optimisation depends on: the cone never rejects
    /// what a member accepts. If this fails, clients silently stop receiving
    /// bodies they are looking at -- so it is checked by brute force over a
    /// spread of layouts rather than on a hand-picked case.
    #[test]
    fn cone_never_rejects_what_a_member_frustum_accepts() {
        let mut seed = 0x9E3779B9u32;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed >> 8) as f32 / 16_777_216.0
        };
        let mut checked = 0u32;
        let mut accepted_by_member = 0u32;
        for group in 0..64 {
            // Groups range from tight (a shared firefight) to loose (players
            // scattered and facing apart), so the test covers the cases where
            // the cone is nearly a frustum and where it degenerates.
            let spread = 1.0 + (group as f32) * 2.0;
            let members: Vec<ViewFrustum> = (0..6)
                .map(|_| {
                    let eye = Vec3::new(
                        (next() - 0.5) * spread,
                        (next() - 0.5) * spread * 0.2 + 2.0,
                        (next() - 0.5) * spread,
                    );
                    let direction = Vec3::new(
                        next() - 0.5,
                        (next() - 0.5) * 0.4,
                        next() - 0.5,
                    );
                    frustum(eye, direction)
                })
                .collect();
            let cone = ClusterCone::bounding(&members);
            for _ in 0..400 {
                let position = Vec3::new(
                    (next() - 0.5) * 200.0,
                    (next() - 0.5) * 60.0,
                    (next() - 0.5) * 200.0,
                );
                let radius = 0.1 + next() * 3.0;
                let any_member =
                    members.iter().any(|f| f.contains_sphere(position, radius));
                checked += 1;
                if any_member {
                    accepted_by_member += 1;
                    assert!(
                        cone.may_contain_sphere(position, radius),
                        "cone rejected a body a member can see: pos={position:?} \
                         radius={radius} half_angle={}",
                        cone.half_angle()
                    );
                }
            }
        }
        // Guard against a vacuous pass: if the layouts never put anything in
        // view, the assertion above proves nothing.
        assert!(
            accepted_by_member > checked / 100,
            "test data too sparse to be meaningful: {accepted_by_member}/{checked} visible"
        );
    }

    /// Being a superset is necessary but not sufficient -- a cone that accepts
    /// everything is trivially safe and worthless.
    #[test]
    fn tight_group_rejects_most_of_the_world() {
        let members: Vec<ViewFrustum> = (0..8)
            .map(|i| {
                let t = i as f32;
                frustum(
                    Vec3::new(t * 0.8, 2.0, t * 0.4),
                    Vec3::new(0.0, -0.1, 1.0),
                )
            })
            .collect();
        let cone = ClusterCone::bounding(&members);
        let mut rejected = 0;
        let total = 4000;
        for i in 0..total {
            let a = (i as f32) * 0.37;
            let position = Vec3::new(a.sin() * 60.0, (a * 1.7).cos() * 20.0, a.cos() * 60.0);
            if !cone.may_contain_sphere(position, 0.5) {
                rejected += 1;
            }
        }
        assert!(
            rejected > total / 2,
            "cone over a tightly grouped squad only rejected {rejected}/{total}"
        );
    }

    #[test]
    fn opposed_group_degenerates_to_accepting_everything() {
        let members = vec![
            frustum(Vec3::ZERO, Vec3::Z),
            frustum(Vec3::ZERO, -Vec3::Z),
        ];
        let cone = ClusterCone::bounding(&members);
        assert!(cone.may_contain_sphere(Vec3::new(0.0, 0.0, 50.0), 1.0));
        assert!(cone.may_contain_sphere(Vec3::new(0.0, 0.0, -50.0), 1.0));
    }

    #[test]
    fn empty_group_accepts_rather_than_drops() {
        let cone = ClusterCone::bounding(&[]);
        assert!(cone.may_contain_sphere(Vec3::new(10.0, 0.0, 10.0), 1.0));
    }
}
