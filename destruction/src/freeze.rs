//! Pile freezing: retiring settled debris from the rigid-body solver, and
//! waking it back spatially.
//!
//! # Why this exists
//!
//! PhysX sleeps per *contact island*, never per body. A settled rubble field
//! is one island of thousands of touching chunks, so it can only sleep as a
//! whole -- and waking any single member wakes every body it transitively
//! touches. Measured live on the 24k-chunk downtown: one rifle round that
//! broke 365 bonds woke 6,065 bodies (94% of them untouched old rubble),
//! dropped the server 60 -> 34 Hz, and the pile never re-slept -- awake sat at
//! ~6,112 for the following eight minutes with no further damage. A smaller
//! shot earlier in the same session broke *7* bonds and woke 2,218 bodies.
//! The amplifier is the contact island, not the damage.
//!
//! The fix is to take settled bodies out of the island structure entirely by
//! making them kinematic. A kinematic body generates no contact pairs against
//! other kinematic or static geometry, so an all-kinematic pile has no island
//! to wake and no contacts to converge; dynamic bodies and the player
//! controller still collide with it, so debris stacks on the pile and players
//! walk over it. The actor and its island serial survive the round trip, which
//! is what lets the network layer treat a freeze exactly like the settle it
//! already handles.
//!
//! # Why not per-body sleep
//!
//! `runtime.rs` documents the closed line: forcing one body of an *active*
//! island asleep is undone by PhysX on the next step, ~650 times a second,
//! with visible judder. This module never fights the engine. It freezes
//! bodies the engine has already slept (`Phase::Sleeping`, the default path),
//! or bodies whose pose has not moved for a long window even though their
//! velocities never quiet (`Phase::Awake` + pose shell, the merged-pile path).
//! In the first case there is nothing awake to fight; in the second the body
//! was going to be simulated anyway and stopping it costs the engine nothing.
//!
//! # Why the criterion is pose, not velocity
//!
//! This is the same lesson the codec learned for bytes: bodies in a deep pile
//! carry contact-impulse velocities far above any usable threshold while their
//! poses go nowhere. A velocity floor therefore never fires on the population
//! that matters. It is also unsafe in the other direction -- PhysX caps
//! depenetration at 1 m/s, so a body climbing out of the floor can read as
//! slow while it is still moving metres. A pose shell held over a window is
//! immune to both: see [`shell_error_meters`], which mirrors the codec's
//! `rigid_shell_error_meters`.

use std::collections::{HashMap, HashSet};

use crate::ids;

/// Fallback island reach when the manifest cannot supply one, matching the
/// encoder's own fallback so a body's freeze shell and its wire shell agree.
const DEFAULT_REACH_M: f32 = 1.5;

/// Rigid-shell error between two poses of a body of the given reach, in
/// metres: how far the worst point on its bounding shell has moved.
///
/// Mirrors `rigid_shell_error_meters` in the destruction codec so the
/// simulation's "has not moved" and the wire's "has not moved" are the same
/// predicate. Rotation is charged at the shell, not the centre, because a body
/// spinning in place moves its surface even though its origin is still.
pub fn shell_error_meters(
    a_pos: [f32; 3],
    a_rot: [f32; 4],
    b_pos: [f32; 3],
    b_rot: [f32; 4],
    reach: f32,
) -> f32 {
    let a = glam::Vec3::from_array(a_pos);
    let b = glam::Vec3::from_array(b_pos);
    let qa = glam::Quat::from_array(a_rot).normalize();
    let qb = glam::Quat::from_array(b_rot).normalize();
    let angle = {
        let delta = (qa - qb).length_squared().min((qa + qb).length_squared());
        if delta <= 1e-12 {
            0.0
        } else {
            2.0 * qa.dot(qb).abs().clamp(0.0, 1.0).acos()
        }
    };
    a.distance(b) + 2.0 * reach * (angle * 0.5).sin().abs()
}

/// One thing holding a body up, as witnessed by the engine's contact reports
/// (or, for the ground, by the immutability of static geometry).
///
/// This is the freeze rule's whole vocabulary: a body may be frozen only when
/// every supporter is EVENT-OBSERVABLE -- World never changes, Rooted and
/// Body deaths arrive as events -- and must be released the same tick any of
/// them dies. Foreign (players, vehicles, props) is movable but NOT
/// event-observable, so its presence blocks freezing outright.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Supporter {
    /// Immutable static geometry. Needs no invalidation events, ever.
    World,
    /// A movable non-debris actor. Never a valid basis for freezing.
    Foreign,
    /// A ground-anchored kinematic fragment ("stump"), by entity and the
    /// specific node carrying the weight -- node-level, because a stump can
    /// lose the node under a dependent while surviving elsewhere.
    Rooted { entity: u32, node: u32 },
    /// Another debris body, frozen or dynamic.
    Body { entity: u32 },
}

/// Keys for the reverse (supporter -> dependents) index. Node-blind for
/// rooted supporters: node-level invalidation filters at cascade time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum SupporterKey {
    Rooted { entity: u32 },
    Body { entity: u32 },
}

impl Supporter {
    fn key(&self) -> Option<SupporterKey> {
        match *self {
            Supporter::Rooted { entity, .. } => Some(SupporterKey::Rooted { entity }),
            Supporter::Body { entity } => Some(SupporterKey::Body { entity }),
            _ => None,
        }
    }
}

/// Tuning for the freeze/wake system. Every field has an environment override
/// so a live session can bisect a regression without a rebuild, following the
/// kill-switch discipline the rest of the destruction stack uses.
#[derive(Debug, Clone, Copy)]
pub struct FreezeConfig {
    /// Master switch. Off means the tracker still observes and counts (so the
    /// censuses stay available) but never freezes anything.
    pub enabled: bool,
    /// Consecutive ticks a body must be *engine-asleep* before it is frozen.
    /// A window rather than an edge, so bodies PhysX wakes again a few ticks
    /// later never enter the freeze/thaw cycle at all.
    pub after_ticks: u32,
    /// Bodies frozen per tick. Freezing is a property write per body; batching
    /// keeps a 6,000-body pile from paying for itself in one frame.
    pub batch: usize,
    /// Freeze awake-but-motionless bodies too (the merged-pile path).
    pub pose_enabled: bool,
    /// Consecutive ticks inside the shell before an awake body is frozen.
    pub pose_ticks: u32,
    /// Shell radius, metres. Matches the codec's masked shell cap.
    pub shell_m: f32,
    /// Count the pose-quiet population without acting on it.
    pub census: bool,
    /// Multiplier on the impact radius when deciding which frozen bodies wake.
    pub wake_radius_scale: f32,
    /// Extra reach straight up from an impact. Rubble above the blast has lost
    /// its support and should fall; without this it hangs as a kinematic
    /// shelf.
    pub wake_above_m: f32,
    /// Spatial-hash cell edge, metres.
    pub cell_m: f32,
    /// Only freeze bodies whose every supporter is event-observable:
    /// the ground (immutable), a rooted stump (topology-evented), or another
    /// frozen body (we own its lifecycle). A supporter that is dynamic
    /// debris defers freezing until it freezes first; a Foreign supporter
    /// (player, vehicle) blocks it outright. This is the correctness
    /// condition of the whole design -- with it on, a frozen body's state
    /// can only be invalidated by an event we receive, so releases are exact
    /// and timer-free.
    pub require_supported: bool,
    /// How far above y=0 a body's underside may sit and still count as
    /// resting on the ground.
    pub ground_epsilon_m: f32,
    /// Deepest contact interpenetration (metres) a freeze candidate may
    /// carry. Beyond it the body is squeezed and admission defers until the
    /// solver relaxes the overlap.
    pub max_penetration_m: f32,
    /// Ticks between sweeps that release frozen bodies which have lost their
    /// support. 0 disables the sweep.
    ///
    /// Freezing at rest is not the same as freezing when *supported*: a body
    /// can be momentarily still while wedged or resting on debris that later
    /// slides away, and once frozen it is kinematic and cannot fall. Measured
    /// on a 70 s high-rise run, transient floaters peak around 9 and resolve
    /// to zero without freezing; with freezing they stick permanently. This
    /// is the self-correcting answer to that, and it is preferable to
    /// refusing to freeze unsupported bodies in the first place, which
    /// strands them awake forever instead (see `require_grounded`).
    pub unsupported_sweep_ticks: u32,
    /// Bodies released per sweep, so a large collapse cannot turn one sweep
    /// into a mass wake.
    pub unsupported_sweep_batch: usize,
}

impl Default for FreezeConfig {
    fn default() -> Self {
        Self {
            // On by default as of 2026-08-22, after the downtown ramp: 34%
            // more of the city destroyed while carrying 57% fewer awake
            // bodies, peak awake 4,041 -> 2,591 (under the ~3,000-body knee
            // rather than past it), and a pile that comes to rest instead of
            // holding ~2,500 bodies awake for the rest of the match.
            // VIBE_CITY_FREEZE=0 is the kill switch.
            enabled: true,
            after_ticks: 30,
            batch: 256,
            // Engine-sleep freezing alone leaves the merged pile behind --
            // the case that never sleeps is exactly the case that matters.
            pose_enabled: true,
            pose_ticks: 60,
            shell_m: 0.02,
            census: false,
            wake_radius_scale: 1.0,
            wake_above_m: 2.0,
            cell_m: 4.0,
            require_supported: true,
            max_penetration_m: 0.015,
            ground_epsilon_m: 0.6,
            unsupported_sweep_ticks: 30,
            unsupported_sweep_batch: 64,
        }
    }
}

impl FreezeConfig {
    /// Read the environment overrides once. Defaults preserve today's
    /// behaviour exactly: nothing freezes unless `VIBE_CITY_FREEZE` is set.
    pub fn from_env() -> Self {
        fn flag(name: &str, default: bool) -> bool {
            match std::env::var(name) {
                Ok(value) => !matches!(value.trim(), "" | "0" | "false" | "off"),
                Err(_) => default,
            }
        }
        fn number<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name)
                .ok()
                .and_then(|value| value.trim().parse().ok())
                .unwrap_or(default)
        }
        let defaults = Self::default();
        let enabled = flag("VIBE_CITY_FREEZE", defaults.enabled);
        Self {
            enabled,
            after_ticks: number("VIBE_CITY_FREEZE_AFTER_TICKS", defaults.after_ticks),
            batch: number("VIBE_CITY_FREEZE_BATCH", defaults.batch),
            // Pose freezing is a strict extension of freezing, so it cannot be
            // on while the master switch is off.
            pose_enabled: enabled && flag("VIBE_CITY_FREEZE_POSE", defaults.pose_enabled),
            pose_ticks: number("VIBE_CITY_FREEZE_POSE_TICKS", defaults.pose_ticks),
            shell_m: number("VIBE_CITY_FREEZE_SHELL_M", defaults.shell_m),
            census: flag("VIBE_CITY_POSE_CENSUS", defaults.census),
            wake_radius_scale: number(
                "VIBE_CITY_WAKE_RADIUS_SCALE",
                defaults.wake_radius_scale,
            ),
            wake_above_m: number("VIBE_CITY_WAKE_ABOVE_M", defaults.wake_above_m),
            cell_m: number("VIBE_CITY_FREEZE_CELL_M", defaults.cell_m),
            require_supported: {
                // The old geometry flag is honoured as a deprecated alias.
                let default = std::env::var("VIBE_CITY_FREEZE_GROUNDED")
                    .ok()
                    .map(|value| !matches!(value.trim(), "" | "0" | "false" | "off"))
                    .unwrap_or(defaults.require_supported);
                flag("VIBE_CITY_FREEZE_SUPPORTED", default)
            },
            ground_epsilon_m: number(
                "VIBE_CITY_FREEZE_GROUND_EPSILON_M",
                defaults.ground_epsilon_m,
            ),
            max_penetration_m: number(
                "VIBE_CITY_FREEZE_MAX_PENETRATION_M",
                defaults.max_penetration_m,
            ),
            unsupported_sweep_ticks: number(
                "VIBE_CITY_FREEZE_SWEEP_TICKS",
                defaults.unsupported_sweep_ticks,
            ),
            unsupported_sweep_batch: number(
                "VIBE_CITY_FREEZE_SWEEP_BATCH",
                defaults.unsupported_sweep_batch,
            ),
        }
    }
}

/// What the simulation currently believes about one body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Dynamic and moving, or at least not slept by the engine.
    Awake,
    /// Engine-asleep since the given tick.
    Sleeping { since: u64 },
    /// Kinematic: out of the solver, held at its frozen pose.
    Frozen,
}

#[derive(Debug, Clone, Copy)]
struct Body {
    phase: Phase,
    /// Pose the shell test measures against, and -- once frozen -- the pose
    /// the body is parked at.
    anchor_pos: [f32; 3],
    anchor_rot: [f32; 4],
    /// Consecutive ticks inside the shell around `anchor_*`.
    quiet_ticks: u32,
    reach: f32,
    /// How often this body has been woken out of a freeze, and when last.
    /// Bodies that thrash get a longer freeze window rather than cycling.
    unfreezes: u32,
    last_unfreeze_tick: u64,
}

/// A body the tracker wants frozen this tick, with the pose it will hold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FreezeCandidate {
    pub entity: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    /// Island reach, carried so the support test does not have to look the
    /// body up again.
    pub reach: f32,
    /// True when the body was never engine-asleep, so no settle record has
    /// been emitted for it and the freeze must synthesize one.
    pub needs_settle_record: bool,
}

/// Per-tick counters the stats snapshot reports.
#[derive(Debug, Default, Clone, Copy)]
pub struct FreezeCensus {
    /// Bodies that went asleep / woke up this tick, from the tracker's own
    /// edges. Level (`awake_chunk_bodies`) says how bad it is; these say
    /// whether the cause is churn or a pile that simply cannot settle.
    pub sleep_edges: u64,
    pub wake_edges: u64,
    /// Awake bodies inside their shell for a full window.
    pub pose_quiet_awake: u32,
    pub frozen: u32,
    /// Resting bodies (frozen or engine-asleep) with nothing beneath them.
    /// Only meaningful as a difference between two runs of one scenario.
    pub unsupported_resting: u32,
    /// Frozen bodies the validity backstop had to release. With the event
    /// cascade correct this is ZERO; every count is a missed release event.
    pub backstop_releases: u64,
    /// Lowest frozen body origin, metres, or +inf when nothing is frozen.
    ///
    /// A frozen body is kinematic, so it disappears from the snapshot stream
    /// the below-ground check reads -- which would make that check pass by
    /// construction on exactly the bodies least able to recover, since a
    /// kinematic body gets no depenetration and cannot climb out of the floor
    /// on its own. Tracked here so the check keeps meaning what it did.
    pub min_frozen_y: f32,
}

/// Tracks every chunk body's rest state, decides what to freeze, and answers
/// spatial wake queries over the frozen set.
///
/// Subsumes the `known_awake` map the runtime used to keep: the settle edge it
/// produced is still produced here, byte for byte, when freezing is disabled.
pub struct FreezeTracker {
    config: FreezeConfig,
    bodies: HashMap<u32, Body>,
    /// Frozen bodies bucketed by spatial cell. Frozen poses never change, so
    /// this index cannot go stale while a body stays frozen.
    cells: HashMap<(i32, i32, i32), Vec<u32>>,
    frozen: HashSet<u32>,
    census: FreezeCensus,
    /// Who is holding each body up, per the engine's contact reports.
    /// Sticky: reports stop when pairs sleep, so the set captured during the
    /// quiet window is exactly the knowledge that must survive the freeze.
    supporters: HashMap<u32, Vec<Supporter>>,
    /// Reverse index: supporter -> the FROZEN bodies leaning on it. Only
    /// frozen dependents matter for cascades; candidates simply re-check at
    /// admission.
    dependents: HashMap<SupporterKey, Vec<u32>>,
    /// Rooted entities believed alive (lazily populated when an edge names
    /// one; emptied by their death events).
    rooted_live: HashSet<u32>,
    /// Nodes that migrated OFF a still-standing rooted fragment: edges
    /// naming (entity, node) are dead even though the entity survives.
    dead_rooted_nodes: HashSet<(u32, u32)>,
    /// Most negative contact separation per body (metres), from the last
    /// report. Deep negative = squeezed between neighbours; freezing such a
    /// body bakes the overlap into an immovable anchor, and the neighbour it
    /// squeezes becomes a depenetration pump -- rising and dropping forever,
    /// never pose-quiet, spiking contact wakes into the pile around it.
    /// Measured live as a 198-body permanently-awake cluster plus ~2/s of
    /// bursty freeze-thrash. Admission refuses these until they relax.
    penetration_m: HashMap<u32, f32>,
    /// Multiset of frozen anchor heights, keyed by sortable float bits.
    ///
    /// Exists so `min_frozen_y` is O(log n) instead of a walk of the whole
    /// frozen set: the walk was honest (a cached running minimum can only
    /// fall, and would keep reporting a body that thawed) but it ran every
    /// tick in the stats path, which at 11k frozen bodies -- i.e. exactly
    /// when freezing is working -- measured as milliseconds of settle-scan
    /// time. A multiset gets the same honesty incrementally: entries leave
    /// when their body does. Anchor poses are immutable while frozen, so the
    /// key recorded at freeze time is the key to remove at thaw time.
    frozen_y: std::collections::BTreeMap<u32, u32>,
    /// Rotating start position for the interval backstop, so each pass scans
    /// a bounded slice of the frozen set instead of all of it.
    sweep_cursor: usize,
}

impl FreezeTracker {
    pub fn new(config: FreezeConfig) -> Self {
        Self {
            config,
            bodies: HashMap::new(),
            cells: HashMap::new(),
            frozen: HashSet::new(),
            census: FreezeCensus::default(),
            supporters: HashMap::new(),
            dependents: HashMap::new(),
            rooted_live: HashSet::new(),
            dead_rooted_nodes: HashSet::new(),
            penetration_m: HashMap::new(),
            frozen_y: std::collections::BTreeMap::new(),
            sweep_cursor: 0,
        }
    }

    pub fn config(&self) -> &FreezeConfig {
        &self.config
    }

    /// Stop freezing for the rest of the match. Already-frozen bodies stay
    /// frozen and stay wakeable -- the spatial index is still authoritative
    /// for them -- but nothing new is retired. Used when the bridge refuses a
    /// freeze, which is not a condition that repairs itself.
    pub fn disable(&mut self) {
        self.config.enabled = false;
        self.config.pose_enabled = false;
    }

    pub fn frozen_count(&self) -> usize {
        self.frozen.len()
    }

    pub fn is_frozen(&self, entity: u32) -> bool {
        self.frozen.contains(&entity)
    }

    /// Start a tick: clear the per-tick counters. Levels are recomputed by
    /// `observe`; totals that must survive the tick live in the caller's
    /// stats.
    pub fn begin_tick(&mut self) {
        self.census.sleep_edges = 0;
        self.census.wake_edges = 0;
        self.census.pose_quiet_awake = 0;
    }

    /// A new island appeared. Reach comes from the manifest so the freeze
    /// shell matches the shell the wire holds this body to.
    pub fn promote(&mut self, entity: u32, reach: f32) {
        // A serial is never reused, so a promotion is always a fresh body; if
        // the id is somehow live, the new body's state is the correct one.
        self.release_cell(entity);
        self.frozen.remove(&entity);
        self.bodies.insert(
            entity,
            Body {
                phase: Phase::Awake,
                anchor_pos: [0.0; 3],
                anchor_rot: [0.0, 0.0, 0.0, 1.0],
                quiet_ticks: 0,
                reach: if reach.is_finite() && reach > 0.0 { reach } else { DEFAULT_REACH_M },
                unfreezes: 0,
                last_unfreeze_tick: 0,
            },
        );
    }

    /// The adapter destroyed this body (merge or recycle).
    /// The adapter destroyed this body (merge or recycle).
    ///
    /// The caller must follow with `supporter_died(Body{entity})`: the body
    /// may have been holding others up, and its death is their release event.
    pub fn retire(&mut self, entity: u32) {
        self.release_cell(entity);
        if self.frozen.remove(&entity) {
            if let Some(body) = self.bodies.get(&entity) {
                Self::remove_frozen_y(&mut self.frozen_y, body.anchor_pos[1]);
            }
        }
        self.supporters.remove(&entity);
        self.penetration_m.remove(&entity);
        self.bodies.remove(&entity);
    }

    pub fn clear(&mut self) {
        self.bodies.clear();
        self.cells.clear();
        self.frozen.clear();
        self.census = FreezeCensus::default();
        self.supporters.clear();
        self.dependents.clear();
        self.rooted_live.clear();
        self.dead_rooted_nodes.clear();
        self.penetration_m.clear();
        self.frozen_y.clear();
        self.sweep_cursor = 0;
    }

    /// Observe one body from this tick's snapshot, returning what changed.
    ///
    /// Frozen bodies are absent from the snapshot (the bridge skips kinematic
    /// actors), so seeing one here means the adapter itself flipped it back to
    /// dynamic -- it split under load. That is a genuine wake and is reported
    /// as one.
    #[must_use]
    pub fn observe(&mut self, sample: BodySample) -> Observation {
        let BodySample { entity, position, rotation, sleeping, tick } = sample;
        let config = self.config;
        let mut observation = Observation::default();

        let body = self.bodies.entry(entity).or_insert_with(|| Body {
            phase: Phase::Awake,
            anchor_pos: position,
            anchor_rot: rotation,
            quiet_ticks: 0,
            reach: DEFAULT_REACH_M,
            unfreezes: 0,
            last_unfreeze_tick: 0,
        });

        // A frozen body cannot appear in the snapshot unless the adapter
        // flipped it back to dynamic, which it does when a body splits.
        let was_frozen = body.phase == Phase::Frozen;
        // Captured before the anchor is overwritten below: the body is
        // indexed under the cell of the pose it was FROZEN at, and releasing
        // it against its new pose would leave a stale entry pointing at a
        // body that is no longer frozen.
        let frozen_cell = was_frozen.then(|| cell_index(body.anchor_pos, config.cell_m));
        // Same reason: the pose it was frozen at is where its dependents are.
        let frozen_support = was_frozen.then(|| (body.anchor_pos, body.reach));
        if was_frozen {
            body.phase = Phase::Awake;
            body.quiet_ticks = 0;
            body.anchor_pos = position;
            body.anchor_rot = rotation;
            observation.thawed_by_adapter = true;
        } else if sleeping {
            if !matches!(body.phase, Phase::Sleeping { .. }) {
                body.phase = Phase::Sleeping { since: tick };
                // The engine-sleep edge is the network-definitive "at rest
                // now" moment, and stays the settle record's trigger.
                observation.settled = true;
            }
            // A sleeping body cannot move, so its pose IS its anchor.
            body.anchor_pos = position;
            body.anchor_rot = rotation;
        } else if matches!(body.phase, Phase::Sleeping { .. }) {
            body.phase = Phase::Awake;
            body.quiet_ticks = 0;
            body.anchor_pos = position;
            body.anchor_rot = rotation;
            observation.woke = true;
        }

        // Freeze decision, and the pose-shell window for awake bodies.
        let mut pose_quiet = false;
        match body.phase {
            Phase::Sleeping { since } => {
                let window = u64::from(Self::window(body, config.after_ticks));
                if config.enabled && tick.saturating_sub(since) >= window {
                    observation.freeze = Some(FreezeCandidate {
                        entity,
                        position,
                        rotation,
                        reach: body.reach,
                        // The engine slept it, so the settle record already
                        // went out on that edge.
                        needs_settle_record: false,
                    });
                }
            }
            Phase::Awake if config.census || config.pose_enabled => {
                let drift = shell_error_meters(
                    position,
                    rotation,
                    body.anchor_pos,
                    body.anchor_rot,
                    body.reach,
                );
                if drift <= config.shell_m {
                    body.quiet_ticks = body.quiet_ticks.saturating_add(1);
                } else {
                    // Re-anchor on escape: a body creeping slowly must not
                    // accumulate quiet ticks against a pose it left long ago.
                    body.quiet_ticks = 0;
                    body.anchor_pos = position;
                    body.anchor_rot = rotation;
                }
                if body.quiet_ticks >= Self::window(body, config.pose_ticks) {
                    pose_quiet = true;
                    // Both switches, not just the pose one. Pose freezing is
                    // an extension of freezing, so the master kill switch has
                    // to cover it -- otherwise VIBE_CITY_FREEZE=0 would still
                    // retire every motionless body, and the one control that
                    // is supposed to restore old behaviour would not.
                    if config.pose_enabled && config.enabled {
                        observation.freeze = Some(FreezeCandidate {
                            entity,
                            position,
                            rotation,
                            reach: body.reach,
                            // Never engine-slept, so nothing has told the wire
                            // this body is at rest: the freeze must say so.
                            needs_settle_record: true,
                        });
                    }
                }
            }
            _ => {}
        }

        // Counter updates last: they borrow the tracker, not the body.
        if observation.settled {
            self.census.sleep_edges += 1;
        }
        if observation.woke || observation.thawed_by_adapter {
            self.census.wake_edges += 1;
        }
        if pose_quiet {
            self.census.pose_quiet_awake += 1;
        }
        if let Some(cell) = frozen_cell {
            self.frozen.remove(&entity);
            self.drop_from_cell(cell, entity);
            self.census.frozen = self.frozen.len() as u32;
            if let Some(support) = frozen_support {
                // The adapter took this frozen body back (it split). Its
                // dependents' release rides the caller's supporter_died
                // cascade, driven by the thawed_by_adapter observation.
                Self::remove_frozen_y(&mut self.frozen_y, support.0[1]);
            }
        }
        observation
    }

    /// Freeze window for a body, lengthened for bodies that keep being woken.
    /// Without this a chunk sitting under a firefight pays the freeze/unfreeze
    /// property write every few ticks forever.
    ///
    /// The cap is 64x, not the earlier 8x, because of bodies resting on
    /// ROOTED support -- a structure's kinematic stump, which the support
    /// geometry cannot see (stumps are adapter actors, not tracked islands).
    /// The watch list releases such a body as "unsupported"; it lands exactly
    /// where it was, sleeps, refreezes, and cycles. The backoff is what damps
    /// that loop: a genuine floater is released on its FIRST watch pass
    /// (~1 s, before any backoff exists), while a stump-top body's cycle
    /// stretches to once per ~half-minute -- two property writes it can
    /// afford, invisible on screen.
    fn window(body: &Body, base: u32) -> u32 {
        let factor = 1u32 << body.unfreezes.min(6);
        base.saturating_mul(factor)
    }

    /// Record that these bodies are now kinematic at the given poses.
    pub fn mark_frozen(&mut self, frozen: &[FreezeCandidate]) {
        for candidate in frozen {
            let cell = self.cell_of(candidate.position);
            let Some(body) = self.bodies.get_mut(&candidate.entity) else {
                continue;
            };
            body.phase = Phase::Frozen;
            body.anchor_pos = candidate.position;
            body.anchor_rot = candidate.rotation;
            body.quiet_ticks = 0;
            if self.frozen.insert(candidate.entity) {
                self.cells.entry(cell).or_default().push(candidate.entity);
                *self.frozen_y.entry(y_key(candidate.position[1])).or_insert(0) += 1;
                // Register in the reverse index: when any of this body's
                // supporters dies, the cascade must find it.
                if let Some(supporters) = self.supporters.get(&candidate.entity) {
                    for supporter in supporters {
                        if let Some(key) = supporter.key() {
                            self.dependents.entry(key).or_default().push(candidate.entity);
                        }
                    }
                }
            }
        }
        self.census.frozen = self.frozen.len() as u32;
    }

    /// Frozen bodies whose shell intersects a sphere at `center`, plus the
    /// column of rubble above it out to `above` metres.
    ///
    /// The upward extension is not cosmetic: blasting the base of a frozen
    /// pile removes the support of everything over it, and kinematic bodies do
    /// not fall. Without waking the column, the pile keeps a floating shelf.
    pub fn frozen_within(&self, center: [f32; 3], radius: f32, above: f32) -> Vec<u32> {
        let mut hits = Vec::new();
        if self.frozen.is_empty() {
            return hits;
        }
        let cell = self.config.cell_m.max(0.5);
        let lo = [
            center[0] - radius,
            center[1] - radius,
            center[2] - radius,
        ];
        let hi = [
            center[0] + radius,
            center[1] + radius + above,
            center[2] + radius,
        ];
        let (lo_x, hi_x) = ((lo[0] / cell).floor() as i32, (hi[0] / cell).floor() as i32);
        let (lo_y, hi_y) = ((lo[1] / cell).floor() as i32, (hi[1] / cell).floor() as i32);
        let (lo_z, hi_z) = ((lo[2] / cell).floor() as i32, (hi[2] / cell).floor() as i32);
        for x in lo_x..=hi_x {
            for y in lo_y..=hi_y {
                for z in lo_z..=hi_z {
                    let Some(bucket) = self.cells.get(&(x, y, z)) else {
                        continue;
                    };
                    for &entity in bucket {
                        let Some(body) = self.bodies.get(&entity) else {
                            continue;
                        };
                        if body.phase != Phase::Frozen {
                            continue;
                        }
                        if Self::within(center, radius, above, body.anchor_pos, body.reach) {
                            hits.push(entity);
                        }
                    }
                }
            }
        }
        hits.sort_unstable();
        hits.dedup();
        hits
    }

    /// Sphere-plus-upward-column test against a body's bounding shell.
    fn within(
        center: [f32; 3],
        radius: f32,
        above: f32,
        pos: [f32; 3],
        reach: f32,
    ) -> bool {
        let dx = pos[0] - center[0];
        let dz = pos[2] - center[2];
        let dy = pos[1] - center[1];
        let reach = reach.max(0.0);
        if dx * dx + dy * dy + dz * dz <= (radius + reach).powi(2) {
            return true;
        }
        // The column: within the horizontal footprint and above the impact.
        above > 0.0
            && dy > 0.0
            && dy <= above + reach
            && dx * dx + dz * dz <= (radius + reach).powi(2)
    }

    /// These bodies are dynamic again. Returns the ones that really were
    /// frozen, so callers only announce genuine wakes.
    pub fn mark_thawed(&mut self, entities: &[u32], tick: u64) -> Vec<u32> {
        let mut woken = Vec::with_capacity(entities.len());
        for &entity in entities {
            if !self.frozen.remove(&entity) {
                continue;
            }
            self.release_cell(entity);
            if let Some(body) = self.bodies.get(&entity) {
                Self::remove_frozen_y(&mut self.frozen_y, body.anchor_pos[1]);
            }
            if let Some(body) = self.bodies.get_mut(&entity) {
                body.phase = Phase::Awake;
                body.quiet_ticks = 0;
                body.unfreezes = body.unfreezes.saturating_add(1);
                body.last_unfreeze_tick = tick;
            }
            woken.push(entity);
        }
        self.census.frozen = self.frozen.len() as u32;
        self.census.wake_edges += woken.len() as u64;
        woken
    }

    pub fn census(&self) -> FreezeCensus {
        FreezeCensus {
            frozen: self.frozen.len() as u32,
            min_frozen_y: self.min_frozen_y(),
            unsupported_resting: if self.config.census {
                self.unsupported_resting()
            } else {
                0
            },
            ..self.census
        }
    }

    /// Ingest this tick's supporter-set replacements from the bridge.
    ///
    /// Each entry wholesale-replaces one body's supporter list -- the bridge
    /// only exports sets that changed. Rooted supporters named here are
    /// presumed alive until their death event arrives; the bridge classifies
    /// by its CURRENT rooted set at resolve time, so a post-death report can
    /// never resurrect one.
    pub fn ingest_support(&mut self, entity: u32, supporters: Vec<Supporter>, min_separation: f32) {
        self.penetration_m.insert(entity, min_separation);
        for supporter in &supporters {
            if let Supporter::Rooted { entity: rooted, .. } = supporter {
                self.rooted_live.insert(*rooted);
            }
        }
        // Frozen bodies do not report (kinematic pairs are not simulated), so
        // a set arriving for one would be stale by construction; keep the
        // set captured at freeze time instead.
        if !self.frozen.contains(&entity) {
            self.supporters.insert(entity, supporters);
        }
    }

    /// The supporters currently stored for a body (diagnostics/tests).
    pub fn supporters_of(&self, entity: u32) -> Option<&[Supporter]> {
        self.supporters.get(&entity).map(|list| list.as_slice())
    }

    /// Is one supporter currently a valid basis for staying frozen?
    fn supporter_valid(&self, supporter: &Supporter, accepted: Option<&HashSet<u32>>) -> bool {
        match supporter {
            Supporter::World => true,
            Supporter::Foreign => false,
            Supporter::Rooted { entity, node } => {
                self.rooted_live.contains(entity)
                    && !self.dead_rooted_nodes.contains(&(*entity, *node))
            }
            Supporter::Body { entity } => {
                self.frozen.contains(entity)
                    || accepted.is_some_and(|set| set.contains(entity))
            }
        }
    }

    /// Squeezed = interpenetrating a neighbour deeper than the admission
    /// bound. Such a body is in unresolved contact conflict; freezing it (or
    /// around it) locks the conflict in.
    fn is_squeezed(&self, entity: u32) -> bool {
        let Some(&separation) = self.penetration_m.get(&entity) else {
            return false;
        };
        // Reach-relative: resting penetration scales with body size and mass
        // (a multi-tonne 10 m slab sits decimetres deep at equilibrium; live
        // measurement found 79 large bodies parked at -150..-317 mm and
        // permanently refused by a flat 15 mm bound). The floor keeps the
        // original protection for small chunks -- the population where the
        // squeeze pump actually happened.
        let Some(body) = self.bodies.get(&entity) else {
            return false;
        };
        let bound = self
            .config
            .max_penetration_m
            .max(body.reach * 0.03);
        separation < -bound
    }

    /// The freeze-admission and stay-frozen predicate: at least one valid
    /// supporter, and NO invalid-but-blocking one (Foreign).
    ///
    /// The ground is analytic, not evented: statics never report on this GPU
    /// stack (measured, pinned), and static geometry is immutable, so a body
    /// whose underside sits at the ground plane is supported by World with no
    /// event ever needed to revoke it.
    fn supported(&self, entity: u32, position: [f32; 3], reach: f32,
                 accepted: Option<&HashSet<u32>>) -> bool {
        if !self.config.require_supported {
            return true;
        }
        let grounded = position[1] - reach <= self.config.ground_epsilon_m;
        let mut any_valid = grounded;
        if let Some(supporters) = self.supporters.get(&entity) {
            for supporter in supporters {
                if matches!(supporter, Supporter::Foreign) {
                    // A movable non-debris supporter is carrying weight and
                    // is not event-observable: freezing on top of it would
                    // be exactly the class of bug this design removes.
                    return false;
                }
                if self.supporter_valid(supporter, accepted) {
                    any_valid = true;
                }
            }
        }
        any_valid
    }

    /// Plan which candidates may freeze this tick: a deterministic fold that
    /// admits bodies whose every needed support is already immovable -- or
    /// becomes so earlier in this same fold, which is what lets a whole
    /// settled stack freeze in ONE call, bottom dependency first.
    ///
    /// Rejected candidates are simply not frozen this tick; `observe`
    /// re-emits them every tick while they stay quiet, so they retry with no
    /// timer until whatever is under them freezes first.
    pub fn plan_freeze_batch(&self, candidates: &[FreezeCandidate]) -> Vec<FreezeCandidate> {
        if candidates.is_empty() {
            return Vec::new();
        }
        let cap = self.config.batch.max(1);
        let mut ordered: Vec<&FreezeCandidate> = candidates.iter().collect();
        // Deterministic order: low to high, entity as tie-break. COM height
        // orients dependency edges, so processing upward means supporters
        // are considered before their dependents.
        ordered.sort_by(|a, b| {
            a.position[1]
                .partial_cmp(&b.position[1])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.entity.cmp(&b.entity))
        });
        let mut accepted_set: HashSet<u32> = HashSet::new();
        let mut accepted: Vec<FreezeCandidate> = Vec::new();
        // Multi-pass: a single upward pass covers stacks, but support edges
        // are not strictly height-ordered (a wide slab's COM can sit below a
        // supporter's); passes repeat until a fixed point. Bounded by the
        // candidate count.
        loop {
            let mut grew = false;
            for candidate in &ordered {
                if accepted.len() >= cap {
                    break;
                }
                if accepted_set.contains(&candidate.entity) {
                    continue;
                }
                if self.is_squeezed(candidate.entity) {
                    continue; // penetrating: freezing would bake the overlap
                }
                if self.supported(
                    candidate.entity,
                    candidate.position,
                    candidate.reach,
                    Some(&accepted_set),
                ) {
                    accepted_set.insert(candidate.entity);
                    accepted.push(**candidate);
                    grew = true;
                }
            }
            if !grew || accepted.len() >= cap {
                break;
            }
        }
        accepted
    }

    /// A supporter died: a frozen body was thawed or retired, or a rooted
    /// fragment went dynamic or was crushed. Returns the frozen dependents
    /// that are no longer supported and must be released NOW -- the caller
    /// unfreezes them, and each release feeds back in here, so a dependency
    /// chain lets go link by link within the same tick.
    #[must_use]
    pub fn supporter_died(&mut self, entity: u32, was_rooted: bool) -> Vec<u32> {
        if was_rooted {
            self.rooted_live.remove(&entity);
        }
        let mut released = Vec::new();
        let keys = [
            SupporterKey::Body { entity },
            SupporterKey::Rooted { entity },
        ];
        for key in keys {
            let Some(dependents) = self.dependents.remove(&key) else {
                continue;
            };
            for dependent in dependents {
                if !self.frozen.contains(&dependent) {
                    continue;
                }
                let Some(body) = self.bodies.get(&dependent) else {
                    continue;
                };
                if !self.supported(dependent, body.anchor_pos, body.reach, None) {
                    released.push(dependent);
                }
            }
        }
        released.sort_unstable();
        released.dedup();
        released
    }

    /// A node migrated OFF a still-standing rooted fragment: every frozen
    /// body whose weight that specific node carried must re-prove its
    /// support or be released. The fragment itself survives, so this is
    /// finer than `supporter_died`.
    #[must_use]
    pub fn rooted_node_died(&mut self, entity: u32, node: u32) -> Vec<u32> {
        // Ordinary debris migrations name non-rooted sources every fracture
        // tick; only entities some edge actually recorded as rooted matter,
        // and gating here keeps dead_rooted_nodes from growing unboundedly.
        if !self.rooted_live.contains(&entity) {
            return Vec::new();
        }
        self.dead_rooted_nodes.insert((entity, node));
        let mut released = Vec::new();
        if let Some(dependents) = self.dependents.get(&SupporterKey::Rooted { entity }) {
            for &dependent in dependents.iter() {
                if !self.frozen.contains(&dependent) {
                    continue;
                }
                let Some(body) = self.bodies.get(&dependent) else {
                    continue;
                };
                if !self.supported(dependent, body.anchor_pos, body.reach, None) {
                    released.push(dependent);
                }
            }
        }
        released.sort_unstable();
        released.dedup();
        released
    }

    /// Per-body debug states for the body-color overlay: 0 awake, 1 awake
    /// but pose-quiet (wants to freeze; admission pending), 2 engine-asleep,
    /// 3 frozen, 4 blocked by a Foreign supporter (player/vehicle in the
    /// support chain -- can never freeze while it stays).
    pub fn debug_states(&self) -> Vec<(u32, u8, u32, i32)> {
        let mut out = Vec::with_capacity(self.bodies.len());
        for (&entity, body) in &self.bodies {
            let foreign = self
                .supporters
                .get(&entity)
                .is_some_and(|list| list.iter().any(|s| matches!(s, Supporter::Foreign)));
            let state = match body.phase {
                Phase::Frozen => 3,
                _ if foreign => 4,
                Phase::Sleeping { .. } => 2,
                Phase::Awake => {
                    if self.is_squeezed(entity) {
                        7
                    } else if body.quiet_ticks >= Self::window(body, self.config.pose_ticks) {
                        1
                    } else {
                        0
                    }
                }
            };
            let pen_mm = (self.penetration_m.get(&entity).copied().unwrap_or(0.0)
                * 1000.0) as i32;
            out.push((entity, state, body.unfreezes, pen_mm));
        }
        out
    }

    /// Validity backstop: a rotating slice of the frozen set re-proves its
    /// support each interval. With the event cascade correct this finds
    /// NOTHING -- every find is counted (`backstop_releases`) and means a
    /// release event was missed somewhere. Last resort, not mechanism.
    pub fn unsupported_frozen(&mut self, tick: u64) -> Vec<u32> {
        if self.config.unsupported_sweep_ticks == 0
            || tick % u64::from(self.config.unsupported_sweep_ticks) != 0
            || self.frozen.is_empty()
        {
            return Vec::new();
        }
        let scan = self.config.unsupported_sweep_batch.max(64) * 2;
        let count = self.frozen.len();
        let start = self.sweep_cursor % count;
        let mut stranded = Vec::new();
        for &entity in self.frozen.iter().cycle().skip(start).take(scan.min(count)) {
            let Some(body) = self.bodies.get(&entity) else {
                continue;
            };
            if !self.supported(entity, body.anchor_pos, body.reach, None) {
                stranded.push(entity);
                if stranded.len() >= self.config.unsupported_sweep_batch.max(1) {
                    break;
                }
            }
        }
        self.sweep_cursor = (start + scan) % count.max(1);
        self.census.backstop_releases += stranded.len() as u64;
        stranded
    }


    /// Resting bodies with nothing under them: the floating-rubble census.
    ///
    /// Counts every body currently at rest -- frozen OR engine-asleep -- whose
    /// underside is clear of the ground and which has no other resting body
    /// beneath it. Deliberately blind to *why* a body is at rest, because the
    /// question it answers is whether freezing invents floaters or merely
    /// preserves ones the simulation was already producing, and a metric that
    /// only sees frozen bodies cannot tell those apart.
    ///
    /// Bodies held up by Blast bonds are expected to appear here: a slab
    /// bonded to a standing structure is legitimately in mid-air. So the
    /// number is only meaningful as a difference between two runs of the same
    /// scenario, never on its own.
    ///
    /// O(n) with a temporary grid, so it runs on the census cadence rather
    /// than per tick.
    pub fn unsupported_resting(&self) -> u32 {
        let cell = self.config.cell_m.max(0.5);
        let resting: Vec<(u32, [f32; 3], f32)> = self
            .bodies
            .iter()
            .filter(|(_, body)| {
                matches!(body.phase, Phase::Frozen | Phase::Sleeping { .. })
            })
            .map(|(entity, body)| (*entity, body.anchor_pos, body.reach))
            .collect();
        let mut grid: HashMap<(i32, i32, i32), Vec<usize>> = HashMap::new();
        for (index, (_, pos, _)) in resting.iter().enumerate() {
            grid.entry(cell_index(*pos, cell)).or_default().push(index);
        }
        let mut floating = 0;
        for (index, (_, pos, reach)) in resting.iter().enumerate() {
            let bottom = pos[1] - reach;
            if bottom <= self.config.ground_epsilon_m {
                continue;
            }
            let (cx, cy, cz) = cell_index(*pos, cell);
            let mut supported = false;
            'search: for x in (cx - 1)..=(cx + 1) {
                for y in (cy - 1)..=cy {
                    for z in (cz - 1)..=(cz + 1) {
                        let Some(bucket) = grid.get(&(x, y, z)) else {
                            continue;
                        };
                        for &other_index in bucket {
                            if other_index == index {
                                continue;
                            }
                            let (_, other_pos, other_reach) = resting[other_index];
                            // Strictly below, or the census is blind to the
                            // same mutual-support rings the sweep was.
                            if other_pos[1] >= pos[1] {
                                continue;
                            }
                            if other_pos[1] + other_reach
                                < bottom - self.config.ground_epsilon_m
                            {
                                continue;
                            }
                            let dx = other_pos[0] - pos[0];
                            let dz = other_pos[2] - pos[2];
                            if dx * dx + dz * dz <= (reach + other_reach).powi(2) {
                                supported = true;
                                break 'search;
                            }
                        }
                    }
                }
            }
            if !supported {
                floating += 1;
            }
        }
        floating
    }

    /// Lowest frozen body origin, or +inf when nothing is frozen.
    ///
    /// A height multiset, not a cached running minimum (which could only ever
    /// fall, so a thawed body would depress it forever) and not a per-tick
    /// walk of the frozen set (which measured as milliseconds of settle scan
    /// at 11k frozen bodies). Entries leave with their bodies, so it stays
    /// honest at O(log n).
    pub fn min_frozen_y(&self) -> f32 {
        self.frozen_y
            .first_key_value()
            .map(|(&key, _)| y_from_key(key))
            .unwrap_or(f32::INFINITY)
    }

    fn remove_frozen_y(frozen_y: &mut std::collections::BTreeMap<u32, u32>, y: f32) {
        if let Some(count) = frozen_y.get_mut(&y_key(y)) {
            *count -= 1;
            if *count == 0 {
                frozen_y.remove(&y_key(y));
            }
        }
    }

    fn cell_of(&self, pos: [f32; 3]) -> (i32, i32, i32) {
        cell_index(pos, self.config.cell_m)
    }

    fn drop_from_cell(&mut self, cell: (i32, i32, i32), entity: u32) {
        if let Some(bucket) = self.cells.get_mut(&cell) {
            bucket.retain(|&held| held != entity);
            if bucket.is_empty() {
                self.cells.remove(&cell);
            }
        }
    }

    fn release_cell(&mut self, entity: u32) {
        let Some(body) = self.bodies.get(&entity) else {
            return;
        };
        let cell = self.cell_of(body.anchor_pos);
        self.drop_from_cell(cell, entity);
    }
}

/// f32 -> totally-ordered u32 key (IEEE 754 sortable-bits transform), so a
/// BTreeMap can hold a multiset of heights with the minimum at the first key.
fn y_key(y: f32) -> u32 {
    let bits = y.to_bits();
    if bits & 0x8000_0000 != 0 { !bits } else { bits | 0x8000_0000 }
}

fn y_from_key(key: u32) -> f32 {
    if key & 0x8000_0000 != 0 {
        f32::from_bits(key & 0x7fff_ffff)
    } else {
        f32::from_bits(!key)
    }
}

fn cell_index(pos: [f32; 3], cell_m: f32) -> (i32, i32, i32) {
    let cell = cell_m.max(0.5);
    (
        (pos[0] / cell).floor() as i32,
        (pos[1] / cell).floor() as i32,
        (pos[2] / cell).floor() as i32,
    )
}

/// One body's snapshot for [`FreezeTracker::observe`].
#[derive(Debug, Clone, Copy)]
pub struct BodySample {
    pub entity: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub sleeping: bool,
    pub tick: u64,
}

/// What observing one body implied.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Observation {
    /// The engine slept this body this tick: emit a settle record.
    pub settled: bool,
    /// The engine woke this body this tick.
    pub woke: bool,
    /// The adapter flipped a frozen body back to dynamic (it split).
    pub thawed_by_adapter: bool,
    /// This body should be frozen now.
    pub freeze: Option<FreezeCandidate>,
}

/// Island reach for a set of chunks: the distance from the island's centre of
/// mass to the far side of its furthest member.
///
/// Shared with the encoder so a body's freeze shell and its wire shell are the
/// same number. The root chunk's own radius under-constrains a wide island --
/// that under-constraint was measured as 249k shell violations on the wire.
pub fn island_reach(
    manifest: &crate::manifest::DestructionManifest,
    structure_id: u32,
    chunks: &[u32],
) -> f32 {
    let Some(structure) = manifest.structure(structure_id) else {
        return DEFAULT_REACH_M;
    };
    let mut com = glam::Vec3::ZERO;
    let mut weight_total = 0.0f32;
    let mut members = Vec::with_capacity(chunks.len());
    for &chunk in chunks {
        let node = ids::chunk_id_parts(chunk).1 as usize;
        let Some(def) = structure.chunks.get(node) else {
            continue;
        };
        let centroid = glam::Vec3::from_array(def.centroid);
        let weight = if def.mass > 0.0 { def.mass } else { 1.0 };
        com += centroid * weight;
        weight_total += weight;
        members.push((centroid, def.radius));
    }
    if weight_total <= 0.0 {
        return DEFAULT_REACH_M;
    }
    com /= weight_total;
    members
        .iter()
        .map(|(centroid, radius)| centroid.distance(com) + radius)
        .fold(0.5f32, f32::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(entity: u32, pos: [f32; 3], sleeping: bool, tick: u64) -> BodySample {
        BodySample {
            entity,
            position: pos,
            rotation: [0.0, 0.0, 0.0, 1.0],
            sleeping,
            tick,
        }
    }

    fn config(enabled: bool) -> FreezeConfig {
        FreezeConfig { enabled, after_ticks: 3, ..FreezeConfig::default() }
    }

    #[test]
    fn shell_error_charges_rotation_at_the_shell() {
        // A body that only spins has zero centre error but a real surface
        // displacement; a velocity- or position-only test would call it still.
        let half_turn = [0.0, 1.0, 0.0, 0.0];
        let spun = shell_error_meters([0.0; 3], [0.0, 0.0, 0.0, 1.0], [0.0; 3], half_turn, 2.0);
        assert!((spun - 4.0).abs() < 1e-4, "half turn at reach 2 should move the shell 4 m, got {spun}");
        let still = shell_error_meters([0.0; 3], [0.0, 0.0, 0.0, 1.0], [0.0; 3], [0.0, 0.0, 0.0, 1.0], 2.0);
        assert_eq!(still, 0.0);
    }

    #[test]
    fn engine_sleep_edge_still_settles_with_freezing_off() {
        // The settle record is the wire's "at rest now" moment and must not
        // depend on the freeze feature at all.
        let mut tracker = FreezeTracker::new(config(false));
        let awake = tracker.observe(sample(7, [0.0; 3], false, 1));
        assert!(!awake.settled);
        let slept = tracker.observe(sample(7, [0.0; 3], true, 2));
        assert!(slept.settled, "engine sleep must emit a settle");
        let held = tracker.observe(sample(7, [0.0; 3], true, 3));
        assert!(!held.settled, "settle is an edge, not a level");
        assert!(held.freeze.is_none(), "nothing may freeze with the flag off");
    }

    #[test]
    fn wake_edge_is_reported_and_resets_the_settle() {
        let mut tracker = FreezeTracker::new(config(false));
        let _ = tracker.observe(sample(7, [0.0; 3], true, 1));
        let woke = tracker.observe(sample(7, [0.0; 3], false, 2));
        assert!(woke.woke);
        // And a later sleep settles again: a re-settled body needs a fresh
        // record, since its pose may have changed.
        let again = tracker.observe(sample(7, [1.0, 0.0, 0.0], true, 3));
        assert!(again.settled);
    }

    /// VIBE_CITY_FREEZE=0 has to mean nothing freezes, by any route.
    ///
    /// Pose freezing is a separate switch, and once both default to on a
    /// config with the master off but the pose flag left on is reachable --
    /// at which point the kill switch would silently keep retiring every
    /// motionless body, which is the one thing it exists to prevent.
    #[test]
    fn the_master_switch_covers_pose_freezing_too() {
        let mut tracker = FreezeTracker::new(FreezeConfig {
            enabled: false,
            pose_enabled: true,
            pose_ticks: 3,
            ..FreezeConfig::default()
        });
        for tick in 1..=10 {
            assert!(
                tracker.observe(sample(1, [0.0; 3], false, tick)).freeze.is_none(),
                "tick {tick} froze a body with the master switch off"
            );
        }
    }

    #[test]
    fn freeze_waits_for_the_window_then_fires_once() {
        let mut tracker = FreezeTracker::new(config(true));
        assert!(tracker.observe(sample(7, [0.0; 3], true, 10)).freeze.is_none());
        assert!(tracker.observe(sample(7, [0.0; 3], true, 11)).freeze.is_none());
        assert!(tracker.observe(sample(7, [0.0; 3], true, 12)).freeze.is_none());
        let fired = tracker.observe(sample(7, [0.0; 3], true, 13)).freeze;
        let candidate = fired.expect("window elapsed");
        assert_eq!(candidate.entity, 7);
        assert!(
            !candidate.needs_settle_record,
            "engine-slept bodies already sent their settle record"
        );
    }

    #[test]
    fn a_body_woken_before_the_window_never_freezes() {
        let mut tracker = FreezeTracker::new(config(true));
        let _ = tracker.observe(sample(7, [0.0; 3], true, 10));
        let _ = tracker.observe(sample(7, [0.0; 3], false, 11));
        // The clock restarts from the new sleep, not from the old one.
        let _ = tracker.observe(sample(7, [0.0; 3], true, 12));
        assert!(tracker.observe(sample(7, [0.0; 3], true, 13)).freeze.is_none());
        assert!(tracker.observe(sample(7, [0.0; 3], true, 14)).freeze.is_none());
        assert!(tracker.observe(sample(7, [0.0; 3], true, 15)).freeze.is_some());
    }

    #[test]
    fn spatial_query_finds_only_nearby_frozen_bodies() {
        let mut tracker = FreezeTracker::new(config(true));
        for (entity, x) in [(1u32, 0.0f32), (2, 3.0), (3, 40.0)] {
            tracker.promote(entity, 0.5);
            let _ = tracker.observe(sample(entity, [x, 0.0, 0.0], true, 1));
        }
        tracker.mark_frozen(&[
            FreezeCandidate { entity: 1, position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0, 1.0], reach: 0.5, needs_settle_record: false },
            FreezeCandidate { entity: 2, position: [3.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0, 1.0], reach: 0.5, needs_settle_record: false },
            FreezeCandidate { entity: 3, position: [40.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0, 1.0], reach: 0.5, needs_settle_record: false },
        ]);
        assert_eq!(tracker.frozen_count(), 3);
        let hit = tracker.frozen_within([0.0, 0.0, 0.0], 4.0, 0.0);
        assert_eq!(hit, vec![1, 2], "the distant pile must stay frozen");
    }

    #[test]
    fn the_wake_column_reaches_rubble_above_the_impact() {
        // Shooting the base of a pile has to release what was resting on it,
        // or the overburden hangs in the air as a kinematic shelf.
        let mut tracker = FreezeTracker::new(config(true));
        tracker.promote(1, 0.5);
        let _ = tracker.observe(sample(1, [0.0, 6.0, 0.0], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0, 6.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        assert!(
            tracker.frozen_within([0.0, 0.0, 0.0], 2.0, 0.0).is_empty(),
            "6 m up is outside a 2 m sphere"
        );
        assert_eq!(
            tracker.frozen_within([0.0, 0.0, 0.0], 2.0, 6.0),
            vec![1],
            "the column above the impact must wake"
        );
    }

    #[test]
    fn thawing_reports_only_bodies_that_were_frozen() {
        let mut tracker = FreezeTracker::new(config(true));
        tracker.promote(1, 0.5);
        let _ = tracker.observe(sample(1, [0.0; 3], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        assert_eq!(tracker.mark_thawed(&[1, 99], 5), vec![1]);
        assert_eq!(tracker.frozen_count(), 0);
        assert!(tracker.frozen_within([0.0; 3], 10.0, 0.0).is_empty());
    }

    #[test]
    fn a_thrashing_body_earns_a_longer_freeze_window() {
        // Otherwise a chunk under sustained fire pays a property write every
        // few ticks for the whole match.
        let mut tracker = FreezeTracker::new(config(true));
        tracker.promote(1, 0.5);
        let _ = tracker.observe(sample(1, [0.0; 3], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        tracker.mark_thawed(&[1], 2);
        // Window is now 3 * 2 = 6 ticks, so the old 3-tick wait must not fire.
        for tick in 3..=8 {
            assert!(
                tracker.observe(sample(1, [0.0; 3], true, tick)).freeze.is_none(),
                "tick {tick} froze inside the backoff window"
            );
        }
        assert!(tracker.observe(sample(1, [0.0; 3], true, 9)).freeze.is_some());
    }

    #[test]
    fn the_adapter_flipping_a_frozen_body_back_reads_as_a_wake() {
        // The adapter sets bodies dynamic when they split. A frozen body that
        // reappears in the snapshot was flipped behind our back, and the wire
        // has to hear about it or the client keeps drawing it parked.
        let mut tracker = FreezeTracker::new(config(true));
        tracker.promote(1, 0.5);
        let _ = tracker.observe(sample(1, [0.0; 3], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        let seen = tracker.observe(sample(1, [0.5, 0.0, 0.0], false, 9));
        assert!(seen.thawed_by_adapter);
        assert_eq!(tracker.frozen_count(), 0);
    }

    #[test]
    fn retiring_a_frozen_body_clears_its_cell() {
        let mut tracker = FreezeTracker::new(config(true));
        tracker.promote(1, 0.5);
        let _ = tracker.observe(sample(1, [0.0; 3], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        tracker.retire(1);
        assert_eq!(tracker.frozen_count(), 0);
        assert!(tracker.frozen_within([0.0; 3], 10.0, 0.0).is_empty());
    }


    #[test]
    fn pose_census_counts_still_bodies_that_never_sleep() {
        // The measured pathology: velocities never quiet in a merged pile, so
        // only a pose test can see that the pile is at rest.
        let mut tracker = FreezeTracker::new(FreezeConfig {
            enabled: false,
            census: true,
            pose_ticks: 3,
            shell_m: 0.02,
            ..FreezeConfig::default()
        });
        tracker.begin_tick();
        for tick in 1..=4 {
            let _ = tracker.observe(sample(1, [0.0, 0.0, 0.0], false, tick));
        }
        assert!(tracker.census().pose_quiet_awake >= 1, "a motionless awake body must be counted");
    }

    #[test]
    fn a_creeping_body_never_counts_as_quiet() {
        // PhysX caps depenetration at 1 m/s, so a body climbing out of the
        // floor looks slow to a velocity floor. Over a window it leaves the
        // shell many times over, which is the whole point of the pose test.
        let mut tracker = FreezeTracker::new(FreezeConfig {
            enabled: false,
            census: true,
            pose_ticks: 3,
            shell_m: 0.02,
            ..FreezeConfig::default()
        });
        tracker.begin_tick();
        for tick in 1..=20 {
            let y = tick as f32 * (1.0 / 60.0); // 1 m/s at 60 Hz
            let _ = tracker.observe(sample(1, [0.0, y, 0.0], false, tick));
        }
        assert_eq!(tracker.census().pose_quiet_awake, 0, "a creeping body is not at rest");
    }
}

#[cfg(test)]
mod dependency_tests {
    use super::*;

    fn config() -> FreezeConfig {
        FreezeConfig {
            enabled: true,
            require_supported: true,
            after_ticks: 1,
            batch: 10_000,
            unsupported_sweep_ticks: 0, // backstop off: events must carry it all
            ..FreezeConfig::default()
        }
    }

    fn candidate(entity: u32, y: f32) -> FreezeCandidate {
        FreezeCandidate {
            entity,
            position: [0.0, y, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }
    }

    fn tracker_with(bodies: &[(u32, f32, Vec<Supporter>)]) -> FreezeTracker {
        let mut tracker = FreezeTracker::new(config());
        for (entity, y, supporters) in bodies {
            tracker.promote(*entity, 0.5);
            let _ = tracker.observe(BodySample {
                entity: *entity,
                position: [0.0, *y, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                sleeping: true,
                tick: 1,
            });
            tracker.ingest_support(*entity, supporters.clone());
        }
        tracker
    }

    /// Freeze everything a fold admits, and keep folding across "ticks" until
    /// nothing more is admitted -- the shape of the runtime loop.
    fn freeze_to_fixed_point(tracker: &mut FreezeTracker, candidates: &[FreezeCandidate]) {
        loop {
            let pending: Vec<FreezeCandidate> = candidates
                .iter()
                .filter(|candidate| !tracker.is_frozen(candidate.entity))
                .copied()
                .collect();
            let accepted = tracker.plan_freeze_batch(&pending);
            if accepted.is_empty() {
                break;
            }
            tracker.mark_frozen(&accepted);
        }
    }

    /// Release a dead supporter and chase the cascade exactly as the runtime
    /// does: every released body is itself a dead supporter.
    fn cascade(tracker: &mut FreezeTracker, entity: u32, was_rooted: bool) -> Vec<u32> {
        let mut all = Vec::new();
        let mut queue = tracker.supporter_died(entity, was_rooted);
        while let Some(next) = queue.pop() {
            for released in tracker.mark_thawed(&[next], 100) {
                all.push(released);
                queue.extend(tracker.supporter_died(released, false));
            }
        }
        all.sort_unstable();
        all
    }

    /// The ground needs no contact evidence: statics never report on this
    /// stack (measured), and static geometry is immutable, so "resting at
    /// the ground plane" is a complete proof of support by itself.
    #[test]
    fn ground_support_is_analytic() {
        let mut tracker = tracker_with(&[(1, 0.4, vec![]), (2, 8.0, vec![])]);
        let accepted = tracker.plan_freeze_batch(&[candidate(1, 0.4), candidate(2, 8.0)]);
        assert_eq!(
            accepted.iter().map(|c| c.entity).collect::<Vec<_>>(),
            vec![1],
            "the grounded body freezes; the airborne one with no supporters must not"
        );
        let _ = tracker;
    }

    /// A supporter that is movable but not event-observable (a player's
    /// head, a vehicle roof) blocks freezing outright -- even if the body is
    /// also touching the ground.
    #[test]
    fn a_foreign_supporter_blocks_freezing() {
        let tracker = tracker_with(&[(1, 0.4, vec![Supporter::Foreign])]);
        assert!(tracker.plan_freeze_batch(&[candidate(1, 0.4)]).is_empty());
    }

    /// A body resting on dynamic debris waits for the debris to freeze --
    /// and when both are candidates in one batch, the fold admits the whole
    /// stack in a single call, dependency-first.
    #[test]
    fn a_settled_stack_freezes_in_one_fold() {
        let mut tracker = tracker_with(&[
            (1, 0.4, vec![]),
            (2, 1.3, vec![Supporter::Body { entity: 1 }]),
            (3, 2.2, vec![Supporter::Body { entity: 2 }]),
        ]);
        // Body 3 alone: refused (its supporter is dynamic).
        assert!(tracker.plan_freeze_batch(&[candidate(3, 2.2)]).is_empty());
        // All three at once: the whole stack, in one call.
        let accepted =
            tracker.plan_freeze_batch(&[candidate(3, 2.2), candidate(1, 0.4), candidate(2, 1.3)]);
        assert_eq!(
            accepted.iter().map(|c| c.entity).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "the fold must admit dependency-first, in one pass over one batch"
        );
        tracker.mark_frozen(&accepted);
        assert_eq!(tracker.frozen_count(), 3);
    }

    /// Releasing a supporter releases its dependents the same cascade --
    /// transitively, with no timer anywhere.
    #[test]
    fn a_thawed_supporter_cascades_through_the_stack() {
        let mut tracker = tracker_with(&[
            (1, 0.4, vec![]),
            (2, 1.3, vec![Supporter::Body { entity: 1 }]),
            (3, 2.2, vec![Supporter::Body { entity: 2 }]),
            // A side body on the ground, leaning contact on 2: must SURVIVE
            // the cascade -- it has its own valid support.
            (4, 0.4, vec![Supporter::Body { entity: 2 }]),
        ]);
        freeze_to_fixed_point(
            &mut tracker,
            &[candidate(1, 0.4), candidate(2, 1.3), candidate(3, 2.2), candidate(4, 0.4)],
        );
        assert_eq!(tracker.frozen_count(), 4);

        // Body 1 is struck and released (contact wake); the stack above goes
        // with it, link by link; the grounded leaner stays.
        tracker.mark_thawed(&[1], 50);
        let released = cascade(&mut tracker, 1, false);
        assert_eq!(released, vec![2, 3], "the stack releases; the grounded leaner survives");
        assert!(tracker.is_frozen(4));
        assert_eq!(tracker.frozen_count(), 1);
    }

    /// A rooted fragment dying (crushed, or gone dynamic) releases exactly
    /// the bodies it was holding.
    #[test]
    fn a_rooted_death_releases_its_dependents() {
        let stump = 0x8000_0000u32 | 900;
        let mut tracker = tracker_with(&[
            (1, 5.0, vec![Supporter::Rooted { entity: stump, node: 7 }]),
            (2, 5.0, vec![Supporter::Rooted { entity: stump, node: 8 },
                          Supporter::Body { entity: 3 }]),
            (3, 4.0, vec![]),
        ]);
        // 3 is airborne with no supporters -- it must never freeze, so 2's
        // survival after the stump dies must come from... nothing. 2 falls
        // too. Re-pin 3 as grounded instead to give 2 a real alternative.
        let mut tracker2 = tracker_with(&[
            (1, 5.0, vec![Supporter::Rooted { entity: stump, node: 7 }]),
            (2, 5.0, vec![Supporter::Rooted { entity: stump, node: 8 },
                          Supporter::Body { entity: 3 }]),
            (3, 0.4, vec![]),
        ]);
        freeze_to_fixed_point(
            &mut tracker2,
            &[candidate(1, 5.0), candidate(2, 5.0), candidate(3, 0.4)],
        );
        assert_eq!(tracker2.frozen_count(), 3, "stump-supported rubble freezes");

        let released = cascade(&mut tracker2, stump, true);
        assert_eq!(
            released,
            vec![1],
            "1 hung only on the stump and falls; 2 also rests on frozen 3 and stays"
        );
        assert!(tracker2.is_frozen(2));
        let _ = tracker;
    }

    /// Node-level: the stump survives, but the specific node under a body
    /// migrated away. Only that body's support is re-proved.
    #[test]
    fn a_migrated_rooted_node_releases_only_its_dependents() {
        let stump = 0x8000_0000u32 | 900;
        let mut tracker = tracker_with(&[
            (1, 5.0, vec![Supporter::Rooted { entity: stump, node: 7 }]),
            (2, 5.0, vec![Supporter::Rooted { entity: stump, node: 8 }]),
        ]);
        freeze_to_fixed_point(&mut tracker, &[candidate(1, 5.0), candidate(2, 5.0)]);
        assert_eq!(tracker.frozen_count(), 2);

        let released = tracker.rooted_node_died(stump, 7);
        assert_eq!(released, vec![1], "only node 7's dependent releases");
        tracker.mark_thawed(&released, 60);
        assert!(tracker.is_frozen(2), "node 8's dependent is untouched");
    }

    /// Property: over random dependency graphs, freeze-to-fixed-point must
    /// admit EXACTLY the oracle-supported set, and killing supporters must
    /// release EXACTLY what becomes unreachable. The oracle is independent
    /// reachability over {analytic ground, live rooted} seeds with the
    /// Foreign veto, written against the same rules but none of the same
    /// code.
    #[test]
    fn fold_and_cascade_match_the_reachability_oracle_on_random_graphs() {
        fn next(state: &mut u64) -> f32 {
            *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((*state >> 33) as f32) / (u32::MAX >> 1) as f32
        }
        for seed in 0..64u64 {
            let mut rng = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).max(1);
            let body_count = 4 + (next(&mut rng) * 20.0) as u32;
            let stump = 0x8000_0000u32 | 0x3f_fff0;
            let mut spec: Vec<(u32, f32, Vec<Supporter>)> = Vec::new();
            for entity in 1..=body_count {
                // Height decides analytic ground; edges point only at
                // LOWER-numbered bodies, matching the COM-height acyclicity
                // the bridge guarantees.
                let grounded = next(&mut rng) < 0.3;
                let y = if grounded { 0.4 } else { 1.0 + next(&mut rng) * 8.0 };
                let mut supporters = Vec::new();
                if !grounded {
                    for _ in 0..(1 + (next(&mut rng) * 2.0) as u32) {
                        let roll = next(&mut rng);
                        if roll < 0.15 {
                            supporters.push(Supporter::Foreign);
                        } else if roll < 0.35 {
                            supporters.push(Supporter::Rooted {
                                entity: stump,
                                node: (next(&mut rng) * 4.0) as u32,
                            });
                        } else if entity > 1 {
                            let target = 1 + ((next(&mut rng) * (entity - 1) as f32) as u32)
                                .min(entity - 2);
                            supporters.push(Supporter::Body { entity: target });
                        }
                    }
                }
                spec.push((entity, y, supporters));
            }

            // Oracle: supported iff no Foreign supporter AND (grounded OR any
            // supporter reaches ground/stump through supported bodies).
            let oracle: HashSet<u32> = {
                let mut supported: HashSet<u32> = HashSet::new();
                loop {
                    let mut grew = false;
                    for (entity, y, supporters) in &spec {
                        if supported.contains(entity) {
                            continue;
                        }
                        if supporters.iter().any(|s| matches!(s, Supporter::Foreign)) {
                            continue;
                        }
                        let grounded = *y - 0.5 <= 0.6;
                        let held = grounded
                            || supporters.iter().any(|s| match s {
                                Supporter::Rooted { .. } => true,
                                Supporter::Body { entity } => supported.contains(entity),
                                _ => false,
                            });
                        if held {
                            supported.insert(*entity);
                            grew = true;
                        }
                    }
                    if !grew {
                        break;
                    }
                }
                supported
            };

            let mut tracker = tracker_with(&spec);
            let candidates: Vec<FreezeCandidate> =
                spec.iter().map(|(entity, y, _)| candidate(*entity, *y)).collect();
            freeze_to_fixed_point(&mut tracker, &candidates);
            for (entity, _, _) in &spec {
                assert_eq!(
                    tracker.is_frozen(*entity),
                    oracle.contains(entity),
                    "seed {seed}: body {entity} frozen-state disagrees with the oracle"
                );
            }

            // Kill the stump; recompute the oracle without it; the cascade
            // must land exactly there.
            let oracle_after: HashSet<u32> = {
                let mut supported: HashSet<u32> = HashSet::new();
                loop {
                    let mut grew = false;
                    for (entity, y, supporters) in &spec {
                        if supported.contains(entity)
                            || supporters.iter().any(|s| matches!(s, Supporter::Foreign))
                        {
                            continue;
                        }
                        let grounded = *y - 0.5 <= 0.6;
                        let held = grounded
                            || supporters.iter().any(|s| match s {
                                Supporter::Body { entity } => supported.contains(entity),
                                _ => false, // stump dead; Foreign never
                            });
                        if held {
                            supported.insert(*entity);
                            grew = true;
                        }
                    }
                    if !grew {
                        break;
                    }
                }
                supported
            };
            let _ = cascade(&mut tracker, stump, true);
            for (entity, _, _) in &spec {
                let expect = oracle.contains(entity) && oracle_after.contains(entity);
                assert_eq!(
                    tracker.is_frozen(*entity),
                    expect,
                    "seed {seed}: body {entity} post-cascade state disagrees with the oracle"
                );
            }
        }
    }

    /// The backstop is a tripwire: after any cascade, it must find nothing.
    #[test]
    fn the_backstop_finds_nothing_after_a_correct_cascade() {
        let mut tracker = FreezeTracker::new(FreezeConfig {
            unsupported_sweep_ticks: 1,
            ..config()
        });
        for (entity, y, supporters) in [
            (1u32, 0.4f32, vec![]),
            (2, 1.3, vec![Supporter::Body { entity: 1 }]),
        ] {
            tracker.promote(entity, 0.5);
            let _ = tracker.observe(BodySample {
                entity,
                position: [0.0, y, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                sleeping: true,
                tick: 1,
            });
            tracker.ingest_support(entity, supporters);
        }
        freeze_to_fixed_point(&mut tracker, &[candidate(1, 0.4), candidate(2, 1.3)]);
        tracker.mark_thawed(&[1], 40);
        let released = cascade(&mut tracker, 1, false);
        assert_eq!(released, vec![2]);
        for tick in 41..80u64 {
            assert!(
                tracker.unsupported_frozen(tick).is_empty(),
                "the backstop found stranded bodies the cascade should have released"
            );
        }
        assert_eq!(tracker.census().backstop_releases, 0);
    }
}
