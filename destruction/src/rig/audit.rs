//! Auditing a structure: does it settle, and if not, what is wrong.
//!
//! This lives in the library rather than a test file because a test that
//! PRINTS a verdict is not a test. The previous arrangement selected
//! structures with an env var, asserted nothing, and was scraped by a shell
//! script grepping stdout -- so a building could regress to unstable without
//! failing anything. Selection, filtering, parallelism and reporting are
//! things a test runner already does well; the job here is to give it
//! something to assert on.
//!
//! ## What converged means
//!
//! Nothing has broken AND the peak has held still for ten consecutive
//! seconds. Either alone is not enough: a structure can stop breaking while
//! its load climbs toward the next failure, which is exactly what a delayed
//! collapse looks like from inside the lull.
//!
//! ## Why it samples over time
//!
//! One reading is a statement about when the shutter opened, not about the
//! building -- two consecutive runs of one pack once reported peak 1.23 and
//! 2.15. Hot joints are ranked by the share of the run they spend overloaded:
//! hot in one frame is noise, hot in thirty is a defect.

use std::collections::{HashMap, HashSet};

use crate::city_config::ShotProfile;
use crate::rig::{facade_aim, Rig, HZ};
use crate::scene_pack::ScenePack;

/// Ticks between samples. Half a second: fine enough to see a runaway develop,
/// coarse enough that a long audit is hundreds of solver reports, not thousands.
const SAMPLE_EVERY: u32 = HZ / 2;

/// Consecutive quiet samples before a structure is called converged: nothing
/// breaking and the peak holding still, for twenty samples -- ten seconds.
///
/// Ten and not two because settling is not monotone: the walled city's last
/// bond broke at 73 s after eight seconds of silence, and a short window would
/// have called that converged twice before it was.
const QUIET_SAMPLES: u32 = 20;

/// How still the peak has to be to count as quiet.
const PEAK_STEADY: f32 = 0.02;

/// What one bond did across the whole run, rather than at one instant.
pub struct BondHistory {
    /// Samples in which this bond was over its elastic limit.
    pub hot_samples: u32,
    pub peak: f32,
    pub sum: f32,
    pub seen: u32,
    pub area: f32,
    pub height: f32,
    pub class: String,
    pub mode: String,
}

/// One bond, at the moment it went.
///
/// The audit used to report only how MANY bonds broke, which is not actionable:
/// "sheds 3 bonds" sent a whole session guessing between a stair and a set of
/// beams, at ten minutes a guess. The most-overloaded joints are printed too,
/// but they are a different population -- a joint can sit at 2.4x all run and
/// never go, while the one that goes was fine until the load shifted onto it.
///
/// Recovered by diffing the live bond set between samples rather than through
/// new FFI: a broken bond stops appearing in the stress rows, and the last
/// history entry says what it was.
pub struct Break {
    pub id: u32,
    pub at: f32,
    pub class: String,
    pub mode: String,
    pub height: f32,
    pub area: f32,
    /// What it was carrying the last time it was seen intact.
    pub last_util: f32,
}

/// How the run ended. The point of the audit is to produce one of these
/// rather than a number of seconds someone has to interpret.
pub enum Outcome {
    /// Nothing broke and the peak held still, from this time onward.
    Converged { at: f32, broke_total: u32 },
    /// Still breaking, or the peak still moving, when the cap ran out.
    Unresolved { capped_at: f32, broke_total: u32, last_break_at: Option<f32> },
}

pub struct Audit {
    pub outcome: Outcome,
    /// Peak utilisation averaged over the first and last thirds of the run.
    /// Two numbers instead of one because the DIRECTION is the diagnosis.
    pub early_peak: f32,
    pub late_peak: f32,
    /// Bonds over limit, averaged over the last third: a stable count of real
    /// overloads rather than whatever the final frame happened to hold.
    pub late_over: f32,
    pub persistent: Vec<(String, BondHistory)>,
    pub class_load: Vec<(String, u32)>,
    /// The bonds that actually broke, earliest first.
    pub breaks: Vec<Break>,
    /// Furthest any chunk moved DOWN from where it was placed, and the role it
    /// belongs to.
    ///
    /// Stress and deflection are different failure criteria and this project
    /// only ever measured the first. A 1.1 m prestressed garage beam satisfies
    /// its bending check with margin and still cracks the deck above it,
    /// because it sags -- 116 broken bonds against 3, from a member that passes
    /// on paper. Serviceability is usually what governs a long span, and it was
    /// invisible here.
    pub peak_sag: f32,
    pub sag_role: String,
    pub shot_broke: u32,
    pub bonds: usize,
}

/// Run a structure until it settles the question, or until `max_secs`.
pub fn audit(pack: &ScenePack, max_secs: f32) -> Audit {
    let mut rig = Rig::spin_up(&pack).expect("install");
    let start_pos = rig.chunk_positions();

    let max_samples = (max_secs * HZ as f32 / SAMPLE_EVERY as f32) as u32;
    let at = |sample: u32| sample as f32 * SAMPLE_EVERY as f32 / HZ as f32;
    let mut history: HashMap<u32, BondHistory> = HashMap::new();
    let mut peaks: Vec<f32> = Vec::new();
    let mut overs: Vec<f32> = Vec::new();

    let mut quiet = 0u32;
    let mut last_peak = 0.0f32;
    let mut last_broken = 0u32;
    let mut last_break_at: Option<f32> = None;
    let mut outcome = None;
    let mut breaks: Vec<Break> = Vec::new();
    let mut live: HashSet<u32> = HashSet::new();
    let mut peak_sag = 0.0f32;
    let mut sag_role = String::new();

    for sample in 1..=max_samples {
        rig.run_ticks(SAMPLE_EVERY).expect("tick");
        let report = rig.stress_report();
        let peak = report.bonds.first().map(|b| b.utilisation).unwrap_or(0.0);
        let broken = rig.broken_bonds();
        peaks.push(peak);
        overs.push(report.over_limit() as f32);

        // Quiet means BOTH: nothing broke this sample, and the peak held
        // still. Either alone is not enough -- a structure can stop breaking
        // while its load is still climbing toward the next failure, which is
        // precisely how a delayed collapse looks from inside the lull.
        let broke_now = broken > last_broken;
        if broke_now {
            last_break_at = Some(at(sample));
        }

        // WHICH ones. A broken bond is not removed from the stress rows -- it
        // stays and reads exactly zero, because the solver stops carrying it --
        // so this is a load transition, not a disappearance: a bond that was
        // carrying something last sample and carries nothing now.
        //
        // Anchored to a sample where the broken COUNT actually rose, because
        // "went to zero" on its own also describes a bond that merely
        // unloaded. Between the two conditions this is heuristic, and can name
        // an unloaded neighbour alongside the real victim -- but it is the
        // difference between "3 bonds broke" and "3 bonds broke, tension,
        // stair-to-stair, at y=4 m", and only one of those is a place to look.
        let now: HashSet<u32> = report
            .bonds
            .iter()
            .filter(|b| b.utilisation > 0.0)
            .map(|b| b.bond_index)
            .collect();
        if broke_now && sample > 1 && breaks.len() < 64 {
            for id in live.difference(&now) {
                if let Some(h) = history.get(id) {
                    breaks.push(Break {
                        id: *id,
                        at: at(sample),
                        class: h.class.clone(),
                        mode: h.mode.clone(),
                        height: h.height,
                        area: h.area,
                        last_util: h.peak,
                    });
                }
            }
        }
        live = now;

        // Deflection, alongside stress. Downward only: a chunk rising is
        // debris, not a member sagging.
        for (i, p) in rig.chunk_positions().iter().enumerate() {
            let drop = start_pos.get(i).map(|s| s.y - p.y).unwrap_or(0.0);
            if drop > peak_sag {
                peak_sag = drop;
                sag_role = pack.node_role(i).to_string();
            }
        }
        let peak_steady = (peak - last_peak).abs() <= PEAK_STEADY * last_peak.max(1e-6);
        if !broke_now && peak_steady {
            quiet += 1;
        } else {
            quiet = 0;
        }
        last_peak = peak;
        last_broken = broken;

        for b in &report.bonds {
            let entry = history.entry(b.bond_index).or_insert_with(|| BondHistory {
                hot_samples: 0,
                peak: 0.0,
                sum: 0.0,
                seen: 0,
                area: b.area,
                height: b.position.y,
                class: format!(
                    "{}<->{}",
                    pack.node_role(b.node0 as usize),
                    pack.node_role(b.node1 as usize)
                ),
                mode: b.governing_mode().to_string(),
            });
            entry.seen += 1;
            entry.sum += b.utilisation;
            entry.peak = entry.peak.max(b.utilisation);
            if b.utilisation >= 1.0 {
                entry.hot_samples += 1;
                entry.mode = b.governing_mode().to_string();
            }
        }

        if quiet >= QUIET_SAMPLES {
            outcome = Some(Outcome::Converged {
                at: at(sample - QUIET_SAMPLES),
                broke_total: broken,
            });
            break;
        }
    }
    let outcome = outcome.unwrap_or(Outcome::Unresolved {
        capped_at: max_secs,
        broke_total: last_broken,
        last_break_at,
    });
    let samples = peaks.len() as u32;

    let third = (samples / 3).max(1) as usize;
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
    let early_peak = mean(&peaks[..third.min(peaks.len())]);
    let late_peak = mean(&peaks[peaks.len().saturating_sub(third)..]);
    let late_over = mean(&overs[overs.len().saturating_sub(third)..]);

    // Rank by time spent overloaded, then by how badly. A joint that is hot in
    // most samples is a property of the building; one hot in a couple is a
    // property of the moment the shutter opened.
    let mut persistent: Vec<(String, BondHistory)> = history
        .into_iter()
        .filter(|(_, h)| h.hot_samples > 0)
        .map(|(i, h)| (format!("#{i}"), h))
        .collect();
    persistent.sort_by(|a, b| {
        b.1.hot_samples
            .cmp(&a.1.hot_samples)
            .then((b.1.sum / b.1.seen as f32).total_cmp(&(a.1.sum / a.1.seen as f32)))
    });

    // Which joint class owns the problem, in bond-samples-over-limit: a class
    // with many joints slightly over outranks one joint spiking briefly.
    let mut by_class: HashMap<String, u32> = HashMap::new();
    for (_, h) in &persistent {
        *by_class.entry(h.class.clone()).or_default() += h.hot_samples;
    }
    let mut class_load: Vec<(String, u32)> = by_class.into_iter().collect();
    class_load.sort_by(|a, b| b.1.cmp(&a.1));

    let before = rig.broken_bonds();
    let (center, direction) = facade_aim(&pack);
    rig.shot(center, direction, ShotProfile::city()).expect("shot");
    rig.run_ticks(HZ * 2).expect("tick");

    Audit {
        outcome,
        early_peak,
        late_peak,
        late_over,
        persistent: persistent.into_iter().take(6).collect(),
        class_load: class_load.into_iter().take(4).collect(),
        breaks,
        peak_sag,
        sag_role,
        shot_broke: rig.broken_bonds().saturating_sub(before),
        bonds: pack.bonds.len(),
    }
}

/// Longest chain of bonds between an anchored chunk and the farthest chunk
/// from it: the load path, counted in joints.
///
/// This is what predicts how long a structure takes to settle, and it is not
/// chunk count. The parking garage has 3,350 chunks over 19 hops and settles
/// in four seconds; a 32-floor component stack has 2,240 over roughly seventy
/// and never does. Conjugate gradient moves information about one hop per
/// iteration, so depth is the thing a fixed iteration budget is spent against.
pub fn hops_to_ground(pack: &ScenePack) -> u32 {
    let n = pack.nodes.len();
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
    for b in &pack.bonds {
        adj[b.node0 as usize].push(b.node1);
        adj[b.node1 as usize].push(b.node0);
    }
    let mut dist = vec![u32::MAX; n];
    let mut queue = std::collections::VecDeque::new();
    for (i, node) in pack.nodes.iter().enumerate() {
        if node.is_support() {
            dist[i] = 0;
            queue.push_back(i as u32);
        }
    }
    let mut far = 0;
    while let Some(x) = queue.pop_front() {
        let d = dist[x as usize];
        far = far.max(d);
        for &y in &adj[x as usize] {
            if dist[y as usize] == u32::MAX {
                dist[y as usize] = d + 1;
                queue.push_back(y);
            }
        }
    }
    far
}
