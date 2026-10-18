//! State-based structural acceptance. Elapsed time is never evidence of rest.
//! A caller may bound its update loop, but exhausting that budget is failure.
use crate::types::NamedSpan;
use vibe_netcode::destruction_backend::DestructionStats;

#[derive(Clone, Debug, PartialEq)]
pub struct EquilibriumSample {
    pub live_structures: u64,
    pub converged_structures: u64,
    pub completed_updates: u64,
    pub active_island_updates: u64,
    pub crush_yield_nodes: u64,
    pub topology_changes: u64,
    pub solver_islands: u32,
    pub skipped_islands: u32,
    pub awake_bodies: u32,
    pub overstressed_bonds: u32,
    pub peak_utilisation: f32,
    pub broken_bonds: u32,
    pub bodies: u32,
}

impl EquilibriumSample {
    /// Missing diagnostics must fail closed: a default zero is not convergence.
    pub fn capture(stats: &DestructionStats, spans: &[NamedSpan]) -> Result<Self, String> {
        let count = |name: &str| -> Result<u64, String> {
            let matches: Vec<_> = spans.iter().filter(|s| s.name == name).collect();
            if matches.len() != 1 {
                return Err(format!(
                    "expected one {name} diagnostic, found {}",
                    matches.len()
                ));
            }
            let s = matches[0];
            if s.kind != 2
                || !s.value.is_finite()
                || s.value < 0.0
                || s.value.fract() != 0.0
                || s.value > 9_007_199_254_740_991.0
            {
                return Err(format!(
                    "invalid count {name}: {} (kind {})",
                    s.value, s.kind
                ));
            }
            Ok(s.value as u64)
        };
        Ok(Self {
            live_structures: count("stress_live_structures")?,
            converged_structures: count("stress_converged_structures")?,
            completed_updates: count("stress_completed_updates")?,
            active_island_updates: count("stress_active_island_updates")?,
            crush_yield_nodes: count("stress_crush_yield_nodes")?,
            topology_changes: count("stress_topology_changes")?,
            solver_islands: stats.solver_island_count,
            skipped_islands: stats.solver_islands_skipped,
            awake_bodies: stats.awake_chunk_bodies,
            overstressed_bonds: stats.overstressed_bonds,
            peak_utilisation: stats.bond_utilisation_max,
            broken_bonds: stats.broken_bonds,
            bodies: stats.chunk_bodies,
        })
    }

    /// Numerical convergence, safe material loads, physical sleep and actual
    /// solver skipping are independent requirements. Nonzero broken_bonds is
    /// allowed here for a damaged structure; the pristine gate checks it itself.
    pub fn is_inactive(&self) -> bool {
        self.live_structures > 0
            && self.completed_updates > 0
            && self.converged_structures == self.live_structures
            && self.skipped_islands == self.solver_islands
            && self.crush_yield_nodes == 0
            && self.awake_bodies == 0
            && self.overstressed_bonds == 0
            && self.peak_utilisation.is_finite()
            && (0.0..=1.0).contains(&self.peak_utilisation)
    }

    /// Compare across an actual idle update, not a delay. No new structural
    /// work or damage may occur, and the complete state must remain inactive.
    pub fn skipped_since(&self, previous: &Self) -> bool {
        previous.is_inactive()
            && self.is_inactive()
            && self.live_structures == previous.live_structures
            && self.solver_islands == previous.solver_islands
            && self.completed_updates >= previous.completed_updates
            && self.active_island_updates == previous.active_island_updates
            && self.broken_bonds == previous.broken_bonds
            && self.bodies == previous.bodies
            && self.topology_changes == previous.topology_changes
    }

    /// A changed input must cause fresh structural work. A cached convergence
    /// flag or an awake-body count alone does not prove invalidation happened.
    pub fn resumed_since(&self, previous: &Self) -> bool {
        self.completed_updates > previous.completed_updates
            && self.active_island_updates > previous.active_island_updates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inactive() -> EquilibriumSample {
        EquilibriumSample {
            live_structures: 2,
            converged_structures: 2,
            completed_updates: 10,
            active_island_updates: 16,
            crush_yield_nodes: 0,
            topology_changes: 2,
            solver_islands: 4,
            skipped_islands: 4,
            awake_bodies: 0,
            overstressed_bonds: 0,
            peak_utilisation: 0.5,
            broken_bonds: 0,
            bodies: 2,
        }
    }

    #[test]
    fn quiet_but_unconverged_or_overloaded_is_not_settled() {
        let good = inactive();
        assert!(good.is_inactive());
        let mut bad = good.clone();
        bad.converged_structures = 1;
        assert!(!bad.is_inactive());
        let mut bad = good.clone();
        bad.overstressed_bonds = 1;
        assert!(!bad.is_inactive());
        let mut bad = good.clone();
        bad.peak_utilisation = 1.01;
        assert!(!bad.is_inactive());
        let mut bad = good.clone();
        bad.crush_yield_nodes = 1;
        assert!(!bad.is_inactive());
        let mut bad = good;
        bad.awake_bodies = 1;
        assert!(!bad.is_inactive());
    }

    #[test]
    fn solver_must_skip_all_groups_and_have_completed_a_solve() {
        let mut s = inactive();
        s.skipped_islands -= 1;
        assert!(!s.is_inactive());
        let mut s = inactive();
        s.completed_updates = 0;
        assert!(!s.is_inactive());
        let mut s = inactive();
        s.live_structures = 0;
        s.converged_structures = 0;
        assert!(!s.is_inactive());
        for value in [f32::NAN, f32::INFINITY, -1.0] {
            let mut s = inactive();
            s.peak_utilisation = value;
            assert!(!s.is_inactive());
        }
    }

    #[test]
    fn idle_update_requires_no_new_work_damage_or_topology_change() {
        let before = inactive();
        let mut next = before.clone();
        next.completed_updates += 1;
        assert!(next.skipped_since(&before)); // Cheap no-op invocation is fine.
        next.active_island_updates += 1;
        assert!(!next.skipped_since(&before));
        let mut next = before.clone();
        next.broken_bonds += 1;
        assert!(!next.skipped_since(&before));
        let mut next = before.clone();
        next.bodies += 1;
        assert!(!next.skipped_since(&before));
        let mut next = before.clone();
        next.topology_changes += 1;
        assert!(!next.skipped_since(&before));
        let mut next = before.clone();
        next.completed_updates = 1;
        assert!(!next.skipped_since(&before)); // A recreated counter is not a skip.
    }

    #[test]
    fn disturbance_must_resume_work_not_just_report_an_awake_body() {
        let before = inactive();
        let mut after = before.clone();
        after.awake_bodies = 1;
        assert!(!after.resumed_since(&before));
        after.completed_updates += 1;
        after.active_island_updates += 1;
        assert!(after.resumed_since(&before));
    }

    #[test]
    fn damaged_structure_can_resettle_without_erasing_damage() {
        let mut before = inactive();
        before.broken_bonds = 50;
        let mut after = before.clone();
        after.completed_updates += 1;
        assert!(after.skipped_since(&before));
    }

    #[test]
    fn missing_invalid_or_duplicate_diagnostics_fail_closed() {
        let stats = DestructionStats::default();
        assert!(EquilibriumSample::capture(&stats, &[]).is_err());
        let names = [
            "stress_live_structures",
            "stress_converged_structures",
            "stress_completed_updates",
            "stress_active_island_updates",
            "stress_crush_yield_nodes",
            "stress_topology_changes",
        ];
        let spans: Vec<_> = names
            .iter()
            .map(|name| NamedSpan {
                name: name.to_string(),
                value: 1.0,
                kind: 2,
            })
            .collect();
        assert!(EquilibriumSample::capture(&stats, &spans).is_ok());
        for value in [f64::NAN, -1.0, 1.5, f64::INFINITY] {
            let mut invalid = spans.clone();
            invalid[0].value = value;
            assert!(EquilibriumSample::capture(&stats, &invalid).is_err());
        }
        let mut duplicate = spans.clone();
        duplicate.push(spans[0].clone());
        assert!(EquilibriumSample::capture(&stats, &duplicate).is_err());
        let mut timing = spans;
        timing[0].kind = 0;
        assert!(EquilibriumSample::capture(&stats, &timing).is_err());
    }
}
