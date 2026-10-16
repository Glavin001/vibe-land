//! One scripted WebTransport player for checking debris damage live
//! (`VIBE_CITY_DEBRIS_DAMAGE`): it joins a /city match, camera-drops to an
//! exact point and heading, optionally walks forward for a window of time,
//! and prints its own position and HP from every snapshot whose HP changed
//! (and once a second otherwise).
//!
//!   debris-probe --api http://127.0.0.1:6911 --wt-port 6912
//!                --pos x,y,z --yaw 1.57 --duration 40 [--walk 5,12]
//!                [--match city-default]
//!
//! Yaw convention as the client's: forward is (sin yaw, cos yaw) in x/z, so
//! the yaw that faces a target is `atan2(dx, dz)`.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use bytes::BufMut;
use vibe_land_shared::constants::{
    CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE, PKT_CITY_CAMERA_DROP, PKT_CLIENT_HELLO,
    PKT_INPUT_BUNDLE, PKT_SNAPSHOT_V2, PKT_WELCOME, PROTOCOL_VERSION, SIM_HZ,
};
use vibe_netcode::unit_conv::angle_to_i16;

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

fn floats(text: &str) -> Result<Vec<f32>> {
    text.split(',').map(|v| v.trim().parse::<f32>().map_err(Into::into)).collect()
}

fn hello(match_id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(PKT_CLIENT_HELLO);
    out.put_u16_le(match_id.len() as u16);
    out.extend_from_slice(match_id.as_bytes());
    out.put_u16_le(PROTOCOL_VERSION);
    out.push(CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE);
    out
}

fn input_bundle(seq: u16, move_y: i8, yaw: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    out.push(PKT_INPUT_BUNDLE);
    out.push(1);
    out.put_u16_le(seq);
    out.put_u16_le(0);
    out.put_i8(0);
    out.put_i8(move_y);
    out.put_i16_le(angle_to_i16(yaw));
    out.put_i16_le(0);
    out
}

fn camera_drop(position: [f32; 3], yaw: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(21);
    out.push(PKT_CITY_CAMERA_DROP);
    for value in position {
        out.put_f32_le(value);
    }
    out.put_f32_le(yaw);
    out.put_f32_le(0.0);
    out
}

/// (tick, self position m, hp) from a SNAPSHOT_V2: kind, tick u32, ack u16,
/// anchor (the player's own position) 3 x i32 mm, four counts, self
/// velocity/yaw/pitch 5 x i16, then hp.
fn snapshot_v2(bytes: &[u8]) -> Option<(u32, [f32; 3], u8)> {
    if bytes.len() < 34 || bytes[0] != PKT_SNAPSHOT_V2 {
        return None;
    }
    let tick = u32::from_le_bytes(bytes[1..5].try_into().ok()?);
    let mm = |at: usize| i32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as f32 / 1000.0;
    Some((tick, [mm(7), mm(11), mm(15)], bytes[33]))
}

#[tokio::main]
async fn main() -> Result<()> {
    let api = flag("--api").unwrap_or_else(|| "http://127.0.0.1:6911".to_string());
    let wt_port: u16 = flag("--wt-port").map_or(Ok(6912), |v| v.parse())?;
    let match_id = flag("--match").unwrap_or_else(|| "city-default".to_string());
    let pos = floats(&flag("--pos").ok_or_else(|| anyhow!("--pos x,y,z is required"))?)?;
    let pos: [f32; 3] = pos.as_slice().try_into().map_err(|_| anyhow!("--pos needs three values"))?;
    let yaw: f32 = flag("--yaw").map_or(Ok(0.0), |v| v.parse())?;
    let duration = Duration::from_secs_f64(flag("--duration").map_or(Ok(40.0), |v| v.parse())?);
    let walk = match flag("--walk") {
        Some(window) => {
            let w = floats(&window)?;
            Some((w[0] as f64, w[1] as f64))
        }
        None => None,
    };

    let client = reqwest::Client::builder().danger_accept_invalid_certs(true).build()?;
    let config: serde_json::Value = client
        .get(format!("{api}/session-config?match_id={match_id}"))
        .send()
        .await
        .context("GET /session-config")?
        .json()
        .await?;
    let digest: [u8; 32] = hex::decode(
        config["server_certificate_hash_hex"]
            .as_str()
            .ok_or_else(|| anyhow!("session-config has no server_certificate_hash_hex"))?,
    )?
    .as_slice()
    .try_into()
    .map_err(|_| anyhow!("certificate hash is not 32 bytes"))?;

    let wt = wtransport::ClientConfig::builder()
        .with_bind_address("127.0.0.1:0".parse()?)
        .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(digest)])
        .build();
    let endpoint = wtransport::Endpoint::client(wt)?;
    let connection = tokio::time::timeout(
        Duration::from_secs(60),
        endpoint.connect(format!("https://127.0.0.1:{wt_port}/game")),
    )
    .await
    .context("connect timed out")??;
    let (mut send, mut recv) = connection.open_bi().await?.await?;
    let hello = hello(&match_id);
    send.write_all(&(hello.len() as u32).to_le_bytes()).await?;
    send.write_all(&hello).await?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4096);
    let reliable = {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut length = [0u8; 4];
            while recv.read_exact(&mut length).await.is_ok() {
                let len = u32::from_le_bytes(length) as usize;
                if len == 0 || len > 64 * 1024 * 1024 {
                    break;
                }
                let mut frame = vec![0u8; len];
                if recv.read_exact(&mut frame).await.is_err() || tx.send(frame).await.is_err() {
                    break;
                }
            }
        })
    };
    let datagrams = {
        let connection = connection.clone();
        tokio::spawn(async move {
            while let Ok(datagram) = connection.receive_datagram().await {
                let bytes = datagram.payload().to_vec();
                if !bytes.is_empty() && tx.send(bytes).await.is_err() {
                    break;
                }
            }
        })
    };

    let started = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(SIM_HZ)));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut seq: u16 = 0;
    let mut player_id: Option<u32> = None;
    let mut placed_at: Option<Instant> = None;
    let mut last_hp: Option<u8> = None;
    let mut last_print = Instant::now();
    while started.elapsed() < duration {
        tokio::select! {
            _ = ticker.tick() => {
                let since_placed = placed_at.map(|at| at.elapsed().as_secs_f64());
                let moving = matches!((walk, since_placed), (Some((from, to)), Some(t)) if t >= from && t < to);
                let _ = connection.send_datagram(input_bundle(seq, if moving { 127 } else { 0 }, yaw));
                seq = seq.wrapping_add(1);
                // Repeat the drop until it lands near the target (the server
                // rate-limits drops and ignores them while the player is dead).
                if player_id.is_some() && placed_at.is_none() && started.elapsed() > Duration::from_millis(1500) {
                    let _ = connection.send_datagram(camera_drop(pos, yaw));
                    placed_at = Some(Instant::now());
                    println!("probe t={:.2}s camera drop to {pos:?} yaw {yaw:.3}", started.elapsed().as_secs_f64());
                }
            }
            frame = rx.recv() => {
                let Some(bytes) = frame else { return Err(anyhow!("connection closed by server")) };
                if bytes[0] == PKT_WELCOME && bytes.len() >= 5 && player_id.is_none() {
                    let id = u32::from_le_bytes(bytes[1..5].try_into()?);
                    player_id = Some(id);
                    println!("probe t={:.2}s joined as player {id}", started.elapsed().as_secs_f64());
                } else if let Some((tick, position, hp)) = snapshot_v2(&bytes) {
                    let changed = last_hp != Some(hp);
                    if changed || last_print.elapsed() >= Duration::from_secs(1) {
                        println!(
                            "probe t={:.2}s tick {tick} pos ({:.2}, {:.2}, {:.2}) hp {hp}{}",
                            started.elapsed().as_secs_f64(),
                            position[0], position[1], position[2],
                            if changed { last_hp.map_or(String::new(), |prev| format!("  (was {prev})")) } else { String::new() }
                        );
                        last_print = Instant::now();
                    }
                    last_hp = Some(hp);
                }
            }
        }
    }
    reliable.abort();
    datagrams.abort();
    connection.close(wtransport::VarInt::from_u32(0), b"done");
    println!("probe done: player {player_id:?} final hp {last_hp:?}");
    Ok(())
}
