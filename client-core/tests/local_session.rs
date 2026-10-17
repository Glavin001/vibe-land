//! The client core against the real match loop, in process (`server/src/local_session.rs`), on the
//! physics-free synthetic city (`VIBE_CITY_SYNTHETIC=1`): no sockets and no GPU, so CI can run it.
//! The match runs in lockstep, one tick per step, and every packet is delivered at its tick's time.
//!
//! Gates come from the protocol: every packet decodes, the client's structure hashes agree with the
//! server's, and snapshots arrive at the session's snapshot rate. The synthetic city has no
//! colliders, so shots and meteors do nothing in a match (`server/src/city.rs`); fractures and the
//! free fall of the bodies they free are gated against a PhysX server by `vl-headless`
//! (`client-core/examples/headless.rs`).

use std::io::Read;

use vibe_client_core::coords::Space;
use vibe_client_core::frame::{VlCoreState, VL_BODY_REMOVED, VL_BODY_STANDING};
use vibe_client_core::{ClientCore, Lane};
use vibe_land_shared::net_client::SessionConfig;
use web_fps_server::local_session::LocalSession;

const TICK_US: u64 = 16_667;

struct Harness {
    session: LocalSession,
    core: ClientCore,
    tick: u32,
    /// Every body pose seen: (body key, render tick, server-space y).
    falls: std::collections::HashMap<(u32, u32), Vec<(f32, f32)>>,
    assigned_to_bodies: usize,
    removed: usize,
}

impl Harness {
    fn start(match_id: &str) -> Self {
        std::env::set_var("VIBE_CITY_SYNTHETIC", "1");
        std::env::set_var("VIBE_PHYSICS_BACKEND", "rapier");
        let session = LocalSession::start_with(match_id, true).expect("start the in-process match");
        let mut core = ClientCore::new(Space::Server);

        let config = SessionConfig::from_json(session.session_config_json().as_bytes()).expect("session config");
        assert_eq!(config.city_wire(), 4, "a citypp match must stream wire 4");
        let hash = config.city_manifest_hash.clone().expect("the city match names its manifest");
        core.on_session_config(config);

        let response = session.request(&format!("/city-manifest/{hash}")).expect("manifest route");
        assert_eq!(response.status, 200);
        let mut manifest = Vec::new();
        if response.content_encoding.as_deref() == Some("gzip") {
            flate2::read::GzDecoder::new(response.body.as_slice()).read_to_end(&mut manifest).unwrap();
        } else {
            manifest = response.body;
        }
        core.on_manifest(&manifest);
        assert_eq!(core.state(), VlCoreState::WaitingForWelcome, "{:?}", core.last_error());

        Self { session, core, tick: 0, falls: Default::default(), assigned_to_bodies: 0, removed: 0 }
    }

    fn run(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.tick = self.session.step(1).expect("step the match");
            let arrival_us = u64::from(self.tick) * TICK_US;
            let core = &mut self.core;
            self.session
                .drain(|reliable, bytes| {
                    let lane = if reliable { Lane::Reliable } else { Lane::Datagram };
                    core.on_packet(lane, &bytes, arrival_us);
                })
                .expect("drain the match's packets");
            let frame = self.core.poll(arrival_us + TICK_US / 2);
            let r = frame.stats.city_render_tick;
            for a in &frame.assignments {
                match a.body {
                    VL_BODY_STANDING => {}
                    VL_BODY_REMOVED => self.removed += 1,
                    _ => self.assigned_to_bodies += 1,
                }
            }
            for pose in &frame.body_poses {
                self.falls.entry((pose.structure, pose.body)).or_default().push((r, pose.pos[1]));
            }
            let outgoing: Vec<_> = self.core.drain_outgoing().collect();
            for packet in outgoing {
                self.session.send(&packet.bytes).expect("send to the match");
            }
        }
    }

    fn stats(&mut self) -> vibe_client_core::frame::VlStats {
        self.core.poll(u64::from(self.tick) * TICK_US + TICK_US / 2).stats
    }
}

#[test]
fn the_core_follows_a_wire_4_city_match_end_to_end() {
    let mut h = Harness::start("citypp-core-e2e");
    let config = h.core.session_config().unwrap().clone();
    let chunks = h.core.chunks().len();
    assert!(chunks > 0, "the manifest has chunks");

    // Two seconds of play: joined, snapshots at the session's rate, the city bootstrapped.
    h.run(120);
    let stats = h.stats();
    assert_eq!(h.core.state(), VlCoreState::Playing, "{:?}", h.core.last_error());
    assert!(stats.player_id > 0);
    let expected_snapshots = 120.0 * f64::from(config.snapshot_hz) / f64::from(config.sim_hz);
    assert!(
        stats.snapshots as f64 >= 0.95 * expected_snapshots,
        "{} snapshots in 120 ticks at {} Hz (expected ≥ {:.0})",
        stats.snapshots,
        config.snapshot_hz,
        0.95 * expected_snapshots
    );
    assert!(stats.bootstraps >= 1, "no wire 4 bootstrap: {stats:?}");
    assert_eq!(stats.chunks as usize, chunks);
    assert!(stats.city_render_tick.is_finite(), "the city clock never started");
    assert!(stats.player_render_tick.is_finite(), "the player clock never started");
    assert!(h.core.poll(u64::from(h.tick) * TICK_US).local.player.flags & 1 == 1, "no local player state");

    // Six more seconds: the server's per-structure hash checks (carried in events packets) arrive.
    h.run(360);
    let stats = h.stats();
    assert_eq!(stats.hash_mismatches, 0, "the client's structures diverged from the server's");
    assert!(stats.hash_checks > 0, "the server never checked the client's structures");
    assert_eq!(stats.decode_errors, 0, "{stats:?}");
    assert!(stats.acks_sent > 0, "the client never acked a keyframe datagram");
}

/// M2's movement gate: input sent through the core's 60 Hz bundler moves the server's player at
/// the server's walk speed (`MoveConfig::walk_speed`, 6 m/s), measured from the snapshots once the
/// player is up to speed, along the direction the view faces.
#[test]
fn input_from_the_core_walks_the_server_player_at_walk_speed() {
    use vibe_client_core::frame::VlInput;
    let mut h = Harness::start("citypp-core-walk");
    h.run(120); // join, land
    let yaw = 0.7f32;
    h.core.set_input(&VlInput { move_x: 0.0, move_y: 1.0, yaw, pitch: 0.0, buttons: 0 });
    h.run(60); // accelerate (ground accel 80 m/s²: 6 m/s within 0.1 s) and let the prediction settle
    let at = |h: &mut Harness| {
        let local = h.core.poll(u64::from(h.tick) * TICK_US + TICK_US / 2).local;
        (local.player.pos, local.prediction_offset_m)
    };
    let (start, offset_start) = at(&mut h);
    let seconds = 2.0f32;
    h.run((seconds * 60.0) as u32);
    let (end, offset_end) = at(&mut h);
    let (dx, dz) = (end[0] - start[0], end[2] - start[2]);
    let speed = dx.hypot(dz) / seconds;
    let walk = vibe_netcode::movement::MoveConfig::default().walk_speed as f32;
    // The presented pose carries the predictor's lead at both ends; at steady state it is the
    // same lead, so it cancels.
    assert!((offset_start - offset_end).abs() < 0.02, "prediction not steady: {offset_start} vs {offset_end}");
    assert!((speed - walk).abs() <= 0.05 * walk, "walked {speed:.3} m/s, server walk speed {walk}");
    let heading = dx.atan2(dz);
    assert!((heading - yaw).abs() < 0.02, "walked toward {heading:.3} rad, faced {yaw}");
    assert!((end[1] - start[1]).abs() < 0.05, "left the ground: {start:?} -> {end:?}");
}

/// A rifle shot from the core is resolved by the server: the shooter gets its verdict (ShotResult)
/// and everyone the shot (ShotFired), starting at the shooter's eye and pointing where it aimed.
/// The synthetic city has no colliders, so this checks the protocol round trip, not damage.
#[test]
fn a_shot_from_the_core_comes_back_resolved_by_the_server() {
    use vibe_client_core::frame::{VlInput, VL_EVENT_LOCAL_SHOT, VL_EVENT_SHOT_FIRED, VL_EVENT_SHOT_RESULT, VL_WEAPON_RIFLE};
    let mut h = Harness::start("citypp-core-shot");
    h.run(120);
    let (yaw, pitch) = (1.2f32, 0.3f32);
    h.core.set_input(&VlInput { yaw, pitch, ..Default::default() });
    h.run(30); // the view reaches the server
    let now = u64::from(h.tick) * TICK_US + TICK_US / 2;
    let eye = h.core.poll(now).local.eye;
    let shot = h.core.fire(VL_WEAPON_RIFLE, now);
    assert!(shot > 0);
    assert_eq!(h.core.fire(VL_WEAPON_RIFLE, now + 50_000), 0, "fired inside the 100 ms interval");
    let me = h.core.frame().stats.player_id;

    let mut events = Vec::new();
    for _ in 0..30 {
        let outgoing: Vec<_> = h.core.drain_outgoing().collect();
        for packet in outgoing {
            h.session.send(&packet.bytes).unwrap();
        }
        h.tick = h.session.step(1).unwrap();
        let arrival = u64::from(h.tick) * TICK_US;
        let core = &mut h.core;
        h.session.drain(|reliable, bytes| core.on_packet(if reliable { Lane::Reliable } else { Lane::Datagram }, &bytes, arrival)).unwrap();
        events.extend(h.core.poll(arrival + TICK_US / 2).events.iter().copied());
    }
    let local = events.iter().find(|e| e.kind == VL_EVENT_LOCAL_SHOT).expect("no local shot event");
    assert_eq!(local.id, shot);
    let result = events.iter().find(|e| e.kind == VL_EVENT_SHOT_RESULT && e.id == shot).expect("no ShotResult for the shot");
    assert_eq!(result.weapon, u32::from(VL_WEAPON_RIFLE as u8));
    let fired = events.iter().find(|e| e.kind == VL_EVENT_SHOT_FIRED && e.id == shot).expect("no ShotFired for the shot");
    assert_eq!(fired.player, me);
    let origin = glam::Vec3::from_array(fired.p0);
    assert!((origin - glam::Vec3::from_array(eye)).length() < 0.25, "shot from {origin}, eye at {eye:?}");
    let dir = (glam::Vec3::from_array(fired.p1) - origin).normalize();
    let aimed = glam::Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    assert!(dir.dot(aimed) > 0.999, "shot along {dir}, aimed {aimed}");
}

/// The aerial camera's drop: the server moves the player to the pose the core sends (and the
/// player then falls to the ground below it).
#[test]
fn a_camera_drop_from_the_core_moves_the_server_player() {
    let mut h = Harness::start("citypp-core-drop");
    h.run(120);
    let target = [57.0f32, 3.0, -61.0];
    h.core.camera_drop(target, 0.5, 0.0);
    h.run(90);
    let pos = h.core.poll(u64::from(h.tick) * TICK_US + TICK_US / 2).local.player.pos;
    let horizontal = (pos[0] - target[0]).hypot(pos[2] - target[2]);
    assert!(horizontal < 0.5, "dropped at {target:?}, player at {pos:?}");
    assert!(pos[1] < target[1], "the player should have fallen from the drop height: {pos:?}");
}

/// Cars: the stream carries them (on the car clock), their assets are announced, and a player who
/// asks to drive one next to it is put in it; throttle moves it; leaving puts the player out.
#[test]
fn a_player_enters_drives_and_leaves_a_car() {
    use vibe_client_core::frame::{VlInput, VL_EVENT_VEHICLE_ASSET};
    let mut h = Harness::start("citypp-core-car");
    let mut assets = Vec::new();
    for _ in 0..180 {
        h.run(1);
        assets.extend(h.core.frame().events.iter().filter(|e| e.kind == VL_EVENT_VEHICLE_ASSET).map(|e| e.id));
    }
    let cars = h.core.poll(u64::from(h.tick) * TICK_US + TICK_US / 2).cars.clone();
    eprintln!("cars {}: {:?}; assets {:?}", cars.len(), cars.iter().map(|c| (c.handle, c.pos)).collect::<Vec<_>>(), assets);
    if cars.is_empty() {
        eprintln!("this server fields no cars (synthetic city without vehicles); driving is gated in Unreal against PhysX");
        return;
    }
    let car = cars[0];
    // Only the destructible garage builds announce an asset (PKT_VEHICLE_ASSET); stock cars draw
    // from their vehicle type, so an asset is not required to drive one.
    eprintln!("car {} asset: {}", car.handle, h.core.vehicle_asset(car.handle).is_some());
    // Stand beside it and ask to drive.
    h.core.camera_drop([car.pos[0] + 1.5, car.pos[1] + 1.0, car.pos[2]], 0.0, 0.0);
    h.run(60);
    h.core.enter_vehicle(car.handle);
    h.run(30);
    assert!(h.core.in_vehicle(), "the server did not seat the player in car {}", car.handle);
    let start = h.core.frame().cars.iter().find(|c| c.handle == car.handle).unwrap().pos;
    h.core.set_input(&VlInput { move_y: 1.0, ..Default::default() });
    h.run(120);
    let end = h.core.poll(u64::from(h.tick) * TICK_US + TICK_US / 2).cars.iter().find(|c| c.handle == car.handle).unwrap().pos;
    let moved = (end[0] - start[0]).hypot(end[2] - start[2]);
    assert!(moved > 2.0, "throttle moved the car {moved} m");
    h.core.set_input(&VlInput::default());
    h.core.exit_vehicle();
    h.run(30);
    assert!(!h.core.in_vehicle(), "still in the car after leaving");
}
