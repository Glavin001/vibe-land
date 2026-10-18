//! Outbound liveness reporting to the orchestration control plane.
//!
//! The control plane never dials in: Vast instances sit behind random high
//! ports on shared IPs, so every fact the fleet knows about this process
//! arrives through this loop. That inverts the usual health-check direction and
//! makes delivery load-bearing -- a process that stops heartbeating is reaped
//! within 90 s, so the loop retries forever rather than giving up on an error.
//!
//! It also carries the connect metadata (WebTransport URL, certificate hash)
//! browsers need. They cannot fetch `/session-config` from this box directly:
//! the certificate is self-signed, and `serverCertificateHashes` only rescues
//! the WebTransport handshake, not a plain `fetch()`. So the control plane
//! relays it instead.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tracing::{debug, info, warn};

use crate::AppState;

const INTERVAL: Duration = Duration::from_secs(30);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const JITTER_MAX: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct HeartbeatConfig {
    control_plane_url: String,
    server_do_id: String,
    token: String,
    public_ip: String,
    udp_port: u16,
    capacity: u32,
}

impl HeartbeatConfig {
    /// Absent unless the full control-plane triple is present, which is how a
    /// local `cargo run` stays silent instead of retrying against nothing.
    pub(crate) fn from_env() -> Option<Self> {
        let control_plane_url = non_empty_env("CONTROL_PLANE_URL")?;
        let server_do_id = non_empty_env("SERVER_DO_ID")?;
        let token = non_empty_env("HEARTBEAT_TOKEN")?;

        Some(Self {
            control_plane_url: control_plane_url.trim_end_matches('/').to_string(),
            server_do_id,
            token,
            // The entrypoint resolves these from Vast's port mapping. Falling
            // back to the internal bind port would advertise an address no
            // client can reach, so prefer an obviously-wrong 0 that shows up in
            // the fleet view over a plausible lie.
            public_ip: non_empty_env("HEARTBEAT_PUBLIC_IP").unwrap_or_default(),
            udp_port: non_empty_env("HEARTBEAT_UDP_PORT")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            capacity: non_empty_env("MATCHES_PER_BOX")
                .and_then(|value| value.parse().ok())
                .unwrap_or(6),
        })
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct HeartbeatBody {
    pub server_do_id: String,
    pub ip: String,
    pub udp_port: u16,
    pub cert_hash: String,
    pub active_matches: u32,
    pub players: u32,
    pub capacity: u32,
    pub session: SessionBlock,
}

/// The subset of `/session-config` a browser needs before it can open a
/// WebTransport session. Mirrors `SessionConfig` in `main.rs`; kept flat so the
/// control plane can hand it back verbatim without understanding any of it.
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct SessionBlock {
    pub url: String,
    pub sim_hz: u16,
    pub snapshot_hz: u16,
    pub interpolation_delay_ms: u16,
    pub protocol_version: u16,
    pub physics_backend: u8,
    pub client_movement_mode: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city_manifest_hash: Option<String>,
}

#[derive(Debug, serde::Deserialize, Default)]
struct HeartbeatReply {
    /// Reserved: "finish current matches, accept no new ones". Parsed now so
    /// the control plane can start sending it before the server acts on it.
    #[serde(default)]
    #[allow(dead_code)]
    drain: bool,
}

/// Counts reported to the fleet. `active_matches` drives idle shutdown, so it
/// counts live match loops rather than connected players -- a match with zero
/// players still holds a PhysX scene and should keep the box alive only as long
/// as the loop exists.
pub(crate) async fn fleet_stats(state: &AppState) -> (u32, u32) {
    let active_matches = state.matches.read().await.len() as u32;
    let players = state
        .stats_registry
        .read()
        .expect("stats registry poisoned")
        .values()
        .map(|stats| stats.player_count as u32)
        .sum();
    (active_matches, players)
}

async fn build_body(state: &AppState, config: &HeartbeatConfig) -> HeartbeatBody {
    let (active_matches, players) = fleet_stats(state).await;
    HeartbeatBody {
        server_do_id: config.server_do_id.clone(),
        ip: config.public_ip.clone(),
        udp_port: config.udp_port,
        cert_hash: state.cert_hash_hex.clone(),
        active_matches,
        players,
        capacity: config.capacity,
        session: SessionBlock {
            url: format!("{}/game", state.wt_base_url),
            sim_hz: state.physics.sim_hz(),
            snapshot_hz: state.physics.snapshot_hz(),
            interpolation_delay_ms: state.physics.interpolation_delay_ms(),
            protocol_version: vibe_land_shared::constants::PROTOCOL_VERSION,
            physics_backend: state.physics.backend.wire_id(),
            client_movement_mode: state.physics.client_movement_mode(),
            city_manifest_hash: crate::city::manifest_asset().map(|(hash, _, _)| hash.clone()),
        },
    }
}

/// Spread beats across the fleet so N boxes booted together do not converge on
/// the same instant. Derived from the clock rather than `rand` to avoid pulling
/// a dependency in for three bits of entropy.
fn jitter() -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.subsec_nanos())
        .unwrap_or(0);
    Duration::from_millis(u64::from(nanos) % (JITTER_MAX.as_millis() as u64 + 1))
}

pub(crate) fn spawn(state: Arc<AppState>, config: HeartbeatConfig) {
    let endpoint = format!("{}/servers/heartbeat", config.control_plane_url);
    info!(
        %endpoint,
        server_do_id = %config.server_do_id,
        advertised = %format!("{}:{}", config.public_ip, config.udp_port),
        capacity = config.capacity,
        "heartbeat enabled"
    );

    tokio::spawn(async move {
        let http = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(client) => client,
            Err(err) => {
                warn!(error = ?err, "heartbeat disabled: could not build HTTP client");
                return;
            }
        };

        // First beat goes out immediately -- it is what promotes this instance
        // from BOOTING to READY, so every millisecond of delay is cold-start
        // time a player waits through.
        loop {
            let body = build_body(&state, &config).await;
            let delay = match http
                .post(&endpoint)
                .bearer_auth(&config.token)
                .json(&body)
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    let reply: HeartbeatReply = response.json().await.unwrap_or_default();
                    debug!(
                        active_matches = body.active_matches,
                        players = body.players,
                        drain = reply.drain,
                        "heartbeat delivered"
                    );
                    INTERVAL
                }
                Ok(response) => {
                    warn!(status = %response.status(), "heartbeat rejected");
                    RETRY_DELAY
                }
                Err(err) => {
                    warn!(error = %err, "heartbeat failed");
                    RETRY_DELAY
                }
            };
            tokio::time::sleep(delay + jitter()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_body() -> HeartbeatBody {
        HeartbeatBody {
            server_do_id: "srv-1".to_string(),
            ip: "203.0.113.7".to_string(),
            udp_port: 40687,
            cert_hash: "ab12".to_string(),
            active_matches: 2,
            players: 5,
            capacity: 6,
            session: SessionBlock {
                url: "https://203.0.113.7:40687/game".to_string(),
                sim_hz: 60,
                snapshot_hz: 30,
                interpolation_delay_ms: 100,
                protocol_version: 3,
                physics_backend: 2,
                client_movement_mode: 1,
                city_manifest_hash: None,
            },
        }
    }

    /// The control plane parses these names verbatim; renaming a field here is
    /// a wire break that no compiler catches on either side.
    #[test]
    fn body_serializes_with_the_field_names_the_control_plane_expects() {
        let json = serde_json::to_value(sample_body()).expect("serialize");

        assert_eq!(json["server_do_id"], "srv-1");
        assert_eq!(json["ip"], "203.0.113.7");
        assert_eq!(json["udp_port"], 40687);
        assert_eq!(json["cert_hash"], "ab12");
        assert_eq!(json["active_matches"], 2);
        assert_eq!(json["players"], 5);
        assert_eq!(json["capacity"], 6);
        assert_eq!(json["session"]["url"], "https://203.0.113.7:40687/game");
        assert_eq!(json["session"]["protocol_version"], 3);
    }

    /// `city_manifest_hash` absent means "not a city build", which the client
    /// distinguishes from a present-but-null hash when deciding whether to
    /// bootstrap the destruction stream.
    #[test]
    fn absent_city_manifest_hash_is_omitted_rather_than_null() {
        let json = serde_json::to_value(sample_body()).expect("serialize");
        assert!(json["session"].get("city_manifest_hash").is_none());
    }

    #[test]
    fn jitter_stays_within_the_advertised_bound() {
        for _ in 0..100 {
            assert!(jitter() <= JITTER_MAX);
        }
    }

    #[test]
    fn reply_defaults_to_no_drain_when_body_is_empty() {
        let reply: HeartbeatReply = serde_json::from_str("{}").expect("parse");
        assert!(!reply.drain);
    }
}
