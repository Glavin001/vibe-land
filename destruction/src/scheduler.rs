//! Reusable urgency scoring and bounded candidate selection.
//!
//! Ported from /root/workspace/destruction-codec/src/scheduler.rs (2026-08-10).
//! The budget is a ceiling, never a fill target. Candidates are emitted only
//! when their state warrants an update, then packed in descending urgency.

use crate::classify::PhysicalClass;

#[derive(Clone, Copy, Debug)]
pub struct PriorityConfig {
    pub max_moving_age_ticks: u32,
    pub contact_target_age_ticks: u32,
    pub linear_motion_threshold: f32,
    pub angular_motion_threshold: f32,
}

impl PriorityConfig {
    pub fn from_hz(hz: u32) -> Self {
        Self {
            max_moving_age_ticks: (hz / 2).max(1),
            contact_target_age_ticks: (hz / 12).max(1),
            linear_motion_threshold: 0.05,
            angular_motion_threshold: 0.08,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PriorityInput {
    pub class: PhysicalClass,
    pub projected_error_ratio: f32,
    pub age_ticks: u32,
    pub contacts: u16,
    pub linear_speed: f32,
    pub angular_speed: f32,
    pub linear_velocity_innovation: f32,
    pub angular_velocity_innovation: f32,
    pub contact_begin: bool,
    pub joint_break: bool,
    pub wake: bool,
    pub interest_entry: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct PriorityDecision {
    pub score: f32,
    pub should_send: bool,
    pub hard_deadline: bool,
}

pub fn compute_priority(input: PriorityInput, config: PriorityConfig) -> PriorityDecision {
    let moving = input.linear_speed > config.linear_motion_threshold
        || input.angular_speed > config.angular_motion_threshold;
    let perturbation = input.linear_velocity_innovation + 0.35 * input.angular_velocity_innovation;
    let event = input.contact_begin || input.joint_break || input.wake || input.interest_entry;
    let contact_motion = input.contacts > 0 && moving;
    let target_age = if contact_motion || input.class == PhysicalClass::ImpactBurst {
        config.contact_target_age_ticks
    } else {
        config.max_moving_age_ticks
    };
    let hard_deadline =
        input.interest_entry || (moving && input.age_ticks >= config.max_moving_age_ticks);

    let class_score = match input.class {
        PhysicalClass::Quiescent => 0.0,
        PhysicalClass::Ballistic => 0.5,
        PhysicalClass::ContactActive => {
            if contact_motion {
                5.0
            } else {
                0.5
            }
        }
        PhysicalClass::ImpactBurst => 12.0,
    };
    let event_score = if event { 20.0 } else { 0.0 };
    let age_score = input.age_ticks as f32 / target_age.max(1) as f32 * 4.0;
    let deadline_score = if hard_deadline {
        40.0 + (input.age_ticks.saturating_sub(config.max_moving_age_ticks)) as f32
            / config.max_moving_age_ticks.max(1) as f32
            * 8.0
    } else {
        0.0
    };
    let score = input.projected_error_ratio.max(0.0) * 8.0
        + class_score
        + event_score
        + age_score
        + perturbation.min(20.0) * 2.0
        + deadline_score;

    let should_send = input.class != PhysicalClass::Quiescent
        && (input.projected_error_ratio >= 1.0
            || event
            || hard_deadline
            || (contact_motion && input.age_ticks >= target_age)
            || perturbation >= 0.25);
    PriorityDecision {
        score,
        should_send,
        hard_deadline,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BudgetCandidate {
    pub index: usize,
    pub cost_bytes: usize,
    pub priority: f32,
    pub required: bool,
}

#[derive(Clone, Debug, Default)]
pub struct BudgetSelection {
    pub selected_indices: Vec<usize>,
    pub used_bytes: usize,
}

/// Greedy fill by priority, in place.
///
/// Takes `&mut` so it can sort the caller's buffer directly: it used to
/// `to_vec()` first, copying every candidate before sorting it, once per
/// client per send. At several thousand candidates that copy is pure waste --
/// the caller rebuilds the buffer next send anyway.
pub fn select_with_ceiling(
    candidates: &mut [BudgetCandidate],
    ceiling_bytes: Option<usize>,
    initial_bytes: usize,
) -> BudgetSelection {
    let order = &mut *candidates;
    let ranking = |a: &BudgetCandidate, b: &BudgetCandidate| {
        b.required
            .cmp(&a.required)
            .then_with(|| b.priority.total_cmp(&a.priority))
            .then_with(|| a.index.cmp(&b.index))
    };

    // Partition to the plausible winners, then sort only those.
    //
    // The ceiling admits roughly ceiling/min_cost records, so a full O(n log n)
    // sort of every candidate ranks thousands of bodies that cannot possibly
    // ship. select_nth_unstable puts the best K in the front partition in
    // O(n); the sort that decides actual order then runs over K, not n. K is
    // padded 2x because per-record costs vary, so the K-th best by priority is
    // not exactly the cutoff by bytes; the greedy fill below remains the
    // arbiter and required records are counted separately so they can never be
    // partitioned away.
    let mut fill_limit = order.len();
    if let Some(ceiling) = ceiling_bytes {
        let min_cost = order
            .iter()
            .map(|candidate| candidate.cost_bytes.max(1))
            .min()
            .unwrap_or(1);
        let max_records = ceiling.saturating_sub(initial_bytes) / min_cost;
        let required = order.iter().filter(|candidate| candidate.required).count();
        let padded = max_records.saturating_mul(2).saturating_add(required);
        if padded < order.len() {
            order.select_nth_unstable_by(padded, ranking);
            fill_limit = padded + 1;
        }
    }
    order[..fill_limit].sort_by(ranking);

    let mut selection = BudgetSelection {
        selected_indices: Vec::with_capacity(fill_limit),
        used_bytes: initial_bytes,
    };
    for candidate in order[..fill_limit].iter() {
        let fits = ceiling_bytes.is_none_or(|ceiling| {
            selection.used_bytes.saturating_add(candidate.cost_bytes) <= ceiling
        });
        if fits {
            selection.selected_indices.push(candidate.index);
            selection.used_bytes += candidate.cost_bytes;
        }
    }
    selection.selected_indices.sort_unstable();
    selection
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> PriorityInput {
        PriorityInput {
            class: PhysicalClass::ContactActive,
            projected_error_ratio: 0.5,
            age_ticks: 1,
            contacts: 1,
            linear_speed: 1.0,
            angular_speed: 0.0,
            linear_velocity_innovation: 0.0,
            angular_velocity_innovation: 0.0,
            contact_begin: false,
            joint_break: false,
            wake: false,
            interest_entry: false,
        }
    }

    #[test]
    fn recent_update_has_lower_priority_than_old_update() {
        let config = PriorityConfig::from_hz(120);
        let recent = compute_priority(input(), config);
        let old = compute_priority(
            PriorityInput {
                age_ticks: 20,
                ..input()
            },
            config,
        );
        assert!(old.score > recent.score);
        assert!(!recent.should_send);
        assert!(old.should_send);
    }

    #[test]
    fn perturbed_contact_outranks_stable_contact() {
        let config = PriorityConfig::from_hz(120);
        let stable = compute_priority(
            PriorityInput {
                linear_speed: 0.0,
                age_ticks: 20,
                ..input()
            },
            config,
        );
        let perturbed = compute_priority(
            PriorityInput {
                linear_velocity_innovation: 4.0,
                contact_begin: true,
                ..input()
            },
            config,
        );
        assert!(!stable.should_send);
        assert!(perturbed.should_send);
        assert!(perturbed.score > stable.score);
    }

    #[test]
    fn moving_body_eventually_reaches_hard_deadline() {
        let config = PriorityConfig::from_hz(120);
        let decision = compute_priority(
            PriorityInput {
                class: PhysicalClass::Ballistic,
                contacts: 0,
                age_ticks: config.max_moving_age_ticks,
                ..input()
            },
            config,
        );
        assert!(decision.hard_deadline);
        assert!(decision.should_send);
        assert!(decision.score >= 40.0);
    }

    #[test]
    fn budget_is_a_ceiling_not_a_fill_target() {
        let mut only = [BudgetCandidate {
            index: 0,
            cost_bytes: 20,
            priority: 1.0,
            required: false,
        }];
        let selection = select_with_ceiling(&mut only, Some(100), 5);
        assert_eq!(selection.selected_indices, [0]);
        assert_eq!(selection.used_bytes, 25);

        let idle = select_with_ceiling(&mut [], Some(100), 0);
        assert!(idle.selected_indices.is_empty());
        assert_eq!(idle.used_bytes, 0);
    }

    #[test]
    fn highest_priority_candidates_fit_first() {
        let mut pair = [
            BudgetCandidate {
                index: 0,
                cost_bytes: 60,
                priority: 1.0,
                required: false,
            },
            BudgetCandidate {
                index: 1,
                cost_bytes: 60,
                priority: 5.0,
                required: false,
            },
        ];
        let selection = select_with_ceiling(&mut pair, Some(70), 0);
        assert_eq!(selection.selected_indices, [1]);
        assert_eq!(selection.used_bytes, 60);
    }
}
