//! Structure qualification: every native destructible (city building, fleet
//! car) linted for authoring faults and, on the GPU, solved under its load
//! cases with the native stage's own solve report, ending in a verdict.
//!
//! The solve report (PxDestructionScene v23) says, per stress component and
//! per solve, why the solve stopped: converged, cut off at the iteration cap
//! while still improving, or stagnated (no 1% improvement in 512 iterations),
//! with its residual history and each chunk's share of what is left. That is
//! what turns "unconverged" into a decision:
//!   - cut off at the cap: more iterations would converge it, and the history
//!     says how many (`extra_iterations`);
//!   - stagnated: no iteration count will; the structure or its loads must
//!     change, and the chunks holding the residual say where.
//!
//!   cargo test -p web-fps-server --bin web-fps-server lint_city_structures -- --ignored --nocapture
//! (CPU only; the vehicle builds: vehicle_assets::lint::tests::lint_vehicle_builds;
//! solve verdicts: physx_runtime::vehicle_lab and city_structures_qualify.)

#[cfg(feature = "native-destruction")]
pub use tally::*;

#[cfg(feature = "native-destruction")]
mod tally {
    use std::collections::{BTreeMap, HashMap};
    use vibe_land_physx_bridge::FfiStressSolveReport;

    pub fn reason_name(reason: u32) -> &'static str {
        match reason {
            1 => "converged", 2 => "iteration-cap", 3 => "stagnated", 4 => "degenerate", 5 => "failed",
            6 => "settled", 7 => "not-ready", 8 => "large-component", _ => "unreported",
        }
    }

    /// Iterations beyond `iterations` the residual's own recent rate needs to
    /// reach tolerance: the last two powers of two in the history give a
    /// per-iteration factor. None when it is not falling.
    pub fn extra_iterations(history: &[f32], final2: f32, tolerance2: f32) -> Option<f64> {
        let points: Vec<(f64, f64)> = history.iter().enumerate().filter(|(_, h)| h.is_finite() && **h > 0.)
            .map(|(k, h)| (if k == 0 { 0. } else { (1u64 << (k - 1)) as f64 }, *h as f64)).collect();
        let [.., (i0, h0), (i1, h1)] = points.as_slice() else { return None };
        let factor = (h1 / h0).powf(1. / (i1 - i0));
        if !(factor < 0.999) || !(final2 > tolerance2) { return None; }
        Some(((tolerance2 as f64) / (final2 as f64)).ln() / factor.ln())
    }

    /// Solve reports over a run, for the components of chosen structures.
    #[derive(Default)]
    pub struct SolveTally {
        pub solves: u32,
        pub reasons: BTreeMap<&'static str, u32>,
        /// sqrt(final2 / tolerance2) of every unconverged solve.
        pub excess: Vec<f32>,
        /// Extrapolated extra iterations of solves cut off at the cap.
        pub extra: Vec<f64>,
        /// Per (structure, node): summed share of its component's residual over unconverged solves.
        pub hot: HashMap<(u32, u32), f64>,
        /// A few unconverged component records, verbatim.
        pub examples: Vec<serde_json::Value>,
        pub max_iterations: u32,
    }

    impl SolveTally {
        /// Fold one step's report in; `keep` selects structures by id.
        pub fn ingest(&mut self, report: &FfiStressSolveReport, keep: impl Fn(u32) -> bool) {
            let mut owner: HashMap<u32, u32> = HashMap::new();
            let mut members: HashMap<u32, Vec<(u32, u32, f32)>> = HashMap::new();
            for c in &report.chunks {
                if !keep(c.structure_id) { continue; }
                owner.insert(c.component, c.structure_id);
                members.entry(c.component).or_default().push((c.structure_id, c.node, c.residual2));
            }
            for c in &report.components {
                if !owner.contains_key(&c.component) { continue; }
                let reason = reason_name(c.reason);
                self.solves += 1;
                *self.reasons.entry(reason).or_default() += 1;
                self.max_iterations = self.max_iterations.max(c.iterations);
                if !matches!(c.reason, 1 | 6) {
                    if c.tolerance2 > 0. && c.final2.is_finite() { self.excess.push((c.final2 / c.tolerance2).sqrt()); }
                    if c.reason == 2 { if let Some(e) = extra_iterations(&c.history, c.final2, c.tolerance2) { self.extra.push(e); } }
                    let chunks = &members[&c.component];
                    let total: f64 = chunks.iter().map(|m| m.2 as f64).sum();
                    if total > 0. { for m in chunks { *self.hot.entry((m.0, m.1)).or_default() += m.2 as f64 / total; } }
                    if self.examples.len() < 6 {
                        self.examples.push(serde_json::json!({"component": c.component, "chunks": c.chunk_count, "anchored": c.anchored,
                            "reason": reason, "iterations": c.iterations, "bestIteration": c.best_iteration,
                            "residualOverTolerance": (c.final2 / c.tolerance2).sqrt(), "bestOverTolerance": (c.best2 / c.tolerance2).sqrt(),
                            "history": c.history.iter().map(|h| if h.is_finite() { (h / c.tolerance2).sqrt() } else { f32::NAN }).collect::<Vec<_>>()}));
                    }
                }
            }
        }

        pub fn unconverged(&self) -> u32 { self.solves - self.reasons.get("converged").copied().unwrap_or(0) - self.reasons.get("settled").copied().unwrap_or(0) }

        fn median(v: &[f32]) -> f32 { let mut s = v.to_vec(); s.sort_by(f32::total_cmp); s.get(s.len() / 2).copied().unwrap_or(0.) }

        /// One sentence: converges, needs N more iterations, or stalls (authoring).
        pub fn verdict(&self) -> String {
            let bad = self.unconverged();
            if self.solves == 0 { return "no solve observed".into(); }
            if bad == 0 { return format!("converges ({} solves, at most {} iterations)", self.solves, self.max_iterations); }
            let stalled = self.reasons.get("stagnated").copied().unwrap_or(0) + self.reasons.get("degenerate").copied().unwrap_or(0) + self.reasons.get("failed").copied().unwrap_or(0);
            let capped = self.reasons.get("iteration-cap").copied().unwrap_or(0);
            let share = |n: u32| 100. * n as f32 / self.solves as f32;
            let mut parts = vec![format!("{bad} of {} solves unconverged ({:.0}%), median residual {:.1}x tolerance", self.solves, share(bad), Self::median(&self.excess))];
            if stalled > 0 { parts.push(format!("{stalled} stalled ({:.0}%): more iterations will not help; fix the structure or its loads", share(stalled))); }
            if capped > 0 {
                let mut e = self.extra.clone(); e.sort_by(f64::total_cmp);
                let p = |q: f64| e.get(((e.len() as f64 - 1.) * q) as usize).copied().unwrap_or(f64::NAN);
                parts.push(format!("{capped} cut off at {} iterations ({:.0}%): would need ~{:.0} more (median; p90 {:.0}) at their recent rate",
                    self.max_iterations, share(capped), p(0.5), p(0.9)));
            }
            parts.join("; ")
        }

        /// The chunks that hold most of the unresolved residual, by summed share.
        pub fn hot_chunks(&self, n: usize) -> Vec<((u32, u32), f64)> {
            let mut v: Vec<_> = self.hot.iter().map(|(k, s)| (*k, *s)).collect();
            v.sort_by(|a, b| b.1.total_cmp(&a.1));
            v.truncate(n);
            v
        }

        pub fn to_json(&self, name: impl Fn(u32, u32) -> String) -> serde_json::Value {
            serde_json::json!({"solves": self.solves, "reasons": self.reasons, "verdict": self.verdict(),
                "maxIterations": self.max_iterations, "medianExcess": Self::median(&self.excess),
                "hotChunks": self.hot_chunks(10).iter().map(|((s, n), share)| serde_json::json!({"chunk": name(*s, *n), "share": share / self.unconverged().max(1) as f64})).collect::<Vec<_>>(),
                "examples": self.examples})
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn extrapolates_a_falling_residual_and_not_a_plateau() {
            let mut falling = vec![f32::NAN; 16];
            // 1e-2 at iteration 32, 1e-3 at 64: a decade per 32 iterations.
            falling[6] = 1e-2; falling[7] = 1e-3;
            let extra = super::extra_iterations(&falling, 1e-3, 1e-6).unwrap();
            assert!((extra - 96.).abs() < 1., "{extra}");
            let mut flat = vec![f32::NAN; 16];
            flat[6] = 1e-3; flat[7] = 1e-3;
            assert!(super::extra_iterations(&flat, 1e-3, 1e-6).is_none());
        }
    }
}

#[cfg(test)]
mod tests {
    /// The authoring lint over every structure of the city scene the server loads.
    #[test]
    #[ignore = "reads the city scene asset"]
    fn lint_city_structures() {
        let (_, manifest, _) = crate::city::manifest_asset().expect("city scene asset");
        let settings = vibe_land_destruction::city_config::stress_settings(&crate::city::scene_stress_materials());
        let mut blockers = 0;
        for s in &manifest.structures {
            let (nodes, bonds) = vibe_land_destruction::structure_lint::building_inputs(s, &settings.materials);
            let report = vibe_land_destruction::structure_lint::lint(&nodes, &bonds, &Default::default());
            blockers += report.blockers();
            eprintln!("== structure {}: {}", s.structure_id, report.card());
        }
        eprintln!("{} structures, {blockers} blocker(s)", manifest.structures.len());
    }
}
