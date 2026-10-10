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
    decoded, encode_bootstrap, encode_events, encode_keyframes, quantised, record_bytes, BodyKey, Bootstrap,
    BootstrapStructure, Event, KeyframePacket, KeyframeRecord, POSITION_STEPS,
};
use vibe_netcode::destruction_backend::DestructionTickOutput;

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
    /// At most about this many bodies evaluated per client per send (0: no
    /// cap). Past it, a rotating slice plus the bodies that cannot wait.
    pub eval_cap: usize,
    /// Evaluations per send across every client (0: none): each client's
    /// cap is the smaller of `eval_cap` and this shared among the clients,
    /// so the server's work per send stops growing with players.
    pub eval_budget: usize,
}

impl PerPlayerConfig {
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
            drawn_view: false,
            age_priority: false,
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
    recent_contacts: Vec<BodyKey>,
    config: PerPlayerConfig,
    model: PerceptualModel,
    physics: Physics,
    defs: BTreeMap<u32, StructureDef>,
    states: BTreeMap<u32, StructureState>,
    chunk_radius: BTreeMap<u32, Vec<f32>>,
    ledger: CityLedger,
    serial_body: HashMap<(u32, u32), u32>,
    truth: FxHashMap<BodyKey, Truth>,
    /// Each awake body's last `BACKTEST_TICKS` + 1 truth states, for the
    /// mode backtest.
    history: FxHashMap<BodyKey, VecDeque<Keyframe>>,
    event_seq: u32,
    clients: BTreeMap<u64, ClientState>,
    tick: u32,
    pub stats: PerPlayerStats,
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
            serial_body: HashMap::new(),
            truth: FxHashMap::default(),
            now_tick: 0,
            order: Vec::new(),
            in_order: FxHashSet::default(),
            recent_contacts: Vec::new(),
            history: FxHashMap::default(),
            event_seq: 0,
            clients: BTreeMap::new(),
            tick: 0,
            stats: PerPlayerStats::default(),
        };
        // A capture that starts mid-match: derive the structure from the
        // ledger's bonds and islands, as a joining client would from bits.
        for (&id, def) in &this.defs {
            let state = states.get_mut(&id).unwrap();
            let broken: Vec<u32> = (0..def.bonds.len() as u32).filter(|&b| !this.ledger_bond_alive(id, b)).collect();
            state.apply(def, &broken, &[]);
            let removed = this.removed_nodes(id, state);
            state.apply(def, &[], &removed);
            for (_, island) in this.ledger.structure_islands(id).into_iter().flatten() {
                if let Some(&min) = island.nodes.first() {
                    let key = BodyKey { structure: id, body: min };
                    let radius = this.radius_of(id, state, min);
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

    /// Nodes on a dynamic derived body that are on no physics island: the
    /// physics removed them without breaking their bonds.
    fn removed_nodes(&self, structure: u32, state: &StructureState) -> Vec<u32> {
        let mut on_island: HashSet<u32> = HashSet::new();
        for island in self.ledger.structure_islands(structure).into_iter().flat_map(|m| m.values()) {
            on_island.extend(island.nodes.iter().copied());
        }
        let n = self.defs[&structure].node_count();
        (0..n)
            .filter(|&node| {
                let body = state.body_of(node);
                body != ANCHORED && body != REMOVED && !on_island.contains(&node)
            })
            .collect()
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
            self.refresh_serials(id);
        }
    }

    /// Map the physics' island serials to derived body ids, and count any
    /// island the derivation disagrees with.
    fn refresh_serials(&mut self, structure: u32) {
        let state = &self.states[&structure];
        self.serial_body.retain(|(s, _), _| *s != structure);
        for (&serial, island) in self.ledger.structure_islands(structure).into_iter().flatten() {
            let Some(&min) = island.nodes.first() else { continue };
            if state.members(min) != Some(island.nodes.as_slice()) {
                self.stats.derive_mismatches += 1;
            }
            self.serial_body.insert((structure, serial), min);
        }
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
        let steps: Vec<&Keyframe> = history.iter().rev().take(2).collect();
        let mut supported = steps.len() == 2;
        let mut later = now;
        for earlier in steps {
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
        self.clients.insert(client, state);
        vec![Outgoing::reliable(encode_bootstrap(&boot))]
    }

    fn ingest_tick(&mut self, tick: u32, active: &[BodySnapshotInput], output: &DestructionTickOutput) -> Vec<Outgoing> {
        self.tick = tick;
        let mut events: Vec<Event> = Vec::new();
        // The bodies this tick's events change: re-sent to a client that
        // received the events after its drawing had passed them.
        let mut touched: Vec<BodyKey> = Vec::new();
        self.now_tick = tick;
        for batch in &output.batches {
            self.ledger.apply_batch(batch);
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
            let truth_parents: HashMap<u32, Truth> =
                state.bodies().keys().filter_map(|&b| self.truth.get(&BodyKey { structure, body: b }).map(|t| (b, *t))).collect();
            let parent_coms: HashMap<u32, Vec3> =
                state.bodies().keys().map(|&b| (b, state.centre_of_mass(def, b))).collect();
            let mut change = state.apply(def, &broken, &[]);
            let removed = self.removed_nodes(structure, &state);
            if !removed.is_empty() {
                let more = state.apply(def, &[], &removed);
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
                self.refresh_serials(structure);
                continue;
            }
            self.stats.fractures += 1;
            self.stats.removed_chunks += removed.len() as u64;
            events.push(Event::Fracture { tick, structure, broken_bonds: broken, removed_chunks: removed });
            for id in &change.retired_bodies {
                self.truth.remove(&BodyKey { structure, body: *id });
            }
            // The new bodies' truth: the physics' own promotion (pose and
            // velocities in the new body's centre-of-mass frame), from the
            // ledger. A body the physics did not promote this tick (asleep,
            // re-keyed) is where its chunks were: its parent's frame moved to
            // its own centre of mass.
            let islands: HashMap<u32, (Vec3, Quat, Vec3, Vec3, bool)> = self
                .ledger
                .structure_islands(structure)
                .into_iter()
                .flatten()
                .filter_map(|(_, i)| {
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
                self.truth.insert(key, Truth { keyframe, radius, settled, contact_tick: 0, born });
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
            let mut models: Vec<&mut ClientState> = self.clients.values_mut().collect();
            let threads = (self.config.send_threads.max(1) as usize).min(models.len().max(1));
            if threads <= 1 {
                models.into_iter().for_each(update);
            } else {
                let per = models.len().div_ceil(threads);
                std::thread::scope(|scope| {
                    for part in models.chunks_mut(per) {
                        let update = &update;
                        scope.spawn(move || part.iter_mut().for_each(|cs| update(cs)));
                    }
                });
            }
            self.states.insert(structure, state);
            self.refresh_serials(structure);
        }
        // Each awake body's keyframe, mode, floor and contact: a pure
        // function of its snapshot and its history so far, so it runs on
        // `send_threads` workers (byte-identical to one); the history and
        // truth are then updated in order.
        let work: Vec<(BodyKey, &BodySnapshotInput)> = active
            .iter()
            .filter_map(|snapshot| {
                let (structure, serial) = ids::body_entity_parts(snapshot.body_entity);
                let &body = self.serial_body.get(&(structure, serial))?;
                Some((BodyKey { structure, body }, snapshot))
            })
            .collect();
        let classify = |&(key, snapshot): &(BodyKey, &BodySnapshotInput)| -> (BodyKey, Truth, bool) {
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
            if let (Some(state), Some(def)) = (self.states.get(&key.structure), self.defs.get(&key.structure)) {
                keyframe.floor_drop = state.floor_drop(def, key.body, keyframe.position, keyframe.rotation);
            }
            (key, Truth { keyframe, radius, settled: false, contact_tick, born: previous.map_or(0, |p| p.born) }, continuous)
        };
        let threads = (self.config.send_threads.max(1) as usize).min(work.len().max(1));
        let classified: Vec<(BodyKey, Truth, bool)> = if threads <= 1 || work.len() < 256 {
            work.iter().map(classify).collect()
        } else {
            let per = work.len().div_ceil(threads);
            std::thread::scope(|scope| {
                let handles: Vec<_> = work.chunks(per).map(|part| scope.spawn(|| part.iter().map(classify).collect::<Vec<_>>())).collect();
                handles.into_iter().flat_map(|h| h.join().expect("per-player ingest worker")).collect()
            })
        };
        for (key, truth, continuous) in classified {
            let history = self.history.entry(key).or_default();
            if !continuous {
                history.clear();
            }
            history.push_back(truth.keyframe);
            while history.len() > BACKTEST_TICKS as usize + 1 {
                history.pop_front();
            }
            self.truth.insert(key, truth);
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
        let cap = self.effective_config().eval_cap;
        // The body order sends slice (insertion order, new bodies sorted
        // in), and the bodies with a contact recent enough that a slice may
        // not have reached them yet. Only needed past the evaluation cap.
        if cap == 0 || self.truth.len() <= cap {
            return;
        }
        let window = (self.truth.len().div_ceil((cap / 2).max(1)) as u32 * self.config.send_interval_ticks.max(1)).max(1);
        let mut fresh: Vec<BodyKey> = Vec::new();
        self.recent_contacts.clear();
        for (key, truth) in &self.truth {
            if !self.in_order.contains(key) {
                fresh.push(*key);
            }
            if truth.contact_tick > 0 && truth.contact_tick + window >= tick {
                self.recent_contacts.push(*key);
            }
        }
        fresh.sort_unstable();
        // Freshest first: sends take them in this order, up to a share of
        // the evaluation cap.
        let truth = &self.truth;
        self.recent_contacts.sort_unstable_by(|a, b| truth[b].contact_tick.cmp(&truth[a].contact_tick).then(a.cmp(b)));
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
        send_for(config, self.physics, &self.truth, &self.order, &self.recent_contacts, &self.model, cs, view, tick, budget, &mut self.stats)
    }

    fn client_sends(&mut self, requests: &[SendRequest]) -> Vec<ClientSend> {
        let threads = self.config.send_threads.max(1) as usize;
        if threads == 1 || requests.len() < 2 {
            return requests.iter().map(|r| self.client_send(r.client, &r.view, r.tick, r.budget)).collect();
        }
        // Each client's state is its own: hand disjoint sets to workers.
        let config = self.effective_config();
        let index: HashMap<u64, usize> = requests.iter().enumerate().map(|(i, r)| (r.client, i)).collect();
        let mut jobs: Vec<(usize, &mut ClientState)> =
            self.clients.iter_mut().filter_map(|(id, cs)| index.get(id).map(|&i| (i, cs))).collect();
        jobs.sort_by_key(|j| j.0);
        let (physics, truth, model) = (self.physics, &self.truth, &self.model);
        let (order, recent) = (&self.order[..], &self.recent_contacts[..]);
        let per = jobs.len().div_ceil(threads).max(1);
        let parts: Vec<(Vec<(usize, ClientSend)>, PerPlayerStats)> = std::thread::scope(|scope| {
            let handles: Vec<_> = jobs
                .chunks_mut(per)
                .map(|part| {
                    scope.spawn(move || {
                        let mut stats = PerPlayerStats::default();
                        let sends = part
                            .iter_mut()
                            .map(|(i, cs)| {
                                let r = &requests[*i];
                                (*i, send_for(config, physics, truth, order, recent, model, cs, &r.view, r.tick, r.budget, &mut stats))
                            })
                            .collect();
                        (sends, stats)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().expect("per-player send worker")).collect()
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
    order: &[BodyKey],
    recent_contacts: &[BodyKey],
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
        record: KeyframeRecord,
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
        for key in recent_contacts {
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
    for key in &evaluate {
        let truth = &truths[key];
        let required = cs.unsent.contains(key);
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
        let drawn_now = cs
            .believed
            .get(key)
            .filter(|t| config.drawn_view && !t.keyframes().is_empty())
            .map(|t| t.pose_at(r, physics));
        let (error_px_per_m, weight) = match drawn_now.map(|(p, _)| scale_at(p)) {
            Some((d_scale, d_weight)) if d_weight > truth_weight => (d_scale, d_weight),
            Some((d_scale, d_weight)) if d_weight == truth_weight => (d_scale.max(px_per_m), d_weight),
            _ => (px_per_m, truth_weight),
        };
        // The drawn motion against the truth's, one frame's step on screen.
        let motion_px = match cs.believed.get(key) {
            Some(track) if (config.motion_cost || config.age_priority) && !track.keyframes().is_empty() => {
                let frame_ticks = config.sim_hz as f32 / FRAMES_PER_SECOND;
                let (p0, q0) = track.pose_at(r, physics);
                let (p1, q1) = track.pose_at(r + frame_ticks, physics);
                let (t1, tq1) = vibe_land_perplayer::predict::predict(&truth.keyframe, frame_ticks, physics);
                let drawn_turn = 2.0 * q0.dot(q1).abs().min(1.0).acos();
                let true_turn = 2.0 * truth.keyframe.rotation.dot(tq1).abs().min(1.0).acos();
                (((p1 - p0) - (t1 - truth.keyframe.position)).length() + truth.radius * (drawn_turn - true_turn).abs()) * error_px_per_m
            }
            _ => 0.0,
        };
        let motion_gain = if config.motion_cost && motion_px >= config.tolerance_px {
            let frames = config.send_interval_ticks as f32 * FRAMES_PER_SECOND / config.sim_hz as f32;
            model.penalty(ArtifactClass::Pop, f64::from(motion_px), f64::from(weight)) as f32 * frames
        } else {
            0.0
        };
        let error_px = match cs.believed.get(key) {
            Some(track) if !track.keyframes().is_empty() => {
                // Now, and a horizon ahead: the client's drawing then
                // against the server's best prediction of the truth then
                // (the keyframe's own mode). Raw velocity gaps would count
                // contact noise as error nobody will see.
                let gap = |(p, q): (Vec3, Quat), (tp, tq): (Vec3, Quat)| {
                    let angle = 2.0 * q.dot(tq).abs().min(1.0).acos();
                    (p - tp).length() + truth.radius * angle.min(1.0)
                };
                let now = gap(track.pose_at(r, physics), (truth.keyframe.position, truth.keyframe.rotation));
                let ahead = gap(
                    track.pose_at(r + config.horizon_ticks, physics),
                    vibe_land_perplayer::predict::predict(&truth.keyframe, config.horizon_ticks, physics),
                );
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
        let contact_gain = match cs.believed.get(key).and_then(|t| t.newest()) {
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
        let incarnation = cs.believed.get(key).map_or(0, BodyTrack::incarnation);
        let baseline = cs
            .acked
            .get(key)
            .filter(|b| b.tick >= incarnation && b.tick <= tick && tick - b.tick <= BASELINE_MAX_TICKS)
            .copied();
        let mut absolute = KeyframeRecord::absolute(*key, tier, keyframe);
        if truth.born > 0 && truth.born + INCARNATION_WINDOW >= tick {
            absolute.incarnation = Some(truth.born);
        }
        let mut record = absolute;
        let mut bytes = record_bytes(&absolute, physics);
        if baseline.is_some() {
            let delta = KeyframeRecord { baseline, ..absolute };
            let delta_bytes = record_bytes(&delta, physics);
            if delta_bytes < bytes {
                record = delta;
                bytes = delta_bytes;
            }
        }
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
    candidates.sort_by(|a, b| b.priority.total_cmp(&a.priority).then(a.rank.cmp(&b.rank)).then(a.key.cmp(&b.key)));
    let candidate_keys: Vec<BodyKey> = candidates.iter().map(|c| c.key).collect();
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
    let mut chosen: Vec<KeyframeRecord> = Vec::new();
    // The datagrams' own headers count too: records are packed in this
    // order, a new datagram starting whenever the next one does not fit.
    let mut room = 0usize;
    for c in &candidates {
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
        if c.record.baseline.is_some() {
            stats.delta_records += 1;
        }
        stats.by_mode[c.record.keyframe.mode as usize] += 1;
        stats.bytes_by_mode[c.record.keyframe.mode as usize] += c.bytes as u64;
        let band = DISTANCE_BANDS_M.iter().position(|&d| c.distance < d).unwrap_or(DISTANCE_BANDS_M.len());
        stats.keyframes_by_distance[band] += 1;
        stats.bytes_by_distance[band] += c.bytes as u64;
        chosen.push(c.record);
    }
    // What lost the ranking is looked at again next send (the best of it,
    // up to half the cap).
    for r in &chosen {
        cs.over_since.remove(&r.key);
    }
    cs.hot.clear();
    if slices > 1 {
        let sent: HashSet<BodyKey> = chosen.iter().map(|r| r.key).collect();
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
        while end < chosen.len() && bytes + record_bytes(&chosen[end], physics) <= config.max_datagram {
            bytes += record_bytes(&chosen[end], physics);
            end += 1;
        }
        let records = chosen[start..end].to_vec();
        let ordinal = cs.ordinal;
        cs.ordinal += 1;
        let packet = encode_keyframes(&KeyframePacket { server_tick: tick, ordinal, records: records.clone() }, physics);
        out.record_bytes += packet.len();
        out.packets.push(Outgoing::datagram(packet));
        let mut carried = Vec::with_capacity(records.len());
        for record in &records {
            // The client derives the floor from the body at the decoded
            // pose; the truth's is that to within the quantisation.
            let decoded = Keyframe { floor_drop: record.keyframe.floor_drop, ..decoded(record, physics) };
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
            truths.insert(key, Truth { keyframe: keyframe(tick, rest, Vec3::ZERO, Mode::Resting), radius: 0.5, settled: false, contact_tick: 0, born: 0 });
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
            truths.insert(key, Truth { keyframe: still(tick, at), radius: 0.5, settled: false, contact_tick: 0, born: 0 });
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
        truths.insert(old, Truth { keyframe: still(start, old_at), radius: 0.5, settled: false, contact_tick: 0, born: 0 });
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
            truths.insert(fresh, Truth { keyframe: still(tick, at), radius: 0.5, settled: false, contact_tick: 0, born: 0 });
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
