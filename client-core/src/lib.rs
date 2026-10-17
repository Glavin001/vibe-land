//! vibe-land's client core: everything between the network and the renderer, with no I/O.
//!
//! Bytes in (session config, the city manifest, server packets with their arrival times), render-ready
//! scene state out ([`SceneFrame`]), plus the packets the client should send. The caller owns the
//! clock and the sockets: the Unreal client drives it through `client-core-ffi` with the native
//! WebTransport adapter (`client-transport-wt`); the web client will drive it through WASM with the
//! browser's WebTransport. Both get the same decoding, the same city stream and the same
//! interpolation.
//!
//! Times are microseconds on the caller's clock; packet arrival times and `now` must use the same one.

pub mod city;
pub mod coords;
pub mod frame;
pub mod geometry;
pub mod input;
pub mod materials;
pub mod players;
pub mod predictor;

use glam::Vec3;
use vibe_land_shared::constants::{
    FLAG_IN_VEHICLE, FLAG_ON_GROUND, PLAYER_EYE_HEIGHT_M, RIFLE_FIRE_INTERVAL_MS, WEAPON_CANNONBALL, WEAPON_HITSCAN,
    WEAPON_METEOR,
};
use vibe_land_shared::net_client::{decode_server_packet, encode_fire, encode_input_bundle, ServerMessage, SessionConfig};
use vibe_land_shared::protocol::FireCmd;

use crate::city::{decode_manifest, is_city_packet, CityStream, CITY_DELAY_TICKS};
use crate::coords::Space;
use crate::frame::{
    SceneFrame, VlChunk, VlCoreState, VlEvent, VlInput, VlLocal, VL_EVENT_DAMAGE, VL_EVENT_LOCAL_SHOT, VL_EVENT_SHOT_FIRED,
    VL_EVENT_SHOT_RESULT,
};
use crate::input::{InputBundler, InputState};
use crate::players::{player_record, Players};
use crate::predictor::ThinPredictor;

/// The server's clock for lag compensation: `server_tick × (1000 / SIM_HZ)` ms in integer
/// milliseconds per tick (`server/src/main.rs`, `server_time_ms`), so 16 ms at 60 Hz.
fn server_ms_per_tick(sim_hz: u16) -> u64 {
    1000 / u64::from(sim_hz.max(1))
}

/// Which lane a packet came on (the core treats them alike: the server moves oversized datagrams
/// onto the reliable stream, so every kind can arrive on either).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    Reliable,
    Datagram,
}

/// A packet the client should send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    /// Send as a datagram (else on the reliable stream).
    pub datagram: bool,
    pub bytes: Vec<u8>,
}

pub struct ClientCore {
    space: Space,
    config: Option<SessionConfig>,
    city: Option<CityStream>,
    meshes: Option<geometry::ChunkMeshes>,
    surfaces: Vec<materials::VlChunkSurface>,
    players: Option<Players>,
    frame: SceneFrame,
    outgoing: Vec<Outgoing>,
    state: VlCoreState,
    last_error: Option<String>,
    player_id: u32,
    protocol_decode_errors: u64,
    unknown_packets: u64,
    input: InputState,
    bundler: Option<InputBundler>,
    predictor: ThinPredictor,
    last_poll_us: Option<u64>,
    energy: f32,
    events: Vec<VlEvent>,
    next_shot_id: u32,
    last_fire_us: Option<u64>,
}

impl ClientCore {
    pub fn new(space: Space) -> Self {
        Self {
            space,
            config: None,
            city: None,
            meshes: None,
            surfaces: Vec::new(),
            players: None,
            frame: SceneFrame::default(),
            outgoing: Vec::new(),
            state: VlCoreState::WaitingForConfig,
            last_error: None,
            player_id: 0,
            protocol_decode_errors: 0,
            unknown_packets: 0,
            input: InputState::default(),
            bundler: None,
            predictor: ThinPredictor::default(),
            last_poll_us: None,
            energy: -1.0,
            events: Vec::new(),
            next_shot_id: 1,
            last_fire_us: None,
        }
    }

    pub fn state(&self) -> VlCoreState {
        self.state
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn session_config(&self) -> Option<&SessionConfig> {
        self.config.as_ref()
    }

    fn fail(&mut self, error: String) {
        self.state = VlCoreState::Failed;
        self.last_error = Some(error);
    }

    /// The match's session config (`/session-config`). Only wire 4 city matches are supported.
    pub fn on_session_config(&mut self, config: SessionConfig) {
        if config.city_world && config.city_wire() != 4 {
            self.fail(format!(
                "match {} streams the city on wire {}; this client speaks wire 4 only (use a citypp* match)",
                config.match_id,
                config.city_wire()
            ));
            return;
        }
        self.bundler = Some(InputBundler::new(u32::from(config.sim_hz)));
        let mut players = Players::new(u32::from(config.sim_hz), config.interpolation_delay_ms);
        players.set_snapshot_hz(config.snapshot_hz);
        self.players = Some(players);
        self.state = if config.city_world { VlCoreState::WaitingForManifest } else { VlCoreState::WaitingForWelcome };
        self.config = Some(config);
    }

    /// The uncompressed city manifest, checked against the session config's hash.
    pub fn on_manifest(&mut self, bytes: &[u8]) {
        let Some(config) = self.config.as_ref() else {
            self.fail("city manifest before session config".into());
            return;
        };
        match decode_manifest(bytes, config.city_manifest_hash.as_deref()) {
            Ok(manifest) => {
                self.city = Some(CityStream::new(&manifest, u32::from(config.sim_hz), self.space));
                let catalog = materials::Catalog::get();
                self.surfaces = materials::chunk_surfaces(&manifest, catalog);
                self.meshes = Some(geometry::ChunkMeshes::build_with_surfaces(
                    &manifest,
                    self.space,
                    Some((&self.surfaces, catalog)),
                ));
                if self.state == VlCoreState::WaitingForManifest {
                    self.state = VlCoreState::WaitingForWelcome;
                }
            }
            Err(error) => self.fail(error.to_string()),
        }
    }

    /// The city's chunk table (empty until the manifest arrives). Fixed for the session.
    pub fn chunks(&self) -> &[VlChunk] {
        self.city.as_ref().map_or(&[], |c| c.chunks())
    }

    /// Every chunk's mesh, in chunk-table order (`None` until the manifest arrives). Fixed for the
    /// session.
    pub fn chunk_meshes(&self) -> Option<&geometry::ChunkMeshes> {
        self.meshes.as_ref()
    }

    /// Every chunk's catalog materials, in chunk-table order (empty until the manifest arrives).
    pub fn chunk_surfaces(&self) -> &[materials::VlChunkSurface] {
        &self.surfaces
    }

    /// One server packet.
    pub fn on_packet(&mut self, _lane: Lane, bytes: &[u8], arrival_us: u64) {
        let Some(&kind) = bytes.first() else { return };
        let arrival_ms = arrival_us as f64 / 1000.0;
        if is_city_packet(kind) {
            if let Some(city) = self.city.as_mut() {
                city.ingest(bytes, arrival_ms);
            }
            return;
        }
        match decode_server_packet(bytes) {
            Ok(ServerMessage::Welcome(welcome)) => {
                self.player_id = welcome.player_id;
                if let Some(players) = self.players.as_mut() {
                    players.set_local_player(welcome.player_id);
                }
                if self.state != VlCoreState::Failed {
                    self.state = VlCoreState::Playing;
                }
            }
            Ok(ServerMessage::SnapshotV2(snapshot)) => {
                if let Some(players) = self.players.as_mut() {
                    players.on_snapshot(&snapshot, arrival_ms);
                }
            }
            Ok(ServerMessage::PlayerRoster(roster)) => {
                if let Some(players) = self.players.as_mut() {
                    players.on_roster(&roster);
                }
            }
            Ok(ServerMessage::ShotFired(s)) => {
                let mm = |x: i32, y: i32, z: i32| self.space.pos(Vec3::new(x as f32, y as f32, z as f32) / 1000.0);
                self.events.push(VlEvent {
                    kind: VL_EVENT_SHOT_FIRED,
                    player: s.shooter_player_id,
                    id: s.shot_id,
                    weapon: u32::from(s.weapon),
                    a: u32::from(s.hit_kind),
                    b: u32::from(s.hit_zone),
                    p0: mm(s.origin_px_mm, s.origin_py_mm, s.origin_pz_mm),
                    p1: mm(s.end_px_mm, s.end_py_mm, s.end_pz_mm),
                });
            }
            Ok(ServerMessage::ShotResult(s)) => self.events.push(VlEvent {
                kind: VL_EVENT_SHOT_RESULT,
                player: s.hit_player_id,
                id: s.shot_id,
                weapon: u32::from(s.weapon),
                a: u32::from(s.confirmed),
                b: u32::from(s.hit_zone),
                ..Default::default()
            }),
            Ok(ServerMessage::DamageEvent(d)) => self.events.push(VlEvent {
                kind: VL_EVENT_DAMAGE,
                player: d.attacker_player_id,
                a: u32::from(d.damage_amount),
                b: u32::from(d.hit_zone),
                p0: self.space.pos(Vec3::new(d.attacker_px_mm as f32, d.attacker_py_mm as f32, d.attacker_pz_mm as f32) / 1000.0),
                ..Default::default()
            }),
            Ok(ServerMessage::LocalPlayerEnergy(e)) => self.energy = e.energy_centi as f32 / 100.0,
            Ok(ServerMessage::DynamicBodyMeta(_)) => {}
            // Pings are echoed by the transport on its own thread.
            Ok(ServerMessage::Ping(_)) | Ok(ServerMessage::Pong(_)) => {}
            Ok(ServerMessage::Other { .. }) => self.unknown_packets += 1,
            Err(_) => self.protocol_decode_errors += 1,
        }
    }

    /// Advance to `now_us` and return this frame. Assignments and body poses hold only what changed
    /// since the previous poll; players are interpolated to the render time.
    pub fn poll(&mut self, now_us: u64) -> &SceneFrame {
        let now_ms = now_us as f64 / 1000.0;
        let dt_s = self.last_poll_us.map_or(0.0, |last| now_us.saturating_sub(last) as f64 / 1e6);
        self.last_poll_us = Some(now_us);
        self.frame.clear_changes();
        self.frame.events.append(&mut self.events);

        // Input: the 60 Hz frames due since the last poll, one bundle (as the web client sends).
        if self.state == VlCoreState::Playing {
            if let Some(bundler) = self.bundler.as_mut() {
                let frames = bundler.produce(dt_s, &self.input);
                if !frames.is_empty() {
                    self.outgoing.push(Outgoing { datagram: true, bytes: encode_input_bundle(&frames) });
                }
            }
        }

        let mut stats = crate::frame::VlStats {
            state: self.state as u32,
            player_id: self.player_id,
            city_wire: self.config.as_ref().map_or(0, |c| u32::from(c.city_wire())),
            city_render_tick: f32::NAN,
            player_render_tick: f32::NAN,
            unknown_packets: self.unknown_packets,
            ..Default::default()
        };
        if let Some(city) = self.city.as_mut() {
            if let Some(r) = city.advance(now_ms, &mut self.frame) {
                stats.city_render_tick = r;
            }
            if let Some(ack) = city.ack(now_ms) {
                self.outgoing.push(Outgoing { datagram: true, bytes: ack });
            }
            if let Some(resync) = city.resync(now_ms) {
                self.outgoing.push(Outgoing { datagram: true, bytes: resync });
            }
            city.write_stats(&mut stats);
        }
        // The city's decode errors (written above) plus the game protocol's.
        stats.decode_errors += self.protocol_decode_errors;
        if let Some(players) = self.players.as_mut() {
            if let Some((r, local)) = players.sample(now_ms, self.space, &mut self.frame.remote_players) {
                stats.player_render_tick = r;
                if let Some(s) = local {
                    let flags = u16::from(s.flags);
                    self.predictor.observe(s.vel, flags & FLAG_ON_GROUND != 0, flags & FLAG_IN_VEHICLE != 0, dt_s as f32);
                    let presented = self.predictor.update(s.pos, dt_s as f32, &self.input);
                    let player = player_record(players.local_player_id(), s, presented, self.space);
                    self.frame.local = VlLocal {
                        player,
                        eye: self.space.pos(presented + Vec3::Y * PLAYER_EYE_HEIGHT_M),
                        energy: self.energy,
                        ack_input_seq: u32::from(players.ack_input_seq),
                        next_input_seq: self.bundler.as_ref().map_or(0, |b| u32::from(b.next_seq())),
                        prediction_offset_m: self.predictor.offset().length(),
                    };
                }
            }
            stats.snapshots = players.snapshots;
            stats.newest_server_tick = players.newest_tick;
        }
        stats.remote_players = self.frame.remote_players.len() as u32;
        self.frame.stats = stats;
        &self.frame
    }

    /// What the player is doing, in the renderer's space (see [`VlInput`]). Held until changed; each
    /// poll turns the time since the last into the server's 60 Hz input frames.
    pub fn set_input(&mut self, input: &VlInput) {
        let (yaw, pitch) = self.space.yaw_pitch_to_server(input.yaw, input.pitch);
        self.input = InputState { move_x: input.move_x, move_y: input.move_y, yaw, pitch, buttons: input.buttons as u16 };
    }

    /// Fire `weapon` (`VL_WEAPON_*`) along the current view (the input's yaw and pitch). Returns the
    /// shot id, or 0 when not playing, the weapon is unknown, or the last shot was less than the
    /// fire interval ago (the server enforces it too). The shot also appears as a
    /// [`VL_EVENT_LOCAL_SHOT`] in the next frame.
    pub fn fire(&mut self, weapon: u32, now_us: u64) -> u32 {
        let weapon = match u8::try_from(weapon) {
            Ok(w) if w == WEAPON_HITSCAN || w == WEAPON_CANNONBALL || w == WEAPON_METEOR => w,
            _ => return 0,
        };
        if self.state != VlCoreState::Playing {
            return 0;
        }
        if self.last_fire_us.is_some_and(|last| now_us.saturating_sub(last) < u64::from(RIFLE_FIRE_INTERVAL_MS) * 1000) {
            return 0;
        }
        let (Some(config), Some(players), Some(bundler)) = (self.config.as_ref(), self.players.as_ref(), self.bundler.as_ref()) else {
            return 0;
        };
        let Some(server_tick) = players.server_tick_now() else { return 0 };
        self.last_fire_us = Some(now_us);
        let tick_ms = 1000.0 / f32::from(config.sim_hz.max(1));
        let (yaw, pitch) = (self.input.yaw, self.input.pitch);
        let dir = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos()).normalize_or_zero();
        let shot_id = self.next_shot_id;
        self.next_shot_id = self.next_shot_id.wrapping_add(1).max(1);
        let cmd = FireCmd {
            seq: bundler.next_seq(),
            shot_id,
            weapon,
            client_fire_time_us: (server_tick.max(0.0) as u64) * server_ms_per_tick(config.sim_hz) * 1000,
            client_interp_ms: (players.delay_ticks() * tick_ms).round() as u16,
            client_dynamic_interp_ms: (CITY_DELAY_TICKS * tick_ms).round() as u16,
            dir: dir.to_array(),
        };
        self.outgoing.push(Outgoing { datagram: true, bytes: encode_fire(&cmd) });
        let eye = self.frame.local.eye;
        self.events.push(VlEvent {
            kind: VL_EVENT_LOCAL_SHOT,
            player: self.player_id,
            id: shot_id,
            weapon: u32::from(weapon),
            p0: eye,
            p1: { let d = self.space.pos(dir); let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-9); [d[0] / l, d[1] / l, d[2] / l] },
            ..Default::default()
        });
        shot_id
    }

    /// The frame the last [`poll`](Self::poll) produced.
    pub fn frame(&self) -> &SceneFrame {
        &self.frame
    }

    /// Packets to send, in order. Call after [`poll`](Self::poll).
    pub fn drain_outgoing(&mut self) -> std::vec::Drain<'_, Outgoing> {
        self.outgoing.drain(..)
    }

    /// For tests and debug views: a chunk's world pose now, in server space.
    pub fn chunk_world_server(&self, structure: u32, node: u32) -> Option<(glam::Vec3, glam::Quat)> {
        self.city.as_ref()?.chunk_world_server(structure, node)
    }
}
