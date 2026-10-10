//! What a viewer notices: the perceptual model both the lab's scorecard and
//! the per-player encoder's priority use (docs/netcode-lab.md).
//!
//! People judge where an object is, or how fast it spins, poorly. They are
//! sharp at motion that breaks physics or causality. So the error that
//! matters is not one pixel distance. It is a set of artifact classes, each
//! with a psychometric function: the probability that a viewer notices an
//! error of size `m` is a log-logistic curve, `1 / (1 + (theta / m)^beta)`,
//! with threshold `theta` (noticed half the time) and slope `beta` on a log
//! scale -- the standard shape for detection thresholds (a Weibull-like
//! function of log magnitude). Unlike a logistic in raw units it has no
//! floor: an error a tenth of threshold is noticed 0.01% of the time at
//! beta 4, not a few percent, which summed over hundreds of debris pieces
//! would otherwise swamp the score with errors nobody can see. Each class also has a severity `S`: how
//! objectionable the error is once noticed. The penalty is
//!
//!   sum over events e of  A_e * P(notice | m_e) * S_class,
//!
//! reported per client-minute. `A` is the visibility weight: 0 off screen or
//! fully occluded, 1 otherwise; sudden-change classes are never discounted.
//!
//! **Calibration status.** The thresholds below are seeded from the
//! literature the spec cites and are labelled `uncalibrated` until a
//! calibration study fits them (milestone 5). Each carries its source.
//! Severities start in the spec's tier order (sudden changes and causality
//! above physics-law violations, above smoothness, above steady offsets)
//! and are likewise for the study to fit.

use glam::{Quat, Vec2, Vec3};
use serde::{Deserialize, Serialize};

use crate::types::Camera;

/// The artifact classes of the spec's metric catalogue that are scored as
/// noticed artifacts (V1-V13).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactClass {
    /// V2: a frame-to-frame step the truth did not take (px).
    Pop,
    /// V6: a contact shown early or late (ms).
    ContactTiming,
    /// V7: a break and its fragments' motion out of step (frames).
    CauseEffect,
    /// V12: an impact sound and its displayed contact out of step (ms).
    AudioSync,
    /// V13: a correction that overshoots and comes back (px).
    RubberBand,
    /// V3: a body in free flight not falling at g (fraction of g).
    Gravity,
    /// V5: kinetic energy gained without a cause (fraction of the true KE).
    EnergyGain,
    /// V4: acceleration the truth did not have (m/s^2, direction-weighted).
    UnexplainedAccel,
    /// V11: interpenetration the truth did not have (cm).
    Overlap,
    /// V10: uneven motion below the pop threshold (px, rms step error).
    Smoothness,
    /// V1: steady screen-space offset (px).
    ScreenError,
    /// V8: a debris group's mean motion off (px of mean position).
    GroupError,
}

impl ArtifactClass {
    pub const ALL: [ArtifactClass; 12] = [
        ArtifactClass::Pop,
        ArtifactClass::ContactTiming,
        ArtifactClass::CauseEffect,
        ArtifactClass::AudioSync,
        ArtifactClass::RubberBand,
        ArtifactClass::Gravity,
        ArtifactClass::EnergyGain,
        ArtifactClass::UnexplainedAccel,
        ArtifactClass::Overlap,
        ArtifactClass::Smoothness,
        ArtifactClass::ScreenError,
        ArtifactClass::GroupError,
    ];

    /// Sudden changes are never discounted by gaze or crowding (spec).
    pub fn is_sudden(self) -> bool {
        matches!(
            self,
            ArtifactClass::Pop | ArtifactClass::ContactTiming | ArtifactClass::CauseEffect | ArtifactClass::RubberBand
        )
    }

    pub fn name(self) -> &'static str {
        match self {
            ArtifactClass::Pop => "pop",
            ArtifactClass::ContactTiming => "contact_timing",
            ArtifactClass::CauseEffect => "cause_effect",
            ArtifactClass::AudioSync => "audio_sync",
            ArtifactClass::RubberBand => "rubber_band",
            ArtifactClass::Gravity => "gravity",
            ArtifactClass::EnergyGain => "energy_gain",
            ArtifactClass::UnexplainedAccel => "unexplained_accel",
            ArtifactClass::Overlap => "overlap",
            ArtifactClass::Smoothness => "smoothness",
            ArtifactClass::ScreenError => "screen_error",
            ArtifactClass::GroupError => "group_error",
        }
    }
}

/// One class's psychometric function and severity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Psychometric {
    /// The error noticed half the time, in the class's unit.
    pub theta: f64,
    /// Slope on a log scale (dimensionless): at `beta` 4, half the
    /// threshold is noticed 6% of the time and twice it 94%.
    pub beta: f64,
    /// How objectionable a noticed error is (tier order until fitted).
    pub severity: f64,
    pub unit: String,
    /// Where `theta` comes from.
    pub source: String,
}

impl Psychometric {
    pub fn p_notice(&self, m: f64) -> f64 {
        if !m.is_finite() || m <= 0.0 {
            return 0.0;
        }
        1.0 / (1.0 + (self.theta / m).powf(self.beta))
    }
}

/// The whole model: one psychometric function per class, plus how a
/// penalty per minute maps to the quality score Q.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PerceptualModel {
    /// `uncalibrated` (literature seeds) or the calibration study's label.
    pub calibration: String,
    pub classes: std::collections::BTreeMap<String, Psychometric>,
    /// Q = 100 * exp(-penalty_per_minute / q_scale).
    pub q_scale: f64,
    /// The screen the pixel classes are measured on.
    pub pane: (u32, u32),
}

impl PerceptualModel {
    /// The literature seeds (the spec's perception table). Uncalibrated.
    pub fn literature() -> Self {
        let mut classes = std::collections::BTreeMap::new();
        // beta 4 throughout until the calibration study fits each class: a
        // conventional detection slope (Weibull beta 3-4 is typical of
        // displacement and timing detection).
        let mut add = |class: ArtifactClass, theta: f64, severity: f64, unit: &str, source: &str| {
            classes.insert(
                class.name().to_string(),
                Psychometric { theta, beta: 4.0, severity, unit: unit.into(), source: source.into() },
            );
        };
        // Tier 3: discontinuities and causality.
        add(ArtifactClass::Pop, 2.0, 4.0, "px", "spec V2 threshold (2 px); popping visibility, Schwarz & Stamminger 2009");
        add(ArtifactClass::ContactTiming, 60.0, 4.0, "ms", "collision delays of ~60 ms accepted on average, O'Sullivan et al. 2003");
        add(ArtifactClass::CauseEffect, 3.0, 4.0, "frames", "~50 ms launch window, Michotte (3 frames at 60 Hz)");
        add(ArtifactClass::AudioSync, 75.0, 3.0, "ms", "audio lead undetected to ~75 ms, Eg & Behne 2015 (Dixon & Spitz)");
        add(ArtifactClass::RubberBand, 2.0, 4.0, "px", "overshoot read as a pop that comes back; spec V13");
        // Tier 4: physics-law violations.
        add(ArtifactClass::Gravity, 0.2, 3.0, "fraction of g", "gravity detected accurately, Lacquaniti et al. 2013; spec V3 target 20%");
        add(ArtifactClass::EnergyGain, 0.15, 3.0, "fraction of KE", "energy change predicts believability, Yeh et al. 2009");
        add(ArtifactClass::UnexplainedAccel, 3.0, 2.5, "m/s^2 (weighted)", "added horizontal/speed-up accelerations detected first, Reitsma & Pollard 2003");
        add(ArtifactClass::Overlap, 5.0, 2.5, "cm", "spec G4/V11 5 cm starting value");
        // Tier 5: smoothness.
        add(ArtifactClass::Smoothness, 0.75, 1.5, "px rms", "4-12 ms frame-time variation felt, 2023 study (arXiv 2306.01691)");
        // Tier 6: steady offsets.
        add(ArtifactClass::ScreenError, 3.0, 1.0, "px", "spec V1 target p95 <= 3 px; position judged poorly");
        add(ArtifactClass::GroupError, 4.0, 1.0, "px", "ensemble motion perceived accurately, Whitney & Yamanashi Leib 2018");
        Self { calibration: "uncalibrated".into(), classes, q_scale: 10.0, pane: (1920, 1080) }
    }

    pub fn class(&self, class: ArtifactClass) -> &Psychometric {
        &self.classes[class.name()]
    }

    /// One event's expected noticed-artifact penalty.
    pub fn penalty(&self, class: ArtifactClass, m: f64, visibility: f64) -> f64 {
        let f = self.class(class);
        visibility.clamp(0.0, 1.0) * f.p_notice(m) * f.severity
    }

    /// A model written as JSON (`scripts/netlab/fit-calibration.py`).
    pub fn load(path: &std::path::Path) -> std::io::Result<Self> {
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    /// Q (0-100) from a penalty per client-minute.
    pub fn quality(&self, penalty_per_minute: f64) -> f64 {
        100.0 * (-penalty_per_minute.max(0.0) / self.q_scale).exp()
    }
}

/// Direction weighting of an unexplained acceleration (V4): horizontal errors
/// are easier to detect than vertical ones, and added (speed-up)
/// accelerations easier than slow-downs (Reitsma & Pollard 2003). Returns the
/// weighted magnitude in m/s^2.
pub fn weighted_unexplained_accel(extra: Vec3, velocity: Vec3) -> f64 {
    let horizontal = Vec2::new(extra.x, extra.z).length() as f64;
    let vertical = extra.y.abs() as f64;
    let speeding_up = velocity.length_squared() > 1e-6 && extra.dot(velocity) > 0.0;
    let base = (horizontal * 1.5).hypot(vertical);
    if speeding_up {
        base * 1.3
    } else {
        base
    }
}

/// A camera as a pinhole projection onto a `pane` of pixels.
#[derive(Clone, Copy, Debug)]
pub struct Projector {
    eye: Vec3,
    forward: Vec3,
    right: Vec3,
    up: Vec3,
    focal_px: f32,
    half_w: f32,
    half_h: f32,
    near: f32,
}

impl Projector {
    pub fn new(camera: Camera, pane: (u32, u32)) -> Self {
        let forward = camera.direction.normalize_or_zero();
        let reference_up = if forward.dot(Vec3::Y).abs() > 0.99 { Vec3::X } else { Vec3::Y };
        let right = forward.cross(reference_up).normalize_or_zero();
        let up = right.cross(forward).normalize_or_zero();
        let focal_px = pane.1 as f32 * 0.5 / (camera.fov_degrees.max(1.0).to_radians() * 0.5).tan();
        Self {
            eye: camera.eye,
            forward,
            right,
            up,
            focal_px,
            half_w: pane.0 as f32 * 0.5,
            half_h: pane.1 as f32 * 0.5,
            near: 0.1,
        }
    }

    /// Pixel coordinates (origin at the centre, y up) and depth; None
    /// behind the near plane.
    pub fn project(&self, point: Vec3) -> Option<(Vec2, f32)> {
        let rel = point - self.eye;
        let depth = rel.dot(self.forward);
        if depth <= self.near {
            return None;
        }
        Some((Vec2::new(rel.dot(self.right), rel.dot(self.up)) * (self.focal_px / depth), depth))
    }

    /// Whether a sphere is at least partly on screen.
    pub fn sphere_on_screen(&self, centre: Vec3, radius: f32) -> bool {
        let rel = centre - self.eye;
        let depth = rel.dot(self.forward);
        if depth + radius <= self.near {
            return false;
        }
        if depth <= radius {
            return true;
        }
        let scale = self.focal_px / depth;
        let x = rel.dot(self.right) * scale;
        let y = rel.dot(self.up) * scale;
        let r = radius * scale;
        x.abs() <= self.half_w + r && y.abs() <= self.half_h + r
    }

    pub fn focal_px(&self) -> f32 {
        self.focal_px
    }

    pub fn pane_half(&self) -> Vec2 {
        Vec2::new(self.half_w, self.half_h)
    }
}

/// The eight corners of a box at a pose.
pub fn box_corners(position: Vec3, rotation: Quat, half_extents: Vec3) -> [Vec3; 8] {
    let mut out = [Vec3::ZERO; 8];
    for (i, corner) in out.iter_mut().enumerate() {
        let local = Vec3::new(
            if i & 1 == 0 { -half_extents.x } else { half_extents.x },
            if i & 2 == 0 { -half_extents.y } else { half_extents.y },
            if i & 4 == 0 { -half_extents.z } else { half_extents.z },
        );
        *corner = position + rotation * local;
    }
    out
}

/// V1: the largest projected distance, in pixels, between corresponding
/// corners of the displayed and the true box (covers rotation too). None
/// when the true box is not in front of the camera; a displayed corner
/// behind the camera counts as the pane's diagonal.
pub fn corner_error_px(
    projector: &Projector,
    displayed: (Vec3, Quat),
    truth: (Vec3, Quat),
    half_extents: Vec3,
) -> Option<f32> {
    let d = box_corners(displayed.0, displayed.1, half_extents);
    let t = box_corners(truth.0, truth.1, half_extents);
    let mut worst = 0.0f32;
    let mut any = false;
    let diagonal = projector.pane_half().length() * 2.0;
    for i in 0..8 {
        let Some((tp, _)) = projector.project(t[i]) else { continue };
        any = true;
        let error = match projector.project(d[i]) {
            Some((dp, _)) => dp.distance(tp),
            None => diagonal,
        };
        worst = worst.max(error);
    }
    any.then_some(worst)
}

/// A box's on-screen size (px): its projected bounding-circle diameter.
pub fn screen_size_px(projector: &Projector, position: Vec3, half_extents: Vec3) -> f32 {
    match projector.project(position) {
        Some((_, depth)) => 2.0 * half_extents.length() * projector.focal_px() / depth,
        None => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_logistic_is_half_at_threshold_and_monotone() {
        let model = PerceptualModel::literature();
        for class in ArtifactClass::ALL {
            let f = model.class(class);
            assert!((f.p_notice(f.theta) - 0.5).abs() < 1e-9, "{class:?}");
            assert!(f.p_notice(f.theta * 0.1) < 1e-3, "{class:?}: a tenth of threshold is all but invisible");
            assert!(f.p_notice(f.theta * 2.0) > f.p_notice(f.theta));
            assert_eq!(f.p_notice(0.0), 0.0, "no error, nothing to notice");
            assert!(!f.source.is_empty(), "{class:?} has no source");
        }
        assert_eq!(model.quality(0.0), 100.0);
        assert!(model.quality(10.0) < model.quality(1.0));
        assert_eq!(model.calibration, "uncalibrated");
    }

    #[test]
    fn one_pixel_at_the_centre_projects_as_one_pixel() {
        let camera = Camera { eye: Vec3::ZERO, direction: -Vec3::Z, fov_degrees: 90.0 };
        let p = Projector::new(camera, (1920, 1080));
        // At depth 10 m with a 90 degree vertical FOV, 1 px is 10/540 m.
        let metre_per_px = 10.0 / 540.0;
        let error = corner_error_px(
            &p,
            (Vec3::new(metre_per_px, 0.0, -10.0), Quat::IDENTITY),
            (Vec3::new(0.0, 0.0, -10.0), Quat::IDENTITY),
            Vec3::splat(0.01),
        )
        .unwrap();
        assert!((error - 1.0).abs() < 0.01, "{error}");
        // A box behind the camera is not scored.
        assert!(corner_error_px(&p, (Vec3::Z, Quat::IDENTITY), (Vec3::Z * 5.0, Quat::IDENTITY), Vec3::splat(0.1)).is_none());
        assert!(p.sphere_on_screen(Vec3::new(0.0, 0.0, -10.0), 0.5));
        assert!(!p.sphere_on_screen(Vec3::new(50.0, 0.0, -10.0), 0.5));
    }

    #[test]
    fn horizontal_and_speed_up_accelerations_weigh_more() {
        let v = Vec3::new(5.0, 0.0, 0.0);
        let sideways = weighted_unexplained_accel(Vec3::new(0.0, 0.0, 1.0), v);
        let vertical = weighted_unexplained_accel(Vec3::new(0.0, 1.0, 0.0), v);
        let faster = weighted_unexplained_accel(Vec3::new(1.0, 0.0, 0.0), v);
        let slower = weighted_unexplained_accel(Vec3::new(-1.0, 0.0, 0.0), v);
        assert!(sideways > vertical);
        assert!(faster > slower);
    }
}
