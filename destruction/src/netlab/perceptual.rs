//! The perceptual evaluator: what one player's screen showed, frame by frame,
//! against the server's truth at that frame's render time, scored as noticed
//! artifacts (`crate::perception`).
//!
//! The evaluator is pure: it is fed one frame at a time (the player's camera
//! and, per item, its displayed and true pose) and keeps the short history
//! each metric needs. The lab's glue (`netlab2 city`) builds the frames from
//! a run's drawn chunks; the injection tests build them by hand, one known
//! error at a time.
//!
//! Metrics (the spec's catalogue; units are `perception::ArtifactClass`'s):
//!
//! - **V1 screen error.** Per visible item per frame, the largest projected
//!   distance between corresponding corners of the displayed and the true
//!   box. Scored as one event per body per second, at that second's mean.
//! - **V2 pops.** The displayed frame-to-frame screen step differs from the
//!   true step by more than 2 px or 10% of the item's on-screen size. One
//!   event per body per frame, at the largest discrepancy.
//! - **V3 gravity.** In contact-free flight (truth falling at g), the
//!   displayed vertical acceleration against the true one, as a fraction of
//!   g. Accelerations are perceived over hundreds of milliseconds, not per
//!   frame, so positions are first averaged over 4 frames (which also
//!   removes a 30 Hz alternation exactly) and the second difference spans
//!   9 frames each side (a 300 ms window). Over 50 ms, a pixel of jitter at
//!   40 m reads as tens of m/s^2 -- jitter, which V10 scores, not a push.
//!   Scored per body per second, at the mean of the frames' violations.
//! - **V4 unexplained acceleration.** Displayed minus true acceleration,
//!   weighted by direction and sign (`weighted_unexplained_accel`). In free
//!   flight its vertical part is V3's, so it is left out there. A push is
//!   sustained, a wobble or a catch-up step is not, so the per-second event
//!   weighs the second's mean acceleration *vector* (oscillations cancel;
//!   V13 and V2 score those).
//! - **V5 energy gain.** Displayed minus true kinetic energy, as a fraction
//!   of the true energy (floored at 0.5 m/s), in contact-free flight, net
//!   over each second (Yeh et al. 2009: the total change), positive part.
//!   A straight chord through an arc moves at its mean speed, so it *loses*
//!   energy on average: V3 scores it, not V5.
//! - **V10 smoothness.** The rms of the step discrepancies below the pop
//!   threshold. Per body per second.
//! - **V13 rubber-banding.** The displayed-minus-true screen offset swings to
//!   the opposite side within 500 ms, more than 2 px on both sides. One
//!   event per body per 500 ms (its chunks swing together), at the smaller
//!   side.
//!
//! Visibility is free-gaze (weight 1 anywhere on screen) and occlusion-aware:
//! the caller passes each item's visibility, from the object-ID buffer
//! (`IdBuffer`) rasterised from the displayed frame. Off-screen and fully
//! occluded items are excluded. Nothing is discounted for effects, crowding
//! or gaze.
//!
//! Not measured yet (listed in the report): V6 contact timing, V7 cause to
//! effect, V8 group error, V9 video score, V11 overlap, V12 audio sync.

use std::collections::{BTreeMap, HashMap};

use glam::{Quat, Vec2, Vec3};
use serde::{Deserialize, Serialize};

use crate::netlab::score::WeightedHist;
use crate::perception::{
    corner_error_px, screen_size_px, weighted_unexplained_accel, ArtifactClass, PerceptualModel, Projector,
};
use crate::types::Camera;

/// One item (a chunk) in one frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct ItemSample {
    /// Stable identity across frames (the chunk slot).
    pub id: u32,
    /// The truth body it is on (events aggregate per body).
    pub body: u32,
    pub half_extents: Vec3,
    pub mass: f32,
    /// What the screen showed; None when not drawn.
    pub displayed: Option<(Vec3, Quat)>,
    /// The server's truth at this frame's render time; None when gone.
    pub truth: Option<(Vec3, Quat)>,
    /// Visibility weight on the displayed frame: 0 off screen or fully
    /// occluded, 1 visible (free gaze).
    pub visibility: f32,
    /// The body the screen drew it on (overlap pairs are across bodies).
    pub displayed_body: u32,
    /// Drawn on, and truly on, a standing structure (a break is the moment
    /// this turns false).
    pub displayed_standing: bool,
    pub truth_standing: bool,
    /// The truth body has settled (gate G5: nothing settled may move on
    /// screen, unless it is woken -- then it is no longer settled).
    pub truth_settled: bool,
}

#[derive(Clone, Debug, Default)]
struct ItemState {
    /// The last frame's displayed and true screen positions (box centre).
    last_screen: Option<(Vec2, Vec2)>,
    /// Displayed and true world centres, newest last (accelerations).
    world: [(Vec3, Vec3); HISTORY],
    world_len: usize,
    /// The offset (displayed - true, px) at its largest on its current
    /// side, with when; the previous side's peak; whether this swing has
    /// been counted.
    swing: Option<(Vec2, f64)>,
    previous_swing: Option<(Vec2, f64)>,
    swing_counted: bool,
    /// Contact detection (V6): the last two frames' positions and times,
    /// displayed and true.
    contact_last: Option<(f64, Vec3, Vec3)>,
    contact_velocity: Option<(Vec3, Vec3)>,
    /// V7: when the drawn and the true chunk left its standing structure,
    /// where it was then, and when it first moved.
    break_displayed: Option<(f64, Vec3, Option<f64>)>,
    break_truth: Option<(f64, Vec3, Option<f64>)>,
    break_scored: bool,
    was_displayed_standing: bool,
    was_truth_standing: bool,
    truth_contacts: std::collections::VecDeque<f64>,
    displayed_contacts: std::collections::VecDeque<f64>,
    /// Acceleration samples waiting out the contact window, and recent true
    /// contacts.
    accel_pending: std::collections::VecDeque<AccelSample>,
    truth_contact_times: std::collections::VecDeque<f64>,
    /// Seen before: a chunk enters the scored set the frame it leaves its
    /// standing structure (in the drawing or the truth), so on first sight
    /// both are taken to have been standing.
    seen: bool,
}

/// One frame's acceleration measurements for one item (V3/V4/V5).
#[derive(Clone, Copy, Debug)]
struct AccelSample {
    t: f64,
    second: i64,
    body: u32,
    vis: f32,
    /// Free flight only: the vertical violation (fraction of g) and the
    /// kinetic-energy change.
    gravity: Option<f64>,
    energy: Option<f64>,
    /// The unexplained acceleration (horizontal only in free flight) and the
    /// true velocity.
    extra: Vec3,
    velocity: Vec3,
}

/// Per-class event list and raw distribution.
#[derive(Default)]
struct ClassAcc {
    hist: WeightedHist,
    events: u64,
    events_at_theta: u64,
    penalty: f64,
}

/// Per (class, body, second) running aggregate for the per-second classes.
#[derive(Default, Clone, Copy)]
struct SecondAgg {
    sum: f64,
    sum_sq: f64,
    n: u32,
    max: f64,
    visibility: f32,
    /// V4: the extra acceleration and the true velocity, summed as vectors.
    vector: Vec3,
    velocity: Vec3,
}

/// One class's line in the report.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ClassReport {
    pub unit: String,
    /// Raw per-sample distribution (before the psychometric function).
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub samples: f64,
    /// Scored events, and those at or above the class threshold (noticed at
    /// least half the time).
    pub events: u64,
    pub events_at_theta: u64,
    pub events_at_theta_per_minute: f64,
    /// Expected noticed artifacts x severity, per minute.
    pub penalty_per_minute: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PerceptualReport {
    pub model_calibration: String,
    pub minutes: f64,
    pub frames: u64,
    /// Item-frames scored (visible, displayed and in truth).
    pub visible_item_frames: u64,
    pub classes: BTreeMap<String, ClassReport>,
    pub penalty_per_minute: f64,
    /// Q (0-100), from the penalty (`PerceptualModel::quality`).
    pub q: f64,
    pub not_measured: Vec<String>,
    /// Gate G5: visible frames in which a body the truth has at rest moved
    /// more than 1 cm, counted once per body per frame -- except a step
    /// that ends closer to the resting truth than it began, which is the
    /// client landing on the settle pose (counted below; its size is scored
    /// as a pop). Motion that does not converge on the rest pose fails.
    pub g5_resurrection_frames: u64,
    /// Steps onto the settle pose: frames a resting body was corrected onto
    /// the truth (not motion away from it).
    pub g5_settle_snap_frames: u64,
    /// Gate G4: visible body-frames in which a drawn loose chunk is inside
    /// solid geometry (the ground, a standing structure) more than
    /// `G4_TOLERANCE_M` deeper than the truth has it, and the worst such
    /// depth (cm).
    pub g4_solid_frames: u64,
    pub g4_worst_cm: f64,
}

/// V8's grouping: a cell of the truth, metres, and the fewest chunks that
/// make a group.
const GROUP_CELL_M: f32 = 4.0;
const GROUP_MIN: u32 = 5;

/// The static world's lookup grid, metres.
pub const STATIC_CELL: f32 = 4.0;

/// G4's tolerance (the spec's 5 cm, as V11's threshold).
pub const G4_TOLERANCE_M: f32 = 0.05;

/// A box of the static world (a standing chunk): centre, rotation, half
/// extents.
#[derive(Clone, Copy, Debug)]
pub struct StaticBox {
    pub position: Vec3,
    pub rotation: Quat,
    pub half_extents: Vec3,
}

impl StaticBox {
    /// How deep a sphere is inside the box (negative: outside by that much).
    pub fn sphere_depth(&self, centre: Vec3, radius: f32) -> f32 {
        let local = self.rotation.conjugate() * (centre - self.position);
        let outside = (local.abs() - self.half_extents).max(Vec3::ZERO);
        if outside.length_squared() > 0.0 {
            radius - outside.length()
        } else {
            // Inside: to the nearest face, plus the radius.
            radius + (self.half_extents - local.abs()).min_element()
        }
    }
}

pub struct PerceptualEval {
    model: PerceptualModel,
    gravity: Vec3,
    items: HashMap<u32, ItemState>,
    classes: BTreeMap<ArtifactClass, ClassAcc>,
    /// (class, body, second) -> aggregate, flushed when the second passes.
    seconds: HashMap<(ArtifactClass, u32, i64), SecondAgg>,
    current_second: i64,
    frames: u64,
    visible_item_frames: u64,
    first_t: Option<f64>,
    last_t: f64,
    frame_dt: f64,
    log_events: bool,
    event_log: Vec<(f64, ArtifactClass, u32, f64)>,
    g5_frames: u64,
    g5_snap_frames: u64,
    g4_frames: u64,
    g4_worst_cm: f64,
    /// The static world this frame, and a 4 m grid over it.
    statics: Vec<StaticBox>,
    static_cells: HashMap<(i32, i32, i32), Vec<u32>>,
    /// When each body last scored a rubber band, a contact.
    body_band_s: HashMap<u32, f64>,
    body_contact_s: HashMap<u32, f64>,
}

/// Frames either side of an acceleration stencil (9 at 60 Hz: a 300 ms
/// window), over positions averaged across `SMOOTH` frames.
const STENCIL: usize = 9;
const SMOOTH: usize = 4;
const HISTORY: usize = 2 * STENCIL + SMOOTH;
/// Truth is in contact-free flight when its acceleration is within this
/// share of g of gravity (a contact or a slide changes it by far more).
const FREE_FLIGHT_TOLERANCE: f32 = 0.15;
/// Energy fractions use at least this speed's energy as the denominator.
const ENERGY_FLOOR_MPS: f32 = 0.5;
const POP_PX: f32 = 2.0;
const POP_SIZE_SHARE: f32 = 0.10;
const RUBBER_BAND_PX: f32 = 2.0;
/// A contact: a frame-to-frame velocity change this far from gravity's, m/s.
const CONTACT_DV: f32 = 1.0;
/// How far apart a true and a displayed contact may be and still match.
const CONTACT_WINDOW_S: f64 = 0.3;
const RUBBER_BAND_S: f64 = 0.5;

impl PerceptualEval {
    pub fn new(model: PerceptualModel, gravity: Vec3) -> Self {
        let classes = ArtifactClass::ALL.iter().map(|c| (*c, ClassAcc::default())).collect();
        Self {
            model,
            gravity,
            items: HashMap::new(),
            classes,
            seconds: HashMap::new(),
            current_second: i64::MIN,
            frames: 0,
            visible_item_frames: 0,
            first_t: None,
            last_t: 0.0,
            frame_dt: 1.0 / 60.0,
            log_events: false,
            event_log: Vec::new(),
            body_band_s: HashMap::new(),
            body_contact_s: HashMap::new(),
            g5_frames: 0,
            g5_snap_frames: 0,
            g4_frames: 0,
            g4_worst_cm: 0.0,
            statics: Vec::new(),
            static_cells: HashMap::new(),
        }
    }

    pub fn model(&self) -> &PerceptualModel {
        &self.model
    }

    /// Every event at or above threshold, for diagnosis: (t, class, body,
    /// magnitude). Off unless `record_events` was called.
    pub fn take_events(&mut self) -> Vec<(f64, ArtifactClass, u32, f64)> {
        std::mem::take(&mut self.event_log)
    }

    pub fn record_events(&mut self, on: bool) {
        self.log_events = on;
    }

    fn event(&mut self, class: ArtifactClass, m: f64, visibility: f32) {
        self.event_for(class, m, visibility, u32::MAX);
    }

    fn event_for(&mut self, class: ArtifactClass, m: f64, visibility: f32, body: u32) {
        let theta = self.model.class(class).theta;
        if self.log_events && m >= theta && visibility > 0.0 {
            self.event_log.push((self.last_t, class, body, m));
        }
        let penalty = self.model.penalty(class, m, f64::from(visibility));
        let acc = self.classes.get_mut(&class).unwrap();
        acc.events += 1;
        if m >= theta {
            acc.events_at_theta += 1;
        }
        acc.penalty += penalty;
    }

    fn sample(&mut self, class: ArtifactClass, value: f64) {
        self.classes.get_mut(&class).unwrap().hist.add(value as f32, 1.0);
    }

    fn per_second(&mut self, class: ArtifactClass, body: u32, second: i64, value: f64, visibility: f32) {
        let agg = self.seconds.entry((class, body, second)).or_default();
        agg.sum += value;
        agg.sum_sq += value * value;
        agg.n += 1;
        agg.max = agg.max.max(value);
        agg.visibility = agg.visibility.max(visibility);
    }

    fn per_second_vector(&mut self, body: u32, second: i64, extra: Vec3, velocity: Vec3, visibility: f32) {
        let agg = self.seconds.entry((ArtifactClass::UnexplainedAccel, body, second)).or_default();
        agg.vector += extra;
        agg.velocity += velocity;
        agg.n += 1;
        agg.visibility = agg.visibility.max(visibility);
    }

    fn flush_seconds(&mut self, before: i64) {
        let due: Vec<(ArtifactClass, u32, i64)> =
            self.seconds.keys().filter(|(_, _, s)| *s < before).copied().collect();
        let mut due = due;
        due.sort_unstable();
        for key in due {
            let agg = self.seconds.remove(&key).unwrap();
            let n = f64::from(agg.n.max(1));
            let m = match key.0 {
                // rms of the sub-pop step discrepancies
                ArtifactClass::Smoothness => (agg.sum_sq / n).sqrt(),
                // Gravity / accelerations need a sustained run: fewer than
                // 6 samples (100 ms) in the second is not scored.
                ArtifactClass::Gravity | ArtifactClass::UnexplainedAccel | ArtifactClass::EnergyGain if agg.n < 6 => {
                    continue
                }
                // A push is sustained; a wobble or a catch-up step is not:
                // their accelerations cancel over the second.
                ArtifactClass::UnexplainedAccel => {
                    let nf = agg.n.max(1) as f32;
                    weighted_unexplained_accel(agg.vector / nf, agg.velocity / nf)
                }
                // Energy gained net over the second (Yeh et al. 2009: the
                // total energy change), not frame-by-frame excursions.
                ArtifactClass::EnergyGain => (agg.sum / n).max(0.0),
                _ => agg.sum / n,
            };
            self.event_for(key.0, m, agg.visibility, key.1);
        }
    }

    /// One displayed frame at `t_s` seen through `camera`.
    pub fn frame(&mut self, t_s: f64, camera: Camera, items: &[ItemSample]) {
        if let Some(_) = self.first_t {
            let dt = t_s - self.last_t;
            if dt > 0.0 && dt < 0.2 {
                self.frame_dt = self.frame_dt * 0.9 + dt * 0.1;
            }
        }
        self.first_t.get_or_insert(t_s);
        self.last_t = t_s;
        self.frames += 1;
        let second = t_s.floor() as i64;
        if second != self.current_second {
            // A second lag: acceleration samples arrive after the contact
            // window.
            self.flush_seconds(second - 1);
            self.current_second = second;
        }
        let projector = Projector::new(camera, self.model.pane);
        let g = self.gravity.length().max(1e-3);
        let span = (STENCIL as f64 * self.frame_dt) as f32;
        let mut pops: HashMap<u32, (f64, f32)> = HashMap::new();
        for item in items {
            let state = self.items.entry(item.id).or_default();
            let (Some(displayed), Some(truth)) = (item.displayed, item.truth) else {
                *state = ItemState::default();
                continue;
            };
            // World history for accelerations (whether visible or not: a
            // body coming on screen has its history already).
            if state.world_len < state.world.len() {
                state.world[state.world_len] = (displayed.0, truth.0);
                state.world_len += 1;
            } else {
                state.world.rotate_left(1);
                state.world[state.world.len() - 1] = (displayed.0, truth.0);
            }
            let screen_now = match (projector.project(displayed.0), projector.project(truth.0)) {
                (Some((d, _)), Some((t, _))) => Some((d, t)),
                _ => None,
            };
            let last_screen = state.last_screen;
            state.last_screen = screen_now;
            let state = state.clone();
            if item.visibility <= 0.0 {
                continue;
            }
            self.visible_item_frames += 1;
            let vis = item.visibility;
            // V1
            if let Some(error) = corner_error_px(&projector, displayed, truth, item.half_extents) {
                self.sample(ArtifactClass::ScreenError, f64::from(error));
                self.per_second(ArtifactClass::ScreenError, item.body, second, f64::from(error), vis);
            }
            // V2 / V10 / V13
            if let (Some((d_now, t_now)), Some((d_last, t_last))) = (screen_now, last_screen) {
                let discrepancy = ((d_now - d_last) - (t_now - t_last)).length();
                let size = screen_size_px(&projector, truth.0, item.half_extents);
                let threshold = POP_PX.max(POP_SIZE_SHARE * size);
                if discrepancy > threshold {
                    self.sample(ArtifactClass::Pop, f64::from(discrepancy));
                    let entry = pops.entry(item.body).or_insert((0.0, 0.0));
                    entry.0 = entry.0.max(f64::from(discrepancy));
                    entry.1 = entry.1.max(vis);
                } else {
                    self.sample(ArtifactClass::Smoothness, f64::from(discrepancy));
                    self.per_second(ArtifactClass::Smoothness, item.body, second, f64::from(discrepancy), vis);
                }
                // Rubber band: the offset peaks on one side, then on the
                // other within the window, past the threshold both times.
                let offset = d_now - t_now;
                let stored = self.items.get_mut(&item.id).unwrap();
                match stored.swing {
                    None => stored.swing = Some((offset, t_s)),
                    Some((peak, _)) if peak.dot(offset) < 0.0 => {
                        stored.previous_swing = stored.swing;
                        stored.swing = Some((offset, t_s));
                        stored.swing_counted = false;
                    }
                    Some((peak, _)) if offset.length() > peak.length() => stored.swing = Some((offset, t_s)),
                    Some(_) => {}
                }
                if let (Some((now_peak, now_at)), Some((before, before_at))) = (stored.swing, stored.previous_swing) {
                    let smaller = now_peak.length().min(before.length());
                    if !stored.swing_counted && smaller > RUBBER_BAND_PX && now_at - before_at <= RUBBER_BAND_S {
                        stored.swing_counted = true;
                        // One event per body per swing window: a body's
                        // chunks swing together.
                        let last = self.body_band_s.get(&item.body).copied().unwrap_or(f64::MIN);
                        if t_s - last > RUBBER_BAND_S {
                            self.body_band_s.insert(item.body, t_s);
                            self.sample(ArtifactClass::RubberBand, f64::from(smaller));
                            self.event_for(ArtifactClass::RubberBand, f64::from(smaller), vis, item.body);
                        }
                    }
                }
            }
            // V3 / V4 / V5: accelerations and velocities over the stencil.
            if state.world_len >= HISTORY {
                let n = state.world_len;
                let smooth = |end: usize| {
                    let (mut d, mut t) = (Vec3::ZERO, Vec3::ZERO);
                    for k in end + 1 - SMOOTH..=end {
                        d += state.world[k].0;
                        t += state.world[k].1;
                    }
                    (d / SMOOTH as f32, t / SMOOTH as f32)
                };
                let (d0, t0) = smooth(n - 1 - 2 * STENCIL);
                let (d1, t1) = smooth(n - 1 - STENCIL);
                let (d2, t2) = smooth(n - 1);
                let accel = |a: Vec3, b: Vec3, c: Vec3| (a - 2.0 * b + c) / (span * span);
                let velocity = |a: Vec3, c: Vec3| (c - a) / (2.0 * span);
                let (a_d, a_t) = (accel(d0, d1, d2), accel(t0, t1, t2));
                let (v_d, v_t) = (velocity(d0, d2), velocity(t0, t2));
                let free_flight = (a_t - self.gravity).length() <= FREE_FLIGHT_TOLERANCE * g;
                let extra = a_d - a_t;
                let sample = if free_flight {
                    let floor = 0.5 * ENERGY_FLOOR_MPS * ENERGY_FLOOR_MPS;
                    let ke_d = 0.5 * v_d.length_squared();
                    let ke_t = 0.5 * v_t.length_squared();
                    Some(AccelSample {
                        t: t_s,
                        second,
                        body: item.body,
                        vis,
                        gravity: Some(f64::from(extra.y.abs() / g)),
                        extra: Vec3::new(extra.x, 0.0, extra.z),
                        velocity: v_t,
                        energy: Some(f64::from((ke_d - ke_t) / ke_t.max(floor))),
                    })
                } else if a_t.length() <= FREE_FLIGHT_TOLERANCE * g {
                    // Steady motion (resting, gliding): any displayed
                    // acceleration is unexplained.
                    Some(AccelSample { t: t_s, second, body: item.body, vis, gravity: None, extra, velocity: v_t, energy: None })
                } else {
                    None
                };
                if let Some(sample) = sample {
                    self.items.get_mut(&item.id).unwrap().accel_pending.push_back(sample);
                }
            }
        }
        let mut pops: Vec<(u32, (f64, f32))> = pops.into_iter().collect();
        pops.sort_unstable_by_key(|(body, _)| *body);
        for (body, (m, vis)) in pops {
            self.event_for(ArtifactClass::Pop, m, vis, body);
        }
        self.contacts_and_breaks(t_s, items);
        self.overlaps(t_s, items);
        self.commit_accelerations(t_s, items);
        self.resurrections(items);
        self.solid_geometry(items);
        self.group_error(&projector, second, items);
    }

    /// V3/V4/V5 samples wait `CONTACT_WINDOW_S` before they count, and are
    /// dropped when a true contact falls within that window either side: a
    /// mistimed contact is V6's artifact, and would otherwise read as a
    /// gravity, energy and acceleration error too.
    fn commit_accelerations(&mut self, t_s: f64, items: &[ItemSample]) {
        let ids: Vec<u32> = items.iter().map(|i| i.id).collect();
        self.commit_pending(t_s, &ids);
    }

    /// Commit the samples of `ids` older than the contact window (all of them
    /// at `t_s = INFINITY`). A sample taken at `t` measured the motion of the
    /// stencil before it, so a contact touches it from `t - span` on.
    fn commit_pending(&mut self, t_s: f64, ids: &[u32]) {
        let span = (2 * STENCIL + SMOOTH) as f64 * self.frame_dt;
        let mut ready: Vec<AccelSample> = Vec::new();
        for id in ids {
            let Some(state) = self.items.get_mut(id) else { continue };
            while state.accel_pending.front().is_some_and(|a| t_s - a.t > CONTACT_WINDOW_S) {
                let a = state.accel_pending.pop_front().unwrap();
                let near_contact = state
                    .truth_contact_times
                    .iter()
                    .any(|&c| c >= a.t - span - CONTACT_WINDOW_S && c <= a.t + CONTACT_WINDOW_S);
                if !near_contact {
                    ready.push(a);
                }
            }
            while state.truth_contact_times.front().is_some_and(|&c| t_s - c > 3.0 * CONTACT_WINDOW_S + span) {
                state.truth_contact_times.pop_front();
            }
        }
        for a in ready {
            if let Some(v) = a.gravity {
                self.sample(ArtifactClass::Gravity, v);
                self.per_second(ArtifactClass::Gravity, a.body, a.second, v, a.vis);
            }
            self.sample(ArtifactClass::UnexplainedAccel, weighted_unexplained_accel(a.extra, a.velocity));
            self.per_second_vector(a.body, a.second, a.extra, a.velocity, a.vis);
            if let Some(e) = a.energy {
                self.sample(ArtifactClass::EnergyGain, e.max(0.0));
                self.per_second(ArtifactClass::EnergyGain, a.body, a.second, e, a.vis);
            }
        }
    }

    /// V8: a pile of debris drawn shifted as a whole. Visible loose chunks
    /// are grouped by the `GROUP_CELL_M` cell of their true position; a
    /// group of at least `GROUP_MIN` has the mean of its members' on-screen
    /// displacement (drawn minus true centre). Independent errors cancel in
    /// the mean; a shared shift does not, and an ensemble's motion is seen
    /// more accurately than any member's (Whitney & Yamanashi Leib 2018).
    /// Per group per second, the mean magnitude.
    fn group_error(&mut self, projector: &Projector, second: i64, items: &[ItemSample]) {
        let mut groups: BTreeMap<(i32, i32, i32), (glam::Vec2, u32, f32)> = BTreeMap::new();
        for item in items {
            if item.visibility <= 0.0 || item.displayed_standing || item.truth_standing {
                continue;
            }
            let (Some((dp, _)), Some((tp, _))) = (item.displayed, item.truth) else { continue };
            let (Some((d, _)), Some((t, _))) = (projector.project(dp), projector.project(tp)) else { continue };
            let cell = (tp / GROUP_CELL_M).floor();
            let g = groups.entry((cell.x as i32, cell.y as i32, cell.z as i32)).or_insert((glam::Vec2::ZERO, 0, 0.0));
            g.0 += d - t;
            g.1 += 1;
            g.2 = g.2.max(item.visibility);
        }
        for ((x, y, z), (sum, n, vis)) in groups {
            if n < GROUP_MIN {
                continue;
            }
            let shift = f64::from((sum / n as f32).length());
            let id = (x as u32).wrapping_mul(73_856_093) ^ (y as u32).wrapping_mul(19_349_663) ^ (z as u32).wrapping_mul(83_492_791);
            self.sample(ArtifactClass::GroupError, shift);
            self.per_second(ArtifactClass::GroupError, id, second, shift, vis);
        }
    }

    /// The static world for the next frames (standing chunks as drawn); the
    /// ground plane is y = 0 always.
    pub fn set_static_world(&mut self, boxes: Vec<StaticBox>) {
        self.static_cells.clear();
        for (i, b) in boxes.iter().enumerate() {
            let r = b.half_extents.length();
            let lo = ((b.position - Vec3::splat(r)) / STATIC_CELL).floor();
            let hi = ((b.position + Vec3::splat(r)) / STATIC_CELL).floor();
            for x in lo.x as i32..=hi.x as i32 {
                for y in lo.y as i32..=hi.y as i32 {
                    for z in lo.z as i32..=hi.z as i32 {
                        self.static_cells.entry((x, y, z)).or_default().push(i as u32);
                    }
                }
            }
        }
        self.statics = boxes;
    }

    /// G4: each visible loose drawn chunk's inscribed sphere against the
    /// ground and the standing boxes near it, against the truth's own depth
    /// (truth rests on the ground and against walls, so only depth beyond
    /// it is the display's).
    fn solid_geometry(&mut self, items: &[ItemSample]) {
        let mut bodies: HashMap<u32, f32> = HashMap::new();
        for item in items {
            if item.visibility <= 0.0 || item.displayed_standing {
                continue;
            }
            let (Some((dp, _)), Some((tp, _))) = (item.displayed, item.truth) else { continue };
            let r = item.half_extents.min_element();
            let depth = |p: Vec3| -> f32 {
                let mut d = r - p.y;
                let cell = (p / STATIC_CELL).floor();
                if let Some(list) = self.static_cells.get(&(cell.x as i32, cell.y as i32, cell.z as i32)) {
                    for &i in list {
                        d = d.max(self.statics[i as usize].sphere_depth(p, r));
                    }
                }
                d
            };
            let extra = depth(dp) - depth(tp).max(0.0);
            if extra > G4_TOLERANCE_M && std::env::var_os("NETLAB2_G4_TRACE").is_some() {
                // Diagnosis: where, how deep, and into what.
                eprintln!(
                    "G4 t={:.3} body={} drawn_body={} slot={} r={:.3} shown={:?} truth={:?} ground_shown={:.3} ground_truth={:.3} depth_shown={:.3} depth_truth={:.3}",
                    self.last_t, item.body, item.displayed_body, item.id, r, dp, tp, r - dp.y, r - tp.y, depth(dp), depth(tp)
                );
            }
            if extra > G4_TOLERANCE_M {
                let e = bodies.entry(item.displayed_body).or_insert(0.0);
                *e = e.max(extra);
            }
        }
        self.g4_frames += bodies.len() as u64;
        for depth in bodies.values() {
            self.g4_worst_cm = self.g4_worst_cm.max(f64::from(*depth) * 100.0);
        }
    }

    fn resurrections(&mut self, items: &[ItemSample]) {
        let mut bodies = std::collections::HashSet::new();
        let mut snaps = std::collections::HashSet::new();
        for item in items {
            if !item.truth_settled || item.visibility <= 0.0 {
                continue;
            }
            let Some(state) = self.items.get(&item.id) else { continue };
            if state.world_len < 2 {
                continue;
            }
            let (d1, t1) = state.world[state.world_len - 1];
            let (d0, t0) = state.world[state.world_len - 2];
            if d1.distance(d0) > 0.01 && t1.distance(t0) < 0.001 {
                if d1.distance(t1) < d0.distance(t0) {
                    snaps.insert(item.body);
                    continue;
                }
                if std::env::var_os("NETLAB2_G5_TRACE").is_some() {
                    // Diagnosis: the step, and how far the drawn pose is
                    // from the still truth before and after it.
                    eprintln!(
                        "G5 t={:.3} body={} slot={} step={:.4} off_before={:.4} off_after={:.4}",
                        self.last_t,
                        item.body,
                        item.id,
                        d1.distance(d0),
                        d0.distance(t0),
                        d1.distance(t1)
                    );
                }
                bodies.insert(item.body);
            }
        }
        snaps.retain(|b| !bodies.contains(b));
        self.g5_frames += bodies.len() as u64;
        self.g5_snap_frames += snaps.len() as u64;
    }

    /// V6 contact timing and V7 cause to effect.
    ///
    /// A contact is an impulse: a frame-to-frame velocity change more than
    /// `CONTACT_DV` away from gravity's, found the same way in the true and
    /// the displayed motion. Each true contact is matched to the nearest
    /// displayed one of the same chunk within `CONTACT_WINDOW_S`; the event is
    /// the offset (ms), or the window when the display smoothed it away. One
    /// event per body per contact.
    ///
    /// A break (V7) is the frame a chunk stops being drawn on its standing
    /// structure; its fragments start to move when the drawn chunk has left
    /// that spot by a centimetre. The event is how many frames later that
    /// happens than it does in the truth.
    fn contacts_and_breaks(&mut self, t_s: f64, items: &[ItemSample]) {
        let g = self.gravity;
        let dt_frame = self.frame_dt;
        let mut contacts: Vec<(u32, f64, f32)> = Vec::new();
        let mut breaks: Vec<(u32, f64, f32)> = Vec::new();
        for item in items {
            let Some(state) = self.items.get_mut(&item.id) else { continue };
            if !state.seen {
                state.seen = true;
                state.was_displayed_standing = true;
                state.was_truth_standing = true;
            }
            // V7
            if state.was_displayed_standing && !item.displayed_standing {
                if let Some((p, _)) = item.displayed {
                    state.break_displayed = Some((t_s, p, None));
                    state.break_scored = false;
                }
            }
            if state.was_truth_standing && !item.truth_standing {
                if let Some((p, _)) = item.truth {
                    state.break_truth = Some((t_s, p, None));
                    state.break_scored = false;
                }
            }
            state.was_displayed_standing = item.displayed_standing;
            state.was_truth_standing = item.truth_standing;
            for (slot, now) in [(&mut state.break_displayed, item.displayed), (&mut state.break_truth, item.truth)] {
                if let (Some((_, at, moved @ None)), Some((p, _))) = (slot.as_mut(), now) {
                    if p.distance(*at) > 0.01 {
                        *moved = Some(t_s);
                    }
                }
            }
            if !state.break_scored {
                if let (Some((bd, _, Some(md))), Some((bt, _, Some(mt)))) = (state.break_displayed, state.break_truth) {
                    state.break_scored = true;
                    let late_frames = ((md - bd) - (mt - bt)) / dt_frame;
                    breaks.push((item.body, late_frames.max(0.0), item.visibility));
                }
            }
            // V6
            let (Some((dp, _)), Some((tp, _))) = (item.displayed, item.truth) else {
                state.contact_last = None;
                state.contact_velocity = None;
                continue;
            };
            if let Some((t0, dp0, tp0)) = state.contact_last {
                let dt = (t_s - t0) as f32;
                if dt > 1e-4 {
                    let (dv, tv) = ((dp - dp0) / dt, (tp - tp0) / dt);
                    // A fragment starting to move off its structure is an
                    // impulse too, but it is V7's to score.
                    let just_broke = [state.break_displayed, state.break_truth]
                        .iter()
                        .any(|b| b.is_some_and(|(t, _, _)| t_s - t <= CONTACT_WINDOW_S));
                    if let (Some((dv0, tv0)), false) = (state.contact_velocity, just_broke) {
                        let impulse = |v: Vec3, v0: Vec3| (v - v0 - g * dt).length() > CONTACT_DV;
                        if impulse(tv, tv0) {
                            state.truth_contacts.push_back(t_s);
                            state.truth_contact_times.push_back(t_s);
                        }
                        if impulse(dv, dv0) {
                            state.displayed_contacts.push_back(t_s);
                        }
                    }
                    state.contact_velocity = Some((dv, tv));
                }
            }
            state.contact_last = Some((t_s, dp, tp));
            // Match: a true contact old enough to have seen the window.
            while let Some(&tc) = state.truth_contacts.front() {
                let near = state
                    .displayed_contacts
                    .iter()
                    .copied()
                    .filter(|d| (d - tc).abs() <= CONTACT_WINDOW_S)
                    .min_by(|a, b| (a - tc).abs().total_cmp(&(b - tc).abs()));
                if near.is_none() && t_s - tc < CONTACT_WINDOW_S {
                    break;
                }
                state.truth_contacts.pop_front();
                let offset_ms = near.map_or(CONTACT_WINDOW_S * 1000.0, |d| (d - tc).abs() * 1000.0);
                if let Some(d) = near {
                    state.displayed_contacts.retain(|&x| x != d);
                }
                contacts.push((item.body, offset_ms, item.visibility));
            }
            while state.displayed_contacts.front().is_some_and(|&d| t_s - d > 2.0 * CONTACT_WINDOW_S) {
                state.displayed_contacts.pop_front();
            }
        }
        for (body, m, vis) in contacts {
            let last = self.body_contact_s.get(&body).copied().unwrap_or(f64::MIN);
            if vis > 0.0 && t_s - last > 0.1 {
                self.body_contact_s.insert(body, t_s);
                self.sample(ArtifactClass::ContactTiming, m);
                self.event_for(ArtifactClass::ContactTiming, m, vis, body);
            }
        }
        let mut seen = std::collections::HashSet::new();
        for (body, m, vis) in breaks {
            if vis > 0.0 && seen.insert(body) {
                self.sample(ArtifactClass::CauseEffect, m);
                self.event_for(ArtifactClass::CauseEffect, m, vis, body);
            }
        }
    }

    /// V11: two visible dynamic chunks of different drawn bodies overlapping
    /// more than they do in the truth, by their inscribed spheres (a lower
    /// bound on the boxes' penetration, so a hit is a real overlap). Per pair
    /// of bodies per second, at the worst depth (cm).
    fn overlaps(&mut self, t_s: f64, items: &[ItemSample]) {
        let second = t_s.floor() as i64;
        let mut cells: HashMap<(i32, i32, i32), Vec<usize>> = HashMap::new();
        let live: Vec<usize> = (0..items.len())
            .filter(|&i| items[i].visibility > 0.0 && items[i].displayed.is_some() && items[i].truth.is_some() && !items[i].displayed_standing)
            .collect();
        for &i in &live {
            let p = items[i].displayed.unwrap().0;
            cells.entry(((p.x).floor() as i32, (p.y).floor() as i32, (p.z).floor() as i32)).or_default().push(i);
        }
        let mut worst: HashMap<(u32, u32), (f64, f32)> = HashMap::new();
        for &i in &live {
            let a = &items[i];
            let (pa, ta) = (a.displayed.unwrap().0, a.truth.unwrap().0);
            let ra = a.half_extents.min_element();
            let c = ((pa.x).floor() as i32, (pa.y).floor() as i32, (pa.z).floor() as i32);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let Some(list) = cells.get(&(c.0 + dx, c.1 + dy, c.2 + dz)) else { continue };
                        for &j in list {
                            if j <= i {
                                continue;
                            }
                            let b = &items[j];
                            if b.displayed_body == a.displayed_body || b.body == a.body {
                                continue;
                            }
                            let r = ra + b.half_extents.min_element();
                            let shown = r - pa.distance(b.displayed.unwrap().0);
                            let truly = r - ta.distance(b.truth.unwrap().0);
                            let extra = f64::from(shown - truly.max(0.0)) * 100.0;
                            if extra > 0.0 {
                                let key = (a.body.min(b.body), a.body.max(b.body));
                                let e = worst.entry(key).or_insert((0.0, 0.0));
                                e.0 = e.0.max(extra);
                                e.1 = e.1.max(a.visibility.min(b.visibility));
                            }
                        }
                    }
                }
            }
        }
        let mut worst: Vec<_> = worst.into_iter().collect();
        worst.sort_unstable_by_key(|(k, _)| *k);
        for ((a, b), (depth, vis)) in worst {
            self.sample(ArtifactClass::Overlap, depth);
            let agg = self.seconds.entry((ArtifactClass::Overlap, a ^ b.rotate_left(16), second)).or_default();
            agg.sum = agg.sum.max(depth);
            agg.n = 1;
            agg.visibility = agg.visibility.max(vis);
        }
    }

    pub fn report(&mut self) -> PerceptualReport {
        let mut ids: Vec<u32> = self.items.keys().copied().collect();
        ids.sort_unstable();
        self.commit_pending(f64::INFINITY, &ids);
        self.flush_seconds(i64::MAX);
        let minutes = match self.first_t {
            Some(first) => ((self.last_t - first) + self.frame_dt) / 60.0,
            None => 0.0,
        };
        let mut report = PerceptualReport {
            model_calibration: self.model.calibration.clone(),
            minutes,
            frames: self.frames,
            visible_item_frames: self.visible_item_frames,
            ..Default::default()
        };
        let mut total = 0.0;
        for (class, acc) in &self.classes {
            let summary = acc.hist.summary();
            let per_minute = if minutes > 0.0 { acc.penalty / minutes } else { 0.0 };
            total += per_minute;
            report.classes.insert(
                class.name().to_string(),
                ClassReport {
                    unit: self.model.class(*class).unit.clone(),
                    p50: f64::from(summary.p50),
                    p95: f64::from(summary.p95),
                    p99: f64::from(summary.p99),
                    max: f64::from(summary.max),
                    samples: f64::from(summary.weight),
                    events: acc.events,
                    events_at_theta: acc.events_at_theta,
                    events_at_theta_per_minute: if minutes > 0.0 { acc.events_at_theta as f64 / minutes } else { 0.0 },
                    penalty_per_minute: per_minute,
                },
            );
        }
        report.penalty_per_minute = total;
        report.g5_resurrection_frames = self.g5_frames;
        report.g5_settle_snap_frames = self.g5_snap_frames;
        report.g4_solid_frames = self.g4_frames;
        report.g4_worst_cm = self.g4_worst_cm;
        report.q = self.model.quality(total);
        report.not_measured = vec![
            "V9 video score (ColorVideoVDP)".into(),
            "V12 audio sync (the lab replays no audio)".into(),
        ];
        report
    }
}

/// A low-resolution object-ID buffer: every displayed box rasterised with a
/// depth test, so an item is visible when any of its pixels survive. Free
/// gaze, no effects: what a viewer could see.
pub struct IdBuffer {
    width: usize,
    height: usize,
    depth: Vec<f32>,
    id: Vec<u32>,
    scale: Vec2,
}

const NO_ID: u32 = u32::MAX;

impl IdBuffer {
    /// A buffer of `width` x `height` for a pane of `pane` pixels.
    pub fn new(width: usize, height: usize, pane: (u32, u32)) -> Self {
        Self {
            width,
            height,
            depth: vec![f32::INFINITY; width * height],
            id: vec![NO_ID; width * height],
            scale: Vec2::new(width as f32 / pane.0 as f32, height as f32 / pane.1 as f32),
        }
    }

    pub fn clear(&mut self) {
        self.depth.fill(f32::INFINITY);
        self.id.fill(NO_ID);
    }

    /// Rasterise a box's twelve triangles under item id `id`.
    pub fn draw_box(&mut self, projector: &Projector, id: u32, position: Vec3, rotation: Quat, half_extents: Vec3) {
        if !projector.sphere_on_screen(position, half_extents.length()) {
            return;
        }
        let corners = crate::perception::box_corners(position, rotation, half_extents);
        let half = projector.pane_half();
        // Faces as corner quads (bit order x, y, z), each clipped at the near
        // plane: a box reaching behind the eye covers what is in front of it.
        const FACES: [[usize; 4]; 6] =
            [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
        for face in FACES {
            let poly: Vec<(Vec2, f32)> = projector
                .project_polygon(&face.map(|i| corners[i]))
                .into_iter()
                .map(|(p, d)| (Vec2::new((p.x + half.x) * self.scale.x, (half.y - p.y) * self.scale.y), d))
                .collect();
            for k in 1..poly.len().saturating_sub(1) {
                self.triangle(id, poly[0], poly[k], poly[k + 1]);
            }
        }
    }

    fn triangle(&mut self, id: u32, a: (Vec2, f32), b: (Vec2, f32), c: (Vec2, f32)) {
        let min_x = a.0.x.min(b.0.x).min(c.0.x).floor().max(0.0) as i64;
        let max_x = a.0.x.max(b.0.x).max(c.0.x).ceil().min(self.width as f32 - 1.0) as i64;
        let min_y = a.0.y.min(b.0.y).min(c.0.y).floor().max(0.0) as i64;
        let max_y = a.0.y.max(b.0.y).max(c.0.y).ceil().min(self.height as f32 - 1.0) as i64;
        if min_x > max_x || min_y > max_y {
            return;
        }
        let edge = |p: Vec2, q: Vec2, r: Vec2| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        let area = edge(a.0, b.0, c.0);
        if area.abs() < 1e-6 {
            return;
        }
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let p = Vec2::new(x as f32 + 0.5, y as f32 + 0.5);
                let w0 = edge(b.0, c.0, p) / area;
                let w1 = edge(c.0, a.0, p) / area;
                let w2 = edge(a.0, b.0, p) / area;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                    continue;
                }
                let depth = w0 * a.1 + w1 * b.1 + w2 * c.1;
                let i = y as usize * self.width + x as usize;
                if depth < self.depth[i] {
                    self.depth[i] = depth;
                    self.id[i] = id;
                }
            }
        }
    }

    /// Item ids with at least one visible pixel.
    pub fn visible_ids(&self) -> std::collections::HashSet<u32> {
        self.id.iter().copied().filter(|&id| id != NO_ID).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f64 = 1.0 / 60.0;
    const G: Vec3 = Vec3::new(0.0, -9.81, 0.0);

    fn camera(distance: f32) -> Camera {
        Camera { eye: Vec3::new(0.0, 5.0, distance), direction: -Vec3::Z, fov_degrees: 80.0 }
    }

    /// A metre per pixel at `distance` on the lab's 1080-line pane, 80 deg.
    fn metres_per_px(distance: f32) -> f32 {
        distance * (40.0f32.to_radians().tan()) / 540.0
    }

    /// A body thrown sideways and falling for `seconds`, truth and displayed
    /// (the displayed made by `display(t, truth)`), through the evaluator.
    fn run(distance: f32, seconds: f64, display: impl Fn(f64, Vec3) -> Vec3) -> PerceptualReport {
        let mut eval = PerceptualEval::new(PerceptualModel::literature(), G);
        let frames = (seconds / DT) as usize;
        for i in 0..frames {
            let t = i as f64 * DT;
            let tf = t as f32;
            let truth = Vec3::new(-6.0 + 4.0 * tf, 30.0 + 2.0 * tf + 0.5 * G.y * tf * tf, 0.0);
            let shown = display(t, truth);
            let item = ItemSample {
                id: 1,
                body: 7,
                half_extents: Vec3::splat(0.4),
                mass: 100.0,
                displayed: Some((shown, Quat::IDENTITY)),
                truth: Some((truth, Quat::IDENTITY)),
                visibility: 1.0,
                ..Default::default()
            };
            eval.frame(t, camera(distance), &[item]);
        }
        eval.report()
    }

    /// Classes whose events reached their threshold (noticed at least half
    /// the time).
    fn fired(report: &PerceptualReport) -> Vec<String> {
        report.classes.iter().filter(|(_, c)| c.events_at_theta > 0).map(|(k, _)| k.clone()).collect()
    }

    #[test]
    fn the_truth_itself_fires_nothing() {
        let report = run(40.0, 3.0, |_, truth| truth);
        assert!(fired(&report).is_empty(), "{:?}", fired(&report));
        assert!(report.q > 99.9, "Q {}", report.q);
    }

    #[test]
    fn a_half_pixel_jitter_is_unsmooth_and_nothing_else() {
        // Alternating +-0.5 px sideways: step discrepancies of 1 px, under
        // the pop threshold, every frame.
        let px = metres_per_px(40.0);
        let report = run(40.0, 3.0, |t, truth| {
            let sign = if ((t / DT).round() as i64) % 2 == 0 { 0.5 } else { -0.5 };
            truth + Vec3::new(sign * px, 0.0, 0.0)
        });
        assert_eq!(fired(&report), vec!["smoothness".to_string()]);
    }

    #[test]
    fn a_straight_line_instead_of_the_arc_breaks_gravity_and_nothing_else() {
        // The spec's case: straight lines between keyframes a second apart
        // (zero g across the gap), far enough that the sag stays under the
        // screen-error threshold.
        let report = run(400.0, 4.0, |t, _| {
            let key = t.floor();
            let at = |s: f64| {
                let s = s as f32;
                Vec3::new(-6.0 + 4.0 * s, 30.0 + 2.0 * s + 0.5 * G.y * s * s, 0.0)
            };
            at(key).lerp(at(key + 1.0), (t - key) as f32)
        });
        assert!(report.classes["gravity"].events_at_theta > 0, "{:?}", report.classes["gravity"]);
        assert_eq!(fired(&report), vec!["gravity".to_string()]);
    }

    #[test]
    fn an_added_sideways_push_is_unexplained_acceleration_and_nothing_else() {
        // 3 m/s^2 across the motion (no work along it), far enough that the
        // drift stays under the screen-error threshold. Across the motion is
        // the only way to push without adding much kinetic energy.
        let report = run(900.0, 1.5, |t, truth| truth + Vec3::new(0.0, 0.0, 0.5 * 3.0 * (t * t) as f32));
        assert_eq!(fired(&report), vec!["unexplained_accel".to_string()]);
    }

    #[test]
    fn a_sudden_three_pixel_step_is_a_pop_and_nothing_else() {
        let px = metres_per_px(40.0);
        // 2.5 px behind, then caught up in one frame at 1.5 s.
        let report = run(40.0, 3.0, |t, truth| if t < 1.5 { truth - Vec3::new(2.5 * px, 0.0, 0.0) } else { truth });
        assert_eq!(fired(&report), vec!["pop".to_string()]);
        assert_eq!(report.classes["pop"].events, 1);
    }

    #[test]
    fn an_overshoot_that_swings_back_is_rubber_banding_and_nothing_else() {
        let px = metres_per_px(40.0);
        // A 2.5 px offset swinging side to side every 0.25 s, smoothly.
        let report = run(40.0, 3.0, |t, truth| {
            truth + Vec3::new(2.5 * px * (t * std::f64::consts::TAU / 0.5).sin() as f32, 0.0, 0.0)
        });
        assert!(report.classes["rubber_band"].events > 0);
        assert_eq!(fired(&report), vec!["rubber_band".to_string()]);
    }

    #[test]
    fn a_steady_four_pixel_offset_is_screen_error_and_nothing_else() {
        let px = metres_per_px(40.0);
        let report = run(40.0, 3.0, |_, truth| truth + Vec3::new(4.0 * px, 0.0, 0.0));
        assert_eq!(fired(&report), vec!["screen_error".to_string()]);
    }

    #[test]
    fn a_faster_throw_gains_energy_and_nothing_else() {
        // Displayed 40% faster sideways from the start, far away.
        let report = run(900.0, 1.0, |t, truth| truth + Vec3::new(1.6 * t as f32, 0.0, 0.0));
        assert!(report.classes["energy_gain"].events_at_theta > 0, "{:?}", report.classes["energy_gain"]);
        assert_eq!(fired(&report), vec!["energy_gain".to_string()]);
    }

    #[test]
    fn an_occluded_item_is_not_scored() {
        let mut eval = PerceptualEval::new(PerceptualModel::literature(), G);
        let item = ItemSample {
            id: 1,
            body: 1,
            half_extents: Vec3::splat(0.5),
            mass: 1.0,
            displayed: Some((Vec3::new(5.0, 5.0, 0.0), Quat::IDENTITY)),
            truth: Some((Vec3::ZERO, Quat::IDENTITY)),
            visibility: 0.0,
            ..Default::default()
        };
        for i in 0..120 {
            eval.frame(i as f64 * DT, camera(40.0), &[item]);
        }
        let report = eval.report();
        assert_eq!(report.visible_item_frames, 0);
        assert!(fired(&report).is_empty());
    }

    /// Frames of several items, each made by `make(t)`, through the
    /// evaluator from 400 m away (screen errors stay under a pixel).
    fn run_items(seconds: f64, make: impl Fn(f64) -> Vec<ItemSample>) -> PerceptualReport {
        let mut eval = PerceptualEval::new(PerceptualModel::literature(), G);
        for i in 0..(seconds / DT) as usize {
            let t = i as f64 * DT;
            eval.frame(t, camera(400.0), &make(t));
        }
        eval.report()
    }

    #[test]
    fn a_pile_shifted_together_is_group_error_but_scattered_errors_are_not() {
        // Ten pieces in one 4 m cell, drawn 3 m off at 100 m (about 16 px):
        // all the same way, or alternating so the mean is zero.
        let pile = |t: f64, shared: bool| -> Vec<ItemSample> {
            (0..10u32)
                .map(|i| {
                    let truth = Vec3::new(0.3 * i as f32, 1.0 + (t as f32) * 0.0, 0.0);
                    let sign = if shared || i % 2 == 0 { 1.0 } else { -1.0 };
                    ItemSample {
                        id: i,
                        body: i,
                        half_extents: Vec3::splat(0.1),
                        mass: 1.0,
                        displayed: Some((truth + Vec3::X * 3.0 * sign, Quat::IDENTITY)),
                        truth: Some((truth, Quat::IDENTITY)),
                        visibility: 1.0,
                        displayed_body: i,
                        displayed_standing: false,
                        truth_standing: false,
                        truth_settled: false,
                    }
                })
                .collect()
        };
        let run = |shared: bool| {
            let mut eval = PerceptualEval::new(PerceptualModel::literature(), G);
            for i in 0..120 {
                eval.frame(i as f64 * DT, camera(100.0), &pile(i as f64 * DT, shared));
            }
            eval.report()
        };
        let shifted = run(true);
        let group = &shifted.classes["group_error"];
        assert!(group.events >= 2 && group.max > 10.0, "{group:?}");
        let scattered = run(false);
        assert!(scattered.classes.get("group_error").map_or(true, |g| g.max < 0.5), "{:?}", scattered.classes.get("group_error"));
    }

    #[test]
    fn a_chunk_drawn_inside_the_ground_or_a_wall_fails_g4_but_resting_on_them_does_not() {
        let item = |id: u32, shown: Vec3, truth: Vec3| ItemSample {
            id,
            body: id,
            half_extents: Vec3::splat(0.3),
            mass: 1.0,
            displayed: Some((shown, Quat::IDENTITY)),
            truth: Some((truth, Quat::IDENTITY)),
            visibility: 1.0,
            displayed_body: id,
            displayed_standing: false,
            truth_standing: false,
            truth_settled: false,
        };
        let wall = StaticBox { position: Vec3::new(5.0, 2.0, 0.0), rotation: Quat::IDENTITY, half_extents: Vec3::new(0.5, 2.0, 3.0) };
        let run = |shown: Vec3, truth: Vec3| {
            let mut eval = PerceptualEval::new(PerceptualModel::literature(), G);
            eval.set_static_world(vec![wall]);
            for i in 0..30 {
                eval.frame(i as f64 * DT, camera(20.0), &[item(1, shown, truth)]);
            }
            eval.report()
        };
        // Resting on the ground and against the wall, as the truth does.
        let ok = run(Vec3::new(0.0, 0.3, 0.0), Vec3::new(0.0, 0.3, 0.0));
        assert_eq!(ok.g4_solid_frames, 0);
        let leaning = run(Vec3::new(4.2, 1.0, 0.0), Vec3::new(4.2, 1.0, 0.0));
        assert_eq!(leaning.g4_solid_frames, 0, "touching the wall as the truth does");
        // 20 cm into the ground where the truth rests on it.
        let sunk = run(Vec3::new(0.0, 0.1, 0.0), Vec3::new(0.0, 0.3, 0.0));
        assert_eq!(sunk.g4_solid_frames, 30);
        assert!((sunk.g4_worst_cm - 20.0).abs() < 0.1, "{}", sunk.g4_worst_cm);
        // Half inside the wall.
        let walled = run(Vec3::new(4.6, 1.0, 0.0), Vec3::new(4.0, 1.0, 0.0));
        assert_eq!(walled.g4_solid_frames, 30);
        assert!(walled.g4_worst_cm > 30.0);
    }

    #[test]
    fn a_rest_snap_is_a_settle_correction_but_drifting_off_rest_is_a_resurrection() {
        // The truth lies still from 1 s. Display A lies 3 cm off it and snaps
        // onto it at 1.5 s; display B lies still and then slides away
        // at 1 m/s from 1.5 s.
        let still = Vec3::new(0.0, 0.3, 0.0);
        let item = |id: u32, shown: Vec3, t: f64| ItemSample {
            id,
            body: id,
            half_extents: Vec3::splat(0.3),
            mass: 1.0,
            displayed: Some((shown, Quat::IDENTITY)),
            truth: Some((still, Quat::IDENTITY)),
            visibility: 1.0,
            displayed_body: id,
            displayed_standing: false,
            truth_standing: false,
            truth_settled: t >= 1.0,
        };
        let snap = run_items(2.0, |t| vec![item(1, if t < 1.5 { still + Vec3::X * 0.03 } else { still }, t)]);
        assert_eq!((snap.g5_resurrection_frames, snap.g5_settle_snap_frames), (0, 1), "{snap:?}");
        let drift = run_items(2.0, |t| vec![item(2, still + Vec3::X * (t - 1.5).max(0.0) as f32, t)]);
        assert!(drift.g5_resurrection_frames >= 25, "{}", drift.g5_resurrection_frames);
        assert_eq!(drift.g5_settle_snap_frames, 0);
    }

    #[test]
    fn a_bounce_shown_80_ms_late_is_contact_timing_and_nothing_else() {
        // A drop from 10 m that bounces at t0 (restitution 0.5); the display
        // keeps falling 80 ms past it, then bounces the same way.
        let fall = |t: f64| 10.0 - 0.5 * 9.81 * t * t;
        let t0 = 1.0;
        let path = |t: f64, contact: f64| -> f64 {
            if t < contact {
                fall(t)
            } else {
                let (y0, v) = (fall(contact), 0.5 * 9.81 * contact);
                let s = t - contact;
                y0 + v * s - 0.5 * 9.81 * s * s
            }
        };
        let report = run_items(2.5, |t| {
            vec![ItemSample {
                id: 1,
                body: 1,
                half_extents: Vec3::splat(0.3),
                mass: 1.0,
                displayed: Some((Vec3::new(0.0, path(t, t0 + 0.08) as f32, 0.0), Quat::IDENTITY)),
                truth: Some((Vec3::new(0.0, path(t, t0) as f32, 0.0), Quat::IDENTITY)),
                visibility: 1.0,
                ..Default::default()
            }]
        });
        let contact = &report.classes["contact_timing"];
        assert_eq!(contact.events, 1, "{contact:?}");
        // Detected at frame boundaries: 80 ms is 66.7-83.3 ms in frames.
        assert!((60.0..=95.0).contains(&contact.max), "{contact:?}");
        assert_eq!(fired(&report), vec!["contact_timing".to_string()]);
        // On time: nothing.
        let on_time = run_items(2.5, |t| {
            let p = Vec3::new(0.0, path(t, t0) as f32, 0.0);
            vec![ItemSample { id: 1, body: 1, half_extents: Vec3::splat(0.3), mass: 1.0, displayed: Some((p, Quat::IDENTITY)), truth: Some((p, Quat::IDENTITY)), visibility: 1.0, ..Default::default() }]
        });
        assert!(fired(&on_time).is_empty(), "{:?}", fired(&on_time));
    }

    #[test]
    fn fragments_that_start_moving_six_frames_after_the_break_are_cause_to_effect_and_nothing_else() {
        // The chunk breaks off at 1 s and slides away at 2 m/s; the display
        // shows the break on time but holds it still for 6 frames first.
        let report = run_items(2.5, |t| {
            let truth = Vec3::new(2.0 * (t - 1.0).max(0.0) as f32, 1.0, 0.0);
            let shown = Vec3::new(2.0 * (t - 1.1).max(0.0) as f32, 1.0, 0.0);
            vec![ItemSample {
                id: 1,
                body: 1,
                half_extents: Vec3::splat(0.3),
                mass: 1.0,
                displayed: Some((shown, Quat::IDENTITY)),
                truth: Some((truth, Quat::IDENTITY)),
                visibility: 1.0,
                displayed_body: 1,
                displayed_standing: t < 1.0,
                truth_standing: t < 1.0,
                truth_settled: false,
            }]
        });
        let cause = &report.classes["cause_effect"];
        assert_eq!(cause.events, 1, "{cause:?}");
        assert!((5.0..=7.0).contains(&cause.max), "{cause:?}");
        assert_eq!(fired(&report), vec!["cause_effect".to_string()]);
    }

    #[test]
    fn two_bodies_shown_10_cm_into_each_other_overlap_and_nothing_else() {
        // Two crates at rest, touching in the truth; the display has one
        // 10 cm into the other.
        let report = run_items(2.0, |_| {
            let crate_at = |id: u32, x: f32, shown_x: f32| ItemSample {
                id,
                body: id,
                half_extents: Vec3::splat(0.5),
                mass: 1.0,
                displayed: Some((Vec3::new(shown_x, 0.5, 0.0), Quat::IDENTITY)),
                truth: Some((Vec3::new(x, 0.5, 0.0), Quat::IDENTITY)),
                visibility: 1.0,
                displayed_body: id,
                ..Default::default()
            };
            vec![crate_at(1, 0.0, 0.0), crate_at(2, 1.0, 0.9)]
        });
        let overlap = &report.classes["overlap"];
        assert!(overlap.events >= 1, "{overlap:?}");
        assert!((9.0..=11.0).contains(&overlap.max), "{overlap:?}");
        assert_eq!(fired(&report), vec!["overlap".to_string()]);
    }

    #[test]
    fn the_id_buffer_hides_what_is_behind_a_wall() {
        let cam = camera(40.0);
        let projector = Projector::new(cam, (1920, 1080));
        let mut buffer = IdBuffer::new(240, 135, (1920, 1080));
        // A wall at z = 10 in front of a small box at z = 0, both on axis.
        buffer.draw_box(&projector, 1, Vec3::new(0.0, 5.0, 0.0), Quat::IDENTITY, Vec3::splat(0.5));
        buffer.draw_box(&projector, 2, Vec3::new(0.0, 5.0, 10.0), Quat::IDENTITY, Vec3::new(10.0, 10.0, 0.5));
        let visible = buffer.visible_ids();
        assert!(visible.contains(&2));
        assert!(!visible.contains(&1), "the box is behind the wall");
        buffer.clear();
        buffer.draw_box(&projector, 1, Vec3::new(0.0, 5.0, 0.0), Quat::IDENTITY, Vec3::splat(0.5));
        assert!(buffer.visible_ids().contains(&1));
    }

    /// A beam passing beside the eye reaches behind it. Its side face crosses
    /// the near plane and must be clipped there, not dropped: it hides the
    /// box behind it. (Faces with corners behind the eye were drawn from
    /// their remaining corners or not at all, so pieces near the camera
    /// flickered and popped in clips and visibility.)
    #[test]
    fn a_box_reaching_behind_the_eye_still_covers_what_it_hides() {
        let cam = camera(40.0);
        let projector = Projector::new(cam, (1920, 1080));
        let mut buffer = IdBuffer::new(240, 135, (1920, 1080));
        buffer.draw_box(&projector, 1, Vec3::new(1.0, 5.0, 40.0), Quat::IDENTITY, Vec3::new(0.3, 0.3, 5.0));
        buffer.draw_box(&projector, 2, Vec3::new(3.0, 5.0, 30.0), Quat::IDENTITY, Vec3::splat(0.5));
        let visible = buffer.visible_ids();
        assert!(visible.contains(&1));
        assert!(!visible.contains(&2), "the beam's side face covers the box");
        // The clipped face stays in front of the near plane.
        let face = [Vec3::new(0.7, 4.7, 35.0), Vec3::new(0.7, 4.7, 45.0), Vec3::new(0.7, 5.3, 45.0), Vec3::new(0.7, 5.3, 35.0)];
        let poly = projector.project_polygon(&face);
        assert_eq!(poly.len(), 4);
        assert!(poly.iter().all(|(_, d)| *d >= 0.1));
    }
}
