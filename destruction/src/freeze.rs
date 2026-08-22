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
    /// Only freeze bodies whose support is the ground or already-frozen
    /// rubble.
    ///
    /// A kinematic body has infinite mass and is not accelerated by gravity,
    /// so frozen rubble is *weightless*: it stops loading whatever is under
    /// it. Resting on the ground that costs nothing. Resting on a structure
    /// still standing, it silently removes the load that should have helped
    /// bring the structure down, and the building reads as stronger than the
    /// same rubble would leave it.
    ///
    /// **Default off, and that is a measured decision rather than an
    /// oversight.** Requiring support re-creates the problem the whole system
    /// exists to solve: a body that cannot find a grounded neighbour can
    /// never be retired, so it stays awake forever. Switched on, the one-shot
    /// bench saw the pile fail to come to rest at all -- 431 bodies still
    /// awake after 180 s, where the *unfrozen* control settled fully. The
    /// fidelity worry it addresses is real but unquantified; the cost of
    /// addressing it this way is neither. At downtown scale freezing already
    /// measures 34% MORE destruction than the control, so weightless rubble
    /// is not suppressing collapses in practice.
    pub require_grounded: bool,
    /// How far above y=0 a body's underside may sit and still count as
    /// resting on the ground.
    pub ground_epsilon_m: f32,
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
            require_grounded: false,
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
            require_grounded: flag("VIBE_CITY_FREEZE_GROUNDED", defaults.require_grounded),
            ground_epsilon_m: number(
                "VIBE_CITY_FREEZE_GROUND_EPSILON_M",
                defaults.ground_epsilon_m,
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
    /// Places where a frozen body was removed (thawed, retired, struck) and
    /// the rubble above may now be hanging. Consumed by the next
    /// `unsupported_frozen` call, so support-loss release is EVENT-DRIVEN --
    /// the tick after the support disappears -- rather than waiting for the
    /// interval sweep, which remains only as a backstop for anything the
    /// targeted checks miss.
    pending_support_checks: Vec<([f32; 3], f32)>,
}

impl FreezeTracker {
    pub fn new(config: FreezeConfig) -> Self {
        Self {
            config,
            bodies: HashMap::new(),
            cells: HashMap::new(),
            frozen: HashSet::new(),
            census: FreezeCensus::default(),
            pending_support_checks: Vec::new(),
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
    pub fn retire(&mut self, entity: u32) {
        self.release_cell(entity);
        if self.frozen.remove(&entity) {
            if let Some(body) = self.bodies.get(&entity) {
                // A frozen support vanished; check what sat on it.
                self.pending_support_checks.push((body.anchor_pos, body.reach));
            }
        }
        self.bodies.remove(&entity);
    }

    pub fn clear(&mut self) {
        self.bodies.clear();
        self.cells.clear();
        self.frozen.clear();
        self.census = FreezeCensus::default();
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
                // The adapter took this frozen body back (it split): whatever
                // was resting on it needs a support check, same as any thaw.
                self.pending_support_checks.push(support);
            }
        }
        observation
    }

    /// Freeze window for a body, lengthened for bodies that keep being woken.
    /// Without this a chunk sitting under a firefight pays the freeze/unfreeze
    /// property write every few ticks forever.
    fn window(body: &Body, base: u32) -> u32 {
        let factor = 1u32 << body.unfreezes.min(3);
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
                // Whatever was resting on this body just lost its support.
                self.pending_support_checks.push((body.anchor_pos, body.reach));
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

    /// Is this body resting on something that will not move out from under it?
    ///
    /// True when its underside is on the ground, or when an already-frozen
    /// body sits directly beneath it. Frozen rubble is transitively grounded
    /// -- it only ever froze because it passed this same test -- so a pile
    /// grows upward one settled layer at a time, which is also the order the
    /// bottom-up freeze pass presents candidates in.
    ///
    /// The point is not tidiness. A kinematic body is weightless, so freezing
    /// rubble that is perched on a structure still standing deletes the load
    /// that rubble should be putting on it, and the building survives damage
    /// it should not have.
    pub fn is_supported(&self, position: [f32; 3], reach: f32) -> bool {
        if !self.config.require_grounded {
            return true;
        }
        let bottom = position[1] - reach;
        if bottom <= self.config.ground_epsilon_m {
            return true;
        }
        // Look for frozen rubble under it. One cell layer down is enough:
        // cells are 4 m and a candidate has to be within its own reach of the
        // supporting body to be resting on it.
        let cell = self.config.cell_m.max(0.5);
        let (cx, cy, cz) = cell_index(position, cell);
        for x in (cx - 1)..=(cx + 1) {
            for y in (cy - 1)..=cy {
                for z in (cz - 1)..=(cz + 1) {
                    let Some(bucket) = self.cells.get(&(x, y, z)) else {
                        continue;
                    };
                    for &entity in bucket {
                        let Some(other) = self.bodies.get(&entity) else {
                            continue;
                        };
                        if other.phase != Phase::Frozen {
                            continue;
                        }
                        let top = other.anchor_pos[1] + other.reach;
                        if top < bottom - self.config.ground_epsilon_m {
                            continue;
                        }
                        if other.anchor_pos[1] > position[1] {
                            continue; // above, not under
                        }
                        let dx = other.anchor_pos[0] - position[0];
                        let dz = other.anchor_pos[2] - position[2];
                        if dx * dx + dz * dz <= (reach + other.reach).powi(2) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Frozen bodies that have lost their support and should fall.
    ///
    /// A body is frozen because it was at rest, which is not the same as
    /// being *supported*: it may have been wedged, or resting on debris that
    /// has since slid out from under it. A kinematic body cannot fall, so
    /// without this it hangs in the air permanently — the artifact a player
    /// notices immediately, and the one measurable difference this system
    /// makes to how the pile looks.
    ///
    /// Returns at most `unsupported_sweep_batch` entities so a collapse that
    /// strands many at once cannot turn one sweep into a mass wake.
    ///
    /// Only *frozen* bodies are candidates, and that is what makes the test
    /// safe: a chunk still bonded to a structure belongs to that structure's
    /// support actor, which is never frozen. So a frozen body has no bonds
    /// holding it up, and contact is the only thing that can — if there is
    /// nothing under it, it is genuinely floating.
    pub fn unsupported_frozen(&mut self, tick: u64) -> Vec<u32> {
        if self.config.unsupported_sweep_ticks == 0 {
            self.pending_support_checks.clear();
            return Vec::new();
        }
        let batch = self.config.unsupported_sweep_batch.max(1);
        let mut stranded = Vec::new();
        let mut seen = HashSet::new();

        // Targeted pass, every tick: only rubble around places where a frozen
        // support just disappeared. This is what makes support-loss release
        // event-driven rather than interval-bound -- a hanging piece is
        // checked the very next tick, and each release queues checks for the
        // layer above it, so a stack un-freezes over consecutive ticks the
        // way a real collapse propagates.
        let checks = std::mem::take(&mut self.pending_support_checks);
        if !self.frozen.is_empty() {
            let cell = self.config.cell_m.max(0.5);
            for (pos, reach) in checks {
                // Everything whose support region could have included the
                // removed body: within combined horizontal reach, at or above.
                let (cx, cy, cz) = cell_index(pos, cell);
                for x in (cx - 1)..=(cx + 1) {
                    for y in cy..=(cy + 1) {
                        for z in (cz - 1)..=(cz + 1) {
                            let Some(bucket) = self.cells.get(&(x, y, z)) else {
                                continue;
                            };
                            for &entity in bucket {
                                if !seen.insert(entity) {
                                    continue;
                                }
                                let Some(body) = self.bodies.get(&entity) else {
                                    continue;
                                };
                                if body.phase != Phase::Frozen
                                    || body.anchor_pos[1] < pos[1] - reach
                                {
                                    continue;
                                }
                                if !self.is_supported_by_frozen(
                                    entity,
                                    body.anchor_pos,
                                    body.reach,
                                ) {
                                    stranded.push(entity);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Interval backstop: the full scan, for anything the targeted checks
        // cannot see (a freeze that was unsupported from the start).
        if tick % u64::from(self.config.unsupported_sweep_ticks) == 0
            && !self.frozen.is_empty()
        {
            for &entity in &self.frozen {
                if stranded.len() >= batch {
                    break;
                }
                if seen.contains(&entity) {
                    continue;
                }
                let Some(body) = self.bodies.get(&entity) else {
                    continue;
                };
                if !self.is_supported_by_frozen(entity, body.anchor_pos, body.reach) {
                    stranded.push(entity);
                }
            }
        }
        stranded.truncate(batch);
        stranded
    }

    /// Ground, or another frozen body beneath. `entity` excludes self.
    fn is_supported_by_frozen(
        &self,
        entity: u32,
        position: [f32; 3],
        reach: f32,
    ) -> bool {
        let bottom = position[1] - reach;
        if bottom <= self.config.ground_epsilon_m {
            return true;
        }
        let cell = self.config.cell_m.max(0.5);
        let (cx, cy, cz) = cell_index(position, cell);
        for x in (cx - 1)..=(cx + 1) {
            for y in (cy - 1)..=cy {
                for z in (cz - 1)..=(cz + 1) {
                    let Some(bucket) = self.cells.get(&(x, y, z)) else {
                        continue;
                    };
                    for &other in bucket {
                        if other == entity {
                            continue;
                        }
                        let Some(neighbour) = self.bodies.get(&other) else {
                            continue;
                        };
                        if neighbour.phase != Phase::Frozen
                            || neighbour.anchor_pos[1] > position[1]
                        {
                            continue;
                        }
                        if neighbour.anchor_pos[1] + neighbour.reach
                            < bottom - self.config.ground_epsilon_m
                        {
                            continue;
                        }
                        let dx = neighbour.anchor_pos[0] - position[0];
                        let dz = neighbour.anchor_pos[2] - position[2];
                        if dx * dx + dz * dz <= (reach + neighbour.reach).powi(2) {
                            return true;
                        }
                    }
                }
            }
        }
        false
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
                            if other_pos[1] > pos[1] {
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
    /// Walks the frozen set rather than caching a running minimum: a cached
    /// one can only ever go down, so a body that thawed would keep depressing
    /// it forever and the below-ground check would report a body that is no
    /// longer frozen -- or no longer exists.
    pub fn min_frozen_y(&self) -> f32 {
        self.frozen
            .iter()
            .filter_map(|entity| self.bodies.get(entity))
            .map(|body| body.anchor_pos[1])
            .fold(f32::INFINITY, f32::min)
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

    /// Frozen bodies must stay inside the below-ground check.
    ///
    /// They are kinematic, so they leave the snapshot stream that check reads
    /// -- and a kinematic body gets no depenetration, so a frozen body under
    /// the floor is the one case that can never recover on its own. Dropping
    /// them from the measurement would make the check pass by construction on
    /// exactly the population it exists to catch.
    #[test]
    fn the_lowest_frozen_body_is_still_measured() {
        let mut tracker = FreezeTracker::new(config(true));
        assert_eq!(
            tracker.min_frozen_y(),
            f32::INFINITY,
            "with nothing frozen the minimum must not read as a body at y=0"
        );
        for (entity, y) in [(1u32, 4.0f32), (2, -3.5), (3, 1.0)] {
            tracker.promote(entity, 0.5);
            let _ = tracker.observe(sample(entity, [0.0, y, 0.0], true, 1));
            tracker.mark_frozen(&[FreezeCandidate {
                entity,
                position: [0.0, y, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                reach: 0.5,
                needs_settle_record: false,
            }]);
        }
        assert_eq!(tracker.census().min_frozen_y, -3.5);

        // Thawing the offender must raise the minimum again: a cached running
        // minimum could only ever fall, and would keep reporting a body that
        // is no longer frozen.
        tracker.mark_thawed(&[2], 5);
        assert_eq!(tracker.census().min_frozen_y, 1.0);
    }

    /// Rubble perched on something still standing must not freeze.
    ///
    /// A kinematic body is weightless, so freezing debris that is resting on
    /// a structure deletes the load it should be putting on that structure --
    /// the building then survives damage it should not have. Only the ground,
    /// or rubble already retired onto the ground, counts as support.
    #[test]
    fn only_grounded_rubble_freezes() {
        // Opt-in: the condition defaults off because enforcing it strands
        // unsupported bodies awake forever. See FreezeConfig::require_grounded.
        let mut tracker = FreezeTracker::new(FreezeConfig {
            require_grounded: true,
            ..config(true)
        });
        // On the ground: fine.
        tracker.promote(1, 0.5);
        assert!(tracker.is_supported([0.0, 0.4, 0.0], 0.5));
        // Ten metres up with nothing under it: not fine.
        assert!(!tracker.is_supported([0.0, 10.0, 0.0], 0.5));

        // Freeze the ground-level body, and the one directly above it now has
        // support -- a pile grows upward one settled layer at a time.
        let _ = tracker.observe(sample(1, [0.0, 0.4, 0.0], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0, 0.4, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        assert!(
            tracker.is_supported([0.0, 1.3, 0.0], 0.5),
            "rubble resting on frozen rubble is transitively grounded"
        );
        assert!(
            !tracker.is_supported([9.0, 1.3, 0.0], 0.5),
            "a body nowhere near the frozen pile is not supported by it"
        );
        assert!(
            !tracker.is_supported([0.0, 10.0, 0.0], 0.5),
            "one frozen layer does not support something ten metres up"
        );
    }

    /// The condition is a kill switch, not a hard-coded policy.
    #[test]
    fn the_ground_condition_can_be_switched_off() {
        let tracker = FreezeTracker::new(FreezeConfig {
            enabled: true,
            require_grounded: false,
            ..FreezeConfig::default()
        });
        assert!(tracker.is_supported([0.0, 400.0, 0.0], 0.5));
        // And off is the default, so nothing is stranded unless asked for.
        assert!(!FreezeConfig::default().require_grounded);
    }

    /// A frozen body whose support slides out from under it must be released.
    ///
    /// This is the artifact a player sees first: kinematic bodies cannot
    /// fall, so a chunk frozen while wedged hangs in the air forever. Without
    /// freezing the same chunk simply drops.
    #[test]
    fn frozen_rubble_that_loses_its_support_is_released() {
        let mut tracker = FreezeTracker::new(FreezeConfig {
            unsupported_sweep_ticks: 10,
            ..config(true)
        });
        // A grounded body, and one perched on top of it.
        for (entity, y) in [(1u32, 0.4f32), (2, 1.3)] {
            tracker.promote(entity, 0.5);
            let _ = tracker.observe(sample(entity, [0.0, y, 0.0], true, 1));
            tracker.mark_frozen(&[FreezeCandidate {
                entity,
                position: [0.0, y, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                reach: 0.5,
                needs_settle_record: false,
            }]);
        }
        assert!(
            tracker.unsupported_frozen(10).is_empty(),
            "a stacked pair is supported: the lower body is on the ground and \
             the upper one is on the lower"
        );

        // The lower body is dug out. The upper one is now hanging -- and the
        // check fires on the NEXT tick, off-cadence: support-loss release is
        // event-driven, not interval-bound. Tick 11 is deliberately not a
        // multiple of the 10-tick sweep.
        tracker.retire(1);
        assert_eq!(
            tracker.unsupported_frozen(11),
            vec![2],
            "the perched body lost its support and must be released the very \
             next tick, without waiting for the sweep interval"
        );
        // The pending check was consumed; quiet ticks stay free.
        assert!(tracker.unsupported_frozen(12).is_empty());
    }

    /// Releasing one layer queues checks for the next: a frozen stack whose
    /// base is removed un-freezes upward over consecutive ticks, like a real
    /// collapse propagating, with no interval in the loop.
    #[test]
    fn support_loss_cascades_up_a_frozen_stack() {
        let mut tracker = FreezeTracker::new(FreezeConfig {
            unsupported_sweep_ticks: 1000, // interval effectively off
            ..config(true)
        });
        for (entity, y) in [(1u32, 0.4f32), (2, 1.3), (3, 2.2)] {
            tracker.promote(entity, 0.5);
            let _ = tracker.observe(sample(entity, [0.0, y, 0.0], true, 1));
            tracker.mark_frozen(&[FreezeCandidate {
                entity,
                position: [0.0, y, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                reach: 0.5,
                needs_settle_record: false,
            }]);
        }
        tracker.retire(1);
        let first = tracker.unsupported_frozen(7);
        assert_eq!(first, vec![2], "the middle of the stack hangs first");
        // Releasing it (mark_thawed) queues the next layer's check.
        tracker.mark_thawed(&first, 7);
        assert_eq!(
            tracker.unsupported_frozen(8),
            vec![3],
            "the top of the stack follows on the next tick"
        );
        assert!(tracker.unsupported_frozen(9).is_empty());
    }

    /// The sweep is bounded, so a collapse cannot turn one tick into a mass wake.
    #[test]
    fn the_unsupported_sweep_is_batched() {
        let mut tracker = FreezeTracker::new(FreezeConfig {
            unsupported_sweep_ticks: 10,
            unsupported_sweep_batch: 3,
            ..config(true)
        });
        for entity in 0..20u32 {
            tracker.promote(entity, 0.5);
            let _ = tracker.observe(sample(entity, [entity as f32 * 10.0, 40.0, 0.0], true, 1));
            tracker.mark_frozen(&[FreezeCandidate {
                entity,
                position: [entity as f32 * 10.0, 40.0, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                reach: 0.5,
                needs_settle_record: false,
            }]);
        }
        assert_eq!(tracker.unsupported_frozen(10).len(), 3);
    }

    /// The sweep can be switched off entirely.
    #[test]
    fn the_unsupported_sweep_can_be_disabled() {
        let mut tracker = FreezeTracker::new(FreezeConfig {
            unsupported_sweep_ticks: 0,
            ..config(true)
        });
        tracker.promote(1, 0.5);
        let _ = tracker.observe(sample(1, [0.0, 40.0, 0.0], true, 1));
        tracker.mark_frozen(&[FreezeCandidate {
            entity: 1,
            position: [0.0, 40.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            reach: 0.5,
            needs_settle_record: false,
        }]);
        assert!(tracker.unsupported_frozen(10).is_empty());
        assert!(tracker.unsupported_frozen(0).is_empty());
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
