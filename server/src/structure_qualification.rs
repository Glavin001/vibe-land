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
            1 => "converged", 2 => "iteration-cap", 3 => "stagnated", 4 => "degenerate", 5 => "failed", 9 => "diverged",
            6 => "settled", 7 => "not-ready", 8 => "large-component", _ => "unreported",
        }
    }

    /// The stop reason, except that a solve whose final residual is ten times
    /// worse than where it started is "diverged" (9) whatever stopped it: its
    /// forces are worse than the warm start it began from.
    pub fn effective_reason(c: &vibe_land_physx_bridge::FfiStressComponentReport) -> u32 {
        let start = c.history.first().copied().unwrap_or(f32::NAN);
        if c.reason != 1 && start.is_finite() && c.final2 > 100. * start { 9 } else { c.reason }
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
        /// history[1] / history[0] of every solve that iterated: how much the
        /// first step changed the residual (> 1: it made it worse).
        pub first_step: Vec<f32>,
        /// Unconverged solves that ended worse than their warm start.
        pub regressed: u32,
        /// Iterations of every converged solve that iterated.
        pub converged_iterations: Vec<u32>,
    }

    impl SolveTally {
        /// Fold one step's report in; `keep` selects structures by id.
        pub fn ingest(&mut self, report: &FfiStressSolveReport, keep: impl Fn(u32) -> bool) {
            let mut owner: HashMap<u32, u32> = HashMap::new();
            let mut members: HashMap<u32, Vec<(u32, u32, f32)>> = HashMap::new();
            for c in &report.chunks {
                if !keep(c.structure_id) || c.component == u32::MAX { continue; }
                owner.insert(c.component, c.structure_id);
                members.entry(c.component).or_default().push((c.structure_id, c.node, c.residual2));
            }
            for c in &report.components {
                if !owner.contains_key(&c.component) { continue; }
                let reason = reason_name(effective_reason(c));
                self.solves += 1;
                *self.reasons.entry(reason).or_default() += 1;
                self.max_iterations = self.max_iterations.max(c.iterations);
                let (h0, h1) = (c.history[0], c.history[1]);
                if c.iterations > 0 && h0 > 0. && h1.is_finite() { self.first_step.push((h1 / h0).sqrt()); }
                if c.reason == 1 && c.iterations > 0 { self.converged_iterations.push(c.iterations); }
                if !matches!(c.reason, 1 | 6) && h0 > 0. && c.final2 > h0 { self.regressed += 1; }
                if !matches!(c.reason, 1 | 6) {
                    let reason_code = effective_reason(c);
                    if c.tolerance2 > 0. && c.final2.is_finite() { self.excess.push((c.final2 / c.tolerance2).sqrt()); }
                    if reason_code == 2 { if let Some(e) = extra_iterations(&c.history, c.final2, c.tolerance2) { self.extra.push(e); } }
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
            let diverged = self.reasons.get("diverged").copied().unwrap_or(0);
            let capped = self.reasons.get("iteration-cap").copied().unwrap_or(0);
            let share = |n: u32| 100. * n as f32 / self.solves as f32;
            let mut parts = vec![format!("{bad} of {} solves unconverged ({:.0}%), median residual {:.1}x tolerance", self.solves, share(bad), Self::median(&self.excess))];
            if diverged > 0 { parts.push(format!("{diverged} diverged ({:.0}%): ended >10x worse than they started; their forces are not to be trusted", share(diverged))); }
            if stalled > 0 { parts.push(format!("{stalled} stalled ({:.0}%): more iterations will not help; fix the structure or its loads", share(stalled))); }
            if capped > 0 {
                let mut e = self.extra.clone(); e.sort_by(f64::total_cmp);
                let p = |q: f64| e.get(((e.len() as f64 - 1.) * q) as usize).copied().unwrap_or(f64::NAN);
                parts.push(format!("{capped} cut off at {} iterations ({:.0}%): would need ~{:.0} more (median; p90 {:.0}) at their recent rate",
                    self.max_iterations, share(capped), p(0.5), p(0.9)));
            }
            parts.join("; ")
        }

        fn quantile<T: Copy + PartialOrd>(v: &[T], q: f64) -> Option<T> {
            let mut s = v.to_vec(); s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            s.get(((s.len() as f64 - 1.) * q).round() as usize).copied()
        }

        /// How the solves behaved, independent of the verdict: the first
        /// step's effect on the residual, regressions below the warm start, and
        /// how many iterations the converged ones took.
        pub fn shape(&self) -> String {
            let q = |v: &[f32], p| Self::quantile(v, p).unwrap_or(f32::NAN);
            let i = |p| Self::quantile(&self.converged_iterations, p).map_or("-".into(), |v| v.to_string());
            format!("first step x{:.2} residual (median; p90 x{:.1}); {} of {} unconverged ended worse than their warm start; converged in {} iterations (median; p90 {})",
                q(&self.first_step, 0.5), q(&self.first_step, 0.9), self.regressed, self.unconverged(), i(0.5), i(0.9))
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
                "maxIterations": self.max_iterations, "medianExcess": Self::median(&self.excess), "shape": self.shape(),
                "firstStepMedian": Self::quantile(&self.first_step, 0.5), "firstStepP90": Self::quantile(&self.first_step, 0.9),
                "regressed": self.regressed, "convergedIterationsMedian": Self::quantile(&self.converged_iterations, 0.5),
                "convergedIterationsP90": Self::quantile(&self.converged_iterations, 0.9),
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
    /// Every city structure on the real city stage, at the city's own
    /// iteration cap (VIBE_CITY_NATIVE_STRESS_ITERATIONS, default 16) and
    /// tolerance: gravity at rest, then the city cannonball into one building
    /// (VIBE_QUALIFY_TARGET, default structure 0). Prints each structure's
    /// solve verdict and the chunks that hold any unresolved residual.
    #[cfg(feature = "native-destruction")]
    #[test]
    #[ignore = "requires local GPU and the native-destruction SDK"]
    fn city_structures_qualify() {
        use super::SolveTally;
        use nalgebra::Vector3;
        use std::collections::BTreeMap;
        let _guard = crate::physx_runtime::tests::gpu_test_guard();
        std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (rest, after, target) = (env("VIBE_QUALIFY_REST_TICKS", 180), env("VIBE_QUALIFY_IMPACT_TICKS", 240), env("VIBE_QUALIFY_TARGET", 0));
        let mut arena = crate::movement::PhysicsArena::new(vibe_netcode::movement::MoveConfig::default(),
            vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu).expect("production arena");
        crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
        let mut city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
        let (_, manifest, _) = crate::city::manifest_asset().expect("city scene asset");
        let ids: Vec<u32> = manifest.structures.iter().map(|s| s.structure_id).collect();
        let gravity = vibe_netcode::movement::default_world_gravity();
        let dt = 1.0 / 60.0;
        let mut tick = 0u32;
        let mut on = false;
        // Bonds broken so far (the stage's count is a running total, so the
        // largest value seen), and the body count after the first tick, for
        // "does it stand".
        let broken_total = std::cell::Cell::new(0u64);
        // Chunks the stage crushed (opt-in chunk crushing): at rest there must be none.
        let crushed_total = std::cell::Cell::new(0u64);
        let clusters_first = std::cell::Cell::new(None::<u32>);
        // VIBE_QUALIFY_BOND_ROWS=path: every bond of structure 0, from the
        // native stage (utilisation, stresses, damage), at the first tick at
        // rest and at the end, with the tick each one broke -- what broke and
        // why, for the authoring.
        let rows_path = std::env::var("VIBE_QUALIFY_BOND_ROWS").ok();
        let first_broken: std::cell::RefCell<BTreeMap<u32, u32>> = Default::default();
        let snapshots: std::cell::RefCell<Vec<serde_json::Value>> = Default::default();
        let mut run = |arena: &mut crate::movement::PhysicsArena, city: &mut crate::city::CityRuntime, tick: &mut u32, n: u32| {
            let mut tallies: BTreeMap<u32, SolveTally> = ids.iter().map(|i| (*i, SolveTally::default())).collect();
            for _ in 0..n {
                arena.step_vehicles_and_dynamics(dt);
                let _ = city.step(*tick, dt, gravity, arena.physx_world_mut());
                broken_total.set(broken_total.get().max(u64::from(city.stats().broken_bonds)));
                if let Some((status, _, _)) = city.native_tick_view() { crushed_total.set(crushed_total.get() + u64::from(status.crushed_chunks)); }
                if clusters_first.get().is_none() {
                    clusters_first.set(arena.physx_world_mut().and_then(|w| w.native_last_status().ok()).map(|n| n.cluster_count));
                }
                *tick += 1;
                let world = arena.physx_world_mut().unwrap();
                if rows_path.is_some() {
                    let rows = world.native_bond_stress_rows(0).unwrap_or_default();
                    let mut first = first_broken.borrow_mut();
                    let before = first.len();
                    for r in &rows { if r.broken || r.remaining_area <= 0. { first.entry(r.bond_index).or_insert(*tick); } }
                    // And the first tick that breaks many at once (the stage's own verdict stresses).
                    let burst = first.len() - before > 50 && !snapshots.borrow().iter().any(|v| v["burst"] == true);
                    if burst { snapshots.borrow_mut().push(serde_json::json!({"tick": *tick, "burst": true, "rows": rows.iter().map(|r| serde_json::json!({"bond": r.bond_index, "node0": r.node0, "node1": r.node1, "material": r.material,
                        "area": r.area, "utilisation": r.utilisation, "compression": r.compression, "tension": r.tension, "shear": r.shear,
                        "normal": r.stress_normal, "bend": r.stress_bend, "damage": r.damage, "remaining": r.remaining_area, "broken": r.broken})).collect::<Vec<_>>()})); }
                    if *tick == 2 || *tick == rest {
                        let rows: Vec<_> = rows.iter().map(|r| serde_json::json!({"bond": r.bond_index, "node0": r.node0, "node1": r.node1, "material": r.material,
                            "area": r.area, "utilisation": r.utilisation, "compression": r.compression, "tension": r.tension, "shear": r.shear,
                            "normal": r.stress_normal, "bend": r.stress_bend, "damage": r.damage, "remaining": r.remaining_area, "broken": r.broken})).collect();
                        snapshots.borrow_mut().push(serde_json::json!({"tick": *tick, "rows": rows}));
                    }
                }
                if !on { on = world.native_set_stress_solve_report(1).unwrap_or(false); continue; }
                if let Ok(r) = world.native_stress_solve_report() {
                    for (id, t) in tallies.iter_mut() { t.ingest(&r, |s| s == *id); }
                }
            }
            tallies
        };
        // VIBE_QUALIFY_FRONT_DROP=1 (a house pack in VIBE_CITY_SCENE): how far
        // the front of the roof and of the upper floor came down -- the mean
        // live height of the roof covering and of the floor members above the
        // ground storey whose authored centroid is in front (z < -0.5), before
        // the run and at its end.
        let front: Option<Vec<(&str, Vec<u32>)>> = std::env::var_os("VIBE_QUALIFY_FRONT_DROP").and(std::env::var("VIBE_CITY_SCENE").ok()).map(|path| {
            let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).expect("VIBE_CITY_SCENE pack")).expect("pack json");
            let types = doc["scenario"]["nodeTypes"].as_array().unwrap();
            let nodes = doc["scenario"]["nodes"].as_array().unwrap();
            let pick = |want: &[&str], min_y: f64| (0..types.len() as u32).filter(|&i| {
                let t = types[i as usize].as_str().unwrap_or("").split('@').next().unwrap_or("");
                let c = &nodes[i as usize]["centroid"];
                want.contains(&t) && c["z"].as_f64().unwrap_or(0.) < -0.5 && c["y"].as_f64().unwrap_or(0.) > min_y
            }).collect::<Vec<u32>>();
            vec![("front roof covering", pick(&["roof-covering"], 0.)), ("front upper floor", pick(&["subfloor", "floor-joist"], 1.5))]
        });
        let heights = |world: &vibe_land_physx_bridge::World, ids: &[u32]| {
            let y: Vec<f32> = ids.iter().filter_map(|&i| world.native_chunk_aim(0, i).ok().filter(|a| a.found).map(|a| a.center.y)).collect();
            (y.iter().sum::<f32>() / y.len().max(1) as f32, y.len())
        };
        let front_start: Vec<(f32, usize)> = front.as_ref().map(|f| { let w = arena.physx_world_mut().unwrap(); f.iter().map(|(_, ids)| heights(w, ids)).collect() }).unwrap_or_default();
        let idle = run(&mut arena, &mut city, &mut tick, rest);
        if let Some(f) = &front {
            let w = arena.physx_world_mut().unwrap();
            for ((label, ids), (y0, n0)) in f.iter().zip(&front_start) {
                let (y1, n1) = heights(w, ids);
                eprintln!("front drop: {label}: {y0:.2} -> {y1:.2} m ({:.2} m down; {n0} -> {n1} of {} chunks found)", y0 - y1, ids.len());
            }
        }
        // Whether it stands as well as converges: a structure can converge and
        // fall down (Bayline's billboard). The authored-structure gate allows
        // under 0.5% of bonds broken at rest (authored_structures_sim.rs).
        {
            let bonds: usize = manifest.structures.iter().map(|s| s.bonds.len()).sum();
            let world = arena.physx_world_mut().expect("physx world");
            let awake = world.stats().map(|w| w.active_dynamic_bodies).unwrap_or(0);
            let clusters = world.native_last_status().map(|n| n.cluster_count).unwrap_or(0);
            let broken = broken_total.get();
            eprintln!("stands at rest: broken bonds {broken} of {bonds} ({:.2}%), awake bodies {awake}, clusters {} -> {clusters}, crushed chunks {}",
                100.0 * broken as f64 / bonds.max(1) as f64, clusters_first.get().unwrap_or(0), crushed_total.get());
        }
        let s = &manifest.structures[target as usize];
        let aim = Vector3::new(s.world_position[0], 3.0, s.world_position[2]);
        let origin = aim + Vector3::new(20., 0.5, 0.);
        let speed = crate::city::city_ball_speed_ms();
        let t = 20. / speed;
        arena.launch_ball_from_muzzle(origin, (aim - origin) / t + Vector3::new(0., 0.5 * 9.81 * t, 0.),
            crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), 600).expect("ball");
        let impact = run(&mut arena, &mut city, &mut tick, after);
        if let Some(path) = &rows_path {
            std::fs::write(path, serde_json::to_vec(&serde_json::json!({"snapshots": *snapshots.borrow(), "firstBroken": *first_broken.borrow(), "restTicks": rest})).unwrap()).unwrap();
        }
        let name = |s: u32, n: u32| {
            let structure = manifest.structures.iter().find(|x| x.structure_id == s);
            let y = structure.and_then(|x| x.chunks.get(n as usize)).map_or(f32::NAN, |c| c.centroid[1]);
            format!("{s}#{n} (y {y:.1} m)")
        };
        let (mut idle_ok, mut impact_ok) = (0, 0);
        let mut json = Vec::new();
        for id in &ids {
            let (a, b) = (&idle[id], &impact[id]);
            idle_ok += (a.unconverged() == 0) as usize; impact_ok += (b.unconverged() == 0) as usize;
            eprintln!("structure {id:>3}: at rest: {}\n               after impact on {target}: {}\n               {}", a.verdict(), b.verdict(), b.shape());
            for (label, t) in [("rest", a), ("impact", b)] {
                if t.unconverged() > 0 {
                    eprintln!("               residual held ({label}) by: {}", t.hot_chunks(4).iter().map(|((s, n), share)| format!("{} {:.0}%", name(*s, *n), share / t.unconverged() as f64 * 100.)).collect::<Vec<_>>().join(", "));
                }
            }
            json.push(serde_json::json!({"structure": id, "rest": a.to_json(name), "impact": b.to_json(name)}));
        }
        eprintln!("{idle_ok} of {} structures converge at rest, {impact_ok} after the impact (iterations {}, tolerance {:e})",
            ids.len(), vibe_land_destruction::native_runtime::stress_iterations(), vibe_land_destruction::native_runtime::stress_tolerance());
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/structure-qualification");
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(format!("{dir}/city.json"), serde_json::to_vec_pretty(&json).unwrap()).unwrap();
    }

    /// The authoring lint over every structure of the city scene the server loads.
    /// The game's own player walks a building's route: the pack in
    /// VIBE_CITY_SCENE (one structure), its route the `route` of the
    /// `.meta.json` beside it (VIBE_WALK_META overrides) -- feet points in the
    /// pack's coordinates, e.g. a house's stair from the ground floor to the
    /// upper floor and back. The production arena and player tick
    /// (MoveConfig::default: the 0.35 m x 1.6 m capsule, 0.55 m step, 45
    /// degree slope) under the app's stress settings, after
    /// VIBE_QUALIFY_REST_TICKS (180) at rest. Each tick the player is steered
    /// at the next point with walking input only (no jump, no drop after the
    /// start), and the run fails on:
    ///   - a point not reached within 15 s, or reached off the ground;
    ///   - a move no walk makes: further across in a tick than the capsule's
    ///     radius, or up more than the controller's step (a teleport);
    ///   - a fall of more than one riser of the code (IRC R311.7.5.1, 196 mm)
    ///     plus the contact offset: walking down a stair drops a riser at a
    ///     time, and nothing else on a route should drop the player at all;
    ///   - headroom under 2032 mm (IRC R311.7.2) over the feet, from a ray up
    ///     the capsule's axis from just over its top, every tick;
    ///   - any bond broken while walking.
    /// Prints `route walk: {json}` (points, ticks, the least headroom, the
    /// largest fall, the most airborne ticks in a row).
    #[cfg(feature = "native-destruction")]
    #[test]
    #[ignore = "requires local GPU and the native-destruction SDK"]
    fn route_walk() {
        use crate::city_qa::walk_input;
        use glam::Vec3;
        // The movement's yaw (shared/src/movement.rs build_wish_dir): forward is (sin yaw, 0, cos yaw).
        let heading = |from: Vec3, to: Vec3| (to.x - from.x).atan2(to.z - from.z);
        let _guard = crate::physx_runtime::tests::gpu_test_guard();
        std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
        const HEADROOM: f32 = 2.032; // IRC R311.7.2
        const MAX_RISER: f32 = 0.196; // IRC R311.7.5.1
        let scene = std::env::var("VIBE_CITY_SCENE").expect("VIBE_CITY_SCENE: the pack to walk");
        let meta_path = std::env::var("VIBE_WALK_META").unwrap_or_else(|_| scene.trim_end_matches(".json").to_string() + ".meta.json");
        let read = |p: &str| -> serde_json::Value { serde_json::from_slice(&std::fs::read(p).unwrap_or_else(|e| panic!("{p}: {e}"))).expect("json") };
        let (pack, meta) = (read(&scene), read(&meta_path));
        let route: Vec<(String, Vec3)> = meta["route"].as_array().expect("meta route").iter()
            .map(|p| (p["name"].as_str().unwrap_or("?").to_string(), Vec3::new(p["at"][0].as_f64().unwrap() as f32, p["at"][1].as_f64().unwrap() as f32, p["at"][2].as_f64().unwrap() as f32))).collect();
        assert!(route.len() >= 2, "a route of two points or more");
        let config = vibe_netcode::movement::MoveConfig::default();
        let (half, walk) = (config.capsule_half_segment + config.capsule_radius, config.walk_speed as f32);
        let mut arena = crate::movement::PhysicsArena::new(config.clone(), vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu).expect("production arena");
        crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
        let mut city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
        arena.set_tolerate_rejected_steps(city.backend_name() == "native");
        let gravity = vibe_netcode::movement::default_world_gravity();
        let dt = 1.0 / 60.0;
        let rest = std::env::var("VIBE_QUALIFY_REST_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(180u32);
        let mut tick = 0u32;
        for _ in 0..rest {
            arena.step_vehicles_and_dynamics(dt);
            let _ = city.step(tick, dt, gravity, arena.physx_world_mut());
            tick += 1;
        }
        let broken_at_rest = city.stats().broken_bonds;
        // Pack to world: where the stage put the pack's first chunk (its slab, fixed).
        let c = &pack["scenario"]["nodes"][0]["centroid"];
        let aim = arena.physx_world_mut().unwrap().native_chunk_aim(0, 0).expect("chunk 0");
        assert!(aim.found, "chunk 0 on the stage");
        let offset = Vec3::new(aim.center.x - c["x"].as_f64().unwrap() as f32, aim.center.y - c["y"].as_f64().unwrap() as f32, aim.center.z - c["z"].as_f64().unwrap() as f32);
        let route: Vec<(String, Vec3)> = route.into_iter().map(|(n, p)| (n, p + offset)).collect();
        // The player, standing at the first point (its position is the capsule's centre).
        arena.spawn_player(1);
        let start = route[0].1;
        let yaw0 = heading(start, route[1].1);
        let placed = arena.drop_player_from_camera(1, &vibe_land_shared::protocol::CityCameraDropCmd { position: [start.x, start.y + half + 0.02, start.z], yaw: yaw0, pitch: 0. });
        assert!(placed, "the player placed at {}", route[0].0);
        let feet = |arena: &crate::movement::PhysicsArena| { let s = arena.player_state(1).expect("player"); (Vec3::new(s.position.x as f32, s.position.y as f32 - half, s.position.z as f32), s.on_ground) };
        // VIBE_WALK_MAX_FALL: a diagnostic override, to see a whole walk past its first long fall.
        let max_fall = std::env::var("VIBE_WALK_MAX_FALL").ok().and_then(|v| v.parse().ok()).unwrap_or(MAX_RISER + config.collision_offset);
        let mut falls: Vec<serde_json::Value> = Vec::new();
        let (mut fastest, mut fastest_at, mut least_at) = (0f32, serde_json::Value::Null, serde_json::Value::Null);
        let mut seq = 0u16;
        let mut step = |arena: &mut crate::movement::PhysicsArena, city: &mut crate::city::CityRuntime, tick: &mut u32, input: vibe_land_shared::protocol::InputCmd| {
            arena.simulate_player_tick(1, &input, dt);
            arena.step_vehicles_and_dynamics(dt);
            let _ = city.step(*tick, dt, gravity, arena.physx_world_mut());
            *tick += 1;
        };
        // Settle onto the first point's floor.
        for _ in 0..30 { step(&mut arena, &mut city, &mut tick, walk_input(seq, yaw0, 0., 0., 0.)); seq = seq.wrapping_add(1); }
        let (mut at, grounded) = feet(&arena);
        assert!(grounded && (at.y - start.y).abs() < 0.05, "standing at {}: feet {at:?}, on the ground {grounded}", route[0].0);
        let (mut least_headroom, mut largest_fall, mut longest_air, mut air, mut fall_from) = (f32::INFINITY, 0f32, 0u32, 0u32, at.y);
        let mut reached = vec![serde_json::json!({"name": route[0].0, "feet": [at.x, at.y, at.z], "tick": 0})];
        let walk_start = tick;
        for (name, goal) in route.iter().skip(1) {
            let mut arrived = false;
            for _ in 0..900 {
                let flat = Vec3::new(goal.x - at.x, 0., goal.z - at.z).length();
                let (_, grounded) = feet(&arena);
                if flat < 0.2 && (at.y - goal.y).abs() < 0.25 && grounded { arrived = true; break; }
                // Walking (the wish direction is normalised: any forward input is walking speed).
                step(&mut arena, &mut city, &mut tick, walk_input(seq, heading(at, *goal), 0., 1., 0.));
                seq = seq.wrapping_add(1);
                let (now, grounded) = feet(&arena);
                let across = Vec3::new(now.x - at.x, 0., now.z - at.z).length();
                if across / dt > fastest { fastest = across / dt; fastest_at = serde_json::json!({"to": name, "from": [at.x, at.y, at.z], "at": [now.x, now.y, now.z], "grounded": grounded}); }
                assert!(across <= config.capsule_radius, "{name}: moved {across:.3} m across in a tick at {now:?}");
                assert!(now.y - at.y <= config.max_step_height + 0.01, "{name}: rose {:.3} m in a tick at {now:?}", now.y - at.y);
                // A fall: from the highest point since last on the ground to here.
                if !grounded { air += 1; longest_air = longest_air.max(air); }
                let fall = (fall_from - now.y).max(0.);
                largest_fall = largest_fall.max(fall);
                assert!(fall <= max_fall, "{name}: fell {fall:.3} m at {now:?}");
                if grounded && fall > MAX_RISER + config.collision_offset { falls.push(serde_json::json!({"to": name, "fall": fall, "at": [now.x, now.y, now.z]})); }
                if grounded { fall_from = now.y; air = 0; } else { fall_from = fall_from.max(now.y); }
                let world = arena.physx_world_mut().unwrap();
                // From just over the capsule's top: a ray from inside it stops on the capsule itself.
                let from = 2. * half + config.collision_offset + 0.005;
                let up = world.native_raycast_chunk(vibe_land_physx_bridge::Vec3::new(now.x, now.y + from, now.z), vibe_land_physx_bridge::Vec3::new(0., 1., 0.), 4.0).expect("ray");
                let headroom = if up.hit { up.distance + from } else { 4.0 + from };
                if headroom < least_headroom { least_headroom = headroom; least_at = serde_json::json!({"to": name, "feet": [now.x, now.y, now.z], "chunk": if up.hit { serde_json::json!(up.chunk_id & 0xffff) } else { serde_json::Value::Null }}); }
                assert!(headroom >= HEADROOM, "{name}: headroom {headroom:.3} m at {now:?} (chunk {})", up.chunk_id);
                let broken = city.stats().broken_bonds;
                assert_eq!(broken, broken_at_rest, "{name}: walking broke {} bonds", broken - broken_at_rest);
                at = now;
            }
            assert!(arrived, "{name} not reached: feet {at:?}, goal {goal:?}");
            reached.push(serde_json::json!({"name": name, "feet": [at.x, at.y, at.z], "tick": tick - walk_start}));
        }
        let summary = serde_json::json!({"passed": true, "points": reached.len(), "ticks": tick - walk_start, "seconds": (tick - walk_start) as f32 * dt,
            "leastHeadroom": least_headroom, "leastHeadroomAt": least_at, "largestFall": largest_fall, "maxFall": max_fall, "fastestAcross": fastest, "fastestAt": fastest_at, "walkSpeed": walk, "fallsOverARiser": falls, "longestAirborneTicks": longest_air, "brokenAtRest": broken_at_rest,
            "offset": [offset.x, offset.y, offset.z], "snapToGround": std::env::var("VIBE_PLAYER_SNAP_TO_GROUND").is_ok_and(|v| v == "1"), "capsule": {"radius": config.capsule_radius, "height": 2. * half, "step": config.max_step_height, "slopeDegrees": config.max_slope_radians.to_degrees()},
            "reached": reached});
        eprintln!("route walk: {summary}");
    }

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
