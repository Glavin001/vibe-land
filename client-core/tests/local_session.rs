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
    assert!(h.core.poll(u64::from(h.tick) * TICK_US).local.flags & 1 == 1, "no local player state");

    // Six more seconds: the server's per-structure hash checks (carried in events packets) arrive.
    h.run(360);
    let stats = h.stats();
    assert_eq!(stats.hash_mismatches, 0, "the client's structures diverged from the server's");
    assert!(stats.hash_checks > 0, "the server never checked the client's structures");
    assert_eq!(stats.decode_errors, 0, "{stats:?}");
    assert!(stats.acks_sent > 0, "the client never acked a keyframe datagram");
}
