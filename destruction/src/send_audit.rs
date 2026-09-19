//! Why a body did or did not get a record this send, bucketed by what it was
//! doing at the time.
//!
//! The stream drops bodies at six different points, and a single "we sent 350
//! of 10,000 records" number cannot tell them apart -- yet the fix is a
//! different fix at each one. Worse, one aggregate hides the case that matters
//! most: a chunk that has just lost its support has almost no accumulated
//! error (it has moved a centimetre) and so ranks at the bottom, while the
//! client, having heard nothing, holds it in mid-air. It climbs the ranking
//! only once it has visibly hung there.
//!
//! So this records a cross-tab: the body's PHASE (what it is physically doing)
//! against the OUTCOME (which of the six gates it met), with the bytes each
//! would have cost. That makes the trade-off legible in the only currency that
//! matters for a fixed link -- error avoided per byte -- and it makes it
//! legible per phase, so a change that helps falling debris and hurts landing
//! debris shows up as two numbers instead of one wash.
//!
//! Enabled only by the offline recorder (`enable_send_audit`). In production
//! the encoder holds `None` and every call site is one predictable branch.
//!
//! Honesty note: the deferred-error figures cover bodies this client has been
//! sent at least once, because only then does the encoder know what pose the
//! client is holding. A body never sent has no reference here, and is counted
//! in `never_sent` instead of being given an invented error. The authority for
//! end-to-end error is `destruction-codec state-diff`, which replays the real
//! client against the real trace; this module is the cheap in-encoder proxy
//! that says WHERE the error is created.

use std::collections::HashMap;

use serde::Serialize;

/// Consecutive free-flight ticks below which a fall counts as "just started".
/// 30 ticks is half a second at 60 Hz -- long enough to cover the classifier's
/// hold plus a few missed sends, short enough that a body still on this
/// counter has not yet fallen far enough to look wrong.
pub const FRESH_FALL_TICKS: u16 = 30;

/// Angular speed above which free flight is tumbling rather than dropping.
/// Rotation is the part of a fall a client cannot predict well, so it is worth
/// separating: the two phases have genuinely different streaming needs.
pub const TUMBLE_ANGULAR_RPS: f32 = 0.8;

/// Linear speed above which a body in contact is still arriving, not settling.
pub const LANDING_SPEED_MPS: f32 = 0.5;

/// At or below this a body is not moving, whatever its contact count says.
pub const REST_SPEED_MPS: f32 = 0.05;

/// What a body was physically doing when the scheduler judged it.
///
/// These are the semantic classes a trade-off gets argued in. They are chosen
/// so that each one has a different *predictability* from the client's side,
/// which is what decides how much a record is worth:
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BodyPhase {
    /// Not moving, in contact. The client's pose is already right; a record
    /// buys nothing.
    Resting,
    /// Free flight, newly begun. The client is almost certainly still holding
    /// it where it was -- this is the floating-building case, and the phase
    /// where one record buys the most.
    JustFreed,
    /// Free flight, established. A client that has a ballistic record
    /// extrapolates this well, so further records buy little.
    Falling,
    /// Free flight with real rotation. Extrapolation degrades quickly because
    /// angular motion is not predicted, so records keep their value.
    Tumbling,
    /// In contact and still fast: decelerating on impact. The client is
    /// applying gravity to something that has stopped, so error grows fast.
    Landing,
    /// In contact, slow, coming to rest. Error is small and shrinking.
    Settling,
}

impl BodyPhase {
    pub const ALL: [BodyPhase; 6] = [
        BodyPhase::Resting,
        BodyPhase::JustFreed,
        BodyPhase::Falling,
        BodyPhase::Tumbling,
        BodyPhase::Landing,
        BodyPhase::Settling,
    ];

    pub fn name(self) -> &'static str {
        match self {
            BodyPhase::Resting => "resting",
            BodyPhase::JustFreed => "just-freed",
            BodyPhase::Falling => "falling",
            BodyPhase::Tumbling => "tumbling",
            BodyPhase::Landing => "landing",
            BodyPhase::Settling => "settling",
        }
    }

    /// Classify from what the encoder already knows about the body.
    ///
    /// The awkward case is a body reporting no contacts and no motion. That
    /// looks like free flight to the contact test, but physically it is rubble
    /// resting on something whose contacts did not reach this snapshot -- and
    /// counting it as falling swamped the `falling` row with 75,803 motionless
    /// samples in the first recorded collapse, which is the opposite of what
    /// the row is for. `free_ticks` is the discriminator: a body that genuinely
    /// just broke loose has barely any, so it is still `JustFreed` even at
    /// walking pace, while one that has been still for half a second is at
    /// rest whatever its contact count says.
    pub fn classify(
        contacts: u16,
        linear_speed: f32,
        angular_speed: f32,
        free_ticks: u16,
    ) -> Self {
        if contacts == 0 {
            if angular_speed > TUMBLE_ANGULAR_RPS {
                BodyPhase::Tumbling
            } else if free_ticks <= FRESH_FALL_TICKS {
                BodyPhase::JustFreed
            } else if linear_speed <= REST_SPEED_MPS {
                BodyPhase::Resting
            } else {
                BodyPhase::Falling
            }
        } else if linear_speed > LANDING_SPEED_MPS {
            BodyPhase::Landing
        } else if linear_speed <= REST_SPEED_MPS && angular_speed <= REST_SPEED_MPS {
            BodyPhase::Resting
        } else {
            BodyPhase::Settling
        }
    }
}

/// Which of the send path's gates decided this body's fate.
///
/// Ordered as the encoder evaluates them, so a cross-tab reads as a funnel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SendOutcome {
    /// Never looked at: beyond the per-client evaluation cap.
    EvalCap,
    /// Deferred by the resting-body evaluation stride.
    RestStride,
    /// At rest where the client already has it; nothing to say.
    RestUnchanged,
    /// Outside this client's interest (frustum / distance).
    NotRelevant,
    /// The priority gate judged it not worth sending (includes Quiescent).
    NotNewsworthy,
    /// Ranked, but lost the byte ceiling.
    Ceiling,
    /// Sent.
    Sent,
}

impl SendOutcome {
    pub const ALL: [SendOutcome; 7] = [
        SendOutcome::EvalCap,
        SendOutcome::RestStride,
        SendOutcome::RestUnchanged,
        SendOutcome::NotRelevant,
        SendOutcome::NotNewsworthy,
        SendOutcome::Ceiling,
        SendOutcome::Sent,
    ];

    pub fn name(self) -> &'static str {
        match self {
            SendOutcome::EvalCap => "eval-cap",
            SendOutcome::RestStride => "rest-stride",
            SendOutcome::RestUnchanged => "rest-unchanged",
            SendOutcome::NotRelevant => "not-relevant",
            SendOutcome::NotNewsworthy => "not-newsworthy",
            SendOutcome::Ceiling => "ceiling",
            SendOutcome::Sent => "sent",
        }
    }

    pub fn is_sent(self) -> bool {
        matches!(self, SendOutcome::Sent)
    }
}

/// Totals for one (phase, outcome) cell.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cell {
    /// Body-sends landing in this cell.
    pub count: u64,
    /// Wire bytes: spent, for `Sent`; forgone, for every other outcome.
    pub bytes: u64,
    /// Sum of |truth now - pose the client is holding|, over the sends where
    /// the client had been sent this body before. Metres.
    pub deferred_error_m: f64,
    /// The same error weighted by the body's bounding radius, in m².
    ///
    /// Metres of centroid displacement treat a 10 m slab and a 0.3 m pebble as
    /// equally wrong, and they are not: what a player sees is the AREA of the
    /// mismatch between where a body is drawn and where it is, which scales
    /// with displacement TIMES the body's silhouette. `projected_error_pixels`
    /// has the same blind spot -- its `center` term is pure centroid distance
    /// and radius enters only the rotational silhouette term -- so this column
    /// exists to measure whether size-weighting changes which bodies deserve
    /// the bytes. Kept ALONGSIDE metres rather than replacing it, so the two
    /// rankings can be compared rather than assumed.
    pub deferred_error_m2: f64,
    /// Worst single deferred error in this cell, metres.
    pub deferred_error_max_m: f32,
    /// Worst single size-weighted error in this cell, m².
    pub deferred_error_max_m2: f32,
    /// Sends counted in `deferred_error_m` (the rest had no reference pose).
    pub error_samples: u64,
    /// Sum of ticks since this client last had this body.
    pub age_ticks: u64,
    /// Sends where this client had never been sent this body at all.
    pub never_sent: u64,
}

impl Cell {
    /// Square metres of visible mismatch per wire byte: the size-weighted
    /// counterpart of `error_per_byte`.
    pub fn error_area_per_byte(&self) -> f64 {
        if self.bytes == 0 {
            0.0
        } else {
            self.deferred_error_m2 / self.bytes as f64
        }
    }

    pub fn mean_error_m(&self) -> f64 {
        if self.error_samples == 0 {
            0.0
        } else {
            self.deferred_error_m / self.error_samples as f64
        }
    }

    /// Metres of client-side error per wire byte this cell accounts for.
    ///
    /// For `Sent` cells this is error *avoided* per byte spent; for dropped
    /// cells it is error *accepted* per byte saved. Comparing the two across a
    /// row is the whole argument for or against a scheduling change.
    pub fn error_per_byte(&self) -> f64 {
        if self.bytes == 0 {
            0.0
        } else {
            self.deferred_error_m / self.bytes as f64
        }
    }

    pub fn mean_age_ticks(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            self.age_ticks as f64 / self.count as f64
        }
    }
}

/// How long a body hung before the client was told it had started falling.
///
/// This is the floating-building effect as a number: ticks from the body
/// entering free flight to the first record that reaches this client after
/// that moment. It is measured, not inferred -- both ticks are observed here.
#[derive(Clone, Copy, Debug, Default)]
struct FallLatency {
    /// Tick this body most recently entered free flight, if it still has not
    /// been told about.
    freed_at: Option<u32>,
    /// Set once, when free flight is first reported: keeps the run's first
    /// fall per body rather than re-arming on every bounce.
    resolved: bool,
    /// How many times each gate turned this body away while it was waiting.
    ///
    /// Without this, a long latency says only "it was late". Raising the byte
    /// ceiling fourfold did not move p99 or max at all, so the tail is not a
    /// bandwidth problem -- and the only way to say which gate it IS is to
    /// count them per body while it hangs.
    blocked_by: [u32; 7],
}

/// One body's free-fall notification delay, in ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FallReport {
    pub body_entity: u32,
    pub freed_at_tick: u32,
    pub first_sent_tick: u32,
    /// Times each gate turned this body away while it waited, indexed by
    /// `SendOutcome::ALL`.
    pub blocked_by: [u32; 7],
}

impl FallReport {
    /// The gate that turned this body away most often while it hung.
    pub fn dominant_blocker(&self) -> Option<(SendOutcome, u32)> {
        SendOutcome::ALL
            .iter()
            .enumerate()
            .filter(|(index, _)| self.blocked_by[*index] > 0)
            .max_by_key(|(index, _)| self.blocked_by[*index])
            .map(|(index, outcome)| (*outcome, self.blocked_by[index]))
    }
}

impl FallReport {
    pub fn latency_ticks(&self) -> u32 {
        self.first_sent_tick.saturating_sub(self.freed_at_tick)
    }
}

impl SendOutcome {
    fn index(self) -> usize {
        SendOutcome::ALL
            .iter()
            .position(|candidate| *candidate == self)
            .expect("every outcome is in ALL")
    }
}

/// Cross-tab of send decisions, plus per-body fall-notification latency.
#[derive(Debug, Default)]
pub struct SendAudit {
    cells: HashMap<(BodyPhase, SendOutcome), Cell>,
    fall: HashMap<u32, FallLatency>,
    /// Resolved fall latencies, one per body per run.
    reports: Vec<FallReport>,
    /// Bodies that entered free flight and were never told about at all.
    unresolved_falls: u64,
    sends: u64,
}

impl SendAudit {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one body's outcome for one send.
    #[allow(clippy::too_many_arguments)]
    pub fn note(
        &mut self,
        sim_tick: u32,
        body_entity: u32,
        phase: BodyPhase,
        outcome: SendOutcome,
        cost_bytes: usize,
        deferred_error_m: Option<f32>,
        radius_m: f32,
        age_ticks: Option<u32>,
    ) {
        let cell = self.cells.entry((phase, outcome)).or_default();
        cell.count += 1;
        cell.bytes += cost_bytes as u64;
        match deferred_error_m {
            Some(error) => {
                let area = error * radius_m.max(0.0);
                cell.deferred_error_m += error as f64;
                cell.deferred_error_m2 += area as f64;
                cell.error_samples += 1;
                if error > cell.deferred_error_max_m {
                    cell.deferred_error_max_m = error;
                }
                if area > cell.deferred_error_max_m2 {
                    cell.deferred_error_max_m2 = area;
                }
            }
            None => cell.never_sent += 1,
        }
        if let Some(age) = age_ticks {
            cell.age_ticks += age as u64;
        }

        // Fall-notification latency. Arming happens the first time a body is
        // seen in free flight; it resolves on the first record that follows,
        // whatever gate let it through.
        if phase == BodyPhase::JustFreed {
            let entry = self.fall.entry(body_entity).or_default();
            if !entry.resolved && entry.freed_at.is_none() {
                entry.freed_at = Some(sim_tick);
            }
        }
        if let Some(entry) = self.fall.get_mut(&body_entity) {
            if entry.freed_at.is_some() {
                entry.blocked_by[outcome.index()] += 1;
            }
            if outcome.is_sent() {
                if let Some(freed_at) = entry.freed_at.take() {
                    entry.resolved = true;
                    self.reports.push(FallReport {
                        body_entity,
                        freed_at_tick: freed_at,
                        first_sent_tick: sim_tick,
                        blocked_by: entry.blocked_by,
                    });
                }
            }
        }
    }

    /// Bodies beyond the per-client evaluation cap, which are never visited.
    pub fn note_eval_cap(&mut self, skipped: u64) {
        let cell = self
            .cells
            .entry((BodyPhase::Resting, SendOutcome::EvalCap))
            .or_default();
        cell.count += skipped;
    }

    pub fn note_send(&mut self) {
        self.sends += 1;
    }

    pub fn sends(&self) -> u64 {
        self.sends
    }

    pub fn cell(&self, phase: BodyPhase, outcome: SendOutcome) -> Cell {
        self.cells.get(&(phase, outcome)).copied().unwrap_or_default()
    }

    /// Row total across every outcome for one phase.
    pub fn phase_total(&self, phase: BodyPhase) -> Cell {
        let mut total = Cell::default();
        for outcome in SendOutcome::ALL {
            let cell = self.cell(phase, outcome);
            total.count += cell.count;
            total.bytes += cell.bytes;
            total.deferred_error_m += cell.deferred_error_m;
            total.deferred_error_m2 += cell.deferred_error_m2;
            total.deferred_error_max_m2 = total.deferred_error_max_m2.max(cell.deferred_error_max_m2);
            total.error_samples += cell.error_samples;
            total.age_ticks += cell.age_ticks;
            total.never_sent += cell.never_sent;
            total.deferred_error_max_m = total.deferred_error_max_m.max(cell.deferred_error_max_m);
        }
        total
    }

    /// Resolved fall-notification latencies.
    pub fn fall_reports(&self) -> &[FallReport] {
        &self.reports
    }

    /// Bodies seen in free flight that were never sent a record afterwards.
    ///
    /// Call after the run: anything still armed never resolved.
    pub fn unresolved_falls(&self) -> u64 {
        self.unresolved_falls
            + self
                .fall
                .values()
                .filter(|entry| entry.freed_at.is_some())
                .count() as u64
    }

    /// Latency percentiles in ticks: (p50, p90, p99, max).
    pub fn fall_latency_percentiles(&self) -> (u32, u32, u32, u32) {
        if self.reports.is_empty() {
            return (0, 0, 0, 0);
        }
        let mut latencies: Vec<u32> = self.reports.iter().map(FallReport::latency_ticks).collect();
        latencies.sort_unstable();
        let at = |fraction: f64| -> u32 {
            let index = ((latencies.len() as f64 - 1.0) * fraction).round() as usize;
            latencies[index]
        };
        (at(0.5), at(0.9), at(0.99), *latencies.last().expect("non-empty"))
    }
}

/// One (phase, outcome) cell, flattened for serialization.
#[derive(Clone, Debug, Serialize)]
pub struct ReportCell {
    pub phase: &'static str,
    pub outcome: &'static str,
    pub count: u64,
    pub bytes: u64,
    pub deferred_error_m: f64,
    pub deferred_error_m2: f64,
    pub deferred_error_max_m: f32,
    pub deferred_error_max_m2: f32,
    pub mean_error_m: f64,
    pub error_per_byte: f64,
    pub error_area_per_byte: f64,
    pub mean_age_ticks: f64,
    pub never_sent: u64,
}

/// The whole audit, ready to write beside a recording.
#[derive(Clone, Debug, Serialize)]
pub struct AuditReport {
    pub sends: u64,
    pub cells: Vec<ReportCell>,
    /// Ticks from entering free flight to the first record that followed.
    pub fall_latency_ticks: FallLatencyReport,
    pub unresolved_falls: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct FallLatencyReport {
    pub samples: usize,
    pub p50: u32,
    pub p90: u32,
    pub p99: u32,
    pub max: u32,
    pub mean: f64,
}

impl SendAudit {
    pub fn report(&self) -> AuditReport {
        let (p50, p90, p99, max) = self.fall_latency_percentiles();
        let samples = self.reports.len();
        let mean = if samples == 0 {
            0.0
        } else {
            self.reports
                .iter()
                .map(|report| report.latency_ticks() as f64)
                .sum::<f64>()
                / samples as f64
        };
        let mut cells = Vec::new();
        for phase in BodyPhase::ALL {
            for outcome in SendOutcome::ALL {
                let cell = self.cell(phase, outcome);
                if cell.count == 0 {
                    continue;
                }
                cells.push(ReportCell {
                    phase: phase.name(),
                    outcome: outcome.name(),
                    count: cell.count,
                    bytes: cell.bytes,
                    deferred_error_m: cell.deferred_error_m,
                    deferred_error_m2: cell.deferred_error_m2,
                    deferred_error_max_m: cell.deferred_error_max_m,
                    deferred_error_max_m2: cell.deferred_error_max_m2,
                    mean_error_m: cell.mean_error_m(),
                    error_per_byte: cell.error_per_byte(),
                    error_area_per_byte: cell.error_area_per_byte(),
                    mean_age_ticks: cell.mean_age_ticks(),
                    never_sent: cell.never_sent,
                });
            }
        }
        AuditReport {
            sends: self.sends,
            cells,
            fall_latency_ticks: FallLatencyReport { samples, p50, p90, p99, max, mean },
            unresolved_falls: self.unresolved_falls(),
        }
    }

    /// The cross-tab as text. This is the thing a human argues with.
    pub fn table(&self, hz: f32) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let _ = writeln!(
            out,
            "{:<11} {:>14} {:>9} {:>8} {:>10} {:>9} {:>10} {:>10} {:>7}",
            "phase", "outcome", "count", "KiB", "err m/avg", "err m/pk",
            "mm/B", "mm2/B", "age tk"
        );
        for phase in BodyPhase::ALL {
            let total = self.phase_total(phase);
            if total.count == 0 {
                continue;
            }
            for outcome in SendOutcome::ALL {
                let cell = self.cell(phase, outcome);
                if cell.count == 0 {
                    continue;
                }
                let _ = writeln!(
                    out,
                    "{:<11} {:>14} {:>9} {:>8.0} {:>10.3} {:>9.2} {:>10.3} {:>10.3} {:>7.1}",
                    phase.name(),
                    outcome.name(),
                    cell.count,
                    cell.bytes as f64 / 1024.0,
                    cell.mean_error_m(),
                    cell.deferred_error_max_m,
                    cell.error_per_byte() * 1000.0,
                    cell.error_area_per_byte() * 1000.0,
                    cell.mean_age_ticks(),
                );
            }
            let share = if total.count == 0 {
                0.0
            } else {
                self.cell(phase, SendOutcome::Sent).count as f64 * 100.0 / total.count as f64
            };
            let _ = writeln!(
                out,
                "{:<11} {:>14} {:>9} {:>8.0} {:>10} {:>9} {:>10} {:>10} {:>6.1}%",
                "", "TOTAL", total.count, total.bytes as f64 / 1024.0, "", "", "", "sent", share
            );
        }
        let (p50, p90, p99, max) = self.fall_latency_percentiles();
        let ms = |ticks: u32| ticks as f32 * 1000.0 / hz;
        let _ = writeln!(
            out,
            "\nfall -> first record  n={}  p50 {} tk ({:.0} ms)  p90 {} tk ({:.0} ms)  \
             p99 {} tk ({:.0} ms)  max {} tk ({:.0} ms)",
            self.reports.len(),
            p50, ms(p50), p90, ms(p90), p99, ms(p99), max, ms(max)
        );
        let _ = writeln!(
            out,
            "fell and was never sent: {} bodies",
            self.unresolved_falls()
        );

        // Which gate actually holds the tail. The p50 is zero ticks, so the
        // artifact is entirely in the stragglers, and the average body's
        // experience says nothing about why they wait.
        let mut worst: Vec<&FallReport> = self.reports.iter().collect();
        worst.sort_unstable_by_key(|report| std::cmp::Reverse(report.latency_ticks()));
        let tail = worst.len().min(worst.len().div_ceil(100).max(1) * 1).max(1);
        let slowest = &worst[..worst.len().min(tail.max(20))];
        if !slowest.is_empty() {
            let mut blockers: HashMap<&'static str, u64> = HashMap::new();
            for report in slowest {
                if let Some((outcome, times)) = report.dominant_blocker() {
                    *blockers.entry(outcome.name()).or_default() += times as u64;
                }
            }
            let mut ranked: Vec<(&'static str, u64)> = blockers.into_iter().collect();
            ranked.sort_unstable_by_key(|(_, times)| std::cmp::Reverse(*times));
            let _ = write!(
                out,
                "slowest {} falls waited on:",
                slowest.len()
            );
            for (name, times) in ranked {
                let _ = write!(out, " {name}={times}");
            }
            let _ = writeln!(out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_flight_splits_by_age_and_spin() {
        assert_eq!(BodyPhase::classify(0, 0.2, 0.0, 1), BodyPhase::JustFreed);
        assert_eq!(BodyPhase::classify(0, 9.0, 0.0, 200), BodyPhase::Falling);
        // Not touching anything and not moving is rubble at rest whose support
        // contacts did not reach the snapshot -- not a fall.
        assert_eq!(BodyPhase::classify(0, 0.01, 0.0, 200), BodyPhase::Resting);
        assert_eq!(BodyPhase::classify(0, 9.0, 3.0, 200), BodyPhase::Tumbling);
        // Spin wins over freshness: a chunk that starts tumbling immediately
        // is not predictable just because it only just broke loose.
        assert_eq!(BodyPhase::classify(0, 0.2, 3.0, 1), BodyPhase::Tumbling);
    }

    #[test]
    fn contact_splits_by_speed() {
        assert_eq!(BodyPhase::classify(3, 6.0, 0.0, 0), BodyPhase::Landing);
        assert_eq!(BodyPhase::classify(3, 0.2, 0.2, 0), BodyPhase::Settling);
        assert_eq!(BodyPhase::classify(3, 0.0, 0.0, 0), BodyPhase::Resting);
    }

    /// The headline measurement: ticks from breaking loose to being told.
    #[test]
    fn fall_latency_measures_the_gap_to_the_first_record() {
        let mut audit = SendAudit::new();
        // Freed at tick 100, dropped by the ceiling for 18 ticks, then sent.
        audit.note(100, 7, BodyPhase::JustFreed, SendOutcome::Ceiling, 12, None, 1.0, None);
        for tick in [104, 108, 112, 116] {
            audit.note(tick, 7, BodyPhase::JustFreed, SendOutcome::Ceiling, 12, None, 1.0, None);
        }
        audit.note(118, 7, BodyPhase::JustFreed, SendOutcome::Sent, 30, Some(2.1), 1.0, Some(18));
        let reports = audit.fall_reports();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].latency_ticks(), 18);
        // And it says WHY it waited, which is the part that picks the fix.
        assert_eq!(
            reports[0].dominant_blocker(),
            Some((SendOutcome::Ceiling, 5)),
            "five ceiling losses then a send"
        );
        assert_eq!(audit.unresolved_falls(), 0);
    }

    /// A body that falls and is never mentioned is the artifact itself, so it
    /// must be counted rather than silently absent from the histogram.
    #[test]
    fn a_fall_that_is_never_sent_is_counted_not_dropped() {
        let mut audit = SendAudit::new();
        audit.note(10, 3, BodyPhase::JustFreed, SendOutcome::NotNewsworthy, 12, None, 1.0, None);
        assert!(audit.fall_reports().is_empty());
        assert_eq!(audit.unresolved_falls(), 1);
    }

    /// Only the first fall per body is reported; a bounce is not a new fall.
    #[test]
    fn a_body_reports_its_first_fall_only() {
        let mut audit = SendAudit::new();
        audit.note(10, 3, BodyPhase::JustFreed, SendOutcome::Ceiling, 12, None, 1.0, None);
        audit.note(20, 3, BodyPhase::JustFreed, SendOutcome::Sent, 30, Some(1.0), 1.0, Some(10));
        audit.note(90, 3, BodyPhase::JustFreed, SendOutcome::Ceiling, 12, None, 1.0, None);
        audit.note(99, 3, BodyPhase::JustFreed, SendOutcome::Sent, 30, Some(1.0), 1.0, Some(9));
        assert_eq!(audit.fall_reports().len(), 1);
        assert_eq!(audit.fall_reports()[0].latency_ticks(), 10);
    }

    #[test]
    fn error_per_byte_is_the_ranking_currency() {
        let mut audit = SendAudit::new();
        // One expensive record that avoided a lot of error...
        audit.note(1, 1, BodyPhase::JustFreed, SendOutcome::Sent, 30, Some(3.0), 1.0, Some(30));
        // ...and one that avoided almost none.
        audit.note(1, 2, BodyPhase::Settling, SendOutcome::Sent, 30, Some(0.03), 1.0, Some(30));
        let freed = audit.cell(BodyPhase::JustFreed, SendOutcome::Sent);
        let settling = audit.cell(BodyPhase::Settling, SendOutcome::Sent);
        assert!(freed.error_per_byte() > settling.error_per_byte() * 50.0);
    }

    #[test]
    fn percentiles_survive_a_single_sample() {
        let mut audit = SendAudit::new();
        audit.note(0, 1, BodyPhase::JustFreed, SendOutcome::Ceiling, 12, None, 1.0, None);
        audit.note(9, 1, BodyPhase::JustFreed, SendOutcome::Sent, 30, Some(0.5), 1.0, Some(9));
        assert_eq!(audit.fall_latency_percentiles(), (9, 9, 9, 9));
    }

    /// The whole point of the second currency: it must be able to disagree
    /// with the first, or measuring it proves nothing.
    ///
    /// A 6 m slab 0.4 m out of place is a wall visibly in the wrong position;
    /// a 0.2 m shard 1.2 m out of place is a pebble nobody can track. Metres
    /// of centroid displacement rank the pebble three times higher; area of
    /// visible mismatch ranks the slab higher, which is what a player sees.
    #[test]
    fn size_weighting_can_reverse_the_ranking() {
        let mut audit = SendAudit::new();
        audit.note(1, 1, BodyPhase::Falling, SendOutcome::Sent, 30, Some(0.4), 6.0, Some(4));
        audit.note(1, 2, BodyPhase::Tumbling, SendOutcome::Sent, 30, Some(1.2), 0.2, Some(4));
        let slab = audit.cell(BodyPhase::Falling, SendOutcome::Sent);
        let shard = audit.cell(BodyPhase::Tumbling, SendOutcome::Sent);

        assert!(
            shard.error_per_byte() > slab.error_per_byte(),
            "in metres the shard looks worse: {} vs {}",
            shard.error_per_byte(),
            slab.error_per_byte()
        );
        assert!(
            slab.error_area_per_byte() > shard.error_area_per_byte(),
            "in visible area the slab is worse: {} vs {}",
            slab.error_area_per_byte(),
            shard.error_area_per_byte()
        );
    }
}
