//! Is this pack actually built from the sources on disk?
//!
//! Scene packs are authored in JavaScript in the sibling `blast-stress-solver`
//! checkout and emitted here as JSON. Nothing in the Rust build knows about
//! that step, so when `node build.mjs` fails, the previous pack stays exactly
//! where it was and every test downstream passes happily against it.
//!
//! That is not hypothetical. A material was added to the garage without
//! registering it in the fracture tables; the build threw, the pack was not
//! rewritten, and the stability suite reported a clean run on a structure that
//! did not contain the change. It was caught by noticing the build had printed
//! nothing -- which is to say, by luck.
//!
//! The check is mtime, not content hash, because the failure mode is precisely
//! "the pack was not rewritten": if any authoring source is newer than the
//! pack, the pack cannot contain it. No hashing, no new dependency, no false
//! negative for the case that actually bites.
//!
//! It is advisory when it cannot see the sources. A checkout without
//! `blast-stress-solver` beside it -- CI, a rented box, anyone running the
//! packs as data -- skips silently rather than failing on something it has no
//! way to verify.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Where the authoring sources live, if they are reachable from here.
///
/// `BLAST_STRUCTURES_DIR` wins; otherwise the sibling checkout at the path this
/// project has used throughout.
fn structures_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("BLAST_STRUCTURES_DIR") {
        let p = PathBuf::from(p);
        return p.is_dir().then_some(p);
    }
    let guess = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .join("blast-stress-solver/blast/blast-stress-solver/structures");
    guess.is_dir().then_some(guess)
}

/// Newest mtime among the sources that can affect THIS pack.
///
/// Not the whole directory. Every structure shares `lib/`, `build.mjs` and
/// `verify.mjs`, so those always count -- but editing `petronas.mjs` has no
/// bearing on `villa-savoye.json`, and a check that says otherwise trains
/// people to rebuild everything or, worse, to ignore it.
///
/// The pairing is by filename: `villa-savoye.json` <- `villa-savoye.mjs`. When
/// there is no such file the pack comes from a module that emits several --
/// `rigs.mjs` produces every `rig-*` pack -- and there is no way to tell which
/// from here, so it falls back to every top-level source. Conservative in the
/// case it cannot resolve, precise in the case it can.
fn newest_source(dir: &Path, pack_stem: &str) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    let mut consider = |p: &Path| {
        if p.extension().is_some_and(|e| e == "mjs") {
            if let Ok(t) = p.metadata().and_then(|m| m.modified()) {
                newest = Some(newest.map_or(t, |n: SystemTime| n.max(t)));
            }
        }
    };
    // The shared authoring surface, always.
    for entry in std::fs::read_dir(dir.join("lib")).ok()?.flatten() {
        consider(&entry.path());
    }
    consider(&dir.join("build.mjs"));
    consider(&dir.join("verify.mjs"));

    // The structure itself, if it can be named.
    let own = dir.join(format!("{pack_stem}.mjs"));
    if own.is_file() {
        consider(&own);
    } else {
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            consider(&entry.path());
        }
    }
    newest
}

/// Panic if `pack_path` is older than the authoring sources that produce it.
///
/// Call it from any harness that loads a pack from disk. The message names the
/// rebuild rather than describing the problem, because the problem is always
/// the same and the fix always is too.
pub fn assert_pack_fresh(pack_path: &Path) {
    let Some(dir) = structures_dir() else { return };
    let stem = pack_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let Some(src) = newest_source(&dir, &stem) else { return };
    let Ok(pack) = pack_path.metadata().and_then(|m| m.modified()) else { return };
    if src <= pack {
        return;
    }
    let name = pack_path.file_name().unwrap_or_default().to_string_lossy();
    panic!(
        "{name} is STALE: an authoring source in {} is newer than the pack.\n  \
         The pack on disk does not contain your change, and every number this \
         run produces describes the previous structure.\n  \
         Rebuild first, and check it succeeded:\n    \
         cd {} && node build.mjs --emit-vibe-land <vibe-land-2>\n  \
         (set BLAST_STRUCTURES_DIR to point this check elsewhere, or run where \
         the sources are absent to skip it)",
        dir.display(),
        dir.display(),
    );
}
