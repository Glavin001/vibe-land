//! vl-headless: the client core on a real WebTransport session, with no renderer.
//!
//!   cargo run -p vibe-client-core --release --example headless -- \
//!       --api http://127.0.0.1:4001 --match citypp-hl --seconds 30 [--meteor-after 5] [--gate]
//!
//! Prints a status line a second and the final stats. `--meteor-after S` drops a meteor (POST
//! /city-meteor/<match>) on the first building's highest chunk S seconds after joining; needs a
//! PhysX server (the synthetic city ignores meteors). `--gate` exits non-zero unless:
//! `--jump` holds jump and `--drop x,y,z` places the player (a stand-in other player for tests).
//!   * the client received ≥ 95% of the snapshots the server produced since joining (server
//!     ticks elapsed × snapshot_hz / sim_hz). That measures delivery, not the server's speed: a
//!     server sharing the GPU with a renderer can tick slower than real time, and the summary
//!     reports that separately as `server_sim_rate`;
//!   * no packet failed to decode and the client's structure hashes never disagreed;
//!   * with a meteor: at least one fracture, and some freed body's first 0.3 s of fall fits an
//!     acceleration within 0.5 m/s² of the city's gravity (9.81 m/s²).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

use vibe_client_core::coords::Space;
use vibe_client_core::frame::VlCoreState;
use vibe_client_core::{ClientCore, Lane};
use vibe_client_transport_wt::{Inbound, Lane as WireLane, Transport, TransportConfig, TransportState};

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let api = flag("--api").unwrap_or_else(|| "http://127.0.0.1:4001".into());
    let match_id = flag("--match").unwrap_or_else(|| "citypp-headless".into());
    let seconds: f64 = flag("--seconds").map_or(30.0, |v| v.parse().expect("--seconds"));
    let meteor_after: Option<f64> = flag("--meteor-after").map(|v| v.parse().expect("--meteor-after"));
    let gate = std::env::args().any(|a| a == "--gate");
    // A stand-in player for other clients' tests: --jump holds jump (it hops whenever grounded),
    // --drop x,y,z (server metres) places it once joined.
    let jump = std::env::args().any(|a| a == "--jump");
    // --walk: hold forward (server yaw 0, +z) after 2 s and print each new snapshot's tick, the
    // acknowledged position and input sequence, and the server's velocity.
    let walk = std::env::args().any(|a| a == "--walk");
    let mut last_walk_tick = 0u32;
    let drop: Option<[f32; 3]> = flag("--drop").map(|v| {
        let p: Vec<f32> = v.split(',').map(|x| x.trim().parse().expect("--drop x,y,z")).collect();
        [p[0], p[1], p[2]]
    });
    let mut dropped = false;
    let poll_ms: u64 = flag("--poll-ms").map_or(4, |v| v.parse().expect("--poll-ms"));

    let transport = Transport::start(TransportConfig::new(&api, &match_id)).expect("start transport");
    let mut core = ClientCore::new(Space::Server);
    let started = Instant::now();
    let mut joined_at: Option<Instant> = None;
    // Sounds and dust puffs the core emitted (client-core audio.rs, effects.rs).
    let (mut sounds, mut dust) = (0usize, 0usize);
    // (server tick, snapshots received) at the first snapshot after joining: the core reaches
    // Playing at Welcome, before any snapshot has carried a tick.
    let mut at_join: Option<(u32, u64)> = None;
    let mut meteor_sent = false;
    let mut last_print = Instant::now();
    let mut tracks: HashMap<(u32, u32), Vec<(f32, f32)>> = HashMap::new();
    let mut closed: Option<String> = None;
    // Frames on which the set of remote players changed (a stable match should change rarely).
    let (mut last_remote, mut remote_changes, mut polls) = (Vec::<u32>::new(), 0u64, 0u64);

    while started.elapsed().as_secs_f64() < seconds && closed.is_none() {
        while let Some(event) = transport.try_recv() {
            match event {
                Inbound::State(state) => {
                    eprintln!("vl-headless: {state:?}");
                    if let TransportState::Closed(r) | TransportState::Failed(r) = state {
                        closed = Some(r);
                    }
                }
                Inbound::SessionConfig(config) => {
                    eprintln!("vl-headless: session {} wire {} snapshot {} Hz", config.match_id, config.city_wire(), config.snapshot_hz);
                    core.on_session_config(config);
                }
                Inbound::Manifest(bytes) => {
                    core.on_manifest(&bytes);
                    eprintln!("vl-headless: manifest {} bytes, {} chunks", bytes.len(), core.chunks().len());
                }
                Inbound::Packet { lane, bytes, arrival_us } => {
                    let lane = if lane == WireLane::Reliable { Lane::Reliable } else { Lane::Datagram };
                    core.on_packet(lane, &bytes, arrival_us);
                }
            }
        }
        if core.state() == VlCoreState::Failed {
            eprintln!("vl-headless: core failed: {}", core.last_error().unwrap_or("?"));
            std::process::exit(2);
        }

        let frame = core.poll(transport.now_us()).clone();
        let r = frame.stats.city_render_tick;
        let mut ids: Vec<u32> = frame.remote_players.iter().map(|p| p.player_id).collect();
        ids.sort_unstable();
        polls += 1;
        if ids != last_remote {
            remote_changes += 1;
            last_remote = ids;
        }
        sounds += frame.sounds.len();
        dust += frame.dust.len();
        for pose in &frame.body_poses {
            tracks.entry((pose.structure, pose.body)).or_default().push((r, pose.pos[1]));
        }
        if joined_at.is_none() && core.state() == VlCoreState::Playing {
            joined_at = Some(Instant::now());
            if jump {
                core.set_input(&vibe_client_core::frame::VlInput { buttons: vibe_client_core::frame::VL_BTN_JUMP, ..Default::default() });
            }
        }
        if let (Some(p), false, Some(j)) = (drop, dropped, joined_at) {
            if j.elapsed().as_secs_f64() > 1.0 {
                core.camera_drop(p, 0.0, 0.0);
                dropped = true;
            }
        }
        if let (true, Some(j)) = (walk, joined_at) {
            if j.elapsed().as_secs_f64() > 2.0 {
                core.set_input(&vibe_client_core::frame::VlInput { move_y: 1.0, ..Default::default() });
                if frame.stats.newest_server_tick != last_walk_tick {
                    last_walk_tick = frame.stats.newest_server_tick;
                    let (p, v) = (frame.local.acked_pos, frame.local.player.vel);
                    println!("walk tick={} ack={} pos=({:.3},{:.3},{:.3}) vel=({:.2},{:.2},{:.2})", last_walk_tick, frame.local.ack_input_seq, p[0], p[1], p[2], v[0], v[1], v[2]);
                }
            }
        }
        if at_join.is_none() && joined_at.is_some() && frame.stats.snapshots > 0 {
            at_join = Some((frame.stats.newest_server_tick, frame.stats.snapshots));
        }
        let outgoing: Vec<_> = core.drain_outgoing().collect();
        for packet in outgoing {
            if packet.datagram {
                transport.send_datagram(&packet.bytes);
            } else {
                transport.send_reliable(&packet.bytes);
            }
        }

        if let (Some(after), Some(joined)) = (meteor_after, joined_at) {
            if !meteor_sent && joined.elapsed().as_secs_f64() >= after {
                meteor_sent = true;
                let first = core.chunks().first().map(|c| c.structure);
                let target = core
                    .chunks()
                    .iter()
                    .filter(|c| Some(c.structure) == first)
                    .map(|c| c.rest_pos)
                    .fold([0.0f32, f32::MIN, 0.0], |b, p| if p[1] > b[1] { p } else { b });
                let body = format!("{{\"targets\":[[{},{},{}]]}}", target[0], target[1], target[2]);
                match http_post(&api, &format!("/city-meteor/{match_id}"), &body) {
                    Ok(status) => eprintln!("vl-headless: meteor at {target:?}: {status}"),
                    Err(e) => eprintln!("vl-headless: meteor request failed: {e}"),
                }
            }
        }

        if last_print.elapsed() >= Duration::from_secs(1) {
            last_print = Instant::now();
            let s = &frame.stats;
            let ts = transport.stats();
            eprintln!(
                "vl-headless: t={:.0}s state={} remote={:?} remote_changes={}/{} snaps={} tick={} city_r={:.1} bodies={} fractures={} keyframes={} hash={}/{} decode_err={} rtt={}us dg_in={}",
                started.elapsed().as_secs_f64(), s.state, last_remote, remote_changes, polls, s.snapshots, s.newest_server_tick, s.city_render_tick,
                s.live_bodies, s.fractures, s.keyframes, s.hash_checks, s.hash_mismatches, s.decode_errors,
                ts.rtt_us.load(std::sync::atomic::Ordering::Relaxed),
                ts.datagrams_in.load(std::sync::atomic::Ordering::Relaxed),
            );
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }

    let stats = core.poll(transport.now_us()).stats;
    let joined_s = joined_at.map_or(0.0, |j| j.elapsed().as_secs_f64());
    let config = core.session_config().cloned();
    let snapshot_hz = config.as_ref().map_or(0.0, |c| f64::from(c.snapshot_hz));
    let sim_hz = config.as_ref().map_or(60.0, |c| f32::from(c.sim_hz));
    let fall = best_free_fall(&tracks, sim_hz);
    let at_join = at_join.unwrap_or((stats.newest_server_tick, stats.snapshots));
    let server_ticks = f64::from(stats.newest_server_tick.wrapping_sub(at_join.0));
    let expected_snapshots = server_ticks * snapshot_hz / f64::from(sim_hz);
    let received_snapshots = (stats.snapshots - at_join.1) as f64;
    let server_sim_rate = server_ticks / (f64::from(sim_hz) * joined_s.max(1e-9));
    println!(
        "{{\"joined_s\":{joined_s:.2},\"snapshots\":{},\"snapshot_rate\":{:.2},\"snapshot_hz\":{snapshot_hz},\"server_sim_rate\":{server_sim_rate:.3},\"snapshots_expected\":{expected_snapshots:.0},\"chunks\":{},\"fractures\":{},\"keyframes\":{},\"late_keyframes\":{},\"hash_checks\":{},\"hash_mismatches\":{},\"decode_errors\":{},\"unknown_packets\":{},\"acks\":{},\"bodies_tracked\":{},\"sounds\":{sounds},\"dust\":{dust},\"free_fall_accel\":{},\"closed\":{:?}}}",
        stats.snapshots, stats.snapshots as f64 / joined_s.max(1e-9), stats.chunks, stats.fractures, stats.keyframes,
        stats.late_keyframes, stats.hash_checks, stats.hash_mismatches, stats.decode_errors, stats.unknown_packets,
        stats.acks_sent, tracks.len(), fall.map_or("null".to_string(), |a| format!("{a:.3}")), closed,
    );

    if gate {
        let mut failures = Vec::new();
        if joined_at.is_none() {
            failures.push("never joined".to_string());
        }
        if expected_snapshots < 1.0 {
            failures.push("the server produced no ticks after the join".into());
        } else if received_snapshots < 0.95 * expected_snapshots {
            failures.push(format!(
                "received {received_snapshots} of {expected_snapshots:.0} snapshots the server produced ({server_ticks} ticks at {snapshot_hz}/{sim_hz} Hz)"
            ));
        }
        if stats.decode_errors != 0 {
            failures.push(format!("{} decode errors", stats.decode_errors));
        }
        if stats.hash_mismatches != 0 {
            failures.push(format!("{} hash mismatches", stats.hash_mismatches));
        }
        if meteor_after.is_some() {
            if stats.fractures == 0 {
                failures.push("the meteor fractured nothing".into());
            }
            match fall {
                Some(a) if (a + 9.81).abs() < 0.5 => {}
                other => failures.push(format!("no body fell at 9.81 ± 0.5 m/s² (best {other:?})")),
            }
        }
        if !failures.is_empty() {
            eprintln!("vl-headless: GATE FAILED: {}", failures.join("; "));
            std::process::exit(1);
        }
        eprintln!("vl-headless: gate passed");
    }
}

/// The free-fall acceleration closest to gravity among tracks with 0.3 s of falling poses.
fn best_free_fall(tracks: &HashMap<(u32, u32), Vec<(f32, f32)>>, hz: f32) -> Option<f32> {
    let window = (0.3 * hz).round() as usize;
    tracks
        .values()
        .filter_map(|track| {
            let w: Vec<_> = track.iter().copied().filter(|(r, _)| r.is_finite()).take(window).collect();
            if w.len() < window || w.windows(2).any(|p| p[1].0 <= p[0].0) || w.last()?.1 >= w[0].1 {
                return None;
            }
            Some(fitted_acceleration(&w, hz))
        })
        .min_by(|a, b| (a + 9.81).abs().total_cmp(&(b + 9.81).abs()))
}

/// Least-squares `a` in y(t) = y0 + v t + a t²/2 (Cramer's rule on the normal equations).
fn fitted_acceleration(samples: &[(f32, f32)], hz: f32) -> f32 {
    let t0 = f64::from(samples[0].0);
    let (mut s, mut b) = ([0f64; 5], [0f64; 3]);
    for &(r, y) in samples {
        let t = (f64::from(r) - t0) / f64::from(hz);
        let y = f64::from(y);
        for (k, sk) in s.iter_mut().enumerate() {
            *sk += t.powi(k as i32);
        }
        b[0] += y;
        b[1] += y * t;
        b[2] += y * t * t;
    }
    let m = [[s[0], s[1], s[2]], [s[1], s[2], s[3]], [s[2], s[3], s[4]]];
    let det = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let mut mc = m;
    for row in 0..3 {
        mc[row][2] = b[row];
    }
    (2.0 * det(mc) / det(m)) as f32
}

/// A minimal HTTP/1.1 POST for a local `http://host:port` API (the dev server).
fn http_post(api: &str, path: &str, body: &str) -> Result<String, String> {
    let host = api.strip_prefix("http://").ok_or("--meteor-after needs an http:// API")?.trim_end_matches('/');
    let mut stream = std::net::TcpStream::connect(host).map_err(|e| e.to_string())?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| e.to_string())?;
    Ok(response.lines().next().unwrap_or("").to_string())
}

#[cfg(test)]
mod tests {
    use super::fitted_acceleration;

    #[test]
    fn fit_recovers_a_known_parabola() {
        let samples: Vec<(f32, f32)> = (0..18).map(|i| (100.0 + i as f32, 20.0 + 1.5 * (i as f32 / 60.0) - 0.5 * 9.81 * (i as f32 / 60.0).powi(2))).collect();
        assert!((fitted_acceleration(&samples, 60.0) + 9.81).abs() < 1e-2);
    }
}
