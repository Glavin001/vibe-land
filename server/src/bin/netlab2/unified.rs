//! The unified "all draws" metric: every rigid body the client draws, per
//! frame, against frozen truth -- players, vehicles, dynamic bodies, meteors
//! and every city chunk -- in one set of numbers per class and overall.
//!
//! Weighting: one draw of one thing in one frame weighs 1. A chunk is one
//! thing (a 24k-chunk city contributes 24k draws a frame; a cannonball 1).
//! The overall figures are therefore chunk-dominated whenever the city is on
//! screen; the per-class rows are the ones to read for bodies, vehicles and
//! players.
//!
//! Per class:
//!
//! - position and rotation error at the client's render time (interpolation
//!   and extrapolation fidelity) and against truth "now" (the tick the server
//!   had completed at that frame's wall time: what a viewer comparing screens
//!   sees), p50/p95/p99/max and mean;
//! - draw-frames **missing** (in truth and in the recipient's interest at the
//!   render time, not drawn), **extra** (drawn, not in truth then: retired,
//!   stale or never existed) and **wrong identity** (drawn as the wrong
//!   shape, vehicle type or, for a chunk, on a body truth never had it on in
//!   the window between render time and now).
//!
//! Percentiles come from a log histogram (30 bins per decade, ~8% relative
//! resolution; `vibe_land_destruction::netlab::score::WeightedHist`); max and
//! mean are exact.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use vibe_land_destruction::netlab::score::WeightedHist;

/// Classes the lab cannot draw as the live client does (local prediction:
/// the own avatar, the vehicle this client drives). Scored and reported, but
/// left out of `overall` so it only holds what the lab reproduces.
pub const APPROXIMATE_CLASSES: [&str; 2] = ["own_avatar", "vehicle_driven"];

pub const WEIGHTING: &str = "one draw of one thing in one frame = 1 (each city chunk counts, each body counts); \
     overall excludes own_avatar and vehicle_driven (local prediction, not reproduced)";

/// Weighted percentiles of one error, in the unit its field names.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Quantiles {
    /// Draw-frames measured (the weight).
    pub n: f64,
    pub mean: f64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

impl Quantiles {
    fn of(hist: &WeightedHist) -> Self {
        let s = hist.summary();
        Self {
            n: f64::from(s.weight),
            mean: f64::from(s.mean),
            p50: f64::from(s.p50),
            p95: f64::from(s.p95),
            p99: f64::from(s.p99),
            max: f64::from(s.max),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DrawCell {
    /// Draw-frames with a truth to compare against.
    pub scored: f64,
    pub pos_render_m: Quantiles,
    pub rot_render_deg: Quantiles,
    pub pos_now_m: Quantiles,
    pub rot_now_deg: Quantiles,
    /// In truth and interest at the render time, not drawn.
    pub missing: f64,
    /// Drawn, not in truth at the render time.
    pub extra: f64,
    /// Drawn as the wrong shape / vehicle type / on the wrong body.
    pub wrong_identity: f64,
    /// Share of draw-frames (scored + extra) or would-be draws (+ missing)
    /// that are wrong in kind rather than in pose.
    pub missing_share: f64,
    pub extra_share: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AllDraws {
    pub weighting: String,
    pub excluded_from_overall: Vec<String>,
    pub frames: u64,
    pub overall: DrawCell,
    pub classes: BTreeMap<String, DrawCell>,
    /// The city client's ledger-sync counters beside the draws they explain
    /// (score.rs `CitySync`): a repair re-bootstraps a structure, which is
    /// where chunks the server retired come back drawn on the intact body
    /// (chunk_intact `extra`).
    pub city_sync: Option<crate::score::CitySync>,
    /// When a moving body is first drawn, per class (`body`, `meteor`,
    /// `island`: a city island body, drawn once any chunk is drawn on it).
    pub first_draw: BTreeMap<String, FirstDrawCell>,
    /// Anything the scorer could not do (e.g. no chunk stream: a client tree
    /// without cityPoseStore.ts, or a run from before it).
    pub notes: Vec<String>,
}

/// First-draw coverage of one class: for every body that moves in truth
/// (faster than 0.5 m/s, inside the recipient's interest for dynamic
/// bodies; city islands have no interest limit), how long after the server
/// completed its first moving tick the client first drew it, and the bodies
/// it never drew at all.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FirstDrawCell {
    /// Bodies that moved in truth.
    pub moving_bodies: u64,
    /// Of those, drawn at some point after they started moving: wall ms from
    /// the server completing the first moving tick to the first frame that
    /// drew it (0 when it was already drawn before it moved).
    pub delay_ms: crate::report::Pct,
    pub drawn_before_moving: u64,
    /// Moved in truth and never drawn at all, and their moving body-frames
    /// (frames in which truth had them moving at the render time).
    pub never_drawn: u64,
    pub never_drawn_moving_frames: u64,
}

/// Accumulates first-draw coverage for one class.
#[derive(Default)]
pub struct FirstDrawAcc {
    /// id -> wall ms (tape clock) the server completed its first moving tick.
    pub first_moving_ms: std::collections::HashMap<u32, f64>,
    /// id -> wall ms of the first frame that drew it.
    pub first_drawn_ms: std::collections::HashMap<u32, f64>,
    /// id -> frames it moved in truth (at the render time).
    pub moving_frames: std::collections::HashMap<u32, u64>,
}

impl FirstDrawAcc {
    pub fn moved(&mut self, id: u32, first_moving_ms: f64) {
        let entry = self.first_moving_ms.entry(id).or_insert(first_moving_ms);
        *entry = entry.min(first_moving_ms);
    }

    pub fn drawn(&mut self, id: u32, at_ms: f64) {
        self.first_drawn_ms.entry(id).or_insert(at_ms);
    }

    pub fn moving_frame(&mut self, id: u32) {
        *self.moving_frames.entry(id).or_default() += 1;
    }

    pub fn cell(&self) -> FirstDrawCell {
        let mut cell = FirstDrawCell { moving_bodies: self.first_moving_ms.len() as u64, ..Default::default() };
        let mut delays = Vec::new();
        for (id, moving_ms) in &self.first_moving_ms {
            match self.first_drawn_ms.get(id) {
                Some(drawn_ms) => {
                    if drawn_ms < moving_ms {
                        cell.drawn_before_moving += 1;
                    }
                    delays.push((drawn_ms - moving_ms).max(0.0) as f32);
                }
                None => {
                    cell.never_drawn += 1;
                    cell.never_drawn_moving_frames += self.moving_frames.get(id).copied().unwrap_or(0);
                }
            }
        }
        cell.delay_ms = crate::report::Pct::of(delays);
        cell
    }
}

/// Frames within `seconds` of the client joining (its first frame) or of a
/// full city bootstrap, on the page clock: reported as a second all-draws
/// set so join behaviour is visible on its own.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct JoinWindows {
    pub seconds: f64,
    /// Window starts, page-clock ms: the first frame, then every full city
    /// bootstrap that arrived.
    pub starts_ms: Vec<f64>,
}

impl JoinWindows {
    pub fn contains(&self, page_ms: f64) -> bool {
        self.starts_ms.iter().any(|start| page_ms >= *start && page_ms < start + self.seconds * 1000.0)
    }
}

/// Where a draw is recorded: the whole run, and the join window when the
/// frame falls in one.
pub struct Sinks<'a> {
    pub all: &'a mut AllDrawsAcc,
    pub join: Option<&'a mut AllDrawsAcc>,
    pub in_join: bool,
}

impl Sinks<'_> {
    fn each(&mut self, mut f: impl FnMut(&mut AllDrawsAcc)) {
        f(self.all);
        if self.in_join {
            if let Some(join) = self.join.as_deref_mut() {
                f(join);
            }
        }
    }

    pub fn frame(&mut self) {
        self.each(|acc| acc.frames += 1);
    }

    pub fn draw(&mut self, class: &'static str, errors: DrawErrors, weight: f32) {
        self.each(|acc| acc.draw(class, errors, weight));
    }

    pub fn missing(&mut self, class: &'static str, weight: f32) {
        self.each(|acc| acc.missing(class, weight));
    }

    pub fn extra(&mut self, class: &'static str, weight: f32) {
        self.each(|acc| acc.extra(class, weight));
    }

    pub fn wrong_identity(&mut self, class: &'static str, weight: f32) {
        self.each(|acc| acc.wrong_identity(class, weight));
    }
}

#[derive(Default)]
struct Acc {
    scored: f64,
    pos_render: WeightedHist,
    rot_render: WeightedHist,
    pos_now: WeightedHist,
    rot_now: WeightedHist,
    missing: f64,
    extra: f64,
    wrong_identity: f64,
}

impl Acc {
    fn cell(&self) -> DrawCell {
        let seen = self.scored + self.extra;
        DrawCell {
            scored: self.scored,
            pos_render_m: Quantiles::of(&self.pos_render),
            rot_render_deg: Quantiles::of(&self.rot_render),
            pos_now_m: Quantiles::of(&self.pos_now),
            rot_now_deg: Quantiles::of(&self.rot_now),
            missing: self.missing,
            extra: self.extra,
            wrong_identity: self.wrong_identity,
            missing_share: self.missing / (self.scored + self.missing).max(1e-9),
            extra_share: self.extra / seen.max(1e-9),
        }
    }
}

/// One draw's errors; `None` where there is no truth to compare (or, for a
/// rotation, where the drawn orientation is cosmetic: a meteor's arc spin).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DrawErrors {
    pub pos_render: Option<f32>,
    pub rot_render: Option<f32>,
    pub pos_now: Option<f32>,
    pub rot_now: Option<f32>,
}

#[derive(Default)]
pub struct AllDrawsAcc {
    classes: BTreeMap<&'static str, Acc>,
    overall: Acc,
    pub frames: u64,
    pub notes: Vec<String>,
    pub city_sync: Option<crate::score::CitySync>,
    pub first_draw: BTreeMap<&'static str, FirstDrawAcc>,
}

impl AllDrawsAcc {
    fn cells(&mut self, class: &'static str) -> (&mut Acc, Option<&mut Acc>) {
        let in_overall = !APPROXIMATE_CLASSES.contains(&class);
        let acc = self.classes.entry(class).or_default();
        (acc, in_overall.then_some(&mut self.overall))
    }

    /// A drawn thing with a truth, `weight` frames of it.
    pub fn draw(&mut self, class: &'static str, errors: DrawErrors, weight: f32) {
        let (acc, overall) = self.cells(class);
        let add = |acc: &mut Acc| {
            acc.scored += f64::from(weight);
            if let Some(v) = errors.pos_render {
                acc.pos_render.add(v, weight);
            }
            if let Some(v) = errors.rot_render {
                acc.rot_render.add(v, weight);
            }
            if let Some(v) = errors.pos_now {
                acc.pos_now.add(v, weight);
            }
            if let Some(v) = errors.rot_now {
                acc.rot_now.add(v, weight);
            }
        };
        add(acc);
        if let Some(overall) = overall {
            add(overall);
        }
    }

    pub fn missing(&mut self, class: &'static str, weight: f32) {
        let (acc, overall) = self.cells(class);
        acc.missing += f64::from(weight);
        if let Some(overall) = overall {
            overall.missing += f64::from(weight);
        }
    }

    pub fn extra(&mut self, class: &'static str, weight: f32) {
        let (acc, overall) = self.cells(class);
        acc.extra += f64::from(weight);
        if let Some(overall) = overall {
            overall.extra += f64::from(weight);
        }
    }

    pub fn wrong_identity(&mut self, class: &'static str, weight: f32) {
        let (acc, overall) = self.cells(class);
        acc.wrong_identity += f64::from(weight);
        if let Some(overall) = overall {
            overall.wrong_identity += f64::from(weight);
        }
    }

    pub fn report(&self) -> AllDraws {
        AllDraws {
            weighting: WEIGHTING.into(),
            excluded_from_overall: APPROXIMATE_CLASSES.iter().map(|c| c.to_string()).collect(),
            frames: self.frames,
            overall: self.overall.cell(),
            classes: self.classes.iter().map(|(k, v)| (k.to_string(), v.cell())).collect(),
            city_sync: self.city_sync.clone(),
            first_draw: self.first_draw.iter().map(|(k, v)| (k.to_string(), v.cell())).collect(),
            notes: self.notes.clone(),
        }
    }
}

/// Smallest angle between two headings, degrees.
pub fn yaw_diff_deg(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % std::f32::consts::TAU;
    if d > std::f32::consts::PI {
        d -= std::f32::consts::TAU;
    } else if d < -std::f32::consts::PI {
        d += std::f32::consts::TAU;
    }
    d.abs().to_degrees()
}

/// Markdown for the top of report.md.
pub fn markdown(all: &AllDraws) -> String {
    markdown_titled(all, "All rigid-body draws vs frozen truth (headline)")
}

pub fn markdown_titled(all: &AllDraws, title: &str) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(s, "## {title}\n");
    let _ = writeln!(
        s,
        "Weighting: {}. Frames: {}.\n",
        all.weighting, all.frames
    );
    let _ = writeln!(s, "| class | scored draw-frames | pos@render p50 / p95 / p99 / max m | rot@render p50 / p95 / p99 / max ° | pos@now p50 / p95 / p99 / max m | rot@now p50 / p99 ° | missing | extra | wrong identity |");
    let _ = writeln!(s, "|---|---:|---|---|---|---|---:|---:|---:|");
    let q = |v: &Quantiles, d: usize| {
        if v.n <= 0.0 {
            "-".to_string()
        } else {
            format!("{:.d$} / {:.d$} / {:.d$} / {:.d$}", v.p50, v.p95, v.p99, v.max, d = d)
        }
    };
    let q2 = |v: &Quantiles| if v.n <= 0.0 { "-".to_string() } else { format!("{:.2} / {:.2}", v.p50, v.p99) };
    let mut row = |name: &str, c: &DrawCell| {
        let _ = writeln!(
            s,
            "| {} | {:.0} | {} | {} | {} | {} | {:.0} ({:.2}%) | {:.0} ({:.2}%) | {:.0} |",
            name,
            c.scored,
            q(&c.pos_render_m, 3),
            q(&c.rot_render_deg, 2),
            q(&c.pos_now_m, 3),
            q2(&c.rot_now_deg),
            c.missing,
            c.missing_share * 100.0,
            c.extra,
            c.extra_share * 100.0,
            c.wrong_identity
        );
    };
    row("**overall**", &all.overall);
    for (name, cell) in &all.classes {
        let label = if APPROXIMATE_CLASSES.contains(&name.as_str()) {
            format!("{name} (approximate, not in overall)")
        } else {
            name.clone()
        };
        row(&label, cell);
    }
    if !all.first_draw.is_empty() {
        let _ = writeln!(s, "\nFirst draw of a moving body (from the server completing its first moving tick):\n");
        let _ = writeln!(s, "| class | moving bodies | delay p50 / p90 / p99 / max ms | drawn before moving | never drawn (moving body-frames) |");
        let _ = writeln!(s, "|---|---:|---|---:|---:|");
        for (class, c) in &all.first_draw {
            let _ = writeln!(
                s,
                "| {class} | {} | {:.0} / {:.0} / {:.0} / {:.0} | {} | {} ({}) |",
                c.moving_bodies, c.delay_ms.p50, c.delay_ms.p90, c.delay_ms.p99, c.delay_ms.max,
                c.drawn_before_moving, c.never_drawn, c.never_drawn_moving_frames
            );
        }
    }
    if let Some(sync) = &all.city_sync {
        let _ = writeln!(
            s,
            "\nCity ledger sync: repairs asked {}, structure repairs applied {}, hash checks {} / mismatches {}, settle rejects {}, topology gaps {}.",
            sync.repairs_asked, sync.structure_repairs_applied, sync.hash_checks, sync.hash_mismatches,
            sync.settle_rejects, sync.topo_seq_gaps
        );
    }
    for note in &all.notes {
        let _ = writeln!(s, "\n- note: {note}");
    }
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_weights_every_draw_once_and_leaves_out_prediction_classes() {
        let mut acc = AllDrawsAcc::default();
        // 1000 intact chunk-frames at 0 error, 10 body-frames at 1 m.
        acc.draw("chunk_intact", DrawErrors { pos_render: Some(0.0), rot_render: Some(0.0), pos_now: Some(0.0), rot_now: Some(0.0) }, 1000.0);
        for _ in 0..10 {
            acc.draw("body", DrawErrors { pos_render: Some(1.0), rot_render: Some(10.0), pos_now: Some(2.0), rot_now: None }, 1.0);
        }
        acc.draw("own_avatar", DrawErrors { pos_render: Some(50.0), ..Default::default() }, 1.0);
        acc.missing("body", 5.0);
        acc.extra("chunk_debris", 2.0);
        acc.wrong_identity("chunk_debris", 1.0);
        let r = acc.report();
        assert_eq!(r.overall.scored, 1010.0);
        assert!(r.overall.pos_render_m.p50 < 1e-4);
        assert!((r.overall.pos_render_m.max - 1.0).abs() < 1e-6, "own_avatar's 50 m is not in overall");
        assert!((r.classes["body"].pos_render_m.p50 - 1.0).abs() < 0.05);
        assert!((r.classes["body"].pos_now_m.p99 - 2.0).abs() < 0.1);
        assert_eq!(r.overall.missing, 5.0);
        assert_eq!(r.overall.extra, 2.0);
        assert_eq!(r.overall.wrong_identity, 1.0);
        assert!((r.classes["body"].missing_share - 5.0 / 15.0).abs() < 1e-9);
        assert_eq!(r.classes["own_avatar"].scored, 1.0);
        // p99 over 1010 draws: 10 at 1 m is ~1%, so p99 sits at the boundary
        // and p95 is 0.
        assert!(r.overall.pos_render_m.p95 < 1e-4);
    }

    #[test]
    fn yaw_difference_wraps() {
        assert!((yaw_diff_deg(0.1, -0.1) - 11.459).abs() < 0.01);
        assert!((yaw_diff_deg(3.1, -3.1) - 4.766).abs() < 0.01);
    }
}
