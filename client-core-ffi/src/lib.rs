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
use vibe_client_core::audio::{VlLoop, VlSound};
use vibe_client_core::effects::VlDust;
use vibe_client_core::geometry::VlMeshRange;
use vibe_client_core::grass::{VlGrassBlade, VlGrassExclusion};
use vibe_client_core::materials::{Catalog, VlChunkSurface, VlMaterial};
use vibe_client_core::frame::{VlAudioContact, VlBodyPose, VlCar, VlCarPart, VlChunk, VlChunkAssignment, VlDynamicBody, VlEvent, VlInput, VlLocal, VlMeteor, VlPlayer, VlStats};
use vibe_client_core::{ClientCore, Lane};
use vibe_client_transport_wt::{Inbound, Lane as WireLane, Transport, TransportConfig, TransportState};

/// Bumped whenever an exported signature or `#[repr(C)]` layout changes. The Unreal module
/// compares it with the header's `VL_ABI_VERSION` at startup and refuses to run on a mismatch.
pub const VL_ABI_VERSION: u32 = 18;

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
/// `VlPlayer::state_flags` (the server's player flags).
pub const VL_STATE_ON_GROUND: u32 = 1;
pub const VL_STATE_IN_VEHICLE: u32 = 2;
pub const VL_STATE_DEAD: u32 = 4;
pub const VL_STATE_MELEEING: u32 = 8;
pub const VL_STATE_SPAWN_PROTECTED: u32 = 16;
/// The eye above a player's reported position, metres.
pub const VL_EYE_HEIGHT_M: f32 = 0.8;
/// `VlInput::buttons`.
pub const VL_BTN_JUMP: u32 = 16;
pub const VL_BTN_CROUCH: u32 = 32;
pub const VL_BTN_SPRINT: u32 = 64;
pub const VL_BTN_RELOAD: u32 = 256;
/// `vl_client_fire` weapons.
pub const VL_WEAPON_RIFLE: u32 = 1;
pub const VL_WEAPON_CANNON: u32 = 3;
pub const VL_WEAPON_METEOR: u32 = 4;
/// `VlCar::flags`: the car's wheel states are present.
pub const VL_CAR_HAS_WHEELS: u32 = 1;
/// `VlDynamicBody::shape`.
pub const VL_SHAPE_BOX: u32 = 0;
pub const VL_SHAPE_SPHERE: u32 = 1;
const _: () = {
    use vibe_client_core::frame as f;
    assert!(VL_CAR_HAS_WHEELS == f::VL_CAR_HAS_WHEELS && VL_SHAPE_BOX == f::VL_SHAPE_BOX && VL_SHAPE_SPHERE == f::VL_SHAPE_SPHERE);
    assert!(VL_SHAPE_BOX == vibe_land_shared::constants::SHAPE_BOX as u32 && VL_SHAPE_SPHERE == vibe_land_shared::constants::SHAPE_SPHERE as u32);
};
/// `VlEvent::kind` (see client-core `frame.rs` for each kind's fields).
pub const VL_EVENT_SHOT_FIRED: u32 = 1;
pub const VL_EVENT_SHOT_RESULT: u32 = 2;
pub const VL_EVENT_DAMAGE: u32 = 3;
pub const VL_EVENT_LOCAL_SHOT: u32 = 4;
pub const VL_EVENT_VEHICLE_ASSET: u32 = 5;
pub const VL_EVENT_FRACTURE: u32 = 6;
/// `VlAudioContact::kind`.
pub const VL_CONTACT_IMPACT: u32 = 0;
pub const VL_CONTACT_SCRAPE: u32 = 1;
const _: () = {
    use vibe_client_core::frame as f;
    assert!(VL_EVENT_FRACTURE == f::VL_EVENT_FRACTURE && VL_CONTACT_IMPACT == f::VL_CONTACT_IMPACT && VL_CONTACT_SCRAPE == f::VL_CONTACT_SCRAPE);
};
/// `VlVehicleVertex::section`: the chassis (still), or a part the suspension rig poses
/// (`VlVehicleMeshView::posed`, `vl_vehicle_mesh_pose`).
pub const VL_VEHICLE_SECTION_CHASSIS: u32 = 0;
pub const VL_VEHICLE_SECTION_POSED: u32 = 1;
const _: () = {
    use vibe_client_core::vehicles as v;
    assert!(VL_EVENT_VEHICLE_ASSET == vibe_client_core::frame::VL_EVENT_VEHICLE_ASSET);
    assert!(VL_VEHICLE_SECTION_CHASSIS == v::VL_VEHICLE_SECTION_CHASSIS && VL_VEHICLE_SECTION_POSED == v::VL_VEHICLE_SECTION_POSED);
};
/// `VlMeshRange::flags`: the mesh is the chunk's convex hull (else its box).
pub const VL_MESH_HULL: u32 = 1;
/// `VlMaterial::flags`.
pub const VL_MATERIAL_DIRECTIONAL: u32 = 1;
pub const VL_MATERIAL_GLASS: u32 = 2;
pub const VL_MATERIAL_WALL: u32 = 4;
pub const VL_MATERIAL_FLOOR: u32 = 8;
/// The web draws city textures at `VlMaterial::metres_per_tile` × this (client-core materials.rs
/// `CITY_TEX_SCALE`); the core's tile UVs already include it.
pub const VL_CITY_TEX_SCALE: f32 = 2.0;
const _: () = {
    use vibe_client_core::{geometry as g, materials as m};
    assert!(VL_MESH_HULL == g::VL_MESH_HULL);
    assert!(VL_MATERIAL_DIRECTIONAL == m::VL_MATERIAL_DIRECTIONAL && VL_MATERIAL_GLASS == m::VL_MATERIAL_GLASS);
    assert!(VL_MATERIAL_WALL == m::VL_MATERIAL_WALL && VL_MATERIAL_FLOOR == m::VL_MATERIAL_FLOOR);
    assert!(VL_CITY_TEX_SCALE == m::CITY_TEX_SCALE);
};
const _: () = {
    use vibe_client_core::frame as f;
    assert!(VL_STATE_ON_GROUND == f::VL_STATE_ON_GROUND && VL_STATE_IN_VEHICLE == f::VL_STATE_IN_VEHICLE);
    assert!(VL_STATE_DEAD == f::VL_STATE_DEAD && VL_STATE_MELEEING == f::VL_STATE_MELEEING);
    assert!(VL_STATE_SPAWN_PROTECTED == f::VL_STATE_SPAWN_PROTECTED && VL_EYE_HEIGHT_M == f::VL_EYE_HEIGHT_M);
    assert!(VL_BTN_JUMP == f::VL_BTN_JUMP && VL_BTN_CROUCH == f::VL_BTN_CROUCH);
    assert!(VL_BTN_SPRINT == f::VL_BTN_SPRINT && VL_BTN_RELOAD == f::VL_BTN_RELOAD);
    assert!(VL_WEAPON_RIFLE == f::VL_WEAPON_RIFLE && VL_WEAPON_CANNON == f::VL_WEAPON_CANNON && VL_WEAPON_METEOR == f::VL_WEAPON_METEOR);
    assert!(VL_EVENT_SHOT_FIRED == f::VL_EVENT_SHOT_FIRED && VL_EVENT_SHOT_RESULT == f::VL_EVENT_SHOT_RESULT);
    assert!(VL_EVENT_DAMAGE == f::VL_EVENT_DAMAGE && VL_EVENT_LOCAL_SHOT == f::VL_EVENT_LOCAL_SHOT);
    // The buttons and flags are the server's own bits.
    use vibe_land_shared::constants as c;
    assert!(VL_BTN_JUMP == c::BTN_JUMP as u32 && VL_BTN_SPRINT == c::BTN_SPRINT as u32 && VL_BTN_CROUCH == c::BTN_CROUCH as u32);
    assert!(VL_BTN_RELOAD == c::BTN_RELOAD as u32 && VL_STATE_DEAD == c::FLAG_DEAD as u32 && VL_STATE_ON_GROUND == c::FLAG_ON_GROUND as u32);
    assert!(VL_WEAPON_RIFLE == c::WEAPON_HITSCAN as u32 && VL_WEAPON_CANNON == c::WEAPON_CANNONBALL as u32 && VL_WEAPON_METEOR == c::WEAPON_METEOR as u32);
    assert!(VL_EYE_HEIGHT_M == c::PLAYER_EYE_HEIGHT_M);
};
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
    pub local: VlLocal,
    pub remote_players: *const VlPlayer,
    pub remote_player_count: usize,
    pub assignments: *const VlChunkAssignment,
    pub assignment_count: usize,
    pub body_poses: *const VlBodyPose,
    pub body_pose_count: usize,
    /// Events since the previous poll (shots, verdicts, damage), in order.
    pub events: *const VlEvent,
    pub event_count: usize,
    /// Every car the city stream carries, on the car clock (the players' render time).
    pub cars: *const VlCar,
    pub car_count: usize,
    /// Free dynamic bodies (cannonballs, meteors) at the render time.
    pub dynamic_bodies: *const VlDynamicBody,
    pub dynamic_body_count: usize,
    /// Meteors launched since the previous poll.
    pub meteors: *const VlMeteor,
    pub meteor_count: usize,
    /// Audible contacts since the previous poll.
    pub audio_contacts: *const VlAudioContact,
    pub audio_contact_count: usize,
    /// Sounds to start now (client-core audio.rs, the web's policy): play clip `vl_audio_clip_id(clip)`
    /// at `position` with `gain` (distance falloff included: add none) and `rate`, after `delay_s`.
    pub sounds: *const VlSound,
    pub sound_count: usize,
    /// Dust puffs to raise now (client-core effects.rs).
    pub dust: *const VlDust,
    pub dust_count: usize,
    /// Every car part off its car, as drawn now (its authored geometry through `pos`/`quat`).
    pub car_parts: *const VlCarPart,
    pub car_part_count: usize,
    /// Continuous sounds playing now (scrapes, air rushing past fast bodies): keep one looping voice
    /// per `id` on clip `vl_audio_clip_id(clip)`, move it to `position` and set `gain` (falloff
    /// included) and `rate` each poll; fade it out when a poll no longer lists its `id`.
    pub loops: *const VlLoop,
    pub loop_count: usize,
    /// Every energy battery in the world now (renderer space).
    pub batteries: *const vibe_client_core::frame::VlBattery,
    pub battery_count: usize,
    pub stats: VlStats,
}

/// Chunk meshes as flat arrays (`vl_client_chunk_meshes`).
#[repr(C)]
pub struct VlMeshView {
    pub ranges: *const VlMeshRange,
    pub range_count: usize,
    pub positions: *const [f32; 3],
    pub normals: *const [f32; 3],
    /// xyz: unit direction of +u along the face; w: sign with `+v = w · (normal × tangent)`.
    pub tangents: *const [f32; 4],
    pub tile_uvs: *const [f32; 2],
    /// Catalog index per vertex.
    pub materials: *const u32,
    pub vertex_count: usize,
    pub indices: *const u32,
    pub index_count: usize,
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
            events: frame.events.as_ptr(),
            event_count: frame.events.len(),
            cars: frame.cars.as_ptr(),
            car_count: frame.cars.len(),
            dynamic_bodies: frame.dynamic_bodies.as_ptr(),
            dynamic_body_count: frame.dynamic_bodies.len(),
            meteors: frame.meteors.as_ptr(),
            meteor_count: frame.meteors.len(),
            audio_contacts: frame.audio_contacts.as_ptr(),
            audio_contact_count: frame.audio_contacts.len(),
            sounds: frame.sounds.as_ptr(),
            sound_count: frame.sounds.len(),
            dust: frame.dust.as_ptr(),
            dust_count: frame.dust.len(),
            car_parts: frame.car_parts.as_ptr(),
            car_part_count: frame.car_parts.len(),
            loops: frame.loops.as_ptr(),
            loop_count: frame.loops.len(),
            batteries: frame.batteries.as_ptr(),
            battery_count: frame.batteries.len(),
            stats: frame.stats,
        });
        VL_OK
    })
}

/// What the local player is doing (see `VlInput`): held until the next call; each poll turns the
/// time since the last into the server's 60 Hz input frames.
///
/// # Safety
/// `client` must be a live client; `input` must point to a `VlInput`.
#[no_mangle]
pub unsafe extern "C" fn vl_client_set_input(client: *mut VlClient, input: *const VlInput) -> i32 {
    let Some(input) = input.as_ref() else { return VL_ERR_ARG };
    guard(client, |c| {
        c.core.set_input(input);
        VL_OK
    })
}

/// Fire `weapon` (`VL_WEAPON_*`) along the view last given to `vl_client_set_input`. Writes the shot
/// id to `out_shot_id` (0 when nothing was fired: not playing yet, or inside the fire interval).
/// The shot is sent at the next poll and appears as a `VL_EVENT_LOCAL_SHOT`.
///
/// # Safety
/// `client` must be a live client; `out_shot_id` must be writable (or null).
#[no_mangle]
pub unsafe extern "C" fn vl_client_fire(client: *mut VlClient, weapon: u32, out_shot_id: *mut u32) -> i32 {
    guard(client, |c| {
        let now_us = c.transport.as_ref().map_or(0, |t| t.now_us());
        let shot = c.core.fire(weapon, now_us);
        if !out_shot_id.is_null() {
            out_shot_id.write(shot);
        }
        VL_OK
    })
}

/// Swing a melee attack along the view last given to `vl_client_set_input`. Writes the swing id to
/// `out_swing_id` (0 when nothing was sent: not playing, or inside the server's 900 ms cooldown).
///
/// # Safety
/// `client` must be a live client; `out_swing_id` must be writable (or null).
#[no_mangle]
pub unsafe extern "C" fn vl_client_melee(client: *mut VlClient, out_swing_id: *mut u32) -> i32 {
    guard(client, |c| {
        let now_us = c.transport.as_ref().map_or(0, |t| t.now_us());
        let swing = c.core.melee(now_us);
        if !out_swing_id.is_null() {
            out_swing_id.write(swing);
        }
        VL_OK
    })
}

/// Put the player at a pose in the client's space (leaving an aerial camera). Sent at the next poll.
///
/// # Safety
/// `client` must be a live client; `pos` must point to three floats.
#[no_mangle]
pub unsafe extern "C" fn vl_client_camera_drop(client: *mut VlClient, pos: *const f32, yaw: f32, pitch: f32) -> i32 {
    if pos.is_null() {
        return VL_ERR_ARG;
    }
    let p = [*pos, *pos.add(1), *pos.add(2)];
    guard(client, |c| {
        c.core.camera_drop(p, yaw, pitch);
        VL_OK
    })
}

/// Hand the core a car's `metadata.json` (the bytes fetched for `vl_vehicle_mesh_build`): its part
/// hulls rest the car's detached parts on the ground as the server does.
///
/// # Safety
/// `client` must be a live client; `metadata` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn vl_client_set_vehicle_metadata(client: *mut VlClient, handle: u32, metadata: *const u8, len: usize) -> i32 {
    if metadata.is_null() {
        return VL_ERR_ARG;
    }
    let bytes = std::slice::from_raw_parts(metadata, len);
    guard(client, |c| match c.core.set_vehicle_metadata(handle, bytes) {
        Ok(()) => VL_OK,
        Err(_) => VL_ERR_ARG,
    })
}

/// Ask to drive the car with `handle` (`VlCar::handle`).
///
/// # Safety
/// `client` must be a live client.
#[no_mangle]
pub unsafe extern "C" fn vl_client_enter_vehicle(client: *mut VlClient, handle: u32) -> i32 {
    guard(client, |c| {
        c.core.enter_vehicle(handle);
        VL_OK
    })
}

/// Leave the car this client entered.
///
/// # Safety
/// `client` must be a live client.
#[no_mangle]
pub unsafe extern "C" fn vl_client_exit_vehicle(client: *mut VlClient) -> i32 {
    guard(client, |c| {
        c.core.exit_vehicle();
        VL_OK
    })
}

/// Copy a car's asset into `buf` (NUL-terminated, truncated to `cap`): `what` 0 = its geometry hash
/// (fetch `<api>/vehicle-assets/<hash>/metadata.json`), 1 = its configuration as JSON. Returns the
/// full length (0 when the asset has not arrived).
///
/// # Safety
/// `client` must be a live client; `buf` must hold `cap` bytes (or be null with `cap` 0).
#[no_mangle]
pub unsafe extern "C" fn vl_client_vehicle_asset(client: *mut VlClient, handle: u32, what: u32, buf: *mut c_char, cap: usize) -> usize {
    let mut len = 0usize;
    guard(client, |c| {
        let text = match c.core.vehicle_asset(handle) {
            Some(asset) if what == 0 => asset.geometry_hash.clone(),
            Some(asset) => asset.configuration.to_string(),
            None => return VL_OK,
        };
        len = text.len();
        if !buf.is_null() && cap > 0 {
            let n = text.len().min(cap - 1);
            std::ptr::copy_nonoverlapping(text.as_ptr(), buf as *mut u8, n);
            *buf.add(n) = 0;
        }
        VL_OK
    });
    len
}

/// A car mesh built by `vl_vehicle_mesh_build`. Opaque to C.
pub struct VlVehicleMesh {
    mesh: vibe_client_core::vehicles::VehicleMesh,
}

/// A car mesh's arrays, valid until `vl_vehicle_mesh_destroy`.
#[repr(C)]
pub struct VlVehicleMeshView {
    /// Three per triangle, in the car's actor frame.
    pub vertices: *const vibe_client_core::vehicles::VlVehicleVertex,
    pub vertex_count: usize,
    /// Stream wheel i's hub: the pivot its sections spin and steer about.
    pub hubs: [[f32; 3]; 4],
    pub wheel_radius: f32,
    /// The actor frame is the source frame less this height: a `VlCarPart` transform applies to a
    /// vertex at `pos + origin_height * up`.
    pub origin_height: f32,
    /// The parts the suspension rig moves, with their rest frames; `vl_vehicle_mesh_pose` gives
    /// their frames now, in this order.
    pub posed: *const vibe_client_core::vehicles::VlPosedPart,
    pub posed_count: usize,
}

/// Build a car's mesh from its `metadata.json` bytes and (optionally, NUL-terminated JSON) its
/// configuration, in `space` (as `VlConfig::space`). Null on failure. Free with
/// `vl_vehicle_mesh_destroy`. Needs no client: any thread may build.
///
/// # Safety
/// `metadata` must hold `len` bytes; `configuration` must be null or a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn vl_vehicle_mesh_build(metadata: *const u8, len: usize, configuration: *const c_char, space: u32) -> *mut VlVehicleMesh {
    if metadata.is_null() {
        return std::ptr::null_mut();
    }
    let Some(space) = Space::from_u32(space) else { return std::ptr::null_mut() };
    let bytes = std::slice::from_raw_parts(metadata, len);
    let config = cstr(configuration).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    match catch_unwind(AssertUnwindSafe(|| vibe_client_core::vehicles::build_vehicle_mesh(bytes, config.as_ref(), space))) {
        Ok(Ok(mesh)) => Box::into_raw(Box::new(VlVehicleMesh { mesh })),
        _ => std::ptr::null_mut(),
    }
}

/// The arrays of a built car mesh.
///
/// # Safety
/// `mesh` must come from `vl_vehicle_mesh_build`; `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn vl_vehicle_mesh_view(mesh: *const VlVehicleMesh, out: *mut VlVehicleMeshView) -> i32 {
    let (Some(mesh), false) = (mesh.as_ref(), out.is_null()) else { return VL_ERR_ARG };
    out.write(VlVehicleMeshView {
        vertices: mesh.mesh.vertices.as_ptr(),
        vertex_count: mesh.mesh.vertices.len(),
        hubs: mesh.mesh.hubs,
        wheel_radius: mesh.mesh.wheel_radius,
        origin_height: mesh.mesh.origin_height,
        posed: mesh.mesh.posed.as_ptr(),
        posed_count: mesh.mesh.posed.len(),
    });
    VL_OK
}

/// The posed parts' frames for a car's four wheels as drawn (`VlCar::wheels`): the web's
/// suspension rig (wishbones solved for travel and steer, wheels spun). Writes up to `cap` poses,
/// in `VlVehicleMeshView::posed` order, and returns how many it wrote (negative on error).
///
/// # Safety
/// `mesh` must come from `vl_vehicle_mesh_build`; `wheels` must point to four wheels; `out` to `cap`.
#[no_mangle]
pub unsafe extern "C" fn vl_vehicle_mesh_pose(
    mesh: *const VlVehicleMesh,
    wheels: *const vibe_client_core::frame::VlWheel,
    out: *mut vibe_client_core::vehicles::VlPartPose,
    cap: usize,
) -> i32 {
    let (Some(mesh), false, false) = (mesh.as_ref(), wheels.is_null(), out.is_null()) else { return VL_ERR_ARG };
    let wheels: &[vibe_client_core::frame::VlWheel; 4] = &*(wheels as *const [vibe_client_core::frame::VlWheel; 4]);
    match catch_unwind(AssertUnwindSafe(|| mesh.mesh.pose(wheels))) {
        Ok(poses) => {
            let n = poses.len().min(cap);
            std::ptr::copy_nonoverlapping(poses.as_ptr(), out, n);
            n as i32
        }
        Err(_) => VL_ERR_PANIC,
    }
}

/// Free a car mesh.
///
/// # Safety
/// `mesh` must come from `vl_vehicle_mesh_build` (or be null) and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn vl_vehicle_mesh_destroy(mesh: *mut VlVehicleMesh) {
    if !mesh.is_null() {
        drop(Box::from_raw(mesh));
    }
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

/// Every chunk's mesh, as flat arrays (see client-core `geometry.rs`): `ranges[i]` locates chunk
/// `i`'s vertices and its indices (relative to the range's first vertex). Positions, normals and
/// tangents are in the chunk's frame (its structure's axes, origin at the chunk's centre), so a
/// standing chunk's vertex is at `rest_pos + rest_quat * v` and one on a body at
/// `body.pos + body.quat * (local_pos + v)`. `tile_uvs` are in tiles of the face's catalog
/// material (`materials`, per vertex). Fixed for the life of the client; valid until
/// `vl_client_destroy`. `VL_ERR_STATE` until the manifest has arrived.
///
/// # Safety
/// `client` must be a live client; `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn vl_client_chunk_meshes(client: *mut VlClient, out: *mut VlMeshView) -> i32 {
    if out.is_null() {
        return VL_ERR_ARG;
    }
    guard(client, |c| {
        let Some(m) = c.core.chunk_meshes() else { return VL_ERR_STATE };
        out.write(VlMeshView {
            ranges: m.ranges.as_ptr(),
            range_count: m.ranges.len(),
            positions: m.positions.as_ptr(),
            normals: m.normals.as_ptr(),
            tangents: m.tangents.as_ptr(),
            tile_uvs: m.tile_uvs.as_ptr(),
            materials: m.materials.as_ptr(),
            vertex_count: m.positions.len(),
            indices: m.indices.as_ptr(),
            index_count: m.indices.len(),
        });
        VL_OK
    })
}

/// Every chunk's catalog materials (wall, floor, authored tint), in chunk-table order. Valid until
/// `vl_client_destroy`; empty until the manifest has arrived.
///
/// # Safety
/// `client` must be a live client; `out_surfaces` and `out_count` must be writable.
#[no_mangle]
pub unsafe extern "C" fn vl_client_chunk_surfaces(
    client: *mut VlClient,
    out_surfaces: *mut *const VlChunkSurface,
    out_count: *mut usize,
) -> i32 {
    if out_surfaces.is_null() || out_count.is_null() {
        return VL_ERR_ARG;
    }
    guard(client, |c| {
        let s = c.core.chunk_surfaces();
        out_surfaces.write(s.as_ptr());
        out_count.write(s.len());
        VL_OK
    })
}

/// The material catalog (`shared/assets/materials/catalog.json`), indexed by the ids chunk meshes
/// and surfaces carry. Static for the life of the process.
///
/// # Safety
/// `out_materials` and `out_count` must be writable.
#[no_mangle]
pub unsafe extern "C" fn vl_catalog(out_materials: *mut *const VlMaterial, out_count: *mut usize) -> i32 {
    if out_materials.is_null() || out_count.is_null() {
        return VL_ERR_ARG;
    }
    match catch_unwind(|| Catalog::get().materials.as_slice()) {
        Ok(m) => {
            out_materials.write(m.as_ptr());
            out_count.write(m.len());
            VL_OK
        }
        Err(_) => VL_ERR_PANIC,
    }
}

/// What a shot along (origin, dir) in the renderer's space would hit among the other players drawn
/// in the last frame, as the server classifies hitscan, blocked by standing buildings: returns the
/// zone (0 none, 1 body, 2 head) and writes the player id to `player` (when not null). For the
/// crosshair's target highlight.
///
/// # Safety
/// `client` must be live; `origin` and `dir` point to three floats; `player` null or writable.
#[no_mangle]
pub unsafe extern "C" fn vl_client_aim_target(client: *const VlClient, origin: *const f32, dir: *const f32, player: *mut u32) -> u32 {
    let (Some(c), false, false) = (client.as_ref(), origin.is_null(), dir.is_null()) else { return 0 };
    let o = [*origin, *origin.add(1), *origin.add(2)];
    let d = [*dir, *dir.add(1), *dir.add(2)];
    let (zone, id) = catch_unwind(AssertUnwindSafe(|| c.core.aim_target(o, d))).unwrap_or((0, 0));
    if !player.is_null() {
        *player = id;
    }
    zone
}

/// Where sounds are heard from, in the renderer's space (a spectator's camera; without it the
/// local player's eye).
///
/// # Safety
/// `client` must be a live client.
#[no_mangle]
pub unsafe extern "C" fn vl_client_set_listener(client: *mut VlClient, x: f32, y: f32, z: f32) -> i32 {
    guard(client, |c| {
        c.core.set_listener([x, y, z]);
        VL_OK
    })
}

/// The sound mix: one of the web's presets (`VL_MIX_*`: cinematic, natural, clarity) at a dynamic
/// range (`VL_RANGE_*`: balanced, night, cinematic), as its sound settings set them.
///
/// # Safety
/// `client` must come from `vl_client_create`.
#[no_mangle]
pub unsafe extern "C" fn vl_client_set_mix(client: *mut VlClient, preset: u32, range: u32) -> i32 {
    guard(client, |c| {
        c.core.set_mix(vibe_client_core::audio::Mix::preset(preset, range));
        VL_OK
    })
}

/// `VlClient::set_mix`'s presets and ranges (client-core audio.rs).
pub const VL_MIX_CINEMATIC: u32 = 0;
pub const VL_MIX_NATURAL: u32 = 1;
pub const VL_MIX_CLARITY: u32 = 2;
pub const VL_RANGE_BALANCED: u32 = 0;
pub const VL_RANGE_NIGHT: u32 = 1;
pub const VL_RANGE_CINEMATIC: u32 = 2;
const _: () = {
    use vibe_client_core::audio as a;
    assert!(VL_MIX_CINEMATIC == a::VL_MIX_CINEMATIC && VL_MIX_NATURAL == a::VL_MIX_NATURAL && VL_MIX_CLARITY == a::VL_MIX_CLARITY);
    assert!(VL_RANGE_BALANCED == a::VL_RANGE_BALANCED && VL_RANGE_NIGHT == a::VL_RANGE_NIGHT && VL_RANGE_CINEMATIC == a::VL_RANGE_CINEMATIC);
};

/// An audio clip's id (the web's catalog name, e.g. "concrete-impact-2"), NUL-terminated; null
/// past the end. Static. `VlSound::clip` indexes these.
#[no_mangle]
pub extern "C" fn vl_audio_clip_id(index: u32) -> *const c_char {
    static IDS: std::sync::OnceLock<Vec<std::ffi::CString>> = std::sync::OnceLock::new();
    let ids = IDS.get_or_init(|| {
        vibe_client_core::audio::Clips::get().ids.iter().map(|id| std::ffi::CString::new(id.as_str()).unwrap_or_default()).collect()
    });
    ids.get(index as usize).map_or(std::ptr::null(), |id| id.as_ptr())
}

/// A weather preset (client-core weather.rs, the web's weatherPresets.ts table): `VL_WEATHER_*`,
/// null past the end. Static.
#[no_mangle]
pub extern "C" fn vl_weather(index: u32) -> *const vibe_client_core::weather::VlWeather {
    vibe_client_core::weather::presets().get(index as usize).map_or(std::ptr::null(), |w| w as *const _)
}

/// A preset's index from the web's name (`clear`, `dust_storm`, `snow_storm`), or -1.
///
/// # Safety
/// `name` is null or a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn vl_weather_index(name: *const c_char) -> i32 {
    if name.is_null() {
        return -1;
    }
    let name = unsafe { std::ffi::CStr::from_ptr(name) };
    name.to_str().ok().and_then(vibe_client_core::weather::by_name).map_or(-1, |i| i as i32)
}

/// The web's fog density (FogExp2, per metre): opacity 0.55 at the server's area of interest.
#[no_mangle]
pub extern "C" fn vl_weather_fog_exp2_density() -> f32 {
    vibe_client_core::weather::default_fog_exp2_density()
}

/// fogSettings.ts wind (strength m/s toward compass degrees, 0° = server +z) as a server-space
/// velocity into `out[3]` (`vl_coords_pos_to_unreal` converts it). The web's default is
/// `vl_weather_wind(8, 45, out)`.
///
/// # Safety
/// `out` points to three floats.
#[no_mangle]
pub unsafe extern "C" fn vl_weather_wind(strength_mps: f32, direction_deg: f32, out: *mut f32) {
    if out.is_null() {
        return;
    }
    let w = vibe_client_core::weather::wind_vector(strength_mps, direction_deg);
    unsafe { std::ptr::copy_nonoverlapping(w.as_ptr(), out, 3) };
}

/// Where the meadow is bare (each building's original footprint plus a verge), in server space
/// (x, z metres), for `vl_grass_patch`. Valid until `vl_client_destroy`; empty until the manifest
/// has arrived.
///
/// # Safety
/// `client` must be a live client; `out_exclusions` and `out_count` must be writable.
#[no_mangle]
pub unsafe extern "C" fn vl_client_grass_exclusions(
    client: *mut VlClient,
    out_exclusions: *mut *const VlGrassExclusion,
    out_count: *mut usize,
) -> i32 {
    if out_exclusions.is_null() || out_count.is_null() {
        return VL_ERR_ARG;
    }
    guard(client, |c| {
        let e = c.core.grass_exclusions();
        out_exclusions.write(e.as_ptr());
        out_count.write(e.len());
        VL_OK
    })
}

/// A shared grass layout (the web's GrassPaint), immutable: read by `vl_grass_patch` from any
/// thread until `vl_grass_paint_free`.
pub struct VlGrassPaint(vibe_client_core::grass::GrassPaint);

/// Parse the server's `/match-stats/<match>/grass` response (`{revision, layout}`, validated as the
/// web validates it). Writes the revision (64 hex digits, NUL-terminated) to `revision` when
/// `revision_capacity` ≥ 65. Null when the response is invalid.
///
/// # Safety
/// `bytes` readable for `len`; `revision` null or writable for `revision_capacity` bytes.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_paint_parse(bytes: *const u8, len: usize, revision: *mut c_char, revision_capacity: usize) -> *mut VlGrassPaint {
    if bytes.is_null() {
        return std::ptr::null_mut();
    }
    let body = std::slice::from_raw_parts(bytes, len);
    catch_unwind(|| match vibe_client_core::grass::GrassPaint::from_snapshot_json(body) {
        Ok((rev, paint)) => {
            if !revision.is_null() && revision_capacity > rev.len() {
                std::ptr::copy_nonoverlapping(rev.as_ptr().cast::<c_char>(), revision, rev.len());
                *revision.add(rev.len()) = 0;
            }
            Box::into_raw(Box::new(VlGrassPaint(paint)))
        }
        Err(_) => std::ptr::null_mut(),
    })
    .unwrap_or(std::ptr::null_mut())
}

/// Painted tiles in a layout.
///
/// # Safety
/// `paint` null or from `vl_grass_paint_parse`.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_paint_tiles(paint: *const VlGrassPaint) -> usize {
    paint.as_ref().map_or(0, |p| p.0.tile_count())
}

/// The ground's cover at server (x, z) under `paint` (null: the default meadow), into `out[4]`: the
/// canopy colour that tints the grass photograph (linear RGB) and the dirt a thin meadow lays bare
/// (client-core grass.rs `ground_cover`; groundNodes.ts).
///
/// # Safety
/// `paint` null or live; `out` writable for four floats.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_ground_cover(paint: *const VlGrassPaint, x: f32, z: f32, out: *mut f32) {
    if out.is_null() {
        return;
    }
    let unpainted = vibe_client_core::grass::GrassPaint::default();
    let (canopy, dirt) = paint.as_ref().map_or(&unpainted, |p| &p.0).ground_cover(x, z);
    std::ptr::copy_nonoverlapping([canopy[0], canopy[1], canopy[2], dirt].as_ptr(), out, 4);
}

/// The web ground's macro noise (client-core ground.rs, cityTextures.ts `cityMacroNoise`): a
/// repeating 256 × 256 single-channel texture, row-major, into `out` (65536 bytes). Returns the
/// edge length, or 0 when `capacity` is too small.
///
/// # Safety
/// `out` writable for `capacity` bytes.
#[no_mangle]
pub unsafe extern "C" fn vl_ground_macro_noise(out: *mut u8, capacity: usize) -> u32 {
    let n = vibe_client_core::ground::MACRO_NOISE_SIZE;
    if out.is_null() || capacity < n * n {
        return 0;
    }
    static NOISE: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let noise = NOISE.get_or_init(vibe_client_core::ground::macro_noise);
    std::ptr::copy_nonoverlapping(noise.as_ptr(), out, noise.len());
    n as u32
}

/// The ground's tint at server (x, z) under `paint` (null: the default meadow): the web's canopy
/// colour over its grass photograph (client-core grass.rs `ground_tint`), linear RGB into `out[3]`.
///
/// # Safety
/// `paint` null or live; `out` writable for three floats.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_ground_tint(paint: *const VlGrassPaint, x: f32, z: f32, out: *mut f32) {
    if out.is_null() {
        return;
    }
    let unpainted = vibe_client_core::grass::GrassPaint::default();
    let tint = paint.as_ref().map_or(&unpainted, |p| &p.0).ground_tint(x, z);
    std::ptr::copy_nonoverlapping(tint.as_ptr(), out, 3);
}

/// The 32 m canopy chunks a layout paints (FoliageCanopy.ts enqueues every chunk a painted tile
/// touches, with a 1 m border), as (cx, cz) pairs into `out` (two ints each). Returns how many there
/// are; writes at most `capacity` pairs.
///
/// # Safety
/// `paint` null or live; `out` writable for `2 * capacity` ints.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_canopy_chunks(paint: *const VlGrassPaint, out: *mut i32, capacity: usize) -> usize {
    let Some(paint) = paint.as_ref() else { return 0 };
    let mut chunks = std::collections::BTreeSet::new();
    for (x, z) in paint.0.tiles() {
        let (min_x, min_z, max_x, max_z) = (x * 8 - 1, z * 8 - 1, x * 8 + 9, z * 8 + 9);
        for cz in (min_z.div_euclid(32)).max(-8)..=(max_z.div_euclid(32)).min(7) {
            for cx in (min_x.div_euclid(32)).max(-8)..=(max_x.div_euclid(32)).min(7) {
                chunks.insert((cx, cz));
            }
        }
    }
    if !out.is_null() {
        for (i, (cx, cz)) in chunks.iter().take(capacity).enumerate() {
            *out.add(2 * i) = *cx;
            *out.add(2 * i + 1) = *cz;
        }
    }
    chunks.len()
}

/// The canopy clumps of 32 m chunk (cx, cz) under `paint` (client-core grass.rs `canopy_clumps`,
/// FoliageCanopy.ts `build`), server space. Writes at most `capacity`; returns how many there are.
/// Touches no client: safe from any thread.
///
/// # Safety
/// `paint` null or live; `exclusions` readable for `exclusion_count`; `out` writable for `capacity`.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_canopy(
    paint: *const VlGrassPaint,
    exclusions: *const VlGrassExclusion,
    exclusion_count: usize,
    cx: i32,
    cz: i32,
    out: *mut vibe_client_core::grass::VlCanopyClump,
    capacity: usize,
) -> usize {
    let Some(paint) = paint.as_ref() else { return 0 };
    let ex = if exclusions.is_null() { &[][..] } else { std::slice::from_raw_parts(exclusions, exclusion_count) };
    catch_unwind(|| {
        let mut clumps = Vec::new();
        vibe_client_core::grass::canopy_clumps(&paint.0, cx, cz, ex, &mut clumps);
        if !out.is_null() {
            std::ptr::copy_nonoverlapping(clumps.as_ptr(), out, clumps.len().min(capacity));
        }
        clumps.len()
    })
    .unwrap_or(0)
}

/// # Safety
/// `paint` null or from `vl_grass_paint_parse`, not used after this (by any thread).
#[no_mangle]
pub unsafe extern "C" fn vl_grass_paint_free(paint: *mut VlGrassPaint) {
    if !paint.is_null() {
        drop(Box::from_raw(paint));
    }
}

/// The web's grass of 8 m patch (`px`, `pz`) at `density` grass blades per m² (150 at most; the
/// renderer's distance LOD draws a prefix) over `paint` (null: the default meadow), in server space
/// (client-core grass.rs). Writes at most `capacity` blades to `out` and returns how many the patch
/// has. Touches no client: safe from any thread.
///
/// # Safety
/// `exclusions` must be readable for `exclusion_count` records; `paint` null or live; `out`
/// writable for `capacity`.
#[no_mangle]
pub unsafe extern "C" fn vl_grass_patch(
    paint: *const VlGrassPaint,
    exclusions: *const VlGrassExclusion,
    exclusion_count: usize,
    px: i32,
    pz: i32,
    density: f32,
    out: *mut VlGrassBlade,
    capacity: usize,
) -> usize {
    let ex = if exclusions.is_null() { &[][..] } else { std::slice::from_raw_parts(exclusions, exclusion_count) };
    catch_unwind(|| {
        let mut blades = Vec::new();
        vibe_client_core::grass::generate_patch(px, pz, density, ex, paint.as_ref().map(|p| &p.0), &mut blades);
        if !out.is_null() {
            std::ptr::copy_nonoverlapping(blades.as_ptr(), out, blades.len().min(capacity));
        }
        blades.len()
    })
    .unwrap_or(0)
}

/// `VlSound::flags`: a sound the player must hear (a near threat).
pub const VL_SOUND_PROTECTED: u32 = 1;
const _: () = assert!(VL_SOUND_PROTECTED == vibe_client_core::audio::VL_SOUND_PROTECTED);
/// `VlLoop::flags`: a debris bed (the web's activity voices), beside the continuous loops.
pub const VL_LOOP_BED: u32 = 1;
const _: () = assert!(VL_LOOP_BED == vibe_client_core::audio::VL_LOOP_BED);

/// A catalog entry's stable id (e.g. "brick"), NUL-terminated; null past the end. Static.
#[no_mangle]
pub extern "C" fn vl_catalog_id(index: u32) -> *const c_char {
    static IDS: std::sync::OnceLock<Vec<std::ffi::CString>> = std::sync::OnceLock::new();
    let ids = IDS.get_or_init(|| {
        Catalog::get().ids.iter().map(|id| std::ffi::CString::new(id.as_str()).unwrap_or_default()).collect()
    });
    ids.get(index as usize).map_or(std::ptr::null(), |id| id.as_ptr())
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

#[cfg(test)]
mod catalog_tests {
    //! The catalog through the C ABI: every entry has an id, and ids and records agree with the
    //! catalog the core resolves chunk materials from.
    use std::ffi::CStr;

    use super::{vl_catalog, vl_catalog_id, VL_MATERIAL_GLASS, VL_OK};

    #[test]
    fn catalog_through_the_c_abi() {
        let mut materials = std::ptr::null();
        let mut count = 0usize;
        assert_eq!(unsafe { vl_catalog(&mut materials, &mut count) }, VL_OK);
        assert!(count >= 16);
        let records = unsafe { std::slice::from_raw_parts(materials, count) };
        let ids: Vec<String> = (0..count as u32)
            .map(|i| unsafe { CStr::from_ptr(vl_catalog_id(i)) }.to_str().unwrap().to_owned())
            .collect();
        assert!(vl_catalog_id(count as u32).is_null());
        assert_eq!(ids[0], "concrete-wall");
        assert_eq!(ids[4], "brick");
        let glass = ids.iter().position(|id| id == "glass").unwrap();
        assert_eq!(records[glass].flags & VL_MATERIAL_GLASS, VL_MATERIAL_GLASS);
        assert_eq!(records[glass].layer, -1);
        for (i, r) in records.iter().enumerate() {
            assert!(r.metres_per_tile > 0.0, "{}", ids[i]);
            if r.layer >= 0 {
                assert_eq!(r.layer, i as i32, "layer order");
            }
        }
    }
}
