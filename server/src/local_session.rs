//! An in-process session: one player in a match running in this process.
//!
//! The native app's single-player (sim-native) runs the server's match loop
//! inside the renderer's process. This is the transport adapter for that, the
//! same shape as `handle_wt_session`: an outbound channel, a
//! `MatchEvent::Connect`, inbound packets decoded exactly as WebTransport
//! datagrams. The client speaks unchanged WebTransport bytes; only the
//! network is gone.
//!
//! The match itself is the real one -- `run_match_loop` on its own thread,
//! configured from the environment as the server binary is (`.env`,
//! `VIBE_PHYSICS_BACKEND`, the city's settings) -- so single-player runs the
//! city server's simulation, not a cheaper variant of it.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock as StdRwLock},
};

use anyhow::{Context, Result};
use futures_util::FutureExt;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::{
    app_config::PhysicsRuntimeConfig,
    city, describe_panic_payload, load_repo_env,
    movement::{MoveConfig, PhysicsArena},
    outbound, protocol, run_match_loop, send_log, ClientTransport, GlobalStatsSnapshot, MatchEvent,
    MatchIoTelemetry, PlayerConnection, SessionConfig, PLAYER_OUTBOUND_QUEUE_CAPACITY,
};

/// The one player of an in-process match.
const LOCAL_PLAYER_ID: u32 = 1;

/// The JS side drains on a timer, but a stalled frame (a pipeline compile, a
/// GC) must not overflow the reliable lane, which ends the session. Room for
/// several seconds of the city's bootstrap at the queue's packet granularity.
const LOCAL_OUTBOUND_QUEUE_CAPACITY: usize = PLAYER_OUTBOUND_QUEUE_CAPACITY * 64;

/// A running in-process match with its one connected player.
pub struct LocalSession {
    match_id: String,
    events: mpsc::UnboundedSender<MatchEvent>,
    outbound: outbound::Receiver,
    session_config_json: String,
    closed: bool,
}

/// Process-wide setup the server binary does in `main` before any match:
/// `.env` (where the physics backend and city settings come from) and
/// logging, unless the host process already installed a subscriber.
fn init_process() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        load_repo_env();
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .try_init();
    });
}

impl LocalSession {
    /// Start `match_id` in this process and connect the local player.
    pub fn start(match_id: &str) -> Result<Self> {
        init_process();
        let physics = PhysicsRuntimeConfig::from_env()?;
        if physics.backend == vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu {
            // As `main` does: fail here, with a reason, rather than inside the match.
            drop(
                PhysicsArena::new(MoveConfig::default(), physics.backend)
                    .context("PhysX GPU startup validation failed")?,
            );
        }
        if city::is_city_match(match_id) {
            if let Some(reason) = city::city_unavailable_reason(physics.backend) {
                anyhow::bail!("city unavailable in this build: {reason}");
            }
        }

        let (events, rx) = mpsc::unbounded_channel();
        let telemetry = Arc::new(MatchIoTelemetry::default());
        let (out_tx, out_rx) = outbound::channel_with_tap(
            LOCAL_OUTBOUND_QUEUE_CAPACITY,
            Some(send_log::Tap::new(LOCAL_PLAYER_ID, false, telemetry.send_hub.clone())),
        );

        spawn_local_match(match_id.to_owned(), rx, physics, telemetry);

        // Registered as WebTransport: the client speaks WebTransport bytes, and
        // every server path keyed on the transport (lane choice, datagram
        // sizing) must be the one it really takes. No link probe: in-process
        // there is no link to measure, and the city rate controller then sends
        // everything (`SendPlan::Full`).
        events
            .send(MatchEvent::Connect(PlayerConnection {
                player_id: LOCAL_PLAYER_ID,
                identity: format!("in-process-player-{LOCAL_PLAYER_ID}"),
                transport: ClientTransport::WebTransport,
                tx: out_tx,
                link: None,
            }))
            .map_err(|_| anyhow::anyhow!("match loop exited before the player connected"))?;

        let session_config_json = serde_json::to_string(&session_config(match_id, &physics))?;
        info!(%match_id, "in-process session started");
        Ok(Self {
            match_id: match_id.to_owned(),
            events,
            outbound: out_rx,
            session_config_json,
            closed: false,
        })
    }

    /// What `/session-config` would answer for this match.
    pub fn session_config_json(&self) -> &str {
        &self.session_config_json
    }

    /// One client packet, decoded as a WebTransport datagram -- or, for the
    /// kinds only the full client decoder knows (the city manifest request the
    /// client sends when it cannot fetch `/city-manifest`, which in-process is
    /// always), as the WebSocket path decodes it.
    pub fn send(&self, bytes: &[u8]) -> Result<()> {
        if self.closed {
            anyhow::bail!("session closed");
        }
        let packet = match protocol::decode_client_datagram(bytes) {
            Ok(datagram) => protocol::client_datagram_to_packet(datagram),
            Err(datagram_error) => protocol::decode_client_packet(bytes)
                .map_err(|_| datagram_error)?,
        };
        self.events
            .send(MatchEvent::Packet { player_id: LOCAL_PLAYER_ID, packet })
            .map_err(|_| anyhow::anyhow!("match loop has exited"))
    }

    /// Every packet queued for the player since the last call, in order per
    /// lane: `(reliable, bytes)`. Reliable first, as a reliable stream and a
    /// datagram arriving together would be read.
    pub fn drain(&mut self, mut each: impl FnMut(bool, Vec<u8>)) -> Result<()> {
        while let Some(packet) = self.outbound.try_recv_reliable() {
            each(true, packet.bytes);
        }
        while let Some(packet) = self.outbound.try_recv_datagram() {
            each(false, packet.bytes);
        }
        if *self.outbound.failed.borrow() {
            anyhow::bail!("the match dropped the in-process player (reliable queue overflow)");
        }
        Ok(())
    }

    /// Disconnect the player; the match loop keeps no thread alive for us
    /// once its event channel closes.
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let _ = self.events.send(MatchEvent::Disconnect { player_id: LOCAL_PLAYER_ID });
        info!(match_id = %self.match_id, "in-process session closed");
    }
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn session_config(match_id: &str, physics: &PhysicsRuntimeConfig) -> SessionConfig {
    let city_world = city::is_city_match(match_id);
    let city_manifest_hash = if city_world {
        city::manifest_asset().map(|(hash, _, _)| hash.clone())
    } else {
        None
    };
    SessionConfig {
        match_id: match_id.to_owned(),
        url: "in-process:".to_owned(),
        server_certificate_hash_hex: String::new(),
        sim_hz: physics.sim_hz(),
        snapshot_hz: physics.snapshot_hz(),
        interpolation_delay_ms: physics.interpolation_delay_ms(),
        protocol_version: vibe_land_shared::constants::PROTOCOL_VERSION,
        physics_backend: physics.backend.wire_id(),
        client_movement_mode: physics.client_movement_mode(),
        city_world: city_world && city_manifest_hash.is_some(),
        city_manifest_hash,
        city_wire_version: city::city_wire_version(match_id),
    }
}

/// `spawn_match_loop` without the HTTP server's shared state: the match gets
/// fresh registries nobody else reads.
fn spawn_local_match(
    match_id: String,
    rx: mpsc::UnboundedReceiver<MatchEvent>,
    physics: PhysicsRuntimeConfig,
    telemetry: Arc<MatchIoTelemetry>,
) {
    let strict_snapshot_datagrams = std::env::var("WT_STRICT_SNAPSHOT_DATAGRAMS")
        .ok()
        .map(|value| !matches!(value.as_str(), "0" | "false" | "FALSE" | "no" | "off"))
        .unwrap_or(true);
    let respawn_delay_ms =
        crate::parse_respawn_delay_ms(std::env::var("VIBE_SERVER_RESPAWN_DELAY_MS").ok().as_deref());
    std::thread::Builder::new()
        .name(format!("match-{match_id}"))
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("match runtime should initialize");
            runtime.block_on(async move {
                let (stats_tx, _stats_rx) = tokio::sync::watch::channel(GlobalStatsSnapshot::default());
                let outcome = std::panic::AssertUnwindSafe(run_match_loop(
                    match_id.clone(),
                    rx,
                    strict_snapshot_datagrams,
                    respawn_delay_ms,
                    physics,
                    Arc::new(stats_tx),
                    telemetry,
                    Arc::new(StdRwLock::new(HashMap::new())),
                    Arc::new(StdRwLock::new(HashMap::new())),
                    Arc::new(StdRwLock::new(HashSet::new())),
                    Arc::new(StdRwLock::new(HashMap::new())),
                    Arc::new(StdRwLock::new(HashMap::new())),
                    Arc::new(StdRwLock::new(HashSet::new())),
                ))
                .catch_unwind()
                .await;
                match outcome {
                    Ok(()) => warn!(%match_id, "in-process match loop exited"),
                    Err(payload) => error!(
                        %match_id,
                        panic = %describe_panic_payload(&payload),
                        "in-process match loop panicked"
                    ),
                }
            });
        })
        .expect("match simulation thread should start");
}
