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
use axum::{routing::get, Router};
use futures_util::FutureExt;
use tower::ServiceExt;
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
/// The match's request queues the HTTP server's debug routes write into
/// (`/city-meteor`, `/city-reset`): `run_match_loop` reads them each tick.
#[derive(Clone, Default)]
struct RequestQueues {
    meteors: Arc<StdRwLock<HashMap<String, Vec<[f32; 3]>>>>,
    resets: Arc<StdRwLock<HashSet<String>>>,
}

pub struct LocalSession {
    match_id: String,
    events: mpsc::UnboundedSender<MatchEvent>,
    queues: RequestQueues,
    outbound: outbound::Receiver,
    session_config_json: String,
    /// The city's every-tick body poses, read from memory (pose_feed.rs);
    /// `None` when `VIBE_LOCAL_POSE_FEED=0` (the pose stream alone, as over
    /// a network) or for a match without a city.
    pose_feed: Option<Arc<crate::pose_feed::PoseFeed>>,
    closed: bool,
    /// Runs `request`'s handlers (they are async; the caller is not).
    http: tokio::runtime::Runtime,
}

/// What `request` answers.
pub struct LocalResponse {
    pub status: u16,
    pub content_type: String,
    pub content_encoding: Option<String>,
    pub body: Vec<u8>,
}

/// The server's HTTP routes a client fetches during play that need no server
/// state, with the server's own handlers: vehicle assets (custom cars'
/// metadata), the city manifest and the city's outdoor visuals.
fn local_router() -> Router {
    Router::new()
        .route("/vehicle-assets/:hash/:file", get(crate::vehicle_assets::asset))
        .route("/city-manifest/:hash", get(crate::city_manifest_handler))
        .route("/city-visuals/:hash", get(crate::city_visuals_handler))
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

        let queues = RequestQueues::default();
        // Registered before the match starts: the city runtime looks it up
        // when it opens.
        let pose_feed = (city::is_city_match(match_id) && local_pose_feed_enabled())
            .then(|| crate::pose_feed::register(match_id));
        spawn_local_match(match_id.to_owned(), rx, physics, telemetry, queues.clone());

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
            queues,
            outbound: out_rx,
            session_config_json,
            pose_feed,
            closed: false,
            http: tokio::runtime::Builder::new_current_thread().enable_all().build()?,
        })
    }

    /// Drop the city's meteor on each target, as `POST /city-meteor` does.
    pub fn meteor(&self, targets: &[[f32; 3]]) {
        self.queues
            .meteors
            .write()
            .expect("meteor requests poisoned")
            .entry(self.match_id.clone())
            .or_default()
            .extend_from_slice(targets);
    }

    /// Rebuild the city, as `POST /city-reset` does.
    pub fn reset(&self) {
        self.queues.resets.write().expect("reset requests poisoned").insert(self.match_id.clone());
    }

    /// A fleet car's server-side state, as `GET /city-vehicle-debug?car=` answers
    /// it (`car` is the fleet index: id = city_fleet::FIRST_ID + car).
    pub fn vehicle_debug(&self, car: u32) -> Result<serde_json::Value> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.events
            .send(MatchEvent::GarageDebug { car: crate::city_fleet::FIRST_ID + car, reply })
            .map_err(|_| anyhow::anyhow!("match loop has exited"))?;
        self.http.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(3), response)
                .await
                .context("vehicle debug readback timed out")?
                .context("match loop has exited")?
                .map_err(|(status, message)| anyhow::anyhow!("{status}: {message}"))
        })
    }

    /// The match's current server tick.
    pub fn current_tick(&self) -> Result<u32> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.events
            .send(MatchEvent::CurrentTick { reply })
            .map_err(|_| anyhow::anyhow!("match loop has exited"))?;
        response.blocking_recv().context("match loop has exited")
    }

    /// Lockstep on or off (the native app's film mode). On: the match stops
    /// ticking in real time and advances only by `step`. Off: it ticks at
    /// 60 Hz in real time again from now. Waits until the match has taken
    /// it, so no real-time tick follows `set_lockstep(true)`; returns the
    /// server tick at that moment.
    pub fn set_lockstep(&self, enabled: bool) -> Result<u32> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.events
            .send(MatchEvent::Lockstep { enabled, reply })
            .map_err(|_| anyhow::anyhow!("match loop has exited"))?;
        response.blocking_recv().context("match loop has exited")
    }

    /// In lockstep, advance the match exactly `ticks` ticks after every
    /// packet sent before this call, and wait for them: returns the server
    /// tick reached. The ticks are the match's own (`tick()`, fracture
    /// re-simulation and all), only paced by the caller instead of a timer.
    /// Outside lockstep it advances nothing and returns the current tick.
    pub fn step(&self, ticks: u32) -> Result<u32> {
        if self.closed {
            anyhow::bail!("session closed");
        }
        let (reply, response) = tokio::sync::oneshot::channel();
        self.events
            .send(MatchEvent::Step { ticks, reply })
            .map_err(|_| anyhow::anyhow!("match loop has exited"))?;
        response.blocking_recv().context("match loop has exited")
    }

    /// A GET for one of the server's stateless routes (`local_router`),
    /// answered in-process. Unknown paths answer 404.
    pub fn request(&self, path: &str) -> Result<LocalResponse> {
        let request = axum::http::Request::get(path).body(axum::body::Body::empty())?;
        self.http.block_on(async {
            let Ok(response) = local_router().oneshot(request).await;
            let header = |name: axum::http::header::HeaderName| {
                response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned)
            };
            let status = response.status().as_u16();
            let content_type = header(axum::http::header::CONTENT_TYPE).unwrap_or_default();
            let content_encoding = header(axum::http::header::CONTENT_ENCODING);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?.to_vec();
            Ok(LocalResponse { status, content_type, content_encoding, body })
        })
    }

    /// The city body poses of every tick after `since` (pose_feed.rs's
    /// packing); empty without a feed.
    pub fn poses_since(&self, since: u32) -> Vec<u32> {
        self.pose_feed.as_ref().map(|feed| feed.since(since)).unwrap_or_default()
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
        if self.pose_feed.take().is_some() {
            crate::pose_feed::unregister(&self.match_id);
        }
        let _ = self.events.send(MatchEvent::Disconnect { player_id: LOCAL_PLAYER_ID });
        info!(match_id = %self.match_id, "in-process session closed");
    }
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        self.close();
    }
}

/// `VIBE_LOCAL_POSE_FEED=0` turns the in-memory pose feed off, leaving the
/// client on the network pose stream (to compare the two).
fn local_pose_feed_enabled() -> bool {
    !matches!(std::env::var("VIBE_LOCAL_POSE_FEED").as_deref(), Ok("0" | "false" | "off"))
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
    queues: RequestQueues,
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
                    queues.resets,
                    Arc::new(StdRwLock::new(HashMap::new())),
                    queues.meteors,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Film mode's sim half: in lockstep the match does not tick on its own,
    /// each `step(n)` advances exactly n ticks, and leaving lockstep returns
    /// it to 60 Hz real time.
    #[test]
    fn lockstep_advances_exactly_the_ticks_stepped() {
        // The demo world on Rapier: no GPU, no city assets.
        std::env::set_var("VIBE_PHYSICS_BACKEND", "rapier");
        let mut session = LocalSession::start("lockstep-test").expect("in-process match starts");
        let mut drain = |session: &mut LocalSession| session.drain(|_, _| {}).expect("player stays connected");

        // Real time first: the match ticks by itself, at the rate this build
        // manages (60 Hz in release; a debug build's Rapier may be slower).
        let rate = |session: &mut LocalSession| {
            let (tick, since) = (session.current_tick().unwrap(), Instant::now());
            std::thread::sleep(Duration::from_millis(600));
            drain(session);
            (session.current_tick().unwrap() - tick) as f64 / since.elapsed().as_secs_f64()
        };
        let real_time_rate = rate(&mut session);
        assert!(real_time_rate > 5.0, "the match should tick in real time ({real_time_rate:.1}/s)");

        // Lockstep: nothing moves without a step...
        let base = session.set_lockstep(true).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(session.current_tick().unwrap(), base, "a lockstepped match must not tick by itself");

        // ...and each frame of a 30 fps film advances exactly two ticks,
        // however long the frame took on the wall clock.
        let mut stepping = Duration::ZERO;
        for frame in 1..=120u32 {
            if frame % 40 == 0 {
                std::thread::sleep(Duration::from_millis(50));
            }
            let step_started = Instant::now();
            let reached = session.step(2).unwrap();
            if frame > 100 {
                stepping += step_started.elapsed();
            }
            assert_eq!(reached, base + 2 * frame, "frame {frame}");
            drain(&mut session);
        }
        assert_eq!(session.current_tick().unwrap(), base + 240);
        // Other step sizes are exact too (60 fps films step one).
        assert_eq!(session.step(1).unwrap(), base + 241);
        assert_eq!(session.step(0).unwrap(), base + 241);

        // Back to real time: 60 Hz again (or as fast as this build's ticks
        // allow -- a debug build's cannot keep up), with no burst for the
        // time spent in lockstep.
        let resumed = session.set_lockstep(false).unwrap();
        assert_eq!(resumed, base + 241);
        let tick_s = stepping.as_secs_f64() / 40.0;
        let sustainable = (1.0 / tick_s).min(60.0);
        let after = rate(&mut session);
        eprintln!(
            "real time: {real_time_rate:.1} ticks/s before lockstep, {after:.1} after \
             ({:.2} ms a tick, {sustainable:.1}/s sustainable)",
            tick_s * 1000.0
        );
        assert!(
            after > sustainable * 0.6 && after < 63.0,
            "{after:.1} ticks/s after lockstep, expected ~{sustainable:.1}"
        );
        // Outside lockstep a step is a no-op.
        let now = session.current_tick().unwrap();
        assert!(session.step(5).unwrap() < now + 5);
        session.close();
    }
}
