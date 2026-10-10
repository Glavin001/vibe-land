//! The per-player destruction netcode's shared core (city wire 4).
//!
//! Everything the server and the client must agree on lives here and is
//! compiled into both: the server links it natively, the browser through
//! WASM. That covers how bodies are derived from a fracture's outcome, how a
//! body is predicted between keyframes, and every packet's bytes.
//! docs/netcode-lab.md describes the approach and how it is measured against
//! the shared-world stream (wire v2).

pub mod client;
pub mod predict;
pub mod structure;
pub mod wire;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
