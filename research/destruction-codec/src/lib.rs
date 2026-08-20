//! Offline rate-distortion evaluator for TWTRACE1 rigid-body traces.
//!
//! The crate is a library so that simulations can write traces the codec reads without
//! duplicating the format: `trace::TraceWriter` is the producer side of the contract and
//! `trace::TraceReader` the consumer side. The `destruction-codec` binary is a CLI over the
//! same modules.

pub mod ack_baseline;
pub mod archive;
pub mod block_zstd;
pub mod budget;
pub mod census;
pub mod codec;
pub mod debris_codec;
pub mod debris_tracks;
pub mod evaluate;
pub mod exact_island;
pub mod hierarchy;
pub mod interest;
pub mod island;
pub mod live;
pub mod mask;
pub mod metrics;
pub mod presentation;
pub mod rans;
pub mod replay;
pub mod residual_coder;
pub mod root_coder;
pub mod scheduler;
pub mod symbol_audit;
pub mod synthetic;
pub mod trace;
