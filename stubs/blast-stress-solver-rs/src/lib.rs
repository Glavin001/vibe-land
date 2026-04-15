//! Placeholder crate used when the real `blast-stress-solver` from
//! `Glavin001/PhysX` is not present on disk.
//!
//! See `docs/BLAST_INTEGRATION.md` in the vibe-land repo for the full
//! story — the short version is that Cargo eagerly resolves path
//! dependencies during metadata resolution even when the gating target
//! `cfg` or feature is disabled, so a valid `Cargo.toml` must exist at
//! `third_party/physx/blast/blast-stress-solver-rs/`.  Environments
//! that cannot run `scripts/setup-blast.sh` (e.g. Vercel preview
//! builds) drop this stub into that path via
//! `scripts/ensure-blast-stub.sh`.
//!
//! The stub exposes no symbols because the consumer
//! (`vibe-land-shared`) only references anything from this crate when
//! the `destructibles` feature is enabled — which in turn is only
//! enabled in environments where the real PhysX clone is available.
