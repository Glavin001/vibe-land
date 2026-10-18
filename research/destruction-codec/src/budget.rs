//! Budgeted selection: spend a fixed per-block byte allowance on the repairs
//! that matter most, and defer the rest.
//!
//! Precision masking is at its measured perceptual ceiling, but the peak is not
//! a precision problem -- peak blocks carry roughly 2.5x the motion-model breaks
//! of quiet ones, so the peak *is* concentrated surprise. Coarsening everything
//! uniformly cannot fix that; choosing what to send can.
//!
//! This is purely an encoder-side decision. A residual is a per-tick correction
//! that never feeds prediction state: `reconstruct_actor` predicts from segments
//! and carried locals alone, so a body whose repair is withheld simply stays on
//! its predicted trajectory, and the receiver needs no knowledge that a choice
//! was made. No wire change, no determinism requirement, no decoder changes.
//!
//! What must not be deferred is the small set of cases where withholding a
//! repair creates one of the artifacts observers reliably detect rather than the
//! positional error they tolerate. Those are marked required and charged before
//! anything else competes for the budget.

use serde::Serialize;

/// Per-body deferral history, carried across blocks. Encoder-side only.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeferralEntry {
    /// Largest shell error left uncorrected in previous blocks.
    pub deferred_error_m: f32,
    /// Ticks since this body last had a repair emitted while it wanted one.
    pub age_ticks: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct BudgetConfig {
    pub enabled: bool,
    /// Target wire rate; converted to a per-block byte allowance.
    pub target_mbps: f64,
    /// Hard cap on shell error, as a multiple of a body's soft bound. Bounded
    /// so a deferred correction stays inside what the receiver's damped
    /// correction path absorbs without a visible lurch.
    pub hard_cap_factor: f32,
    /// A body wanting a repair is never starved longer than this -- the
    /// heartbeat that standardized dead-reckoning schemes have used since DIS.
    pub max_deferral_ticks: u32,
    /// Safety margin when converting the compressed target into a raw-byte
    /// ceiling, since selection works on raw bytes and the budget is on
    /// compressed ones.
    pub zstd_ratio_margin: f32,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            target_mbps: 15.0,
            hard_cap_factor: 4.0,
            max_deferral_ticks: 30,
            zstd_ratio_margin: 1.15,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BudgetTelemetry {
    pub blocks: u64,
    pub blocks_over_budget: u64,
    pub candidates: u64,
    pub emitted: u64,
    pub deferred: u64,
    pub required: u64,
    pub deferred_error_samples: Vec<f32>,
    pub deferral_age_samples: Vec<u32>,
    pub hard_cap_violations: u64,
}

impl BudgetTelemetry {
    pub fn deferred_pct(&self) -> f64 {
        if self.candidates == 0 {
            0.0
        } else {
            100.0 * self.deferred as f64 / self.candidates as f64
        }
    }

    pub fn quantile_error(&self, q: f64) -> f64 {
        quantile_f32(&self.deferred_error_samples, q)
    }

    pub fn quantile_age(&self, q: f64) -> f64 {
        let values: Vec<f32> = self.deferral_age_samples.iter().map(|&v| v as f32).collect();
        quantile_f32(&values, q)
    }
}

fn quantile_f32(values: &[f32], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f32::total_cmp);
    let rank = ((sorted.len() as f64 * q).ceil() as usize).clamp(1, sorted.len());
    sorted[rank - 1] as f64
}

/// Encoder-side budget state carried across blocks.
#[derive(Clone, Debug, Default)]
pub struct BudgetState {
    /// Signed leaky bucket: a keyframe block that overdraws is repaid by the
    /// delta blocks after it, rather than clamping every block independently.
    carryover_bytes: i64,
    zstd_ratio: f32,
    ledger: Vec<DeferralEntry>,
}

impl BudgetState {
    pub fn entry(&mut self, actor: usize) -> DeferralEntry {
        if self.ledger.len() <= actor {
            self.ledger.resize(actor + 1, DeferralEntry::default());
        }
        self.ledger[actor]
    }

    pub fn note_emitted(&mut self, actor: usize) {
        if self.ledger.len() <= actor {
            self.ledger.resize(actor + 1, DeferralEntry::default());
        }
        self.ledger[actor] = DeferralEntry::default();
    }

    pub fn note_deferred(&mut self, actor: usize, shell_m: f32, ticks: u32) {
        if self.ledger.len() <= actor {
            self.ledger.resize(actor + 1, DeferralEntry::default());
        }
        let entry = &mut self.ledger[actor];
        entry.deferred_error_m = entry.deferred_error_m.max(shell_m);
        entry.age_ticks = entry.age_ticks.saturating_add(ticks);
    }

    /// Raw-byte ceiling for this block's residuals, after reserving what the
    /// mandatory streams already consumed.
    pub fn residual_ceiling_bytes(
        &self,
        config: &BudgetConfig,
        block_seconds: f64,
        reserved_raw_bytes: u64,
    ) -> u64 {
        let target = config.target_mbps * 1e6 / 8.0 * block_seconds;
        let allowance = (target + self.carryover_bytes as f64).max(0.0);
        let ratio = if self.zstd_ratio > 0.0 {
            self.zstd_ratio
        } else {
            0.6
        } as f64;
        // Selection works in raw bytes; the budget is compressed. Convert with
        // the observed ratio plus a margin, because the blocks that overshoot
        // are the busy ones, which also compress worst.
        let raw_allowance = allowance / (ratio * config.zstd_ratio_margin as f64);
        (raw_allowance - reserved_raw_bytes as f64).max(0.0) as u64
    }

    /// Feeds back what the block actually cost so later blocks self-correct.
    pub fn observe_block(
        &mut self,
        config: &BudgetConfig,
        block_seconds: f64,
        raw_bytes: u64,
        compressed_bytes: u64,
    ) {
        if raw_bytes > 0 {
            let ratio = compressed_bytes as f32 / raw_bytes as f32;
            self.zstd_ratio = if self.zstd_ratio > 0.0 {
                0.7 * self.zstd_ratio + 0.3 * ratio
            } else {
                ratio
            };
        }
        let target = config.target_mbps * 1e6 / 8.0 * block_seconds;
        self.carryover_bytes += target as i64 - compressed_bytes as i64;
        // Clamp to one block of allowance either way: a long quiet stretch must
        // not bank enough credit to blow the peak it was meant to control.
        let clamp = target as i64;
        self.carryover_bytes = self.carryover_bytes.clamp(-clamp, clamp);
    }
}

/// Selection input for one candidate repair.
#[derive(Clone, Copy, Debug)]
pub struct CandidateCost {
    pub index: usize,
    pub cost_bytes: usize,
    pub priority: f32,
    pub required: bool,
}

/// Picks candidates under a raw-byte ceiling: required first, then by
/// descending priority, ties broken by index so the result is deterministic.
/// Returns the selected indices in ascending index order, i.e. emission order.
pub fn select(candidates: &[CandidateCost], ceiling_bytes: u64) -> Vec<usize> {
    let mut order: Vec<&CandidateCost> = candidates.iter().collect();
    order.sort_by(|a, b| {
        b.required
            .cmp(&a.required)
            .then_with(|| b.priority.total_cmp(&a.priority))
            .then_with(|| a.index.cmp(&b.index))
    });
    let mut used = 0_u64;
    let mut selected = Vec::with_capacity(order.len());
    for candidate in order {
        // Required repairs are charged even if they exceed the ceiling: the
        // alternative is a visible artifact, and the budget is a target for
        // discretionary traffic, not a licence to break the fidelity contract.
        if candidate.required || used + candidate.cost_bytes as u64 <= ceiling_bytes {
            used += candidate.cost_bytes as u64;
            selected.push(candidate.index);
        }
    }
    selected.sort_unstable();
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(index: usize, cost: usize, priority: f32, required: bool) -> CandidateCost {
        CandidateCost {
            index,
            cost_bytes: cost,
            priority,
            required,
        }
    }

    #[test]
    fn keeps_the_highest_priority_within_budget() {
        let candidates = [
            candidate(0, 10, 1.0, false),
            candidate(1, 10, 9.0, false),
            candidate(2, 10, 5.0, false),
        ];
        assert_eq!(select(&candidates, 20), vec![1, 2]);
    }

    #[test]
    fn required_candidates_survive_a_zero_budget() {
        let candidates = [
            candidate(0, 10, 0.1, true),
            candidate(1, 10, 9.0, false),
            candidate(2, 10, 5.0, true),
        ];
        assert_eq!(select(&candidates, 0), vec![0, 2]);
    }

    #[test]
    fn selection_is_deterministic_under_ties() {
        let candidates: Vec<_> = (0..50).map(|i| candidate(i, 4, 1.0, false)).collect();
        let first = select(&candidates, 40);
        let second = select(&candidates, 40);
        assert_eq!(first, second);
        assert_eq!(first.len(), 10);
        // Ties break on index, so the earliest candidates win.
        assert_eq!(first, (0..10).collect::<Vec<_>>());
    }

    #[test]
    fn an_unlimited_budget_keeps_everything() {
        let candidates: Vec<_> = (0..20).map(|i| candidate(i, 7, i as f32, false)).collect();
        assert_eq!(select(&candidates, u64::MAX).len(), 20);
    }

    #[test]
    fn the_ledger_accumulates_deferrals_and_resets_on_emit() {
        let mut state = BudgetState::default();
        state.note_deferred(3, 0.01, 12);
        state.note_deferred(3, 0.03, 12);
        let entry = state.entry(3);
        assert_eq!(entry.age_ticks, 24);
        assert!((entry.deferred_error_m - 0.03).abs() < 1e-9);
        state.note_emitted(3);
        assert_eq!(state.entry(3).age_ticks, 0);
        assert_eq!(state.entry(3).deferred_error_m, 0.0);
    }

    #[test]
    fn carryover_is_clamped_to_one_block_of_allowance() {
        let config = BudgetConfig {
            enabled: true,
            target_mbps: 8.0,
            ..BudgetConfig::default()
        };
        let mut state = BudgetState::default();
        // Many cheap blocks in a row must not bank unbounded credit.
        for _ in 0..50 {
            state.observe_block(&config, 0.25, 1_000, 10);
        }
        let target = (config.target_mbps * 1e6 / 8.0 * 0.25) as i64;
        assert!(state.carryover_bytes <= target);
    }
}
