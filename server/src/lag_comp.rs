// Re-export the generic lag compensation library from vibe-netcode.
// Game-specific usage (recording player positions, calling resolve_hitscan) lives in main.rs.
pub use vibe_netcode::lag_comp::{HistoricalCapsule, LagCompHistory};
