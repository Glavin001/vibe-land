mod lag_comp;
mod movement;
mod protocol;
mod voxel_world;

use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use bytes::BufMut;
use futures_util::{sink::SinkExt, stream::StreamExt};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, RwLock};
use tracing::{error, info, warn};
use wtransport::{Connection, Endpoint, Identity, ServerConfig};

use crate::{
    lag_comp::{HistoricalCapsule, LagCompHistory},
    movement::{MoveConfig, PhysicsArena},
    protocol::{
        client_datagram_to_packet, decode_client_datagram, decode_client_hello,
        decode_client_packet, encode_server_packet, make_net_dynamic_body_state,
        make_net_player_state, ClientPacket, FireCmd, InputCmd, ServerPacket,
        SnapshotPacket, ShotResultPacket, WelcomePacket, PKT_PING, PKT_SNAPSHOT,
    },
    voxel_world::VoxelWorld,
};
use nalgebra::vector;

const SIM_HZ: u16 = 60;
const SNAPSHOT_HZ: u16 = 30;
const CHUNK_RADIUS_ON_JOIN: i32 = 4;
const SERVER_PING_INTERVAL_TICKS: u32 = SIM_HZ as u32;
const MAX_PENDING_INPUTS: usize = 120;

#[derive(Clone)]
struct SharedAppState {
    inner: Arc<AppState>,
}

struct AppState {
    matches: RwLock<HashMap<String, MatchHandle>>,
    next_player_id: AtomicU32,
    verifier: SpacetimeVerifier,
    cert_hash_hex: String,
    wt_base_url: String,
}

#[derive(Clone)]
struct MatchHandle {
    tx: mpsc::UnboundedSender<MatchEvent>,
}

struct SpacetimeVerifier {
    http: reqwest::Client,
    base_url: String,
}

#[derive(Debug, serde::Deserialize)]
struct WsQuery {
    identity: String,
    token: String,
}

#[derive(Debug, serde::Deserialize)]
struct SessionConfigQuery {
    match_id: String,
}

#[derive(serde::Serialize)]
struct SessionConfig {
    match_id: String,
    url: String,
    server_certificate_hash_hex: String,
    sim_hz: u16,
    snapshot_hz: u16,
    interpolation_delay_ms: u16,
}

struct PlayerConnection {
    player_id: u32,
    identity: String,
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

enum MatchEvent {
    Connect(PlayerConnection),
    Disconnect { player_id: u32 },
    Packet { player_id: u32, packet: ClientPacket },
}

struct PlayerRuntime {
    identity: String,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    pending_inputs: VecDeque<InputCmd>,
    last_applied_input: InputCmd,
    last_received_input_seq: Option<u16>,
    last_ack_input_seq: u16,
    estimated_one_way_ms: u32,
    pending_server_ping: Option<(u32, Instant)>,
}

struct QueuedShot {
    player_id: u32,
    cmd: FireCmd,
}

struct MatchState {
    id: String,
    arena: PhysicsArena,
    world: VoxelWorld,
    history: LagCompHistory,
    players: HashMap<u32, PlayerRuntime>,
    queued_shots: Vec<QueuedShot>,
    server_tick: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env from repo root (one level up from server/)
    dotenvy::from_path("../.env").ok();

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    // Build TLS identity for WebTransport.
    // If WT_CERT_PEM + WT_KEY_PEM are set, load a CA-signed cert (production).
    // Otherwise generate a self-signed cert (dev/local) and expose its hash for
    // the browser's serverCertificateHashes pinning API.
    let (identity, cert_hash_hex) = match (
        std::env::var("WT_CERT_PEM").ok(),
        std::env::var("WT_KEY_PEM").ok(),
    ) {
        (Some(cert_path), Some(key_path)) => {
            let identity = Identity::load_pemfiles(&cert_path, &key_path).await?;
            info!(%cert_path, "WebTransport: loaded CA-signed certificate");
            // Empty hash signals the client to skip certificate pinning
            (identity, String::new())
        }
        _ => {
            let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
            let cert_der = identity.certificate_chain().as_slice()[0].der().to_vec();
            let cert_hash_hex = hex::encode(Sha256::digest(&cert_der));
            info!("WebTransport: using self-signed certificate (dev mode)");
            (identity, cert_hash_hex)
        }
    };

    // Determine WebTransport bind address and public base URL
    let wt_addr: SocketAddr = std::env::var("WT_BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4002".to_string())
        .parse()?;
    let wt_host = std::env::var("WT_HOST")
        .unwrap_or_else(|_| "localhost".to_string());
    let wt_base_url = format!("https://{}:{}", wt_host, wt_addr.port());

    info!(%wt_base_url, cert_hash = %cert_hash_hex, "WebTransport identity ready");

    let state = SharedAppState {
        inner: Arc::new(AppState {
            matches: RwLock::new(HashMap::new()),
            next_player_id: AtomicU32::new(1),
            verifier: SpacetimeVerifier {
                http: reqwest::Client::new(),
                base_url: std::env::var("SPACETIMEDB_BASE_URL")
                    .unwrap_or_else(|_| "https://maincloud.spacetimedb.com".to_string()),
            },
            cert_hash_hex,
            wt_base_url,
        }),
    };

    // Start WebTransport server
    let wt_config = ServerConfig::builder()
        .with_bind_address(wt_addr)
        .with_identity(identity)
        .build();
    let wt_endpoint = Endpoint::server(wt_config)?;
    info!(%wt_addr, "WebTransport endpoint listening");

    {
        let app_inner = state.inner.clone();
        tokio::spawn(async move {
            loop {
                let incoming = wt_endpoint.accept().await;
                let app = app_inner.clone();
                tokio::spawn(async move {
                    let request = match incoming.await {
                        Ok(r) => r,
                        Err(err) => { warn!(error = ?err, "WT incoming session failed"); return; }
                    };
                    let path = request.path().to_string();
                    let connection = match request.accept().await {
                        Ok(c) => c,
                        Err(err) => { warn!(error = ?err, "WT session accept failed"); return; }
                    };
                    if path != "/game" {
                        warn!(%path, "WT session rejected: unknown path");
                        return;
                    }
                    if let Err(err) = handle_wt_session(app, connection).await {
                        error!(error = ?err, "WT session error");
                    }
                });
            }
        });
    }

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/session-config", get(session_config_handler))
        .route("/ws/:match_id", get(ws_handler))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4001".to_string())
        .parse()?;
    info!(%addr, "starting web fps server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn session_config_handler(
    Query(query): Query<SessionConfigQuery>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let config = SessionConfig {
        url: format!("{}/game", state.inner.wt_base_url),
        server_certificate_hash_hex: state.inner.cert_hash_hex.clone(),
        match_id: query.match_id,
        sim_hz: SIM_HZ,
        snapshot_hz: SNAPSHOT_HZ,
        interpolation_delay_ms: (1000 / SNAPSHOT_HZ) * 2,
    };
    axum::Json(config)
}

async fn handle_wt_session(app: Arc<AppState>, connection: Connection) -> Result<()> {
    // Accept the client's first bidi stream which carries the framed ClientHello
    let (mut send_stream, mut recv_stream) = connection.accept_bi().await?;

    // Read all bytes from the stream (client closes its write side after sending ClientHello)
    let mut raw = Vec::new();
    recv_stream.read_to_end(&mut raw).await?;

    // Strip 4-byte LE length prefix from frameReliablePacket
    anyhow::ensure!(raw.len() >= 4, "ClientHello too short");
    let payload_len = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    anyhow::ensure!(raw.len() >= 4 + payload_len, "ClientHello truncated");
    let hello = decode_client_hello(&raw[4..4 + payload_len])?;

    let player_id = app.next_player_id.fetch_add(1, Ordering::Relaxed);
    let handle = get_or_create_match(app.clone(), hello.match_id.clone()).await;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    handle.tx.send(MatchEvent::Connect(PlayerConnection {
        player_id,
        identity: format!("wt-player-{player_id}"),
        tx: out_tx,
    }))?;

    // Writer: prefer datagrams for snapshots/pings; fall back to reliable stream
    // if the datagram is too large for the current QUIC path MTU.
    let conn_write = connection.clone();
    let writer = tokio::spawn(async move {
        let mut buf = bytes::BytesMut::with_capacity(4096);
        while let Some(bytes) = out_rx.recv().await {
            if bytes.is_empty() {
                continue;
            }
            let first = bytes[0];
            let use_datagram = (first == PKT_SNAPSHOT || first == PKT_PING)
                && conn_write.send_datagram(bytes.as_slice()).is_ok();
            if !use_datagram {
                // Reliable stream: 4-byte LE length prefix
                buf.clear();
                buf.put_u32_le(bytes.len() as u32);
                buf.put_slice(&bytes);
                if send_stream.write_all(&buf).await.is_err() {
                    break;
                }
            }
        }
    });

    // Reader: receive client datagrams → route to match
    let tx_to_match = handle.tx.clone();
    let reader = tokio::spawn(async move {
        loop {
            match connection.receive_datagram().await {
                Ok(datagram) => {
                    let payload = datagram.payload();
                    match decode_client_datagram(&payload) {
                        Ok(dgram) => {
                            let packet = client_datagram_to_packet(dgram);
                            if tx_to_match.send(MatchEvent::Packet { player_id, packet }).is_err() {
                                break;
                            }
                        }
                        Err(err) => warn!(player_id, error = ?err, "dropping malformed WT datagram"),
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx_to_match.send(MatchEvent::Disconnect { player_id });
    });

    let _ = tokio::join!(writer, reader);
    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(match_id): Path<String>,
    Query(query): Query<WsQuery>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let app = state.inner.clone();
    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_socket(app, match_id, query, socket).await {
            error!(error = ?err, "socket handler failed");
        }
    })
}

async fn handle_socket(
    app: Arc<AppState>,
    match_id: String,
    query: WsQuery,
    socket: WebSocket,
) -> Result<()> {
    app.verifier.verify(&query.identity, &query.token).await?;

    let player_id = app.next_player_id.fetch_add(1, Ordering::Relaxed);
    let handle = get_or_create_match(app.clone(), match_id.clone()).await;

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    handle.tx.send(MatchEvent::Connect(PlayerConnection {
        player_id,
        identity: query.identity.clone(),
        tx: out_tx.clone(),
    }))?;

    let writer = tokio::spawn(async move {
        while let Some(packet) = out_rx.recv().await {
            if ws_tx.send(Message::Binary(packet.into())).await.is_err() {
                break;
            }
        }
    });

    let tx_to_match = handle.tx.clone();
    let reader = tokio::spawn(async move {
        while let Some(result) = ws_rx.next().await {
            let Ok(message) = result else { break; };
            match message {
                Message::Binary(bytes) => match decode_client_packet(&bytes) {
                    Ok(packet) => {
                        if tx_to_match.send(MatchEvent::Packet { player_id, packet }).is_err() {
                            break;
                        }
                    }
                    Err(err) => warn!(player_id, error = ?err, "dropping malformed packet"),
                },
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = tx_to_match.send(MatchEvent::Disconnect { player_id });
    });

    let _ = tokio::join!(writer, reader);
    Ok(())
}

async fn get_or_create_match(app: Arc<AppState>, match_id: String) -> MatchHandle {
    if let Some(existing) = app.matches.read().await.get(&match_id).cloned() {
        return existing;
    }

    let mut write = app.matches.write().await;
    if let Some(existing) = write.get(&match_id).cloned() {
        return existing;
    }

    let (tx, rx) = mpsc::unbounded_channel();
    let handle = MatchHandle { tx: tx.clone() };
    write.insert(match_id.clone(), handle.clone());
    tokio::spawn(run_match_loop(match_id, rx));
    handle
}

async fn run_match_loop(match_id: String, mut rx: mpsc::UnboundedReceiver<MatchEvent>) {
    let mut arena = PhysicsArena::new(MoveConfig::default());
    let mut world = VoxelWorld::new();
    world.seed_demo_world(&mut arena);

    // Spawn a dynamic box that falls from above onto the ground
    arena.spawn_dynamic_box(
        vector![4.0, 8.0, 4.0],
        vector![0.5, 0.5, 0.5],
    );

    // Spawn a test vehicle on the ground near spawn
    arena.spawn_vehicle(0, vector![8.0, 2.0, 0.0]);

    // Rebuild broad phase from scratch so all colliders are cleanly registered
    // (avoids BVH corruption from stale handles accumulated during seeding)
    arena.rebuild_broad_phase();

    let mut state = MatchState {
        id: match_id,
        arena,
        world,
        history: LagCompHistory::new(1000),
        players: HashMap::new(),
        queued_shots: Vec::new(),
        server_tick: 0,
    };

    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / SIM_HZ as f64));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = tick.tick() => {
                state.tick();
            }
            Some(event) = rx.recv() => {
                state.handle_event(event);
            }
            else => break,
        }
    }
}

impl MatchState {
    fn handle_event(&mut self, event: MatchEvent) {
        match event {
            MatchEvent::Connect(conn) => {
                self.arena.spawn_player(conn.player_id);
                self.players.insert(
                    conn.player_id,
                    PlayerRuntime {
                        identity: conn.identity,
                        tx: conn.tx.clone(),
                        pending_inputs: VecDeque::new(),
                        last_applied_input: InputCmd::default(),
                        last_received_input_seq: None,
                        last_ack_input_seq: 0,
                        estimated_one_way_ms: 40,
                        pending_server_ping: None,
                    },
                );

                let server_time_us = (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64);
                let welcome = ServerPacket::Welcome(WelcomePacket {
                    player_id: conn.player_id,
                    sim_hz: SIM_HZ,
                    snapshot_hz: SNAPSHOT_HZ,
                    server_time_us,
                    interpolation_delay_ms: (1000 / SNAPSHOT_HZ) * 2,
                });
                let _ = conn.tx.send(encode_server_packet(&welcome));

                if let Some((pos, _, _, _, _, _)) = self.arena.snapshot_player(conn.player_id) {
                    for key in self.world.visible_chunks_around(pos, CHUNK_RADIUS_ON_JOIN) {
                        if let Some(full) = self.world.chunk_full_packet(key) {
                            let _ = conn.tx.send(encode_server_packet(&ServerPacket::ChunkFull(full)));
                        }
                    }
                }
            }
            MatchEvent::Disconnect { player_id } => {
                self.players.remove(&player_id);
                self.arena.remove_player(player_id);
            }
            MatchEvent::Packet { player_id, packet } => {
                let Some(runtime) = self.players.get_mut(&player_id) else { return; };
                match packet {
                    ClientPacket::InputBundle(cmds) => {
                        enqueue_inputs(runtime, cmds);
                    }
                    ClientPacket::Fire(cmd) => {
                        self.queued_shots.push(QueuedShot { player_id, cmd });
                    }
                    ClientPacket::BlockEdit(cmd) => {
                        match self.world.apply_edit(&mut self.arena, &cmd) {
                            Ok(diff) => {
                                let packet = encode_server_packet(&ServerPacket::ChunkDiff(diff));
                                for player in self.players.values() {
                                    let _ = player.tx.send(packet.clone());
                                }
                            }
                            Err(err) => {
                                warn!(player_id, error = %err, "block edit rejected");
                                if let Some(full) = self.world.chunk_full_for_coords(cmd.chunk) {
                                    let _ = runtime.tx.send(encode_server_packet(&ServerPacket::ChunkFull(full)));
                                }
                            }
                        }
                    }
                    ClientPacket::Ping(value) => {
                        if let Some((nonce, sent_at)) = runtime.pending_server_ping {
                            if nonce == value {
                                let rtt_ms = sent_at.elapsed().as_millis() as u32;
                                runtime.estimated_one_way_ms = (rtt_ms / 2).clamp(10, 250);
                                runtime.pending_server_ping = None;
                                return;
                            }
                        }
                        let _ = runtime.tx.send(encode_server_packet(&ServerPacket::Pong(value)));
                    }
                    ClientPacket::VehicleEnter(cmd) => {
                        if self.arena.vehicles.contains_key(&cmd.vehicle_id) {
                            self.arena.enter_vehicle(player_id, cmd.vehicle_id);
                        }
                    }
                    ClientPacket::VehicleExit(_cmd) => {
                        self.arena.exit_vehicle(player_id);
                    }
                }
            }
        }
    }

    fn tick(&mut self) {
        self.server_tick += 1;
        let dt = 1.0 / SIM_HZ as f32;
        let server_time_ms = self.server_tick * (1000 / SIM_HZ as u32);

        let ids: Vec<u32> = self.players.keys().copied().collect();
        for player_id in ids.iter().copied() {
            let input = self
                .players
                .get_mut(&player_id)
                .map(take_input_for_tick)
                .unwrap_or_default();
            self.arena.simulate_player_tick(player_id, &input, dt);

            if let Some((pos, _vel, _yaw, _pitch, hp, _flags)) = self.arena.snapshot_player(player_id) {
                self.history.record(player_id, HistoricalCapsule {
                    server_tick: self.server_tick,
                    server_time_ms,
                    center: pos,
                    radius: self.arena.config().capsule_radius,
                    half_segment: self.arena.config().capsule_half_segment,
                    alive: hp > 0,
                });
            }
        }

        self.arena.step_vehicles(dt);
        self.arena.step_dynamics(dt);

        self.process_hitscan(server_time_ms);

        if self.server_tick % (SIM_HZ as u32 / SNAPSHOT_HZ as u32) == 0 {
            self.broadcast_snapshot();
        }

        if self.server_tick % SERVER_PING_INTERVAL_TICKS == 0 {
            self.send_server_latency_pings();
        }
    }

    fn send_server_latency_pings(&mut self) {
        for (&player_id, runtime) in &mut self.players {
            let nonce = ((self.server_tick & 0xffff) << 16) | (player_id & 0xffff);
            runtime.pending_server_ping = Some((nonce, Instant::now()));
            let _ = runtime.tx.send(encode_server_packet(&ServerPacket::Ping(nonce)));
        }
    }

    fn process_hitscan(&mut self, server_time_ms: u32) {
        let shots = std::mem::take(&mut self.queued_shots);
        for queued in shots {
            let Some(runtime) = self.players.get(&queued.player_id) else { continue; };
            let estimated_ow = runtime.estimated_one_way_ms;

            // Use the shooter's current eye position as origin
            let origin = match self.arena.snapshot_player(queued.player_id) {
                Some((pos, _, _, _, _, _)) => [pos[0], pos[1] + 0.8, pos[2]], // eye height offset
                None => continue,
            };

            let world_ray_result = self.arena.cast_static_world_ray(
                origin, queued.cmd.dir, 1000.0, Some(queued.player_id),
            );

            let hit = self.history.resolve_hitscan(
                queued.player_id,
                origin,
                queued.cmd.dir,
                estimated_ow,
                server_time_ms,
                queued.cmd.client_interp_ms as u32,
                world_ray_result,
            );

            let packet = if let Some(hit) = hit {
                if let Some(state) = self.arena.players.get_mut(&hit.victim_id) {
                    state.hp = state.hp.saturating_sub(25);
                }
                ServerPacket::ShotResult(ShotResultPacket {
                    shot_id: queued.cmd.shot_id,
                    weapon: queued.cmd.weapon,
                    hit_player_id: hit.victim_id,
                    confirmed: true,
                })
            } else {
                ServerPacket::ShotResult(ShotResultPacket {
                    shot_id: queued.cmd.shot_id,
                    weapon: queued.cmd.weapon,
                    hit_player_id: 0,
                    confirmed: false,
                })
            };

            if let Some(shooter) = self.players.get(&queued.player_id) {
                let _ = shooter.tx.send(encode_server_packet(&packet));
            }
        }
    }

    fn broadcast_snapshot(&self) {
        let server_time_us = (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64);
        let mut states = Vec::with_capacity(self.players.len());
        for &player_id in self.players.keys() {
            if let Some((pos, vel, yaw, pitch, _hp, flags)) = self.arena.snapshot_player(player_id) {
                states.push(make_net_player_state(player_id, pos, vel, yaw, pitch, flags));
            }
        }

        let dynamic_body_states: Vec<_> = self
            .arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .map(|(id, pos, quat, he, vel, shape_type)| make_net_dynamic_body_state(id, pos, quat, he, vel, shape_type))
            .collect();

        let vehicle_states = self.arena.snapshot_vehicles();

        for runtime in self.players.values() {
            let packet = ServerPacket::Snapshot(SnapshotPacket {
                server_time_us,
                server_tick: self.server_tick,
                ack_input_seq: runtime.last_ack_input_seq,
                player_states: states.clone(),
                projectile_states: Vec::new(),
                dynamic_body_states: dynamic_body_states.clone(),
                vehicle_states: vehicle_states.clone(),
            });
            let _ = runtime.tx.send(encode_server_packet(&packet));
        }
    }
}

fn take_input_for_tick(runtime: &mut PlayerRuntime) -> InputCmd {
    if let Some(input) = runtime.pending_inputs.pop_front() {
        runtime.last_ack_input_seq = input.seq;
        runtime.last_applied_input = input.clone();
        return input;
    }
    runtime.last_applied_input.clone()
}

fn enqueue_inputs(runtime: &mut PlayerRuntime, cmds: Vec<InputCmd>) {
    for cmd in cmds {
        let is_new = runtime
            .last_received_input_seq
            .map(|last| seq_is_newer(cmd.seq, last))
            .unwrap_or(true);
        if !is_new {
            continue;
        }
        runtime.last_received_input_seq = Some(cmd.seq);
        runtime.pending_inputs.push_back(cmd);
        while runtime.pending_inputs.len() > MAX_PENDING_INPUTS {
            runtime.pending_inputs.pop_front();
        }
    }
}

use vibe_land_shared::seq::seq_is_newer;

impl SpacetimeVerifier {
    async fn verify(&self, identity: &str, _token: &str) -> Result<()> {
        if std::env::var("SKIP_SPACETIMEDB_VERIFY").is_ok() {
            info!(%identity, "skipping SpacetimeDB verification (MVP mode)");
            return Ok(());
        }
        let url = format!("{}/v1/identity/{identity}/verify", self.base_url.trim_end_matches('/'));

        let response = self
            .http
            .get(url)
            .bearer_auth(_token)
            .send()
            .await?;

        if response.status().is_success() {
            Ok(())
        } else {
            anyhow::bail!("Spacetime identity verify failed: {}", response.status())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        enqueue_inputs, take_input_for_tick, InputCmd, PlayerRuntime, MAX_PENDING_INPUTS,
    };
    use vibe_land_shared::seq::seq_is_newer;
    use std::collections::VecDeque;
    use tokio::sync::mpsc;

    fn runtime() -> PlayerRuntime {
        let (tx, _rx) = mpsc::unbounded_channel();
        PlayerRuntime {
            identity: "test-player".to_string(),
            tx,
            pending_inputs: VecDeque::new(),
            last_applied_input: InputCmd::default(),
            last_received_input_seq: None,
            last_ack_input_seq: 0,
            estimated_one_way_ms: 40,
            pending_server_ping: None,
        }
    }

    fn input(seq: u16) -> InputCmd {
        InputCmd {
            seq,
            buttons: seq,
            move_x: 0,
            move_y: 0,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    #[test]
    fn seq_is_newer_handles_wraparound() {
        assert!(seq_is_newer(2, 0xfffe));
        assert!(!seq_is_newer(0xfffe, 2));
        assert!(!seq_is_newer(0x8000, 0));
    }

    #[test]
    fn enqueue_inputs_rejects_stale_and_duplicate_frames() {
        let mut runtime = runtime();

        enqueue_inputs(&mut runtime, vec![input(10), input(11)]);
        enqueue_inputs(&mut runtime, vec![input(11), input(9), input(12)]);

        let queued: Vec<u16> = runtime.pending_inputs.iter().map(|cmd| cmd.seq).collect();
        assert_eq!(queued, vec![10, 11, 12]);
        assert_eq!(runtime.last_received_input_seq, Some(12));
    }

    #[test]
    fn enqueue_inputs_keeps_newest_frames_when_queue_overflows() {
        let mut runtime = runtime();
        let frames = (1..=(MAX_PENDING_INPUTS as u16 + 5)).map(input).collect();

        enqueue_inputs(&mut runtime, frames);

        assert_eq!(runtime.pending_inputs.len(), MAX_PENDING_INPUTS);
        assert_eq!(runtime.pending_inputs.front().map(|cmd| cmd.seq), Some(6));
        assert_eq!(
            runtime.pending_inputs.back().map(|cmd| cmd.seq),
            Some(MAX_PENDING_INPUTS as u16 + 5)
        );
    }

    #[test]
    fn take_input_for_tick_consumes_queue_then_repeats_last_applied() {
        let mut runtime = runtime();
        enqueue_inputs(&mut runtime, vec![input(21), input(22)]);

        let first = take_input_for_tick(&mut runtime);
        let second = take_input_for_tick(&mut runtime);
        let repeated = take_input_for_tick(&mut runtime);

        assert_eq!(first.seq, 21);
        assert_eq!(second.seq, 22);
        assert_eq!(repeated.seq, 22);
        assert_eq!(runtime.last_ack_input_seq, 22);
    }
}
