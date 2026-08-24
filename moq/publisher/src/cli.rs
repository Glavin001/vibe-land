use clap::Parser;
use std::net;
use url::Url;

/// Publishes simulated vibe-land world state to a MoQ relay, one track per
/// region plus a low-frequency `meta` track.
#[derive(Parser, Clone)]
#[command(version, about)]
pub struct Cli {
    /// Relay URL to publish to.
    ///
    /// For Cloudflare this is the draft-16 endpoint with a publish-capable
    /// token in the path, e.g.
    /// `https://draft-16.cloudflare.mediaoverquic.com/<publish-token>`.
    #[arg(env = "MOQ_RELAY_URL")]
    pub url: Url,

    /// Track namespace. Slashes become tuple fields on the wire, so
    /// `vibe-land/demo` is the two-field namespace ["vibe-land", "demo"].
    #[arg(long, env = "MOQ_NAMESPACE", default_value = "vibe-land/demo")]
    pub namespace: String,

    /// Local UDP address to send from.
    #[arg(long, default_value = "[::]:0")]
    pub bind: net::SocketAddr,

    /// TLS options (`--tls-root`, `--tls-disable-verify`, ...). Only needed
    /// against a local relay with a self-signed certificate.
    #[command(flatten)]
    pub tls: moq_native_ietf::tls::Args,

    /// Publish rate in Hz for each region track, lowest region first.
    ///
    /// The default deliberately fans out — region 0 is the "near" region a
    /// player is standing in, region 3 is scenery on the horizon.
    #[arg(
        long,
        env = "MOQ_REGION_HZ",
        value_delimiter = ',',
        default_value = "10,5,2,1"
    )]
    pub region_hz: Vec<f64>,

    /// Publish rate in Hz for the `meta` track.
    #[arg(long, env = "MOQ_META_HZ", default_value_t = 0.5)]
    pub meta_hz: f64,

    /// Seconds of objects per group. Each group opens with a full snapshot, so
    /// this is also the worst-case wait before a new subscriber can render.
    #[arg(long, env = "MOQ_GROUP_SECONDS", default_value_t = 2.0)]
    pub group_seconds: f64,

    /// Simulation rate in Hz.
    #[arg(long, default_value_t = 60)]
    pub tick_hz: u32,

    /// Seed for the destruction sim. Omit for a time-based seed.
    #[arg(long)]
    pub seed: Option<u64>,

    /// Seconds between throughput summaries on stderr. 0 disables them.
    #[arg(long, default_value_t = 5.0)]
    pub stats_seconds: f64,

    /// Synthetic benchmark tracks. Zero runs the destruction simulation.
    #[arg(long, default_value_t = 0)]
    pub benchmark_tracks: usize,

    /// Object rate per synthetic benchmark track.
    #[arg(long, default_value_t = 20.0)]
    pub benchmark_hz: f64,

    /// Bytes in each synthetic benchmark object, including its 32-byte header.
    #[arg(long, default_value_t = 4096)]
    pub benchmark_payload_bytes: usize,

    /// Send synthetic benchmark objects as unreliable MoQ datagrams.
    #[arg(long, default_value_t = false)]
    pub benchmark_datagrams: bool,
}
