//! Publishes simulated vibe-land world state to a MoQ relay.
//!
//! The interesting part is the track layout, not the simulation. World state is
//! split into one track per region plus a `meta` track, and each track runs at
//! its own rate:
//!
//! ```text
//!   vibe-land/demo
//!     region-0   10 Hz   priority 0    the block the player is standing in
//!     region-1    5 Hz   priority 1
//!     region-2    2 Hz   priority 2
//!     region-3    1 Hz   priority 3    scenery on the horizon
//!     meta      0.5 Hz   priority 8    round number, headline, destroyed %
//! ```
//!
//! A subscriber takes only the tracks it cares about, so a client that can see
//! one city block pays for one city block. Each track opens a new group every
//! `--group-seconds`; object 0 of a group is a full snapshot of the region and
//! the rest are deltas against it, which is what lets a late joiner start
//! rendering without asking anyone for a keyframe.

mod cli;
mod wire;
mod world;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use clap::Parser;
use moq_native_ietf::quic;
use moq_transport::{
    coding::TrackNamespace,
    serve::{self, Datagram, DatagramsWriter, Subgroup, SubgroupsWriter},
    session::Publisher,
};
use tokio::time::MissedTickBehavior;

use cli::Cli;
use world::{World, REGION_COUNT};

/// Priority for the `meta` track. Lower is sent first under congestion, so the
/// region tracks all outrank it.
const META_PRIORITY: u8 = 8;

#[derive(Clone, Copy)]
enum TrackKind {
    Region(u8),
    Meta,
    Synthetic { track_id: u32, payload_bytes: usize },
}

struct TrackPlan {
    name: String,
    kind: TrackKind,
    hz: f64,
    priority: u8,
}

#[derive(Default)]
struct TrackStats {
    objects: AtomicU64,
    bytes: AtomicU64,
}

impl TrackStats {
    fn record(&self, len: usize) {
        self.objects.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(len as u64, Ordering::Relaxed);
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logs go to stderr so stdout stays free for piping.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,quinn=warn")),
        )
        .init();

    let config = Cli::parse();
    if config.benchmark_tracks > 0
        && !(wire::BENCHMARK_HEADER_LEN..=u32::MAX as usize)
            .contains(&config.benchmark_payload_bytes)
    {
        anyhow::bail!(
            "--benchmark-payload-bytes must be between {} and {}",
            wire::BENCHMARK_HEADER_LEN,
            u32::MAX
        );
    }
    if config.benchmark_datagrams && config.benchmark_tracks == 0 {
        anyhow::bail!("--benchmark-datagrams requires --benchmark-tracks");
    }
    let tls = config.tls.load()?;

    let quic = quic::Endpoint::new(quic::Config::new(config.bind, None, tls)?)?;

    tracing::info!(url = %redact_token(&config.url), "connecting to relay");
    let (session, connection_id, transport) = quic
        .client
        .connect(&config.url, None)
        .await
        .context("failed to connect to the relay")?;

    let (session, mut publisher) = Publisher::connect(session, transport)
        .await
        .context("failed to establish the MoQ session")?;
    tracing::info!(connection_id, "session established");

    let namespace = TrackNamespace::from_utf8_path(&config.namespace);
    let (mut tracks_writer, _tracks_request, tracks_reader) =
        serve::Tracks::new(namespace.clone()).produce();

    let seed = config.seed.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    });
    let world = Arc::new(Mutex::new(World::new(seed)));
    tracing::info!(seed, namespace = %config.namespace, "starting world simulation");

    let mut tasks = tokio::task::JoinSet::new();
    let mut reported: Vec<(String, Arc<TrackStats>)> = Vec::new();

    for plan in track_plans(&config) {
        let track_writer = tracks_writer
            .create(plan.name.as_str())
            .context("track namespace was already closed")?;

        let stats = Arc::new(TrackStats::default());
        reported.push((plan.name.clone(), stats.clone()));

        tracing::info!(
            track = %plan.name,
            hz = plan.hz,
            priority = plan.priority,
            "publishing track"
        );

        if config.benchmark_datagrams {
            let datagrams = track_writer
                .datagrams()
                .context("failed to switch the track into datagram mode")?;
            tasks.spawn(run_datagram_track(datagrams, plan, stats));
        } else {
            let subgroups = track_writer
                .subgroups()
                .context("failed to switch the track into subgroup mode")?;
            tasks.spawn(run_track(
                subgroups,
                plan,
                world.clone(),
                stats,
                config.group_seconds,
            ));
        }
    }

    if config.benchmark_tracks == 0 {
        tasks.spawn(run_simulation(world.clone(), config.tick_hz));
    }

    if config.stats_seconds > 0.0 {
        tasks.spawn(run_stats(reported, config.stats_seconds));
    }

    tokio::select! {
        res = session.run() => res.context("session error")?,
        res = publisher.publish_namespace(tracks_reader) => res.context("failed to serve tracks")?,
        Some(res) = tasks.join_next() => res.context("task panicked")??,
    }

    Ok(())
}

fn track_plans(config: &Cli) -> Vec<TrackPlan> {
    if config.benchmark_tracks > 0 {
        return (0..config.benchmark_tracks)
            .map(|track_id| TrackPlan {
                name: format!("benchmark-{track_id}"),
                kind: TrackKind::Synthetic {
                    track_id: track_id as u32,
                    payload_bytes: config.benchmark_payload_bytes,
                },
                hz: config.benchmark_hz.max(0.01),
                priority: u8::try_from(track_id).unwrap_or(u8::MAX),
            })
            .collect();
    }

    let mut plans = Vec::with_capacity(REGION_COUNT + 1);

    for region in 0..REGION_COUNT {
        // Fall back to the slowest configured rate when the caller passes fewer
        // rates than there are regions.
        let hz = config
            .region_hz
            .get(region)
            .copied()
            .or_else(|| config.region_hz.last().copied())
            .unwrap_or(1.0)
            .max(0.01);

        plans.push(TrackPlan {
            name: format!("region-{region}"),
            kind: TrackKind::Region(region as u8),
            hz,
            priority: region as u8,
        });
    }

    plans.push(TrackPlan {
        name: "meta".to_string(),
        kind: TrackKind::Meta,
        hz: config.meta_hz.max(0.01),
        priority: META_PRIORITY,
    });

    plans
}

/// Steps the shared world at a fixed rate. Every track reads from this one
/// simulation, so the regions stay consistent with each other regardless of how
/// often each one publishes.
async fn run_simulation(world: Arc<Mutex<World>>, tick_hz: u32) -> anyhow::Result<()> {
    let tick_hz = tick_hz.max(1);
    let dt = 1.0 / tick_hz as f32;

    let mut interval = tokio::time::interval(Duration::from_secs_f64(1.0 / tick_hz as f64));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        world.lock().expect("world mutex poisoned").step(dt);
    }
}

/// Publishes one track forever: a new group every `group_seconds`, opening with
/// a snapshot and following it with deltas.
async fn run_track(
    mut subgroups: SubgroupsWriter,
    plan: TrackPlan,
    world: Arc<Mutex<World>>,
    stats: Arc<TrackStats>,
    group_seconds: f64,
) -> anyhow::Result<()> {
    let objects_per_group = ((group_seconds * plan.hz).round() as u64).max(1);

    let mut interval = tokio::time::interval(Duration::from_secs_f64(1.0 / plan.hz));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut group_id: u64 = 0;
    // Newest world version this track has already published. Deltas carry
    // everything above it, so nothing is missed even when the rate is slow.
    let mut watermark: u64 = 0;

    loop {
        let mut subgroup = subgroups
            .create(Subgroup {
                group_id,
                subgroup_id: 0,
                priority: plan.priority,
            })
            .with_context(|| format!("failed to open group {group_id} on {}", plan.name))?;

        for object_index in 0..objects_per_group {
            interval.tick().await;

            let payload = {
                let world = world.lock().expect("world mutex poisoned");
                let published_at = now_ms();

                match plan.kind {
                    TrackKind::Region(region) => {
                        let is_snapshot = object_index == 0;
                        let chunks = if is_snapshot {
                            world.snapshot(region)
                        } else {
                            world.delta(region, watermark)
                        };
                        watermark = world.version;

                        let kind = if is_snapshot {
                            wire::KIND_SNAPSHOT
                        } else {
                            wire::KIND_DELTA
                        };
                        wire::encode_region(kind, world.tick, published_at, region, &chunks)
                    }
                    TrackKind::Meta => wire::encode_meta(
                        world.tick,
                        published_at,
                        world.round,
                        world.players_alive,
                        world.destroyed_pct(),
                        &world.headline,
                    ),
                    TrackKind::Synthetic {
                        track_id,
                        payload_bytes,
                    } => wire::encode_benchmark(
                        track_id,
                        group_id * objects_per_group + object_index,
                        now_us(),
                        payload_bytes,
                    ),
                }
            };

            stats.record(payload.len());
            subgroup
                .write(payload)
                .with_context(|| format!("failed to write an object on {}", plan.name))?;
        }

        // Dropping the writer closes the QUIC stream, which is what marks the
        // end of the group for subscribers.
        group_id += 1;
    }
}

async fn run_datagram_track(
    mut datagrams: DatagramsWriter,
    plan: TrackPlan,
    stats: Arc<TrackStats>,
) -> anyhow::Result<()> {
    let TrackKind::Synthetic {
        track_id,
        payload_bytes,
    } = plan.kind
    else {
        anyhow::bail!("datagram mode is only available for synthetic benchmark tracks");
    };

    let mut interval = tokio::time::interval(Duration::from_secs_f64(1.0 / plan.hz));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut sequence = 0_u64;

    loop {
        interval.tick().await;
        let payload = wire::encode_benchmark(track_id, sequence, now_us(), payload_bytes);
        stats.record(payload.len());
        datagrams
            .write(Datagram {
                group_id: sequence,
                object_id: 0,
                priority: plan.priority,
                payload,
                extension_headers: Default::default(),
            })
            .with_context(|| format!("failed to write datagram on {}", plan.name))?;
        sequence += 1;
    }
}

/// Prints per-track throughput so the numbers in the README can be checked
/// against a live run.
async fn run_stats(tracks: Vec<(String, Arc<TrackStats>)>, seconds: f64) -> anyhow::Result<()> {
    let mut interval = tokio::time::interval(Duration::from_secs_f64(seconds));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval.tick().await; // The first tick fires immediately; skip it.

    let mut previous: Vec<(u64, u64)> = vec![(0, 0); tracks.len()];

    loop {
        interval.tick().await;

        let mut total_bytes_per_second = 0.0;
        let mut parts = Vec::with_capacity(tracks.len());

        for (index, (name, stats)) in tracks.iter().enumerate() {
            let objects = stats.objects.load(Ordering::Relaxed);
            let bytes = stats.bytes.load(Ordering::Relaxed);
            let (previous_objects, previous_bytes) = previous[index];
            previous[index] = (objects, bytes);

            let objects_per_second = (objects - previous_objects) as f64 / seconds;
            let bytes_per_second = (bytes - previous_bytes) as f64 / seconds;
            total_bytes_per_second += bytes_per_second;

            parts.push(format!(
                "{name} {objects_per_second:.1}/s {:.1} kB/s",
                bytes_per_second / 1000.0
            ));
        }

        tracing::info!(
            total_kb_per_second = format!("{:.1}", total_bytes_per_second / 1000.0),
            "{}",
            parts.join("  |  ")
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

/// Cloudflare relay tokens live in the URL path, so keep them out of the logs.
fn redact_token(url: &url::Url) -> String {
    let mut redacted = url.clone();
    if url.path().len() > 1 {
        redacted.set_path("/<token>");
    }
    redacted.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(args: &[&str]) -> Cli {
        let mut argv = vec!["vibe-moq-publisher", "https://relay.example/token"];
        argv.extend_from_slice(args);
        Cli::parse_from(argv)
    }

    #[test]
    fn default_plan_has_one_track_per_region_plus_meta() {
        let plans = track_plans(&cli(&[]));
        assert_eq!(plans.len(), REGION_COUNT + 1);

        let names: Vec<&str> = plans.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            ["region-0", "region-1", "region-2", "region-3", "meta"]
        );

        // Rates fan out from the near region to the horizon.
        let rates: Vec<f64> = plans.iter().map(|p| p.hz).collect();
        assert_eq!(rates, [10.0, 5.0, 2.0, 1.0, 0.5]);
    }

    #[test]
    fn short_rate_lists_fall_back_to_the_slowest_given_rate() {
        let plans = track_plans(&cli(&["--region-hz", "20,4"]));
        let rates: Vec<f64> = plans
            .iter()
            .filter(|p| matches!(p.kind, TrackKind::Region(_)))
            .map(|p| p.hz)
            .collect();
        assert_eq!(rates, [20.0, 4.0, 4.0, 4.0]);
    }

    #[test]
    fn benchmark_plan_uses_requested_shape() {
        let config = cli(&[
            "--benchmark-tracks",
            "3",
            "--benchmark-hz",
            "60",
            "--benchmark-payload-bytes",
            "16000",
        ]);
        let plans = track_plans(&config);
        assert_eq!(plans.len(), 3);
        assert_eq!(plans[2].name, "benchmark-2");
        assert_eq!(plans[2].hz, 60.0);
        assert!(matches!(
            plans[2].kind,
            TrackKind::Synthetic {
                track_id: 2,
                payload_bytes: 16000
            }
        ));
    }

    #[test]
    fn region_tracks_outrank_meta_under_congestion() {
        let plans = track_plans(&cli(&[]));
        for plan in &plans {
            match plan.kind {
                TrackKind::Region(_) => assert!(plan.priority < META_PRIORITY),
                TrackKind::Meta => assert_eq!(plan.priority, META_PRIORITY),
                TrackKind::Synthetic { .. } => panic!("default plan included benchmark track"),
            }
        }
    }

    #[test]
    fn tokens_are_redacted_from_logged_urls() {
        let url = url::Url::parse("https://draft-16.cloudflare.mediaoverquic.com/secret").unwrap();
        assert_eq!(
            redact_token(&url),
            "https://draft-16.cloudflare.mediaoverquic.com/%3Ctoken%3E"
        );
    }
}
