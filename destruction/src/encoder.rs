//! The per-tick chunk-stream encoder: classify → schedule → encode-once →
//! per-client interest filter → packetize.
//!
//! Orchestrates the ported codec core for the live server. Encode-once
//! discipline: body records are encoded against globally scheduled baselines
//! (never per-client acked state), so record bytes are identical across
//! clients and the stream stays MoQ-publishable later; only packet
//! composition differs per client.

use std::collections::HashMap;

use glam::Vec3;

use vibe_netcode::destruction_backend::DestructionTickOutput;

use crate::classify::{Classifier, ClassifierConfig, PhysicalClass, FRESH_FALL_TICKS};
use crate::ids;
use crate::interest::{InterestConfig, InterestTrack, InterestView, InterestViewTrack};
use crate::manifest::DestructionManifest;
use crate::quant::projected_error_pixels;
use crate::scheduler::{
    compute_priority, select_with_ceiling, BudgetCandidate, PriorityConfig, PriorityInput,
};
use crate::send_audit::{BodyPhase, SendAudit, SendOutcome};
use crate::topology::CityLedger;
use crate::types::{BodyState, Camera, Pose, FLAG_CONTACT_BEGIN, FLAG_JOINT_BREAK, FLAG_WAKE_EVENT};
use crate::wire::{
    delta_fits, encode_baseline, encode_bootstrap, encode_chunks_datagrams, encode_topology,
    BaselineMessage, BaselineRecord, BodyRecord, RecordMode, TopologyMessage,
    RECORD_FLAG_SETTLED_HINT,
};

/// Kinematic input for one awake island body, produced by the physics half.
#[derive(Clone, Copy, Debug)]
pub struct BodySnapshotInput {
    pub body_entity: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub contacts: u16,
    /// `types::FLAG_*` event bits (contact begin, joint break, wake).
    pub flags: u8,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct EncoderConfig {
    pub sim_hz: u32,
    /// Chunk stream rate divider: encode/send every N sim ticks.
    pub send_interval_ticks: u32,
    /// Global baseline cadence in sim ticks.
    pub baseline_interval_ticks: u32,
    /// Per-client byte ceiling per send (a cap, never a fill target).
    pub client_ceiling_bytes: usize,
    /// Screen-space error budget (pixels) that normalizes error ratios.
    pub error_budget_px: f32,
    pub classifier: ClassifierConfig,
    pub priority: PriorityConfig,
    pub interest: InterestConfig,
    /// Which byte layout the reliable channel uses. The decoded message shapes
    /// are identical across versions; only the encoding differs.
    pub wire_version: u8,
    /// Sends of unspent ceiling a client may bank, to spend during a burst.
    ///
    /// A collapse is bursty and the ceiling is per-send, so the budget is
    /// saturated for the one second that matters and two thirds idle across
    /// the rest of the run. Measured on the wedge scenario: 61,244 records
    /// dropped by the ceiling while averaging 0.93 Mbps against a 2.5 Mbps
    /// allowance. Banking lets the idle stretches pay for the burst.
    ///
    /// 0 disables it and restores the plain per-send ceiling exactly.
    pub burst_capacity_sends: u32,
    /// Hard cap on one send, as a multiple of the steady ceiling.
    ///
    /// Without it a full bank could empty into a single tick -- a third of a
    /// megabyte in one frame, arriving exactly when the client is busiest
    /// drawing the collapse, and on a link that is least able to take it.
    pub burst_max_multiple: u32,
    /// Judge each body against where the client actually DRAWS it, not
    /// against the pose it was last sent.
    ///
    /// The client does not hold a record's pose: it extrapolates the record's
    /// velocity (and gravity, for a ballistic record) for up to
    /// [`CLIENT_MAX_EXTRAPOLATION_TICKS`] and then holds that extrapolated
    /// pose (`client/src/city/presentation.ts`). A body that decelerates into
    /// rest after its last record is therefore drawn metres-per-second x
    /// 133 ms past where it stopped, and the encoder -- comparing truth with
    /// the last-sent pose, which is within the rest epsilon -- concluded the
    /// client was already right and never corrected it. Measured in Netlab v2
    /// (rec1, loopback): resting debris drawn 0.198 m from truth at p50 on
    /// every link, 17% of its on-screen area perceptibly wrong.
    ///
    /// With this on, the rest-unchanged skip and the projected error use the
    /// client's extrapolated pose, and a body at rest whose drawn pose is off
    /// gets one correcting record even while quiescent.
    ///
    /// Absent from captures made before it existed, where it reads as off:
    /// that is what those encoders did, so their replays stay byte-exact.
    #[serde(default)]
    pub model_client_extrapolation: bool,
    /// Send the BALLISTIC record mode only for a body whose measured
    /// acceleration is gravity's, i.e. one that is actually in free fall.
    ///
    /// The classifier calls a body ballistic when it reports no contacts, and
    /// the native backend reports none, so every moving body -- rubble
    /// sliding, rolling or lying on the ground -- was classed ballistic.
    /// Measured on the city-bench quick capture: 78,403 of 80,028 records.
    /// That costs twice: a ballistic record carries an absolute pose (6 B more
    /// than a baseline delta), and the client extrapolates it under gravity,
    /// so a body at rest on the ground is drawn sinking for the whole
    /// extrapolation window and then held there.
    ///
    /// Absent from older captures, where it reads as off (what they did).
    #[serde(default)]
    pub ballistic_requires_free_fall: bool,
    /// World gravity along y, m/s^2 (negative is down): what free fall is
    /// measured against. The server sets it from the physics world.
    #[serde(default = "default_world_gravity_y")]
    pub world_gravity_y: f32,
    /// Resting bodies are re-evaluated on one send in this many; see the
    /// stride in `client_datagrams`. Older captures read today's value.
    #[serde(default = "default_rest_eval_stride")]
    pub rest_eval_stride: u32,
    /// Keep encoding deltas against the PREVIOUS baseline generation for this
    /// many ticks after emitting a new one.
    ///
    /// Baselines travel on the reliable stream and delta records on
    /// datagrams, which a congested sender sends first; the client drops a
    /// delta whose generation it has not received. Switching generations the
    /// tick a baseline is emitted therefore throws away every delta sent
    /// until the baseline arrives -- measured on the 0.5 Mbit/s link, where
    /// that turned sliding debris into seconds-stale poses once deltas became
    /// the common record. The client keeps the two newest generations
    /// (`client/src/city/cityClient.ts`), so any lag below the baseline
    /// interval is safe. Bodies awake only since the new baseline go
    /// absolute meanwhile.
    ///
    /// 0 -- what captures made before it existed did -- switches at once.
    #[serde(default)]
    pub baseline_reference_lag_ticks: u32,
    /// Leave quiescent bodies out of baselines.
    ///
    /// A baseline exists so that records can be deltas; a quiescent body
    /// gets a record only when it wakes or needs a rest correction, so its
    /// ~17 B baseline entry, repeated every baseline, buys nothing -- and a
    /// demolished city is mostly quiescent rubble that has not crossed the
    /// sleep threshold. Its rare records go absolute (6 B more, once).
    /// The encoder only ever deltas against poses it put in a baseline, so
    /// the client never gets a delta it cannot resolve.
    ///
    /// Absent from older captures, where it reads as off (what they did).
    #[serde(default)]
    pub baseline_skips_quiescent: bool,
    /// Copy each reliable topology message onto the datagram lane, at this
    /// many consecutive sends (wire v2; 0 = none).
    ///
    /// Topology says which body every chunk is on, and it rides the ordered
    /// reliable stream while the poses ride datagrams. The reliable stream
    /// is head-of-line blocked on loss (Netlab, LTE 3%: topology p99 340 ms
    /// against 124 ms for datagrams), and on a constrained link the sender
    /// serves datagrams first, so it waits behind them (1 Mbit/s, no loss:
    /// topology p99 799 ms). A fracture's chunks stay drawn on the body they
    /// left until it lands. The copies travel with the poses; the reliable
    /// message still goes, and the client applies whichever arrives first,
    /// in `topo_seq` order (`client/src/city/cityClient.ts`). Carried in
    /// chunk datagrams with no records, as a trailer
    /// ([`crate::wire::CHUNKS_TRAILER_TOPOLOGY_PART`]) older clients ignore,
    /// ahead of the send's records (`add_topology_copies`).
    ///
    /// Absent from older captures, where it reads as 0 (what they did).
    #[serde(default)]
    pub topology_datagram_copies: u32,
    /// The span, in sim ticks, a body's velocity innovation is judged over
    /// (0 = one send interval, what captures made before it did).
    ///
    /// The scheduler sends a body whose velocity changed by 0.25 m/s (plus
    /// 0.35 x its angular change) since the previous send
    /// (`scheduler::compute_priority`). Measured per send, that threshold is
    /// an acceleration that depends on the cadence: 7.5 m/s^2 at 30 Hz, so a
    /// body falling or sliding under gravity is refreshed at every send, but
    /// 15 m/s^2 at 60 Hz, where the same body waits for its error or age
    /// gate. Measured in Netlab v2 (systematic c1, loopback, 60 Hz sends with
    /// the per-send test): 18% fewer records, debris pos@render p99 0.088 ->
    /// 0.110 m, presented jumps over 4 m 198 -> 322. With a window the change
    /// is scaled to it, so the test is the same acceleration at any cadence;
    /// at the window's own cadence the scale is exactly 1.
    #[serde(default)]
    pub innovation_window_ticks: u32,
    /// Model a client that draws debris AHEAD of its playout delay, at the
    /// server's present as it estimates it: error-bounded dead reckoning
    /// (`client/src/city/cityClient.ts` PREDICTIVE_PRESENTATION). OFF.
    ///
    /// With it on the encoder
    /// 1. tells each client its horizon in a chunk-datagram trailer
    ///    ([`crate::wire::CHUNKS_TRAILER_HORIZON`]): the one-way latency, half
    ///    the link's smoothed RTT (`note_link_rtt`), times
    ///    `predictive_latency_share`, less the back-off
    ///    (`predictive_backoff_ticks`, `predictive_backoff_sends`);
    /// 2. models that client's drawn pose with its longer extrapolation
    ///    clamp (the lead is added to it); and
    /// 3. with `predictive_horizon_error`, also judges each body at the
    ///    horizon: a record goes when the pose the last record predicts
    ///    there is off the pose the body's current state predicts there by
    ///    more than the error budget.
    ///
    /// Measured in Netlab v2 (docs/netcode-tuning.md, "Predictive debris"):
    /// debris pos@now p99 about halves on every link, but on LTE 1.6-3.7x
    /// the corrections over 1 m are shown and bytes rise 6-10%. The client's
    /// default (`data`) horizon needs none of this.
    ///
    /// Absent from older captures, where it reads as off.
    #[serde(default)]
    pub predictive_client: bool,
    /// How far behind the server's present the predictive client draws:
    /// this many ticks plus `predictive_backoff_sends` of the send's
    /// interval (1 at 60 Hz, 2 on a link paced to 30 Hz). Both 0 is the
    /// present; one send is "now minus one interval".
    #[serde(default)]
    pub predictive_backoff_ticks: f32,
    #[serde(default)]
    pub predictive_backoff_sends: f32,
    /// The share of the one-way latency the horizon covers: 1 is the
    /// server's present, 0 the newest data the client can have (the
    /// back-off then counts from there). Older captures and the default:
    /// 1 (`default_one`).
    #[serde(default = "default_one")]
    pub predictive_latency_share: f32,
    /// The share of the lead the predictive client gives a body whose newest
    /// record is not ballistic (its PREDICTIVE_CONTACT_SHARE).
    #[serde(default)]
    pub predictive_contact_share: f32,
    /// See `predictive_client` (3).
    #[serde(default)]
    pub predictive_horizon_error: bool,
    /// The predictive client's overshoot bound, metres (its
    /// PREDICTIVE_MAX_OVERSHOOT_M; 0 = none).
    #[serde(default)]
    pub predictive_max_overshoot_m: f32,
    /// For a record sent ballistic, leave out of the velocity-innovation test
    /// the change gravity alone made since the previous send: a body in free
    /// fall is then refreshed by its error, not at every innovation window.
    /// OFF (older captures read it as off).
    #[serde(default)]
    pub ballistic_innovation_net_of_gravity: bool,
}

fn default_rest_eval_stride() -> u32 {
    REST_EVAL_STRIDE
}

fn default_one() -> f32 {
    1.0
}

fn default_world_gravity_y() -> f32 {
    -9.81
}

/// A body is in free fall when its tick-to-tick acceleration is within this
/// of gravity (m/s^2) -- the tolerance Netlab's truth model uses.
const FREE_FALL_ACCEL_TOLERANCE: f32 = 3.0;
/// ... for this many consecutive ticks, so one quiet tick on the ground does
/// not flip a resting body into a falling one.
const FREE_FALL_MIN_TICKS: u16 = 2;

/// What the client does once a body's newest record is behind its render
/// time (`client/src/city/presentation.ts`: `presentationConfig60Hz`
/// `maxExtrapolationTicks` and `gravity`, `PresentationTrack.extrapolate`):
/// it extrapolates the record's velocities, undamped, for at most this many
/// ticks and then holds; a ballistic record also falls under this gravity.
pub const CLIENT_MAX_EXTRAPOLATION_TICKS: u32 = 8;
pub const CLIENT_EXTRAPOLATION_GRAVITY_Y: f32 = -9.81;
/// The predictive client's constants (`client/src/city/cityClient.ts`):
/// its playout delay beyond the send interval, the render clock's lead over
/// the completed tick, and the longest lead it draws at.
pub const CLIENT_PLAYOUT_BEYOND_INTERVAL_TICKS: f32 = 4.0;
pub const CLIENT_PREDICTIVE_CLOCK_BIAS_TICKS: f32 = 1.0;
pub const CLIENT_PREDICTIVE_MAX_LEAD_TICKS: f32 = 20.0;
/// The floor the predictive client's ballistic extrapolation stops at
/// (`PresentationTrack.setLeadFloor`; cityClient PREDICTIVE_FLOOR_Y).
pub const CLIENT_PREDICTIVE_FLOOR_Y: f32 = 0.1;
/// A resting body drawn further than this from where it rests (position,
/// plus rotation error times the body's radius) gets a correcting record.
/// Twice the pose-agreement epsilon, so quantisation alone never triggers it.
const REST_CORRECTION_M: f32 = 2.0 * REST_POSE_EPSILON_M;

impl EncoderConfig {
    pub fn validated(sim_hz: u32) -> Self {
        Self {
            sim_hz,
            // 60 Hz: every tick at a 60 Hz sim. A record leaves the tick its
            // body needs it rather than up to a tick later, and the client's
            // playout delay can be a tick shorter (`cityClient.ts`). 30 Hz
            // (2 ticks) before; captures record theirs in the checkpoint.
            send_interval_ticks: (sim_hz / 60).max(1),
            // 2 s, not 1: with deltas now the common record (see
            // `ballistic_requires_free_fall`), a baseline delayed behind
            // datagrams on a congested link cost every delta sent after it
            // until it arrived. The longer interval allows the longer
            // reference lag below and halves the baseline bytes. Measured in
            // Netlab v2: see docs/netcode-tuning.md.
            baseline_interval_ticks: 2 * sim_hz,
            client_ceiling_bytes: 5_200,                  // ≈ 2.5 Mbps at 60 Hz
            error_budget_px: 2.0,
            classifier: ClassifierConfig::default(),
            priority: PriorityConfig::from_hz(sim_hz),
            interest: InterestConfig::validated(sim_hz),
            wire_version: crate::wire::CITY_WIRE_VERSION,
            // OFF, on the measurement rather than the intuition.
            //
            // Banking a second of unspent ceiling is an appealing idea -- the
            // budget is saturated during a collapse and two thirds idle
            // otherwise -- and it does not work. Across the five recorded
            // scenarios it cost 5-8% more bytes and moved fall-notification
            // p99 and max by nothing at all; in `sustained` the ceiling losses
            // among the slowest falls went UP, 362 to 380.
            //
            // The reason is that a body which loses the ranking loses it at
            // any budget: more allowance admits more of the same winners. The
            // mechanism is kept, and tested, because a different link or a
            // busier match may change that -- but it is not on by default on
            // the strength of an argument that measurement did not support.
            burst_capacity_sends: 0,
            burst_max_multiple: 4,
            model_client_extrapolation: true,
            ballistic_requires_free_fall: true,
            world_gravity_y: default_world_gravity_y(),
            rest_eval_stride: REST_EVAL_STRIDE,
            // The baseline interval less 1/6 s: a baseline delayed up to
            // 1.83 s behind the datagrams still costs no deltas.
            baseline_reference_lag_ticks: 2 * sim_hz - sim_hz / 6,
            baseline_skips_quiescent: true,
            // Two: one lost copy (3% on LTE) is covered by the next send's.
            // Kept at two with the 60 Hz stream (16 ms apart instead of 33):
            // three was measured and was mixed (docs/netcode-tuning.md).
            topology_datagram_copies: 2,
            // 1/30 s: the span the 0.25 m/s perturbation test was tuned at.
            innovation_window_ticks: (sim_hz / 30).max(1),
            // OFF: measured and left opt-in (docs/netcode-tuning.md,
            // "Predictive debris"): it halves debris pos@now but corrects
            // more in view. VIBE_CITY_PREDICTIVE turns it on.
            predictive_client: false,
            predictive_backoff_ticks: 0.0,
            predictive_backoff_sends: 0.0,
            predictive_latency_share: 1.0,
            predictive_contact_share: 0.0,
            predictive_horizon_error: true,
            predictive_max_overshoot_m: 0.0,
            ballistic_innovation_net_of_gravity: false,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct BodyTrack {
    classifier: Classifier,
    class: PhysicalClass,
    state: BodyState,
    /// Interest/error bounding radius for the island.
    radius: f32,
    last_velocity: Vec3,
    last_angular_velocity: Vec3,
    settled_hint: bool,
    /// Velocity at the last ingested tick, and that tick: the per-tick
    /// acceleration free-fall detection needs (`last_velocity` is per send).
    #[serde(default)]
    tick_velocity: Option<(u32, Vec3)>,
    /// Consecutive ticks whose acceleration matched gravity.
    #[serde(default)]
    free_fall_ticks: u16,
}

/// Everything this client knows about one body.
///
/// Merged from three parallel HashMaps (tracks / last_sent_tick /
/// last_sent_pose). The packing loop visits every shared record for every
/// client, so three maps meant three hashes of the same key per record per
/// client -- at ~6800 bodies and 2 clients, ~40k lookups per send.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct ClientBodyState {
    track: InterestTrack,
    /// None until this body has actually been sent to this client.
    last_sent: Option<(u32, Pose)>,
    /// The motion the last record carried, which the client extrapolates.
    /// None for a record without velocities (and in older checkpoints).
    #[serde(default)]
    last_motion: Option<SentMotion>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct SentMotion {
    linear: Vec3,
    angular: Vec3,
    ballistic: bool,
}

impl SentMotion {
    fn of(record: &BodyRecord) -> Option<Self> {
        record.mode.has_velocity().then(|| Self {
            linear: record.linear_velocity,
            angular: record.angular_velocity,
            ballistic: record.mode == RecordMode::Ballistic,
        })
    }
}

impl ClientBodyState {
    /// Where this client draws the body at `tick`, given what it was sent:
    /// the last record's pose, extrapolated as the client extrapolates it.
    /// None before the first record.
    fn presented_at(&self, tick: u32, sim_hz: u32) -> Option<Pose> {
        self.presented_at_ahead(tick as f32, sim_hz, None)
    }

    /// `presented_at` for a predictive client (`lead` is `Some`): at a
    /// fractional tick, with the clamp lengthened by the lead the client
    /// gives this record's class (`PresentationTrack.extrapolate`).
    fn presented_at_ahead(&self, tick: f32, sim_hz: u32, lead: Option<Lead>) -> Option<Pose> {
        let (sent_tick, pose) = self.last_sent?;
        let Some(motion) = self.last_motion else {
            return Some(pose);
        };
        let extra = lead.map_or(0.0, |lead| lead.for_motion(motion));
        let ticks = (tick - sent_tick as f32)
            .max(0.0)
            .min(CLIENT_MAX_EXTRAPOLATION_TICKS as f32 + extra);
        let mut drawn = extrapolate_like_the_client(pose, motion, ticks / sim_hz.max(1) as f32);
        if extra > 0.0 && motion.ballistic && drawn.position.y < CLIENT_PREDICTIVE_FLOOR_Y {
            drawn.position.y = pose.position.y.min(CLIENT_PREDICTIVE_FLOOR_Y);
        }
        Some(drawn)
    }
}

/// The lead a predictive client draws a body at, ticks past its
/// presentation tick: all of it for a ballistic record, a share otherwise.
#[derive(Clone, Copy, Debug)]
struct Lead {
    ballistic: f32,
    contact_share: f32,
    /// The client's playout delay and its overshoot bound (metres, 0 =
    /// none): `PresentationTrack.overshootBound`.
    playout: f32,
    max_overshoot_m: f32,
    tick_s: f32,
}

impl Lead {
    fn for_motion(self, motion: SentMotion) -> f32 {
        let lead = if motion.ballistic {
            self.ballistic
        } else {
            self.ballistic * self.contact_share
        };
        let speed = motion.linear.length();
        if self.max_overshoot_m > 0.0 && speed > 1e-6 {
            lead.min(self.playout + self.max_overshoot_m / (speed * self.tick_s))
        } else {
            lead
        }
    }
}

/// `PresentationTrack.extrapolate` with zero damping (the city tracks are
/// built undamped): position by velocity (plus gravity when ballistic),
/// rotation by the scaled angular-velocity axis applied on the left.
fn extrapolate_like_the_client(pose: Pose, motion: SentMotion, seconds: f32) -> Pose {
    let mut position = pose.position + motion.linear * seconds;
    if motion.ballistic {
        position.y += 0.5 * CLIENT_EXTRAPOLATION_GRAVITY_Y * seconds * seconds;
    }
    let turn = motion.angular * seconds;
    let angle = turn.length();
    let rotation = if angle > 1e-8 {
        (glam::Quat::from_axis_angle(turn / angle, angle) * pose.rotation).normalize()
    } else {
        pose.rotation
    };
    Pose { position, rotation }
}

/// The same record without its baseline dependency: a delta mode becomes
/// its absolute counterpart (the pose is carried whole either way).
fn without_baseline(mut record: BodyRecord) -> BodyRecord {
    record.mode = match record.mode {
        RecordMode::Delta => RecordMode::Absolute,
        RecordMode::MotionDelta => RecordMode::MotionAbsolute,
        mode => mode,
    };
    record
}

/// Rigid-body pose disagreement bounded over a body of `radius`: the
/// translation plus the arc the rotation error sweeps at the radius.
fn pose_error_m(a: Pose, b: Pose, radius: f32) -> f32 {
    let dot = a.rotation.dot(b.rotation).abs().min(1.0);
    let angle = 2.0 * dot.acos();
    a.position.distance(b.position) + angle * radius
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct ClientState {
    view: InterestViewTrack,
    /// Unspent ceiling banked for a burst, in bytes. Filled on the first send.
    burst_tokens: Option<usize>,
    /// Indexed by SharedRecord::slot. An array index instead of a hash probe
    /// per body per send; grown on demand and reset when a slot is recycled.
    slots: Vec<ClientBodyState>,
    sequence: u32,
    /// The first baseline generation this client can hold. A bootstrap
    /// clears the client's generations and names the one in flight as
    /// empty, so until the encoder references a generation emitted after
    /// the bootstrap, a delta is one the client must drop: send absolutes.
    #[serde(default)]
    deltas_from_generation: Option<u16>,
    /// Topology messages still to be copied onto this client's datagrams
    /// (`EncoderConfig::topology_datagram_copies`), oldest first.
    #[serde(default)]
    topology_copies: std::collections::VecDeque<TopologyCopy>,
    /// The link's smoothed RTT, ms (`note_link_rtt`); None until known.
    #[serde(default)]
    link_rtt_ms: Option<f32>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct TopologyCopy {
    topo_seq: u32,
    bytes: Vec<u8>,
    copies_left: u32,
    /// Whether no copy has gone yet.
    #[serde(default)]
    unsent: bool,
}

/// Bytes of topology copies one client may have queued; beyond it the oldest
/// are dropped (their reliable messages are still on the way).
const TOPOLOGY_COPY_QUEUE_BYTES: usize = 64 * 1024;
/// Largest piece of a topology message one datagram carries.
const TOPOLOGY_PART_PAYLOAD_BYTES: usize = crate::quant::MAX_DATAGRAM
    - crate::wire::CHUNKS_HEADER_BYTES
    - crate::wire::TOPOLOGY_PART_HEADER_BYTES;

/// A body slower than this, that has not moved from where a client last saw
/// it, has nothing to send that client. Well under the sleep threshold, so a
/// body creeping toward rest still streams.
const REST_SPEED_MPS: f32 = 0.05;
const REST_ANGULAR_RPS: f32 = 0.05;
/// Pose agreement required alongside those speeds, in metres.
const REST_POSE_EPSILON_M: f32 = 0.02;
/// Re-evaluate a resting body on one send in this many, staggered by slot.
const REST_EVAL_STRIDE: u32 = 8;
/// Records a single client ranks per send. Well above the ~350 the byte
/// ceiling admits, so the selection still has room to choose.
const MAX_EVAL_PER_CLIENT: usize = 1200;

/// Candidates each client may evaluate per send.
///
/// VIBE_CITY_MAX_EVAL overrides it; 0 means unlimited, which streams every
/// body that wants syncing and lets the byte ceiling be the only limit. That
/// is a diagnostic setting: it answers "what does perfect cost" without the
/// priority function in the way.
fn max_eval_per_client() -> usize {
    static VALUE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *VALUE.get_or_init(|| {
        match std::env::var("VIBE_CITY_MAX_EVAL").ok().and_then(|v| v.parse::<usize>().ok()) {
            Some(0) => usize::MAX,
            Some(limit) => limit,
            None => MAX_EVAL_PER_CLIENT,
        }
    })
}

/// Record one body's send outcome, with the error the decision defers.
///
/// The error is measured against the pose this client is actually holding,
/// which is only known once the body has been sent at least once; before that
/// there is no reference and `SendAudit` counts it as `never_sent` rather than
/// being handed a number that would be a guess.
fn note_outcome(
    audit: &mut SendAudit,
    shared: &SharedRecords,
    record: &SharedRecord,
    state: &ClientBodyState,
    outcome: SendOutcome,
) {
    let phase = BodyPhase::classify(
        record.contacts,
        record.linear_speed,
        record.angular_speed,
        record.free_ticks,
    );
    let (error, age) = match state.last_sent {
        Some((tick, pose)) => (
            Some(record.position.distance(pose.position)),
            Some(shared.sim_tick.saturating_sub(tick)),
        ),
        None => (None, None),
    };
    audit.note(
        shared.sim_tick,
        record.record.body_entity,
        phase,
        outcome,
        // Same cost model the budget used: logical bytes less the 4-byte id,
        // plus a typical 2-byte packet-local gap.
        record.record.body_bytes() - 4 + 2,
        error,
        record.radius,
        age,
    );
}

/// One shared (client-independent) candidate produced by `encode_send`.
#[derive(Clone, Debug)]
pub struct SharedRecord {
    /// Dense per-body index, stable across sends and reused after a retire.
    ///
    /// Per-client state is indexed by this rather than hashed by entity: the
    /// packing loop touches every awake body for every client, and at 4735
    /// bodies that was ~700 ns per body per client -- a hash and a random
    /// probe into a large map, i.e. a cache miss, dwarfing the frustum test it
    /// was there to serve.
    pub slot: u32,
    pub record: BodyRecord,
    pub class: PhysicalClass,
    pub contacts: u16,
    pub linear_speed: f32,
    pub angular_speed: f32,
    pub linear_innovation: f32,
    pub angular_innovation: f32,
    pub contact_begin: bool,
    pub joint_break: bool,
    pub wake: bool,
    pub radius: f32,
    pub position: Vec3,
    pub linear_velocity: Vec3,
    /// Consecutive free-flight ticks, for send-audit phase classification.
    pub free_ticks: u16,
}

#[derive(Clone, Debug, Default)]
pub struct SharedRecords {
    /// Indices into `records`, ordered by client-independent newsworthiness
    /// (events first, then motion). Clients evaluate a prefix of this rather
    /// than every record: the byte ceiling ships ~350, so ranking thousands of
    /// motionless bodies per client is work that cannot change the outcome.
    pub eval_order: Vec<usize>,
    pub sim_tick: u32,
    pub records: Vec<SharedRecord>,
    /// The baseline generation this send's delta records are relative to.
    pub baseline_id: u16,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EncoderStats {
    pub awake_bodies: usize,
    pub staged_topology_messages: usize,
    pub baseline_id: u16,
    pub topo_seq: u32,
    /// Records dropped because two bodies claimed the same entity id. Any
    /// non-zero value is a physics-side id-allocation bug.
    pub duplicate_body_records: u64,
}

/// What one `client_datagrams` call decided, body by body, as counts: the
/// gate each awake body stopped at on its way to (or short of) the wire.
///
/// Always kept -- a handful of integer increments per evaluated body -- so a
/// session capture can say, per client and per send, how much of the stream
/// was deferred by the byte ceiling versus held back by interest or policy,
/// without switching on the offline audit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ClientSelectionSummary {
    /// Awake bodies with a shared record this send.
    pub candidates: u32,
    /// Never evaluated: beyond the per-client evaluation cap.
    pub eval_cap: u32,
    /// Resting, skipped by the evaluation stride this send.
    pub rest_stride: u32,
    /// At rest where the client already has it.
    pub rest_unchanged: u32,
    /// Outside this client's interest (frustum / distance).
    pub not_relevant: u32,
    /// Judged not worth a record by the priority gate.
    pub not_newsworthy: u32,
    /// Ranked and wanted, but did not fit the byte ceiling: deferred.
    pub ceiling: u32,
    /// Records sent.
    pub sent: u32,
    /// Bytes the ceiling allowed this send, and bytes the selection used.
    pub allowance_bytes: u32,
    pub used_bytes: u32,
}

pub struct ChunkStreamEncoder {
    config: EncoderConfig,
    manifest_hash: [u8; 32],
    /// Per-structure, per-node rest centroid + radius (for island radii).
    structure_chunks: HashMap<u32, Vec<(Vec3, f32)>>,
    ledger: CityLedger,
    bodies: HashMap<u32, BodyTrack>,
    /// Dense slot per entity, with freed slots reused so the vector tracks
    /// live bodies rather than growing with cumulative destruction.
    entity_slots: HashMap<u32, u32>,
    free_slots: Vec<u32>,
    next_slot: u32,
    active_order: Vec<u32>,
    baseline_id: u16,
    baseline_poses: HashMap<u32, Pose>,
    last_baseline_tick: Option<u32>,
    /// The generation before `baseline_id`, still referenced for
    /// `baseline_reference_lag_ticks` after a new one is emitted.
    previous_baseline: Option<(u16, HashMap<u32, Pose>)>,
    topo_seq: u32,
    staged_topology: Vec<Vec<u8>>,
    clients: HashMap<u64, ClientState>,
    duplicate_body_records: u64,
    /// Off in production. The offline recorder turns it on to learn which of
    /// the send path's gates each body met, bucketed by what it was doing.
    audit: Option<SendAudit>,
    /// When set, only these clients feed the audit. A replay with a hundred
    /// clients wants the cross-tab for a representative few, not a blend of
    /// every viewpoint into one table.
    audit_clients: Option<std::collections::HashSet<u64>>,
    /// The last `client_datagrams` call's decisions; see ClientSelectionSummary.
    last_selection: ClientSelectionSummary,
}

/// The encoder's complete state, so an offline replay of a capture that
/// began mid-match can resume the encoder exactly where the live one was
/// (ledger, per-body classifiers, slots, baselines, topology sequence and
/// every client's interest and sequence state) instead of starting it fresh
/// and diverging on every byte that depends on history.
///
/// Excludes only what is derived from the manifest (per-structure chunk
/// geometry) and the offline-only send audit.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct EncoderCheckpoint {
    /// Bumped when the state layout changes.
    pub format: u32,
    pub config: EncoderConfig,
    pub manifest_hash: [u8; 32],
    ledger: CityLedger,
    bodies: HashMap<u32, BodyTrack>,
    entity_slots: HashMap<u32, u32>,
    free_slots: Vec<u32>,
    next_slot: u32,
    active_order: Vec<u32>,
    baseline_id: u16,
    baseline_poses: HashMap<u32, Pose>,
    last_baseline_tick: Option<u32>,
    #[serde(default)]
    previous_baseline: Option<(u16, HashMap<u32, Pose>)>,
    topo_seq: u32,
    staged_topology: Vec<Vec<u8>>,
    clients: HashMap<u64, ClientState>,
    duplicate_body_records: u64,
    last_selection: ClientSelectionSummary,
}

pub const ENCODER_CHECKPOINT_FORMAT: u32 = 1;

impl EncoderCheckpoint {
    /// Client ids the encoder was serving.
    pub fn clients(&self) -> Vec<u64> {
        let mut clients: Vec<u64> = self.clients.keys().copied().collect();
        clients.sort_unstable();
        clients
    }

    pub fn topo_seq(&self) -> u32 {
        self.topo_seq
    }
}

impl ChunkStreamEncoder {
    pub fn new(manifest: &DestructionManifest, config: EncoderConfig) -> Self {
        let structure_chunks = manifest
            .structures
            .iter()
            .map(|structure| {
                (
                    structure.structure_id,
                    structure
                        .chunks
                        .iter()
                        .map(|chunk| (Vec3::from_array(chunk.centroid), chunk.radius))
                        .collect(),
                )
            })
            .collect();
        Self {
            config,
            manifest_hash: manifest.hash(),
            structure_chunks,
            ledger: CityLedger::from_manifest(manifest),
            bodies: HashMap::new(),
            active_order: Vec::new(),
            baseline_id: 0,
            baseline_poses: HashMap::new(),
            last_baseline_tick: None,
            previous_baseline: None,
            topo_seq: 0,
            staged_topology: Vec::new(),
            clients: HashMap::new(),
            entity_slots: HashMap::new(),
            free_slots: Vec::new(),
            next_slot: 0,
            duplicate_body_records: 0,
            audit: None,
            audit_clients: None,
            last_selection: ClientSelectionSummary::default(),
        }
    }

    /// A copy of the complete state; see [`EncoderCheckpoint`].
    pub fn checkpoint(&self) -> EncoderCheckpoint {
        EncoderCheckpoint {
            format: ENCODER_CHECKPOINT_FORMAT,
            config: self.config,
            manifest_hash: self.manifest_hash,
            ledger: self.ledger.clone(),
            bodies: self.bodies.clone(),
            entity_slots: self.entity_slots.clone(),
            free_slots: self.free_slots.clone(),
            next_slot: self.next_slot,
            active_order: self.active_order.clone(),
            baseline_id: self.baseline_id,
            baseline_poses: self.baseline_poses.clone(),
            last_baseline_tick: self.last_baseline_tick,
            previous_baseline: self.previous_baseline.clone(),
            topo_seq: self.topo_seq,
            staged_topology: self.staged_topology.clone(),
            clients: self.clients.clone(),
            duplicate_body_records: self.duplicate_body_records,
            last_selection: self.last_selection,
        }
    }

    /// The encoder a checkpoint describes, for the manifest it was taken on.
    pub fn from_checkpoint(
        manifest: &DestructionManifest,
        checkpoint: EncoderCheckpoint,
    ) -> Result<Self, String> {
        if checkpoint.format != ENCODER_CHECKPOINT_FORMAT {
            return Err(format!(
                "encoder checkpoint format {} (this build reads {})",
                checkpoint.format, ENCODER_CHECKPOINT_FORMAT
            ));
        }
        if checkpoint.manifest_hash != manifest.hash() {
            return Err("encoder checkpoint was taken against a different manifest".into());
        }
        let mut encoder = Self::new(manifest, checkpoint.config);
        encoder.ledger = checkpoint.ledger;
        encoder.bodies = checkpoint.bodies;
        encoder.entity_slots = checkpoint.entity_slots;
        encoder.free_slots = checkpoint.free_slots;
        encoder.next_slot = checkpoint.next_slot;
        encoder.active_order = checkpoint.active_order;
        encoder.baseline_id = checkpoint.baseline_id;
        encoder.baseline_poses = checkpoint.baseline_poses;
        encoder.last_baseline_tick = checkpoint.last_baseline_tick;
        encoder.previous_baseline = checkpoint.previous_baseline;
        encoder.topo_seq = checkpoint.topo_seq;
        encoder.staged_topology = checkpoint.staged_topology;
        encoder.clients = checkpoint.clients;
        encoder.duplicate_body_records = checkpoint.duplicate_body_records;
        encoder.last_selection = checkpoint.last_selection;
        Ok(encoder)
    }

    /// The effective configuration (what `CityRuntime` built, env included).
    pub fn config(&self) -> EncoderConfig {
        self.config
    }

    /// What the most recent `client_datagrams` call decided for its client.
    pub fn last_client_selection(&self) -> ClientSelectionSummary {
        self.last_selection
    }

    /// Begin recording send decisions. Measurement only; never on in a match.
    pub fn enable_send_audit(&mut self) {
        self.audit = Some(SendAudit::new());
    }

    pub fn send_audit(&self) -> Option<&SendAudit> {
        self.audit.as_ref()
    }

    /// Restrict the audit to `clients` (measurement only).
    pub fn set_audit_clients(&mut self, clients: impl IntoIterator<Item = u64>) {
        self.audit_clients = Some(clients.into_iter().collect());
    }

    pub fn ledger(&self) -> &CityLedger {
        &self.ledger
    }

    pub fn stats(&self) -> EncoderStats {
        EncoderStats {
            awake_bodies: self.active_order.len(),
            staged_topology_messages: self.staged_topology.len(),
            baseline_id: self.baseline_id,
            topo_seq: self.topo_seq,
            duplicate_body_records: self.duplicate_body_records,
        }
    }

    /// Connected client ids. Needed to carry the client set across a city
    /// rebuild, which otherwise silently drops everyone's stream.
    pub fn clients(&self) -> Vec<u64> {
        self.clients.keys().copied().collect()
    }

    pub fn set_wire_version(&mut self, version: u8) {
        debug_assert!(crate::wire::is_supported_city_wire_version(version));
        self.config.wire_version = version;
    }

    pub fn wire_version(&self) -> u8 {
        self.config.wire_version
    }

    pub fn add_client(&mut self, client: u64) {
        self.clients.entry(client).or_default();
        // A join is always followed by a bootstrap.
        self.note_client_bootstrap(client);
    }

    /// `client` was just sent a bootstrap (join, resync, repair): it holds
    /// no baseline poses until the next generation, so it gets absolute
    /// records until the encoder references that one.
    ///
    /// With the reference lag off -- captures made before it -- this changes
    /// nothing: deltas then switch to a generation the tick it is emitted,
    /// and the stream is exactly what those encoders sent.
    pub fn note_client_bootstrap(&mut self, client: u64) {
        if self.config.baseline_reference_lag_ticks == 0 {
            return;
        }
        let first = self.baseline_id.wrapping_add(1);
        if let Some(state) = self.clients.get_mut(&client) {
            state.deltas_from_generation = Some(first);
        }
    }

    pub fn remove_client(&mut self, client: u64) {
        self.clients.remove(&client);
    }

    /// Island bounding radius: chunks keep their rest poses relative to each
    /// other inside a rigid island, so the spread of member rest centroids
    /// (plus per-chunk radius) bounds the island around the body origin.
    fn island_radius(&self, structure_id: u32, nodes: &[u32]) -> f32 {
        let Some(chunks) = self.structure_chunks.get(&structure_id) else {
            return 1.0;
        };
        crate::manifest::island_radius(chunks, nodes)
    }

    /// 60 Hz ingest: apply topology output to the ledger, stage the reliable
    /// message, update classifiers from the active-body snapshots.
    /// Wire v2: ledger/topology plus the per-body classifier the v2 pose
    /// stream ranks with.
    pub fn ingest_tick(
        &mut self,
        sim_tick: u32,
        active: &[BodySnapshotInput],
        output: &DestructionTickOutput,
        wakes: &[(u32, u32)],
    ) {
        self.ingest_topology(sim_tick, output, wakes);
        self.ingest_active(sim_tick, active, true);
    }

    /// Wire v3: the same ledger/topology work -- v3's reliable topology
    /// messages come from this encoder -- without the classifier pass.
    ///
    /// On a v3 match nothing reads the classes: `encode_send`/`client_datagrams`
    /// are skipped and baselines are not emitted (v3 records are
    /// self-contained). Running the pass anyway cost two hash probes and a
    /// classifier update per awake body per tick for output nobody consumed.
    /// The order list itself is still built, so `awake_bodies` and the
    /// duplicate-entity tripwire keep working.
    pub fn ingest_tick_topology_only(
        &mut self,
        sim_tick: u32,
        active: &[BodySnapshotInput],
        output: &DestructionTickOutput,
        wakes: &[(u32, u32)],
    ) {
        self.ingest_topology(sim_tick, output, wakes);
        self.ingest_active(sim_tick, active, false);
    }

    fn ingest_topology(
        &mut self,
        sim_tick: u32,
        output: &DestructionTickOutput,
        wakes: &[(u32, u32)],
    ) {
        // Ledger + staged topology.
        if !output.batches.is_empty() || !output.settled.is_empty() || !wakes.is_empty() {
            for batch in &output.batches {
                self.ledger.apply_batch(batch);
                for promotion in &batch.promoted_islands {
                    let entity =
                        ids::body_entity(batch.structure_id, u32::from(promotion.island_id));
                    let nodes: Vec<u32> = promotion
                        .chunks
                        .iter()
                        .map(|&chunk| ids::chunk_id_parts(chunk).1)
                        .collect();
                    let radius = self.island_radius(batch.structure_id, &nodes);
                    self.bodies.insert(
                        entity,
                        BodyTrack {
                            classifier: Classifier::default(),
                            class: PhysicalClass::ImpactBurst,
                            state: BodyState::default(),
                            radius,
                            last_velocity: Vec3::from_array(promotion.linear_velocity),
                            last_angular_velocity: Vec3::from_array(promotion.angular_velocity),
                            settled_hint: false,
                            tick_velocity: None,
                            free_fall_ticks: 0,
                        },
                    );
                }
                for &retired in &batch.retired_island_ids {
                    let entity = ids::body_entity(batch.structure_id, retired);
                    self.bodies.remove(&entity);
                    if let Some(slot) = self.entity_slots.remove(&entity) {
                        self.free_slots.push(slot);
                        for client in self.clients.values_mut() {
                            if let Some(state) = client.slots.get_mut(slot as usize) {
                                *state = ClientBodyState::default();
                            }
                        }
                    }
                    for client in self.clients.values_mut() {
                    }
                    self.baseline_poses.remove(&entity);
                    if let Some((_, poses)) = self.previous_baseline.as_mut() {
                        poses.remove(&entity);
                    }
                }
            }
            for settle in &output.settled {
                self.ledger.apply_settle(settle);
                let entity = ids::body_entity(settle.structure_id, u32::from(settle.island_id));
                if let Some(track) = self.bodies.get_mut(&entity) {
                    track.settled_hint = true;
                }
            }
            for &(structure_id, serial) in wakes {
                self.ledger.apply_wake(structure_id, serial);
                if let Some(track) = self.bodies.get_mut(&ids::body_entity(structure_id, serial))
                {
                    track.settled_hint = false;
                }
            }
            self.topo_seq += 1;
            let message = TopologyMessage {
                topo_seq: self.topo_seq,
                sim_tick,
                batches: output.batches.clone(),
                settled: output.settled.clone(),
                wakes: wakes.to_vec(),
            };
            let bytes = encode_topology(&message);
            self.queue_topology_copies(self.topo_seq, &bytes);
            self.staged_topology.push(bytes);
        }
    }

    /// Queue a staged topology message for every client's datagram copies.
    fn queue_topology_copies(&mut self, topo_seq: u32, bytes: &[u8]) {
        let copies = self.config.topology_datagram_copies;
        if copies == 0 || self.config.wire_version == crate::wire::CITY_WIRE_V3 {
            return;
        }
        let parts = bytes.len().div_ceil(TOPOLOGY_PART_PAYLOAD_BYTES);
        if parts == 0 || parts > u8::MAX as usize {
            return;
        }
        for state in self.clients.values_mut() {
            state.topology_copies.push_back(TopologyCopy {
                topo_seq,
                bytes: bytes.to_vec(),
                copies_left: copies,
                unsent: true,
            });
            let mut queued: usize = state.topology_copies.iter().map(|c| c.bytes.len()).sum();
            while queued > TOPOLOGY_COPY_QUEUE_BYTES {
                let dropped = state.topology_copies.pop_front().expect("non-empty");
                queued -= dropped.bytes.len();
            }
        }
    }

    /// Whether `client` has topology copies waiting for its next send.
    pub fn has_topology_copies(&self, client: u64) -> bool {
        self.clients.get(&client).is_some_and(|state| !state.topology_copies.is_empty())
    }

    /// Put this send's topology copies for `client` AHEAD of its datagrams,
    /// in datagrams of their own (a chunk-datagram header with no records,
    /// then the parts). Each queued message goes once per send until it has
    /// gone `topology_datagram_copies` times; one larger than a datagram is
    /// split into parts. Returns the bytes added.
    ///
    /// First, not last: on a slow link one send's datagrams arrive tens of ms
    /// apart (1150 B is 18 ms at 0.5 Mbit/s), and the client's presentation
    /// may reach the newest datagram's tick as soon as the first of them
    /// lands; the promotion has to be there by then (Netlab trace,
    /// bw-capped-nq: a promotion appended after its send's records landed
    /// 18 ms after the first of them, with the presentation already at its
    /// tick).
    ///
    /// Called at every send of a v2 stream, including sends with no records
    /// and sends the rate controller skips: topology is small and it is what
    /// the poses mean. Does nothing when copies are off.
    pub fn add_topology_copies(
        &mut self,
        client: u64,
        sim_tick: u32,
        datagrams: &mut Vec<Vec<u8>>,
    ) -> usize {
        use crate::quant::MAX_DATAGRAM;
        let baseline_id = self.baseline_id;
        let Some(state) = self.clients.get_mut(&client) else {
            return 0;
        };
        if state.topology_copies.is_empty() {
            return 0;
        }
        let mut added = 0usize;
        let mut copies: Vec<Vec<u8>> = Vec::new();
        // Not newer than anything this client was sent before: a datagram
        // with no records must not move the client's pose clock (older
        // clients anchor it on every datagram's tick), or the presentation
        // could reach this send's tick before its topology and records land.
        let header_tick = sim_tick.saturating_sub(self.config.send_interval_ticks.max(1));
        // First copies first, in seq order, then the repeats: the client
        // applies in seq order, so a repeat of a large message must not
        // queue ahead of the first copy of the next one.
        let unsent: Vec<bool> = state.topology_copies.iter().map(|copy| copy.unsent).collect();
        for first in [true, false] {
            for (copy, &was_unsent) in state.topology_copies.iter_mut().zip(&unsent) {
                if was_unsent != first {
                    continue;
                }
                let parts = copy.bytes.len().div_ceil(TOPOLOGY_PART_PAYLOAD_BYTES);
                let size = copy.bytes.len().div_ceil(parts);
                for (index, piece) in copy.bytes.chunks(size).enumerate() {
                    let need = crate::wire::TOPOLOGY_PART_HEADER_BYTES + piece.len();
                    if !copies.last().is_some_and(|last| last.len() + need <= MAX_DATAGRAM) {
                        copies.push(crate::wire::chunks_header(state.sequence, baseline_id, header_tick, 0));
                        state.sequence += 1;
                        added += crate::wire::CHUNKS_HEADER_BYTES;
                    }
                    let last = copies.last_mut().expect("pushed above");
                    crate::wire::write_topology_part(last, copy.topo_seq, index as u8, parts as u8, piece);
                    added += need;
                }
                copy.copies_left = copy.copies_left.saturating_sub(1);
                copy.unsent = false;
            }
        }
        state.topology_copies.retain(|copy| copy.copies_left > 0);
        datagrams.splice(0..0, copies);
        added
    }

    /// Build this tick's awake-body order, and (when `classify`) the per-body
    /// tracks the v2 stream ranks with.
    fn ingest_active(&mut self, sim_tick: u32, active: &[BodySnapshotInput], classify: bool) {
        // Classifier updates from the delta/active-only export.
        self.active_order.clear();
        for snapshot in active {
            let entity = snapshot.body_entity;
            if !classify {
                self.active_order.push(entity);
                continue;
            }
            let state = BodyState {
                pose: Pose {
                    position: Vec3::from_array(snapshot.position),
                    rotation: glam::Quat::from_array(snapshot.rotation),
                },
                linear_velocity: Vec3::from_array(snapshot.linear_velocity),
                angular_velocity: Vec3::from_array(snapshot.angular_velocity),
                contacts: snapshot.contacts,
                intact_joints: 0,
                flags: snapshot.flags,
            };
            let config = self.config.classifier;
            if !self.entity_slots.contains_key(&entity) {
                let slot = self.free_slots.pop().unwrap_or_else(|| {
                    let slot = self.next_slot;
                    self.next_slot += 1;
                    slot
                });
                self.entity_slots.insert(entity, slot);
            }
            let track = self.bodies.entry(entity).or_insert_with(|| BodyTrack {
                classifier: Classifier::default(),
                class: PhysicalClass::ContactActive,
                state,
                radius: 1.0,
                last_velocity: Vec3::ZERO,
                last_angular_velocity: Vec3::ZERO,
                settled_hint: false,
                tick_velocity: None,
                free_fall_ticks: 0,
            });
            track.class = track.classifier.update(state, config);
            // Free fall is measured, not inferred from missing contacts:
            // gravity's acceleration, tick over tick.
            let free = match track.tick_velocity {
                Some((previous_tick, previous)) if sim_tick > previous_tick => {
                    let seconds = (sim_tick - previous_tick) as f32 / self.config.sim_hz.max(1) as f32;
                    let acceleration = (state.linear_velocity - previous) / seconds;
                    (acceleration - Vec3::new(0.0, self.config.world_gravity_y, 0.0)).length()
                        < FREE_FALL_ACCEL_TOLERANCE
                }
                _ => false,
            };
            track.free_fall_ticks = if free { track.free_fall_ticks.saturating_add(1) } else { 0 };
            track.tick_velocity = Some((sim_tick, state.linear_velocity));
            track.state = state;
            self.active_order.push(entity);


        }
        // Snapshots come back sorted by body id from the bridge, and entity
        // packing is monotonic within a structure, so the list is already
        // ordered on the overwhelming majority of ticks. Checking is O(n)
        // against an O(n log n) sort over several thousand entries.
        if !self.active_order.is_sorted() {
            self.active_order.sort_unstable();
        }
        // `active_order` drives both the awake-body count and the baseline
        // record list, and the baseline wire format needs strictly increasing
        // ids just like the datagram one. One snapshot batch carrying the same
        // entity twice (a physics-side id-aliasing bug) would otherwise inflate
        // the count and make the baseline unencodable, killing the match loop.
        let before = self.active_order.len();
        self.active_order.dedup();
        if self.active_order.len() != before {
            self.duplicate_body_records += (before - self.active_order.len()) as u64;
        }
    }

    /// Encode-once per send: build the shared candidate set (record contents are
    /// byte-identical for every client).
    pub fn encode_send(&mut self, sim_tick: u32) -> SharedRecords {
        let mut records = Vec::with_capacity(self.active_order.len());
        // The generation deltas are relative to: the newest, or during the
        // lag after an emission the one before it (none, if there was none:
        // everything goes absolute). See `baseline_reference_lag_ticks`.
        // Never as long as the interval: the client keeps two generations, so
        // the previous one is gone once the next is emitted.
        let lag = self
            .config
            .baseline_reference_lag_ticks
            .min(self.config.baseline_interval_ticks.saturating_sub(1));
        let lagging = lag > 0
            && self.last_baseline_tick.is_some_and(|emitted| sim_tick < emitted.saturating_add(lag));
        let empty = HashMap::new();
        let (reference_id, reference) = if lagging {
            match &self.previous_baseline {
                Some((id, poses)) => (*id, poses),
                None => (self.baseline_id, &empty),
            }
        } else {
            (self.baseline_id, &self.baseline_poses)
        };
        // Velocity innovation per `innovation_window_ticks`, not per send;
        // exactly 1 at the window's cadence and when there is no window.
        let innovation_scale = match self.config.innovation_window_ticks {
            0 => 1.0,
            window => window as f32 / self.config.send_interval_ticks.max(1) as f32,
        };
        for &entity in &self.active_order {
            let Some(track) = self.bodies.get_mut(&entity) else {
                continue;
            };
            let state = track.state;
            let class = track.class;
            // Ballistic only in measured free fall when configured: see
            // `EncoderConfig::ballistic_requires_free_fall`.
            let ballistic = class == PhysicalClass::Ballistic
                && (!self.config.ballistic_requires_free_fall
                    || track.free_fall_ticks >= FREE_FALL_MIN_TICKS);
            // What gravity alone added since the previous send, for a record
            // the client will extrapolate under it (see
            // `EncoderConfig::ballistic_innovation_net_of_gravity`).
            let gravity_change = if ballistic && self.config.ballistic_innovation_net_of_gravity {
                Vec3::new(
                    0.0,
                    CLIENT_EXTRAPOLATION_GRAVITY_Y * self.config.send_interval_ticks.max(1) as f32
                        / self.config.sim_hz.max(1) as f32,
                    0.0,
                )
            } else {
                Vec3::ZERO
            };
            let linear_innovation = (state.linear_velocity - track.last_velocity - gravity_change)
                .length()
                * innovation_scale;
            let angular_innovation =
                (state.angular_velocity - track.last_angular_velocity).length() * innovation_scale;
            track.last_velocity = state.linear_velocity;
            track.last_angular_velocity = state.angular_velocity;

            let moving = state.linear_velocity.length() > 0.01
                || state.angular_velocity.length() > 0.01;
            let baseline = reference.get(&entity);
            let mode = if ballistic {
                RecordMode::Ballistic
            } else {
                match baseline {
                    Some(pose) if delta_fits(state.pose.position, pose.position) => {
                        if moving {
                            RecordMode::MotionDelta
                        } else {
                            RecordMode::Delta
                        }
                    }
                    _ => {
                        if moving {
                            RecordMode::MotionAbsolute
                        } else {
                            RecordMode::Absolute
                        }
                    }
                }
            };
            let flags = if track.settled_hint {
                RECORD_FLAG_SETTLED_HINT
            } else {
                0
            };
            records.push(SharedRecord {
                slot: self.entity_slots.get(&entity).copied().unwrap_or(u32::MAX),
                record: BodyRecord {
                    body_entity: entity,
                    mode,
                    flags,
                    pose: state.pose,
                    baseline_position: baseline.map_or(Vec3::ZERO, |pose| pose.position),
                    linear_velocity: state.linear_velocity,
                    angular_velocity: state.angular_velocity,
                },
                class,
                contacts: state.contacts,
                linear_speed: state.linear_velocity.length(),
                angular_speed: state.angular_velocity.length(),
                linear_innovation,
                angular_innovation,
                free_ticks: track.classifier.free_ticks(),
                contact_begin: state.flags & FLAG_CONTACT_BEGIN != 0,
                joint_break: state.flags & FLAG_JOINT_BREAK != 0,
                wake: state.flags & FLAG_WAKE_EVENT != 0,
                radius: track.radius,
                position: state.pose.position,
                linear_velocity: state.linear_velocity,
            });
        }
        // Rank once, client-independently. Events and fast motion first: those
        // are what any client would prioritise, and the ordering below is the
        // same for everyone, so it is computed once instead of N times.
        let mut eval_order: Vec<usize> = (0..records.len()).collect();
        let ranking = |a: &usize, b: &usize| {
            let score = |record: &SharedRecord| {
                let event = record.contact_begin || record.joint_break || record.wake;
                (
                    !event,
                    -(record.linear_speed + record.angular_speed * 0.5),
                )
            };
            let (event_a, motion_a) = score(&records[*a]);
            let (event_b, motion_b) = score(&records[*b]);
            event_a
                .cmp(&event_b)
                .then_with(|| motion_a.total_cmp(&motion_b))
        };
        // Only the prefix clients actually read needs to be in order, so
        // partition to it in O(n) and sort that -- a full sort of every body
        // was costing more in the shared phase than the per-client saving.
        let eval_cap = max_eval_per_client();
        if eval_order.len() > eval_cap {
            eval_order.select_nth_unstable_by(eval_cap, ranking);
            eval_order.truncate(eval_cap);
        }
        eval_order.sort_unstable_by(ranking);

        SharedRecords {
            sim_tick,
            eval_order,
            records,
            baseline_id: reference_id,
        }
    }

    /// The link's smoothed round-trip time to `client`, ms, as the rate
    /// controller reads it. Half of it is the one-way latency a predictive
    /// client's horizon covers (`EncoderConfig::predictive_client`).
    pub fn note_link_rtt(&mut self, client: u64, rtt_ms: f32) {
        if rtt_ms.is_finite() && rtt_ms >= 0.0 {
            self.clients.entry(client).or_default().link_rtt_ms = Some(rtt_ms);
        }
    }

    /// Per-client selection + packet composition from the shared records.
    pub fn client_datagrams(
        &mut self,
        client: u64,
        camera: Camera,
        shared: &SharedRecords,
    ) -> Vec<Vec<u8>> {
        self.client_datagrams_within(client, camera, shared, None, 1)
    }

    /// `client_datagrams` under a per-link byte allowance for this send (the
    /// server's rate adaptation, `server/src/link_rate.rs`). The allowance
    /// only lowers the cut line of the usual selection: the same records are
    /// ranked the same way (required first, then error removed per byte), and
    /// `None` is exactly `client_datagrams`. `ceiling_sends` is how many of
    /// the stream's sends this one stands for (a limited link paced to fewer
    /// sends, `link_rate.rs`); the per-send ceiling is multiplied by it.
    pub fn client_datagrams_within(
        &mut self,
        client: u64,
        camera: Camera,
        shared: &SharedRecords,
        link_allowance_bytes: Option<usize>,
        ceiling_sends: u32,
    ) -> Vec<Vec<u8>> {
        let config = self.config;
        // Moved out for the body of this function: `state` below borrows self
        // mutably, so the audit cannot also be reached through self. Put back
        // before returning.
        let audited = self
            .audit_clients
            .as_ref()
            .map_or(true, |clients| clients.contains(&client));
        let mut audit = if audited { self.audit.take() } else { None };
        let state = self.clients.entry(client).or_default();
        let view: InterestView = state.view.update(camera, config.interest);
        // A predictive client (`EncoderConfig::predictive_client`): its
        // horizon past the render clock, the lead it draws at, and how far
        // ahead a record sent now must hold.
        let predictive = config.predictive_client.then(|| {
            let tick_ms = 1000.0 / config.sim_hz.max(1) as f32;
            let one_way_ticks = state.link_rtt_ms.unwrap_or(0.0) * 0.5 / tick_ms;
            let interval = config.send_interval_ticks.saturating_mul(ceiling_sends.max(1)) as f32;
            let horizon = one_way_ticks * config.predictive_latency_share.clamp(0.0, 1.0)
                - config.predictive_backoff_ticks
                - config.predictive_backoff_sends * interval;
            let playout = interval.min(2.0) + CLIENT_PLAYOUT_BEYOND_INTERVAL_TICKS;
            let lead = Lead {
                ballistic: (playout + horizon - CLIENT_PREDICTIVE_CLOCK_BIAS_TICKS)
                    .clamp(0.0, CLIENT_PREDICTIVE_MAX_LEAD_TICKS),
                contact_share: config.predictive_contact_share.clamp(0.0, 1.0),
                playout,
                max_overshoot_m: config.predictive_max_overshoot_m.max(0.0),
                tick_s: tick_ms / 1000.0,
            };
            (horizon, lead)
        });
        // Deltas against a generation this client cannot hold go absolute.
        let force_absolute = match state.deltas_from_generation {
            Some(first) if (shared.baseline_id.wrapping_sub(first) as i16) < 0 => true,
            Some(_) => {
                state.deltas_from_generation = None;
                false
            }
            None => false,
        };
        let for_client = |record: BodyRecord| if force_absolute { without_baseline(record) } else { record };

        // Camera basis built once, not re-derived inside every visibility test
        // for every body.
        let frusta = crate::interest::ViewFrusta::for_view(view, config.interest);
        // Sized for the record count: this used to grow from empty through a
        // dozen reallocations every send, per client.
        let mut candidates = Vec::with_capacity(shared.records.len());
        // Bounded per-client evaluation. The ceiling ships ~350 records, so
        // ranking every body for every client is work that cannot change what
        // is sent -- it only decides the order of things that were never going
        // to fit. The cap keeps the top candidates by client-independent
        // newsworthiness and is generous enough that per-client interest still
        // has real choice among them.
        let eval_limit = shared.eval_order.len().min(max_eval_per_client());
        let mut summary = ClientSelectionSummary {
            candidates: shared.eval_order.len() as u32,
            eval_cap: (shared.eval_order.len() - eval_limit) as u32,
            ..ClientSelectionSummary::default()
        };
        if let Some(audit) = audit.as_mut() {
            audit.note_send();
            audit.note_eval_cap((shared.eval_order.len() - eval_limit) as u64);
        }
        for &index in shared.eval_order.iter().take(eval_limit) {
            let shared_record = &shared.records[index];
            let entity = shared_record.record.body_entity;
            // Array index, not a hash probe: this line runs once per awake
            // body per client per send.
            let slot = shared_record.slot as usize;
            if slot >= state.slots.len() {
                state.slots.resize(slot + 1, ClientBodyState::default());
            }
            let body_state = &mut state.slots[slot];

            // Resting bodies are re-evaluated at a fraction of the send rate.
            //
            // The packing loop is O(bodies x players) because every client
            // evaluates every awake body. Most of a demolished city is awake
            // but motionless -- rubble that has come to rest without crossing
            // the sleep threshold -- and a motionless body's interest and
            // priority answer barely changes between sends. Staggering by slot
            // spreads them across sends rather than spiking on one, and moving
            // bodies are never deferred, so anything a player can actually see
            // change is evaluated every send.
            //
            // The cost is bounded latency on FIRST delivery of a resting body
            // (up to REST_EVAL_STRIDE sends, ~0.13 s at 30 Hz). It cannot
            // cause a wrong pose, only a late one, and only for something that
            // is not moving.
            // A body that has just broken loose is NOT resting rubble, even
            // though it is moving slower than rubble for its first few ticks.
            //
            // That is the whole trap: the stride's guard is speed alone, and a
            // chunk one tick into free fall is slower than the rest threshold,
            // so the gate built to save work on settled debris was deferring
            // the single most valuable record in the stream -- the one that
            // tells the client this thing is falling at all. Even correctly
            // staggered the stride costs up to REST_EVAL_STRIDE sends, which
            // is 267 ms at 30 Hz, and the client spends all of it drawing the
            // chunk where it used to be.
            //
            // Bounded: only the first FRESH_FALL_TICKS of free flight are
            // exempt, so long-settled bodies that report no contacts keep
            // their stride and the work this saves is not given back.
            let newly_freed =
                shared_record.free_ticks > 0 && shared_record.free_ticks <= FRESH_FALL_TICKS;
            let resting = !newly_freed
                && shared_record.linear_speed <= REST_SPEED_MPS
                && shared_record.angular_speed <= REST_ANGULAR_RPS;
            // Staggered by SEND index, not by sim tick.
            //
            // Sends run every `send_interval_ticks` ticks -- 2 at a 60 Hz sim
            // -- so `sim_tick` is always even here, and `(even + slot) % 8` can
            // never be zero for an odd slot. Half of all bodies were therefore
            // never re-evaluated at all while they were below the rest speed,
            // rather than being spread across sends as intended. Measured on a
            // recorded wedge collapse: the twenty slowest falls were turned
            // away by this gate 837 times, one body waited 1,538 ticks (25 s)
            // for its first record, and quadrupling the byte ceiling did not
            // move p99 or max by a single tick -- because the tail was never
            // about bandwidth.
            let send_index = shared.sim_tick / config.send_interval_ticks.max(1);
            if resting
                && (send_index.wrapping_add(shared_record.slot)) % config.rest_eval_stride.max(1) != 0
            {
                summary.rest_stride += 1;
                if let Some(audit) = audit.as_mut() {
                    note_outcome(audit, shared, shared_record, body_state, SendOutcome::RestStride);
                }
                continue;
            }

            // Nothing to tell this client about a body that is at rest where
            // the client already has it. This is not a staleness tradeoff: the
            // client's pose is already correct, so interest and priority can
            // only conclude "no update needed" after doing the full frustum
            // and error work. Skipping is the same answer for a hash lookup
            // and two compares.
            //
            // With sleep miscalibrated most of a settled rubble field is
            // "awake" but motionless, so this is the bulk of the stream input:
            // ~10k bodies evaluated per client per send to ship ~350.
            let at_rest = shared_record.linear_speed <= REST_SPEED_MPS
                && shared_record.angular_speed <= REST_ANGULAR_RPS;
            // Where the client draws the body now: the last record's pose, or
            // (modelled) that pose as the client extrapolates it.
            let drawn = if let Some((_, lead)) = predictive {
                body_state.presented_at_ahead(shared.sim_tick as f32, config.sim_hz, Some(lead))
            } else if config.model_client_extrapolation {
                body_state.presented_at(shared.sim_tick, config.sim_hz)
            } else {
                body_state.last_sent.map(|(_, pose)| pose)
            };
            // How far the drawn pose is from the truth, over the body.
            let drawn_error_m = drawn.map(|pose| {
                pose_error_m(shared_record.record.pose, pose, shared_record.radius)
            });
            if let Some(last_pose) = drawn {
                let unchanged = if config.model_client_extrapolation {
                    drawn_error_m.is_some_and(|error| error <= REST_CORRECTION_M)
                } else {
                    shared_record.position.distance_squared(last_pose.position)
                        <= REST_POSE_EPSILON_M * REST_POSE_EPSILON_M
                };
                if at_rest && unchanged {
                    summary.rest_unchanged += 1;
                    if let Some(audit) = audit.as_mut() {
                        note_outcome(
                            audit, shared, shared_record, body_state, SendOutcome::RestUnchanged);
                    }
                    continue;
                }
            }
            let decision = body_state.track.update_with_frusta(
                shared.sim_tick,
                Pose {
                    position: shared_record.position,
                    rotation: glam::Quat::IDENTITY,
                },
                shared_record.linear_velocity,
                shared_record.radius,
                frusta,
                config.interest,
            );
            if !decision.relevant {
                summary.not_relevant += 1;
                if let Some(audit) = audit.as_mut() {
                    note_outcome(audit, shared, shared_record, body_state, SendOutcome::NotRelevant);
                }
                continue;
            }
            let age_ticks = body_state
                .last_sent
                .map_or(u32::MAX / 2, |(last, _)| shared.sim_tick.saturating_sub(last));
            let error_ratio = drawn.map_or(4.0, |last_pose| {
                projected_error_pixels(
                    Pose {
                        position: shared_record.position,
                        rotation: shared_record.record.pose.rotation,
                    },
                    last_pose,
                    shared_record.radius,
                    view.current,
                    config.interest.pane_width,
                    config.interest.pane_height,
                ) / config.error_budget_px.max(0.01)
            });
            // Dead reckoning at the predictive client's horizon: where the
            // last record puts the body by the time a record sent now can be
            // drawn, against where its current state puts it then.
            let error_ratio = match predictive {
                Some((horizon, lead)) if config.predictive_horizon_error && horizon > 0.0 => {
                    let ahead = body_state.presented_at_ahead(
                        shared.sim_tick as f32 + horizon,
                        config.sim_hz,
                        Some(lead),
                    );
                    let expected = match SentMotion::of(&shared_record.record) {
                        Some(motion) => {
                            let pose = shared_record.record.pose;
                            let mut ahead = extrapolate_like_the_client(
                                pose,
                                motion,
                                horizon / config.sim_hz.max(1) as f32,
                            );
                            if motion.ballistic && ahead.position.y < CLIENT_PREDICTIVE_FLOOR_Y {
                                ahead.position.y = pose.position.y.min(CLIENT_PREDICTIVE_FLOOR_Y);
                            }
                            ahead
                        }
                        None => shared_record.record.pose,
                    };
                    ahead.map_or(error_ratio, |ahead| {
                        error_ratio.max(
                            projected_error_pixels(
                                expected,
                                ahead,
                                shared_record.radius,
                                view.current,
                                config.interest.pane_width,
                                config.interest.pane_height,
                            ) / config.error_budget_px.max(0.01),
                        )
                    })
                }
                _ => error_ratio,
            };
            // A velocity perturbation counts at most once per innovation
            // window since this client's last record of the body: faster
            // sends judge the same acceleration (the scale in `encode_send`)
            // as often as the 30 Hz stream did, not at every send. At 30 Hz
            // every earlier record is at least a window old, so nothing
            // changes there.
            let perturbation_due = config.innovation_window_ticks == 0
                || age_ticks >= config.innovation_window_ticks;
            let priority = compute_priority(
                PriorityInput {
                    class: shared_record.class,
                    projected_error_ratio: error_ratio,
                    age_ticks,
                    contacts: shared_record.contacts,
                    linear_speed: shared_record.linear_speed,
                    angular_speed: shared_record.angular_speed,
                    linear_velocity_innovation: if perturbation_due {
                        shared_record.linear_innovation
                    } else {
                        0.0
                    },
                    angular_velocity_innovation: if perturbation_due {
                        shared_record.angular_innovation
                    } else {
                        0.0
                    },
                    contact_begin: shared_record.contact_begin,
                    joint_break: shared_record.joint_break,
                    wake: shared_record.wake,
                    interest_entry: decision.entering,
                },
                config.priority,
            );
            // A body at rest that the client draws somewhere else -- it
            // extrapolated the last record past where the body stopped --
            // gets one correcting record, whatever its class: the priority
            // gate never sends to a quiescent body, and nothing else would
            // move it until the reliable settle, if one ever comes.
            let rest_correction = config.model_client_extrapolation
                && at_rest
                && drawn_error_m.is_some_and(|error| error > REST_CORRECTION_M);
            if !priority.should_send && !rest_correction {
                summary.not_newsworthy += 1;
                if let Some(audit) = audit.as_mut() {
                    note_outcome(
                        audit, shared, shared_record, body_state, SendOutcome::NotNewsworthy);
                }
                continue;
            }
            // Packed cost estimate: logical bytes minus the 4-byte id plus a
            // typical 2-byte packet-local gap.
            let cost = for_client(shared_record.record).body_bytes() - 4 + 2;
            candidates.push(BudgetCandidate {
                index,
                cost_bytes: cost,
                priority: priority.score,
                required: priority.hard_deadline || decision.entering,
            });
        }

        // Token bucket over the per-send ceiling.
        //
        // Refill one ceiling per send, bank up to `burst_capacity_sends` of
        // them, and never spend more than `burst_max_multiple` ceilings in one
        // send. With the capacity at zero this is arithmetically identical to
        // the plain ceiling, which is what keeps the old behaviour one config
        // value away.
        let steady = config.client_ceiling_bytes.saturating_mul(ceiling_sends.max(1) as usize);
        let allowance = if config.burst_capacity_sends == 0 {
            steady
        } else {
            let capacity = steady.saturating_mul(config.burst_capacity_sends as usize);
            // Starts full: a client joining mid-collapse has banked nothing,
            // and making it wait a second to earn its first burst would starve
            // exactly the join that needs the stream most.
            let tokens = state.burst_tokens.get_or_insert(capacity);
            *tokens = tokens.saturating_add(steady).min(capacity);
            let cap = steady.saturating_mul(config.burst_max_multiple.max(1) as usize);
            (*tokens).min(cap)
        };
        let allowance = link_allowance_bytes.map_or(allowance, |link| allowance.min(link));
        let selection = select_with_ceiling(&mut candidates, Some(allowance), 0);
        summary.sent = selection.selected_indices.len() as u32;
        summary.ceiling = (candidates.len() - selection.selected_indices.len()) as u32;
        summary.allowance_bytes = u32::try_from(allowance).unwrap_or(u32::MAX);
        summary.used_bytes = u32::try_from(selection.used_bytes).unwrap_or(u32::MAX);
        self.last_selection = summary;
        if let Some(tokens) = state.burst_tokens.as_mut() {
            *tokens = tokens.saturating_sub(selection.used_bytes);
        }
        // Everything that was ranked but did not fit. This is the only drop
        // site that is genuinely about bandwidth; the five above are policy,
        // and telling them apart is the point of the audit.
        if let Some(audit) = audit.as_mut() {
            let won: std::collections::HashSet<usize> =
                selection.selected_indices.iter().copied().collect();
            for candidate in candidates.iter() {
                if won.contains(&candidate.index) {
                    continue;
                }
                let shared_record = &shared.records[candidate.index];
                let slot = shared_record.slot as usize;
                let body_state = state.slots.get(slot).cloned().unwrap_or_default();
                note_outcome(audit, shared, shared_record, &body_state, SendOutcome::Ceiling);
            }
        }
        let mut selected: Vec<BodyRecord> = selection
            .selected_indices
            .iter()
            .map(|&index| for_client(shared.records[index].record))
            .collect();
        selected.sort_unstable_by_key(|record| record.body_entity);
        // The wire format LEB128-encodes strictly increasing body-id gaps, so a
        // duplicate entity is unencodable. A physics-side id-aliasing bug used
        // to send duplicates here, which tripped the encoder's debug assertion
        // and killed the whole match loop (and in release would have emitted a
        // zero gap that desyncs every client's record stream). Never let a bad
        // id upstream take the match down: drop the duplicate and carry on.
        let before = selected.len();
        selected.dedup_by_key(|record| record.body_entity);
        if selected.len() != before {
            self.duplicate_body_records += (before - selected.len()) as u64;
        }

        for index in &selection.selected_indices {
            let shared_record = &shared.records[*index];
            let slot = shared_record.slot as usize;
            if slot >= state.slots.len() {
                state.slots.resize(slot + 1, ClientBodyState::default());
            }
            // Noted BEFORE the overwrite: the error this record avoided is
            // measured against the pose the client was holding until now.
            if let Some(audit) = audit.as_mut() {
                note_outcome(
                    audit, shared, shared_record, &state.slots[slot], SendOutcome::Sent);
            }
            state.slots[slot].last_sent =
                Some((shared.sim_tick, shared_record.record.pose));
            state.slots[slot].last_motion = SentMotion::of(&shared_record.record);
        }
        let mut datagrams = encode_chunks_datagrams(
            &selected,
            &mut state.sequence,
            shared.baseline_id,
            shared.sim_tick,
        );
        // The horizon trailer, on every records datagram with room for it.
        if let Some((horizon, _)) = predictive {
            for packet in &mut datagrams {
                if packet.len() + crate::wire::HORIZON_SECTION_BYTES <= crate::quant::MAX_DATAGRAM {
                    crate::wire::write_horizon(packet, horizon);
                }
            }
        }
        if audited {
            self.audit = audit;
        }
        datagrams
    }

    /// Reliable topology messages staged since the last take — identical
    /// bytes broadcast to every client.
    pub fn take_topology_messages(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.staged_topology)
    }

    /// Scheduled global baseline: on cadence, snapshot all awake body poses,
    /// advance the baseline generation, and emit the reliable broadcast parts.
    pub fn maybe_emit_baseline(&mut self, sim_tick: u32) -> Option<Vec<Vec<u8>>> {
        let due = self
            .last_baseline_tick
            .is_none_or(|last| sim_tick.saturating_sub(last) >= self.config.baseline_interval_ticks);
        if !due {
            return None;
        }
        self.last_baseline_tick = Some(sim_tick);
        if self.config.baseline_reference_lag_ticks > 0 {
            self.previous_baseline =
                Some((self.baseline_id, std::mem::take(&mut self.baseline_poses)));
        }
        self.baseline_id = self.baseline_id.wrapping_add(1);
        self.baseline_poses.clear();
        let mut records = Vec::with_capacity(self.active_order.len());
        for &entity in &self.active_order {
            if let Some(track) = self.bodies.get(&entity) {
                if self.config.baseline_skips_quiescent && track.class == PhysicalClass::Quiescent {
                    continue;
                }
                self.baseline_poses.insert(entity, track.state.pose);
                records.push(BaselineRecord {
                    body_entity: entity,
                    pose: track.state.pose,
                });
            }
        }
        // ≤ 32 KB parts to bound reliable-queue pressure (~17 B/record).
        const RECORDS_PER_PART: usize = 1_800;
        let part_count = records.len().div_ceil(RECORDS_PER_PART).max(1) as u16;
        let mut packets = Vec::new();
        for (part_index, chunk) in records
            .chunks(RECORDS_PER_PART)
            .enumerate()
            .map(|(i, c)| (i as u16, c))
        {
            packets.push(encode_baseline(&BaselineMessage {
                baseline_id: self.baseline_id,
                sim_tick,
                part_index,
                part_count,
                records: chunk.to_vec(),
            }));
        }
        if records.is_empty() {
            packets.push(encode_baseline(&BaselineMessage {
                baseline_id: self.baseline_id,
                sim_tick,
                part_index: 0,
                part_count: 1,
                records: Vec::new(),
            }));
        }
        Some(packets)
    }

    /// Late-join / resync payload.
    pub fn bootstrap_message(&self, sim_tick: u32) -> Vec<u8> {
        let bodies = &self.bodies;
        let live_motion = move |structure_id: u32, serial: u32| {
            bodies
                .get(&ids::body_entity(structure_id, serial))
                .map(|track| {
                    (
                        track.state.pose,
                        track.state.linear_velocity,
                        track.state.angular_velocity,
                    )
                })
        };
        encode_bootstrap(&self.ledger.bootstrap(
            sim_tick,
            self.manifest_hash,
            self.baseline_id,
            self.topo_seq,
            &live_motion,
        ))
    }

    /// A bootstrap covering only the named structures — the repair a
    /// [`Self::topology_hash_message`] mismatch drives.
    pub fn structure_bootstrap_message(&self, sim_tick: u32, structures: &[u32]) -> Vec<u8> {
        let bodies = &self.bodies;
        let live_motion = move |structure_id: u32, serial: u32| {
            bodies
                .get(&ids::body_entity(structure_id, serial))
                .map(|track| {
                    (
                        track.state.pose,
                        track.state.linear_velocity,
                        track.state.angular_velocity,
                    )
                })
        };
        crate::wire::encode_structure_bootstrap(&self.ledger.bootstrap_filtered(
            sim_tick,
            self.manifest_hash,
            self.baseline_id,
            self.topo_seq,
            &live_motion,
            Some(structures),
        ))
    }

    /// Per-structure ledger hashes at the current topo_seq, for periodic
    /// broadcast. The client only compares when its own seq matches, so the
    /// message is meaningful regardless of stream position.
    pub fn topology_hash_message(&self) -> Vec<u8> {
        crate::wire::encode_topology_hashes(self.topo_seq, &self.ledger.structure_hashes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_netcode::destruction_backend::{FractureBatch, IslandPromotion, SettleEvent};

    use crate::city::{build_city_scene, CitySceneDesc};
    use crate::scene_pack::parse_scene_pack;

    fn manifest() -> DestructionManifest {
        let pack = parse_scene_pack(
            r#"{
            "version": 1, "title": "tiny",
            "scenario": {
                "nodes": [
                    {"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0, "volume": 1},
                    {"centroid": {"x": 0, "y": 1, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 2, "z": 0}, "mass": 10, "volume": 1}
                ],
                "bonds": [
                    {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": 0.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 1, "node1": 2, "centroid": {"x": 0, "y": 1.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
                ],
                "nodeSizes": [
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}
                ],
                "nodeColliders": [
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
                ]
            }
        }"#,
        )
        .expect("pack");
        DestructionManifest::from_city(
            &build_city_scene(
                &pack,
                CitySceneDesc {
                    grid: 1,
                    pitch_m: 10.0,
                    varied_heights: false,
                },
            )
            .expect("city"),
        )
    }

    fn promotion_output() -> DestructionTickOutput {
        DestructionTickOutput {
            batches: vec![FractureBatch {
                structure_id: 0,
                broken_bond_ids: vec![ids::bond_id(0, 1)],
                promoted_islands: vec![IslandPromotion {
                    structure_id: 0,
                    island_id: 1,
                    chunks: vec![ids::chunk_id(0, 2)],
                    position: [0.0, 2.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    linear_velocity: [1.0, 0.0, 0.0],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            settled: Vec::new(),
            wakes: Vec::new(),
        }
    }

    fn snapshot(tick_offset: f32) -> BodySnapshotInput {
        BodySnapshotInput {
            body_entity: ids::body_entity(0, 1),
            position: [1.0 + tick_offset, 2.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: [1.0, 0.0, 0.0],
            angular_velocity: [0.0, 0.0, 0.0],
            contacts: 0,
            flags: 0,
        }
    }

    fn close_camera() -> Camera {
        Camera {
            eye: Vec3::new(0.0, 2.0, -10.0),
            direction: Vec3::Z,
            fov_degrees: 70.0,
        }
    }

    /// A physics-side id-allocation bug once handed the encoder two records
    /// with the same body entity. The wire format LEB128-encodes strictly
    /// increasing id gaps, so that tripped `encode_chunks_datagrams`'s sorted
    /// assertion and took the entire match loop down with it. Duplicates must
    /// be dropped and counted, never fatal.
    #[test]
    fn duplicate_body_entities_are_dropped_not_fatal() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let _ = encoder.take_topology_messages();
        let _ = encoder.maybe_emit_baseline(10);

        // Same entity twice in one tick, as the aliasing bug produced.
        let duplicated = [snapshot(1.0), snapshot(1.0)];
        assert_eq!(duplicated[0].body_entity, duplicated[1].body_entity);
        encoder.ingest_tick(12, &duplicated, &DestructionTickOutput::default(), &[]);

        // The baseline path has the same strictly-increasing requirement.
        let interval = EncoderConfig::validated(60).baseline_interval_ticks;
        let baseline = encoder.maybe_emit_baseline(10 + interval).expect("baseline");
        assert!(!baseline.is_empty());

        let shared = encoder.encode_send(12);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        for packet in &packets {
            let decoded = crate::wire::decode_chunks_datagram(packet).expect("decodable");
            let entities: Vec<u32> = decoded.records.iter().map(|r| r.body_entity).collect();
            let mut sorted = entities.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(entities.len(), sorted.len(), "duplicate entity reached the wire");
        }
        assert!(
            encoder.stats().duplicate_body_records > 0,
            "the dropped duplicate should be counted so the physics bug stays visible"
        );
    }

    /// A frozen body released by a spatial wake must reach the client as a
    /// wake record, and must clear the settle that parked it.
    ///
    /// The settle record is terminal on the wire: the client parks the body
    /// at that pose and stops applying the pose stream to it. Freezing a body
    /// emits one and then removes the body from the pose stream entirely, so
    /// waking it back is invisible unless it is announced. Without this the
    /// pile would visibly stay put while the server simulated it moving.
    #[test]
    fn a_woken_body_clears_its_settle_on_the_wire() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let promoted = encoder.take_topology_messages();

        // Freeze: a settle record parks the body at its resting pose.
        let settled = DestructionTickOutput {
            settled: vec![SettleEvent {
                structure_id: 0,
                island_id: 1,
                position: [1.0, 2.0, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
            }],
            ..DestructionTickOutput::default()
        };
        encoder.ingest_tick(11, &[], &settled, &[]);
        let parked = encoder.take_topology_messages();
        let decoded = crate::wire::decode_topology(&parked[0]).expect("topology");
        assert_eq!(decoded.settled.len(), 1, "the freeze must publish a rest pose");
        assert!(decoded.wakes.is_empty());

        // A shot lands nearby and the body is released.
        let woken = DestructionTickOutput {
            wakes: vec![(0, 1)],
            ..DestructionTickOutput::default()
        };
        encoder.ingest_tick(12, &[snapshot(1.0)], &woken, &woken.wakes);
        let released = encoder.take_topology_messages();
        assert_eq!(released.len(), 1, "a wake must stage its own topology message");
        let decoded = crate::wire::decode_topology(&released[0]).expect("topology");
        assert_eq!(
            decoded.wakes,
            vec![(0u32, 1u32)],
            "the wake did not survive the wire encoding"
        );

        // And the client-side ledger applying that message must un-park it.
        // A real client builds its ledger from the manifest; a default one
        // has no structures and silently drops every batch.
        let mut client = CityLedger::from_manifest(&manifest);
        for message in [&promoted[0], &parked[0], &released[0]] {
            let decoded = crate::wire::decode_topology(message).expect("topology");
            for batch in &decoded.batches {
                client.apply_batch(batch);
            }
            for settle in &decoded.settled {
                client.apply_settle(settle);
            }
            for &(structure_id, serial) in &decoded.wakes {
                client.apply_wake(structure_id, serial);
            }
        }
        assert!(
            !client.island(0, 1).expect("island is live").settled,
            "the client is still holding the body parked after a wake"
        );
    }

    /// A replay resumed from a checkpoint must emit exactly the bytes the
    /// encoder it was taken from emits, message for message: that is what
    /// lets Netlab v2 replay a capture that began mid-match.
    #[test]
    fn checkpoint_resumes_byte_identically() {
        let manifest = manifest();
        let mut live = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        live.add_client(1);
        live.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let _ = live.take_topology_messages();
        let _ = live.maybe_emit_baseline(10);
        let shared = live.encode_send(10);
        let _ = live.client_datagrams(1, close_camera(), &shared);

        // Through the same serialisation the capture writes.
        let json = serde_json::to_vec(&live.checkpoint()).expect("serialise");
        let checkpoint: EncoderCheckpoint = serde_json::from_slice(&json).expect("deserialise");
        assert_eq!(checkpoint.clients(), vec![1]);
        let mut resumed =
            ChunkStreamEncoder::from_checkpoint(&manifest, checkpoint).expect("restore");

        for tick in 11..140u32 {
            let input = [snapshot(tick as f32 * 0.05)];
            for encoder in [&mut live, &mut resumed] {
                encoder.ingest_tick(tick, &input, &DestructionTickOutput::default(), &[]);
            }
            assert_eq!(live.take_topology_messages(), resumed.take_topology_messages());
            assert_eq!(live.maybe_emit_baseline(tick), resumed.maybe_emit_baseline(tick));
            if tick % 2 == 0 {
                let a = live.encode_send(tick);
                let b = resumed.encode_send(tick);
                assert_eq!(
                    live.client_datagrams(1, close_camera(), &a),
                    resumed.client_datagrams(1, close_camera(), &b),
                    "datagrams diverged at tick {tick}"
                );
            }
            assert_eq!(live.bootstrap_message(tick), resumed.bootstrap_message(tick));
        }
        assert_eq!(live.stats().topo_seq, resumed.stats().topo_seq);
    }

    #[test]
    fn checkpoint_refuses_another_manifest() {
        let manifest = manifest();
        let encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        let mut checkpoint = encoder.checkpoint();
        checkpoint.manifest_hash[0] ^= 1;
        assert!(ChunkStreamEncoder::from_checkpoint(&manifest, checkpoint).is_err());
    }

    #[test]
    fn fracture_ingest_stages_topology_and_streams_the_island() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);

        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let topology = encoder.take_topology_messages();
        assert_eq!(topology.len(), 1);
        let decoded = crate::wire::decode_topology(&topology[0]).expect("topology");
        assert_eq!(decoded.topo_seq, 1);
        assert_eq!(decoded.batches[0].promoted_islands.len(), 1);

        // Baselines start on the first cadence check.
        let baseline = encoder.maybe_emit_baseline(10).expect("baseline");
        assert_eq!(baseline.len(), 1);

        let shared = encoder.encode_send(10);
        assert_eq!(shared.records.len(), 1);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        assert_eq!(packets.len(), 1);
        let datagram = crate::wire::decode_chunks_datagram(&packets[0]).expect("datagram");
        assert_eq!(datagram.records.len(), 1);
        assert_eq!(datagram.records[0].body_entity, ids::body_entity(0, 1));
    }

    /// Topology copies (`topology_datagram_copies`): each message rides the
    /// datagram lane at the next two sends, ahead of that send's records, in
    /// a record-less chunk datagram stamped no newer than the previous send,
    /// and the bytes are exactly the reliable message's.
    #[test]
    fn topology_copies_go_ahead_of_the_records_at_two_sends() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        assert_eq!(encoder.config().topology_datagram_copies, 2);
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let reliable = encoder.take_topology_messages();
        assert_eq!(reliable.len(), 1);
        assert!(encoder.has_topology_copies(1));

        let mut sends = Vec::new();
        let interval = encoder.config().send_interval_ticks;
        for tick in [10u32, 10 + interval, 10 + 2 * interval] {
            let shared = encoder.encode_send(tick);
            let mut packets = Vec::new();
            let added = encoder.add_topology_copies(1, tick, &mut packets);
            packets.extend(encoder.client_datagrams(1, close_camera(), &shared));
            sends.push((tick, added, packets));
        }
        for (tick, added, packets) in &sends[..2] {
            let first = crate::wire::decode_chunks_datagram(&packets[0]).expect("copy datagram");
            assert!(first.records.is_empty(), "copies travel in their own datagram");
            assert_eq!(first.sim_tick, tick - interval, "stamped no newer than the previous send");
            assert_eq!(first.topology_parts.len(), 1);
            let part = &first.topology_parts[0];
            assert_eq!((part.topo_seq, part.part, part.parts), (1, 0, 1));
            assert_eq!(part.bytes, reliable[0], "the reliable message's own bytes");
            assert_eq!(*added, packets[0].len());
            // The records follow, untouched.
            for packet in &packets[1..] {
                let records = crate::wire::decode_chunks_datagram(packet).expect("records");
                assert_eq!(records.records.len(), 1);
                assert!(records.topology_parts.is_empty());
            }
        }
        assert_eq!(sends[0].2.len(), 2, "the first send carries the new body's record");
        let (_, added, packets) = &sends[2];
        assert_eq!(*added, 0, "two copies, then none");
        assert!(!encoder.has_topology_copies(1));
        assert!(crate::wire::decode_chunks_datagram(&packets[0]).expect("records").topology_parts.is_empty());
    }

    /// A message larger than a datagram is split into parts that reassemble
    /// to its bytes; the repeat of an earlier message never queues ahead of
    /// the first copy of a later one.
    #[test]
    fn large_topology_copies_are_split_and_first_copies_go_first() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        let big: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        encoder.queue_topology_copies(7, &big);
        let mut first = Vec::new();
        encoder.add_topology_copies(1, 10, &mut first);
        let parts: Vec<_> = first
            .iter()
            .flat_map(|p| crate::wire::decode_chunks_datagram(p).expect("copy").topology_parts)
            .collect();
        assert_eq!(parts.len(), 3);
        assert!(first.iter().all(|p| p.len() <= crate::quant::MAX_DATAGRAM));
        let joined: Vec<u8> = parts.iter().flat_map(|p| p.bytes.clone()).collect();
        assert_eq!(joined, big);
        assert!(parts.iter().enumerate().all(|(i, p)| p.part as usize == i && p.parts == 3 && p.topo_seq == 7));

        encoder.queue_topology_copies(8, &[120, 2, 8, 0, 0, 0]);
        let mut second = Vec::new();
        encoder.add_topology_copies(1, 12, &mut second);
        let order: Vec<u32> = second
            .iter()
            .flat_map(|p| crate::wire::decode_chunks_datagram(p).expect("copy").topology_parts)
            .map(|p| p.topo_seq)
            .collect();
        assert_eq!(order, vec![8, 7, 7, 7], "the new message's first copy, then the repeat");
    }

    /// Captures made before copies existed resume with them off, so their
    /// replays stay byte-exact.
    #[test]
    fn an_older_checkpoint_resumes_without_topology_copies() {
        let manifest = manifest();
        let encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        let mut json = serde_json::to_value(encoder.checkpoint()).expect("json");
        json["config"].as_object_mut().expect("config").remove("topology_datagram_copies");
        let checkpoint: EncoderCheckpoint = serde_json::from_value(json).expect("older checkpoint");
        let mut resumed = ChunkStreamEncoder::from_checkpoint(&manifest, checkpoint).expect("resume");
        assert_eq!(resumed.config().topology_datagram_copies, 0);
        resumed.add_client(1);
        resumed.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        assert!(!resumed.has_topology_copies(1));
        let mut packets = Vec::new();
        assert_eq!(resumed.add_topology_copies(1, 10, &mut packets), 0);
        assert!(packets.is_empty());
    }

    #[test]
    fn irrelevant_bodies_are_not_sent() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);

        // Camera far away, looking away from the island, outside proximity.
        let away = Camera {
            eye: Vec3::new(500.0, 2.0, 500.0),
            direction: Vec3::X,
            fov_degrees: 70.0,
        };
        let shared = encoder.encode_send(10);
        let packets = encoder.client_datagrams(1, away, &shared);
        assert!(packets.is_empty());
        // The summary says why: the one candidate was out of interest.
        let summary = encoder.last_client_selection();
        assert_eq!(summary.candidates, 1);
        assert_eq!(summary.not_relevant, 1);
        assert_eq!(summary.sent, 0);
    }

    #[test]
    fn selection_summary_accounts_for_every_candidate() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let shared = encoder.encode_send(10);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        assert_eq!(packets.len(), 1);
        let s = encoder.last_client_selection();
        assert_eq!(s.sent, 1);
        assert_eq!(
            s.candidates,
            s.eval_cap + s.rest_stride + s.rest_unchanged + s.not_relevant
                + s.not_newsworthy + s.ceiling + s.sent
        );
        assert!(s.used_bytes > 0 && s.used_bytes <= s.allowance_bytes);
    }

    #[test]
    fn deltas_flow_after_a_baseline_and_absolutes_before() {
        let manifest = manifest();
        // Deltas against the newest generation at once: the lag is its own test.
        let mut config = EncoderConfig::validated(60);
        config.baseline_reference_lag_ticks = 0;
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);

        // No baseline yet: records must be absolute-family.
        let shared = encoder.encode_send(10);
        assert!(matches!(
            shared.records[0].record.mode,
            RecordMode::MotionAbsolute | RecordMode::Absolute | RecordMode::Ballistic
        ));

        encoder.maybe_emit_baseline(10).expect("baseline");
        encoder.ingest_tick(12, &[snapshot(0.1)], &DestructionTickOutput::default(), &[]);
        let shared = encoder.encode_send(12);
        // With a baseline stored and the classifier not yet ballistic-stable,
        // moving bodies use motion-delta.
        assert!(matches!(
            shared.records[0].record.mode,
            RecordMode::MotionDelta | RecordMode::Ballistic
        ));
    }

    #[test]
    fn ceiling_bounds_selected_bytes() {
        let manifest = manifest();
        let mut config = EncoderConfig::validated(60);
        config.client_ceiling_bytes = 40; // Room for one ~31-byte motion record.
        // This test is about the ceiling itself, so bank nothing: with the
        // burst bucket on, a send may spend several ceilings and both records
        // fit, which is the bucket working rather than the ceiling failing.
        config.burst_capacity_sends = 0;
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);

        // Two islands from two batches.
        let mut output = promotion_output();
        output.batches[0].promoted_islands.push(IslandPromotion {
            structure_id: 0,
            island_id: 2,
            chunks: vec![ids::chunk_id(0, 1)],
            position: [0.0, 1.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: [0.5, 0.0, 0.0],
            ..Default::default()
        });
        let snapshots = [
            snapshot(0.0),
            BodySnapshotInput {
                body_entity: ids::body_entity(0, 2),
                position: [0.5, 1.0, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity: [0.5, 0.0, 0.0],
                angular_velocity: [0.0, 0.0, 0.0],
                contacts: 0,
                flags: 0,
            },
        ];
        encoder.ingest_tick(10, &snapshots, &output, &[]);
        let shared = encoder.encode_send(10);
        assert_eq!(shared.records.len(), 2);
        let packets = encoder.client_datagrams(1, close_camera(), &shared);
        let total_records: usize = packets
            .iter()
            .map(|p| {
                crate::wire::decode_chunks_datagram(p)
                    .expect("decode")
                    .records
                    .len()
            })
            .sum();
        assert_eq!(total_records, 1, "ceiling must drop the lower-priority body");
    }

    /// The per-link allowance (server rate adaptation) moves only the cut
    /// line: with none the bytes are exactly `client_datagrams`'s, and a
    /// small one keeps the body the ceiling would keep.
    #[test]
    fn a_link_allowance_moves_only_the_cut_line() {
        let manifest = manifest();
        let mut config = EncoderConfig::validated(60);
        config.burst_capacity_sends = 0;
        let run = |allowance: Option<usize>, ceiling: usize| {
            let mut config = config;
            config.client_ceiling_bytes = ceiling;
            let mut encoder = ChunkStreamEncoder::new(&manifest, config);
            encoder.add_client(1);
            let mut output = promotion_output();
            output.batches[0].promoted_islands.push(IslandPromotion {
                structure_id: 0,
                island_id: 2,
                chunks: vec![ids::chunk_id(0, 1)],
                position: [0.0, 1.0, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity: [0.5, 0.0, 0.0],
                ..Default::default()
            });
            let snapshots = [
                snapshot(0.0),
                BodySnapshotInput {
                    body_entity: ids::body_entity(0, 2),
                    position: [0.5, 1.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    linear_velocity: [0.5, 0.0, 0.0],
                    angular_velocity: [0.0, 0.0, 0.0],
                    contacts: 0,
                    flags: 0,
                },
            ];
            encoder.ingest_tick(10, &snapshots, &output, &[]);
            let shared = encoder.encode_send(10);
            let packets = match allowance {
                Some(bytes) => encoder.client_datagrams_within(1, close_camera(), &shared, Some(bytes), 1),
                None => encoder.client_datagrams(1, close_camera(), &shared),
            };
            let summary = encoder.last_client_selection();
            (packets, summary)
        };
        let (plain, plain_summary) = run(None, 10_400);
        let (unlimited, _) = run(Some(usize::MAX), 10_400);
        assert_eq!(plain, unlimited, "an allowance above the ceiling changes nothing");
        let records = |packets: &Vec<Vec<u8>>| -> Vec<u32> {
            packets
                .iter()
                .flat_map(|p| crate::wire::decode_chunks_datagram(p).expect("decode").records)
                .map(|r| r.body_entity)
                .collect()
        };
        assert_eq!(records(&plain).len(), 2);
        assert_eq!(plain_summary.allowance_bytes, 10_400);
        let (link_cut, link_summary) = run(Some(40), 10_400);
        let (ceiling_cut, _) = run(None, 40);
        assert_eq!(records(&link_cut).len(), 1, "the allowance must drop the lower-priority body");
        assert_eq!(link_cut, ceiling_cut, "same winner as a ceiling of the same size");
        assert_eq!(link_summary.allowance_bytes, 40);
        assert_eq!(link_summary.ceiling, 1, "the deferred body is counted as a ceiling drop");
        let (nothing, _) = run(Some(0), 10_400);
        assert!(nothing.is_empty(), "a zero allowance sends no packet");
    }

    #[test]
    fn bootstrap_reflects_ledger_state() {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let bootstrap =
            crate::wire::decode_bootstrap(&encoder.bootstrap_message(11)).expect("bootstrap");
        assert_eq!(bootstrap.manifest_hash, manifest.hash());
        assert_eq!(bootstrap.topo_seq, 1);
        assert_eq!(bootstrap.islands.len(), 1);
        assert_eq!(bootstrap.islands[0].nodes, vec![2]);
        // Bond 1 broken -> alive bitset has only bond 0.
        assert_eq!(bootstrap.structures[0].alive_bonds, vec![0b0000_0001]);
    }

    /// Every slot must get its turn, at the send cadence the server runs.
    ///
    /// The stride is staggered so resting bodies spread across sends instead
    /// of spiking on one. Staggering by SIM TICK broke that completely: sends
    /// only happen on ticks divisible by `send_interval_ticks`, so at 30 Hz on
    /// a 60 Hz sim `sim_tick` is always even and `(even + slot) % 8` can never
    /// be zero for an odd slot. Half of all bodies were never re-evaluated
    /// while they were below the rest speed -- which is how a chunk that had
    /// just broken loose could hang for 1,538 ticks before its first record,
    /// unaffected by any amount of extra bandwidth.
    #[test]
    fn the_rest_stride_gives_every_slot_a_turn_at_the_real_send_cadence() {
        for sim_hz in [30, 60, 120] {
            let send_interval = EncoderConfig::validated(sim_hz).send_interval_ticks.max(1);
            for slot in 0..32u32 {
                let turns = (0..2000)
                    .filter(|tick| tick % send_interval == 0)
                    .filter(|tick| {
                        let send_index = tick / send_interval;
                        send_index.wrapping_add(slot) % REST_EVAL_STRIDE == 0
                    })
                    .count();
                assert!(
                    turns > 0,
                    "slot {slot} never evaluated at {sim_hz} Hz \
                     (send interval {send_interval} ticks)"
                );
            }
        }
    }

    /// And its turns must be evenly spaced, or "spread across sends" is only
    /// half true and some slots still bunch up.
    #[test]
    fn the_rest_stride_spaces_each_slot_evenly() {
        let send_interval = EncoderConfig::validated(60).send_interval_ticks.max(1);
        for slot in 0..16u32 {
            let turns: Vec<u32> = (0..2000)
                .filter(|tick| tick % send_interval == 0)
                .filter(|tick| (tick / send_interval).wrapping_add(slot) % REST_EVAL_STRIDE == 0)
                .collect();
            for pair in turns.windows(2) {
                assert_eq!(
                    pair[1] - pair[0],
                    REST_EVAL_STRIDE * send_interval,
                    "slot {slot} turns are not evenly spaced"
                );
            }
        }
    }

    fn body_at(position: [f32; 3], velocity: [f32; 3]) -> BodySnapshotInput {
        BodySnapshotInput {
            body_entity: ids::body_entity(0, 1),
            position,
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: velocity,
            angular_velocity: [0.0, 0.0, 0.0],
            // As the native backend reports them: never.
            contacts: 0,
            flags: 0,
        }
    }

    /// Streams `ticks` of `motion(tick)` to one client looking through
    /// `camera`, sending at the config's cadence; returns every record the client
    /// received, with its tick, delta records resolved against the baseline
    /// generation their datagram names (as the client resolves them).
    fn stream_to(
        config: EncoderConfig,
        ticks: std::ops::Range<u32>,
        camera: Camera,
        motion: impl Fn(u32) -> BodySnapshotInput,
    ) -> Vec<(u32, crate::wire::DecodedBodyRecord)> {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        let mut received = Vec::new();
        let mut baselines: HashMap<u16, Vec3> = HashMap::new();
        for tick in ticks.clone() {
            let output = if tick == ticks.start { promotion_output() } else { DestructionTickOutput::default() };
            encoder.ingest_tick(tick, &[motion(tick)], &output, &[]);
            let _ = encoder.take_topology_messages();
            for part in encoder.maybe_emit_baseline(tick).into_iter().flatten() {
                let message = crate::wire::decode_baseline(&part).expect("baseline");
                if let Some(record) = message.records.first() {
                    baselines.insert(message.baseline_id, record.pose.position);
                }
            }
            if tick % config.send_interval_ticks.max(1) == 0 {
                let shared = encoder.encode_send(tick);
                for packet in encoder.client_datagrams(1, camera, &shared) {
                    let datagram = crate::wire::decode_chunks_datagram(&packet).expect("decode");
                    for mut record in datagram.records {
                        if record.mode.is_delta() {
                            record.position += baselines[&datagram.baseline_id];
                        }
                        received.push((datagram.sim_tick, record));
                    }
                }
            }
        }
        received
    }

    fn stream(
        config: EncoderConfig,
        ticks: std::ops::Range<u32>,
        motion: impl Fn(u32) -> BodySnapshotInput,
    ) -> Vec<(u32, crate::wire::DecodedBodyRecord)> {
        stream_to(config, ticks, close_camera(), motion)
    }

    /// A send that stands for two of the stream's sends (a limited link
    /// paced to 30 Hz) may use two per-send ceilings, and no more.
    #[test]
    fn a_paced_send_may_use_the_ceiling_of_the_sends_it_stands_for() {
        let manifest = manifest();
        let mut config = EncoderConfig::validated(60);
        // A ceiling one record fits in, and not two.
        config.client_ceiling_bytes = 40;
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        encoder.ingest_tick(10, &[snapshot(0.0)], &promotion_output(), &[]);
        let shared = encoder.encode_send(10);
        let _ = encoder.client_datagrams_within(1, close_camera(), &shared, Some(10_000), 1);
        assert_eq!(encoder.last_client_selection().allowance_bytes, 40);
        let _ = encoder.client_datagrams_within(1, close_camera(), &shared, Some(10_000), 2);
        assert_eq!(encoder.last_client_selection().allowance_bytes, 80);
        let _ = encoder.client_datagrams_within(1, close_camera(), &shared, Some(50), 2);
        assert_eq!(encoder.last_client_selection().allowance_bytes, 50, "the link allowance still binds");
    }

    /// The stream is sent every tick at a 60 Hz sim, and the per-send
    /// ceiling is halved with it, so the byte-rate cap is what it was at
    /// 30 Hz (10.4 kB per send).
    #[test]
    fn the_stream_is_sent_every_tick_under_the_same_byte_rate_cap() {
        let config = EncoderConfig::validated(60);
        assert_eq!(config.send_interval_ticks, 1);
        assert_eq!(config.client_ceiling_bytes * 60, 10_400 * 30);
        assert_eq!(config.innovation_window_ticks, 2);
        assert_eq!(EncoderConfig::validated(30).send_interval_ticks, 1);
        assert_eq!(EncoderConfig::validated(120).send_interval_ticks, 2);
    }

    /// Captures record their encoder's config. One made before the 60 Hz
    /// stream resumes at its own 30 Hz cadence and ceiling, with no
    /// innovation window, so its replay stays byte-exact.
    #[test]
    fn an_older_checkpoint_resumes_at_its_cadence_without_an_innovation_window() {
        let manifest = manifest();
        let mut config = EncoderConfig::validated(60);
        config.send_interval_ticks = 2;
        config.client_ceiling_bytes = 10_400;
        let encoder = ChunkStreamEncoder::new(&manifest, config);
        let mut json = serde_json::to_value(encoder.checkpoint()).expect("json");
        json["config"].as_object_mut().expect("config").remove("innovation_window_ticks");
        let checkpoint: EncoderCheckpoint = serde_json::from_value(json).expect("older checkpoint");
        let resumed = ChunkStreamEncoder::from_checkpoint(&manifest, checkpoint).expect("resume");
        assert_eq!(resumed.config().send_interval_ticks, 2);
        assert_eq!(resumed.config().client_ceiling_bytes, 10_400);
        assert_eq!(resumed.config().innovation_window_ticks, 0);
    }

    /// A body speeding up at 9 m/s^2 (debris sliding down a slope) changes
    /// velocity by 0.3 m/s per 30 Hz send, over the 0.25 m/s perturbation
    /// gate, so the 30 Hz stream refreshed it at every send. Judged per
    /// send at 60 Hz the change is 0.15 m/s and the body waits for its
    /// error or age gate instead: the window keeps the test the same
    /// acceleration, refreshed as often as before.
    #[test]
    fn an_accelerating_body_is_refreshed_as_often_at_60_hz_as_at_30() {
        let dt = 1.0 / 60.0;
        let accel = 9.0f32;
        let motion = |tick: u32| {
            let t = (tick - 10) as f32 * dt;
            body_at([1.0 + 0.5 * accel * t * t, 0.5, 0.0], [accel * t, 0.0, 0.0])
        };
        let far = Camera { eye: Vec3::new(0.0, 2.0, -40.0), direction: Vec3::Z, fov_degrees: 70.0 };
        let count = |config: EncoderConfig| stream_to(config, 10..70, far, motion).len();
        let mut at30 = EncoderConfig::validated(60);
        at30.send_interval_ticks = 2;
        let at60 = EncoderConfig::validated(60);
        let mut per_send = at60;
        per_send.innovation_window_ticks = 0;
        let (n30, n60, n60_per_send) = (count(at30), count(at60), count(per_send));
        assert!(n30 >= 25, "30 Hz refreshes it at every send: {n30} records in 60 ticks");
        assert!(n60.abs_diff(n30) <= 2, "60 Hz with the window: {n60} records, 30 Hz: {n30}");
        assert!(n60_per_send * 2 < n30, "judged per send at 60 Hz it is left to the other gates: {n60_per_send}");
    }

    /// At the window's own cadence the scale is exactly 1 and every record
    /// is at least a window old: a 30 Hz stream sends the same records as
    /// without it.
    #[test]
    fn at_30_hz_the_innovation_window_changes_no_record() {
        let dt = 1.0 / 60.0;
        let motion = |tick: u32| {
            let t = (tick - 10) as f32 * dt;
            let wobble = (t * 7.0).sin();
            body_at([1.0 + 0.5 * 9.0 * t * t, 0.5 + 0.1 * wobble, 0.0], [9.0 * t, 0.7 * (t * 7.0).cos(), 0.0])
        };
        let mut with = EncoderConfig::validated(60);
        with.send_interval_ticks = 2;
        with.client_ceiling_bytes = 10_400;
        let mut without = with;
        without.innovation_window_ticks = 0;
        let records = |config: EncoderConfig| {
            stream(config, 10..200, motion)
                .into_iter()
                .map(|(tick, r)| (tick, r.position.to_array(), r.linear_velocity.to_array()))
                .collect::<Vec<_>>()
        };
        let a = records(with);
        assert!(!a.is_empty());
        assert_eq!(a, records(without));
    }

    /// Debris sliding along the ground reports no contacts, so the
    /// classifier calls it ballistic; it must not go out as a ballistic
    /// record, which the client would pull down under gravity. A body that
    /// is really falling still must.
    #[test]
    fn only_a_body_in_measured_free_fall_is_sent_ballistic() {
        let dt = 1.0 / 60.0;
        let sliding = |tick: u32| body_at([1.0 + tick as f32 * dt * 2.0, 0.5, 0.0], [2.0, 0.0, 0.0]);
        let falling = |tick: u32| {
            let t = (tick - 10) as f32 * dt;
            body_at([1.0, 30.0 - 4.905 * t * t, 0.0], [0.0, -9.81 * t, 0.0])
        };
        let config = EncoderConfig::validated(60);
        let slid = stream(config, 10..70, sliding);
        assert!(!slid.is_empty());
        assert!(
            slid.iter().all(|(_, r)| r.mode != RecordMode::Ballistic),
            "a body moving level at constant speed is not in free fall"
        );
        let fell = stream(config, 10..70, falling);
        assert!(
            fell.iter().skip(2).all(|(_, r)| r.mode == RecordMode::Ballistic),
            "a falling body must keep the ballistic mode: {:?}",
            fell.iter().map(|(_, r)| r.mode).collect::<Vec<_>>()
        );

        // And off -- as every capture made before the flag existed -- the old
        // behaviour: no contacts means ballistic.
        let mut old = config;
        old.ballistic_requires_free_fall = false;
        let slid_old = stream(old, 10..70, sliding);
        assert!(slid_old.iter().skip(2).all(|(_, r)| r.mode == RecordMode::Ballistic));
    }

    /// The client extrapolates a record's velocity for a few ticks and then
    /// holds; a body that coasts to a stop after its last record is drawn
    /// past where it stopped. Judged against what the client draws, the
    /// encoder must leave it drawn where it stopped, with at most one record
    /// at rest.
    #[test]
    fn a_body_that_coasts_to_rest_is_left_drawn_where_it_stopped() {
        let dt = 1.0 / 60.0;
        // Friction: 3 m/s to rest at 6 m/s^2 (0.2 m/s per send), a change
        // under the 0.25 m/s innovation gate, as sliding debris does.
        let (v0, decel) = (3.0f32, 6.0f32);
        let stop_s = v0 / decel;
        let stop_x = 1.0 + v0 * stop_s - 0.5 * decel * stop_s * stop_s;
        let motion = |tick: u32| {
            let t = (tick - 10) as f32 * dt;
            if t < stop_s {
                body_at([1.0 + v0 * t - 0.5 * decel * t * t, 0.5, 0.0], [v0 - decel * t, 0.0, 0.0])
            } else {
                body_at([stop_x, 0.5, 0.0], [0.0, 0.0, 0.0])
            }
        };
        // Where the client ends up drawing the body: its newest record,
        // extrapolated through the window and held.
        let drawn_at_rest = |records: &[(u32, crate::wire::DecodedBodyRecord)]| {
            let (_, last) = records.last().expect("records");
            let window = CLIENT_MAX_EXTRAPOLATION_TICKS as f32 * dt;
            last.position.x + last.linear_velocity.x * window
        };
        let stop_tick = 10 + (stop_s / dt).ceil() as u32;
        let far = Camera { eye: Vec3::new(0.0, 2.0, -40.0), direction: Vec3::Z, fov_degrees: 70.0 };
        let run = |config: EncoderConfig| stream_to(config, 10..400, far, motion);

        // Without the client model: the encoder compares truth with the pose
        // it sent, finds the stopped body within the rest epsilon of it, and
        // leaves the client drawing it where it extrapolated to.
        let mut old = EncoderConfig::validated(60);
        old.model_client_extrapolation = false;
        let unfixed = run(old);
        let unfixed_error = (drawn_at_rest(&unfixed) - stop_x).abs();
        assert!(unfixed_error > REST_CORRECTION_M, "scenario must leave the old client off: {unfixed_error}");

        let fixed = run(EncoderConfig::validated(60));
        let fixed_error = (drawn_at_rest(&fixed) - stop_x).abs();
        assert!(fixed_error <= REST_POSE_EPSILON_M, "drawn {fixed_error} m from rest");
        let at_rest = fixed.iter().filter(|(tick, r)| *tick >= stop_tick && r.linear_velocity.length() < 0.01).count();
        assert!(at_rest <= 1, "at most one correction at rest, then silence");
        assert!(fixed.len() <= unfixed.len(), "modelling the client must not cost records here");
    }

    /// A body lying on the ground whose last record was ballistic -- the old
    /// classification -- is drawn sinking under gravity for the whole
    /// extrapolation window and then held there: 0.5 g t^2, 0.18 m at the
    /// 20 m/s^2 the client used to extrapolate with, the resting-debris error
    /// measured in Netlab. The client model must correct it once at rest.
    #[test]
    fn a_resting_body_drawn_sunk_is_corrected_once() {
        let dt = 1.0 / 60.0;
        let motion = |tick: u32| {
            if tick < 30 {
                body_at([1.0 + (tick - 10) as f32 * dt, 0.5, 0.0], [1.0, 0.0, 0.0])
            } else {
                // Stopped: a quarter-second of friction the gates cannot see.
                let t = ((tick - 30) as f32 * dt).min(0.25);
                body_at([1.0 + 20.0 * dt + t - 2.0 * t * t, 0.5, 0.0], [(1.0 - 4.0 * t).max(0.0), 0.0, 0.0])
            }
        };
        let mut sunk = EncoderConfig::validated(60);
        sunk.ballistic_requires_free_fall = false;
        let mut uncorrected = sunk;
        uncorrected.model_client_extrapolation = false;
        let rest_y = 0.5;
        let final_drawn_y = |records: &[(u32, crate::wire::DecodedBodyRecord)]| {
            let (_, last) = records.last().expect("records");
            let window = CLIENT_MAX_EXTRAPOLATION_TICKS as f32 * dt;
            let gravity = if last.mode == RecordMode::Ballistic { 0.5 * CLIENT_EXTRAPOLATION_GRAVITY_Y * window * window } else { 0.0 };
            last.position.y + last.linear_velocity.y * window + gravity
        };
        let old = stream(uncorrected, 10..300, motion);
        // (The first record precedes the classifier's two-tick ballistic hold.)
        assert!(old.iter().skip(1).all(|(_, r)| r.mode == RecordMode::Ballistic));
        let window = CLIENT_MAX_EXTRAPOLATION_TICKS as f32 * dt;
        let sink = 0.5 * CLIENT_EXTRAPOLATION_GRAVITY_Y.abs() * window * window;
        assert!((final_drawn_y(&old) - rest_y).abs() > 0.9 * sink, "the old encoder leaves it sunk");

        let fixed = stream(sunk, 10..300, motion);
        assert!((final_drawn_y(&fixed) - rest_y).abs() <= REST_POSE_EPSILON_M, "corrected to where it rests");
        let corrections = fixed.iter().skip(1).filter(|(_, r)| r.mode != RecordMode::Ballistic).count();
        assert_eq!(corrections, 1, "one correction, then silence");
    }

    /// A new baseline travels on the reliable stream, behind the datagrams
    /// that would reference it; for the lag after it is emitted, deltas must
    /// stay on the generation before it, which the client already holds.
    /// Every delta must decode against a generation the client has.
    #[test]
    fn deltas_keep_the_previous_baseline_until_the_new_one_can_have_arrived() {
        let lag = 30;
        let mut config = EncoderConfig::validated(60);
        config.baseline_interval_ticks = 60;
        config.baseline_reference_lag_ticks = lag;
        config.ballistic_requires_free_fall = true;
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        let dt = 1.0 / 60.0;
        let sliding = |tick: u32| body_at([1.0 + tick as f32 * dt * 2.0, 0.5, 0.0], [2.0, 0.0, 0.0]);
        let mut emitted: Vec<(u32, u16)> = Vec::new();
        let mut referenced: Vec<(u32, u16)> = Vec::new();
        for tick in 10..200u32 {
            let output = if tick == 10 { promotion_output() } else { DestructionTickOutput::default() };
            encoder.ingest_tick(tick, &[sliding(tick)], &output, &[]);
            let _ = encoder.take_topology_messages();
            for part in encoder.maybe_emit_baseline(tick).into_iter().flatten() {
                emitted.push((tick, crate::wire::decode_baseline(&part).expect("baseline").baseline_id));
            }
            if tick % 2 == 0 {
                let shared = encoder.encode_send(tick);
                for packet in encoder.client_datagrams(1, close_camera(), &shared) {
                    let datagram = crate::wire::decode_chunks_datagram(&packet).expect("decode");
                    if datagram.records.iter().any(|r| r.mode.is_delta()) {
                        referenced.push((tick, datagram.baseline_id));
                    }
                }
            }
        }
        assert!(emitted.len() >= 3 && !referenced.is_empty());
        for (tick, id) in referenced {
            let (emitted_at, _) = emitted.iter().find(|(_, e)| *e == id).expect("a generation that was sent");
            assert!(
                tick >= emitted_at + lag,
                "tick {tick} referenced generation {id} only {} ticks after it was emitted",
                tick - emitted_at
            );
            let newer = emitted.iter().filter(|(at, e)| *e != id && *at > *emitted_at && *at + lag <= tick).count();
            assert_eq!(newer, 0, "tick {tick} kept generation {id} past its successor's lag");
        }
    }

    /// Quiescent rubble is left out of baselines, and a body that is not in
    /// the baseline is never sent as a delta against it.
    #[test]
    fn baselines_leave_out_quiescent_bodies_and_deltas_follow_the_baseline() {
        let dt = 1.0 / 60.0;
        // Moves, then lies still long past the classifier's 20-tick hold.
        let motion = |tick: u32| {
            if tick < 40 {
                body_at([1.0 + (tick - 10) as f32 * dt, 0.5, 0.0], [1.0, 0.0, 0.0])
            } else {
                body_at([1.5, 0.5, 0.0], [0.0, 0.0, 0.0])
            }
        };
        for skips in [false, true] {
            let mut config = EncoderConfig::validated(60);
            config.baseline_skips_quiescent = skips;
            config.baseline_reference_lag_ticks = 0;
            let manifest = manifest();
            let mut encoder = ChunkStreamEncoder::new(&manifest, config);
            encoder.add_client(1);
            let mut last_baseline_records = None;
            for tick in 10..400u32 {
                let output = if tick == 10 { promotion_output() } else { DestructionTickOutput::default() };
                encoder.ingest_tick(tick, &[motion(tick)], &output, &[]);
                let _ = encoder.take_topology_messages();
                if let Some(parts) = encoder.maybe_emit_baseline(tick) {
                    let records: usize = parts
                        .iter()
                        .map(|part| crate::wire::decode_baseline(part).expect("baseline").records.len())
                        .sum();
                    last_baseline_records = Some(records);
                }
                if tick % 2 == 0 {
                    let shared = encoder.encode_send(tick);
                    for record in &shared.records {
                        if record.record.mode.is_delta() {
                            assert!(
                                encoder.baseline_poses.contains_key(&record.record.body_entity),
                                "a delta against a pose the baseline never carried"
                            );
                        }
                    }
                }
            }
            assert_eq!(last_baseline_records, Some(if skips { 0 } else { 1 }));
        }
    }

    /// However it is configured, the lag never outlives the generation it
    /// points at: the client drops a generation once the next one arrives.
    #[test]
    fn the_baseline_lag_is_clamped_below_the_interval() {
        let mut config = EncoderConfig::validated(60);
        config.baseline_interval_ticks = 20;
        config.baseline_reference_lag_ticks = 500;
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        let dt = 1.0 / 60.0;
        let mut current = 0u16;
        for tick in 10..200u32 {
            let output = if tick == 10 { promotion_output() } else { DestructionTickOutput::default() };
            encoder.ingest_tick(tick, &[body_at([1.0 + tick as f32 * dt, 0.5, 0.0], [1.0, 0.0, 0.0])], &output, &[]);
            let _ = encoder.take_topology_messages();
            if let Some(parts) = encoder.maybe_emit_baseline(tick) {
                current = crate::wire::decode_baseline(&parts[0]).expect("baseline").baseline_id;
            }
            let shared = encoder.encode_send(tick);
            assert!(
                shared.baseline_id == current || shared.baseline_id == current.wrapping_sub(1),
                "tick {tick}: referenced {} with {current} current -- a generation the client dropped",
                shared.baseline_id
            );
        }
    }

    /// The client model mirrors two constants of the client's presentation
    /// config; if either side changes alone the encoder judges the client
    /// against a pose it does not draw.
    #[test]
    fn the_client_model_matches_the_client_presentation_config() {
        let client = include_str!("../../client/src/city/presentation.ts");
        let config = &client[client.find("export function presentationConfig60Hz").expect("config fn")..];
        let config = &config[..config.find("\n}").expect("fn end")];
        assert!(
            config.contains(&format!("maxExtrapolationTicks: {CLIENT_MAX_EXTRAPOLATION_TICKS},")),
            "presentationConfig60Hz maxExtrapolationTicks != CLIENT_MAX_EXTRAPOLATION_TICKS"
        );
        assert!(
            config.contains(&format!("gravity: [0, {CLIENT_EXTRAPOLATION_GRAVITY_Y}, 0],")),
            "presentationConfig60Hz gravity != CLIENT_EXTRAPOLATION_GRAVITY_Y"
        );
    }

    /// A client that joins (or is re-bootstrapped) mid-stream holds no
    /// baseline until the next generation; with the reference lag that is
    /// up to an interval plus the lag away. It must get absolute records
    /// until the encoder references a generation it can hold -- and deltas
    /// again after that. Other clients are unaffected.
    #[test]
    fn a_client_bootstrapped_mid_stream_gets_absolutes_until_it_can_hold_a_baseline() {
        let config = EncoderConfig::validated(60);
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        let dt = 1.0 / 60.0;
        let sliding = |tick: u32| body_at([1.0 + tick as f32 * dt, 0.5, 0.0], [1.0, 0.0, 0.0]);
        let join_tick = 300u32;
        let mut first_held: Option<u16> = None;
        let (mut late_deltas_before, mut late_deltas_after, mut early_deltas) = (0, 0, 0);
        for tick in 10..900u32 {
            let output = if tick == 10 { promotion_output() } else { DestructionTickOutput::default() };
            encoder.ingest_tick(tick, &[sliding(tick)], &output, &[]);
            let _ = encoder.take_topology_messages();
            for part in encoder.maybe_emit_baseline(tick).into_iter().flatten() {
                let id = crate::wire::decode_baseline(&part).expect("baseline").baseline_id;
                if tick > join_tick && first_held.is_none() {
                    first_held = Some(id);
                }
            }
            if tick == join_tick {
                encoder.add_client(2);
            }
            if tick % 2 == 0 {
                let shared = encoder.encode_send(tick);
                for client in [1u64, 2] {
                    if client == 2 && tick < join_tick {
                        continue;
                    }
                    for packet in encoder.client_datagrams(client, close_camera(), &shared) {
                        let datagram = crate::wire::decode_chunks_datagram(&packet).expect("decode");
                        let deltas = datagram.records.iter().filter(|r| r.mode.is_delta()).count();
                        if client == 1 {
                            early_deltas += deltas;
                        } else if first_held.is_some_and(|held| datagram.baseline_id >= held) {
                            late_deltas_after += deltas;
                        } else {
                            late_deltas_before += deltas;
                        }
                    }
                }
            }
        }
        assert!(early_deltas > 0, "the established client keeps its deltas");
        assert_eq!(late_deltas_before, 0, "a delta the joining client could not resolve");
        assert!(late_deltas_after > 0, "the joining client must get deltas once it holds a baseline");
    }

    /// The model is the client's `PresentationTrack.extrapolate`: velocity
    /// (and gravity, ballistic) for at most the extrapolation window.
    #[test]
    fn the_client_model_extrapolates_like_the_client_and_then_holds() {
        let pose = Pose { position: Vec3::new(0.0, 10.0, 0.0), rotation: glam::Quat::IDENTITY };
        let mut state = ClientBodyState {
            last_sent: Some((100, pose)),
            last_motion: Some(SentMotion { linear: Vec3::new(3.0, 0.0, 0.0), angular: Vec3::ZERO, ballistic: true }),
            ..Default::default()
        };
        let window = CLIENT_MAX_EXTRAPOLATION_TICKS as f32 / 60.0;
        let held = state.presented_at(100 + CLIENT_MAX_EXTRAPOLATION_TICKS, 60).expect("sent");
        assert!((held.position.x - 3.0 * window).abs() < 1e-5);
        assert!((held.position.y - (10.0 + 0.5 * CLIENT_EXTRAPOLATION_GRAVITY_Y * window * window)).abs() < 1e-5);
        assert_eq!(state.presented_at(100 + 500, 60), Some(held), "past the window the client holds");
        assert_eq!(state.presented_at(100, 60).map(|p| p.position), Some(pose.position));
        state.last_motion = None;
        assert_eq!(state.presented_at(100 + 500, 60), Some(pose), "no velocities: no extrapolation");
    }

    /// Captures made before these flags existed resume with them off --
    /// what their encoders did -- so a replay stays byte-exact; a new server
    /// has them on.
    #[test]
    fn older_checkpoints_read_the_new_flags_as_off() {
        let config = EncoderConfig::validated(60);
        assert!(config.model_client_extrapolation && config.ballistic_requires_free_fall);
        let mut json = serde_json::to_value(config).expect("serialise");
        let object = json.as_object_mut().expect("object");
        object.remove("model_client_extrapolation");
        object.remove("ballistic_requires_free_fall");
        object.remove("world_gravity_y");
        object.remove("rest_eval_stride");
        object.remove("baseline_reference_lag_ticks");
        object.remove("baseline_skips_quiescent");
        let old: EncoderConfig = serde_json::from_value(json).expect("deserialise");
        assert!(!old.model_client_extrapolation && !old.ballistic_requires_free_fall);
        assert_eq!(old.world_gravity_y, -9.81);
        assert_eq!(old.rest_eval_stride, REST_EVAL_STRIDE);
        assert_eq!(old.baseline_reference_lag_ticks, 0);
        assert!(!old.baseline_skips_quiescent);
    }

    /// Banking must be able to spend more than one ceiling in a burst -- that
    /// is the entire point -- and must still be bounded.
    #[test]
    fn the_burst_bucket_spends_more_than_one_ceiling_but_not_without_limit() {
        let steady = 10_000usize;
        let capacity_sends = 30u32;
        let max_multiple = 4u32;
        let capacity = steady * capacity_sends as usize;

        // A client that has banked a full second, asked for far more than it
        // could ever send, is capped at the multiple rather than the bank.
        let mut tokens = capacity;
        tokens = tokens.saturating_add(steady).min(capacity);
        let allowance = tokens.min(steady * max_multiple as usize);
        assert_eq!(allowance, steady * 4, "one send must not empty the bank");

        // Spending drains it, and a run of maximal sends exhausts the bank
        // down to the steady rate rather than bursting for ever.
        let mut tokens = capacity;
        let mut allowances = Vec::new();
        for _ in 0..40 {
            tokens = tokens.saturating_add(steady).min(capacity);
            let allowance = tokens.min(steady * max_multiple as usize);
            tokens -= allowance;
            allowances.push(allowance);
        }
        assert_eq!(allowances[0], steady * 4);
        assert_eq!(
            *allowances.last().expect("non-empty"),
            steady,
            "a sustained burst must settle back to the steady ceiling"
        );
        assert!(
            allowances.windows(2).all(|pair| pair[0] >= pair[1]),
            "the allowance must decay monotonically under sustained demand"
        );
    }

    /// Streams `motion` to one client whose link RTT is `rtt_ms` (None: the
    /// encoder never hears it); returns (tick, record) and every records
    /// datagram's horizon trailer.
    fn stream_predictive(
        config: EncoderConfig,
        ticks: std::ops::Range<u32>,
        camera: Camera,
        rtt_ms: Option<f32>,
        motion: impl Fn(u32) -> BodySnapshotInput,
    ) -> (Vec<(u32, crate::wire::DecodedBodyRecord)>, Vec<Option<f32>>) {
        let manifest = manifest();
        let mut encoder = ChunkStreamEncoder::new(&manifest, config);
        encoder.add_client(1);
        let mut received = Vec::new();
        let mut horizons = Vec::new();
        for tick in ticks.clone() {
            let output = if tick == ticks.start { promotion_output() } else { DestructionTickOutput::default() };
            encoder.ingest_tick(tick, &[motion(tick)], &output, &[]);
            let _ = encoder.take_topology_messages();
            let _ = encoder.maybe_emit_baseline(tick);
            if tick % config.send_interval_ticks.max(1) == 0 {
                if let Some(rtt) = rtt_ms {
                    encoder.note_link_rtt(1, rtt);
                }
                let shared = encoder.encode_send(tick);
                for packet in encoder.client_datagrams(1, camera, &shared) {
                    let datagram = crate::wire::decode_chunks_datagram(&packet).expect("decode");
                    if !datagram.records.is_empty() {
                        horizons.push(datagram.horizon_ticks);
                    }
                    for record in datagram.records {
                        received.push((datagram.sim_tick, record));
                    }
                }
            }
        }
        (received, horizons)
    }

    /// The predictive model is opt-in, and a capture made before it existed
    /// resumes with it off.
    #[test]
    fn the_predictive_client_model_is_off_by_default_and_in_older_checkpoints() {
        let config = EncoderConfig::validated(60);
        assert!(!config.predictive_client && !config.ballistic_innovation_net_of_gravity);
        let mut object = serde_json::to_value(config).expect("serialize");
        let object_map = object.as_object_mut().expect("object");
        for field in [
            "predictive_client",
            "predictive_backoff_ticks",
            "predictive_backoff_sends",
            "predictive_contact_share",
            "predictive_horizon_error",
            "predictive_max_overshoot_m",
            "predictive_latency_share",
            "ballistic_innovation_net_of_gravity",
        ] {
            assert!(object_map.remove(field).is_some(), "{field}");
        }
        let old: EncoderConfig = serde_json::from_value(object).expect("deserialize");
        assert!(!old.predictive_client && !old.predictive_horizon_error);
        assert_eq!((old.predictive_backoff_ticks, old.predictive_backoff_sends), (0.0, 0.0));
        assert_eq!(old.predictive_latency_share, 1.0);
    }

    /// A predictive encoder tells the client its horizon -- half the link's
    /// RTT in ticks, less the back-off -- on every records datagram; the
    /// default encoder sends no such trailer.
    #[test]
    fn a_predictive_encoder_sends_the_horizon_and_the_default_does_not() {
        let dt = 1.0 / 60.0;
        // In view of the close camera for the whole half second.
        let falling = |tick: u32| {
            let t = (tick - 10) as f32 * dt;
            body_at([1.0, 4.0 - 4.905 * t * t, 0.0], [0.0, -9.81 * t, 0.0])
        };
        let config = EncoderConfig::validated(60);
        let (records, horizons) = stream_predictive(config, 10..40, close_camera(), Some(180.0), falling);
        assert!(!records.is_empty());
        assert!(horizons.iter().all(Option::is_none));

        let mut predictive = config;
        predictive.predictive_client = true;
        let (_, horizons) = stream_predictive(predictive, 10..40, close_camera(), Some(180.0), falling);
        assert!(!horizons.is_empty());
        // 90 ms one way is 5.4 ticks.
        assert!(horizons.iter().all(|h| h.is_some_and(|h| (h - 5.4).abs() < 0.01)), "{horizons:?}");
        // "Now minus one send": one tick less at 60 Hz.
        predictive.predictive_backoff_sends = 1.0;
        let (_, horizons) = stream_predictive(predictive, 10..40, close_camera(), Some(180.0), falling);
        assert!(horizons.iter().all(|h| h.is_some_and(|h| (h - 4.4).abs() < 0.01)), "{horizons:?}");
        // Before any RTT is known the horizon is the back-off alone.
        let (_, horizons) = stream_predictive(predictive, 10..40, close_camera(), None, falling);
        assert!(horizons.iter().all(|h| h.is_some_and(|h| (h + 1.0).abs() < 0.01)), "{horizons:?}");
    }

    /// Judged at the horizon, a body whose velocity is drifting off its last
    /// record is refreshed before the drift shows at the present: a sliding
    /// body slowing at 6 m/s^2 (0.2 m/s per window, under the innovation
    /// gate) gets more records, and its first refresh sooner, when the client
    /// draws 10 ticks ahead of the data.
    #[test]
    fn the_horizon_error_refreshes_a_drifting_body_sooner() {
        let dt = 1.0 / 60.0;
        let (v0, decel) = (4.0f32, 6.0f32);
        let sliding = |tick: u32| {
            let t = ((tick - 10) as f32 * dt).min(v0 / decel);
            body_at([1.0 + v0 * t - 0.5 * decel * t * t, 0.5, 0.0], [v0 - decel * t, 0.0, 0.0])
        };
        let far = Camera { eye: Vec3::new(0.0, 2.0, -40.0), direction: Vec3::Z, fov_degrees: 70.0 };
        let mut predictive = EncoderConfig::validated(60);
        predictive.predictive_client = true;
        predictive.predictive_horizon_error = true;
        let moving = |records: &[(u32, crate::wire::DecodedBodyRecord)]| {
            records.iter().filter(|(tick, _)| *tick < 10 + (v0 / decel / dt) as u32).count()
        };
        let second = |records: &[(u32, crate::wire::DecodedBodyRecord)]| records.get(1).map(|(tick, _)| *tick);
        // 333 ms RTT: a 10-tick horizon.
        let (ahead, _) = stream_predictive(predictive, 10..120, far, Some(333.4), sliding);
        let mut no_horizon = predictive;
        no_horizon.predictive_horizon_error = false;
        let (present, _) = stream_predictive(no_horizon, 10..120, far, Some(333.4), sliding);
        assert!(moving(&ahead) > moving(&present), "{} vs {}", moving(&ahead), moving(&present));
        assert!(second(&ahead) < second(&present), "{:?} vs {:?}", second(&ahead), second(&present));
    }

    /// The predictive client extrapolates a record as far past its tick as
    /// its lead adds to the usual clamp, and a ballistic one no lower than
    /// the floor; the classic model is unchanged.
    #[test]
    fn the_predictive_model_extends_the_clamp_and_stops_at_the_floor() {
        let state = ClientBodyState {
            last_sent: Some((100, Pose { position: Vec3::new(0.0, 1.0, 0.0), rotation: glam::Quat::IDENTITY })),
            last_motion: Some(SentMotion { linear: Vec3::new(3.0, -10.0, 0.0), angular: Vec3::ZERO, ballistic: true }),
            ..ClientBodyState::default()
        };
        let lead = Lead { ballistic: 10.0, contact_share: 0.0, playout: 5.0, max_overshoot_m: 0.0, tick_s: 1.0 / 60.0 };
        let classic = state.presented_at(140, 60).expect("pose");
        // Held at the 8-tick clamp, below the ground: the classic client draws that.
        let t = CLIENT_MAX_EXTRAPOLATION_TICKS as f32 / 60.0;
        assert!((classic.position.x - 3.0 * t).abs() < 1e-5);
        assert!((classic.position.y - (1.0 - 10.0 * t + 0.5 * CLIENT_EXTRAPOLATION_GRAVITY_Y * t * t)).abs() < 1e-5);
        let ahead = state.presented_at_ahead(140.0, 60, Some(lead)).expect("pose");
        assert!((ahead.position.x - 3.0 * 18.0 / 60.0).abs() < 1e-5, "8 + 10 ticks: {ahead:?}");
        assert_eq!(ahead.position.y, CLIENT_PREDICTIVE_FLOOR_Y);
        // A record in contact gets the contact share of the lead (none here).
        let contact = ClientBodyState {
            last_motion: Some(SentMotion { linear: Vec3::new(3.0, 0.0, 0.0), angular: Vec3::ZERO, ballistic: false }),
            ..state.clone()
        };
        let held = contact.presented_at_ahead(140.0, 60, Some(lead)).expect("pose");
        assert!((held.position.x - 3.0 * t).abs() < 1e-5);
    }

}
