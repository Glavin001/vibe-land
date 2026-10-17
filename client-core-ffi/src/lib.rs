//! C ABI over vibe-land's shared client core.
//!
//! The Unreal client links this crate as a static library. Every exported symbol is prefixed `vl_`
//! and declared in `include/vibe_client_core.h`, which cbindgen generates from this crate and the
//! frame types in `client-core` (`tests/header_current.rs` fails if the committed header is stale).
//!
//! A `VlClient` owns the native WebTransport adapter and the sans-IO core. Call everything from one
//! thread (the game thread): `vl_client_poll` moves packets between them, advances the core and
//! sends what it produced. Arrays a call hands back point into the client and stay valid until the
//! next `vl_client_poll` (frame arrays) or `vl_client_destroy` (the chunk table).
//!
//! Every function catches Rust panics: a panicking client is poisoned and every later call on it
//! returns `VL_ERR_POISONED`.

use std::ffi::{c_char, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};

use vibe_client_core::coords::Space;
use vibe_client_core::frame::{VlBodyPose, VlChunk, VlChunkAssignment, VlPlayer, VlStats};
use vibe_client_core::{ClientCore, Lane};
use vibe_client_transport_wt::{Inbound, Lane as WireLane, Transport, TransportConfig, TransportState};

/// Bumped whenever an exported signature or `#[repr(C)]` layout changes. The Unreal module
/// compares it with the header's `VL_ABI_VERSION` at startup and refuses to run on a mismatch.
pub const VL_ABI_VERSION: u32 = 2;

pub const VL_OK: i32 = 0;
/// A null or invalid argument.
pub const VL_ERR_ARG: i32 = -1;
/// The call is not valid in the client's current state (e.g. connecting twice).
pub const VL_ERR_STATE: i32 = -2;
/// Setup failed (see `vl_client_last_error`).
pub const VL_ERR_IO: i32 = -3;
/// The call panicked; the client is now poisoned.
pub const VL_ERR_PANIC: i32 = -4;
/// An earlier call panicked; destroy the client.
pub const VL_ERR_POISONED: i32 = -5;

// The frame's sentinels and flags, restated here because cbindgen exports constants from this crate
// only; the asserts keep them equal to client-core's at compile time.
/// `VlChunkAssignment::body` for a chunk standing in its structure (drawn at its rest pose).
pub const VL_BODY_STANDING: u32 = 0xFFFF_FFFF;
/// `VlChunkAssignment::body` for a chunk the physics removed (hide it).
pub const VL_BODY_REMOVED: u32 = 0xFFFF_FFFE;
/// `VlChunk::flags`: a support (anchoring) chunk.
pub const VL_CHUNK_SUPPORT: u32 = 1;
/// `VlChunk::flags`: a convex-hull chunk (its extents are the hull's bounds).
pub const VL_CHUNK_HULL: u32 = 2;
/// `VlBodyPose::flags`: the body has settled.
pub const VL_POSE_SETTLED: u32 = 1;
/// `VlPlayer::flags`: the record is valid.
pub const VL_PLAYER_VALID: u32 = 1;
const _: () = {
    use vibe_client_core::frame as f;
    assert!(VL_BODY_STANDING == f::VL_BODY_STANDING && VL_BODY_REMOVED == f::VL_BODY_REMOVED);
    assert!(VL_CHUNK_SUPPORT == f::VL_CHUNK_SUPPORT && VL_CHUNK_HULL == f::VL_CHUNK_HULL);
    assert!(VL_POSE_SETTLED == f::VL_POSE_SETTLED && VL_PLAYER_VALID == f::VL_PLAYER_VALID);
};

/// `VlFrameView::transport_state`.
pub const VL_TRANSPORT_IDLE: u32 = 0;
pub const VL_TRANSPORT_FETCHING_CONFIG: u32 = 1;
pub const VL_TRANSPORT_FETCHING_MANIFEST: u32 = 2;
pub const VL_TRANSPORT_CONNECTING: u32 = 3;
pub const VL_TRANSPORT_CONNECTED: u32 = 4;
pub const VL_TRANSPORT_CLOSED: u32 = 5;
pub const VL_TRANSPORT_FAILED: u32 = 6;

/// How a client is created.
#[repr(C)]
pub struct VlConfig {
    /// The server's HTTP origin, e.g. "http://127.0.0.1:4001" (NUL-terminated UTF-8).
    pub api_base_url: *const c_char,
    /// The match to join; the city must be a wire 4 match ("citypp…").
    pub match_id: *const c_char,
    /// The space positions are written in: 0 server (Y up, metres), 1 Unreal (Z up, centimetres).
    pub space: u32,
}

/// One frame, as returned by `vl_client_poll`. Arrays are valid until the next poll. Assignments
/// and body poses hold only what changed since the previous poll.
#[repr(C)]
pub struct VlFrameView {
    pub transport_state: u32,
    pub local: VlPlayer,
    pub remote_players: *const VlPlayer,
    pub remote_player_count: usize,
    pub assignments: *const VlChunkAssignment,
    pub assignment_count: usize,
    pub body_poses: *const VlBodyPose,
    pub body_pose_count: usize,
    pub stats: VlStats,
}

/// A client: the native transport and the shared core. Opaque to C.
pub struct VlClient {
    config: TransportConfig,
    core: ClientCore,
    transport: Option<Transport>,
    transport_state: u32,
    last_error: String,
    poisoned: bool,
}

const BUILD_INFO: &str = concat!(
    "vibe-client-core ",
    env!("CARGO_PKG_VERSION"),
    " git=",
    env!("VL_GIT_SHA"),
    " target=",
    env!("VL_TARGET"),
    " profile=",
    env!("VL_PROFILE"),
    "\0"
);

/// The ABI version this library was built with.
#[no_mangle]
pub extern "C" fn vl_abi_version() -> u32 {
    VL_ABI_VERSION
}

/// A NUL-terminated, statically allocated description of this build: crate version, git commit,
/// target triple and profile. The pointer stays valid for the life of the process.
#[no_mangle]
pub extern "C" fn vl_build_info() -> *const c_char {
    BUILD_INFO.as_ptr().cast()
}

/// Create a client. Does no I/O; call `vl_client_connect`. Returns null on a bad config.
///
/// # Safety
/// `config` must be null or point to a valid `VlConfig` whose strings are NUL-terminated.
#[no_mangle]
pub unsafe extern "C" fn vl_client_create(config: *const VlConfig) -> *mut VlClient {
    let result = catch_unwind(|| {
        let config = config.as_ref()?;
        let api = cstr(config.api_base_url)?;
        let match_id = cstr(config.match_id)?;
        let space = Space::from_u32(config.space)?;
        Some(Box::into_raw(Box::new(VlClient {
            config: TransportConfig::new(api, match_id),
            core: ClientCore::new(space),
            transport: None,
            transport_state: VL_TRANSPORT_IDLE,
            last_error: String::new(),
            poisoned: false,
        })))
    });
    result.ok().flatten().unwrap_or(std::ptr::null_mut())
}

/// Start connecting in the background: session config, city manifest, WebTransport, hello.
///
/// # Safety
/// `client` must be null or a pointer from `vl_client_create` not yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn vl_client_connect(client: *mut VlClient) -> i32 {
    guard(client, |c| {
        if c.transport.is_some() {
            return VL_ERR_STATE;
        }
        match Transport::start(c.config.clone()) {
            Ok(transport) => {
                c.transport = Some(transport);
                c.transport_state = VL_TRANSPORT_FETCHING_CONFIG;
                VL_OK
            }
            Err(e) => {
                c.last_error = format!("could not start the network runtime: {e}");
                VL_ERR_IO
            }
        }
    })
}

/// Move packets, advance the core to now and fill `out` with this frame.
///
/// # Safety
/// `client` must be a live client; `out` must point to writable memory for one `VlFrameView`.
#[no_mangle]
pub unsafe extern "C" fn vl_client_poll(client: *mut VlClient, out: *mut VlFrameView) -> i32 {
    if out.is_null() {
        return VL_ERR_ARG;
    }
    guard(client, |c| {
        let now_us = match c.transport.as_ref() {
            Some(transport) => {
                while let Some(event) = transport.try_recv() {
                    match event {
                        Inbound::State(state) => {
                            c.transport_state = match &state {
                                TransportState::FetchingConfig => VL_TRANSPORT_FETCHING_CONFIG,
                                TransportState::FetchingManifest => VL_TRANSPORT_FETCHING_MANIFEST,
                                TransportState::Connecting => VL_TRANSPORT_CONNECTING,
                                TransportState::Connected => VL_TRANSPORT_CONNECTED,
                                TransportState::Closed(reason) => {
                                    c.last_error = format!("session closed: {reason}");
                                    VL_TRANSPORT_CLOSED
                                }
                                TransportState::Failed(reason) => {
                                    c.last_error = reason.clone();
                                    VL_TRANSPORT_FAILED
                                }
                            };
                        }
                        Inbound::SessionConfig(config) => c.core.on_session_config(config),
                        Inbound::Manifest(bytes) => c.core.on_manifest(&bytes),
                        Inbound::Packet { lane, bytes, arrival_us } => {
                            let lane = if lane == WireLane::Reliable { Lane::Reliable } else { Lane::Datagram };
                            c.core.on_packet(lane, &bytes, arrival_us);
                        }
                    }
                }
                transport.now_us()
            }
            None => 0,
        };
        if let Some(error) = c.core.last_error() {
            if c.last_error.is_empty() {
                c.last_error = error.to_string();
            }
        }

        c.core.poll(now_us);
        let outgoing: Vec<_> = c.core.drain_outgoing().collect();
        if let Some(transport) = c.transport.as_ref() {
            for packet in outgoing {
                if packet.datagram {
                    transport.send_datagram(&packet.bytes);
                } else {
                    transport.send_reliable(&packet.bytes);
                }
            }
        }

        let frame = c.core.frame();
        out.write(VlFrameView {
            transport_state: c.transport_state,
            local: frame.local,
            remote_players: frame.remote_players.as_ptr(),
            remote_player_count: frame.remote_players.len(),
            assignments: frame.assignments.as_ptr(),
            assignment_count: frame.assignments.len(),
            body_poses: frame.body_poses.as_ptr(),
            body_pose_count: frame.body_poses.len(),
            stats: frame.stats,
        });
        VL_OK
    })
}

/// The city's chunk table: empty until the manifest has arrived (`VlStats::chunks` > 0), then
/// fixed for the life of the client. The pointer stays valid until `vl_client_destroy`.
///
/// # Safety
/// `client` must be a live client; `out_chunks` and `out_count` must be writable.
#[no_mangle]
pub unsafe extern "C" fn vl_client_chunks(client: *mut VlClient, out_chunks: *mut *const VlChunk, out_count: *mut usize) -> i32 {
    if out_chunks.is_null() || out_count.is_null() {
        return VL_ERR_ARG;
    }
    guard(client, |c| {
        let chunks = c.core.chunks();
        out_chunks.write(chunks.as_ptr());
        out_count.write(chunks.len());
        VL_OK
    })
}

/// Copy the last error (UTF-8, NUL-terminated, truncated to `capacity`) into `buffer`. Returns the
/// full length in bytes, excluding the NUL; 0 when there is none.
///
/// # Safety
/// `client` must be a live client; `buffer` must be null or writable for `capacity` bytes.
#[no_mangle]
pub unsafe extern "C" fn vl_client_last_error(client: *mut VlClient, buffer: *mut c_char, capacity: usize) -> usize {
    let Some(c) = client.as_ref() else { return 0 };
    let message = c.last_error.as_bytes();
    if !buffer.is_null() && capacity > 0 {
        let n = message.len().min(capacity - 1);
        std::ptr::copy_nonoverlapping(message.as_ptr(), buffer.cast::<u8>(), n);
        buffer.add(n).write(0);
    }
    message.len()
}

/// Close the session and free the client. Joins the network runtime (at most half a second).
///
/// # Safety
/// `client` must be null or a pointer from `vl_client_create`, not used again afterwards.
#[no_mangle]
pub unsafe extern "C" fn vl_client_destroy(client: *mut VlClient) {
    if client.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(client))));
}

/// Server metres to the Unreal space, exported so the plugin's tests check the same conversion.
#[no_mangle]
pub extern "C" fn vl_coords_pos_to_unreal(x: f32, y: f32, z: f32, out: *mut f32) {
    if out.is_null() {
        return;
    }
    let p = Space::Unreal.pos(glam::Vec3::new(x, y, z));
    unsafe { std::ptr::copy_nonoverlapping(p.as_ptr(), out, 3) };
}

/// A server rotation (x, y, z, w) in the Unreal space, as (x, y, z, w).
#[no_mangle]
pub extern "C" fn vl_coords_quat_to_unreal(x: f32, y: f32, z: f32, w: f32, out: *mut f32) {
    if out.is_null() {
        return;
    }
    let q = Space::Unreal.quat(glam::Quat::from_xyzw(x, y, z, w));
    unsafe { std::ptr::copy_nonoverlapping(q.as_ptr(), out, 4) };
}

/// Run `f` on a live, unpoisoned client, catching panics.
unsafe fn guard(client: *mut VlClient, f: impl FnOnce(&mut VlClient) -> i32) -> i32 {
    let Some(c) = client.as_mut() else { return VL_ERR_ARG };
    if c.poisoned {
        return VL_ERR_POISONED;
    }
    match catch_unwind(AssertUnwindSafe(|| f(&mut *c))) {
        Ok(status) => status,
        Err(panic) => {
            c.poisoned = true;
            c.last_error = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .map_or_else(|| "panic in the client core".to_string(), |m| format!("panic in the client core: {m}"));
            VL_ERR_PANIC
        }
    }
}

unsafe fn cstr(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn build_info_is_a_valid_c_string_naming_the_target() {
        let info = unsafe { CStr::from_ptr(vl_build_info()) }.to_str().unwrap();
        assert!(info.starts_with("vibe-client-core "), "{info}");
        assert!(info.contains(env!("VL_TARGET")), "{info}");
    }

    #[test]
    fn null_and_bad_configs_are_refused_not_crashed() {
        unsafe {
            assert!(vl_client_create(std::ptr::null()).is_null());
            let api = CString::new("http://127.0.0.1:1").unwrap();
            let bad = VlConfig { api_base_url: api.as_ptr(), match_id: std::ptr::null(), space: 1 };
            assert!(vl_client_create(&bad).is_null());
            let m = CString::new("citypp-x").unwrap();
            let bad_space = VlConfig { api_base_url: api.as_ptr(), match_id: m.as_ptr(), space: 9 };
            assert!(vl_client_create(&bad_space).is_null());
            assert_eq!(vl_client_connect(std::ptr::null_mut()), VL_ERR_ARG);
            vl_client_destroy(std::ptr::null_mut());
        }
    }

    #[test]
    fn a_client_polls_before_and_after_connecting_and_reports_an_unreachable_server() {
        unsafe {
            let api = CString::new("http://127.0.0.1:9").unwrap(); // discard port: refused
            let m = CString::new("citypp-x").unwrap();
            let client = vl_client_create(&VlConfig { api_base_url: api.as_ptr(), match_id: m.as_ptr(), space: 1 });
            assert!(!client.is_null());
            let mut frame = std::mem::MaybeUninit::<VlFrameView>::uninit();
            assert_eq!(vl_client_poll(client, frame.as_mut_ptr()), VL_OK);
            assert_eq!(frame.assume_init_ref().transport_state, VL_TRANSPORT_IDLE);
            assert_eq!(vl_client_connect(client), VL_OK);
            assert_eq!(vl_client_connect(client), VL_ERR_STATE);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                assert_eq!(vl_client_poll(client, frame.as_mut_ptr()), VL_OK);
                if frame.assume_init_ref().transport_state == VL_TRANSPORT_FAILED || std::time::Instant::now() > deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(frame.assume_init_ref().transport_state, VL_TRANSPORT_FAILED);
            let mut buf = [0 as c_char; 256];
            assert!(vl_client_last_error(client, buf.as_mut_ptr(), buf.len()) > 0);
            let mut chunks = std::ptr::null();
            let mut count = 7usize;
            assert_eq!(vl_client_chunks(client, &mut chunks, &mut count), VL_OK);
            assert_eq!(count, 0);
            vl_client_destroy(client);
        }
    }

    #[test]
    fn coordinate_exports_match_the_core() {
        let mut p = [0f32; 3];
        vl_coords_pos_to_unreal(1.0, 2.0, 3.0, p.as_mut_ptr());
        assert_eq!(p, [300.0, -100.0, 200.0]);
    }
}
