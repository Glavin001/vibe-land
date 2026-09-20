//! N WebTransport players for a /city match, each behind its own degraded
//! link, logging every city packet they receive.
//!
//!   city-bots --api http://127.0.0.1:4018 --wt-port 4434 --bots 50
//!             --duration 120 --out /dev/shm/netlab/captures/town-volley/bots
//!             [--match city-default] [--profiles wifi-good:40,wifi-bad:30,lte:20,loss-burst:10]
//!             [--centre x,z --radius r] [--seed n]
//!
//! The server side of the stream is O(bodies x clients) per send, and its
//! outbound lanes drop under back-pressure. Neither shows up with one browser
//! on loopback. A bot is the cheapest thing that is still a real client to
//! the server: it joins through the same ClientHello, sends the same input
//! bundles at 60 Hz (so the server derives an interest camera for it exactly
//! as for a player), and receives the same reliable stream and datagrams over
//! QUIC -- through a userspace UDP relay that adds delay, jitter, loss and
//! reordering, so QUIC's own loss recovery and congestion control are what a
//! real link would exercise.
//!
//! What it does not do is decode the city stream: the packets are logged in
//! the recorder's `packets.jsonl` format with their ARRIVAL tick, and the
//! shipping TS client replays them offline. One client implementation.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use bytes::BufMut;
use tokio::net::UdpSocket;
use vibe_land_destruction::netlab::packets::PacketLog;
use vibe_land_shared::constants::{
    CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE, PKT_CITY_CAMERA_DROP, PKT_CLIENT_HELLO,
    PKT_INPUT_BUNDLE, PKT_WELCOME, PROTOCOL_VERSION, SIM_HZ,
};
use vibe_netcode::unit_conv::angle_to_i16;

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

/// A link profile, the same table `client/netlab/netemProfiles.json` holds.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    #[serde(default)]
    delay_ms: f64,
    #[serde(default)]
    jitter_ms: f64,
    #[serde(default)]
    loss_pct: f64,
    #[serde(default)]
    reorder_pct: f64,
}

fn load_profiles() -> Result<std::collections::HashMap<String, Profile>> {
    let path = flag("--profiles-file")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("client/netlab/netemProfiles.json"));
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)?;
    let mut out = std::collections::HashMap::new();
    out.insert(
        "none".to_string(),
        Profile { delay_ms: 0.0, jitter_ms: 0.0, loss_pct: 0.0, reorder_pct: 0.0 },
    );
    if let Some(profiles) = value["profiles"].as_object() {
        for (name, profile) in profiles {
            if let Ok(profile) = serde_json::from_value::<Profile>(profile.clone()) {
                out.insert(name.clone(), profile);
            }
        }
    }
    Ok(out)
}

/// Deterministic mulberry32 so a run's profile assignment and link noise are a
/// function of the seed.
struct Rng(u32);
impl Rng {
    fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// One direction of the relay: a FIFO whose head is released at its due time.
struct Lane {
    queue: VecDeque<(Instant, Vec<u8>)>,
    last_due: Instant,
}

impl Lane {
    fn new() -> Self {
        Self { queue: VecDeque::new(), last_due: Instant::now() }
    }

    /// Router-like: a packet may be held longer than the one before it but
    /// never overtakes it, unless explicitly reordered.
    fn schedule(&mut self, profile: &Profile, rng: &mut Rng, bytes: Vec<u8>) {
        if profile.loss_pct > 0.0 && rng.next_f64() * 100.0 < profile.loss_pct {
            return;
        }
        let jitter = (rng.next_f64() * 2.0 - 1.0) * profile.jitter_ms;
        let mut delay = profile.delay_ms + jitter;
        let reordered = profile.reorder_pct > 0.0 && rng.next_f64() * 100.0 < profile.reorder_pct;
        if reordered {
            delay += profile.jitter_ms * 3.0 + 1.0;
        }
        let mut due = Instant::now() + Duration::from_secs_f64(delay.max(0.0) / 1000.0);
        if !reordered && due < self.last_due {
            due = self.last_due;
        }
        if !reordered {
            self.last_due = due;
        }
        // Keep the queue ordered by due time (a reordered straggler goes
        // behind everything due before it).
        let position = self.queue.partition_point(|(other, _)| *other <= due);
        self.queue.insert(position, (due, bytes));
    }
}

/// The relay: bot <-> relay socket <-> server. The bot's QUIC endpoint dials
/// the relay, the server sees the relay as the peer, and each direction has
/// its own lane so the two are shaped independently.
async fn run_relay(
    relay: UdpSocket,
    server: SocketAddr,
    profile: Profile,
    seed: u32,
    stop: Arc<tokio::sync::Notify>,
) {
    let mut bot_addr: Option<SocketAddr> = None;
    let mut to_server = Lane::new();
    let mut to_bot = Lane::new();
    let mut rng = Rng(seed);
    let mut buffer = vec![0u8; 65_536];
    loop {
        let next_due = [to_server.queue.front(), to_bot.queue.front()]
            .into_iter()
            .flatten()
            .map(|(due, _)| *due)
            .min();
        let sleep = match next_due {
            Some(due) => tokio::time::sleep_until(tokio::time::Instant::from_std(due)),
            None => tokio::time::sleep(Duration::from_secs(3600)),
        };
        tokio::select! {
            _ = stop.notified() => break,
            _ = sleep => {
                let now = Instant::now();
                while let Some((due, _)) = to_server.queue.front() {
                    if *due > now { break; }
                    let (_, bytes) = to_server.queue.pop_front().expect("front");
                    let _ = relay.send_to(&bytes, server).await;
                }
                while let Some((due, _)) = to_bot.queue.front() {
                    if *due > now { break; }
                    let (_, bytes) = to_bot.queue.pop_front().expect("front");
                    if let Some(addr) = bot_addr {
                        let _ = relay.send_to(&bytes, addr).await;
                    }
                }
            }
            received = relay.recv_from(&mut buffer) => {
                let Ok((len, from)) = received else { break; };
                let bytes = buffer[..len].to_vec();
                if from == server {
                    to_bot.schedule(&profile, &mut rng, bytes);
                } else {
                    bot_addr = Some(from);
                    to_server.schedule(&profile, &mut rng, bytes);
                }
            }
        }
    }
}

fn encode_client_hello(match_id: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + match_id.len());
    out.push(PKT_CLIENT_HELLO);
    out.put_u16_le(match_id.len() as u16);
    out.extend_from_slice(match_id.as_bytes());
    out.put_u16_le(PROTOCOL_VERSION);
    out.push(CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE);
    out
}

fn encode_input_bundle(seq: u16, move_x: i8, move_y: i8, yaw: f32, pitch: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    out.push(PKT_INPUT_BUNDLE);
    out.push(1);
    out.put_u16_le(seq);
    out.put_u16_le(0);
    out.put_i8(move_x);
    out.put_i8(move_y);
    out.put_i16_le(angle_to_i16(yaw));
    out.put_i16_le(angle_to_i16(pitch));
    out
}

fn encode_camera_drop(position: [f32; 3], yaw: f32, pitch: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(21);
    out.push(PKT_CITY_CAMERA_DROP);
    for value in position {
        out.put_f32_le(value);
    }
    out.put_f32_le(yaw);
    out.put_f32_le(pitch);
    out
}

fn is_city_packet(kind: u8) -> bool {
    (119..=130).contains(&kind)
}

/// What a bot does with its feet: a walker turns at a constant rate while
/// moving forward, so it traces a circle of `radius` (perturbed by whatever
/// it walks into, which is what a player would do too); a static bot stands
/// and looks.
#[derive(Clone, Debug, serde::Serialize)]
struct BotPlan {
    kind: &'static str,
    start: [f32; 3],
    yaw0: f32,
    pitch: f32,
    /// Radians per second of yaw for a walker; 0 for static.
    yaw_rate: f32,
    walk: bool,
}

#[derive(Debug, serde::Serialize)]
struct BotSummary {
    bot: u32,
    player_id: Option<u32>,
    profile: String,
    profile_values: Profile,
    plan: BotPlan,
    seconds: f64,
    bytes: u64,
    reliable_bytes: u64,
    datagrams: u64,
    reliable_packets: u64,
    bootstraps: u64,
    first_sim_tick: Option<u32>,
    last_sim_tick: Option<u32>,
    inputs_sent: u64,
    error: Option<String>,
}

struct BotArgs {
    index: u32,
    match_id: String,
    api: String,
    wt_port: u16,
    digest: [u8; 32],
    profile_name: String,
    profile: Profile,
    plan: BotPlan,
    duration: Duration,
    out_dir: PathBuf,
    seed: u32,
    hz: f64,
}

async fn run_bot(args: BotArgs) -> BotSummary {
    let mut summary = BotSummary {
        bot: args.index,
        player_id: None,
        profile: args.profile_name.clone(),
        profile_values: args.profile.clone(),
        plan: args.plan.clone(),
        seconds: 0.0,
        bytes: 0,
        reliable_bytes: 0,
        datagrams: 0,
        reliable_packets: 0,
        bootstraps: 0,
        first_sim_tick: None,
        last_sim_tick: None,
        inputs_sent: 0,
        error: None,
    };
    match run_bot_inner(&args, &mut summary).await {
        Ok(()) => {}
        Err(error) => summary.error = Some(format!("{error:#}")),
    }
    summary
}

async fn run_bot_inner(args: &BotArgs, summary: &mut BotSummary) -> Result<()> {
    let _ = &args.api;
    let started = Instant::now();
    // Relay first, so the QUIC endpoint has something to dial.
    let relay = UdpSocket::bind("127.0.0.1:0").await?;
    let relay_addr = relay.local_addr()?;
    let server: SocketAddr = format!("127.0.0.1:{}", args.wt_port).parse()?;
    let stop = Arc::new(tokio::sync::Notify::new());
    let relay_task = tokio::spawn(run_relay(
        relay,
        server,
        args.profile.clone(),
        args.seed,
        stop.clone(),
    ));

    let config = wtransport::ClientConfig::builder()
        .with_bind_address("127.0.0.1:0".parse()?)
        .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(args.digest)])
        .build();
    let endpoint = wtransport::Endpoint::client(config)?;
    let url = format!("https://127.0.0.1:{}/game", relay_addr.port());
    let connection = tokio::time::timeout(Duration::from_secs(15), endpoint.connect(&url))
        .await
        .context("connect timed out")??;

    let (mut send, mut recv) = connection.open_bi().await?.await?;
    let hello = encode_client_hello(&args.match_id);
    send.write_all(&(hello.len() as u32).to_le_bytes()).await?;
    send.write_all(&hello).await?;

    let mut log = PacketLog::create(&args.out_dir)?;

    // Arrival tick: the server's sim tick as this bot experiences it. Anchored
    // to the first pose datagram and pulled forward whenever a datagram
    // arrives "before" the estimate says it was sent -- so the anchor tracks
    // the minimum one-way delay and arrival ticks are never below send ticks.
    let hz = args.hz;
    let mut anchor: Option<(u32, Instant)> = None;
    let arrival_tick = |anchor: &Option<(u32, Instant)>, now: Instant| -> u32 {
        match anchor {
            Some((tick, at)) => *tick + (now.duration_since(*at).as_secs_f64() * hz).floor() as u32,
            None => 0,
        }
    };

    let deadline = started + args.duration;
    let mut input_timer = tokio::time::interval(Duration::from_secs_f64(1.0 / hz));
    input_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut seq: u16 = 0;
    let mut placed = false;
    let yaw_rate = args.plan.yaw_rate;
    let mut last_received = Instant::now();

    // Readers are their own tasks: `read_exact` is not cancellation-safe, so
    // a frame must never be read inside a `select!` that another branch can
    // interrupt half way through a length prefix.
    let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::channel::<(Instant, bool, Vec<u8>)>(4096);
    let reliable_reader = {
        let inbound_tx = inbound_tx.clone();
        tokio::spawn(async move {
            let mut length = [0u8; 4];
            loop {
                if recv.read_exact(&mut length).await.is_err() {
                    break;
                }
                let len = u32::from_le_bytes(length) as usize;
                if len == 0 || len > 64 * 1024 * 1024 {
                    break;
                }
                let mut frame = vec![0u8; len];
                if recv.read_exact(&mut frame).await.is_err() {
                    break;
                }
                if inbound_tx.send((Instant::now(), true, frame)).await.is_err() {
                    break;
                }
            }
        })
    };
    let datagram_reader = {
        let inbound_tx = inbound_tx.clone();
        let connection = connection.clone();
        tokio::spawn(async move {
            loop {
                let Ok(datagram) = connection.receive_datagram().await else { break };
                let bytes = datagram.payload().to_vec();
                if bytes.is_empty() {
                    continue;
                }
                if inbound_tx.send((Instant::now(), false, bytes)).await.is_err() {
                    break;
                }
            }
        })
    };
    drop(inbound_tx);

    loop {
        if Instant::now() >= deadline {
            break;
        }
        tokio::select! {
            _ = input_timer.tick() => {
                let elapsed = started.elapsed().as_secs_f32();
                let yaw = args.plan.yaw0 + yaw_rate * elapsed;
                let (move_x, move_y) = if args.plan.walk && placed { (0i8, 127i8) } else { (0, 0) };
                let bundle = encode_input_bundle(seq, move_x, move_y, yaw, args.plan.pitch);
                seq = seq.wrapping_add(1);
                if connection.send_datagram(bundle).is_ok() {
                    summary.inputs_sent += 1;
                }
                // One teleport to the plan's start once the session is live
                // (the server rate-limits drops; one is all a bot needs).
                if !placed && summary.player_id.is_some() && started.elapsed() > Duration::from_millis(500) {
                    let drop = encode_camera_drop(args.plan.start, args.plan.yaw0, args.plan.pitch);
                    let _ = connection.send_datagram(drop);
                    placed = true;
                }
                // A link that delivers nothing for ten seconds is dead, not slow.
                if last_received.elapsed() > Duration::from_secs(10) {
                    return Err(anyhow!("no packets for 10 s"));
                }
            }
            inbound = inbound_rx.recv() => {
                let Some((now, reliable, bytes)) = inbound else {
                    return Err(anyhow!("connection closed by server"));
                };
                last_received = now;
                let kind = bytes[0];
                if reliable {
                    if is_city_packet(kind) {
                        if kind == vibe_land_shared::constants::PKT_CITY_BOOTSTRAP {
                            summary.bootstraps += 1;
                        }
                        let tick = arrival_tick(&anchor, now);
                        log.push(tick, 'r', &bytes)?;
                    } else if kind == PKT_WELCOME && bytes.len() >= 5 {
                        summary.player_id = Some(u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]));
                    }
                } else if is_city_packet(kind) {
                    if kind == vibe_land_shared::constants::PKT_CITY_CHUNKS && bytes.len() >= 12 {
                        let sim_tick = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
                        summary.first_sim_tick.get_or_insert(sim_tick);
                        summary.last_sim_tick = Some(sim_tick);
                        match anchor {
                            None => anchor = Some((sim_tick, now)),
                            Some(_) => {
                                if sim_tick > arrival_tick(&anchor, now) {
                                    anchor = Some((sim_tick, now));
                                }
                            }
                        }
                    }
                    let tick = arrival_tick(&anchor, now);
                    log.push(tick, 'd', &bytes)?;
                }
            }
        }
    }
    reliable_reader.abort();
    datagram_reader.abort();
    summary.seconds = started.elapsed().as_secs_f64();
    summary.datagrams = log.datagrams;
    summary.reliable_packets = log.reliable_packets;
    let (bytes, reliable) = log.finish()?;
    summary.bytes = bytes;
    summary.reliable_bytes = reliable;
    connection.close(wtransport::VarInt::from_u32(0), b"done");
    // notify_one stores a permit, so the relay sees it even if it was mid-send
    // rather than parked on the notification when this fired.
    stop.notify_one();
    let _ = tokio::time::timeout(Duration::from_secs(5), relay_task).await;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let api = flag("--api").unwrap_or_else(|| "http://127.0.0.1:4018".to_string());
    let wt_port: u16 = flag("--wt-port").map_or(Ok(4434), |v| v.parse())?;
    let match_id = flag("--match").unwrap_or_else(|| "city-default".to_string());
    let bots: u32 = flag("--bots").map_or(Ok(10), |v| v.parse())?;
    let duration = Duration::from_secs_f64(flag("--duration").map_or(Ok(60.0), |v| v.parse())?);
    let out_dir = PathBuf::from(flag("--out").ok_or_else(|| anyhow!("--out <dir> is required"))?);
    let seed: u32 = flag("--seed").map_or(Ok(1), |v| v.parse())?;
    let mix = flag("--profiles").unwrap_or_else(|| "none".to_string());
    let profiles = load_profiles()?;
    let mut weighted: Vec<(String, f64)> = Vec::new();
    for part in mix.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (name, weight) = part.split_once(':').unwrap_or((part, "1"));
        if !profiles.contains_key(name) {
            return Err(anyhow!("unknown profile {name:?}"));
        }
        weighted.push((name.to_string(), weight.parse().unwrap_or(1.0)));
    }
    let total_weight: f64 = weighted.iter().map(|(_, w)| w).sum();

    // Certificate hash and scene extent from the running server.
    let client = reqwest::Client::builder().danger_accept_invalid_certs(true).build()?;
    let config: serde_json::Value = client
        .get(format!("{api}/session-config?match_id={match_id}"))
        .send()
        .await
        .context("GET /session-config")?
        .json()
        .await?;
    let hash_hex = config["server_certificate_hash_hex"]
        .as_str()
        .ok_or_else(|| anyhow!("session-config has no server_certificate_hash_hex"))?;
    let digest_vec = hex::decode(hash_hex)?;
    let digest: [u8; 32] = digest_vec
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("certificate hash is not 32 bytes"))?;
    let hz = config["sim_hz"].as_f64().unwrap_or(f64::from(SIM_HZ));

    let (centre, radius) = match (flag("--centre"), flag("--radius")) {
        (Some(centre), radius) => {
            let parts: Vec<f32> = centre.split(',').map(|v| v.trim().parse()).collect::<Result<_, _>>()?;
            ([parts[0], parts[1]], radius.map_or(Ok(60.0), |v| v.parse())?)
        }
        _ => {
            let buildings: serde_json::Value = client
                .get(format!("{api}/city-buildings"))
                .send()
                .await
                .context("GET /city-buildings")?
                .json()
                .await?;
            let mut min = [f32::MAX; 2];
            let mut max = [f32::MIN; 2];
            for building in buildings.as_array().into_iter().flatten() {
                let x = building["centre"][0].as_f64().unwrap_or(0.0) as f32;
                let z = building["centre"][2].as_f64().unwrap_or(0.0) as f32;
                min[0] = min[0].min(x);
                min[1] = min[1].min(z);
                max[0] = max[0].max(x);
                max[1] = max[1].max(z);
            }
            if min[0] > max[0] {
                ([0.0, 0.0], 60.0)
            } else {
                (
                    [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5],
                    ((max[0] - min[0]).max(max[1] - min[1]) * 0.5).max(20.0),
                )
            }
        }
    };
    println!(
        "city-bots: {bots} bots for {:.0} s at {match_id} via relay -> 127.0.0.1:{wt_port}; centre ({:.1}, {:.1}) radius {radius:.0}; mix {mix}",
        duration.as_secs_f64(),
        centre[0],
        centre[1]
    );
    std::fs::create_dir_all(&out_dir)?;

    let mut rng = Rng(seed);
    let mut handles = Vec::new();
    for index in 0..bots {
        // Profile from the mix, deterministically.
        let mut pick = rng.next_f64() * total_weight;
        let mut profile_name = weighted.last().map(|(n, _)| n.clone()).unwrap_or_default();
        for (name, weight) in &weighted {
            if pick < *weight {
                profile_name = name.clone();
                break;
            }
            pick -= weight;
        }
        let profile = profiles[&profile_name].clone();
        // Spread over the scene: 70% walkers on rings, 30% standing overlooks.
        let angle = rng.next_f64() as f32 * std::f32::consts::TAU;
        let ring = radius * (0.3 + 0.7 * rng.next_f64() as f32);
        let start = [centre[0] + ring * angle.cos(), 2.0, centre[1] + ring * angle.sin()];
        let plan = if rng.next_f64() < 0.7 {
            let turn_radius = 10.0 + 30.0 * rng.next_f64() as f32;
            BotPlan {
                kind: "walker",
                start,
                yaw0: angle + std::f32::consts::FRAC_PI_2,
                pitch: -0.05,
                yaw_rate: 4.0 / turn_radius * if rng.next_f64() < 0.5 { 1.0 } else { -1.0 },
                walk: true,
            }
        } else {
            // Look at the centre.
            let dx = centre[0] - start[0];
            let dz = centre[1] - start[2];
            BotPlan {
                kind: "static",
                start: [start[0], 2.0, start[2]],
                yaw0: dx.atan2(dz),
                pitch: -0.1,
                yaw_rate: 0.0,
                walk: false,
            }
        };
        let args = BotArgs {
            index,
            match_id: match_id.clone(),
            api: api.clone(),
            wt_port,
            digest,
            profile_name,
            profile,
            plan,
            duration,
            out_dir: out_dir.join("pkts").join(format!("bot-{index:03}")),
            seed: seed.wrapping_mul(7919).wrapping_add(index),
            hz,
        };
        // Stagger joins: a hundred simultaneous handshakes is its own test.
        tokio::time::sleep(Duration::from_millis(40)).await;
        handles.push(tokio::spawn(run_bot(args)));
    }
    let mut summaries = Vec::new();
    for handle in handles {
        summaries.push(handle.await?);
    }
    let joined = summaries.iter().filter(|s| s.player_id.is_some()).count();
    let failed = summaries.iter().filter(|s| s.error.is_some()).count();
    let bytes: u64 = summaries.iter().map(|s| s.bytes).sum();
    let seconds = duration.as_secs_f64();
    println!(
        "city-bots: joined {joined}/{bots}, failed {failed}, total {:.2} Mbps over {seconds:.0} s",
        bytes as f64 * 8.0 / seconds / 1e6
    );
    for summary in summaries.iter().take(8) {
        println!(
            "  bot {:03} player {:?} {:<10} {:<7} {:.3} Mbps dg {} rel {} boot {} ticks {:?}..{:?} {}",
            summary.bot,
            summary.player_id,
            summary.profile,
            summary.plan.kind,
            summary.bytes as f64 * 8.0 / seconds / 1e6,
            summary.datagrams,
            summary.reliable_packets,
            summary.bootstraps,
            summary.first_sim_tick,
            summary.last_sim_tick,
            summary.error.as_deref().unwrap_or("")
        );
    }
    std::fs::write(out_dir.join("bots.json"), serde_json::to_vec_pretty(&summaries)?)?;
    if joined == 0 {
        return Err(anyhow!("no bot joined"));
    }
    Ok(())
}
