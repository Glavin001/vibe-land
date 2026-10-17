//! Players from SnapshotV2: the local player's server state and every remote player, interpolated
//! to a render tick.
//!
//! The render tick comes from the same `RenderClock` the city stream plays on (perplayer), fed the
//! snapshots' server ticks and arrival times, with the session's interpolation delay as its
//! playout delay. Positions are anchor-relative on the wire: the anchor (mm) is the local player's
//! position and a remote player is the anchor plus its delta in 2.5 mm units.
//!
//! The server leaves unchanged remote players out of most snapshots (snapshot_builder.rs
//! `idle_cold`: resent a few times as they come to rest, then once per cold refresh), so each remote
//! player keeps its own history and stays until the roster drops it, as in the web client
//! (`netcodeClient.ts` `applyPlayerRoster`). When one is resent after such a gap, a copy of its
//! resting sample one snapshot interval earlier holds it still until it actually moved
//! (`interpolation.ts` `insertWithRestHold`).

use std::collections::{HashMap, VecDeque};

use glam::Vec3;
use vibe_land_perplayer::client::RenderClock;
use glam::Quat;
use vibe_land_shared::protocol::{DynamicBodyMetaPacket, PlayerRosterPacket, SnapshotV2Packet};
use vibe_netcode::unit_conv::i16_to_angle;

use crate::coords::Space;
use crate::frame::{VlDynamicBody, VlPlayer, VL_PLAYER_VALID, VL_SHAPE_SPHERE};

/// Samples kept per player (about a second at 60 Hz).
const HISTORY: usize = 64;
const Q2_5MM_M: f32 = 0.0025;

#[derive(Clone, Copy, Debug)]
pub(crate) struct PlayerSample {
    pub pos: Vec3,
    /// Velocity, including (for the local player) that of whatever it stands on.
    pub vel: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub hp: u8,
    pub flags: u8,
}

/// One player's samples by server tick, oldest first.
#[derive(Clone, Debug, Default)]
struct Track {
    samples: VecDeque<(u32, PlayerSample)>,
}

impl Track {
    fn push(&mut self, tick: u32, sample: PlayerSample, interval_ticks: u32) {
        if let Some(&(last_tick, last)) = self.samples.back() {
            if tick <= last_tick {
                return; // late or duplicate: keep tick order
            }
            // Resent after a gap (it was left out while unchanged): hold the resting sample until
            // the snapshot before this one, so it does not start moving early.
            let hold = tick.saturating_sub(interval_ticks);
            if tick - last_tick > interval_ticks + interval_ticks / 2 && hold > last_tick {
                self.samples.push_back((hold, last));
            }
        }
        self.samples.push_back((tick, sample));
        while self.samples.len() > HISTORY {
            self.samples.pop_front();
        }
    }

    fn at(&self, r: f32) -> Option<PlayerSample> {
        let first = self.samples.front()?;
        if r <= first.0 as f32 || self.samples.len() == 1 {
            return Some(first.1);
        }
        match self.samples.iter().position(|&(tick, _)| tick as f32 >= r) {
            None => self.samples.back().map(|&(_, s)| s),
            Some(i) => {
                let ((ta, a), (tb, b)) = (self.samples[i - 1], self.samples[i]);
                let span = (tb - ta).max(1) as f32;
                Some(lerp(a, b, ((r - ta as f32) / span).clamp(0.0, 1.0)))
            }
        }
    }
}

/// A snapshot car's newest authoritative state, server space, with the input the server had
/// applied when it was taken.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NewestCar {
    pub tick: u32,
    pub vehicle_type: u8,
    pub position: Vec3,
    pub rotation: Quat,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub ack_input_seq: u16,
}

/// A dynamic body's track (cannonballs, meteors): poses by tick, and the last tick it was named.
#[derive(Clone, Debug, Default)]
struct BodyTrack {
    samples: VecDeque<(u32, Vec3, Quat)>,
    last_seen: u32,
}

impl BodyTrack {
    fn at(&self, r: f32) -> Option<(Vec3, Quat)> {
        let first = self.samples.front()?;
        if r <= first.0 as f32 || self.samples.len() == 1 {
            return Some((first.1, first.2));
        }
        match self.samples.iter().position(|&(tick, _, _)| tick as f32 >= r) {
            None => self.samples.back().map(|&(_, p, q)| (p, q)),
            Some(i) => {
                let ((ta, pa, qa), (tb, pb, qb)) = (self.samples[i - 1], self.samples[i]);
                let t = ((r - ta as f32) / (tb - ta).max(1) as f32).clamp(0.0, 1.0);
                Some((pa.lerp(pb, t), qa.slerp(qb, t)))
            }
        }
    }
}

/// A body unseen this long is dropped even without a removal (the server's cold refresh for
/// dynamic bodies is 60 ticks: `COLD_DYNAMIC_REFRESH_TICKS`).
const BODY_STALE_TICKS: u32 = 180;

pub struct Players {
    clock: RenderClock,
    sim_hz: u32,
    interval_ticks: u32,
    local: Track,
    /// By wire handle: the web's interpolation (interp.rs), in server microseconds.
    remote: crate::interp::PlayerInterpolator,
    /// Handle to player id, from the newest roster (None until the first arrives).
    roster: Option<HashMap<u8, u32>>,
    local_player_id: u32,
    pub snapshots: u64,
    pub newest_tick: u32,
    /// The newest input sequence the server has applied (from the newest snapshot).
    pub ack_input_seq: u16,
    /// The render tick of the last [`sample`](Self::sample).
    render_tick: Option<f32>,
    bodies: HashMap<u16, BodyTrack>,
    /// The snapshot's vehicles (on wire 4: the car this player drives, which the city stream
    /// leaves out), by handle.
    vehicles: HashMap<u8, BodyTrack>,
    /// Each snapshot car's newest authoritative state, for the driver's presentation
    /// (vehicle_predictor.rs).
    vehicle_newest: HashMap<u8, NewestCar>,
    /// handle -> (body id, shape, half extents m), from `PKT_DYNAMIC_BODY_META`.
    body_meta: HashMap<u16, (u32, u8, Vec3)>,
}

impl Players {
    pub fn new(sim_hz: u32, interpolation_delay_ms: u16) -> Self {
        let delay_ticks = (f32::from(interpolation_delay_ms) * sim_hz as f32 / 1000.0).max(1.0);
        Self {
            clock: RenderClock::new(sim_hz, delay_ticks),
            sim_hz: sim_hz.max(1),
            interval_ticks: 1,
            local: Track::default(),
            remote: crate::interp::PlayerInterpolator::default(),
            roster: None,
            local_player_id: 0,
            snapshots: 0,
            newest_tick: 0,
            ack_input_seq: 0,
            render_tick: None,
            bodies: HashMap::new(),
            body_meta: HashMap::new(),
            vehicles: HashMap::new(),
            vehicle_newest: HashMap::new(),
        }
    }

    /// The session's snapshot rate: a remote player missing for more than ~1.5 intervals was left out.
    pub fn set_snapshot_hz(&mut self, snapshot_hz: u16) {
        self.interval_ticks = (self.sim_hz / u32::from(snapshot_hz.max(1))).max(1);
    }

    pub fn set_local_player(&mut self, player_id: u32) {
        self.local_player_id = player_id;
    }

    pub fn on_roster(&mut self, roster: &PlayerRosterPacket) {
        let map: HashMap<u8, u32> = roster.entries.iter().map(|e| (e.handle, e.player_id)).collect();
        let handles: Vec<u32> = map.keys().map(|&h| u32::from(h)).collect();
        self.remote.retain_only(&handles);
        self.roster = Some(map);
    }

    pub fn on_body_meta(&mut self, meta: &DynamicBodyMetaPacket) {
        for e in &meta.entries {
            let half = Vec3::new(f32::from(e.hx_cm), f32::from(e.hy_cm), f32::from(e.hz_cm)) / 100.0;
            self.body_meta.insert(e.handle, (e.body_id, e.shape_type, half));
        }
    }

    pub fn on_snapshot(&mut self, s: &SnapshotV2Packet, arrival_ms: f64) {
        self.snapshots += 1;
        self.clock.observe(s.server_tick, arrival_ms);
        if s.server_tick >= self.newest_tick {
            self.ack_input_seq = s.ack_input_seq;
        }
        self.newest_tick = self.newest_tick.max(s.server_tick);
        let anchor = Vec3::new(s.anchor_px_mm as f32, s.anchor_py_mm as f32, s.anchor_pz_mm as f32) / 1000.0;
        let me = &s.self_state;
        let cms = |v: [i16; 3]| Vec3::new(f32::from(v[0]), f32::from(v[1]), f32::from(v[2])) / 100.0;
        let local = PlayerSample {
            pos: anchor,
            vel: cms([me.vx_cms, me.vy_cms, me.vz_cms]) + cms(me.support_velocity_cms),
            yaw: i16_to_angle(me.yaw_i16),
            pitch: i16_to_angle(me.pitch_i16),
            hp: me.hp,
            flags: me.flags,
        };
        self.local.push(s.server_tick, local, self.interval_ticks);
        // Remote players as netcodeClient.ts pushes them (f64: anchor mm / 1000 + delta x 0.0025,
        // velocity cm/s / 100, angles from the i16's turn fraction), at tick x SERVER_TICK_US.
        let tick_us = self.tick_us();
        let anchor_m = [f64::from(s.anchor_px_mm) / 1000.0, f64::from(s.anchor_py_mm) / 1000.0, f64::from(s.anchor_pz_mm) / 1000.0];
        let turn = |a: i16| f64::from(a as u16) / 65535.0 * std::f64::consts::PI * 2.0;
        for r in &s.remote_players {
            let sample = crate::interp::PlayerSample {
                server_time_us: f64::from(s.server_tick) * tick_us,
                position: [
                    anchor_m[0] + f64::from(r.dx_q2_5mm) * 0.0025,
                    anchor_m[1] + f64::from(r.dy_q2_5mm) * 0.0025,
                    anchor_m[2] + f64::from(r.dz_q2_5mm) * 0.0025,
                ],
                velocity: [f64::from(r.vx_cms) / 100.0, f64::from(r.vy_cms) / 100.0, f64::from(r.vz_cms) / 100.0],
                yaw: turn(r.yaw_i16),
                pitch: turn(r.pitch_i16),
                hp: f64::from(r.hp),
                flags: f64::from(r.flags),
                held: false,
            };
            self.remote.push(u32::from(r.handle), sample, f64::from(self.interval_ticks) * tick_us);
        }
        let q2_5 = |x: i16, y: i16, z: i16| anchor + Vec3::new(f32::from(x), f32::from(y), f32::from(z)) * Q2_5MM_M;
        let snorm = |v: i16| f32::from(v) / 32767.0;
        let mut bodies = |handle: u16, pos: Vec3, rot: Quat| {
            let track = self.bodies.entry(handle).or_default();
            track.last_seen = s.server_tick;
            if track.samples.back().is_none_or(|&(t, _, _)| t < s.server_tick) {
                track.samples.push_back((s.server_tick, pos, rot));
                while track.samples.len() > HISTORY {
                    track.samples.pop_front();
                }
            }
        };
        for b in &s.sphere_states {
            bodies(b.handle, q2_5(b.dx_q2_5mm, b.dy_q2_5mm, b.dz_q2_5mm), Quat::IDENTITY);
        }
        for b in &s.box_states {
            let q = Quat::from_xyzw(snorm(b.qx_snorm), snorm(b.qy_snorm), snorm(b.qz_snorm), snorm(b.qw_snorm)).normalize();
            bodies(b.handle, q2_5(b.dx_q2_5mm, b.dy_q2_5mm, b.dz_q2_5mm), q);
        }
        for v in &s.vehicle_states {
            let q = Quat::from_xyzw(snorm(v.qx_snorm), snorm(v.qy_snorm), snorm(v.qz_snorm), snorm(v.qw_snorm)).normalize();
            if self.vehicle_newest.get(&v.handle).is_none_or(|n| n.tick < s.server_tick) {
                let w = |x: i16| f32::from(x) / 1000.0;
                self.vehicle_newest.insert(
                    v.handle,
                    NewestCar {
                        tick: s.server_tick,
                        vehicle_type: v.vehicle_type,
                        position: q2_5(v.dx_q2_5mm, v.dy_q2_5mm, v.dz_q2_5mm),
                        rotation: q,
                        linear_velocity: cms([v.vx_cms, v.vy_cms, v.vz_cms]),
                        angular_velocity: Vec3::new(w(v.wx_mrads), w(v.wy_mrads), w(v.wz_mrads)),
                        ack_input_seq: s.ack_input_seq,
                    },
                );
            }
            let track = self.vehicles.entry(v.handle).or_default();
            track.last_seen = s.server_tick;
            if track.samples.back().is_none_or(|&(t, _, _)| t < s.server_tick) {
                track.samples.push_back((s.server_tick, q2_5(v.dx_q2_5mm, v.dy_q2_5mm, v.dz_q2_5mm), q));
                while track.samples.len() > HISTORY {
                    track.samples.pop_front();
                }
            }
        }
        for removal in &s.removals {
            // 0x8000 | handle names a vehicle (the support-handle convention), not a body.
            if removal.handle & 0x8000 == 0 {
                self.bodies.remove(&removal.handle);
            }
        }
        let now = s.server_tick;
        self.bodies.retain(|_, t| now.saturating_sub(t.last_seen) <= BODY_STALE_TICKS);
        self.vehicles.retain(|_, t| now.saturating_sub(t.last_seen) <= BODY_STALE_TICKS);
        let vehicles = &self.vehicles;
        self.vehicle_newest.retain(|h, _| vehicles.contains_key(h));
    }

    /// Players at `now_ms`, written in `space`. Returns the render tick.
    /// Interpolate to `now_ms`: remote players into `remote` (renderer space); the local player's
    /// authoritative sample (server space) is returned for the predictor, with the render tick.
    pub fn sample(&mut self, now_ms: f64, space: Space, remote: &mut Vec<VlPlayer>) -> Option<(f32, Option<PlayerSample>)> {
        let r = self.clock.render_tick(now_ms)?;
        self.render_tick = Some(r);
        let write = |player_id: u32, s: PlayerSample| player_record(player_id, s, s.pos, space);
        let target_us = f64::from(r) * self.tick_us();
        let handles: Vec<u32> = self.remote.ids().collect();
        for handle in handles {
            let Ok(handle8) = u8::try_from(handle) else { continue };
            let id = match &self.roster {
                Some(roster) => match roster.get(&handle8) {
                    Some(&id) => id,
                    None => continue,
                },
                None => handle,
            };
            if id == self.local_player_id {
                continue;
            }
            if let Some(s) = self.remote.sample(handle, target_us) {
                remote.push(write(id, from_interp(&s)));
            }
        }
        Some((r, self.local.at(r)))
    }

    /// The dynamic bodies at the last sampled render tick, in `space`.
    pub fn dynamic_bodies(&self, space: Space, out: &mut Vec<VlDynamicBody>) {
        let Some(r) = self.render_tick else { return };
        for (handle, track) in &self.bodies {
            let Some(&(body_id, shape, half)) = self.body_meta.get(handle) else { continue };
            let Some((p, q)) = track.at(r) else { continue };
            out.push(VlDynamicBody {
                body_id,
                shape: u32::from(shape),
                pos: space.pos(p),
                quat: space.quat(q),
                half_extents: space.extents(if u32::from(shape) == VL_SHAPE_SPHERE { Vec3::splat(half.x) } else { half }),
            });
        }
    }

    /// A snapshot vehicle's pose at the last sampled render tick, in server space.
    pub fn vehicle_pose(&self, handle: u8) -> Option<(Vec3, Quat)> {
        self.vehicles.get(&handle)?.at(self.render_tick?)
    }

    /// A snapshot car's newest authoritative state (server space).
    pub fn newest_vehicle(&self, handle: u8) -> Option<&NewestCar> {
        self.vehicle_newest.get(&handle)
    }

    /// The snapshot's vehicle handles.
    pub fn vehicle_handles(&self) -> impl Iterator<Item = u8> + '_ {
        self.vehicles.keys().copied()
    }

    pub fn local_player_id(&self) -> u32 {
        self.local_player_id
    }

    /// The interpolation delay in ticks (render time trails the newest snapshot by this).
    pub fn delay_ticks(&self) -> f32 {
        self.clock.delay_ticks
    }

    /// The server tick the client estimates has been produced by now: the newest tick the render
    /// clock has seen, extrapolated (render tick + delay). `None` before the first snapshot.
    pub fn server_tick_now(&self) -> Option<f32> {
        Some(self.render_tick? + self.clock.delay_ticks)
    }

    /// A remote player's interpolated state at render tick `r`.
    #[cfg(test)]
    pub(crate) fn remote_at(&self, handle: u8, r: f32) -> Option<PlayerSample> {
        self.remote.sample(u32::from(handle), f64::from(r) * self.tick_us()).map(|s| from_interp(&s))
    }

    /// One server tick in microseconds, as the web counts it (`SERVER_TICK_US`: floor(1e6 / sim Hz)).
    fn tick_us(&self) -> f64 {
        (1_000_000 / self.sim_hz) as f64
    }
}

/// A player record in the renderer's space, drawn at `pos` (server space).
pub(crate) fn player_record(player_id: u32, s: PlayerSample, pos: Vec3, space: Space) -> VlPlayer {
    let (yaw, pitch) = space.yaw_pitch(s.yaw, s.pitch);
    VlPlayer {
        player_id,
        flags: VL_PLAYER_VALID,
        pos: space.pos(pos),
        yaw,
        pitch,
        hp: u32::from(s.hp),
        vel: space.pos(s.vel),
        state_flags: u32::from(s.flags),
    }
}

/// A web-interpolated remote player as the renderer's sample.
fn from_interp(s: &crate::interp::PlayerSample) -> PlayerSample {
    let v = |a: [f64; 3]| Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32);
    PlayerSample {
        pos: v(s.position),
        vel: v(s.velocity),
        yaw: s.yaw as f32,
        pitch: s.pitch as f32,
        hp: s.hp as u8,
        flags: s.flags as u8,
    }
}

fn lerp(a: PlayerSample, b: PlayerSample, t: f32) -> PlayerSample {
    PlayerSample {
        pos: a.pos.lerp(b.pos, t),
        vel: a.vel.lerp(b.vel, t),
        yaw: lerp_angle(a.yaw, b.yaw, t),
        pitch: a.pitch + (b.pitch - a.pitch) * t,
        hp: if t < 0.5 { a.hp } else { b.hp },
        flags: if t < 0.5 { a.flags } else { b.flags },
    }
}

/// Interpolate along the shorter way round.
fn lerp_angle(a: f32, b: f32, t: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    let mut d = (b - a) % tau;
    if d > std::f32::consts::PI {
        d -= tau;
    } else if d < -std::f32::consts::PI {
        d += tau;
    }
    a + d * t
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_land_shared::protocol::{PlayerRosterEntry, RemotePlayerStateV2, SnapshotV2Packet};

    fn snap(tick: u32, x_mm: i32, remote_dx: i16) -> SnapshotV2Packet {
        SnapshotV2Packet {
            server_tick: tick,
            anchor_px_mm: x_mm,
            remote_players: vec![RemotePlayerStateV2 { handle: 3, dx_q2_5mm: remote_dx, hp: 100, ..Default::default() }],
            ..Default::default()
        }
    }

    #[test]
    fn remote_players_are_anchor_plus_delta_and_named_by_the_roster() {
        let mut p = Players::new(60, 33);
        p.set_local_player(1);
        p.on_roster(&PlayerRosterPacket { entries: vec![PlayerRosterEntry { handle: 3, player_id: 42 }] });
        let ms = |tick: u32| f64::from(tick) * 1000.0 / 60.0;
        for tick in 0..30 {
            p.on_snapshot(&snap(tick, 1000, 400), ms(tick));
        }
        let mut remote = Vec::new();
        let (_, local) = p.sample(ms(30), Space::Server, &mut remote).unwrap();
        assert_eq!(p.local_player_id(), 1);
        assert!((local.unwrap().pos.x - 1.0).abs() < 1e-6);
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].player_id, 42);
        // 400 units of 2.5 mm = 1 m beyond the anchor.
        assert!((remote[0].pos[0] - 2.0).abs() < 1e-6, "{:?}", remote[0].pos);
    }

    #[test]
    fn interpolation_moves_linearly_between_snapshots() {
        let mut p = Players::new(60, 33);
        let ms = |tick: u32| f64::from(tick) * 1000.0 / 60.0;
        // The local player walks +x at 6 m/s: 100 mm per tick.
        for tick in 0..120 {
            p.on_snapshot(&snap(tick, tick as i32 * 100, 0), ms(tick));
        }
        let mut remote = Vec::new();
        let (r, local) = p.sample(ms(120), Space::Server, &mut remote).unwrap();
        // Drawn at the render tick: x = 0.1 m per tick there.
        let x = local.unwrap().pos.x;
        assert!((x - 0.1 * r).abs() < 1e-3, "x {x} at tick {r}");
    }

    fn snap_without_remote(tick: u32) -> SnapshotV2Packet {
        SnapshotV2Packet { server_tick: tick, ..Default::default() }
    }

    #[test]
    fn a_resting_player_the_server_stops_resending_stays_until_the_roster_drops_them() {
        // snapshot_builder.rs `idle_cold`: an unchanged remote player is sent a few times, then only
        // on a cold refresh. The client keeps it, as the web client does, until the roster drops it.
        let mut p = Players::new(60, 33);
        p.set_snapshot_hz(30);
        p.set_local_player(1);
        p.on_roster(&PlayerRosterPacket { entries: vec![PlayerRosterEntry { handle: 3, player_id: 42 }] });
        let ms = |tick: u32| f64::from(tick) * 1000.0 / 60.0;
        for tick in (0..10).map(|i| i * 2) {
            p.on_snapshot(&snap(tick, 0, 400), ms(tick));
        }
        for tick in (10..60).map(|i| i * 2) {
            p.on_snapshot(&snap_without_remote(tick), ms(tick));
        }
        let mut remote = Vec::new();
        p.sample(ms(120), Space::Server, &mut remote).unwrap();
        assert_eq!(remote.len(), 1, "a player at rest must not vanish between cold refreshes");
        assert!((remote[0].pos[0] - 1.0).abs() < 1e-6, "{:?}", remote[0].pos);

        p.on_roster(&PlayerRosterPacket { entries: vec![] });
        remote.clear();
        p.sample(ms(122), Space::Server, &mut remote).unwrap();
        assert!(remote.is_empty(), "the roster dropped the player");
    }

    #[test]
    fn a_player_resent_after_a_gap_holds_still_until_the_snapshot_before_it_moved() {
        let mut p = Players::new(60, 33);
        p.set_snapshot_hz(30);
        p.set_local_player(1);
        p.on_roster(&PlayerRosterPacket { entries: vec![PlayerRosterEntry { handle: 3, player_id: 42 }] });
        let ms = |tick: u32| f64::from(tick) * 1000.0 / 60.0;
        // At rest at dx=0 until tick 10, then silent, then seen at dx=400 (1 m) at tick 40.
        for tick in [0u32, 2, 4, 6, 8, 10] {
            p.on_snapshot(&snap(tick, 0, 0), ms(tick));
        }
        for tick in (12..40).step_by(2) {
            p.on_snapshot(&snap_without_remote(tick), ms(tick));
        }
        p.on_snapshot(&snap(40, 0, 400), ms(40));
        // Halfway between ticks 10 and 40 the player is still where it stood: the hold at tick 38.
        let at = |p: &Players, r: f32| p.remote_at(3, r).map(|s| s.pos.x);
        assert!((at(&p, 25.0).unwrap() - 0.0).abs() < 1e-6, "moved before it did: {:?}", at(&p, 25.0));
        assert!((at(&p, 39.0).unwrap() - 0.5).abs() < 1e-3, "{:?}", at(&p, 39.0));
    }

    #[test]
    fn angles_take_the_short_way() {
        let a = 179f32.to_radians();
        let b = (-179f32).to_radians();
        let mid = lerp_angle(a, b, 0.5).to_degrees();
        assert!((mid.abs() - 180.0).abs() < 1e-3, "{mid}");
    }
    #[test]
    fn dynamic_bodies_interpolate_carry_their_shape_and_leave_when_removed() {
        use vibe_land_shared::protocol::{DynamicBodyMetaEntry, DynamicSphereStateV2, SnapshotRemoval};
        let mut p = Players::new(60, 33);
        p.on_body_meta(&DynamicBodyMetaPacket {
            entries: vec![DynamicBodyMetaEntry { handle: 4, body_id: 900, shape_type: 1, hx_cm: 50, hy_cm: 50, hz_cm: 50 }],
        });
        let ms = |tick: u32| f64::from(tick) * 1000.0 / 60.0;
        // Falling 2.5 mm per tick in y (one q2.5mm unit).
        let snap = |tick: u32| SnapshotV2Packet {
            server_tick: tick,
            sphere_states: vec![DynamicSphereStateV2 { handle: 4, dy_q2_5mm: -(tick as i16), ..Default::default() }],
            ..Default::default()
        };
        for tick in 0..60 {
            p.on_snapshot(&snap(tick), ms(tick));
        }
        let mut remote = Vec::new();
        let (r, _) = p.sample(ms(60), Space::Server, &mut remote).unwrap();
        let mut bodies = Vec::new();
        p.dynamic_bodies(Space::Server, &mut bodies);
        assert_eq!(bodies.len(), 1);
        assert_eq!((bodies[0].body_id, bodies[0].shape), (900, 1));
        assert_eq!(bodies[0].half_extents, [0.5, 0.5, 0.5]);
        assert!((bodies[0].pos[1] + 0.0025 * r).abs() < 1e-4, "y {} at tick {r}", bodies[0].pos[1]);

        // A vehicle's removal (0x8000 | handle) leaves bodies alone; the body's own removes it.
        let mut gone = SnapshotV2Packet { server_tick: 61, removals: vec![SnapshotRemoval { handle: 0x8000 | 4, age_ticks: 0 }], ..Default::default() };
        p.on_snapshot(&gone, ms(61));
        bodies.clear();
        p.dynamic_bodies(Space::Server, &mut bodies);
        assert_eq!(bodies.len(), 1);
        gone.server_tick = 62;
        gone.removals = vec![SnapshotRemoval { handle: 4, age_ticks: 0 }];
        p.on_snapshot(&gone, ms(62));
        bodies.clear();
        p.dynamic_bodies(Space::Server, &mut bodies);
        assert!(bodies.is_empty());
    }
}
