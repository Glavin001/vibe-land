//! Native WebTransport adapter for vibe-land's client core.
//!
//! The client core is sans-IO: bytes in, scene state out. This crate is the I/O around it for native
//! clients (the Unreal client and headless tools); the browser supplies its own WebTransport. It
//! fetches `/session-config`, downloads the city manifest, opens the WebTransport session, sends the
//! hello, and then moves packets between the network and the game thread:
//!
//! * a tokio runtime (two `vl-net` threads) owns all sockets;
//! * inbound packets arrive on [`Transport::try_recv`] with their arrival time on [`Transport::now_us`]'s
//!   clock, in arrival order, tagged with their lane;
//! * the game thread sends datagrams synchronously and reliable packets through a writer task.
//!
//! The server's latency pings are echoed here, on the network thread, so a slow render frame never
//! inflates the server's RTT estimate. The session's reliable stream carries `[u32 LE len][packet]`
//! frames; readers run as their own tasks because `read_exact` is not cancellation-safe.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self as std_mpsc, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc as tokio_mpsc;
use vibe_land_shared::constants::{CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE, PKT_PING};
use vibe_land_shared::net_client::{
    encode_client_hello, encode_ping, frame_reliable, SessionConfig,
};

/// Which lane a packet arrived on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    Reliable,
    Datagram,
}

/// Where the connection is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportState {
    FetchingConfig,
    FetchingManifest,
    Connecting,
    /// The session is open and the hello was sent.
    Connected,
    /// The server or the network closed the session.
    Closed(String),
    /// Setup failed before the session opened.
    Failed(String),
}

/// What the transport hands the game thread, in order.
#[derive(Debug)]
pub enum Inbound {
    State(TransportState),
    /// The match's session config, before the session opens.
    SessionConfig(SessionConfig),
    /// The uncompressed city manifest (VLCM), when the match has one. The client core checks it
    /// against `SessionConfig::city_manifest_hash`.
    Manifest(Vec<u8>),
    Packet {
        lane: Lane,
        bytes: Vec<u8>,
        arrival_us: u64,
    },
}

#[derive(Clone, Debug)]
pub struct TransportConfig {
    /// The server's HTTP origin, e.g. `http://127.0.0.1:4001`.
    pub api_base_url: String,
    pub match_id: String,
    /// Movement capability bits for the hello.
    pub movement_caps: u8,
}

impl TransportConfig {
    pub fn new(api_base_url: impl Into<String>, match_id: impl Into<String>) -> Self {
        Self {
            api_base_url: api_base_url.into().trim_end_matches('/').to_string(),
            match_id: match_id.into(),
            movement_caps: CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE,
        }
    }
}

/// Counters, readable from any thread.
#[derive(Debug, Default)]
pub struct TransportStats {
    pub datagrams_in: AtomicU64,
    pub datagram_bytes_in: AtomicU64,
    pub reliable_in: AtomicU64,
    pub reliable_bytes_in: AtomicU64,
    pub datagrams_out: AtomicU64,
    pub datagrams_dropped: AtomicU64,
    pub reliable_out: AtomicU64,
    pub pings_echoed: AtomicU64,
    /// QUIC's smoothed RTT in microseconds, sampled every 250 ms.
    pub rtt_us: AtomicU64,
}

pub struct Transport {
    runtime: Option<tokio::runtime::Runtime>,
    origin: Instant,
    inbound: Receiver<Inbound>,
    connection: Arc<Mutex<Option<wtransport::Connection>>>,
    reliable_out: tokio_mpsc::UnboundedSender<Vec<u8>>,
    stats: Arc<TransportStats>,
}

impl Transport {
    /// Start connecting in the background. Progress and packets arrive on [`try_recv`](Self::try_recv).
    pub fn start(config: TransportConfig) -> std::io::Result<Self> {
        // wtransport and reqwest both use rustls; with only ring enabled the provider is
        // unambiguous, but install it explicitly so a host that links another rustls user still works.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("vl-net")
            .enable_all()
            .build()?;
        let origin = Instant::now();
        let (inbound_tx, inbound) = std_mpsc::channel();
        let (reliable_out, reliable_rx) = tokio_mpsc::unbounded_channel();
        let connection = Arc::new(Mutex::new(None));
        let stats = Arc::new(TransportStats::default());

        let task = Session {
            config,
            origin,
            inbound: inbound_tx,
            connection: connection.clone(),
            stats: stats.clone(),
        };
        runtime.spawn(task.run(reliable_rx));

        Ok(Self {
            runtime: Some(runtime),
            origin,
            inbound,
            connection,
            reliable_out,
            stats,
        })
    }

    /// Microseconds since the transport started: the clock inbound arrival times are on. Pass it
    /// to the client core as its `now`, so arrival times and the present agree.
    pub fn now_us(&self) -> u64 {
        self.origin.elapsed().as_micros() as u64
    }

    /// The next inbound event, if any. Never blocks.
    pub fn try_recv(&self) -> Option<Inbound> {
        self.inbound.try_recv().ok()
    }

    /// Send one datagram now. Returns false when the session is not open or the datagram was
    /// refused (too large for the path, or the session closed).
    pub fn send_datagram(&self, bytes: &[u8]) -> bool {
        let guard = self
            .connection
            .lock()
            .expect("transport connection lock poisoned");
        let Some(connection) = guard.as_ref() else {
            return false;
        };
        match connection.send_datagram(bytes) {
            Ok(()) => {
                self.stats.datagrams_out.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(_) => {
                self.stats.datagrams_dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Queue a packet on the reliable stream (framed here).
    pub fn send_reliable(&self, packet: &[u8]) {
        let _ = self.reliable_out.send(frame_reliable(packet));
    }

    pub fn stats(&self) -> &TransportStats {
        &self.stats
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.lock().ok().and_then(|mut c| c.take()) {
            connection.close(0u32.into(), b"client closed");
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_millis(500));
        }
    }
}

struct Session {
    config: TransportConfig,
    origin: Instant,
    inbound: Sender<Inbound>,
    connection: Arc<Mutex<Option<wtransport::Connection>>>,
    stats: Arc<TransportStats>,
}

impl Session {
    async fn run(self, reliable_rx: tokio_mpsc::UnboundedReceiver<Vec<u8>>) {
        let state = match self.connect(reliable_rx).await {
            Ok(reason) => TransportState::Closed(reason),
            Err(error) => TransportState::Failed(error),
        };
        *self
            .connection
            .lock()
            .expect("transport connection lock poisoned") = None;
        let _ = self.inbound.send(Inbound::State(state));
    }

    fn emit(&self, event: Inbound) {
        let _ = self.inbound.send(event);
    }

    /// Runs until the session ends; Ok(reason) for a close after the session opened.
    async fn connect(
        &self,
        reliable_rx: tokio_mpsc::UnboundedReceiver<Vec<u8>>,
    ) -> Result<String, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client: {e}"))?;

        self.emit(Inbound::State(TransportState::FetchingConfig));
        let config_url = format!(
            "{}/session-config?match_id={}",
            self.config.api_base_url,
            percent_encode(&self.config.match_id)
        );
        let body = http_get(&http, &config_url).await?;
        let session =
            SessionConfig::from_json(&body).map_err(|e| format!("session-config: {e}"))?;
        self.emit(Inbound::SessionConfig(session.clone()));

        if let Some(hash) = session
            .city_manifest_hash
            .as_deref()
            .filter(|h| !h.is_empty())
        {
            self.emit(Inbound::State(TransportState::FetchingManifest));
            let url = format!("{}/city-manifest/{hash}", self.config.api_base_url);
            self.emit(Inbound::Manifest(http_get(&http, &url).await?));
        }

        self.emit(Inbound::State(TransportState::Connecting));
        let builder = wtransport::ClientConfig::builder().with_bind_default();
        let client_config = if session.server_certificate_hash_hex.is_empty() {
            builder.with_native_certs().build()
        } else {
            let digest: [u8; 32] = hex::decode(&session.server_certificate_hash_hex)
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| {
                    "session-config certificate hash is not 32 bytes of hex".to_string()
                })?;
            builder
                .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(digest)])
                .build()
        };
        let endpoint =
            wtransport::Endpoint::client(client_config).map_err(|e| format!("endpoint: {e}"))?;
        let connection =
            tokio::time::timeout(Duration::from_secs(15), endpoint.connect(&session.url))
                .await
                .map_err(|_| format!("connecting to {} timed out", session.url))?
                .map_err(|e| format!("connecting to {}: {e}", session.url))?;

        let (mut send, recv) = connection
            .open_bi()
            .await
            .map_err(|e| format!("open stream: {e}"))?
            .await
            .map_err(|e| format!("open stream: {e}"))?;
        let hello = frame_reliable(&encode_client_hello(
            &self.config.match_id,
            self.config.movement_caps,
        ));
        send.write_all(&hello)
            .await
            .map_err(|e| format!("send hello: {e}"))?;

        *self
            .connection
            .lock()
            .expect("transport connection lock poisoned") = Some(connection.clone());
        self.emit(Inbound::State(TransportState::Connected));

        let writer = tokio::spawn(write_reliable(send, reliable_rx, self.stats.clone()));
        let reliable = tokio::spawn(read_reliable(recv, self.reader_context(&connection)));
        let datagrams = tokio::spawn(read_datagrams(
            connection.clone(),
            self.reader_context(&connection),
        ));
        let rtt = tokio::spawn(sample_rtt(connection.clone(), self.stats.clone()));

        let reason = connection.closed().await.to_string();
        writer.abort();
        reliable.abort();
        datagrams.abort();
        rtt.abort();
        Ok(reason)
    }

    fn reader_context(&self, connection: &wtransport::Connection) -> ReaderContext {
        ReaderContext {
            origin: self.origin,
            inbound: self.inbound.clone(),
            connection: connection.clone(),
            stats: self.stats.clone(),
        }
    }
}

struct ReaderContext {
    origin: Instant,
    inbound: Sender<Inbound>,
    connection: wtransport::Connection,
    stats: Arc<TransportStats>,
}

impl ReaderContext {
    /// Echo a server ping at once, then forward the packet. False when the game side is gone.
    fn deliver(&self, lane: Lane, bytes: Vec<u8>) -> bool {
        if bytes.len() >= 5 && bytes[0] == PKT_PING {
            let nonce = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
            if self.connection.send_datagram(encode_ping(nonce)).is_ok() {
                self.stats.pings_echoed.fetch_add(1, Ordering::Relaxed);
            }
        }
        let arrival_us = self.origin.elapsed().as_micros() as u64;
        self.inbound
            .send(Inbound::Packet {
                lane,
                bytes,
                arrival_us,
            })
            .is_ok()
    }
}

async fn read_reliable(mut recv: wtransport::RecvStream, ctx: ReaderContext) {
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
        ctx.stats.reliable_in.fetch_add(1, Ordering::Relaxed);
        ctx.stats
            .reliable_bytes_in
            .fetch_add(len as u64, Ordering::Relaxed);
        if !ctx.deliver(Lane::Reliable, frame) {
            break;
        }
    }
}

async fn read_datagrams(connection: wtransport::Connection, ctx: ReaderContext) {
    while let Ok(datagram) = connection.receive_datagram().await {
        let bytes = datagram.payload().to_vec();
        if bytes.is_empty() {
            continue;
        }
        ctx.stats.datagrams_in.fetch_add(1, Ordering::Relaxed);
        ctx.stats
            .datagram_bytes_in
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if !ctx.deliver(Lane::Datagram, bytes) {
            break;
        }
    }
}

async fn write_reliable(
    mut send: wtransport::SendStream,
    mut frames: tokio_mpsc::UnboundedReceiver<Vec<u8>>,
    stats: Arc<TransportStats>,
) {
    while let Some(frame) = frames.recv().await {
        if send.write_all(&frame).await.is_err() {
            break;
        }
        stats.reliable_out.fetch_add(1, Ordering::Relaxed);
    }
}

async fn sample_rtt(connection: wtransport::Connection, stats: Arc<TransportStats>) {
    let mut every = tokio::time::interval(Duration::from_millis(250));
    loop {
        every.tick().await;
        stats
            .rtt_us
            .store(connection.rtt().as_micros() as u64, Ordering::Relaxed);
    }
}

async fn http_get(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {url}: HTTP {status}"));
    }
    Ok(response
        .bytes()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?
        .to_vec())
}

/// Match ids are `[A-Za-z0-9-_.]` in practice; escape anything else for the query string.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
