//! The per-player destruction stream (city wire 4): the destruction netcode
//! spec's Part A, as a `ReplicationStrategy` beside the shared-world stream.
//!
//! - **Structure.** Each fracture goes out once, reliably, as its outcome:
//!   the bonds that broke and the chunks the physics removed
//!   (`perplayer::structure`). Every end derives the bodies from that, named
//!   by their lowest chunk; the server checks its derivation against the
//!   physics' islands as it goes (`stats.derive_mismatches`).
//! - **Motion.** For each client, the server keeps that client's own drawing
//!   of every body: `perplayer::client::BodyTrack`, the client's code, over
//!   the keyframes the client is believed to have. A body costs bytes only
//!   when that drawing would visibly drift from the truth. It is judged in
//!   the client's camera, a short horizon ahead (a contact shows up at once as
//!   a velocity the drawing does not have), and ranked by the perceptual
//!   penalty it removes per byte (`perception::PerceptualModel`, the same
//!   model the lab scores with).
//! - **Loss.** Keyframes are presumed received until the client's acks say a
//!   datagram was lost. Then they leave the server's model of that client,
//!   and the error that reappears gets the body resent.
//! - **Precision.** Each keyframe is quantised at the coarsest grid whose
//!   step stays under half the tolerance in that client's view.
//! - **No view culling.** A body behind the camera still counts at half
//!   weight (a 180 degree flick takes under 100 ms).
//!
//! Not yet: datagram copies of the events (D6), delta coding against acked
//! baselines, group keyframes, occlusion.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use rustc_hash::{FxHashMap, FxHashSet};

use glam::{Quat, Vec3};

use vibe_land_perplayer::client::{apply_spawns, BodyTrack, BASELINE_MAX_TICKS};
use vibe_land_perplayer::predict::{Keyframe, Mode, Physics};
use vibe_land_perplayer::structure::{StructureDef, StructureState, ANCHORED, REMOVED};
use vibe_land_perplayer::wire::{
    encode_bootstrap, encode_events, encode_prepared, quantised, BodyKey, Bootstrap, BootstrapStructure, Event,
    KeyframeRecord, PreparedRecord, POSITION_STEPS,
};
use vibe_netcode::destruction_backend::{DestructionTickOutput, FractureBatch};

use crate::encoder::BodySnapshotInput;
use crate::ids;
use crate::manifest::DestructionManifest;
use crate::perception::{ArtifactClass, PerceptualModel};
use crate::replication::{ClientFeedback, ClientSend, ClientView, Outgoing, ReplicationStrategy, SendBudget, SendRequest};
use crate::topology::CityLedger;

/// Ticks of truth a keyframe's mode is backtested over (100 ms).
const BACKTEST_TICKS: u32 = 6;

/// The shared derivation's view of a manifest.
pub fn structure_defs(manifest: &DestructionManifest) -> Vec<StructureDef> {
    manifest
        .structures
        .iter()
        .map(|s| {
            let n = s.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0) as usize;
            let (mut rest, mut mass_center, mut mass, mut support) =
                (vec![Vec3::ZERO; n], vec![Vec3::ZERO; n], vec![0.0; n], vec![false; n]);
            for c in &s.chunks {
                let i = c.node_index as usize;
                rest[i] = Vec3::from_array(c.centroid);
                mass_center[i] = Vec3::from_array(c.mass_center());
                mass[i] = c.mass;
                support[i] = c.support;
            }
            let mut bonds = vec![(0u32, 0u32); s.bonds.iter().map(|b| b.bond_index + 1).max().unwrap_or(0) as usize];
            for b in &s.bonds {
                bonds[b.bond_index as usize] = (b.node0, b.node1);
            }
            let mut half = vec![Vec3::ZERO; n];
            for c in &s.chunks {
                half[c.node_index as usize] = Vec3::from_array(c.size) * 0.5;
            }
            StructureDef::new(
                s.structure_id,
                Vec3::from_array(s.world_position),
                Quat::from_array(s.world_rotation).normalize(),
                rest,
                mass_center,
                mass,
                support,
                bonds,
            )
            .with_half_extents(half)
        })
        .collect()
}

/// Per-player body ids in the city's body-entity space: the serial field
/// carries bit 19 plus the lowest chunk, so they never collide with the
/// physics' serials (small counters) and a scorer can tell them apart.
pub const PER_PLAYER_SERIAL_BIT: u32 = 1 << 19;

pub fn body_entity(key: BodyKey) -> u32 {
    if key.body == ANCHORED {
        ids::body_entity(key.structure, 0)
    } else {
        ids::body_entity(key.structure, PER_PLAYER_SERIAL_BIT | key.body)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PerPlayerConfig {
    pub sim_hz: u32,
    pub send_interval_ticks: u32,
    /// The most record bytes one send may carry, as wire v2's ceiling.
    pub ceiling_bytes: usize,
    /// The drawn error, in the client's pixels, worth a keyframe.
    pub tolerance_px: f32,
    pub pane: (u32, u32),
    /// How far ahead the drawing's error is judged (contacts show at once).
    pub horizon_ticks: f32,
    /// The client's playout delay (`perplayer::client::RenderClock`).
    pub delay_ticks: f32,
    pub hash_interval_ticks: u32,
    /// An empty keyframe packet at least this often, for the clock and acks.
    pub heartbeat_sends: u32,
    pub max_datagram: usize,
    pub gravity_y: f32,
    /// Choose each keyframe's mode by backtest (false: free fall by
    /// acceleration, else sliding).
    pub backtest_modes: bool,
    /// Copies of every events packet sent ahead on the datagram lane (the
    /// reliable stream carries it too): HOL blocking on a lossy link delays
    /// a fracture past the playout delay otherwise (gate G2). 0 disables.
    pub event_copies: u32,
    /// Worker threads for one send's clients (`client_sends`); 1 runs them
    /// in turn. Each client's selection is independent, so the result is
    /// the same either way.
    pub send_threads: u32,
    /// Rank a contact the client has not been sent by its timing penalty
    /// (V6), beside the screen error. Off by default: measured 1-7% lower
    /// penalty on six runs, but it does not fix the cause (the drawing
    /// smooths a sub-pixel change of direction; docs/netcode-shared-vs-per-player.md).
    pub contacts: bool,
    /// Rank a record by the pop its correction will make (V2) as well as
    /// the screen error it removes.
    pub correction_cost: bool,
    /// Rank a body drawn moving wrongly by the pop its motion makes (V2):
    /// each frame its drawn step differs from the truth's by more than the
    /// tolerance, the scorer counts a pop, and waiting one more send keeps
    /// that up for a send interval. Screen error saturates; this does not.
    pub motion_cost: bool,
    /// Judge a body's error where the client draws it as well as where it
    /// is: in view if either pose is, scaled at the nearer (the scorer
    /// projects both). Off: by the truth's pose alone.
    pub drawn_view: bool,
    /// Priority accumulator (Fiedler, "State Synchronization", 2015;
    /// Frohnmayer & Gift, the Tribes network model, 2000; age-weighted
    /// scheduling, Kadota et al., IEEE/ACM ToN 2018): a body's gain is the
    /// penalty its error has been costing per second (V1 once per body per
    /// second, V2 every frame its drawn motion is wrong) times how long it
    /// has been over tolerance, plus the correction's pop. Off: one send's
    /// worth of saturated penalty, under which a body left wrong never
    /// outranks fresh errors.
    pub age_priority: bool,
    /// Gates before penalties, as the scorecard orders them: a body drawn
    /// sunk into the ground deeper than the truth has it (gate G4's own
    /// test: each chunk's inscribed sphere, `G4_TOLERANCE_M`) is sent
    /// before any perceptual priority.
    pub ground_gate: bool,
    /// `ground_gate` against standing structures too: each chunk's sphere
    /// against the standing chunk boxes near it (G4's own test and grid).
    pub solid_gate: bool,
    /// At most about this many bodies evaluated per client per send (0: no
    /// cap). Past it, a rotating slice plus the bodies that cannot wait.
    pub eval_cap: usize,
    /// Evaluations per send across every client (0: none): each client's
    /// cap is the smaller of `eval_cap` and this shared among the clients,
    /// so the server's work per send stops growing with players.
    pub eval_budget: usize,
}

impl PerPlayerConfig {
    /// Set one knob by name (the lab's `--knob pp.<name>=<value>`, the live
    /// server's `VIBE_CITY_PP_KNOBS`). Err names what was wrong.
    pub fn apply_knob(&mut self, name: &str, value: &str) -> Result<(), String> {
        let f: f64 = value.trim().parse().map_err(|_| format!("{name}={value}: not a number"))?;
        let on = f != 0.0;
        match name.trim().trim_start_matches("pp.") {
            "tolerance_px" => self.tolerance_px = f as f32,
            "horizon_ticks" => self.horizon_ticks = f as f32,
            "delay_ticks" => self.delay_ticks = f as f32,
            "ceiling_bytes" => self.ceiling_bytes = f as usize,
            "send_hz" => self.send_interval_ticks = (self.sim_hz as f64 / f).round().max(1.0) as u32,
            "heartbeat_sends" => self.heartbeat_sends = f as u32,
            "backtest" => self.backtest_modes = on,
            "event_copies" => self.event_copies = f as u32,
            "send_threads" => self.send_threads = f as u32,
            "contacts" => self.contacts = on,
            "correction_cost" => self.correction_cost = on,
            "motion_cost" => self.motion_cost = on,
            "drawn_view" => self.drawn_view = on,
            "age_priority" => self.age_priority = on,
            "ground_gate" => self.ground_gate = on,
            "solid_gate" => self.solid_gate = on,
            "eval_cap" => self.eval_cap = f as usize,
            "eval_budget" => self.eval_budget = f as usize,
            other => return Err(format!("unknown per-player knob {other}")),
        }
        Ok(())
    }

    /// Knobs from a comma-separated `name=value` list.
    pub fn apply_knobs(&mut self, list: &str) -> Result<(), String> {
        for item in list.split(',').map(str::trim).filter(|i| !i.is_empty()) {
            let (name, value) = item.split_once('=').ok_or_else(|| format!("{item}: expected name=value"))?;
            self.apply_knob(name, value)?;
        }
        Ok(())
    }

    pub fn validated(sim_hz: u32) -> Self {
        Self {
            sim_hz,
            send_interval_ticks: (sim_hz / 60).max(1),
            ceiling_bytes: 5_200,
            tolerance_px: 1.0,
            pane: (1920, 1080),
            horizon_ticks: 6.0,
            delay_ticks: 5.0,
            hash_interval_ticks: 120,
            heartbeat_sends: 6,
            max_datagram: 1_150,
            gravity_y: -(vibe_netcode::movement::GRAVITY as f32),
            backtest_modes: true,
            event_copies: 2,
            send_threads: 1,
            contacts: false,
            correction_cost: true,
            motion_cost: false,
            // On by the scorecard (docs/netcode-shared-vs-per-player.md,
            // "The turning-camera corner"): gates first, then penalty.
            drawn_view: true,
            age_priority: true,
            ground_gate: false,
            solid_gate: true,
            eval_cap: 4096,
            eval_budget: 65_536,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Truth {
    keyframe: Keyframe,
    radius: f32,
    settled: bool,
    /// The newest tick the truth had a contact (0: none): a velocity
    /// change more than `CONTACT_DV` from gravity's, the scorer's own
    /// definition (V6).
    contact_tick: u32,
    /// The fracture that made this version of a body whose id outlived it
    /// (0: none to name; a new id needs none).
    born: u32,
    /// This send's `TruthAhead` (`begin_send`; None for a settled body, or
    /// before the first send).
    ahead: Option<TruthAhead>,
}

/// How long a body's records name the fracture that made it (ticks): long
/// enough for its event to arrive through loss.
const INCARNATION_WINDOW: u32 = 240;

/// The smallest a keyframe record can be on the wire (a resting delta):
/// bounds how many never-sent bodies one send could carry.
const MIN_RECORD_BYTES: usize = 8;

/// Bytes of a keyframes datagram before its records (kind, tick, ordinal,
/// count).
const DATAGRAM_HEADER: usize = 13;

/// A contact, as the perceptual scorer finds one: a frame-to-frame velocity
/// change this far from gravity's (m/s).
const CONTACT_DV: f32 = 1.0;

/// Frames drawn per second, as the perceptual scorer samples them (the
/// lab's 60 Hz frame clock): how many pops a send interval holds.
const FRAMES_PER_SECOND: f32 = 60.0;

#[derive(Default)]
struct ClientState {
    ordinal: u32,
    believed: FxHashMap<BodyKey, BodyTrack>,
    /// Ordinal -> the keyframes it carried (as decoded) and how many acks
    /// have not named it, until acked or known lost.
    sent: VecDeque<(u32, Vec<(BodyKey, Keyframe)>, u8)>,
    /// Per body, the newest keyframe this client acked: the baseline delta
    /// records are coded against.
    acked: FxHashMap<BodyKey, Keyframe>,
    /// Bodies this client has never been sent.
    unsent: FxHashSet<BodyKey>,
    sends_since_datagram: u32,
    rtt_ms: f32,
    /// Events packets still to be copied onto this client's datagram lane,
    /// and how many copies each has left (decision D6).
    event_copies: VecDeque<(Vec<u8>, u32)>,
    /// Events packets not yet acked: (sequence, tick, bodies they change).
    event_marks: VecDeque<(u32, u32, Vec<BodyKey>)>,
    /// Sends so far (the evaluation slice rotates on it).
    sends: u64,
    /// Bodies that were over tolerance last send and lost the ranking:
    /// evaluated again whatever the slice (`PerPlayerConfig::eval_cap`).
    hot: FxHashSet<BodyKey>,
    /// The tick each body's error went over tolerance, until it is sent
    /// (`PerPlayerConfig::age_priority`).
    over_since: FxHashMap<BodyKey, u32>,
}

/// Counters for reports.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct PerPlayerStats {
    pub fractures: u64,
    pub removed_chunks: u64,
    /// Physics islands whose members differ from the derived body.
    pub derive_mismatches: u64,
    pub keyframes_sent: u64,
    pub keyframes_lost: u64,
    pub heartbeats: u64,
    /// Keyframes sent as residuals against an acked baseline.
    pub delta_records: u64,
    /// Keyframes by the mode they carry: ballistic, sliding, resting, friction.
    pub by_mode: [u64; 4],
    /// Keyframe bytes by mode.
    pub bytes_by_mode: [u64; 4],
    /// Bodies evaluated across every client send, and of those, how many
    /// were there for a recent contact, last send's ranking, or never sent.
    pub evaluated: u64,
    pub evaluated_contacts: u64,
    pub evaluated_hot: u64,
    pub evaluated_unsent: u64,
    /// Bytes the budget offered across sends, and record bytes chosen; and
    /// sends that ran out of candidates before the allowance did.
    pub allowance_offered: u64,
    pub allowance_used: u64,
    pub sends_out_of_candidates: u64,
    /// Bodies re-sent because the client received their event late.
    pub late_event_resends: u64,
    /// Keyframes and record bytes by the body's distance from the client's
    /// eye: under 10, 25, 50, 100 m, and beyond (the collapse-cost report).
    pub keyframes_by_distance: [u64; 5],
    pub bytes_by_distance: [u64; 5],
}

/// The distance bands of the cost report, m.
pub const DISTANCE_BANDS_M: [f32; 4] = [10.0, 25.0, 50.0, 100.0];

impl PerPlayerStats {
    /// Add what one send worker counted (the fields `send_for` touches).
    fn absorb_sends(&mut self, other: &PerPlayerStats) {
        self.keyframes_sent += other.keyframes_sent;
        self.heartbeats += other.heartbeats;
        self.delta_records += other.delta_records;
        self.evaluated += other.evaluated;
        self.evaluated_contacts += other.evaluated_contacts;
        self.evaluated_hot += other.evaluated_hot;
        self.evaluated_unsent += other.evaluated_unsent;
        self.allowance_offered += other.allowance_offered;
        self.allowance_used += other.allowance_used;
        self.sends_out_of_candidates += other.sends_out_of_candidates;
        for b in 0..5 {
            self.keyframes_by_distance[b] += other.keyframes_by_distance[b];
            self.bytes_by_distance[b] += other.bytes_by_distance[b];
        }
        for m in 0..4 {
            self.by_mode[m] += other.by_mode[m];
            self.bytes_by_mode[m] += other.bytes_by_mode[m];
        }
    }
}

/// The client's ack cadence (30 Hz), ms.
const ACK_INTERVAL_MS: f32 = 1000.0 / 30.0;
/// Events packets remembered per client awaiting their ack.
const EVENT_MARKS_MAX: usize = 1024;

pub struct PerPlayer {
    /// The newest tick ingested (feedback arrives between ticks).
    now_tick: u32,
    /// Past the evaluation cap: the order sends slice the bodies in, its
    /// membership, and the bodies with a recent contact (`begin_send`).
    order: Vec<BodyKey>,
    in_order: FxHashSet<BodyKey>,
    /// Every body with a contact, the freshest first (contact tick
    /// descending, then key): kept in order as contacts arrive, since a new
    /// contact is always newer than every one listed. `recent` is the
    /// prefix within the window sends look back over.
    contacts: Vec<(u32, BodyKey)>,
    recent: usize,
    /// Bodies with a contact since the last send.
    fresh_contacts: Vec<BodyKey>,
    /// Bodies whose listed contact may no longer hold since the last send:
    /// a newer contact, or the body gone or made anew by a fracture.
    contacts_stale: FxHashSet<BodyKey>,
    /// Bodies new to the truth since the last send past the evaluation cap:
    /// the only ones that can be missing from `order`.
    order_new: FxHashSet<BodyKey>,
    config: PerPlayerConfig,
    model: PerceptualModel,
    physics: Physics,
    defs: BTreeMap<u32, StructureDef>,
    states: BTreeMap<u32, StructureState>,
    chunk_radius: BTreeMap<u32, Vec<f32>>,
    ledger: CityLedger,
    serial_body: FxHashMap<(u32, u32), u32>,
    /// Each structure's islands as last seen (`IslandMirror`).
    mirrors: FxHashMap<u32, IslandMirror>,
    truth: FxHashMap<BodyKey, Truth>,
    /// Each awake body's last `BACKTEST_TICKS` + 1 truth states, for the
    /// mode backtest.
    history: FxHashMap<BodyKey, VecDeque<Keyframe>>,
    event_seq: u32,
    clients: BTreeMap<u64, ClientState>,
    tick: u32,
    pub stats: PerPlayerStats,
    /// Per awake body (`PerPlayerConfig::ground_gate`): its member count and
    /// each member's offset from the body's centre of mass and inscribed
    /// radius.
    shapes: FxHashMap<BodyKey, BodyShape>,
    /// What can make a shape stale since the last send: bodies new to the
    /// truth, and structures a fracture changed (membership changes
    /// nowhere else). Until the first send, every body.
    shapes_new: FxHashSet<BodyKey>,
    /// Per body, its chunk boxes for the floor its keyframes carry
    /// (`StructureState::floor_boxes`; None where none derives), until a
    /// fracture changes its membership.
    floors: FxHashMap<BodyKey, Option<Vec<(Vec3, Vec3)>>>,
    shapes_dirty: FxHashSet<u32>,
    shapes_built: bool,
    /// Standing chunk boxes by G4's grid cell (`PerPlayerConfig::solid_gate`),
    /// rebuilt when a fracture changes what stands.
    statics: FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>,
    /// Each structure's cells in `statics`, and the structures whose standing
    /// chunks changed since (rebuilt alone: a fracture changes one).
    static_cells_of: FxHashMap<u32, Vec<(i32, i32, i32)>>,
    statics_dirty: FxHashSet<u32>,
    statics_built: bool,
    /// `send_threads` workers, made on first use.
    workers: Option<std::sync::Arc<rayon::ThreadPool>>,
}

use crate::netlab::perceptual::{StaticBox, STATIC_CELL};

/// How deep a body's deepest chunk sphere is inside solid geometry at a
/// pose: the ground (y = 0) and, given, the standing boxes (negative: clear).
fn solid_depth(shape: &BodyShape, position: Vec3, rotation: Quat, statics: Option<&FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>>) -> f32 {
    let mut deepest = f32::NEG_INFINITY;
    for &(offset, r) in &shape.chunks {
        deepest = deepest.max(chunk_depth(position + rotation * offset, r, statics));
    }
    deepest
}

/// One chunk sphere's depth (`solid_depth`): the ground, and the standing
/// boxes in its centre's cell.
fn chunk_depth(c: Vec3, r: f32, statics: Option<&FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>>) -> f32 {
    let mut d = r - c.y;
    if let Some(cells) = statics {
        let cell = (c / STATIC_CELL).floor();
        if let Some(list) = cells.get(&(cell.x as i32, cell.y as i32, cell.z as i32)) {
            for (_, b) in list {
                d = d.max(b.sphere_depth(c, r));
            }
        }
    }
    d
}

/// Float slack on the bound in `sunk_deeper`, m: far above the rounding of
/// positions a few km from the origin (f32 ulp 0.5 mm at 4 km).
const SUNK_BOUND_SLACK_M: f32 = 0.005;

/// Gate G4's test, `solid_depth(drawn) - truth_depth.max(0) > G4_TOLERANCE_M`,
/// without looking up the chunks that cannot fire it. A chunk whose centre
/// stays in the truth's cell is tested against the same boxes, and each of
/// its depth terms moves no more than its centre does (a distance, or the
/// ground height): drawn within `G4_TOLERANCE_M` of the truth, it is no
/// deeper than the truth's deepest chunk plus that. Only the others are
/// looked up. The depth is the deepest chunk's, so it is over the tolerance
/// exactly when one chunk is (rounding is monotone).
fn sunk_deeper(
    shape: &BodyShape,
    drawn: (Vec3, Quat),
    truth: (Vec3, Quat),
    truth_depth: f32,
    statics: Option<&FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>>,
) -> bool {
    let floor = truth_depth.max(0.0);
    for &(offset, r) in &shape.chunks {
        let c = drawn.0 + drawn.1 * offset;
        if statics.is_some() {
            let t = truth.0 + truth.1 * offset;
            if (c / STATIC_CELL).floor() == (t / STATIC_CELL).floor()
                && (c - t).length() <= crate::netlab::perceptual::G4_TOLERANCE_M - SUNK_BOUND_SLACK_M
            {
                continue;
            }
        }
        if chunk_depth(c, r, statics) - floor > crate::netlab::perceptual::G4_TOLERANCE_M {
            return true;
        }
    }
    false
}

/// A body's chunks as G4 sees them: offset from the centre of mass, and the
/// inscribed sphere's radius (the smallest half extent).
struct BodyShape {
    members: usize,
    chunks: Vec<(Vec3, f32)>,
    /// The radius about the centre of mass that holds every chunk sphere.
    extent: f32,
}

/// Whether any chunk sphere of `shape` at `position` could touch the ground
/// or a standing box: false proves `solid_depth` is at most 0 (every chunk
/// sphere clear), which no gate can fire on. Exact, and far cheaper than
/// the depth itself for the bodies in the air or away from any structure.
fn could_touch_solid(shape: &BodyShape, position: Vec3, statics: Option<&FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>>) -> bool {
    if position.y - shape.extent <= 0.0 {
        return true;
    }
    let Some(cells) = statics else { return false };
    // The cells the chunk centres can be in (solid_depth looks only there).
    let lo = ((position - Vec3::splat(shape.extent)) / STATIC_CELL).floor();
    let hi = ((position + Vec3::splat(shape.extent)) / STATIC_CELL).floor();
    let count = (hi - lo + Vec3::ONE).element_product();
    if count > shape.chunks.len() as f32 {
        // More cells than chunks: the depth itself is cheaper to ask.
        return true;
    }
    for x in lo.x as i32..=hi.x as i32 {
        for y in lo.y as i32..=hi.y as i32 {
            for z in lo.z as i32..=hi.z as i32 {
                if cells.get(&(x, y, z)).is_some_and(|list| !list.is_empty()) {
                    return true;
                }
            }
        }
    }
    false
}

/// One structure's physics islands as this strategy last saw them: which
/// island each chunk is on, each island's chunks, the islands the
/// derivation disagrees with (the derive check), and the chunks that may be
/// on a dynamic body yet on no island (what `removed_nodes` looks for).
/// Kept per fracture batch from what the batch can have changed, so a
/// fracture's bookkeeping follows the fracture, not the debris about.
#[derive(Default)]
struct IslandMirror {
    /// Per chunk, the islands holding it (one, unless the physics' own
    /// stream put it on two).
    islands_with: FxHashMap<u32, Vec<u32>>,
    nodes_of: FxHashMap<u32, Vec<u32>>,
    mismatched: FxHashSet<u32>,
    /// Chunks the last crush pass moved: possibly dynamic and on no island.
    pending: Vec<u32>,
}

impl IslandMirror {
    fn of(ledger: &CityLedger, structure: u32) -> Self {
        let mut mirror = Self::default();
        let mut serials: Vec<u32> = ledger.structure_islands(structure).into_iter().flatten().map(|(&s, _)| s).collect();
        serials.sort_unstable();
        for serial in serials {
            let nodes = &ledger.island(structure, serial).expect("listed").nodes;
            for &n in nodes {
                mirror.islands_with.entry(n).or_default().push(serial);
            }
            mirror.nodes_of.insert(serial, nodes.clone());
        }
        mirror
    }

    fn on_island(&self, node: u32) -> bool {
        self.islands_with.get(&node).is_some_and(|s| !s.is_empty())
    }

    /// Follow `batch` (already applied to `ledger`): returns the islands it
    /// may have changed or removed, and the chunks it left on no island.
    fn follow(&mut self, ledger: &CityLedger, structure: u32, batch: &FractureBatch) -> (Vec<u32>, Vec<u32>) {
        let mut touched: FxHashSet<u32> = FxHashSet::default();
        for promotion in &batch.promoted_islands {
            touched.insert(promotion.island_id);
            for &chunk in &promotion.chunks {
                if let Some(from) = self.islands_with.get(&ids::chunk_id_parts(chunk).1) {
                    touched.extend(from.iter().copied());
                }
            }
        }
        for migration in &batch.migrations {
            touched.insert(migration.from_island_id);
            touched.insert(migration.to_island_id);
        }
        touched.extend(batch.retired_island_ids.iter().copied());
        let mut touched: Vec<u32> = touched.into_iter().collect();
        touched.sort_unstable();
        let mut left: Vec<u32> = Vec::new();
        for &serial in &touched {
            for n in self.nodes_of.remove(&serial).unwrap_or_default() {
                if let Some(list) = self.islands_with.get_mut(&n) {
                    list.retain(|&s| s != serial);
                    if list.is_empty() {
                        self.islands_with.remove(&n);
                        left.push(n);
                    }
                }
            }
        }
        for &serial in &touched {
            if let Some(island) = ledger.island(structure, serial) {
                for &n in &island.nodes {
                    self.islands_with.entry(n).or_default().push(serial);
                }
                self.nodes_of.insert(serial, island.nodes.clone());
            }
        }
        left.retain(|&n| !self.on_island(n));
        (touched, left)
    }

    /// The islands whose lowest chunk is `node`.
    fn islands_lowest(&self, node: u32) -> impl Iterator<Item = u32> + '_ {
        self.islands_with
            .get(&node)
            .into_iter()
            .flatten()
            .copied()
            .filter(move |s| self.nodes_of.get(s).and_then(|n| n.first()) == Some(&node))
    }
}

/// `TruthAhead` of a truth's keyframe (the depth only with a shape).
fn truth_ahead(
    keyframe: &Keyframe,
    shape: Option<&BodyShape>,
    solids: Option<&FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>>,
    horizon_ticks: f32,
    frame_ticks: f32,
    physics: Physics,
) -> TruthAhead {
    let ahead = vibe_land_perplayer::predict::predict(keyframe, horizon_ticks, physics);
    let (t1, tq1) = vibe_land_perplayer::predict::predict(keyframe, frame_ticks, physics);
    TruthAhead {
        ahead,
        step: t1 - keyframe.position,
        turn: 2.0 * keyframe.rotation.dot(tq1).abs().min(1.0).acos(),
        solid: shape.map_or(0.0, |shape| solid_depth(shape, keyframe.position, keyframe.rotation, solids)),
    }
}

/// What every client's evaluation of a body needs from its truth alone,
/// computed once per send (`PerPlayer::begin_send`), not once per client.
#[derive(Clone, Copy, Debug)]
struct TruthAhead {
    /// The truth predicted a horizon ahead (its own mode).
    ahead: (Vec3, Quat),
    /// Its predicted step over one drawn frame, and the turn in it.
    step: Vec3,
    turn: f32,
    /// Its depth in solid geometry (the gates), when a gate is on.
    solid: f32,
}


impl PerPlayer {
    /// From the manifest and the ledger at the start (a capture's
    /// checkpoint, or the intact city).
    /// The event ack: every events packet before `through` reached the
    /// client. One it received after its drawing passed the events' tick
    /// was applied late, and the server's model of that client (which
    /// applied it on time) no longer holds for the bodies it changed: they
    /// are sent again. Received is estimated as now less half the round
    /// trip and half the ack interval.
    fn events_received(&mut self, client: u64, through: u32) {
        let (hz, delay) = (self.config.sim_hz.max(1) as f32, self.config.delay_ticks);
        let now = self.now_tick as f32;
        let Some(cs) = self.clients.get_mut(&client) else { return };
        let received = now - (cs.rtt_ms * 0.5 + ACK_INTERVAL_MS * 0.5) / 1000.0 * hz;
        while cs.event_marks.front().is_some_and(|(seq, _, _)| *seq < through) {
            let (_, tick, keys) = cs.event_marks.pop_front().unwrap();
            if received > tick as f32 + delay {
                for key in keys {
                    if self.truth.get(&key).is_some_and(|t| !t.settled) {
                        cs.unsent.insert(key);
                        self.stats.late_event_resends += 1;
                    }
                }
            }
        }
    }

    /// The config a send runs with: the evaluation cap shared out of the
    /// per-send budget.
    /// The worker pool, when `send_threads` asks for more than one.
    fn workers(&mut self) -> Option<std::sync::Arc<rayon::ThreadPool>> {
        let threads = self.config.send_threads as usize;
        if threads <= 1 {
            return None;
        }
        if self.workers.is_none() {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .thread_name(|i| format!("per-player-{i}"))
                .build()
                .expect("per-player worker pool");
            self.workers = Some(std::sync::Arc::new(pool));
        }
        self.workers.clone()
    }

    fn effective_config(&self) -> PerPlayerConfig {
        let mut config = self.config;
        if config.eval_cap > 0 && config.eval_budget > 0 {
            config.eval_cap = config.eval_cap.min((config.eval_budget / self.clients.len().max(1)).max(256));
        }
        config
    }

    /// Rank records by `model` (a calibrated fit) instead of the literature
    /// seeds: the priority is the scorecard's own penalty.
    pub fn with_model(mut self, model: PerceptualModel) -> Self {
        self.model = model;
        self
    }

    pub fn new(manifest: &DestructionManifest, ledger: CityLedger, config: PerPlayerConfig) -> Self {
        let defs: BTreeMap<u32, StructureDef> = structure_defs(manifest).into_iter().map(|d| (d.id, d)).collect();
        let chunk_radius = manifest
            .structures
            .iter()
            .map(|s| {
                let n = s.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0) as usize;
                let mut r = vec![0.0; n];
                for c in &s.chunks {
                    r[c.node_index as usize] = c.radius;
                }
                (s.structure_id, r)
            })
            .collect();
        let mut states: BTreeMap<u32, StructureState> =
            defs.values().map(|d| (d.id, StructureState::new(d))).collect();
        let mut this = Self {
            config,
            model: PerceptualModel::literature(),
            physics: Physics::at_hz(config.sim_hz, config.gravity_y),
            defs,
            states: BTreeMap::new(),
            chunk_radius,
            ledger,
            serial_body: FxHashMap::default(),
            mirrors: FxHashMap::default(),
            truth: FxHashMap::default(),
            now_tick: 0,
            order: Vec::new(),
            in_order: FxHashSet::default(),
            contacts: Vec::new(),
            recent: 0,
            fresh_contacts: Vec::new(),
            contacts_stale: FxHashSet::default(),
            order_new: FxHashSet::default(),
            history: FxHashMap::default(),
            event_seq: 0,
            clients: BTreeMap::new(),
            tick: 0,
            stats: PerPlayerStats::default(),
            shapes: FxHashMap::default(),
            shapes_new: FxHashSet::default(),
            floors: FxHashMap::default(),
            shapes_dirty: FxHashSet::default(),
            shapes_built: false,
            statics: FxHashMap::default(),
            static_cells_of: FxHashMap::default(),
            statics_dirty: FxHashSet::default(),
            statics_built: false,
            workers: None,
        };
        // A capture that starts mid-match: derive the structure from the
        // ledger's bonds and islands, as a joining client would from bits.
        for (&id, def) in &this.defs {
            let state = states.get_mut(&id).unwrap();
            let broken: Vec<u32> = (0..def.bonds.len() as u32).filter(|&b| !this.ledger_bond_alive(id, b)).collect();
            state.apply(def, &broken, &[]);
            // Removed: on a body only because bonds broke, and on no island.
            // An object authored loose (a body in the intact structure: a
            // bench, a planter) is awaiting the island the physics' first
            // tick promotes, not crushed.
            let authored = StructureState::new(def);
            let removed: Vec<u32> = this
                .removed_nodes(id, state)
                .into_iter()
                .filter(|&n| matches!(authored.body_of(n), ANCHORED | REMOVED))
                .collect();
            let crushed = state.apply(def, &[], &removed);
            let mut mirror = IslandMirror::of(&this.ledger, id);
            mirror.pending = crushed.moved_chunks;
            this.mirrors.insert(id, mirror);
            for (_, island) in this.ledger.structure_islands(id).into_iter().flatten() {
                if let Some(&min) = island.nodes.first() {
                    let key = BodyKey { structure: id, body: min };
                    let radius = this.radius_of(id, state, min);
                    this.order_new.insert(key);
                    this.truth.insert(
                        key,
                        Truth {
                            keyframe: Keyframe {
                                tick: 0,
                                position: island.pose.position,
                                rotation: island.pose.rotation,
                                linear_velocity: island.linear_velocity,
                                angular_velocity: island.angular_velocity,
                                mode: if island.settled { Mode::Resting } else { Mode::Ballistic }, decel: 0.0, floor_drop: None,
                            },
                            radius,
                            settled: island.settled,
                            contact_tick: 0,
                            born: 0,
                            ahead: None,
                        },
                    );
                }
            }
        }
        this.states = states;
        this.refresh_serials_all();
        this
    }

    pub fn config(&self) -> PerPlayerConfig {
        self.config
    }

    fn ledger_bond_alive(&self, structure: u32, bond: u32) -> bool {
        self.ledger.bond_alive(structure, bond)
    }

    /// `removed_nodes` among `candidates`: the chunks a batch can have left
    /// dynamic and on no island (those it took off an island, those it made
    /// dynamic, and those the last crush pass made dynamic). Every other
    /// chunk is as it was after the last batch, when none was both.
    fn removed_among(&self, structure: u32, state: &StructureState, candidates: impl IntoIterator<Item = u32>) -> Vec<u32> {
        let mirror = &self.mirrors[&structure];
        let mut off: Vec<u32> = candidates
            .into_iter()
            .filter(|&n| {
                let body = state.body_of(n);
                body != ANCHORED && body != REMOVED && !mirror.on_island(n)
            })
            .collect();
        off.sort_unstable();
        off.dedup();
        off
    }

    /// Nodes on a dynamic derived body that are on no physics island: the
    /// physics removed them without breaking their bonds.
    fn removed_nodes(&self, structure: u32, state: &StructureState) -> Vec<u32> {
        let n = self.defs[&structure].node_count();
        let mut on_island = vec![0u64; (n as usize).div_ceil(64)];
        for island in self.ledger.structure_islands(structure).into_iter().flat_map(|m| m.values()) {
            for &node in island.nodes.iter().filter(|&&node| node < n) {
                on_island[node as usize / 64] |= 1 << (node % 64);
            }
        }
        // The dynamic chunks are the bodies' members (ascending once sorted).
        let mut off: Vec<u32> = state
            .bodies()
            .values()
            .flatten()
            .copied()
            .filter(|&node| node < n && on_island[node as usize / 64] & (1 << (node % 64)) == 0)
            .collect();
        off.sort_unstable();
        off
    }

    fn radius_of(&self, structure: u32, state: &StructureState, body: u32) -> f32 {
        let def = &self.defs[&structure];
        let com = state.centre_of_mass(def, body);
        let radii = &self.chunk_radius[&structure];
        state
            .members(body)
            .map(|m| m.iter().map(|&n| (def.rest[n as usize] - com).length() + radii[n as usize]).fold(0.0, f32::max))
            .unwrap_or(0.5)
    }

    fn refresh_serials_all(&mut self) {
        let ids: Vec<u32> = self.defs.keys().copied().collect();
        for id in ids {
            let serials: Vec<u32> = self.ledger.structure_islands(id).into_iter().flatten().map(|(&s, _)| s).collect();
            self.refresh_serials(id, &serials, &[]);
        }
    }

    /// Map the physics' island serials to derived body ids, and count the
    /// islands the derivation disagrees with (every island, each refresh:
    /// `derive_mismatches`). Only `serials` (islands a batch may have
    /// changed or removed) and the islands whose lowest chunk names one of
    /// `bodies` (bodies whose members changed) can have changed since.
    fn refresh_serials(&mut self, structure: u32, serials: &[u32], bodies: &[u32]) {
        let state = &self.states[&structure];
        let mirror = self.mirrors.entry(structure).or_default();
        let mut check: Vec<u32> = serials.to_vec();
        check.extend(bodies.iter().flat_map(|&b| mirror.islands_lowest(b)));
        for serial in check {
            let island = self.ledger.island(structure, serial).filter(|i| !i.nodes.is_empty());
            match island {
                Some(island) => {
                    let min = island.nodes[0];
                    self.serial_body.insert((structure, serial), min);
                    if state.members(min) != Some(island.nodes.as_slice()) {
                        if mirror.mismatched.insert(serial) {
                            // What the derivation disagrees with, once per
                            // island as it starts (the counter only counts).
                            let derived = state.members(min).map(<[u32]>::to_vec);
                            let only_island: Vec<u32> = island.nodes.iter().copied().filter(|n| derived.as_ref().map_or(true, |d| d.binary_search(n).is_err())).take(8).collect();
                            let only_derived: Vec<u32> = derived.iter().flatten().copied().filter(|n| island.nodes.binary_search(n).is_err()).take(8).collect();
                            let bodies: Vec<u32> = island.nodes.iter().map(|&n| state.body_of(n)).take(8).collect();
                            tracing::warn!(
                                structure, serial, lowest = min, island_chunks = island.nodes.len(),
                                derived_chunks = derived.as_ref().map_or(0, Vec::len),
                                ?only_island, ?only_derived, ?bodies,
                                "per-player derivation disagrees with a physics island"
                            );
                        }
                    } else {
                        mirror.mismatched.remove(&serial);
                    }
                }
                None => {
                    self.serial_body.remove(&(structure, serial));
                    mirror.mismatched.remove(&serial);
                }
            }
        }
        self.stats.derive_mismatches += mirror.mismatched.len() as u64;
    }

    /// How the client should predict a body from its state now: whichever
    /// predictor would have best predicted its last `BACKTEST_TICKS` from the
    /// truth already seen -- ballistic, sliding, sliding to a stop (with the
    /// deceleration measured over that window) or resting. The spec's "best
    /// predictor of the next few ticks", measured on the past few. Without
    /// the history: ballistic for a body just freed (most likely falling).
    fn mode_of(&self, history: Option<&VecDeque<Keyframe>>, now: &Keyframe, radius: f32) -> (Mode, f32) {
        if !self.config.backtest_modes {
            let prev = history.and_then(|h| h.back()).filter(|k| k.tick + 1 == now.tick);
            if now.linear_velocity.length() < 0.05 && now.angular_velocity.length() < 0.05 {
                return (Mode::Resting, 0.0);
            }
            return match prev {
                Some(prev) => {
                    let accel = (now.linear_velocity - prev.linear_velocity) / self.physics.dt;
                    let g = self.physics.gravity;
                    (if (accel - g).length() <= 0.15 * g.length() { Mode::Ballistic } else { Mode::Sliding }, 0.0)
                }
                None => (Mode::Ballistic, 0.0),
            };
        }
        let Some(history) = history.filter(|h| !h.is_empty()) else {
            return (if now.linear_velocity.length() < 0.05 && now.angular_velocity.length() < 0.05 { Mode::Resting } else { Mode::Ballistic }, 0.0);
        };
        let past = *history.front().unwrap();
        let ticks = now.tick.saturating_sub(past.tick) as f32;
        if ticks < 1.0 {
            return (Mode::Ballistic, 0.0);
        }
        let decel = ((past.linear_velocity.length() - now.linear_velocity.length()) / (ticks * self.physics.dt)).max(0.0);
        let error = |mode: Mode| {
            let kf = Keyframe { mode, decel, ..past };
            let (p, q) = vibe_land_perplayer::predict::predict(&kf, ticks, self.physics);
            let angle = 2.0 * q.dot(now.rotation).abs().min(1.0).acos();
            (p - now.position).length() + radius * angle
        };
        // Supported now: free flight accelerates at exactly g each step
        // (PhysX integrates it), so a body whose last two steps fell short
        // of g by more than half is on something. The backtest scores the
        // past, which for a body that just landed is a fall; predicting a
        // fall from here draws it sinking into what holds it up.
        let g_y = self.physics.gravity.y;
        let mut supported = history.len() >= 2;
        let mut later = now;
        for earlier in history.iter().rev().take(2) {
            if later.tick != earlier.tick + 1 {
                supported = false;
                break;
            }
            let accel_y = (later.linear_velocity.y - earlier.linear_velocity.y) / self.physics.dt;
            supported &= accel_y > 0.5 * g_y;
            later = earlier;
        }
        // Cheapest first: a tie goes to the one with fewer bytes.
        let mut best = (Mode::Resting, error(Mode::Resting));
        for mode in [Mode::Ballistic, Mode::Sliding, Mode::Friction] {
            if supported && mode == Mode::Ballistic {
                continue;
            }
            let e = error(mode);
            if e + 1e-3 < best.1 {
                best = (mode, e);
            }
        }
        (best.0, if best.0 == Mode::Friction { decel } else { 0.0 })
    }
}

impl ReplicationStrategy for PerPlayer {
    fn name(&self) -> &'static str {
        "per-player"
    }

    fn wire_version(&self) -> u8 {
        4
    }

    fn send_interval_ticks(&self) -> u32 {
        self.config.send_interval_ticks.max(1)
    }

    fn ceiling_bytes(&self) -> usize {
        self.config.ceiling_bytes
    }

    fn add_client(&mut self, client: u64) {
        self.clients.entry(client).or_default();
    }

    fn remove_client(&mut self, client: u64) {
        self.clients.remove(&client);
    }

    fn join(&mut self, client: u64, tick: u32) -> Vec<Outgoing> {
        let mut state = ClientState::default();
        let mut boot = Bootstrap {
            tick,
            next_event_seq: self.event_seq,
            structures: Vec::new(),
            settled: Vec::new(),
            awake: Vec::new(),
        };
        for (&id, s) in &self.states {
            boot.structures.push(BootstrapStructure {
                structure: id,
                alive_bonds: s.alive_bits().to_vec(),
                removed_chunks: s.removed_bits().to_vec(),
            });
        }
        let mut keys: Vec<&BodyKey> = self.truth.keys().collect();
        keys.sort();
        for key in keys {
            let truth = &self.truth[key];
            let kf = quantised(&Keyframe { tick, ..truth.keyframe }, 0);
            let mut track = BodyTrack::default();
            if truth.settled {
                boot.settled.push((*key, kf.position, kf.rotation));
                track.restart(Keyframe { mode: Mode::Resting, ..kf });
                track.settle(tick, kf.position, kf.rotation);
            } else {
                boot.awake.push((*key, kf));
                track.add(kf, f32::MIN, self.physics);
            }
            state.believed.insert(*key, track);
        }
        // As the client draws a body it has no pose for (one the physics has
        // not promoted yet): resting where it was authored.
        for (&id, s) in &self.states {
            let def = &self.defs[&id];
            for &body in s.bodies().keys() {
                let key = BodyKey { structure: id, body };
                if !state.believed.contains_key(&key) {
                    let mut track = BodyTrack::default();
                    track.restart(vibe_land_perplayer::client::authored_rest(def, s, body, tick));
                    state.believed.insert(key, track);
                }
            }
        }
        self.clients.insert(client, state);
        vec![Outgoing::reliable(encode_bootstrap(&boot))]
    }

    fn ingest_tick(&mut self, tick: u32, active: &[BodySnapshotInput], output: &DestructionTickOutput) -> Vec<Outgoing> {
        self.tick = tick;
        let pool = self.workers();
        let mut events: Vec<Event> = Vec::new();
        // The bodies this tick's events change: re-sent to a client that
        // received the events after its drawing had passed them.
        let mut touched: Vec<BodyKey> = Vec::new();
        self.now_tick = tick;
        for batch in &output.batches {
            self.ledger.apply_batch(batch);
            let (islands_touched, left_islands) = match self.mirrors.get_mut(&batch.structure_id) {
                Some(mirror) => mirror.follow(&self.ledger, batch.structure_id, batch),
                None => (Vec::new(), Vec::new()),
            };
            let structure = batch.structure_id;
            let Some(def) = self.defs.get(&structure) else { continue };
            let broken: Vec<u32> = batch
                .broken_bond_ids
                .iter()
                .map(|&b| ids::bond_id_parts(b))
                .filter(|&(s, _)| s == structure)
                .map(|(_, i)| i)
                .collect();
            // Every client's drawn parents before the split (each client's
            // model spawns from its own drawing).
            let mut state = self.states.remove(&structure).unwrap();
            // A body this batch splits holds a broken bond's end (or, for
            // the crush pass below, a crushed chunk or its neighbour): only
            // those can be a new body's parent, and their state before the
            // split is kept.
            let mut truth_parents: FxHashMap<u32, Truth> = FxHashMap::default();
            let mut parent_coms: FxHashMap<u32, Vec3> = FxHashMap::default();
            let mut keep_parent = |state: &StructureState, node: u32| {
                let body = state.body_of(node);
                if body == ANCHORED || body == REMOVED || parent_coms.contains_key(&body) {
                    return;
                }
                parent_coms.insert(body, state.centre_of_mass(def, body));
                if let Some(t) = self.truth.get(&BodyKey { structure, body }) {
                    truth_parents.insert(body, *t);
                }
            };
            for &bond in &broken {
                if let Some(&(a, b)) = def.bonds.get(bond as usize) {
                    keep_parent(&state, a);
                    keep_parent(&state, b);
                }
            }
            let mut change = state.apply(def, &broken, &[]);
            let pending = self.mirrors.get_mut(&structure).map(|m| std::mem::take(&mut m.pending)).unwrap_or_default();
            let removed = self.removed_among(structure, &state, left_islands.iter().chain(&change.moved_chunks).chain(&pending).copied());
            if !removed.is_empty() {
                // The crush pass's parents: unchanged by the break pass (a
                // body it changed maps to its own parent, kept above), so
                // their state now is their state before the tick.
                let changed: FxHashSet<u32> = change.changed_bodies.iter().copied().collect();
                for &node in &removed {
                    for n in std::iter::once(node).chain(def.neighbours(node).iter().map(|&(o, _)| o)) {
                        if !changed.contains(&state.body_of(n)) {
                            keep_parent(&state, n);
                        }
                    }
                }
                let more = state.apply(def, &[], &removed);
                if let Some(mirror) = self.mirrors.get_mut(&structure) {
                    mirror.pending = more.moved_chunks.clone();
                }
                change.changed_bodies.extend(more.changed_bodies);
                change.retired_bodies.extend(more.retired_bodies);
                change.moved_chunks.extend(more.moved_chunks);
                for (id, parent) in more.parent_of {
                    // A body split again by a removal still spawns from the
                    // body it was part of before this tick.
                    let original = change.parent_of.iter().find(|(c, _)| *c == parent).map_or(parent, |&(_, p)| p);
                    change.parent_of.retain(|(c, _)| *c != id);
                    change.parent_of.push((id, original));
                }
                change.parent_of.retain(|(c, _)| state.members(*c).is_some());
                change.retired_bodies.retain(|b| state.members(*b).is_none());
            }
            if broken.is_empty() && removed.is_empty() {
                self.states.insert(structure, state);
                self.refresh_serials(structure, &islands_touched, &[]);
                continue;
            }
            self.stats.fractures += 1;
            self.statics_dirty.insert(structure);
            self.shapes_dirty.insert(structure);
            self.stats.removed_chunks += removed.len() as u64;
            for id in change.changed_bodies.iter().chain(&change.retired_bodies) {
                self.floors.remove(&BodyKey { structure, body: *id });
            }
            events.push(Event::Fracture { tick, structure, broken_bonds: broken, removed_chunks: removed });
            for id in &change.retired_bodies {
                self.truth.remove(&BodyKey { structure, body: *id });
                self.contacts_stale.insert(BodyKey { structure, body: *id });
            }
            // The new bodies' truth: the physics' own promotion (pose and
            // velocities in the new body's centre-of-mass frame), from the
            // ledger. A body the physics did not promote this tick (asleep,
            // re-keyed) is where its chunks were: its parent's frame moved to
            // its own centre of mass.
            let mirror = &self.mirrors[&structure];
            let islands: FxHashMap<u32, (Vec3, Quat, Vec3, Vec3, bool)> = change
                .parent_of
                .iter()
                .flat_map(|&(id, _)| mirror.islands_lowest(id))
                .filter_map(|serial| self.ledger.island(structure, serial))
                .filter_map(|i| {
                    i.nodes.first().map(|&min| (min, (i.pose.position, i.pose.rotation, i.linear_velocity, i.angular_velocity, i.settled)))
                })
                .collect();
            for &(id, parent) in &change.parent_of {
                let key = BodyKey { structure, body: id };
                let radius = self.radius_of(structure, &state, id);
                let com = state.centre_of_mass(def, id);
                let (keyframe, settled) = match islands.get(&id) {
                    Some(&(p, q, v, w, settled)) => (
                        Keyframe {
                            tick,
                            position: p,
                            rotation: q,
                            linear_velocity: v,
                            angular_velocity: w,
                            mode: if settled { Mode::Resting } else { Mode::Ballistic }, decel: 0.0, floor_drop: None,
                        },
                        settled,
                    ),
                    None => match truth_parents.get(&parent) {
                        Some(t) if parent != ANCHORED => {
                            let parent_com = parent_coms.get(&parent).copied().unwrap_or(com);
                            let arm = t.keyframe.rotation * (com - parent_com);
                            (
                                Keyframe {
                                    tick,
                                    position: t.keyframe.position + arm,
                                    linear_velocity: t.keyframe.linear_velocity + t.keyframe.angular_velocity.cross(arm),
                                    ..t.keyframe
                                },
                                false,
                            )
                        }
                        _ => (
                            Keyframe {
                                tick,
                                position: def.world_position + def.world_rotation * com,
                                rotation: def.world_rotation,
                                linear_velocity: Vec3::ZERO,
                                angular_velocity: Vec3::ZERO,
                                mode: Mode::Resting, decel: 0.0, floor_drop: None,
                            },
                            false,
                        ),
                    },
                };
                // Only an id that outlives the split (the piece keeping the
                // lowest chunk) needs its version named: a new id is one the
                // client simply does not have yet.
                let born = if id == parent { tick } else { 0 };
                if self.truth.insert(key, Truth { keyframe, radius, settled, contact_tick: 0, born , ahead: None }).is_none() {
                    self.shapes_new.insert(key);
                    self.order_new.insert(key);
                }
                self.contacts_stale.insert(key);
                touched.push(key);
            }
            // Each client's model spawns the new bodies from its own drawing
            // of their parents just before the split: only the parents this
            // fracture split, and each client independently (on
            // `send_threads` workers, byte-identical to one).
            let mut needed: Vec<u32> = change.parent_of.iter().map(|&(_, p)| p).filter(|&p| p != ANCHORED).collect();
            needed.sort_unstable();
            needed.dedup();
            let physics = self.physics;
            let (state_ref, change_ref, coms) = (&state, &change, &parent_coms);
            let update = |cs: &mut ClientState| {
                let mut parents: HashMap<u32, vibe_land_perplayer::client::ParentState> = HashMap::new();
                for &id in &needed {
                    if let Some(track) = cs.believed.get(&BodyKey { structure, body: id }) {
                        let track = track.before(tick);
                        let (p, q) = track.pose_at(tick as f32, physics);
                        let (v, w) = track.velocity_at(tick as f32, physics);
                        parents.insert(id, (p, q, v, w, coms.get(&id).copied().unwrap_or(Vec3::ZERO)));
                    }
                }
                apply_spawns(def, state_ref, structure, tick, change_ref, &parents, &mut cs.believed);
                for &(id, _) in &change_ref.parent_of {
                    cs.unsent.insert(BodyKey { structure, body: id });
                    cs.over_since.remove(&BodyKey { structure, body: id });
                }
            };
            // Workers only for enough work to pay for waking them (each
            // client's update is a few predictions per split parent).
            let work = self.clients.len() * (needed.len() + change.parent_of.len());
            let workers = pool.clone().filter(|_| self.clients.len() > 1 && work >= 1024);
            let models: Vec<&mut ClientState> = self.clients.values_mut().collect();
            match workers {
                Some(pool) => pool.install(|| {
                    use rayon::prelude::*;
                    models.into_par_iter().for_each(update)
                }),
                None => models.into_iter().for_each(update),
            }
            let bodies: Vec<u32> = change.changed_bodies.iter().chain(&change.retired_bodies).copied().collect();
            self.states.insert(structure, state);
            self.refresh_serials(structure, &islands_touched, &bodies);
        }
        // Each awake body's keyframe, mode, floor and contact: a pure
        // function of its snapshot and its history so far, so it runs on
        // `send_threads` workers (byte-identical to one); the history and
        // truth are then updated in order.
        let workers = pool;
        let serial_body = &self.serial_body;
        fn keyed<'s>(serial_body: &FxHashMap<(u32, u32), u32>, snapshot: &'s BodySnapshotInput) -> Option<(BodyKey, &'s BodySnapshotInput)> {
            let (structure, serial) = ids::body_entity_parts(snapshot.body_entity);
            let &body = serial_body.get(&(structure, serial))?;
            Some((BodyKey { structure, body }, snapshot))
        }
        let key_of = |snapshot| keyed(serial_body, snapshot);
        let work: Vec<(BodyKey, &BodySnapshotInput)> = match workers.as_ref().filter(|_| active.len() >= 16_384) {
            Some(pool) => pool.install(|| {
                use rayon::prelude::*;
                active.par_iter().with_min_len(256).filter_map(key_of).collect()
            }),
            None => active.iter().filter_map(key_of).collect(),
        };
        let classify = |&(key, snapshot): &(BodyKey, &BodySnapshotInput)| -> (BodyKey, Truth, bool, Option<Option<Vec<(Vec3, Vec3)>>>) {
            let previous = self.truth.get(&key).copied();
            let radius = previous.map_or(0.5, |p| p.radius);
            let mut keyframe = Keyframe {
                tick,
                position: Vec3::from_array(snapshot.position),
                rotation: Quat::from_array(snapshot.rotation).normalize(),
                linear_velocity: Vec3::from_array(snapshot.linear_velocity),
                angular_velocity: Vec3::from_array(snapshot.angular_velocity),
                mode: Mode::Ballistic,
                decel: 0.0, floor_drop: None,
            };
            // Only this incarnation's continuous past counts.
            let history = self.history.get(&key).filter(|h| h.back().map_or(true, |k| k.tick + 1 == tick));
            let continuous = history.is_some();
            // A contact this tick: the velocity changed by more than gravity
            // explains.
            let gravity_step = Vec3::new(0.0, self.config.gravity_y, 0.0) / self.config.sim_hz.max(1) as f32;
            let contact = history
                .and_then(|h| h.back())
                .is_some_and(|p| (keyframe.linear_velocity - p.linear_velocity - gravity_step).length() > CONTACT_DV);
            let contact_tick = if contact { tick } else { previous.map_or(0, |p| p.contact_tick) };
            let (mode, decel) = self.mode_of(history, &keyframe, radius);
            keyframe.mode = mode;
            keyframe.decel = decel;
            let mut derived = None;
            if let (Some(state), Some(def)) = (self.states.get(&key.structure), self.defs.get(&key.structure)) {
                let boxes = match self.floors.get(&key) {
                    Some(boxes) => boxes.as_deref(),
                    None => derived.insert(state.floor_boxes(def, key.body)).as_deref(),
                };
                keyframe.floor_drop = boxes.map(|b| StructureState::floor_drop_of(b, keyframe.position, keyframe.rotation));
            }
            (key, Truth { keyframe, radius, settled: false, contact_tick, born: previous.map_or(0, |p| p.born), ahead: None }, continuous, derived)
        };
        let classified: Vec<(BodyKey, Truth, bool, Option<Option<Vec<(Vec3, Vec3)>>>)> = match workers.filter(|_| work.len() >= 2_048) {
            Some(pool) => pool.install(|| {
                use rayon::prelude::*;
                work.par_iter().with_min_len(64).map(classify).collect()
            }),
            None => work.iter().map(classify).collect(),
        };
        // Written back in order; each chunk's entries fetched first, in a
        // tight loop of independent lookups whose cache misses overlap.
        let keys: Vec<BodyKey> = classified.iter().map(|c| c.0).collect();
        for (i, (key, truth, continuous, derived)) in classified.into_iter().enumerate() {
            if i % 64 == 0 {
                let mut touched = 0u32;
                for key in &keys[i..(i + 64).min(keys.len())] {
                    touched = touched
                        .wrapping_add(self.truth.get(key).map_or(0, |t| t.contact_tick))
                        .wrapping_add(self.history.get(key).and_then(|h| h.back()).map_or(0, |k| k.tick));
                }
                std::hint::black_box(touched);
            }
            if let Some(boxes) = derived {
                self.floors.insert(key, boxes);
            }
            let history = self.history.entry(key).or_default();
            if !continuous {
                history.clear();
            }
            history.push_back(truth.keyframe);
            while history.len() > BACKTEST_TICKS as usize + 1 {
                history.pop_front();
            }
            if truth.contact_tick == tick && tick > 0 {
                self.fresh_contacts.push(key);
                self.contacts_stale.insert(key);
            }
            if self.truth.insert(key, truth).is_none() {
                self.shapes_new.insert(key);
                self.order_new.insert(key);
            }
        }
        // A body the physics put to sleep has no snapshot: it lies where it
        // was last seen. (Without this its last awake velocity carried on,
        // and the server kept sending a falling body that lay still.) Every
        // body updated above has this tick, so the rest are the sleepers.
        for truth in self.truth.values_mut() {
            if !truth.settled && truth.keyframe.tick < tick {
                truth.keyframe = Keyframe {
                    tick,
                    linear_velocity: Vec3::ZERO,
                    angular_velocity: Vec3::ZERO,
                    mode: Mode::Resting,
                    ..truth.keyframe
                };
            }
        }
        for settle in &output.settled {
            self.ledger.apply_settle(settle);
            let Some(&body) = self.serial_body.get(&(settle.structure_id, settle.island_id)) else { continue };
            let key = BodyKey { structure: settle.structure_id, body };
            let position = Vec3::from_array(settle.position);
            let rotation = Quat::from_array(settle.rotation).normalize();
            if let Some(t) = self.truth.get_mut(&key) {
                t.settled = true;
                t.keyframe = Keyframe { tick, position, rotation, linear_velocity: Vec3::ZERO, angular_velocity: Vec3::ZERO, mode: Mode::Resting, decel: 0.0, floor_drop: None };
            }
            // Settles ride the reliable stream: every client holds the pose
            // from this tick (rounded as the wire carries it).
            let q = quantised(&Keyframe { tick, position, rotation, linear_velocity: Vec3::ZERO, angular_velocity: Vec3::ZERO, mode: Mode::Resting, decel: 0.0, floor_drop: None }, 0);
            for cs in self.clients.values_mut() {
                cs.believed.entry(key).or_default().settle(tick, q.position, q.rotation);
            }
            events.push(Event::Settle { tick, key, position, rotation });
            touched.push(key);
        }
        for &(structure, serial) in &output.wakes {
            self.ledger.apply_wake(structure, serial);
            let Some(&body) = self.serial_body.get(&(structure, serial)) else { continue };
            let key = BodyKey { structure, body };
            if let Some(t) = self.truth.get_mut(&key) {
                t.settled = false;
            }
            for cs in self.clients.values_mut() {
                if let Some(track) = cs.believed.get_mut(&key) {
                    track.wake(tick);
                }
            }
            events.push(Event::Wake { tick, key });
            touched.push(key);
        }
        if tick % self.config.hash_interval_ticks.max(1) == 0 {
            for (&structure, state) in &self.states {
                events.push(Event::Hash { tick, structure, hash: state.hash() });
            }
        }
        if events.is_empty() {
            return Vec::new();
        }
        let packet = encode_events(self.event_seq, &events);
        if !touched.is_empty() {
            for cs in self.clients.values_mut() {
                cs.event_marks.push_back((self.event_seq, tick, touched.clone()));
                // Bounded: a client that never acks events keeps no more
                // than a few seconds of them.
                while cs.event_marks.len() > EVENT_MARKS_MAX {
                    cs.event_marks.pop_front();
                }
            }
        }
        self.event_seq += 1;
        if self.config.event_copies > 0 && packet.len() <= self.config.max_datagram {
            for cs in self.clients.values_mut() {
                cs.event_copies.push_back((packet.clone(), self.config.event_copies));
            }
        }
        vec![Outgoing::reliable(packet)]
    }

    fn begin_send(&mut self, tick: u32) {
        if self.config.solid_gate && (!self.statics_built || !self.statics_dirty.is_empty()) {
            let structures: Vec<u32> = if self.statics_built {
                self.statics_dirty.iter().copied().collect()
            } else {
                self.defs.keys().copied().collect()
            };
            self.statics_built = true;
            self.statics_dirty.clear();
            for id in structures {
                // Out with this structure's old boxes.
                for cell in self.static_cells_of.remove(&id).unwrap_or_default() {
                    if let Some(list) = self.statics.get_mut(&cell) {
                        list.retain(|(s, _)| *s != id);
                    }
                }
                let (Some(def), Some(state)) = (self.defs.get(&id), self.states.get(&id)) else { continue };
                if def.half_extents.len() != def.rest.len() {
                    continue;
                }
                let mut cells_of: FxHashSet<(i32, i32, i32)> = FxHashSet::default();
                for n in 0..def.node_count() {
                    if state.body_of(n) != ANCHORED {
                        continue;
                    }
                    let b = StaticBox {
                        position: def.world_position + def.world_rotation * def.rest[n as usize],
                        rotation: def.world_rotation,
                        half_extents: def.half_extents[n as usize],
                    };
                    let r = b.half_extents.length();
                    let lo = ((b.position - Vec3::splat(r)) / STATIC_CELL).floor();
                    let hi = ((b.position + Vec3::splat(r)) / STATIC_CELL).floor();
                    for x in lo.x as i32..=hi.x as i32 {
                        for y in lo.y as i32..=hi.y as i32 {
                            for z in lo.z as i32..=hi.z as i32 {
                                self.statics.entry((x, y, z)).or_default().push((id, b));
                                cells_of.insert((x, y, z));
                            }
                        }
                    }
                }
                self.static_cells_of.insert(id, cells_of.into_iter().collect());
            }
        }
        if self.config.ground_gate || self.config.solid_gate {
            let (defs, states, truth) = (&self.defs, &self.states, &self.truth);
            // Only what a fracture or a new body can have changed (bodies
            // leave the truth only in a fracture).
            let mut stale: Vec<BodyKey> = Vec::new();
            if !self.shapes_built || !self.shapes_dirty.is_empty() {
                self.shapes.retain(|k, _| truth.contains_key(k));
            }
            let all = !self.shapes_built;
            let dirty = &self.shapes_dirty;
            if all || !dirty.is_empty() {
                stale.extend(truth.keys().filter(|k| all || dirty.contains(&k.structure)));
            }
            stale.extend(self.shapes_new.iter().filter(|k| !all && !dirty.contains(&k.structure) && truth.contains_key(k)));
            self.shapes_built = true;
            self.shapes_dirty.clear();
            self.shapes_new.clear();
            for key in &stale {
                let (Some(def), Some(state)) = (defs.get(&key.structure), states.get(&key.structure)) else { continue };
                let Some(members) = state.members(key.body) else { continue };
                if self.shapes.get(key).is_some_and(|s| s.members == members.len()) || def.half_extents.len() != def.rest.len() {
                    continue;
                }
                let com = state.centre_of_mass(def, key.body);
                let chunks: Vec<(Vec3, f32)> =
                    members.iter().map(|&n| (def.rest[n as usize] - com, def.half_extents[n as usize].min_element())).collect();
                let extent = chunks.iter().map(|&(o, r)| o.length() + r).fold(0.0f32, f32::max);
                self.shapes.insert(*key, BodyShape { members: members.len(), chunks, extent });
            }
        }
        // What every client's evaluation needs from each truth alone, once.
        {
            let pool = if self.truth.len() >= 2_048 { self.workers() } else { None };
            let config = self.effective_config();
            let physics = self.physics;
            let frame_ticks = config.sim_hz as f32 / FRAMES_PER_SECOND;
            let gated = config.ground_gate || config.solid_gate;
            let solids = config.solid_gate.then_some(&self.statics);
            let shapes = &self.shapes;
            let fill = |(key, truth): (&BodyKey, &mut Truth)| {
                truth.ahead = (!truth.settled).then(|| {
                    let shape = shapes.get(key).filter(|_| gated);
                    truth_ahead(&truth.keyframe, shape, solids, config.horizon_ticks, frame_ticks, physics)
                });
            };
            match pool {
                Some(pool) => {
                    let mut all: Vec<(&BodyKey, &mut Truth)> = self.truth.iter_mut().collect();
                    pool.install(|| {
                        use rayon::prelude::*;
                        all.par_iter_mut().with_min_len(256).for_each(|(k, t)| fill((k, t)));
                    });
                }
                None => self.truth.iter_mut().for_each(fill),
            }
        }
        // The contacts since the last send go in front of the rest (all
        // older), which drop out when their body is gone or has had a newer
        // contact (listed again in front).
        {
            let truth = &self.truth;
            let mut fresh: Vec<(u32, BodyKey)> = self
                .fresh_contacts
                .drain(..)
                .filter_map(|key| truth.get(&key).filter(|t| t.contact_tick > 0).map(|t| (t.contact_tick, key)))
                .collect();
            fresh.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            fresh.dedup();
            let stale = &self.contacts_stale;
            fresh.extend(self.contacts.iter().filter(|(_, key)| !stale.contains(key)));
            self.contacts = fresh;
            self.contacts_stale.clear();
        }
        let cap = self.effective_config().eval_cap;
        // The body order sends slice (insertion order, new bodies sorted
        // in), and the bodies with a contact recent enough that a slice may
        // not have reached them yet. Only needed past the evaluation cap.
        if cap == 0 || self.truth.len() <= cap {
            self.recent = 0;
            return;
        }
        let window = (self.truth.len().div_ceil((cap / 2).max(1)) as u32 * self.config.send_interval_ticks.max(1)).max(1);
        // Freshest first: sends take them in this order, up to a share of
        // the evaluation cap.
        self.recent = self.contacts.partition_point(|&(at, _)| at + window >= tick);
        let (truth, in_order) = (&self.truth, &self.in_order);
        let mut fresh: Vec<BodyKey> = self.order_new.drain().filter(|k| truth.contains_key(k) && !in_order.contains(k)).collect();
        fresh.sort_unstable();
        self.in_order.extend(fresh.iter().copied());
        self.order.extend(fresh);
        if self.order.len() > self.truth.len() + self.truth.len() / 4 {
            let truth = &self.truth;
            self.order.retain(|k| truth.contains_key(k));
            self.in_order = self.order.iter().copied().collect();
        }
    }

    fn has_pending(&self, _client: u64) -> bool {
        true
    }

    fn has_records(&self) -> bool {
        true
    }

    fn note_link_rtt(&mut self, client: u64, rtt_ms: f32) {
        if let Some(cs) = self.clients.get_mut(&client) {
            cs.rtt_ms = rtt_ms;
        }
    }

    fn client_send(&mut self, client: u64, view: &ClientView, tick: u32, budget: Option<SendBudget>) -> ClientSend {
        let config = self.effective_config();
        let Some(cs) = self.clients.get_mut(&client) else { return ClientSend::default() };
        send_for(config, self.physics, &self.truth, &self.shapes, &self.statics, &self.order, &self.contacts[..self.recent], &self.model, cs, view, tick, budget, &mut self.stats)
    }

    fn client_sends(&mut self, requests: &[SendRequest]) -> Vec<ClientSend> {
        let workers = if requests.len() >= 2 { self.workers() } else { None };
        let Some(pool) = workers else {
            return requests.iter().map(|r| self.client_send(r.client, &r.view, r.tick, r.budget)).collect();
        };
        // Each client's state is its own: hand disjoint sets to workers.
        let config = self.effective_config();
        let index: HashMap<u64, usize> = requests.iter().enumerate().map(|(i, r)| (r.client, i)).collect();
        let mut jobs: Vec<(usize, &mut ClientState)> =
            self.clients.iter_mut().filter_map(|(id, cs)| index.get(id).map(|&i| (i, cs))).collect();
        jobs.sort_by_key(|j| j.0);
        let (physics, truth, model, shapes, statics) = (self.physics, &self.truth, &self.model, &self.shapes, &self.statics);
        let (order, recent) = (&self.order[..], &self.contacts[..self.recent]);
        // One client per task: costs vary a lot between clients (what each
        // sees), and the pool steals work rather than waiting on the
        // slowest fixed share.
        let parts: Vec<(Vec<(usize, ClientSend)>, PerPlayerStats)> = pool.install(|| {
            use rayon::prelude::*;
            jobs.into_par_iter()
                .map(|(i, cs)| {
                    let r = &requests[i];
                    let mut stats = PerPlayerStats::default();
                    let send = send_for(config, physics, truth, shapes, statics, order, recent, model, cs, &r.view, r.tick, r.budget, &mut stats);
                    (vec![(i, send)], stats)
                })
                .collect()
        });
        let mut out: Vec<ClientSend> = (0..requests.len()).map(|_| ClientSend::default()).collect();
        for (sends, stats) in parts {
            self.stats.absorb_sends(&stats);
            for (i, send) in sends {
                out[i] = send;
            }
        }
        out
    }

    fn report(&self) -> String {
        serde_json::to_string(&self.stats).unwrap_or_else(|_| format!("{:?}", self.stats))
    }

    fn on_feedback(&mut self, client: u64, feedback: ClientFeedback) {
        let (newest, mask) = match feedback {
            ClientFeedback::DatagramAcks { newest, mask } => (newest, mask),
            ClientFeedback::EventsReceived { through } => {
                self.events_received(client, through);
                return;
            }
        };
        let Some(cs) = self.clients.get_mut(&client) else { return };
        let acked = |o: u32| o == newest || (o < newest && newest - o <= 64 && mask & (1 << (newest - o - 1)) != 0);
        // A datagram an ack does not name may still be in flight: links
        // reorder (a third of datagrams on the lab's LTE). It is lost when
        // three acks in a row have not named it, or it fell out of the
        // window.
        const MISSES_TO_LOSE: u8 = 3;
        let mut lost: Vec<(BodyKey, Keyframe)> = Vec::new();
        let mut arrived: Vec<(BodyKey, Keyframe)> = Vec::new();
        cs.sent.retain_mut(|(ordinal, carried, misses)| {
            if *ordinal > newest {
                return true;
            }
            if acked(*ordinal) {
                arrived.append(carried);
                return false;
            }
            *misses += 1;
            if *misses >= MISSES_TO_LOSE || newest - *ordinal > 64 {
                lost.append(carried);
                return false;
            }
            true
        });
        for (key, kf) in arrived {
            let incarnation = cs.believed.get(&key).map_or(0, BodyTrack::incarnation);
            if kf.tick >= incarnation && cs.acked.get(&key).map_or(true, |a| a.tick < kf.tick) {
                cs.acked.insert(key, kf);
            }
        }
        for (key, kf) in lost {
            if let Some(track) = cs.believed.get_mut(&key) {
                track.remove_keyframe(kf.tick);
            }
            self.stats.keyframes_lost += 1;
        }
    }
}

/// One client's packets this send (`ReplicationStrategy::client_send`): it
/// reads only what every client shares (truth, config, model) and writes
/// only that client's state and `stats`, so clients can run in parallel.
#[allow(clippy::too_many_arguments)]
fn send_for(
    config: PerPlayerConfig,
    physics: Physics,
    truths: &FxHashMap<BodyKey, Truth>,
    shapes: &FxHashMap<BodyKey, BodyShape>,
    statics: &FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>>,
    order: &[BodyKey],
    recent_contacts: &[(u32, BodyKey)],
    model: &PerceptualModel,
    cs: &mut ClientState,
    view: &ClientView,
    tick: u32,
    budget: Option<SendBudget>,
    stats: &mut PerPlayerStats,
) -> ClientSend {
    let camera = view.camera;
    let forward = camera.direction.normalize_or_zero();
    let focal = config.pane.1 as f32 * 0.5 / (camera.fov_degrees.max(1.0).to_radians() * 0.5).tan();
    let horizon_s = config.horizon_ticks / config.sim_hz as f32;
    let r = tick as f32;
    // When this keyframe lands, the client's drawing is at about
    // `tick - delay + one-way latency`.
    let latency_ticks = cs.rtt_ms * 0.5 / 1000.0 * config.sim_hz as f32;
    let arrival_render = r - config.delay_ticks + latency_ticks;
    struct Candidate {
        key: BodyKey,
        bytes: usize,
        priority: f32,
        /// Among never-sent bodies when there are more than fit: the
        /// biggest on screen first (0 otherwise).
        rank: u32,
        /// Distance from the client's eye, m (for the cost report).
        distance: f32,
        record: PreparedRecord,
    }
    let allowance = match budget {
        Some(SendBudget::Skip) => 0,
        Some(b) => b
            .allowance()
            .unwrap_or(config.ceiling_bytes * b.ceiling_sends() as usize)
            .min(config.ceiling_bytes * b.ceiling_sends() as usize),
        None => config.ceiling_bytes,
    };

    let mut candidates: Vec<Candidate> = Vec::new();
    // Evaluation is bounded: with more awake bodies than `eval_cap`, each
    // send looks at a rotating 1/k slice, plus every body it must not
    // wait on (never sent, a contact not yet sent, over tolerance last
    // send). Below the cap (k = 1) every body is looked at every send.
    // Past the cap the evaluations total about the cap: half for the slice,
    // a quarter each for last send's losers and fresh contacts.
    let slices = if config.eval_cap == 0 || truths.len() <= config.eval_cap {
        1
    } else {
        truths.len().div_ceil((config.eval_cap / 2).max(1)).max(2) as u64
    };
    let turn = cs.sends;
    cs.sends += 1;
    // Never-sent bodies (a joining client, a fresh collapse) can outnumber
    // what one send can carry many times over: rank them by size on
    // screen and evaluate only as many as could fit.
    let mut waiting: Vec<(f32, BodyKey)> = Vec::new();
    let mut evaluate: Vec<BodyKey> = Vec::new();
    let size_of = |truth: &Truth| {
        let rel = truth.keyframe.position - camera.eye;
        let depth = rel.dot(forward);
        if depth > 0.5 { truth.radius * focal / depth } else { 0.5 * truth.radius * focal / rel.length().max(0.5) }
    };
    if slices <= 1 {
        for (key, truth) in truths {
            if truth.settled {
                continue;
            }
            if cs.unsent.contains(key) {
                waiting.push((size_of(truth), *key));
            } else {
                evaluate.push(*key);
            }
        }
    } else {
        // This send's slice of the body order, what lost the ranking last
        // send, fresh contacts, and (while few) every never-sent body;
        // never a pass over every body.
        let mut seen: FxHashSet<BodyKey> = FxHashSet::default();
        let mut visit = |key: &BodyKey, contact_only: bool| -> u64 {
            let Some(truth) = truths.get(key).filter(|t| !t.settled) else { return 0 };
            if contact_only && cs.believed.get(key).and_then(|t| t.newest()).is_some_and(|n| n.tick >= truth.contact_tick) {
                return 0;
            }
            if !seen.insert(*key) {
                return 0;
            }
            if cs.unsent.contains(key) {
                waiting.push((size_of(truth), *key));
            } else {
                evaluate.push(*key);
            }
            1
        };
        for key in order.iter().skip((turn % slices) as usize).step_by(slices as usize) {
            visit(key, false);
        }
        let mut hot: Vec<BodyKey> = cs.hot.iter().copied().collect();
        hot.sort_unstable();
        let mut counts = [0u64; 3];
        for key in &hot {
            counts[1] += visit(key, false);
        }
        // Freshest contacts first (begin_send's order), at most half the
        // cap: piles in constant contact would otherwise be every body.
        for (_, key) in recent_contacts {
            if counts[0] as usize >= config.eval_cap / 4 {
                break;
            }
            counts[0] += visit(key, true);
        }
        if cs.unsent.len() <= config.eval_cap {
            let mut unsent: Vec<BodyKey> = cs.unsent.iter().copied().collect();
            unsent.sort_unstable();
            for key in &unsent {
                counts[2] += visit(key, false);
            }
        }
        stats.evaluated_contacts += counts[0];
        stats.evaluated_hot += counts[1];
        stats.evaluated_unsent += counts[2];
    }
    let fits = allowance / MIN_RECORD_BYTES + 1;
    let mut rank_of: FxHashMap<BodyKey, u32> = FxHashMap::default();
    if waiting.len() > fits {
        let by_size = |a: &(f32, BodyKey), b: &(f32, BodyKey)| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1));
        waiting.select_nth_unstable_by(fits, by_size);
        waiting.truncate(fits);
        waiting.sort_by(by_size);
        rank_of = waiting.iter().enumerate().map(|(i, &(_, k))| (k, i as u32)).collect();
    }
    evaluate.extend(waiting.iter().map(|&(_, k)| k));
    stats.evaluated += evaluate.len() as u64;
    let frame_ticks = config.sim_hz as f32 / FRAMES_PER_SECOND;
    let gated = config.ground_gate || config.solid_gate;
    let solids = config.solid_gate.then_some(statics);
    // This client's tracks of every body to evaluate, fetched first: each
    // is a chain of cache misses (table, entry, keyframes) in a model too
    // large to stay cached, and fetched in a tight loop of independent
    // lookups the misses overlap instead of following one another.
    let entries: Vec<Option<&BodyTrack>> = evaluate.iter().map(|key| cs.believed.get(key)).collect();
    let mut touched = 0u32;
    for track in entries.iter().flatten() {
        // Both ends: a keyframe straddles cache lines.
        if let Some(k) = track.keyframes().last() {
            touched = touched.wrapping_add(k.rotation.x.to_bits() ^ k.mode as u32 ^ k.tick);
        }
    }
    std::hint::black_box(touched);
    for (key, &entry) in evaluate.iter().zip(&entries) {
        let truth = &truths[key];
        // The truth's share, computed once per send for every client (or
        // here, when this send had no begin_send: tests).
        let truth_ahead = truth.ahead.unwrap_or_else(|| {
            truth_ahead(&truth.keyframe, shapes.get(key).filter(|_| gated), solids, config.horizon_ticks, frame_ticks, physics)
        });
        // The client's drawing of it now, predicted once.
        let track = entry.filter(|t| !t.keyframes().is_empty());
        let drawn = track.map(|t| t.pose_at(r, physics));
        // Gate G4 first: drawn sunk into the ground (and, with solid_gate,
        // the standing structures) deeper than the truth.
        let sunk = || {
            gated
                && shapes.get(key).zip(drawn).is_some_and(|(shape, (p, q))| {
                    could_touch_solid(shape, p, solids)
                        && sunk_deeper(shape, (p, q), (truth.keyframe.position, truth.keyframe.rotation), truth_ahead.solid, solids)
                })
        };
        let required = cs.unsent.contains(key) || sunk();
        let distance = (truth.keyframe.position - camera.eye).length().max(0.5);
        // In view: pixels at its depth. Behind or beside: half weight at
        // its distance -- never culled. This scales the keyframe's grid: the
        // keyframe draws the body at the truth.
        let scale_at = |p: Vec3| {
            let rel = p - camera.eye;
            let depth = rel.dot(forward);
            if depth > 0.5 { (focal / depth, 1.0f32) } else { (focal / rel.length().max(0.5), 0.5) }
        };
        let (px_per_m, truth_weight) = scale_at(truth.keyframe.position);
        // The error is seen where it is drawn as well as where it should be
        // (the scorer projects both): in view if either is, at the nearer
        // of the two. A body drawn in front of a player whose truth is
        // behind them is in plain view.
        let drawn_now = drawn.filter(|_| config.drawn_view);
        let (error_px_per_m, weight) = match drawn_now.map(|(p, _)| scale_at(p)) {
            Some((d_scale, d_weight)) if d_weight > truth_weight => (d_scale, d_weight),
            Some((d_scale, d_weight)) if d_weight == truth_weight => (d_scale.max(px_per_m), d_weight),
            _ => (px_per_m, truth_weight),
        };
        // The drawn motion against the truth's, one frame's step on screen
        // (worked out only where it is used).
        let motion = || match (track, drawn) {
            (Some(track), Some((p0, q0))) if config.motion_cost || config.age_priority => {
                let (p1, q1) = track.pose_at(r + frame_ticks, physics);
                let drawn_turn = 2.0 * q0.dot(q1).abs().min(1.0).acos();
                (((p1 - p0) - truth_ahead.step).length() + truth.radius * (drawn_turn - truth_ahead.turn).abs()) * error_px_per_m
            }
            _ => 0.0,
        };
        let motion_px = if config.motion_cost { Some(motion()) } else { None };
        let motion_gain = if let Some(motion_px) = motion_px.filter(|&m| m >= config.tolerance_px) {
            let frames = config.send_interval_ticks as f32 * FRAMES_PER_SECOND / config.sim_hz as f32;
            model.penalty(ArtifactClass::Pop, f64::from(motion_px), f64::from(weight)) as f32 * frames
        } else {
            0.0
        };
        let error_px = match (track, drawn) {
            (Some(track), Some(drawn)) => {
                // Now, and a horizon ahead: the client's drawing then
                // against the server's best prediction of the truth then
                // (the keyframe's own mode). Raw velocity gaps would count
                // contact noise as error nobody will see.
                let gap = |(p, q): (Vec3, Quat), (tp, tq): (Vec3, Quat)| {
                    let angle = 2.0 * q.dot(tq).abs().min(1.0).acos();
                    (p - tp).length() + truth.radius * angle.min(1.0)
                };
                let now = gap(drawn, (truth.keyframe.position, truth.keyframe.rotation));
                let ahead = gap(track.pose_at(r + config.horizon_ticks, physics), truth_ahead.ahead);
                let _ = horizon_s;
                now.max(ahead) * error_px_per_m
            }
            _ => f32::INFINITY,
        };
        // A contact the client has not been sent since: its timing is a
        // class of its own (V6), scored in ms, not pixels -- a small or far
        // piece's bounce moves it under the tolerance for frames, and is
        // drawn late. Waiting one more send delays it to `late_ms`.
        // A contact is seen only on screen and at least a pixel across (the
        // scorer scores visible contacts only): one off to the side or
        // smaller than a pixel has no timing anyone can judge.
        let on_screen = |p: Vec3| {
            let rel = p - camera.eye;
            let depth = rel.dot(forward);
            if depth <= 0.5 {
                return false;
            }
            let right = forward.cross(Vec3::Y).normalize_or_zero();
            let up = right.cross(forward);
            let (x, y) = (rel.dot(right) * focal / depth, rel.dot(up) * focal / depth);
            let radius_px = truth.radius * focal / depth;
            2.0 * radius_px >= 1.0
                && x.abs() <= config.pane.0 as f32 * 0.5 + radius_px
                && y.abs() <= config.pane.1 as f32 * 0.5 + radius_px
        };
        let contact_gain = match track.and_then(|t| t.newest()) {
            Some(newest)
                if config.contacts
                    && truth.contact_tick > newest.tick
                    && (on_screen(truth.keyframe.position) || drawn_now.is_some_and(|(p, _)| on_screen(p))) =>
            {
                // What sending now saves: drawn this late, against one send
                // later. A keyframe that lands before the drawing reaches the
                // contact draws it on time; one long past gains nothing
                // either way.
                let ms_per_tick = 1000.0 / config.sim_hz as f32;
                let late = |lands: f32| (lands - truth.contact_tick as f32).max(0.0) * ms_per_tick;
                let late_now = late(arrival_render);
                let late_wait = late(arrival_render + config.send_interval_ticks as f32);
                let p = |ms: f32| model.penalty(ArtifactClass::ContactTiming, f64::from(ms), 1.0) as f32;
                p(late_wait) - p(late_now)
            }
            _ => 0.0,
        };
        if !required && error_px < config.tolerance_px && contact_gain <= 0.0 && motion_gain <= 0.0 {
            cs.over_since.remove(key);
            continue;
        }
        let over_since = *cs.over_since.entry(*key).or_insert(tick);
        // The coarsest grid whose step stays under half the tolerance.
        let mut tier = 0u8;
        for t in (0..4u8).rev() {
            if POSITION_STEPS[t as usize] * px_per_m <= 0.5 * config.tolerance_px {
                tier = t;
                break;
            }
        }
        // Against the newest keyframe this client acked (when it still
        // keeps it), if that is smaller than absolute.
        let keyframe = Keyframe { tick, ..truth.keyframe };
        let incarnation = entry.map_or(0, BodyTrack::incarnation);
        let baseline = cs
            .acked
            .get(key)
            .filter(|b| b.tick >= incarnation && b.tick <= tick && tick - b.tick <= BASELINE_MAX_TICKS)
            .copied();
        let mut absolute = KeyframeRecord::absolute(*key, tier, keyframe);
        if truth.born > 0 && truth.born + INCARNATION_WINDOW >= tick {
            absolute.incarnation = Some(truth.born);
        }
        let mut record = PreparedRecord::new(absolute, physics);
        if baseline.is_some() {
            let delta = PreparedRecord::new(KeyframeRecord { baseline, ..absolute }, physics);
            if delta.bytes() < record.bytes() {
                record = delta;
            }
        }
        let bytes = record.bytes();
        let gain = if error_px.is_finite() {
            let screen = if error_px >= config.tolerance_px {
                model.penalty(ArtifactClass::ScreenError, f64::from(error_px), f64::from(weight)) as f32
            } else {
                0.0
            };
            // The correction this record will make is itself seen: the
            // client blends an error away over CORRECTION_TICKS frames, or
            // snaps it past SNAP_METRES. Its per-frame step is a pop
            // (class V2), and sending sooner keeps it smaller. Screen error
            // saturates (a body metres off scores like one a few pixels
            // off); the pop it will become does not.
            let correction = if config.correction_cost && error_px >= config.tolerance_px {
                let step_px = if error_px / error_px_per_m > vibe_land_perplayer::client::SNAP_METRES {
                    error_px
                } else {
                    error_px / vibe_land_perplayer::client::CORRECTION_TICKS
                };
                model.penalty(ArtifactClass::Pop, f64::from(step_px), f64::from(weight)) as f32
            } else {
                0.0
            };
            if config.age_priority {
                // The penalty this error costs per second, accrued since it
                // went over tolerance and for the send interval to come.
                // The scorer charges these only while the body is on screen
                // (V1, V2: visible items only); off screen or under a pixel
                // it costs nothing yet.
                let visible = on_screen(truth.keyframe.position) || drawn_now.is_some_and(|(p, _)| on_screen(p));
                let mut per_s = 0.0;
                if visible {
                    per_s += model.penalty(ArtifactClass::ScreenError, f64::from(error_px), 1.0) as f32;
                    let motion_px = motion_px.unwrap_or_else(motion);
                    if motion_px >= config.tolerance_px {
                        per_s += model.penalty(ArtifactClass::Pop, f64::from(motion_px), 1.0) as f32 * FRAMES_PER_SECOND;
                    }
                }
                let age_s = (tick - over_since.min(tick) + config.send_interval_ticks) as f32 / config.sim_hz as f32;
                per_s * age_s + correction + contact_gain
            } else {
                screen + correction + contact_gain + motion_gain
            }
        } else {
            f32::MAX
        };
        let priority = if required { f32::MAX } else { gain.max(1e-9) / bytes as f32 };
        candidates.push(Candidate { key: *key, bytes, priority, rank: rank_of.get(key).copied().unwrap_or(0), distance, record });
    }
    // Ranked by index: a candidate carries its prepared record, too large
    // to move about while sorting.
    let mut ranked: Vec<u32> = (0..candidates.len() as u32).collect();
    ranked.sort_unstable_by(|&a, &b| {
        let (a, b) = (&candidates[a as usize], &candidates[b as usize]);
        b.priority.total_cmp(&a.priority).then(a.rank.cmp(&b.rank)).then(a.key.cmp(&b.key))
    });
    let candidate_keys: Vec<BodyKey> = ranked.iter().map(|&i| candidates[i as usize].key).collect();
    // Event copies go first, out of the same allowance (they are what the
    // poses mean).
    let mut out = ClientSend::default();
    let mut used = 0usize;
    if budget != Some(SendBudget::Skip) {
        // Copies are an optimisation (the reliable stream carries every
        // event): one that does not fit the allowance is skipped, and uses
        // up that try, so they never queue up behind the original.
        for (bytes, left) in cs.event_copies.iter_mut() {
            if used + bytes.len() > allowance {
                *left -= 1;
                continue;
            }
            used += bytes.len();
            out.topology_bytes += bytes.len();
            out.packets.push(Outgoing::datagram(bytes.clone()));
            *left -= 1;
        }
        cs.event_copies.retain(|(_, left)| *left > 0);
    }
    let mut chosen: Vec<PreparedRecord> = Vec::new();
    // The datagrams' own headers count too: records are packed in this
    // order, a new datagram starting whenever the next one does not fit.
    let mut room = 0usize;
    for c in ranked.iter().map(|&i| &candidates[i as usize]) {
        let header = if c.bytes > room { DATAGRAM_HEADER } else { 0 };
        if used + header + c.bytes > allowance && c.priority < f32::MAX {
            continue;
        }
        if used + header + c.bytes > allowance {
            break;
        }
        if header > 0 {
            room = config.max_datagram - DATAGRAM_HEADER;
        }
        room -= c.bytes.min(room);
        used += header + c.bytes;
        if c.record.record.baseline.is_some() {
            stats.delta_records += 1;
        }
        stats.by_mode[c.record.record.keyframe.mode as usize] += 1;
        stats.bytes_by_mode[c.record.record.keyframe.mode as usize] += c.bytes as u64;
        let band = DISTANCE_BANDS_M.iter().position(|&d| c.distance < d).unwrap_or(DISTANCE_BANDS_M.len());
        stats.keyframes_by_distance[band] += 1;
        stats.bytes_by_distance[band] += c.bytes as u64;
        chosen.push(c.record);
    }
    // What lost the ranking is looked at again next send (the best of it,
    // up to half the cap).
    for r in &chosen {
        cs.over_since.remove(&r.record.key);
    }
    cs.hot.clear();
    if slices > 1 {
        let sent: HashSet<BodyKey> = chosen.iter().map(|r| r.record.key).collect();
        cs.hot.extend(candidate_keys.iter().filter(|k| !sent.contains(k)).take(config.eval_cap / 4));
    }
    stats.allowance_offered += allowance as u64;
    stats.allowance_used += used as u64;
    if used + MIN_RECORD_BYTES + DATAGRAM_HEADER < allowance && chosen.len() == candidates.len() {
        stats.sends_out_of_candidates += 1;
    }
    cs.sends_since_datagram += 1;
    if chosen.is_empty() {
        if cs.sends_since_datagram < config.heartbeat_sends {
            return out;
        }
        stats.heartbeats += 1;
    }
    // Pack into datagrams under the MTU.
    let mut start = 0;
    loop {
        let mut end = start;
        let mut bytes = DATAGRAM_HEADER;
        while end < chosen.len() && bytes + chosen[end].bytes() <= config.max_datagram {
            bytes += chosen[end].bytes();
            end += 1;
        }
        let records = &chosen[start..end];
        let ordinal = cs.ordinal;
        cs.ordinal += 1;
        let packet = encode_prepared(tick, ordinal, records);
        out.record_bytes += packet.len();
        out.packets.push(Outgoing::datagram(packet));
        let mut carried = Vec::with_capacity(records.len());
        for prepared in records {
            let record = &prepared.record;
            // The client derives the floor from the body at the decoded
            // pose; the truth's is that to within the quantisation.
            let decoded = Keyframe { floor_drop: record.keyframe.floor_drop, ..prepared.decoded(physics) };
            cs.believed.entry(record.key).or_default().add(decoded, arrival_render, physics);
            cs.unsent.remove(&record.key);
            carried.push((record.key, decoded));
            stats.keyframes_sent += 1;
        }
        cs.sent.push_back((ordinal, carried, 0));
        start = end;
        if start >= chosen.len() {
            break;
        }
    }
    cs.sends_since_datagram = 0;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_land_perplayer::wire::record_bytes;
    use crate::types::Camera;

    fn keyframe(tick: u32, position: Vec3, velocity: Vec3, mode: Mode) -> Keyframe {
        Keyframe {
            tick,
            position,
            rotation: Quat::IDENTITY,
            linear_velocity: velocity,
            angular_velocity: Vec3::ZERO,
            mode,
            decel: 0.0,
            floor_drop: None,
        }
    }

    /// Two bodies drawn metres from where they rest, past where the
    /// screen-error penalty saturates. One is drawn still, 8 m off; the
    /// other 4 m off but drawn sliding at 50 m/s, so every frame it stays
    /// unsent its displayed step disagrees with the truth's by tens of
    /// pixels: a pop each frame (V2), which the scorer counts. With room for
    /// one record, the sliding one is sent: its error alone ranks lower. (Adversarial round 3: a piece drawn sliding along the
    /// ground for 3 s, 70 m off, lost the ranking to bodies drawn still.)
    #[test]
    fn a_body_drawn_moving_wrongly_outranks_one_drawn_still_wrong() {
        let config = PerPlayerConfig { tolerance_px: 2.0, eval_cap: 0, event_copies: 0, motion_cost: true, ..PerPlayerConfig::validated(60) };
        let physics = Physics::at_hz(60, config.gravity_y);
        let model = PerceptualModel::literature();
        let camera = Camera { eye: Vec3::new(0.0, 1.6, 0.0), direction: Vec3::new(0.0, 0.0, -1.0), fov_degrees: 80.0 };
        let tick = 600;
        let still = BodyKey { structure: 1, body: 9 };
        let sliding = BodyKey { structure: 1, body: 10 };
        let rest_still = Vec3::new(-6.0, 0.5, -30.0);
        let rest_sliding = Vec3::new(6.0, 0.5, -30.0);
        let off = Vec3::new(0.0, 0.0, 4.0);
        let off_still = Vec3::new(0.0, 0.0, 8.0);
        let mut truths: FxHashMap<BodyKey, Truth> = FxHashMap::default();
        for (key, rest) in [(still, rest_still), (sliding, rest_sliding)] {
            truths.insert(key, Truth { keyframe: keyframe(tick, rest, Vec3::ZERO, Mode::Resting), radius: 0.5, settled: false, contact_tick: 0, born: 0 , ahead: None });
        }
        let mut cs = ClientState { rtt_ms: 60.0, ..Default::default() };
        let mut drawn_still = BodyTrack::default();
        drawn_still.restart(keyframe(tick - 120, rest_still + off_still, Vec3::ZERO, Mode::Resting));
        cs.believed.insert(still, drawn_still);
        // Drawn 4 m off now too, sliding away at 50 m/s.
        let v = Vec3::new(0.0, 0.0, 50.0);
        let mut drawn_sliding = BodyTrack::default();
        drawn_sliding.restart(keyframe(tick - 120, rest_sliding + off - v * 2.0, v, Mode::Sliding));
        cs.believed.insert(sliding, drawn_sliding);
        // Room for one record, not two (the finest grid is the largest).
        let record = record_bytes(&KeyframeRecord::absolute(sliding, 0, truths[&sliding].keyframe), physics);
        let one_record = DATAGRAM_HEADER + record + record / 2;
        let order: Vec<BodyKey> = vec![still, sliding];
        let mut stats = PerPlayerStats::default();
        send_for(
            config,
            physics,
            &truths,
            &FxHashMap::default(),
            &FxHashMap::default(),
            &order,
            &[],
            &model,
            &mut cs,
            &ClientView { camera },
            tick,
            Some(SendBudget::Limited { allowance_bytes: one_record, sends: 1 }),
            &mut stats,
        );
        let newest = |key: BodyKey| cs.believed[&key].newest().map(|k| k.tick);
        assert_eq!(stats.keyframes_sent, 1, "room for one record");
        assert_eq!(newest(sliding), Some(tick), "the body drawn sliding wrongly is the one sent");
        assert_eq!(newest(still), Some(tick - 120));
    }
}

#[cfg(test)]
mod drawn_near_tests {
    use super::*;
    use vibe_land_perplayer::wire::record_bytes;
    use crate::types::Camera;

    fn still(tick: u32, position: Vec3) -> Keyframe {
        Keyframe {
            tick,
            position,
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            mode: Mode::Resting,
            decel: 0.0,
            floor_drop: None,
        }
    }

    /// An error is seen where it is drawn. One body truly lies 90 m behind
    /// the camera but is drawn 6 m in front of it (it slid there on a stale
    /// keyframe); another lies 30 m ahead and is drawn 3 m from there. Judged
    /// by the truth's position alone, the first is behind the player (half
    /// weight) and far (few pixels per metre). On the client's screen it is
    /// in view and near, the larger error by far: the scorer sees the drawn
    /// box. With room for one record, it is the one sent. (Adversarial round
    /// 3: pieces drawn sliding past a player who had turned, their truth
    /// behind them, went unsent for 3 s.)
    #[test]
    fn an_error_drawn_in_view_counts_where_it_is_drawn() {
        let config = PerPlayerConfig { tolerance_px: 2.0, eval_cap: 0, event_copies: 0, drawn_view: true, ..PerPlayerConfig::validated(60) };
        let physics = Physics::at_hz(60, config.gravity_y);
        let model = PerceptualModel::literature();
        let eye = Vec3::new(0.0, 1.6, 0.0);
        let camera = Camera { eye, direction: Vec3::new(0.0, 0.0, -1.0), fov_degrees: 80.0 };
        let tick = 600;
        let mid = BodyKey { structure: 1, body: 9 };
        let near_drawn = BodyKey { structure: 1, body: 10 };
        let mut truths: FxHashMap<BodyKey, Truth> = FxHashMap::default();
        let mid_truth = Vec3::new(-2.0, 0.5, -30.0);
        let far_truth = Vec3::new(2.0, 0.5, 90.0);
        for (key, at) in [(mid, mid_truth), (near_drawn, far_truth)] {
            truths.insert(key, Truth { keyframe: still(tick, at), radius: 0.5, settled: false, contact_tick: 0, born: 0 , ahead: None });
        }
        let mut cs = ClientState { rtt_ms: 60.0, ..Default::default() };
        let mut drawn_mid = BodyTrack::default();
        drawn_mid.restart(still(tick - 120, mid_truth + Vec3::new(-3.0, 0.0, 0.0)));
        cs.believed.insert(mid, drawn_mid);
        let mut drawn_near = BodyTrack::default();
        drawn_near.restart(still(tick - 120, Vec3::new(1.5, 0.5, -6.0)));
        cs.believed.insert(near_drawn, drawn_near);
        let record = record_bytes(&KeyframeRecord::absolute(mid, 0, truths[&mid].keyframe), physics);
        let mut stats = PerPlayerStats::default();
        send_for(
            config,
            physics,
            &truths,
            &FxHashMap::default(),
            &FxHashMap::default(),
            &[mid, near_drawn],
            &[],
            &model,
            &mut cs,
            &ClientView { camera },
            tick,
            Some(SendBudget::Limited { allowance_bytes: DATAGRAM_HEADER + record + record / 2, sends: 1 }),
            &mut stats,
        );
        let newest = |key: BodyKey| cs.believed[&key].newest().map(|k| k.tick);
        assert_eq!(stats.keyframes_sent, 1, "room for one record");
        assert_eq!(newest(near_drawn), Some(tick), "the error drawn near the eye is the one sent");
        assert_eq!(newest(mid), Some(tick - 120));
    }
}

#[cfg(test)]
mod age_tests {
    use super::*;
    use vibe_land_perplayer::wire::record_bytes;
    use crate::types::Camera;

    fn still(tick: u32, position: Vec3) -> Keyframe {
        Keyframe {
            tick,
            position,
            rotation: Quat::IDENTITY,
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            mode: Mode::Resting,
            decel: 0.0,
            floor_drop: None,
        }
    }

    /// A body drawn moving wrongly costs the player a pop every frame (V2)
    /// for as long as it is left: the scorer's heaviest steady charge. Each
    /// send has room for one record, and a fresh error appears every send,
    /// larger on screen than the old one's offset. The old body is drawn
    /// sliding at 10 m/s on a stale keyframe while it truly rests; its record
    /// (a sliding keyframe) costs more bytes. Ranked by one send's worth of
    /// saturated penalty it loses every send. With the priority accumulator
    /// it is sent within a tenth of a second. (Adversarial round 3: a piece
    /// drawn sliding past a player for 3 s, 86 pops.)
    #[test]
    fn a_body_drawn_moving_wrongly_is_sent_within_a_tenth_of_a_second() {
        let config = PerPlayerConfig { tolerance_px: 2.0, eval_cap: 0, event_copies: 0, age_priority: true, ..PerPlayerConfig::validated(60) };
        let physics = Physics::at_hz(60, config.gravity_y);
        let model = PerceptualModel::literature();
        let camera = Camera { eye: Vec3::new(0.0, 1.6, 0.0), direction: Vec3::new(0.0, 0.0, -1.0), fov_degrees: 80.0 };
        let old = BodyKey { structure: 1, body: 1 };
        let start = 600u32;
        let mut truths: FxHashMap<BodyKey, Truth> = FxHashMap::default();
        let mut cs = ClientState { rtt_ms: 60.0, ..Default::default() };
        let old_at = Vec3::new(0.0, 0.5, -15.0);
        truths.insert(old, Truth { keyframe: still(start, old_at), radius: 0.5, settled: false, contact_tick: 0, born: 0 , ahead: None });
        let mut drawn = BodyTrack::default();
        // Drawn half a metre off now, sliding sideways at 10 m/s.
        let v = Vec3::new(10.0, 0.0, 0.0);
        let mut slide = still(start - 60, old_at + Vec3::new(0.5, 0.0, 0.0) - v * 1.0);
        slide.linear_velocity = v;
        slide.mode = Mode::Sliding;
        drawn.restart(slide);
        cs.believed.insert(old, drawn);
        let record = record_bytes(&KeyframeRecord::absolute(old, 0, truths[&old].keyframe), physics);
        let mut sent_at = None;
        for i in 0..60u32 {
            let tick = start + i;
            // The truth rests where the old body is drawn sliding past.
            // A fresh error: drawn 3 m off, 20 m away (larger on screen).
            let fresh = BodyKey { structure: 2, body: i };
            let at = Vec3::new(-4.0 + 0.1 * i as f32, 0.5, -20.0);
            truths.insert(fresh, Truth { keyframe: still(tick, at), radius: 0.5, settled: false, contact_tick: 0, born: 0 , ahead: None });
            let mut track = BodyTrack::default();
            track.restart(still(tick - 30, at + Vec3::new(3.0, 0.0, 0.0)));
            cs.believed.insert(fresh, track);
            for t in truths.values_mut() {
                t.keyframe.tick = tick;
            }
            let order: Vec<BodyKey> = truths.keys().copied().collect();
            let mut stats = PerPlayerStats::default();
            send_for(
                config,
                physics,
                &truths,
                &FxHashMap::default(),
                &FxHashMap::default(),
                &order,
                &[],
                &model,
                &mut cs,
                &ClientView { camera },
                tick,
                Some(SendBudget::Limited { allowance_bytes: DATAGRAM_HEADER + record + record / 2, sends: 1 }),
                &mut stats,
            );
            if cs.believed[&old].newest().is_some_and(|k| k.tick >= start) {
                sent_at = Some(i);
                break;
            }
            // Whatever was sent is now right: drop it from the contest.
            truths.retain(|k, _| cs.believed[k].newest().is_some_and(|n| n.tick < tick) || *k == old);
        }
        let sent_at = sent_at.expect("the old error is never sent");
        assert!(sent_at < 6, "sent after {sent_at} sends");
    }
}

#[cfg(test)]
mod knob_tests {
    use super::*;

    #[test]
    fn knobs_parse_by_the_labs_names_and_reject_unknown_ones() {
        let mut c = PerPlayerConfig::validated(60);
        c.apply_knobs("age_priority=1, pp.drawn_view=1,send_threads=8,tolerance_px=2").unwrap();
        assert!(c.age_priority && c.drawn_view);
        assert_eq!(c.send_threads, 8);
        assert_eq!(c.tolerance_px, 2.0);
        assert!(c.apply_knobs("no_such=1").is_err());
        assert!(c.apply_knobs("age_priority").is_err());
    }
}

#[cfg(test)]
mod sunk_tests {
    use super::*;

    /// The bounded G4 test is the full one: drawn poses from on the truth
    /// to well past the tolerance, around tilted boxes, across cell
    /// boundaries and on the ground, for one-chunk and many-chunk bodies.
    #[test]
    fn the_bounded_g4_test_answers_as_the_full_depth_does() {
        let mut seed = 0x9e3779b97f4a7c15u64;
        let mut rand = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / (1u64 << 24) as f32
        };
        let mut statics: FxHashMap<(i32, i32, i32), Vec<(u32, StaticBox)>> = FxHashMap::default();
        for i in 0..60 {
            let b = StaticBox {
                position: Vec3::new(rand() * 24.0 - 12.0, rand() * 6.0, rand() * 24.0 - 12.0),
                rotation: Quat::from_rotation_y(rand() * 0.6) * Quat::from_rotation_x(rand() * 0.2),
                half_extents: Vec3::new(0.2 + rand(), 0.2 + rand(), 0.2 + rand()),
            };
            let r = b.half_extents.length();
            let lo = ((b.position - Vec3::splat(r)) / STATIC_CELL).floor();
            let hi = ((b.position + Vec3::splat(r)) / STATIC_CELL).floor();
            for x in lo.x as i32..=hi.x as i32 {
                for y in lo.y as i32..=hi.y as i32 {
                    for z in lo.z as i32..=hi.z as i32 {
                        statics.entry((x, y, z)).or_default().push((i, b));
                    }
                }
            }
        }
        let (mut fired, mut checked) = (0, 0);
        for case in 0..20_000 {
            let chunks: Vec<(Vec3, f32)> = (0..if case % 3 == 0 { 12 } else { 1 })
                .map(|_| (Vec3::new(rand() - 0.5, rand() - 0.5, rand() - 0.5) * 3.0, 0.1 + rand() * 0.4))
                .collect();
            let extent = chunks.iter().map(|&(o, r)| o.length() + r).fold(0.0f32, f32::max);
            let shape = BodyShape { members: chunks.len(), chunks, extent };
            let truth = (
                Vec3::new(rand() * 24.0 - 12.0, rand() * 5.0 - 0.3, rand() * 24.0 - 12.0),
                Quat::from_euler(glam::EulerRot::XYZ, rand() * 6.3, rand() * 6.3, rand() * 6.3),
            );
            let size = [0.0, 0.01, 0.04, 0.045, 0.06, 0.3, 2.0][case % 7];
            let drawn = (
                truth.0 + Vec3::new(rand() - 0.5, rand() - 0.5, rand() - 0.5) * size,
                (Quat::from_rotation_z((rand() - 0.5) * size) * truth.1).normalize(),
            );
            for solids in [Some(&statics), None] {
                let truth_depth = solid_depth(&shape, truth.0, truth.1, solids);
                let full = solid_depth(&shape, drawn.0, drawn.1, solids) - truth_depth.max(0.0) > crate::netlab::perceptual::G4_TOLERANCE_M;
                assert_eq!(sunk_deeper(&shape, drawn, truth, truth_depth, solids), full, "case {case}");
                fired += usize::from(full);
                checked += 1;
            }
        }
        // Both answers occur often enough to mean something.
        assert!(fired > 1_000 && checked - fired > 20_000, "{fired} of {checked}");
    }
}

#[cfg(test)]
mod fracture_scale_tests {
    use super::*;
    use crate::manifest::{BondDef, ChunkDef, ChunkGeometry, StructureManifest};
    use crate::topology::CityLedger;
    use vibe_netcode::destruction_backend::{FractureBatch, IslandPromotion};

    /// A standing block `nx` x `ny` x `nz` of 1 m chunks, the bottom layer
    /// supports, each chunk bonded to its six neighbours.
    fn block(nx: u32, ny: u32, nz: u32) -> DestructionManifest {
        let id = |x: u32, y: u32, z: u32| (y * nz + z) * nx + x;
        let mut chunks = Vec::new();
        for y in 0..ny {
            for z in 0..nz {
                for x in 0..nx {
                    chunks.push(ChunkDef {
                        node_index: id(x, y, z),
                        centroid: [x as f32, y as f32 + 0.5, z as f32],
                        mass: if y == 0 { 0.0 } else { 1.0 },
                        volume: 1.0,
                        size: [1.0, 1.0, 1.0],
                        geometry: ChunkGeometry::Cuboid { half_extents: [0.5, 0.5, 0.5] },
                        radius: 0.87,
                        support: y == 0,
                        material: 0,
                        mass_offset: [0.0; 3],
                    });
                }
            }
        }
        let mut bonds = Vec::new();
        let mut bond = |a: u32, b: u32, bonds: &mut Vec<BondDef>| {
            bonds.push(BondDef { bond_index: bonds.len() as u32, node0: a, node1: b, centroid: [0.0; 3], normal: [0.0, 1.0, 0.0], area: 1.0, material: 0 });
        };
        for y in 0..ny {
            for z in 0..nz {
                for x in 0..nx {
                    if x + 1 < nx {
                        bond(id(x, y, z), id(x + 1, y, z), &mut bonds);
                    }
                    if y + 1 < ny {
                        bond(id(x, y, z), id(x, y + 1, z), &mut bonds);
                    }
                    if z + 1 < nz {
                        bond(id(x, y, z), id(x, y, z + 1), &mut bonds);
                    }
                }
            }
        }
        DestructionManifest {
            version: crate::manifest::MANIFEST_VERSION,
            structures: vec![StructureManifest { structure_id: 0, world_position: [0.0; 3], world_rotation: [0.0, 0.0, 0.0, 1.0], chunks, bonds }],
            materials: Vec::new(),
            material_appearance: Vec::new(),
            shape_library: Vec::new(),
        }
    }

    /// Per tick, one 2x2x2 piece of the block knocked loose (its bonds
    /// broken, the physics' promotion of it), walking the block a piece at a
    /// time; only the newest piece is awake (the rest lie asleep). Returns
    /// the mean ingest per tick over the last `measured` ticks, ms.
    fn knock_pieces_off(nx: u32, ny: u32, nz: u32, ticks: u32, measured: u32) -> f64 {
        let manifest = block(nx, ny, nz);
        let mut pp = PerPlayer::new(&manifest, CityLedger::from_manifest(&manifest), PerPlayerConfig::validated(60));
        pp.add_client(1);
        let structure = &manifest.structures[0];
        let (px, pz) = (nx / 2, nz / 2);
        let mut spent = std::time::Duration::ZERO;
        for tick in 1..=ticks {
            let k = tick - 1;
            // Top down, so every piece is cut from standing chunks.
            let (x0, z0, y0) = ((k % px) * 2, ((k / px) % pz) * 2, ny - 2 - (k / (px * pz)) * 2);
            assert!(y0 >= 2, "the block has room for {ticks} pieces");
            let inside = |n: u32| {
                let (x, y, z) = (n % nx, n / (nx * nz), (n / nx) % nz);
                x >= x0 && x < x0 + 2 && z >= z0 && z < z0 + 2 && y >= y0 && y < y0 + 2
            };
            let mut broken: Vec<u32> = Vec::new();
            let mut nodes: Vec<u32> = Vec::new();
            for y in y0.saturating_sub(1)..(y0 + 3).min(ny) {
                for z in z0.saturating_sub(1)..(z0 + 3).min(nz) {
                    for x in x0.saturating_sub(1)..(x0 + 3).min(nx) {
                        let n = (y * nz + z) * nx + x;
                        if inside(n) {
                            nodes.push(n);
                        }
                    }
                }
            }
            nodes.sort_unstable();
            for b in &structure.bonds {
                if inside(b.node0) != inside(b.node1) && (nodes.binary_search(&b.node0).is_ok() || nodes.binary_search(&b.node1).is_ok()) {
                    broken.push(ids::bond_id(0, b.bond_index));
                }
            }
            let centre = [x0 as f32 + 0.5, y0 as f32 + 1.5, z0 as f32 + 0.5];
            let output = DestructionTickOutput {
                batches: vec![FractureBatch {
                    structure_id: 0,
                    broken_bond_ids: broken,
                    migrations: Vec::new(),
                    promoted_islands: vec![IslandPromotion {
                        structure_id: 0,
                        island_id: tick,
                        chunks: nodes.iter().map(|&n| ids::chunk_id(0, n)).collect(),
                        mass: 8.0,
                        center_of_mass: centre,
                        inertia_diagonal: [1.0; 3],
                        position: centre,
                        rotation: [0.0, 0.0, 0.0, 1.0],
                        linear_velocity: [0.0, -1.0, 0.0],
                        angular_velocity: [0.0; 3],
                        split_impulse: [0.0; 3],
                    }],
                    retired_island_ids: Vec::new(),
                }],
                ..Default::default()
            };
            let snapshots = [BodySnapshotInput {
                body_entity: ids::body_entity(0, tick),
                position: centre,
                rotation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity: [0.0, -1.0, 0.0],
                angular_velocity: [0.0; 3],
                contacts: 0,
                flags: 0,
            }];
            let started = std::time::Instant::now();
            pp.ingest_tick(tick, &snapshots, &output);
            if tick > ticks - measured {
                spent += started.elapsed();
            }
        }
        assert_eq!(pp.stats.fractures, u64::from(ticks));
        assert_eq!(pp.stats.derive_mismatches, 0, "the derivation agrees with the promotions");
        spent.as_secs_f64() * 1000.0 / f64::from(measured)
    }

    /// An object authored loose (no support in its own component, like
    /// Vibe Town's benches and planters) is a body awaiting its island when
    /// the match starts, not chunks the physics crushed: the physics
    /// promotes it on its first tick. Marked removed, it vanished for every
    /// wire-4 client and the derive check disagreed from the first tick on
    /// (live session 2026-10-11: 8 objects, 234 chunks).
    #[test]
    fn an_object_authored_loose_is_a_body_awaiting_its_island_not_crushed() {
        let mut manifest = block(3, 3, 3);
        // A loose 2-chunk bench beside the block: bonded to itself only.
        let structure = &mut manifest.structures[0];
        let first = structure.chunks.len() as u32;
        for (i, x) in [5.0f32, 6.0].into_iter().enumerate() {
            let mut chunk = structure.chunks[1].clone();
            chunk.node_index = first + i as u32;
            chunk.centroid = [x, 0.5, 0.0];
            chunk.support = false;
            chunk.mass = 1.0;
            structure.chunks.push(chunk);
        }
        let bond = structure.bonds.len() as u32;
        structure.bonds.push(BondDef { bond_index: bond, node0: first, node1: first + 1, centroid: [5.5, 0.5, 0.0], normal: [1.0, 0.0, 0.0], area: 1.0, material: 0 });
        let mut pp = PerPlayer::new(&manifest, CityLedger::from_manifest(&manifest), PerPlayerConfig::validated(60));
        assert_eq!(pp.states[&0].body_of(first), first, "a body named by its lowest chunk, not removed");
        // The physics' first tick promotes it, with no bond broken.
        let promotion = IslandPromotion {
            structure_id: 0,
            island_id: 1,
            chunks: vec![ids::chunk_id(0, first), ids::chunk_id(0, first + 1)],
            rotation: [0.0, 0.0, 0.0, 1.0],
            ..Default::default()
        };
        let batch = FractureBatch { structure_id: 0, promoted_islands: vec![promotion], ..Default::default() };
        pp.ingest_tick(1, &[], &DestructionTickOutput { batches: vec![batch], ..Default::default() });
        assert_eq!(pp.stats.derive_mismatches, 0);
        assert_eq!(pp.states[&0].members(first), Some(&[first, first + 1][..]));
        assert!(!pp.states[&0].is_removed(first));
    }

    /// The island mirror follows the ledger exactly, the derive check counts
    /// what a full recount does, and every chunk on a dynamic body yet on no
    /// island is one the next crush pass will look at: random breaks,
    /// promotions of any chunks, migrations (some to islands that do not
    /// exist) and retirements, batch after batch.
    #[test]
    fn the_island_mirror_and_crush_candidates_match_a_full_recount() {
        use vibe_netcode::destruction_backend::ShapeMigration;
        let (nx, ny, nz) = (6, 6, 5);
        let manifest = block(nx, ny, nz);
        let n = nx * ny * nz;
        let mut seed = 0x51ed_270b_c0ffee11u64;
        let mut rand = move |m: u32| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % u64::from(m.max(1))) as u32
        };
        for _ in 0..12 {
            let mut pp = PerPlayer::new(&manifest, CityLedger::from_manifest(&manifest), PerPlayerConfig::validated(60));
            let mut next_serial = 1u32;
            for tick in 1..60u32 {
                let bonds = manifest.structures[0].bonds.len() as u32;
                let mut batch = FractureBatch { structure_id: 0, ..Default::default() };
                batch.broken_bond_ids = (0..rand(6)).map(|_| ids::bond_id(0, rand(bonds))).collect();
                // Promote a derived body as it is now, or a random handful.
                for _ in 0..rand(3) {
                    let state = &pp.states[&0];
                    let bodies: Vec<&Vec<u32>> = state.bodies().values().collect();
                    let chunks: Vec<u32> = if !bodies.is_empty() && rand(2) == 0 {
                        bodies[rand(bodies.len() as u32) as usize].clone()
                    } else {
                        (0..1 + rand(5)).map(|_| rand(n)).collect()
                    };
                    batch.promoted_islands.push(IslandPromotion {
                        structure_id: 0,
                        island_id: next_serial,
                        chunks: chunks.iter().map(|&c| ids::chunk_id(0, c)).collect(),
                        rotation: [0.0, 0.0, 0.0, 1.0],
                        ..Default::default()
                    });
                    next_serial += 1;
                }
                for _ in 0..rand(3) {
                    batch.migrations.push(ShapeMigration {
                        chunk_id: ids::chunk_id(0, rand(n)),
                        from_island_id: 1 + rand(next_serial),
                        to_island_id: 1 + rand(next_serial + 3),
                    });
                }
                if rand(4) == 0 {
                    batch.retired_island_ids.push(1 + rand(next_serial));
                }
                pp.ingest_tick(tick, &[], &DestructionTickOutput { batches: vec![batch], ..Default::default() });

                let (ledger, state, mirror) = (&pp.ledger, &pp.states[&0], &pp.mirrors[&0]);
                let mut index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
                let mut mismatched = 0;
                for (&serial, island) in ledger.structure_islands(0).into_iter().flatten() {
                    for &c in &island.nodes {
                        index.entry(c).or_default().push(serial);
                    }
                    assert_eq!(mirror.nodes_of.get(&serial), Some(&island.nodes), "tick {tick}: island {serial}");
                    if let Some(&min) = island.nodes.first() {
                        mismatched += usize::from(state.members(min) != Some(island.nodes.as_slice()));
                        assert_eq!(pp.serial_body.get(&(0, serial)), Some(&min));
                    }
                }
                let mut mirrored = mirror.islands_with.clone();
                for list in mirrored.values_mut().chain(index.values_mut()) {
                    list.sort_unstable();
                }
                assert_eq!(mirrored, index, "tick {tick}");
                assert_eq!(mirror.mismatched.len(), mismatched, "tick {tick}");
                for c in pp.removed_nodes(0, state) {
                    assert!(mirror.pending.contains(&c), "tick {tick}: chunk {c} is dynamic on no island, unlisted");
                }
            }
        }
    }

    /// A fracture's server-side cost follows what it breaks, not the size of
    /// the structure it breaks off (Vibe Town: one structure of 51,921
    /// chunks). The same pieces knocked off a block 8 times larger must not
    /// cost several times as much. (Before: 0.13 vs 0.17 ms, and 0.95 ms
    /// with 2,000 bodies about; every body's centre of mass, a SipHash set
    /// of every island chunk and every chunk scanned, per fracture.) Timing, so run alone:
    /// `cargo test --release -p vibe-land-destruction --lib fracture_scale -- --ignored`.
    #[test]
    #[ignore]
    fn a_fracture_costs_what_it_breaks_not_the_structure() {
        // The same 400 pieces off a 6,600- and a 51,200-chunk block; then
        // 2,000 pieces off the large one (five times the bodies lying about).
        let small = knock_pieces_off(10, 66, 10, 400, 100);
        let large = knock_pieces_off(40, 32, 40, 400, 100);
        let crowded = knock_pieces_off(40, 32, 40, 2_000, 100);
        println!("ingest per fracture tick: 6,600 chunks {small:.3} ms, 51,200 chunks {large:.3} ms, with 2,000 bodies {crowded:.3} ms");
        assert!(large < 1.5 * small + 0.02, "structure size: {large:.3} ms vs {small:.3} ms");
        // Still one pass over the debris's islands per fracture (the derive
        // check, the crushed-chunk test): linear in the bodies lying about,
        // never worse (it was 5.5x for 5x before).
        assert!(crowded < 5.0 * large, "bodies: {crowded:.3} ms vs {large:.3} ms");
    }
}
