//! One structure in, one line of JSON out.
//!
//! The stability suite answers "does this pass", which is the right question
//! once and the wrong one twelve times in a row. Tuning a member wants the
//! numbers themselves, in a form something else can tabulate -- and parsing
//! them back out of a panic message is how a harness starts lying to you.
//!
//!     cargo run -p vibe-land-destruction --features cuda-stress --release \
//!       --bin structure-audit -- parking-garage
//!
//! Exits non-zero only if the pack cannot be loaded. A structure that falls
//! over is a RESULT, not an error, and the caller decides what to make of it.

use std::path::{Path, PathBuf};

use vibe_land_destruction::rig::audit::{audit, hops_to_ground, Outcome};
use vibe_land_destruction::rig::freshness::assert_pack_fresh;
use vibe_land_destruction::scene_pack::load_scene_pack_file;

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let name = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: structure-audit <scene-name> [max-secs]");
        std::process::exit(2);
    });
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("assets/scenes/{name}.json"));
    assert_pack_fresh(&path);
    let pack = match load_scene_pack_file(&path) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("load {name}: {e:?}");
            std::process::exit(1);
        }
    };

    let hops = hops_to_ground(&pack);
    // The same budget the gate uses, so a sweep and the gate cannot disagree
    // about what "settled" means.
    let budget = 4.0 + hops as f32 * 0.5;
    let max_secs: f32 = std::env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(budget + 14.0);

    let r = audit(&pack, max_secs);
    let (settles, at, broke) = match r.outcome {
        Outcome::Converged { at, broke_total } => (true, at, broke_total),
        Outcome::Unresolved { broke_total, .. } => (false, -1.0, broke_total),
    };
    // "Passes" is settled AND intact, which is the gate's rule. A structure
    // that settles by shedding joints has not stood up, it has rearranged.
    let passes = settles && broke == 0 && at <= budget;

    let breaks: Vec<String> = r
        .breaks
        .iter()
        .take(5)
        .map(|b| {
            format!(
                "{{\"id\":{},\"at\":{:.1},\"mode\":\"{}\",\"class\":\"{}\",\"y\":{:.1},\"area\":{:.3},\"util\":{:.2}}}",
                b.id, b.at, esc(&b.mode), esc(&b.class), b.height, b.area, b.last_util
            )
        })
        .collect();
    let classes: Vec<String> = r
        .class_load
        .iter()
        .map(|(c, n)| format!("{{\"class\":\"{}\",\"hot\":{}}}", esc(c), n))
        .collect();

    println!(
        "{{\"name\":\"{}\",\"passes\":{},\"settles\":{},\"settled_at\":{:.1},\
         \"budget\":{:.1},\"broke\":{},\"early_peak\":{:.2},\"late_peak\":{:.2},\
         \"peak_sag\":{:.2},\"sag_role\":\"{}\",\"late_over\":{:.0},\"bonds\":{},\
         \"hops\":{},\"shot_broke\":{},\"breaks\":[{}],\"classes\":[{}]}}",
        esc(&name),
        passes,
        settles,
        at,
        budget,
        broke,
        r.early_peak,
        r.late_peak,
        r.peak_sag,
        esc(&r.sag_role),
        r.late_over,
        r.bonds,
        hops,
        r.shot_broke,
        breaks.join(","),
        classes.join(","),
    );
}
