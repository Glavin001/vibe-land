//! Thin wrapper module that picks between the real NVIDIA Blast
//! stress solver backend and a no-op stub, depending on whether the
//! `destructibles` Cargo feature is enabled.
//!
//! - When `destructibles` is on (the PhysX clone at
//!   `third_party/physx/` is available and the wasi C++ toolchain is
//!   installed), the real backend in
//!   [`destructibles_real`](crate::destructibles_real) drives
//!   Rapier-linked destructible structures powered by Blast.
//! - When `destructibles` is off (e.g. Vercel preview builds), the
//!   stub backend in
//!   [`destructibles_stub`](crate::destructibles_stub) provides the
//!   same API but every call is a no-op.  The wasm module still
//!   exposes the JS destructibles bindings on `WasmSimWorld` — the
//!   client just sees an empty destructibles registry.
//!
//! The split exists because Cargo eagerly resolves path dependencies
//! during metadata resolution.  `vibe-land-shared` cannot rely on a
//! local PhysX checkout existing on every build environment, so the
//! real Blast dep is `optional = true` behind the `destructibles`
//! feature and the real backend module is gated accordingly.  See
//! `docs/BLAST_INTEGRATION.md` for the full story.

#![cfg(target_arch = "wasm32")]

#[cfg(feature = "destructibles")]
pub use crate::destructibles_real::*;

#[cfg(not(feature = "destructibles"))]
pub use crate::destructibles_stub::*;
