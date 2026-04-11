pub mod clock_sync;
pub mod lag_comp;
pub mod movement;
pub mod physics_arena;
/// Generic physics-enabled netcode library for vibe-land.
///
/// Provides reusable building blocks:
/// - `seq`           — 16-bit sequence number utilities (wraparound-safe ordering)
/// - `unit_conv`     — compact wire-format encoding helpers
/// - `movement`      — KCC movement math (MoveConfig, accelerate, friction)
/// - `sim_world`     — Rapier3D KCC collision world (SimWorld)
/// - `physics_arena` — dynamic rigid-body simulation (DynamicArena, DynamicBody)
/// - `lag_comp`      — server-side lag-compensated hitscan (LagCompHistory)
pub mod seq;
pub mod sim_world;
pub mod unit_conv;
