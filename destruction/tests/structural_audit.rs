//! A repeatable structural audit for an authored building.
//!
//! The loop this exists to support: the solver can now tell us a structure
//! never reaches equilibrium, and the per-bond readout can tell us WHERE it is
//! straining. Between them, "this building is wrong" becomes "this joint
//! class, at this height, in this mode, is carrying more than it can" -- which
//! is something an author can act on.
//!
//! ## Why this samples over time rather than reading once
//!
//! The first version read one stress card at a fixed time and ranked the worst
//! joints in it. That works on a structure at rest and is worthless on one
//! that is failing, which is exactly the case worth diagnosing: the card is
//! then a snapshot of a moving system, and consecutive runs of the same pack
//! disagreed by nearly 2x (peak 1.23 then 2.15) purely on where in the
//! collapse the shutter happened to open. Ranking fixes off that is ranking
//! noise, and tuning to noise is a mistake this project has already made once.
//!
//! So the audit samples every half second and reports two things a snapshot
//! cannot:
//!
//!   - PERSISTENCE. A joint over its limit in one frame is noise; a joint over
//!     its limit in thirty consecutive frames is a defect. Hot joints are
//!     ranked by how much of the run they spent overloaded, not by who
//!     happened to be worst at the end.
//!   - TREND. Comparing the first third of the run to the last says whether a
//!     structure is converging on an answer, plateauing, or running away --
//!     the difference between "slow to settle" and "failing", which peak
//!     utilisation alone cannot distinguish.
//!
//! ## The four questions
//!
//!   1. Does it settle, and if not, which way is it going?
//!   2. What is persistently past its limit -- not what peaked once?
//!   3. Which joint CLASS owns the problem, weighted by time spent overloaded?
//!   4. Is it still destructible? A building that survives its own weight by
//!      being indestructible has traded one bug for a worse one.
//!
//!     cargo test -p vibe-land-destruction --features cuda-stress \
//!       --test structural_audit --release -- --ignored --nocapture
//!
//! AUDIT_PACKS=name,name limits it; AUDIT_SECS sets the window (default 20).
#![cfg(feature = "physx")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use vibe_land_destruction::city_config::ShotProfile;
use vibe_land_destruction::rig::{Rig, HZ};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

const DEFAULT_PACKS: &[&str] = &[
    "house-1story",
    "house-2story",
    "villa-savoye",
    "parking-garage",
    "algedra-tower",
    "park-432",
    "petronas",
];

/// Ticks between samples. Half a second: fine enough to see a runaway develop,
/// coarse enough that a 20 s audit is 40 solver reports rather than 1200.
const SAMPLE_EVERY: u32 = HZ / 2;

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

/// What one bond did across the whole run, rather than at one instant.
struct BondHistory {
    /// Samples in which this bond was over its elastic limit.
    hot_samples: u32,
    peak: f32,
    sum: f32,
    seen: u32,
    area: f32,
    height: f32,
    class: String,
    mode: String,
}

struct Audit {
    settled_at: Option<f32>,
    /// Peak utilisation averaged over the first and last thirds of the run.
    /// Two numbers instead of one because the DIRECTION is the diagnosis.
    early_peak: f32,
    late_peak: f32,
    /// Bonds over limit, averaged over the last third: a stable count of real
    /// overloads rather than whatever the final frame happened to hold.
    late_over: f32,
    broken_first_half: u32,
    broken_second_half: u32,
    persistent: Vec<(String, BondHistory)>,
    class_load: Vec<(String, u32)>,
    shot_broke: u32,
    bonds: usize,
}

fn audit(name: &str, secs: f32) -> Audit {
    let pack = load(name);
    let mut rig = Rig::spin_up(&pack).expect("install");

    let samples = (secs * HZ as f32 / SAMPLE_EVERY as f32) as u32;
    let mut history: HashMap<u32, BondHistory> = HashMap::new();
    let mut peaks: Vec<f32> = Vec::new();
    let mut overs: Vec<f32> = Vec::new();
    let mut broken_at_half = 0u32;
    let mut settled_at = None;
    let mut steady_run = 0u32;
    let mut last_peak = 0.0f32;

    for s in 0..samples {
        rig.run_ticks(SAMPLE_EVERY).expect("tick");
        let report = rig.stress_report();
        let peak = report.bonds.first().map(|b| b.utilisation).unwrap_or(0.0);
        peaks.push(peak);
        overs.push(report.over_limit() as f32);

        // Settled = peak utilisation within 1% for four consecutive samples
        // (2 s). Measured on sound buildings: the garage holds this from 1.2 s.
        if (peak - last_peak).abs() <= 0.01 * last_peak.max(1e-6) {
            steady_run += 1;
            if steady_run >= 4 && settled_at.is_none() {
                settled_at = Some((s + 1) as f32 * SAMPLE_EVERY as f32 / HZ as f32);
            }
        } else {
            steady_run = 0;
        }
        last_peak = peak;

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
        if s + 1 == samples / 2 {
            broken_at_half = rig.broken_bonds();
        }
    }

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
    let broken_second_half = before.saturating_sub(broken_at_half);
    let (center, direction) = facade_aim(&pack);
    rig.shot(center, direction, ShotProfile::city()).expect("shot");
    rig.run_ticks(HZ * 2).expect("tick");

    Audit {
        settled_at,
        early_peak,
        late_peak,
        late_over,
        broken_first_half: broken_at_half,
        broken_second_half,
        persistent: persistent.into_iter().take(6).collect(),
        class_load: class_load.into_iter().take(4).collect(),
        shot_broke: rig.broken_bonds().saturating_sub(before),
        bonds: pack.bonds.len(),
    }
}

/// A point on the outside at about a third of the height, aimed inward, chosen
/// so the blast actually lands on breakable material.
///
/// The obvious version -- take the outermost chunk in a height band -- picked
/// a FOUNDATION block for the walled city: fixed, unfracturable, and standing
/// alone with exactly ONE chunk inside the blast radius. The audit duly
/// reported that a rocket broke 7 bonds in a 170,000-bond city, and the
/// honest-looking conclusion from that was "this thing is nearly
/// indestructible". It was measuring a shot into an anchor.
///
/// So: skip supports and foundations, and among the outer candidates prefer
/// the one with the most material around it. A destructibility check is only
/// worth reading if the shot hits something destructible.
fn facade_aim(pack: &ScenePack) -> ([f32; 3], [f32; 3]) {
    const BLAST_R: f32 = 2.5;
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for node in &pack.nodes {
        let c = [node.centroid.x, node.centroid.y, node.centroid.z];
        for a in 0..3 {
            lo[a] = lo[a].min(c[a]);
            hi[a] = hi[a].max(c[a]);
        }
    }
    let band = lo[1] + (hi[1] - lo[1]) * 0.33;
    let span = (hi[1] - lo[1]).max(1e-3);

    let eligible: Vec<usize> = (0..pack.nodes.len())
        .filter(|&i| {
            let n = &pack.nodes[i];
            !n.is_support()
                && pack.node_role(i) != "foundation"
                && (n.centroid.y - band).abs() <= span * 0.08
        })
        .collect();
    if eligible.is_empty() {
        let c = pack.nodes[0].centroid;
        return ([c.x, c.y, c.z], [-1.0, 0.0, 0.0]);
    }

    // The outer tenth by x, then the best-surrounded of those: far enough out
    // to be a facade hit, dense enough to be a hit on the building.
    let mut outer = eligible.clone();
    outer.sort_by(|&a, &b| {
        pack.nodes[b].centroid.x.total_cmp(&pack.nodes[a].centroid.x)
    });
    outer.truncate((outer.len() / 10).max(1));

    let neighbours = |i: usize| {
        let c = pack.nodes[i].centroid;
        eligible
            .iter()
            .filter(|&&j| (pack.nodes[j].centroid - c).length_squared() < BLAST_R * BLAST_R)
            .count()
    };
    let best = outer
        .iter()
        .copied()
        .max_by_key(|&i| neighbours(i))
        .unwrap_or(outer[0]);
    let c = pack.nodes[best].centroid;
    ([c.x, c.y, c.z], [-1.0, 0.0, 0.0])
}

#[test]
#[ignore = "audit: minutes of GPU across every building"]
fn audit_every_building() {
    let names: Vec<String> = std::env::var("AUDIT_PACKS")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| DEFAULT_PACKS.iter().map(|s| s.to_string()).collect());
    let secs: f32 = std::env::var("AUDIT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20.0);

    for name in &names {
        let a = audit(name, secs);
        let trend = a.late_peak - a.early_peak;
        // The verdict reads the DIRECTION, which is what a snapshot cannot see.
        // A structure whose peak is falling is resolving itself even if it is
        // still above 1; one whose peak is climbing is running away even if it
        // is currently below.
        // Breakage is the ground truth and outranks the stress trend, because
        // a joint can ride above its elastic limit indefinitely without
        // accumulating damage if it only does so in peaks. Petronas showed
        // exactly that: peak climbing 0.98 -> 1.39 with two joints past yield
        // and ZERO bonds broken in thirty seconds. An earlier version of this
        // verdict called that "running away", which would have sent me to fix
        // a building that is not breaking.
        let broke = a.broken_first_half + a.broken_second_half;
        let verdict = if broke == 0 && a.late_over < 0.5 {
            "sound"
        } else if broke == 0 {
            "holding - joints ride above yield, but nothing is breaking"
        } else if a.broken_second_half > a.broken_first_half.saturating_mul(2).max(50) {
            "RUNNING AWAY - damage accelerating"
        } else if a.broken_second_half * 2 < a.broken_first_half {
            "SHEDDING - broke, then converged"
        } else if trend > 0.1 {
            "DEGRADING - breaking steadily, load still rising"
        } else {
            "DEGRADING - breaking steadily"
        };
        let settles = match a.settled_at {
            Some(t) => format!("{t:.1}s"),
            None => "never".into(),
        };

        println!("\n=== {name} ({} bonds, {secs:.0} s) ===", a.bonds);
        println!("  {verdict}");
        println!(
            "  settles {settles} | peak {:.2} -> {:.2} ({}{:.2}) | {:.1} joints past yield",
            a.early_peak,
            a.late_peak,
            if trend >= 0.0 { "+" } else { "" },
            trend,
            a.late_over,
        );
        println!(
            "  broken bonds: {} in the first half, {} in the second | test shot broke {}",
            a.broken_first_half, a.broken_second_half, a.shot_broke,
        );
        if !a.class_load.is_empty() {
            let classes: Vec<String> = a
                .class_load
                .iter()
                .map(|(c, n)| format!("{c} ({n})"))
                .collect();
            println!("  joint classes by time overloaded: {}", classes.join(", "));
        }
        for (id, h) in &a.persistent {
            println!(
                "    {id:>7} {:>3}% of run  mean {:.2} peak {:.2}  {} {}  y={:.0}m  {:.3} m2",
                h.hot_samples * 100 / h.seen.max(1),
                h.sum / h.seen as f32,
                h.peak,
                h.mode,
                h.class,
                h.height,
                h.area,
            );
        }
    }
}
