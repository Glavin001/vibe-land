//! Offline measurement of the destruction stream.
//!
//! The pieces here answer "did this scheduling change help, and by how much"
//! without a GPU and without the run-to-run noise of the physics sim.

pub mod cameras;
pub mod gates;
pub mod presented;
pub mod capture;
pub mod packets;
pub mod replay;
pub mod score;
pub mod tape;
