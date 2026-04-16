//! Re-exports from the NVIDIA Blast stress solver backend in
//! [`destructibles_real`](crate::destructibles_real).
//!
//! The `blast-stress-solver` crate is published on crates.io with
//! prebuilt wasm32 static libraries, so the real backend is always
//! available.  See `docs/BLAST_INTEGRATION.md` for details.

#![cfg(target_arch = "wasm32")]

pub use crate::destructibles_real::*;
