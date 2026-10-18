//! The game server as a library, so the native app can run a match in the
//! same process (`local_session`, used by sim-native). The server binary is
//! src/server_bin.rs.
//!
//! The server's code is still src/main.rs, included here whole: it stays one
//! file with its history, and work on it merges as before.

pub mod local_session;

include!("main.rs");
