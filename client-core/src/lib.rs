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
pub mod players;

use vibe_land_shared::net_client::{decode_server_packet, ServerMessage, SessionConfig};

use crate::city::{decode_manifest, is_city_packet, CityStream};
use crate::coords::Space;
use crate::frame::{SceneFrame, VlChunk, VlCoreState};
use crate::players::Players;

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
    players: Option<Players>,
    frame: SceneFrame,
    outgoing: Vec<Outgoing>,
    state: VlCoreState,
    last_error: Option<String>,
    player_id: u32,
    protocol_decode_errors: u64,
    unknown_packets: u64,
}

impl ClientCore {
    pub fn new(space: Space) -> Self {
        Self {
            space,
            config: None,
            city: None,
            players: None,
            frame: SceneFrame::default(),
            outgoing: Vec::new(),
            state: VlCoreState::WaitingForConfig,
            last_error: None,
            player_id: 0,
            protocol_decode_errors: 0,
            unknown_packets: 0,
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
        self.frame.clear_changes();

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
            if let Some(r) = players.sample(now_ms, self.space, &mut self.frame.local, &mut self.frame.remote_players) {
                stats.player_render_tick = r;
            }
            stats.snapshots = players.snapshots;
            stats.newest_server_tick = players.newest_tick;
        }
        stats.remote_players = self.frame.remote_players.len() as u32;
        self.frame.stats = stats;
        &self.frame
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
