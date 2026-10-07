#![cfg(feature = "native-destruction")]

//! Textbook verification of the native GPU destruction stage.
//!
//! Chunked members joined by bonds, solved on the GPU stage at the shipping
//! solver settings, against closed-form structural mechanics. Every check
//! prints the textbook value, the exact answer of the stage's own discrete
//! model (f64, so the chunking's own error is visible), what the stage
//! computed, and the error. See docs/verification/README.md.
//!
//! One engine configuration per process (the bridge reads its flags once):
//!   (none)                    default
//!   VIBE_SECTION_BENDING=1    bending and torsion graded on each bond's section
//!   VIBE_SECTION_ROTATION=1   rotational stiffness from each bond's section too
//!
//! VIBE_GPU_SHARED=1 CARGO_TARGET_DIR=target/verify PHYSX_ROOT=... \
//!   cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test textbook -- --ignored --test-threads=1 --nocapture
//! or scripts/verify/correctness.sh quick|full.
//!
//! VERIFY_TIER=quick|full (default quick), VERIFY_CASES=a,b (substring
//! filter), VERIFY_OUT=path (JSON lines appended), VERIFY_DUMP=dir (write
//! each scenario's structure as JSON and exit).

mod build;
mod cases;
mod failure;
mod model;
mod stage;

use cases::{Check, Q, Tier, TOL};
use model::{Config, Graded};
use std::io::Write;

/// Known accuracy gaps: config, case, check, recorded error. A check that
/// misses the tolerance and is listed here is a KNOWN-GAP (it fails if it
/// gets worse than 1.25x its recorded error plus 0.5%); one that is listed
/// and now passes is reported FIXED, to be removed from the list.
const EXPECTED: &str = include_str!("expected.tsv");

pub struct Expectation {
    config: String,
    case: String,
    check: String,
    error: f64,
}

fn expectations() -> Vec<Expectation> {
    EXPECTED
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            assert!(f.len() >= 4, "expected.tsv: {l}");
            Expectation { config: f[0].into(), case: f[1].into(), check: f[2].into(), error: f[3].parse().expect("error") }
        })
        .collect()
}

pub struct Row {
    pub config: String,
    pub case: String,
    pub check: String,
    pub formula: String,
    pub source: String,
    pub unit: String,
    pub textbook: f64,
    pub model: f64,
    pub stage: f64,
    pub error: f64,
    pub solver_error: f64,
    pub tolerance: f64,
    pub status: String,
    pub ticks: u32,
    pub converged: bool,
    /// First tick the stage's stresses matched the model to 1e-3.
    pub accurate_at: Option<u32>,
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn json_num(x: f64) -> String {
    if x.is_finite() { format!("{x:e}") } else { "null".into() }
}

impl Row {
    fn json(&self) -> String {
        format!(
            "{{\"config\":{},\"case\":{},\"check\":{},\"formula\":{},\"source\":{},\"unit\":{},\"textbook\":{},\"model\":{},\"stage\":{},\"error\":{},\"solver_error\":{},\"tolerance\":{},\"status\":{},\"ticks\":{},\"converged\":{},\"accurate_at\":{}}}",
            json_str(&self.config), json_str(&self.case), json_str(&self.check), json_str(&self.formula), json_str(&self.source),
            json_str(&self.unit), json_num(self.textbook), json_num(self.model), json_num(self.stage), json_num(self.error),
            json_num(self.solver_error), json_num(self.tolerance), json_str(&self.status), self.ticks, self.converged,
            self.accurate_at.map(|t| t.to_string()).unwrap_or("null".into())
        )
    }
}

/// Classify one row against the tolerance and the expectations.
fn classify(row: &mut Row, expected: &[Expectation]) {
    let listed = expected.iter().find(|e| e.config == row.config && e.case == row.case && e.check == row.check);
    let pass = row.error.is_finite() && row.error <= row.tolerance;
    row.status = match (pass, listed) {
        (true, None) => "PASS".into(),
        (true, Some(_)) => "FIXED".into(),
        (false, Some(e)) if row.error <= 1.25 * e.error + 0.005 => "KNOWN-GAP".into(),
        (false, Some(_)) => "GAP-WORSE".into(),
        (false, None) => "FAIL".into(),
    };
}

fn value(q: Q, g: &Graded, area: f64) -> f64 {
    match q {
        Q::Axial => g.normal * area,
        Q::Shear => g.shear * area,
        Q::Bend => g.bend,
        Q::Tension => g.tension,
        Q::Compression => g.compression,
        Q::Twist { transverse } => g.shear - transverse / area,
    }
}

/// VERIFY_MODEL_ONLY=1: no GPU; the model stands in for the stage (to study
/// the discretisation alone).
fn model_only() -> bool {
    std::env::var("VERIFY_MODEL_ONLY").is_ok_and(|v| v == "1")
}

fn rel(a: f64, b: f64, scale: f64) -> f64 {
    (a - b).abs() / scale.max(1e-30)
}

fn wanted(name: &str, tier: Tier, want: Tier) -> bool {
    if let Ok(filter) = std::env::var("VERIFY_CASES") {
        if !filter.is_empty() {
            return filter.split(',').any(|f| name.contains(f.trim()));
        }
    }
    tier == Tier::Quick || want == Tier::Full
}

pub struct Output {
    rows: Vec<Row>,
    file: Option<std::fs::File>,
}

impl Output {
    pub fn push(&mut self, row: Row) {
        let d = |x: f64| if x.is_finite() { format!("{x:>12.4}") } else { format!("{:>12}", "-") };
        println!(
            "  {:<44} {:>4} {} {} {}  err {:>8} solver {:>8}  {:<10} {}",
            row.check,
            row.unit,
            d(row.textbook),
            d(row.model),
            d(row.stage),
            format!("{:.2}%", 100.0 * row.error),
            if row.solver_error.is_finite() { format!("{:.2}%", 100.0 * row.solver_error) } else { "-".into() },
            row.status,
            if row.ticks == 0 {
                String::new()
            } else {
                format!(
                    "(converged {}, accurate {})",
                    if row.converged { format!("tick {}", row.ticks) } else { format!("NO by tick {}", row.ticks) },
                    row.accurate_at.map(|t| format!("tick {t}")).unwrap_or("never".into())
                )
            }
        );
        if let Some(f) = &mut self.file {
            writeln!(f, "{}", row.json()).unwrap();
        }
        self.rows.push(row);
    }
}

fn run_statics(config: Config, want: Tier, expected: &[Expectation], out: &mut Output) {
    for case in cases::registry() {
        if !wanted(&case.name, case.tier, want) {
            continue;
        }
        println!("\n{} -- {}\n  {}", case.name, case.title, case.source);
        let model = model::model_graded(&case.structure, cases::G, config);
        let checked: Vec<(usize, Q, f64)> = case
            .checks
            .iter()
            .map(|c| (c.bond, c.q, value(c.q, &model[c.bond], model::section(&case.structure.bonds[c.bond]).area)))
            .collect();
        let accurate = |rows: &[Graded]| {
            checked.iter().all(|&(b, q, m)| {
                let area = model::section(&case.structure.bonds[b]).area;
                let scale = case.checks.iter().map(|c| c.scale).fold(0.0f64, f64::max).max(m.abs());
                rel(value(q, &rows[b], area), m, scale) <= 1e-3
            })
        };
        let solved = if model_only() {
            stage::Solved { rows: model.clone(), ticks: 0, converged: true, converged_at: 0, accurate_at: Some(0) }
        } else {
            stage::solve(&case.structure, 600, accurate)
        };
        let (stage, ticks, converged) = (&solved.rows, if solved.converged { solved.converged_at } else { solved.ticks }, solved.converged);
        for c in &case.checks {
            let Check { label, bond, q, textbook, formula, scale } = c;
            let area = model::section(&case.structure.bonds[*bond]).area;
            let m = value(*q, &model[*bond], area);
            let s = value(*q, &stage[*bond], area);
            let k = q.display();
            let mut row = Row {
                config: config.name.into(),
                case: case.name.clone(),
                check: label.clone(),
                formula: formula.clone(),
                source: case.source.into(),
                unit: q.unit().into(),
                textbook: textbook * k,
                model: m * k,
                stage: s * k,
                error: rel(s, *textbook, *scale),
                solver_error: rel(s, m, scale.max(m.abs())),
                tolerance: TOL,
                status: String::new(),
                ticks,
                converged,
                accurate_at: solved.accurate_at,
            };
            classify(&mut row, expected);
            out.push(row);
        }
    }
}

#[test]
#[ignore = "requires the native GPU destruction SDK"]
fn textbook_suite() {
    let config = Config::from_env();
    if let Ok(dir) = std::env::var("VERIFY_DUMP") {
        std::fs::create_dir_all(&dir).unwrap();
        for case in cases::registry() {
            std::fs::write(format!("{dir}/{}.json", case.name.replace('/', "_")), dump(&case.structure)).unwrap();
        }
        return;
    }
    let want = match std::env::var("VERIFY_TIER").as_deref() {
        Ok("full") => Tier::Full,
        _ => Tier::Quick,
    };
    let expected = expectations();
    let file = std::env::var("VERIFY_OUT").ok().map(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap());
    let mut out = Output { rows: Vec::new(), file };
    println!("configuration: {} (rotation {:?}, grading {:?})", config.name, config.rotation, config.grading);
    println!("  {:<44} {:>10} {:>12} {:>12} {:>12}", "check", "unit", "textbook", "model", "stage");
    run_statics(config, want, &expected, &mut out);
    failure::run(config, want, &expected, &mut out);
    let bad: Vec<&Row> = out.rows.iter().filter(|r| r.status == "FAIL" || r.status == "GAP-WORSE").collect();
    let fixed: Vec<&Row> = out.rows.iter().filter(|r| r.status == "FIXED").collect();
    println!(
        "\n{}: {} checks, {} pass, {} known gaps, {} fixed, {} failing",
        config.name,
        out.rows.len(),
        out.rows.iter().filter(|r| r.status == "PASS").count(),
        out.rows.iter().filter(|r| r.status == "KNOWN-GAP").count(),
        fixed.len(),
        bad.len()
    );
    for r in &fixed {
        println!("FIXED (remove from expected.tsv): {}\t{}\t{}", r.config, r.case, r.check);
    }
    for r in &bad {
        println!("{}\t{}\t{}\t{}\t{:.4}", r.status, r.config, r.case, r.check, r.error);
    }
    assert!(bad.is_empty(), "{} checks failed", bad.len());
}

fn dump(s: &model::Structure) -> String {
    let v = |a: model::V3| format!("[{},{},{}]", a[0], a[1], a[2]);
    let chunks: Vec<String> = s
        .chunks
        .iter()
        .map(|c| {
            format!(
                "{{\"name\":{},\"center\":{},\"half\":{},\"mass\":{},\"hull\":{}}}",
                json_str(&c.name),
                v(c.center),
                v(c.half),
                c.mass,
                c.hull.as_ref().map(|h| format!("[{}]", h.iter().map(|p| v(*p)).collect::<Vec<_>>().join(","))).unwrap_or("null".into())
            )
        })
        .collect();
    let bonds: Vec<String> = s
        .bonds
        .iter()
        .map(|b| {
            format!(
                "{{\"a\":{},\"b\":{},\"centroid\":{},\"normal\":{},\"area\":{},\"material\":{},\"patch\":[{}]}}",
                b.a,
                b.b,
                v(b.centroid),
                v(b.normal),
                model::section(b).area,
                b.material,
                b.patch.iter().map(|p| v(*p)).collect::<Vec<_>>().join(",")
            )
        })
        .collect();
    let mats: Vec<String> = s
        .materials
        .iter()
        .map(|m| format!("{{\"modulus\":{},\"compression\":{},\"tension\":{},\"shear\":{}}}", m.modulus, m.compression, m.tension, m.shear))
        .collect();
    format!(
        "{{\"rotation\":[{},{},{},{}],\"chunks\":[{}],\"bonds\":[{}],\"materials\":[{}]}}\n",
        s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3],
        chunks.join(","),
        bonds.join(","),
        mats.join(",")
    )
}
