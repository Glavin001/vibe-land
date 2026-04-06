mod lag_comp;
mod movement;
mod protocol;
mod voxel_world;

use std::{
    collections::HashMap,
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
use futures_util::{sink::SinkExt, stream::StreamExt};
use tokio::sync::{mpsc, RwLock};
use tracing::{error, info, warn};

use crate::{
    lag_comp::{HistoricalCapsule, LagCompHistory},
    movement::{MoveConfig, PhysicsArena},
    protocol::{
        decode_client_packet, encode_server_packet, make_net_player_state, ClientPacket, FireCmd, InputCmd, ServerPacket,
        SnapshotPacket, WelcomePacket,
    },
    voxel_world::{VoxelWorld, CHUNK_SIZE},
};

const SIM_HZ: u16 = 60;
const SNAPSHOT_HZ: u16 = 30;
const CHUNK_RADIUS_ON_JOIN: i32 = 4;
const SERVER_PING_INTERVAL_TICKS: u32 = SIM_HZ as u32;

#[derive(Clone)]
struct SharedAppState {
    inner: Arc<AppState>,
}

struct AppState {
    matches: RwLock<HashMap<String, MatchHandle>>,
    next_player_id: AtomicU32,
    verifier: SpacetimeVerifier,
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
    latest_input: InputCmd,
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
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let state = SharedAppState {
        inner: Arc::new(AppState {
            matches: RwLock::new(HashMap::new()),
            next_player_id: AtomicU32::new(1),
            verifier: SpacetimeVerifier {
                http: reqwest::Client::new(),
                base_url: std::env::var("SPACETIMEDB_BASE_URL")
                    .unwrap_or_else(|_| "https://maincloud.spacetimedb.com".to_string()),
            },
        }),
    };

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws/:match_id", get(ws_handler))
        .with_state(state);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4001".to_string())
        .parse()?;
    info!(%addr, "starting web fps server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
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
                        latest_input: InputCmd::default(),
                        last_ack_input_seq: 0,
                        estimated_one_way_ms: 40,
                        pending_server_ping: None,
                    },
                );

                let welcome = ServerPacket::Welcome(WelcomePacket {
                    player_id: conn.player_id,
                    sim_hz: SIM_HZ,
                    snapshot_hz: SNAPSHOT_HZ,
                    chunk_size: CHUNK_SIZE as u8,
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
                    ClientPacket::Input(cmd) => {
                        runtime.latest_input = cmd;
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
            let input = self.players.get(&player_id).map(|p| p.latest_input.clone()).unwrap_or_default();
            self.arena.simulate_player_tick(player_id, &input, dt);
            if let Some(runtime) = self.players.get_mut(&player_id) {
                runtime.last_ack_input_seq = input.seq;
            }

            if let Some((pos, _vel, _yaw, _pitch, hp, _flags)) = self.arena.snapshot_player(player_id) {
                self.history.record(player_id, HistoricalCapsule {
                    server_tick: self.server_tick,
                    server_time_ms,
                    center: pos,
                    radius: self.arena.config.capsule_radius,
                    half_segment: self.arena.config.capsule_half_segment,
                    alive: hp > 0,
                });
            }
        }

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

            let world_ray_result = self.arena.cast_static_world_ray(
                queued.cmd.origin, queued.cmd.dir, 1000.0, Some(queued.player_id),
            );

            let hit = self.history.resolve_hitscan(
                queued.player_id,
                estimated_ow,
                server_time_ms,
                &queued.cmd,
                |_player_toi| world_ray_result,
            );

            let packet = if let Some(hit) = hit {
                if let Some(state) = self.arena.players.get_mut(&hit.victim_id) {
                    state.hp = state.hp.saturating_sub(hit.damage as u8);
                }
                ServerPacket::ShotResult(crate::protocol::ShotResultPacket {
                    shot_id: queued.cmd.shot_id,
                    hit_player_id: hit.victim_id,
                    damage: hit.damage,
                    confirmed: true,
                })
            } else {
                ServerPacket::ShotResult(crate::protocol::ShotResultPacket {
                    shot_id: queued.cmd.shot_id,
                    hit_player_id: 0,
                    damage: 0,
                    confirmed: false,
                })
            };

            if let Some(shooter) = self.players.get(&queued.player_id) {
                let _ = shooter.tx.send(encode_server_packet(&packet));
            }
        }
    }

    fn broadcast_snapshot(&self) {
        let mut states = Vec::with_capacity(self.players.len());
        for &player_id in self.players.keys() {
            if let Some((pos, vel, yaw, pitch, hp, flags)) = self.arena.snapshot_player(player_id) {
                states.push(make_net_player_state(player_id, pos, vel, yaw, pitch, hp, flags));
            }
        }

        for runtime in self.players.values() {
            let packet = ServerPacket::Snapshot(SnapshotPacket {
                server_tick: self.server_tick,
                ack_input_seq: runtime.last_ack_input_seq,
                player_states: states.clone(),
            });
            let _ = runtime.tx.send(encode_server_packet(&packet));
        }
    }
}

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
