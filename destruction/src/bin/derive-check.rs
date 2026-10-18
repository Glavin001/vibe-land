//! Can a client derive every body from the broken bonds alone?
//!
//!   derive-check --capture <city capture dir> [--json <out>]
//!
//! Replays a capture's structural truth (every fracture batch on the encoder
//! tape, from the checkpoint's ledger) and after each batch derives the
//! structure's bodies the way a bonds-only client would -- flood fill over
//! intact bonds, a component with a support chunk is the standing structure,
//! every other component is one body named by its lowest chunk -- and
//! compares them with the islands the physics actually made
//! (`CityLedger::derive_check`). This is the check the per-player structural
//! channel stands on (docs/netcode-lab.md, decision D8): every disagreement
//! category is a case its wire must state explicitly.

use std::path::PathBuf;

use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::capture::{self, CaptureDir};
use vibe_land_destruction::netlab::tape::TapeReader;
use vibe_land_destruction::topology::{CityLedger, StructureDerivation};

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let dir = PathBuf::from(value("--capture").expect("--capture <city capture dir>"));
    let capture_dir = CaptureDir::open(&dir)?;
    let manifest: DestructionManifest = serde_json::from_slice(&std::fs::read(capture_dir.manifest_path())?)?;
    let checkpoint = capture::read_checkpoint(&dir)?;
    let mut ledger = checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.ledger().clone())
        .unwrap_or_else(|| CityLedger::from_manifest(&manifest));

    // The state at capture start, every structure.
    let mut at_start = StructureDerivation::default();
    for structure in &manifest.structures {
        at_start.add(&ledger.derive_check(&manifest, structure.structure_id));
    }

    let mut after_batches = StructureDerivation::default();
    let mut batches = 0u64;
    let mut batches_disagreeing = 0u64;
    let mut ticks = 0u64;
    let mut first_disagreement: Option<(u32, StructureDerivation)> = None;
    let mut reader = TapeReader::open(&capture_dir.tape_path())?;
    while let Some(entry) = reader.next_tick()? {
        ticks += 1;
        for batch in &entry.output.batches {
            ledger.apply_batch(batch);
            batches += 1;
            let check = ledger.derive_check(&manifest, batch.structure_id);
            if check.disagreements() > 0 {
                batches_disagreeing += 1;
                if first_disagreement.is_none() {
                    first_disagreement = Some((entry.tick, check.clone()));
                }
            }
            after_batches.add(&check);
        }
        for settle in &entry.output.settled {
            ledger.apply_settle(settle);
        }
        for &(structure, serial) in &entry.output.wakes {
            ledger.apply_wake(structure, serial);
        }
    }
    let mut at_end = StructureDerivation::default();
    for structure in &manifest.structures {
        at_end.add(&ledger.derive_check(&manifest, structure.structure_id));
    }
    let report = serde_json::json!({
        "capture": dir.display().to_string(),
        "backend": capture_dir.meta.backend,
        "ticks": ticks,
        "batches": batches,
        "batches_disagreeing": batches_disagreeing,
        "at_start": at_start,
        "after_each_batch": after_batches,
        "at_end": at_end,
        "first_disagreement": first_disagreement.map(|(tick, d)| serde_json::json!({"tick": tick, "check": d})),
    });
    let text = serde_json::to_string_pretty(&report)?;
    if let Some(path) = value("--json") {
        std::fs::write(path, &text)?;
    }
    println!("{text}");
    Ok(())
}
