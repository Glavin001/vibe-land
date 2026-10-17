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

pub mod audio;
pub mod city;
pub mod coords;
pub mod effects;
pub mod frame;
pub mod geometry;
pub mod grass;
pub mod ground;
pub mod input;
pub mod interp;
pub mod materials;
pub mod players;
pub mod predictor;
pub mod vehicle_predictor;
pub mod vehicles;
pub mod weather;

use glam::Vec3;
use vibe_land_shared::constants::{
    FLAG_IN_VEHICLE, FLAG_ON_GROUND, PLAYER_EYE_HEIGHT_M, RIFLE_FIRE_INTERVAL_MS, WEAPON_CANNONBALL, WEAPON_HITSCAN,
    WEAPON_METEOR,
};
use vibe_land_shared::constants::{MELEE_COOLDOWN_MS, PKT_AUDIO_CONTACTS, PKT_METEOR_LAUNCHED, PKT_VEHICLE_ASSET, PKT_VEHICLE_RIG};
use vibe_land_shared::net_client::{
    decode_audio_contacts, decode_meteor_launched, decode_server_packet, decode_vehicle_asset, decode_vehicle_rig, VehicleRig, encode_city_camera_drop, encode_fire,
    encode_input_bundle, encode_melee, encode_vehicle_enter, encode_vehicle_exit, MeteorLaunched, ServerMessage,
    SessionConfig, VehicleAsset,
};
use vibe_land_shared::protocol::{FireCmd, InputFrame, MeleeCmd};

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
    grass_exclusions: Vec<grass::VlGrassExclusion>,
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
    next_swing_id: u32,
    last_melee_us: Option<u64>,
    /// Meteor launches since the last poll, with their arrival times.
    meteors: Vec<(MeteorLaunched, u64)>,
    audio_contacts: Vec<crate::frame::VlAudioContact>,
    audio: audio::AudioDirector,
    flybys: audio::FlybyTracker,
    /// Debris energy per region, for the continuous debris beds (destructionActivity.ts).
    activity: audio::Activity,
    /// Scene rays from the listener to sources (occlusion.ts).
    occlusion: audio::Occlusion,
    loops: audio::Loops,
    /// Free dynamic bodies' last drawn position and time (server space, ms), for their velocity.
    dynamic_previous: std::collections::HashMap<u32, (Vec3, f64)>,
    /// Bodies launched as meteors (stone, air from 8 m/s).
    meteor_bodies: std::collections::HashSet<u32>,
    /// Where sounds are heard from (server space): the local player's eye unless the renderer says.
    listener: Option<Vec3>,
    vehicle_assets: std::collections::HashMap<u32, VehicleAsset>,
    /// Each car's newest rig (wheel states), for cars drawn from the snapshot.
    vehicle_rigs: std::collections::HashMap<u32, VehicleRig>,
    /// The car this client asked to drive (its handle), until it asks to leave.
    driving: Option<u32>,
    /// Whether the server has this player in a vehicle (the newest local state).
    in_vehicle: bool,
    /// The newest input frames sent, for the in-car resend window.
    recent_inputs: std::collections::VecDeque<InputFrame>,
    /// The driven car's presentation: its unacknowledged inputs replayed from the newest
    /// authoritative state (vehicle_predictor.rs, the web's vehiclePresentation.ts).
    car_predictor: vehicle_predictor::VehiclePredictor,
    /// The snapshot tick of the newest car state the predictor has seen.
    car_observed_tick: Option<u32>,
    /// Each garage car's wheel centres (actor frame, stream wheel order), from its metadata.
    wheel_centres: std::collections::HashMap<u32, [[f32; 3]; 4]>,
}

/// In a car the web resends the newest unacknowledged input frames with every bundle, this many
/// at most when the server does not pace vehicle input (`VEHICLE_INPUT_REDUNDANCY`).
const VEHICLE_INPUT_REDUNDANCY: usize = 4;
const RECENT_INPUTS: usize = vibe_land_shared::net_client::INPUT_BUNDLE_MAX_FRAMES;

impl ClientCore {
    pub fn new(space: Space) -> Self {
        Self {
            space,
            config: None,
            city: None,
            meshes: None,
            grass_exclusions: Vec::new(),
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
            next_swing_id: 1,
            last_melee_us: None,
            meteors: Vec::new(),
            audio_contacts: Vec::new(),
            audio: audio::AudioDirector::default(),
            flybys: audio::FlybyTracker::default(),
            activity: audio::Activity::default(),
            occlusion: audio::Occlusion::default(),
            loops: audio::Loops::default(),
            dynamic_previous: Default::default(),
            meteor_bodies: Default::default(),
            listener: None,
            vehicle_assets: std::collections::HashMap::new(),
            vehicle_rigs: std::collections::HashMap::new(),
            driving: None,
            in_vehicle: false,
            recent_inputs: std::collections::VecDeque::new(),
            car_predictor: Default::default(),
            car_observed_tick: None,
            wheel_centres: std::collections::HashMap::new(),
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

    /// Fail with `error`, unless the core already failed: then what follows is a consequence (a
    /// manifest arriving for a session the core refused), and the first reason is the one to keep.
    fn fail(&mut self, error: String) {
        if self.state == VlCoreState::Failed {
            return;
        }
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
                self.grass_exclusions = grass::exclusions_from_manifest(&manifest);
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

    /// Where the meadow is bare: each building's original footprint plus a verge (grass.rs), server
    /// space. Empty until the manifest arrives.
    pub fn grass_exclusions(&self) -> &[grass::VlGrassExclusion] {
        &self.grass_exclusions
    }

    /// Every chunk's catalog materials, in chunk-table order (empty until the manifest arrives).
    pub fn chunk_surfaces(&self) -> &[materials::VlChunkSurface] {
        &self.surfaces
    }

    /// One server packet.
    pub fn on_packet(&mut self, _lane: Lane, bytes: &[u8], arrival_us: u64) {
        let Some(&kind) = bytes.first() else { return };
        let arrival_ms = arrival_us as f64 / 1000.0;
        if kind == PKT_VEHICLE_ASSET {
            match decode_vehicle_asset(bytes) {
                Ok(asset) => {
                    let handle = u32::from(asset.handle);
                    self.vehicle_assets.insert(handle, asset);
                    self.events.push(VlEvent { kind: crate::frame::VL_EVENT_VEHICLE_ASSET, id: handle, ..Default::default() });
                }
                Err(_) => self.protocol_decode_errors += 1,
            }
            return;
        }
        if kind == PKT_AUDIO_CONTACTS {
            match decode_audio_contacts(bytes) {
                Ok((_, contacts)) => {
                    let m = self.space.metres();
                    for c in contacts {
                        let n = self.space.pos(Vec3::from_array(c.normal));
                        self.audio_contacts.push(crate::frame::VlAudioContact {
                            entity_a: c.entity_a,
                            entity_b: c.entity_b,
                            kind: u32::from(c.kind),
                            pos: self.space.pos(Vec3::from_array(c.position)),
                            normal: [n[0] / m, n[1] / m, n[2] / m],
                            normal_speed: c.normal_speed * m,
                            tangent_speed: c.tangent_speed * m,
                            intensity: c.intensity,
                            size: c.size,
                        });
                    }
                }
                Err(_) => self.protocol_decode_errors += 1,
            }
            return;
        }
        if kind == PKT_VEHICLE_RIG {
            match decode_vehicle_rig(bytes) {
                Ok(rig) => {
                    let handle = u32::from(rig.handle);
                    if self.vehicle_rigs.get(&handle).is_none_or(|r| r.server_tick <= rig.server_tick) {
                        self.vehicle_rigs.insert(handle, rig);
                    }
                }
                Err(_) => self.protocol_decode_errors += 1,
            }
            return;
        }
        if kind == PKT_METEOR_LAUNCHED {
            match decode_meteor_launched(bytes) {
                Ok(meteor) => {
                    self.meteor_bodies.insert(meteor.body_id);
                    self.meteors.push((meteor, arrival_us));
                }
                Err(_) => self.protocol_decode_errors += 1,
            }
            return;
        }
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
            Ok(ServerMessage::DynamicBodyMeta(meta)) => {
                if let Some(players) = self.players.as_mut() {
                    players.on_body_meta(&meta);
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
        let dt_s = self.last_poll_us.map_or(0.0, |last| now_us.saturating_sub(last) as f64 / 1e6);
        self.last_poll_us = Some(now_us);
        self.frame.clear_changes();
        self.frame.events.append(&mut self.events);
        self.frame.audio_contacts.append(&mut self.audio_contacts);

        // Input: the 60 Hz frames due since the last poll, one bundle (as the web client sends).
        if self.state == VlCoreState::Playing {
            if let Some(bundler) = self.bundler.as_mut() {
                let frames = bundler.produce(dt_s, &self.input);
                if !frames.is_empty() {
                    if let (true, Some(handle)) = (self.in_vehicle, self.driving) {
                        self.car_predictor.record(handle, &frames);
                    }
                    self.recent_inputs.extend(frames.iter().cloned());
                    while self.recent_inputs.len() > RECENT_INPUTS {
                        self.recent_inputs.pop_front();
                    }
                    let bundle = if self.in_vehicle {
                        // The newest unacknowledged frames, at least this poll's.
                        let ack = self.players.as_ref().map_or(0, |p| p.ack_input_seq);
                        let unacked: Vec<InputFrame> =
                            self.recent_inputs.iter().filter(|f| (1..0x8000).contains(&f.seq.wrapping_sub(ack))).cloned().collect();
                        let keep = VEHICLE_INPUT_REDUNDANCY.max(frames.len()).min(unacked.len());
                        let window = &unacked[unacked.len() - keep..];
                        // Never less than this poll's frames, whatever the ack says.
                        if window.last().map(|f| f.seq) == frames.last().map(|f| f.seq) { window.to_vec() } else { frames }
                    } else {
                        frames
                    };
                    if !bundle.is_empty() {
                        self.outgoing.push(Outgoing { datagram: true, bytes: encode_input_bundle(&bundle) });
                    }
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
            // Shots this poll, remembered so the breaks they make are recognised as their entry
            // (effects.rs; the web registers each tracer the same way, vfx/dustShots.ts).
            let space = self.space;
            for e in &self.frame.events {
                match e.kind {
                    crate::frame::VL_EVENT_LOCAL_SHOT => city.source_state.shots.register(
                        space.pos_to_server(e.p0),
                        space.pos_to_server(e.p1),
                        None,
                        now_ms,
                    ),
                    crate::frame::VL_EVENT_SHOT_FIRED => {
                        let (o, end) = (space.pos_to_server(e.p0), space.pos_to_server(e.p1));
                        city.source_state.shots.register(o, end - o, Some(end), now_ms);
                    }
                    _ => {}
                }
            }
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
                    self.in_vehicle = flags & FLAG_IN_VEHICLE != 0;
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
                        acked_pos: self.space.pos(players.acked_pos),
                    };
                }
            }
            stats.snapshots = players.snapshots;
            stats.newest_server_tick = players.newest_tick;
            players.dynamic_bodies(self.space, &mut self.frame.dynamic_bodies);
            // Cars on the players' clock (the web's setVehicleClock), so a driver sits in its car.
            if let Some(city) = self.city.as_mut() {
                city.cars(stats.player_render_tick, &mut self.frame.cars);
            }
            // The snapshot's cars: on wire 4 the car this player drives is left out of the city
            // stream and sent in every snapshot instead (the web draws it from there too). Draw a
            // snapshot car when it is the one driven or the stream does not carry it.
            let handles: Vec<u8> = players.vehicle_handles().collect();
            for handle in handles {
                let h = u32::from(handle);
                let streamed = self.frame.cars.iter().position(|c| c.handle == h);
                if streamed.is_some() && self.driving != Some(h) {
                    continue;
                }
                let Some((p, q)) = players.vehicle_pose(handle) else { continue };
                let mut car = crate::frame::VlCar { handle: h, pos: self.space.pos(p), quat: self.space.quat(q), ..Default::default() };
                if let Some(rig) = self.vehicle_rigs.get(&h) {
                    car.flags |= crate::frame::VL_CAR_HAS_WHEELS;
                    for (out, w) in car.wheels.iter_mut().zip(rig.wheels) {
                        *out = crate::frame::VlWheel {
                            travel: w.travel_m * self.space.metres(),
                            steer: w.steer_rad,
                            spin: w.rotation_rad,
                            grounded: u32::from(w.grounded),
                        };
                    }
                }
                match streamed {
                    Some(i) => self.frame.cars[i] = car,
                    None => self.frame.cars.push(car),
                }
            }
            // The driven car: drawn where the driver's inputs put it, not an interpolation delay
            // plus a round trip behind (the web's VehiclePresentationPredictor).
            match (self.in_vehicle, self.driving) {
                (true, Some(handle)) => {
                    let sim_hz = self.config.as_ref().map_or(60, |c| u32::from(c.sim_hz));
                    if let Some(n) = u8::try_from(handle).ok().and_then(|h| players.newest_vehicle(h)).copied() {
                        if self.car_observed_tick.is_none_or(|t| n.tick > t) {
                            self.car_observed_tick = Some(n.tick);
                            let proxy = self.vehicle_proxy(handle, n.vehicle_type);
                            let sample = vehicle_predictor::CarSample {
                                server_time_us: f64::from(n.tick) * 1e6 / f64::from(sim_hz),
                                position: n.position,
                                rotation: n.rotation,
                                linear_velocity: n.linear_velocity,
                                angular_velocity: n.angular_velocity,
                            };
                            self.car_predictor.observe(handle, sample, n.ack_input_seq, proxy, now_ms);
                        }
                    }
                    self.car_predictor.update(dt_s as f32, now_ms);
                    if let (Some((p, q)), Some(car)) =
                        (self.car_predictor.pose(), self.frame.cars.iter_mut().find(|c| c.handle == handle))
                    {
                        car.pos = self.space.pos(p);
                        car.quat = self.space.quat(q);
                    }
                }
                _ => {
                    if self.car_predictor.handle().is_some() {
                        self.car_predictor.reset();
                    }
                    self.car_observed_tick = None;
                }
            }
        }
        for (m, arrival_us) in self.meteors.drain(..) {
            let g = Vec3::new(0.0, -m.gravity_ms2, 0.0);
            self.frame.meteors.push(crate::frame::VlMeteor {
                body_id: m.body_id,
                shooter: m.shooter_player_id,
                age_s: now_us.saturating_sub(arrival_us) as f32 / 1e6,
                flight_time_s: m.flight_time_s,
                start: self.space.pos(Vec3::from_array(m.start)),
                velocity: self.space.pos(Vec3::from_array(m.velocity)),
                gravity: self.space.pos(g),
                target: self.space.pos(Vec3::from_array(m.target)),
                radius: m.radius_m * self.space.metres(),
            });
        }
        self.present_effects(now_ms);
        stats.remote_players = self.frame.remote_players.len() as u32;
        self.frame.stats = stats;
        &self.frame
    }

    /// Where sounds are heard from, in the renderer's space (a spectator's camera). Without it the
    /// local player's eye is the listener.
    pub fn set_listener(&mut self, position: [f32; 3]) {
        self.listener = Some(self.space.pos_to_server(position));
    }

    /// This poll's destruction sources, shots and server contacts as sounds (through the web's
    /// director and voice choices, audio.rs) and dust (effects.rs), in the renderer's space.
    fn present_effects(&mut self, now_ms: f64) {
        let listener = self.listener.unwrap_or_else(|| {
            let eye = self.frame.local.eye;
            if self.frame.local.player.player_id != 0 { self.space.pos_to_server(eye) } else { Vec3::ZERO }
        });
        self.audio.listener = listener;
        let space = self.space;
        let to_server_dir = |d: [f32; 3]| (space.pos_to_server(d)).normalize_or_zero();

        let mut near_misses = Vec::new();
        if let Some(city) = self.city.as_mut() {
            // Swept near misses of moving city bodies (GameAudioLayer.tsx: the first 256 within 120 m).
            let mut budget = 0;
            for m in city.motions.drain(..) {
                if m.position.distance(listener) > 120.0 || budget >= 256 {
                    continue;
                }
                budget += 1;
                self.flybys.note(m, listener, m.time_ms, &mut near_misses);
            }
            let sources = std::mem::take(&mut city.sources);
            let table = city.source_table();
            for source in &sources {
                let acoustic = table.acoustic(source.material);
                if let Some(sound) = effects::sound_from_source(source, acoustic, now_ms) {
                    emit_sound(&mut self.audio, &mut self.activity, sound, listener, now_ms);
                }
                // Dust in the material's colour (authored, else concrete).
                let mut dust = source.dust(table.color(source.material));
                dust.position = space.pos(Vec3::from_array(dust.position));
                dust.normal = Vec3::from_array(space.pos(Vec3::from_array(dust.normal))).normalize_or_zero().to_array();
                dust.radius *= space.metres();
                self.frame.dust.push(dust);
            }
        }
        // Shots (gameEvents.ts soundFromShot): anyone's resolved hitscan shots, and this client's
        // own at once.
        for e in &self.frame.events {
            let origin = || space.pos_to_server(e.p0);
            let shot = match e.kind {
                crate::frame::VL_EVENT_SHOT_FIRED if e.player != self.player_id => audio::sound_from_shot(e.player, e.id, e.weapon as u8, origin(), now_ms),
                crate::frame::VL_EVENT_LOCAL_SHOT => audio::sound_from_shot(self.player_id, e.id, e.weapon as u8, origin(), now_ms),
                _ => None,
            };
            if let Some(s) = shot {
                emit_sound(&mut self.audio, &mut self.activity, s, listener, now_ms);
            }
        }
        // Free dynamic bodies (cannonballs, meteors): velocity from their drawn motion, fly-bys and
        // air (GameAudioLayer.tsx).
        let mut seen = Vec::new();
        for b in &self.frame.dynamic_bodies {
            let position = space.pos_to_server(b.pos);
            seen.push(b.body_id);
            let previous = self.dynamic_previous.insert(b.body_id, (position, now_ms));
            let Some((before, at)) = previous else { continue };
            let dt = ((now_ms - at) / 1000.0) as f32;
            if dt <= 0.0 || dt >= 0.2 {
                continue;
            }
            let velocity = (position - before) / dt;
            let meteor = self.meteor_bodies.contains(&b.body_id);
            let radius = b.half_extents.iter().fold(0.0f32, |a, &h| a.max(h)) / space.metres();
            let (material, size) = if meteor { (audio::AcousticMaterial::Stone, radius) } else { (audio::AcousticMaterial::Metal, radius * 2.0) };
            let id = 0xD000_0000_0000_0000 | u64::from(b.body_id);
            self.flybys.note(audio::Motion { id, position, velocity, time_ms: now_ms, material, size }, listener, now_ms, &mut near_misses);
            let speed = velocity.length();
            let loop_id = 0x8000_0000 | b.body_id;
            if meteor && speed > 8.0 {
                self.loops.air(loop_id, position, velocity, (speed / 90.0).min(1.0), listener, now_ms, audio::DEFAULT_MIX);
            } else if !meteor && speed > 20.0 {
                self.loops.air(loop_id, position, velocity, (speed / 120.0).min(1.0), listener, now_ms, audio::DEFAULT_MIX);
            }
        }
        self.dynamic_previous.retain(|id, _| seen.contains(id));
        self.meteor_bodies.retain(|id| seen.contains(id) || self.meteors.iter().any(|(m, _)| m.body_id == *id) || self.frame.meteors.iter().any(|m| m.body_id == *id));
        self.flybys.prune(now_ms);
        for e in near_misses {
            emit_sound(&mut self.audio, &mut self.activity, e, listener, now_ms);
        }
        // The server's audible contacts (GameAudioLayer.tsx): impacts as one-shots, scrapes as loops.
        for c in &self.frame.audio_contacts {
            let contact = audio::AudioContact {
                sim_tick: 0,
                entity_a: c.entity_a,
                entity_b: c.entity_b,
                scrape: c.kind == crate::frame::VL_CONTACT_SCRAPE,
                position: space.pos_to_server(c.pos),
                normal: to_server_dir(c.normal),
                normal_speed: c.normal_speed / space.metres(),
                tangent_speed: c.tangent_speed / space.metres(),
                intensity: c.intensity,
                size: c.size,
            };
            if contact.scrape {
                let (lo, hi) = (c.entity_a.min(c.entity_b), c.entity_a.max(c.entity_b));
                let id = (lo.wrapping_mul(0x9E37_79B1) ^ hi) & 0x7FFF_FFFF;
                self.loops.scrape(id, contact.position, audio::AcousticMaterial::Concrete, contact.tangent_speed, contact.intensity, listener, now_ms, audio::DEFAULT_MIX);
            } else if let Some(s) = audio::sound_from_contact(&contact, audio::AcousticMaterial::Concrete, false, now_ms) {
                emit_sound(&mut self.audio, &mut self.activity, s, listener, now_ms);
            }
        }
        // Car engines (GameAudioLayer.tsx: the first 64 cars within 80 m).
        let mut engines = 0;
        for car in &self.frame.cars {
            let position = space.pos_to_server(car.pos);
            let speed = Vec3::from_array(car.vel).length() / space.metres();
            if position.distance(listener) > 80.0 || engines >= 64 {
                continue;
            }
            engines += 1;
            if let Some(intensity) = audio::engine_intensity(speed) {
                self.loops.engine(0x2000_0000 | (car.handle & 0x1FFF_FFFF), position, speed, intensity, listener, now_ms, audio::DEFAULT_MIX);
            }
        }
        let mut loops = Vec::new();
        self.loops.current(now_ms, &mut loops);
        // Debris beds (engine.ts update): the strongest four regions of breaking debris.
        for bed in self.activity.sample(now_ms, listener) {
            if let Some(l) = audio::bed_loop(&bed, listener, audio::DEFAULT_MIX) {
                loops.push(l);
            }
        }
        let city = self.city.as_ref();
        for mut l in loops {
            let p = Vec3::from_array(l.position);
            let occlusion = self.occlusion.sample(listener, p, now_ms, |a, b, m| city.is_some_and(|c| c.segment_blocked(a, b, m)));
            (l.gain, l.lowpass_hz) = audio::occluded(l.gain, p.distance(listener), occlusion, l.flags & audio::VL_LOOP_BED != 0);
            l.position = space.pos(p);
            self.frame.loops.push(l);
        }
        let mut voices = Vec::new();
        self.audio.drain(now_ms, |e| audio::voices(e, listener, now_ms, audio::DEFAULT_MIX, &mut voices));
        let city = self.city.as_ref();
        for mut v in voices {
            let p = Vec3::from_array(v.position);
            let occlusion = self.occlusion.sample(listener, p, now_ms, |a, b, m| city.is_some_and(|c| c.segment_blocked(a, b, m)));
            (v.gain, v.lowpass_hz) = audio::occluded(v.gain, p.distance(listener), occlusion, false);
            v.position = space.pos(p);
            self.frame.sounds.push(v);
        }
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

    /// Swing a melee attack along the current view (the web's V key). Returns the swing id, or 0
    /// when not playing or inside the server's cooldown (`MELEE_COOLDOWN_MS`).
    pub fn melee(&mut self, now_us: u64) -> u32 {
        if self.state != VlCoreState::Playing
            || self.last_melee_us.is_some_and(|last| now_us.saturating_sub(last) < u64::from(MELEE_COOLDOWN_MS) * 1000)
        {
            return 0;
        }
        let (Some(config), Some(players), Some(bundler)) = (self.config.as_ref(), self.players.as_ref(), self.bundler.as_ref()) else {
            return 0;
        };
        let Some(server_tick) = players.server_tick_now() else { return 0 };
        self.last_melee_us = Some(now_us);
        let swing_id = self.next_swing_id;
        self.next_swing_id = self.next_swing_id.wrapping_add(1).max(1);
        let cmd = MeleeCmd {
            seq: bundler.next_seq(),
            swing_id,
            client_time_us: (server_tick.max(0.0) as u64) * server_ms_per_tick(config.sim_hz) * 1000,
            yaw: self.input.yaw,
            pitch: self.input.pitch,
        };
        self.outgoing.push(Outgoing { datagram: true, bytes: encode_melee(&cmd) });
        swing_id
    }

    /// Put the player at a pose (the web's aerial camera: leaving it drops the player where the
    /// camera is). Renderer space; sent on the reliable stream; the server rate-limits it.
    pub fn camera_drop(&mut self, pos: [f32; 3], yaw: f32, pitch: f32) {
        if self.state != VlCoreState::Playing {
            return;
        }
        let p = self.space.pos_to_server(pos);
        let (yaw, pitch) = self.space.yaw_pitch_to_server(yaw, pitch);
        self.outgoing.push(Outgoing { datagram: false, bytes: encode_city_camera_drop(p.to_array(), yaw, pitch) });
    }

    /// A car's asset (geometry hash, configuration), once its `PKT_VEHICLE_ASSET` has arrived.
    pub fn vehicle_asset(&self, handle: u32) -> Option<&VehicleAsset> {
        self.vehicle_assets.get(&handle)
    }

    /// A car's `metadata.json` (fetched by the renderer for its mesh): its part hulls let the
    /// stream rest the car's detached parts on the ground as the server does.
    pub fn set_vehicle_metadata(&mut self, handle: u32, metadata: &[u8]) -> Result<(), vehicles::VehicleMeshError> {
        let parts = vehicles::part_hull_points(metadata)?;
        if let Some(centres) = vehicles::wheel_centres(metadata) {
            self.wheel_centres.insert(handle, centres);
        }
        if let Some(city) = self.city.as_mut() {
            city.set_vehicle_parts(handle, parts);
        }
        Ok(())
    }

    /// The driven car's proxy (`vehicleProxy`): a garage car's dimensions, prepared driving and wheel
    /// centres once its metadata has arrived; the stock definition of its type otherwise.
    fn vehicle_proxy(&self, handle: u32, vehicle_type: u8) -> vehicle_predictor::VehicleProxy {
        self.vehicle_assets
            .get(&handle)
            .zip(self.wheel_centres.get(&handle))
            .and_then(|(asset, wheels)| vehicle_predictor::VehicleProxy::custom(&asset.configuration, &asset.driving, wheels))
            .unwrap_or_else(|| vehicle_predictor::VehicleProxy::stock(vehicle_type))
    }

    /// The driven car's newest authoritative position and velocity (server space), for tests.
    pub fn driven_car_authoritative(&self) -> Option<(Vec3, Vec3)> {
        let handle = u8::try_from(self.driving?).ok()?;
        let n = self.players.as_ref()?.newest_vehicle(handle)?;
        Some((n.position, n.linear_velocity))
    }

    /// Ask to drive the car with `handle` (the web's E near a car; the server checks the seat is
    /// free and the player within `VEHICLE_INTERACT_RADIUS_M`).
    pub fn enter_vehicle(&mut self, handle: u32) {
        if self.state == VlCoreState::Playing {
            self.driving = Some(handle);
            self.outgoing.push(Outgoing { datagram: true, bytes: encode_vehicle_enter(handle, 0) });
        }
    }

    /// Leave the car this client entered.
    pub fn exit_vehicle(&mut self) {
        if let (VlCoreState::Playing, Some(handle)) = (self.state, self.driving.take()) {
            self.outgoing.push(Outgoing { datagram: true, bytes: encode_vehicle_exit(handle) });
        }
    }

    /// Whether the server has this player in a car.
    pub fn in_vehicle(&self) -> bool {
        self.in_vehicle
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

/// engine.ts `emit`: every sound goes to the director, and its energy (at its arrival time) to the
/// debris beds.
fn emit_sound(director: &mut audio::AudioDirector, activity: &mut audio::Activity, e: audio::SoundEvent, listener: Vec3, now_ms: f64) {
    let arrival = audio::SoundEvent { at_ms: e.at_ms + f64::from(audio::propagation_delay_ms(e.position.distance(listener))), ..e.clone() };
    activity.add(&arrival, listener, now_ms, 0.0);
    director.enqueue(e);
}
