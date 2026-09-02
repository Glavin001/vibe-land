//! Destructible mini-city: scene assembly, the shared manifest, and the
//! streaming-codec core.
//!
//! This crate stitches together the validated pieces from the sibling
//! research projects in /root/workspace:
//!
//! - Codec core (`quant`, `classify`, `scheduler`, `interest`, `packet`)
//!   ported from `destruction-codec` — offline-validated at 7.42 Mbps avg per
//!   client on a 6,119-body collapse with all visual gates passing at 1% loss.
//! - Scene assembly (`scene_pack`, `variants`, `city`) mirroring the
//!   blast-stress-solver mini-city demo (fractured-tower ScenePack, floor
//!   truncation variants, N×N grid).
//! - The shared `manifest` ledger and stable `ids` that server and clients
//!   agree on, plus the network-definitive `settle` policy.
//!
//! The default build is pure Rust and CI-safe. The `physx` feature adds the
//! native runtime that drives `ExtStressPhysXDestructible` via physx-bridge.

pub mod city;
pub mod city_config;
pub mod classify;
pub mod encoder;
pub mod fingerprint;
pub mod freeze;
pub mod ids;
pub mod interest;
pub mod manifest;
pub mod manifest_binary;
pub mod membership;
pub mod packet;
pub mod quant;
pub mod scene_pack;
pub mod scheduler;
pub mod settle;
pub mod synthetic;
pub mod topology;
pub mod types;
pub mod variants;
pub mod wire;

#[cfg(feature = "physx")]
#[cfg(feature = "blast-core")]
pub mod core_runtime;

// Gated, because runtime.rs is the PhysX-backed path and imports the bridge
// unconditionally. The merge inserted core_runtime above this and took the
// cfg with it, which only shows up in a build WITHOUT the feature -- i.e. the
// pure-Rust CI-safe one this gate exists to protect.
#[cfg(feature = "physx")]
pub mod runtime;

#[cfg(feature = "physx")]
pub mod rig;
