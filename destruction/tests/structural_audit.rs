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
//! ## Why it runs to a verdict rather than for a fixed time
//!
//! Every earlier version watched for a fixed window and reported what it saw,
//! which makes the answer a statement about the observer rather than the
//! building. It also gets the answer WRONG, repeatedly and in the flattering
//! direction: 432 Park broke 5 bonds in its first 45 seconds and 14,561 in the
//! next 45, so every check at 10, 20 and 45 seconds called a delayed collapse
//! stable. "Sound, as far as I watched" is not a property anyone wants.
//!
//! So the audit now runs until the structure settles the question itself. It
//! is converged when nothing has broken AND the peak has held still for a
//! sustained stretch; it is failing while either is still moving. If neither
//! resolves inside the cap it says so, which is a real answer too -- a
//! structure still arguing with gravity after five minutes is not stable.
//!
//! AUDIT_PACKS=name,name limits it; AUDIT_MAX_SECS caps the run (default 300).
#![cfg(feature = "physx")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use vibe_land_destruction::city_config::ShotProfile;
use vibe_land_destruction::rig::{facade_aim, Rig, HZ};
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
/// coarse enough that a long audit is hundreds of solver reports, not thousands.
const SAMPLE_EVERY: u32 = HZ / 2;

/// Consecutive quiet samples before a structure is called converged: nothing
/// breaking and the peak holding still, for twenty samples -- ten seconds.
///
/// Ten and not two because settling is not monotone. Buildings here go quiet
/// for a few seconds mid-settle and then resume, and the walled city's last
/// bond broke at 73 s after eight seconds of silence. A short window would
/// have called that converged twice before it was.
const QUIET_SAMPLES: u32 = 20;

/// How still the peak has to be to count as quiet. Utilisation wanders by a
/// per cent or so on a settled structure, which is the solver re-converging
/// rather than the building moving.
const PEAK_STEADY: f32 = 0.02;

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

/// How the run ended. The point of the audit is to produce one of these
/// rather than a number of seconds someone has to interpret.
enum Outcome {
    /// Nothing broke and the peak held still, from this time onward.
    Converged { at: f32, broke_total: u32 },
    /// Still breaking, or the peak still moving, when the cap ran out.
    Unresolved { capped_at: f32, broke_total: u32, last_break_at: Option<f32> },
}

struct Audit {
    outcome: Outcome,
    /// Peak utilisation averaged over the first and last thirds of the run.
    /// Two numbers instead of one because the DIRECTION is the diagnosis.
    early_peak: f32,
    late_peak: f32,
    /// Bonds over limit, averaged over the last third: a stable count of real
    /// overloads rather than whatever the final frame happened to hold.
    late_over: f32,
    persistent: Vec<(String, BondHistory)>,
    class_load: Vec<(String, u32)>,
    shot_broke: u32,
    bonds: usize,
}

fn audit(name: &str, max_secs: f32) -> Audit {
    let pack = load(name);
    let mut rig = Rig::spin_up(&pack).expect("install");

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
        shot_broke: rig.broken_bonds().saturating_sub(before),
        bonds: pack.bonds.len(),
    }
}

#[test]
#[ignore = "audit: minutes of GPU across every building"]
fn audit_every_building() {
    let names: Vec<String> = std::env::var("AUDIT_PACKS")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| DEFAULT_PACKS.iter().map(|s| s.to_string()).collect());
    let max_secs: f32 = std::env::var("AUDIT_MAX_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300.0);

    let mut unresolved = Vec::new();
    for name in &names {
        let a = audit(name, max_secs);
        println!("\n=== {name} ({} bonds) ===", a.bonds);
        match &a.outcome {
            Outcome::Converged { at, broke_total } => {
                println!("  STABLE - converged at {at:.0} s after breaking {broke_total} bonds");
            }
            Outcome::Unresolved { capped_at, broke_total, last_break_at } => {
                unresolved.push(name.clone());
                match last_break_at {
                    Some(t) => println!(
                        "  NOT STABLE - still unsettled at the {capped_at:.0} s cap; \
                         {broke_total} bonds broken, most recently at {t:.0} s"
                    ),
                    None => println!(
                        "  NOT STABLE - nothing has broken, but the peak was still \
                         moving at the {capped_at:.0} s cap"
                    ),
                }
            }
        }
        println!(
            "  peak {:.2} -> {:.2} | {:.1} joints past yield near the end | test shot broke {}",
            a.early_peak, a.late_peak, a.late_over, a.shot_broke,
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

    if !unresolved.is_empty() {
        println!("\nnot stable: {}", unresolved.join(", "));
    }
}

/// Wall-clock cost of simulating a fixed slice of time, at whatever the
/// solver's iteration count is set to.
///
/// The question this answers is the only one that matters for shipping: a
/// 60 Hz tick has 16.7 ms, so a run that takes longer in wall clock than the
/// sim time it covers cannot be played. Reported as a real-time factor, where
/// 1.0 is exactly break-even and lower is headroom.
#[test]
#[ignore = "measurement"]
fn tick_cost() {
    let name = std::env::var("AUDIT_PACKS").unwrap_or_else(|_| "minas-tirith".into());
    let secs: f32 = std::env::var("COST_SECS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(10.0);
    let pack = load(&name);
    let mut rig = Rig::spin_up(&pack).expect("install");
    // Skip the spawn transient: measure a structure mid-settle, which is the
    // expensive regime and the one destruction puts a city back into.
    rig.run_ticks(HZ).expect("tick");

    let ticks = (secs * HZ as f32) as u32;
    let start = std::time::Instant::now();
    rig.run_ticks(ticks).expect("tick");
    let wall = start.elapsed().as_secs_f32();
    println!(
        "[cost] {name}: {:.1} s of sim in {:.2} s wall = {:.2}x real time, {:.2} ms/tick",
        secs, wall, secs / wall, wall * 1000.0 / ticks as f32
    );
}
