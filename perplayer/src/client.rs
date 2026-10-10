//! The per-player client: what one player's screen shows, from what has
//! arrived.
//!
//! The server runs the same `BodyTrack` for each client (over the keyframes
//! it believes that client has), so its error model is not a model: it is
//! the client's own drawing rule.
//!
//! Drawing rule, per body, at the render tick `r` (server time minus the
//! playout delay):
//! - between keyframes `k1 <= r < k2`, the predictor from `k1`, plus the gap
//!   to `k2` spread along the arc with a smoothstep. The body lands exactly
//!   on every keyframe, and the correction is a gentle curve, not a jump.
//! - past the newest keyframe, the predictor alone (exact in free flight).
//! - a keyframe that arrives after `r` passed its tick switches the track
//!   with a decaying offset over 150 ms. Over 5 m it snaps: the owner judged
//!   a long glide worse than a one-frame snap (decision D3).
//! - a settled body holds its rest pose from the settle's tick.
//!
//! Structure: events apply when `r` reaches their tick, never on arrival, so
//! a wall splits in the same frame its fragments start to move (gate G2). A
//! new body starts from its parent's drawn pose at the break (`v + w x r` for
//! a moving parent; the authored pose for a standing one).

use std::collections::{BTreeMap, HashMap};

use glam::{Quat, Vec3};

use crate::predict::{predict, predict_velocity, Keyframe, Mode, Physics};
use crate::structure::{StructureDef, StructureState, ANCHORED, REMOVED};
use crate::wire::{
    decode_bootstrap, decode_events, decode_keyframes_with, BodyKey, Event, PKT_PP_BOOTSTRAP, PKT_PP_EVENTS,
    PKT_PP_KEYFRAMES,
};

/// Larger corrections snap (D3).
pub const SNAP_METRES: f32 = 5.0;
/// A late keyframe's offset decays over this many ticks (150 ms at 60 Hz).
pub const CORRECTION_TICKS: f32 = 9.0;
/// Keyframes kept per body.
const TRACK_LEN: usize = 6;
/// Decoded keyframes kept per body as delta baselines: at most this many,
/// and none older than `HISTORY_TICKS` behind the newest. The server only
/// names baselines inside both (`BASELINE_MAX_TICKS`).
pub const HISTORY_LEN: usize = 64;
pub const HISTORY_TICKS: u32 = 300;
pub const BASELINE_MAX_TICKS: u32 = 240;

fn smoothstep(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

#[derive(Clone, Copy, Debug)]
struct Correction {
    offset: Vec3,
    rotation: Quat,
    from_tick: f32,
}

/// One body's keyframes and how it is drawn.
#[derive(Clone, Debug, Default)]
pub struct BodyTrack {
    keyframes: Vec<Keyframe>,
    settled: Option<(u32, Vec3, Quat)>,
    correction: Option<Correction>,
    /// The tick this body (this id's current incarnation) began: keyframes
    /// from before it describe another body and are refused.
    incarnation: u32,
}

impl BodyTrack {
    pub fn keyframes(&self) -> &[Keyframe] {
        &self.keyframes
    }

    pub fn newest(&self) -> Option<&Keyframe> {
        self.keyframes.last()
    }

    pub fn settled(&self) -> Option<(u32, Vec3, Quat)> {
        self.settled
    }

    /// Forget everything before `spawn.tick` (a new incarnation of the id).
    /// A keyframe the server sent for that very tick describes the new body
    /// better than a derived spawn, so it is kept in the spawn's place.
    pub fn restart(&mut self, spawn: Keyframe) {
        self.incarnation = spawn.tick;
        self.keyframes.retain(|k| k.tick >= spawn.tick);
        if self.keyframes.first().map_or(true, |k| k.tick != spawn.tick) {
            self.keyframes.insert(0, spawn);
        }
        self.settled = None;
        self.correction = None;
    }

    /// This track as it stood before `tick`: keyframes at or after it may
    /// belong to the body the id names after a split there.
    pub fn before(&self, tick: u32) -> BodyTrack {
        let mut track = self.clone();
        track.keyframes.retain(|k| k.tick < tick);
        if track.keyframes.is_empty() {
            track.keyframes = self.keyframes.first().copied().into_iter().collect();
        }
        track
    }

    /// Add a keyframe, drawn from `render_tick` on. A keyframe for a tick the
    /// drawing has already passed switches the track under a decaying offset
    /// (or a snap over `SNAP_METRES`).
    pub fn incarnation(&self) -> u32 {
        self.incarnation
    }

    pub fn add(&mut self, keyframe: Keyframe, render_tick: f32, physics: Physics) {
        if keyframe.tick < self.incarnation {
            return;
        }
        // The server's keyframe for a tick replaces whatever is there (a
        // derived spawn, or an earlier copy).
        if let Some(existing) = self.keyframes.iter_mut().find(|k| k.tick == keyframe.tick) {
            *existing = keyframe;
            return;
        }
        let late = (keyframe.tick as f32) < render_tick && !self.keyframes.is_empty();
        let before = late.then(|| self.pose_at(render_tick, physics));
        let at = self.keyframes.partition_point(|k| k.tick < keyframe.tick);
        self.keyframes.insert(at, keyframe);
        if self.keyframes.len() > TRACK_LEN {
            // Drop the oldest that no render tick still needs.
            let needed = self.keyframes.partition_point(|k| (k.tick as f32) <= render_tick).saturating_sub(1);
            let drop = (self.keyframes.len() - TRACK_LEN).min(needed);
            self.keyframes.drain(..drop);
        }
        if let Some((p0, q0)) = before {
            self.correction = None;
            let (p1, q1) = self.pose_at(render_tick, physics);
            let offset = p0 - p1;
            self.correction = (offset.length() <= SNAP_METRES).then(|| Correction {
                offset,
                rotation: (q0 * q1.inverse()).normalize(),
                from_tick: render_tick,
            });
        }
    }

    /// Forget the keyframe for `tick` (the server learned it was lost).
    pub fn remove_keyframe(&mut self, tick: u32) {
        if self.keyframes.len() > 1 {
            self.keyframes.retain(|k| k.tick != tick);
        }
    }

    pub fn settle(&mut self, tick: u32, position: Vec3, rotation: Quat) {
        self.settled = Some((tick, position, rotation));
    }

    pub fn wake(&mut self, tick: u32) {
        if self.settled.is_some_and(|(t, _, _)| t <= tick) {
            let (_, p, q) = self.settled.take().unwrap();
            self.restart(Keyframe {
                tick,
                position: p,
                rotation: q,
                linear_velocity: Vec3::ZERO,
                angular_velocity: Vec3::ZERO,
                mode: Mode::Resting, decel: 0.0,
            });
        }
    }

    /// The pose drawn at render tick `r`.
    pub fn pose_at(&self, r: f32, physics: Physics) -> (Vec3, Quat) {
        if let Some((tick, p, q)) = self.settled {
            if r >= tick as f32 {
                return (p, q);
            }
        }
        let Some(first) = self.keyframes.first() else {
            return (Vec3::ZERO, Quat::IDENTITY);
        };
        let i = self.keyframes.partition_point(|k| k.tick as f32 <= r);
        let (mut p, mut q) = if i == 0 {
            (first.position, first.rotation)
        } else {
            let k1 = &self.keyframes[i - 1];
            let (mut p, mut q) = predict(k1, r - k1.tick as f32, physics);
            if let Some(k2) = self.keyframes.get(i) {
                let span = (k2.tick - k1.tick).max(1) as f32;
                let (p2, q2) = predict(k1, span, physics);
                let gap = k2.position - p2;
                if gap.length() <= SNAP_METRES {
                    let w = smoothstep((r - k1.tick as f32) / span);
                    p += gap * w;
                    let turn = (k2.rotation * q2.inverse()).normalize();
                    q = (Quat::IDENTITY.slerp(turn, w) * q).normalize();
                }
            }
            (p, q)
        };
        if let Some(c) = self.correction {
            let w = 1.0 - smoothstep((r - c.from_tick) / CORRECTION_TICKS);
            if w > 0.0 {
                p += c.offset * w;
                q = (Quat::IDENTITY.slerp(c.rotation, w) * q).normalize();
            }
        }
        (p, q)
    }

    /// The velocity at `r` (the newest keyframe at or before it).
    pub fn velocity_at(&self, r: f32, physics: Physics) -> (Vec3, Vec3) {
        if self.settled.is_some_and(|(t, _, _)| r >= t as f32) {
            return (Vec3::ZERO, Vec3::ZERO);
        }
        let i = self.keyframes.partition_point(|k| k.tick as f32 <= r);
        match i.checked_sub(1).and_then(|i| self.keyframes.get(i)) {
            Some(k) => (predict_velocity(k, r - k.tick as f32, physics), k.angular_velocity),
            None => (Vec3::ZERO, Vec3::ZERO),
        }
    }
}

/// The render clock: the server's tick estimated from packet arrivals, less
/// the playout delay. It never runs backwards.
#[derive(Clone, Debug)]
pub struct RenderClock {
    tick_ms: f64,
    /// server_ms - local_ms, for the least delayed packet recently seen.
    offset_ms: Option<f64>,
    pub delay_ticks: f32,
    last_render: f32,
}

impl RenderClock {
    pub fn new(hz: u32, delay_ticks: f32) -> Self {
        Self { tick_ms: 1000.0 / f64::from(hz.max(1)), offset_ms: None, delay_ticks, last_render: f32::MIN }
    }

    pub fn observe(&mut self, server_tick: u32, arrival_ms: f64) {
        let sample = f64::from(server_tick) * self.tick_ms - arrival_ms;
        self.offset_ms = Some(match self.offset_ms {
            // A faster packet moves the estimate at once; a slower path pulls
            // it back gently (1 ms per packet), so jitter does not shake it.
            Some(current) if sample > current => sample,
            Some(current) => current - (current - sample).min(1.0) * 0.05,
            None => sample,
        });
    }

    pub fn render_tick(&mut self, now_ms: f64) -> Option<f32> {
        let offset = self.offset_ms?;
        let r = ((now_ms + offset) / self.tick_ms) as f32 - self.delay_ticks;
        self.last_render = self.last_render.max(r);
        Some(self.last_render)
    }

    pub fn server_tick(&self, now_ms: f64) -> Option<f32> {
        Some(((now_ms + self.offset_ms?) / self.tick_ms) as f32)
    }
}

/// A dynamic body's drawn state at a tick: pose, velocity, spin, and the
/// centre of mass its pose is the frame of.
pub type ParentState = (Vec3, Quat, Vec3, Vec3, Vec3);

/// Every dynamic body's drawn state at `tick`, before a fracture changes the
/// structure: what the new bodies spawn from.
pub fn parent_states(
    def: &StructureDef,
    state: &StructureState,
    structure: u32,
    tick: u32,
    tracks: &HashMap<BodyKey, BodyTrack>,
    physics: Physics,
) -> HashMap<u32, ParentState> {
    let mut parents = HashMap::new();
    for &id in state.bodies().keys() {
        if let Some(track) = tracks.get(&BodyKey { structure, body: id }) {
            let track = track.before(tick);
            let (p, q) = track.pose_at(tick as f32, physics);
            let (v, w) = track.velocity_at(tick as f32, physics);
            parents.insert(id, (p, q, v, w, state.centre_of_mass(def, id)));
        }
    }
    parents
}

/// After a fracture: retire the bodies it ended and start every changed body
/// from its parent's drawn state (`v + w x r` for a moving parent, the
/// authored pose for a standing one). The client and the server's model of
/// each client both call this, so they spawn alike.
pub fn apply_spawns(
    def: &StructureDef,
    state: &StructureState,
    structure: u32,
    tick: u32,
    change: &crate::structure::FractureChange,
    parents: &HashMap<u32, ParentState>,
    tracks: &mut HashMap<BodyKey, BodyTrack>,
) {
    for id in &change.retired_bodies {
        tracks.remove(&BodyKey { structure, body: *id });
    }
    for &(id, parent) in &change.parent_of {
        let com = state.centre_of_mass(def, id);
        let spawn = match parents.get(&parent) {
            Some(&(p, q, v, w, parent_com)) if parent != ANCHORED => {
                let arm = q * (com - parent_com);
                Keyframe { tick, position: p + arm, rotation: q, linear_velocity: v + w.cross(arm), angular_velocity: w, mode: Mode::Ballistic, decel: 0.0 }
            }
            _ => Keyframe {
                tick,
                position: def.world_position + def.world_rotation * com,
                rotation: def.world_rotation,
                linear_velocity: Vec3::ZERO,
                angular_velocity: Vec3::ZERO,
                mode: Mode::Resting, decel: 0.0,
            },
        };
        tracks.entry(BodyKey { structure, body: id }).or_default().restart(spawn);
    }
}

/// Counters the lab and the debug overlay read.
#[derive(Clone, Debug, Default)]
pub struct ClientStats {
    pub keyframes: u64,
    pub late_keyframes: u64,
    pub events_applied: u64,
    pub hash_checks: u64,
    pub hash_mismatches: u64,
    /// Events applied after the render tick had passed theirs (gate G2).
    pub events_late: u64,
    pub decode_errors: u64,
    pub bootstraps: u64,
    /// Delta records whose baseline this client no longer had.
    pub missing_baselines: u64,
}

/// A structural change in body terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BodyChange {
    /// A fracture at `tick` in `structure`: these bonds broke, these chunks
    /// were removed, these bodies ended, and these have new members (new
    /// bodies among them).
    Fracture { tick: u32, structure: u32, broken_bonds: Vec<u32>, removed_chunks: Vec<u32>, retired: Vec<u32>, changed: Vec<(u32, Vec<u32>)> },
    /// The whole structural state was replaced (a bootstrap).
    Reset,
}

/// One structure, client side.
pub struct ClientStructure {
    pub def: StructureDef,
    pub state: StructureState,
}

/// The whole per-player client.
pub struct Client {
    pub physics: Physics,
    pub structures: BTreeMap<u32, ClientStructure>,
    bodies: HashMap<BodyKey, BodyTrack>,
    /// Every body's recent decoded keyframes: the baselines delta records
    /// name.
    history: HashMap<BodyKey, std::collections::VecDeque<Keyframe>>,
    pending: BTreeMap<u32, Vec<Event>>,
    next_seq: u32,
    pub clock: RenderClock,
    received: Vec<u32>,
    /// (structure, node) whose body changed since the last drain.
    slot_changes: Vec<(u32, u32)>,
    /// The same changes in body terms, for a ledger kept elsewhere (the
    /// browser's): in application order.
    body_changes: Vec<BodyChange>,
    pub stats: ClientStats,
    started: bool,
    render: f32,
}

impl Client {
    pub fn new(defs: Vec<StructureDef>, physics: Physics, hz: u32, delay_ticks: f32) -> Self {
        let structures = defs
            .into_iter()
            .map(|def| {
                let state = StructureState::new(&def);
                (def.id, ClientStructure { def, state })
            })
            .collect();
        Self {
            physics,
            structures,
            bodies: HashMap::new(),
            history: HashMap::new(),
            pending: BTreeMap::new(),
            next_seq: 0,
            clock: RenderClock::new(hz, delay_ticks),
            received: Vec::new(),
            slot_changes: Vec::new(),
            body_changes: Vec::new(),
            stats: ClientStats::default(),
            started: false,
            render: f32::MIN,
        }
    }

    pub fn started(&self) -> bool {
        self.started
    }

    /// A packet, at its arrival time.
    pub fn ingest(&mut self, bytes: &[u8], arrival_ms: f64) {
        match bytes.first() {
            Some(&PKT_PP_KEYFRAMES) => match {
                let (history, bodies) = (&self.history, &self.bodies);
                decode_keyframes_with(bytes, self.physics, &mut |key, tick| {
                    let incarnation = bodies.get(&key).map_or(0, BodyTrack::incarnation);
                    (tick >= incarnation).then(|| history.get(&key)?.iter().find(|k| k.tick == tick).copied()).flatten()
                })
            } {
                Ok((packet, missing)) => {
                    self.stats.missing_baselines += u64::from(missing);
                    self.clock.observe(packet.server_tick, arrival_ms);
                    self.received.push(packet.ordinal);
                    let render = self.render.max(self.clock.render_tick(arrival_ms).unwrap_or(f32::MIN));
                    for record in packet.records {
                        self.stats.keyframes += 1;
                        if (record.keyframe.tick as f32) < render {
                            self.stats.late_keyframes += 1;
                        }
                        self.bodies.entry(record.key).or_default().add(record.keyframe, render, self.physics);
                        let history = self.history.entry(record.key).or_default();
                        history.push_back(record.keyframe);
                        let newest = record.keyframe.tick;
                        while history.len() > HISTORY_LEN || history.front().is_some_and(|k| k.tick + HISTORY_TICKS < newest) {
                            history.pop_front();
                        }
                    }
                }
                Err(_) => self.stats.decode_errors += 1,
            },
            Some(&PKT_PP_EVENTS) => match decode_events(bytes) {
                Ok((seq, events)) => {
                    if seq >= self.next_seq {
                        self.pending.entry(seq).or_insert(events);
                    }
                }
                Err(_) => self.stats.decode_errors += 1,
            },
            Some(&PKT_PP_BOOTSTRAP) => match decode_bootstrap(bytes) {
                Ok(boot) => {
                    self.stats.bootstraps += 1;
                    self.clock.observe(boot.tick, arrival_ms);
                    for s in &boot.structures {
                        if let Some(cs) = self.structures.get_mut(&s.structure) {
                            cs.state = StructureState::from_bits(&cs.def, s.alive_bonds.clone(), s.removed_chunks.clone());
                        }
                    }
                    self.bodies.clear();
                    self.history.clear();
                    for (key, p, q) in boot.settled {
                        let mut track = BodyTrack::default();
                        track.restart(Keyframe {
                            tick: boot.tick,
                            position: p,
                            rotation: q,
                            linear_velocity: Vec3::ZERO,
                            angular_velocity: Vec3::ZERO,
                            mode: Mode::Resting, decel: 0.0,
                        });
                        track.settle(boot.tick, p, q);
                        self.bodies.insert(key, track);
                    }
                    for (key, kf) in boot.awake {
                        self.bodies.entry(key).or_default().add(kf, f32::MIN, self.physics);
                    }
                    self.pending.retain(|&seq, _| seq >= boot.next_event_seq);
                    self.next_seq = boot.next_event_seq;
                    for (&id, cs) in &self.structures {
                        for node in 0..cs.def.node_count() {
                            self.slot_changes.push((id, node));
                        }
                    }
                    self.body_changes.push(BodyChange::Reset);
                    self.started = true;
                }
                Err(_) => self.stats.decode_errors += 1,
            },
            _ => {}
        }
    }

    /// The newest datagram ordinal and the 64 before it, as an ack.
    pub fn ack(&mut self) -> Option<(u32, u64)> {
        let newest = *self.received.iter().max()?;
        let mut mask = 0u64;
        for &o in &self.received {
            if o < newest && newest - o <= 64 {
                mask |= 1 << (newest - o - 1);
            }
        }
        self.received.retain(|&o| newest.saturating_sub(o) <= 64);
        Some((newest, mask))
    }

    /// Advance to `now_ms`: apply every event the render tick has reached.
    /// Returns the render tick.
    pub fn advance(&mut self, now_ms: f64) -> Option<f32> {
        let r = self.clock.render_tick(now_ms)?;
        self.render = r;
        loop {
            let Some(events) = self.pending.get(&self.next_seq) else { break };
            // An events packet applies once the render tick reaches its
            // first event (they are in tick order).
            if events.first().is_some_and(|e| e.tick() as f32 > r) {
                break;
            }
            let events = self.pending.remove(&self.next_seq).unwrap();
            self.next_seq += 1;
            for event in events {
                if (event.tick() as f32) + 1.0 < r {
                    self.stats.events_late += 1;
                }
                self.apply(event, r);
            }
        }
        Some(r)
    }

    fn apply(&mut self, event: Event, r: f32) {
        self.stats.events_applied += 1;
        match event {
            Event::Fracture { tick, structure, broken_bonds, removed_chunks } => {
                let Some(cs) = self.structures.get_mut(&structure) else { return };
                let parents = parent_states(&cs.def, &cs.state, structure, tick, &self.bodies, self.physics);
                let change = cs.state.apply(&cs.def, &broken_bonds, &removed_chunks);
                for &node in &change.moved_chunks {
                    self.slot_changes.push((structure, node));
                }
                // A body that kept its id but changed members has a new centre
                // of mass: every member's offset on it changed too.
                for &id in &change.changed_bodies {
                    for &node in cs.state.members(id).unwrap_or(&[]) {
                        self.slot_changes.push((structure, node));
                    }
                }
                for &node in &removed_chunks {
                    self.slot_changes.push((structure, node));
                }
                apply_spawns(&cs.def, &cs.state, structure, tick, &change, &parents, &mut self.bodies);
                self.body_changes.push(BodyChange::Fracture {
                    tick,
                    structure,
                    broken_bonds,
                    removed_chunks,
                    retired: change.retired_bodies.clone(),
                    changed: change
                        .changed_bodies
                        .iter()
                        .map(|&id| (id, cs.state.members(id).map(<[u32]>::to_vec).unwrap_or_default()))
                        .collect(),
                });
            }
            Event::Settle { tick, key, position, rotation } => {
                self.bodies.entry(key).or_default().settle(tick, position, rotation);
            }
            Event::Wake { tick, key } => {
                if let Some(track) = self.bodies.get_mut(&key) {
                    track.wake(tick);
                }
            }
            Event::Hash { structure, hash, .. } => {
                if let Some(cs) = self.structures.get(&structure) {
                    self.stats.hash_checks += 1;
                    if cs.state.hash() != hash {
                        self.stats.hash_mismatches += 1;
                    }
                }
            }
        }
        let _ = r;
    }

    pub fn render_tick(&self) -> f32 {
        self.render
    }

    /// The body a chunk is drawn on: `None` for a standing chunk (it rides
    /// the structure), `Some(REMOVED)` for a removed one.
    pub fn chunk_body(&self, structure: u32, node: u32) -> Option<u32> {
        let cs = self.structures.get(&structure)?;
        match cs.state.body_of(node) {
            ANCHORED => None,
            id => Some(id),
        }
    }

    /// A chunk's offset on its body, structure frame (rest less the body's
    /// centre of mass; the rest itself on the standing structure).
    pub fn chunk_local(&self, structure: u32, node: u32) -> Vec3 {
        let Some(cs) = self.structures.get(&structure) else { return Vec3::ZERO };
        let rest = cs.def.rest[node as usize];
        match cs.state.body_of(node) {
            ANCHORED | REMOVED => rest,
            id => rest - cs.state.centre_of_mass(&cs.def, id),
        }
    }

    /// Every live dynamic body and its drawn pose at the render tick.
    pub fn body_poses(&self) -> Vec<(BodyKey, Vec3, Quat, bool)> {
        let mut out = Vec::new();
        for (&structure, cs) in &self.structures {
            for &id in cs.state.bodies().keys() {
                let key = BodyKey { structure, body: id };
                if let Some(track) = self.bodies.get(&key) {
                    let (p, q) = track.pose_at(self.render, self.physics);
                    let settled = track.settled().is_some_and(|(t, _, _)| self.render >= t as f32);
                    out.push((key, p, q, settled));
                }
            }
        }
        out
    }

    pub fn track(&self, key: BodyKey) -> Option<&BodyTrack> {
        self.bodies.get(&key)
    }

    pub fn drain_body_changes(&mut self) -> Vec<BodyChange> {
        std::mem::take(&mut self.body_changes)
    }

    pub fn drain_slot_changes(&mut self) -> Vec<(u32, u32)> {
        std::mem::take(&mut self.slot_changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structure::tests::column;
    use crate::wire::{encode_events, encode_keyframes, KeyframePacket, KeyframeRecord};

    fn physics() -> Physics {
        Physics::at_hz(60, -9.81)
    }

    fn ballistic(tick: u32, p: Vec3, v: Vec3) -> Keyframe {
        Keyframe { tick, position: p, rotation: Quat::IDENTITY, linear_velocity: v, angular_velocity: Vec3::ZERO, mode: Mode::Ballistic, decel: 0.0 }
    }

    #[test]
    fn a_track_lands_on_every_keyframe_without_a_jump() {
        let ph = physics();
        let mut track = BodyTrack::default();
        let k1 = ballistic(0, Vec3::ZERO, Vec3::new(5.0, 5.0, 0.0));
        // The truth bounced a little differently: the next keyframe is 10 cm off.
        let (p2, _) = predict(&k1, 30.0, ph);
        let k2 = ballistic(30, p2 + Vec3::new(0.0, 0.1, 0.0), Vec3::new(5.0, 2.0, 0.0));
        track.add(k1, -10.0, ph);
        track.add(k2, -10.0, ph);
        assert!((track.pose_at(0.0, ph).0 - k1.position).length() < 1e-5);
        assert!((track.pose_at(30.0, ph).0 - k2.position).length() < 1e-5);
        // No frame steps more than the motion plus a sliver of the gap.
        let mut last = track.pose_at(0.0, ph).0;
        for i in 1..=300 {
            let r = i as f32 * 0.1;
            let p = track.pose_at(r, ph).0;
            assert!((p - last).length() < 0.06, "step at {r}: {}", (p - last).length());
            last = p;
        }
    }

    #[test]
    fn a_late_keyframe_blends_in_and_a_far_one_snaps() {
        let ph = physics();
        let mut track = BodyTrack::default();
        track.add(ballistic(0, Vec3::ZERO, Vec3::X), -1.0, ph);
        // Drawing reached tick 20; a keyframe for tick 10 arrives 0.5 m off.
        let (p10, _) = predict(&track.keyframes()[0], 10.0, ph);
        let shown = track.pose_at(20.0, ph).0;
        track.add(ballistic(10, p10 + Vec3::new(0.5, 0.0, 0.0), Vec3::X), 20.0, ph);
        assert!((track.pose_at(20.0, ph).0 - shown).length() < 1e-4, "no jump at the switch");
        let settled = track.pose_at(20.0 + CORRECTION_TICKS, ph).0;
        let target = predict(&track.keyframes()[1], 10.0 + CORRECTION_TICKS, ph).0;
        assert!((settled - target).length() < 1e-4, "converged after 150 ms");
        // Ten metres off: snap.
        let mut far = BodyTrack::default();
        far.add(ballistic(0, Vec3::ZERO, Vec3::ZERO), -1.0, ph);
        far.add(ballistic(5, Vec3::new(10.0, 0.0, 0.0), Vec3::ZERO), 20.0, ph);
        assert!((far.pose_at(20.0, ph).0.x - 10.0).abs() < 0.5);
    }

    #[test]
    fn events_apply_at_their_tick_and_fragments_spawn_where_the_wall_was() {
        let def = column(6);
        let mut client = Client::new(vec![def.clone()], physics(), 60, 5.0);
        let boot = crate::wire::encode_bootstrap(&crate::wire::Bootstrap {
            tick: 100,
            next_event_seq: 0,
            structures: vec![],
            settled: vec![],
            awake: vec![],
        });
        client.ingest(&boot, 0.0);
        // A fracture at tick 110 and the new body's first keyframe.
        client.ingest(&encode_events(0, &[Event::Fracture { tick: 110, structure: 3, broken_bonds: vec![2], removed_chunks: vec![] }]), 1.0);
        let key = BodyKey { structure: 3, body: 3 };
        let start = def.world_position + Vec3::new(0.0, 4.0, 0.0);
        let kf = ballistic(111, start, Vec3::new(0.0, 0.0, 2.0));
        client.ingest(&encode_keyframes(&KeyframePacket { server_tick: 111, ordinal: 0, records: vec![KeyframeRecord::absolute(key, 0, kf)] }, physics()), 2.0);
        // Before the render tick reaches 110 the column stands.
        let r = client.advance(2.0).unwrap();
        assert!(r < 110.0);
        assert_eq!(client.chunk_body(3, 4), None);
        // Later: the break applied, the body spawned where its chunks were.
        let r = client.advance(2.0 + 1000.0 / 60.0 * (110.5 - r as f64)).unwrap();
        assert!(r >= 110.0, "{r}");
        assert_eq!(client.chunk_body(3, 4), Some(3));
        let spawn = client.track(key).unwrap().keyframes()[0];
        assert_eq!(spawn.tick, 110);
        assert!((spawn.position - start).length() < 1e-5);
        assert!(client.drain_slot_changes().contains(&(3, 4)));
        assert_eq!(client.stats.events_late, 0);
        // Body 3 loses chunk 5: it keeps its id, its centre of mass moves, and
        // chunk 4 -- still on body 3 -- has a new offset to be redrawn with.
        client.ingest(&encode_events(1, &[Event::Fracture { tick: 112, structure: 3, broken_bonds: vec![4], removed_chunks: vec![] }]), 3.0);
        let before = client.chunk_local(3, 4);
        client.advance(2.0 + 1000.0 / 60.0 * 10.0);
        assert_eq!(client.chunk_body(3, 4), Some(3));
        assert_ne!(client.chunk_local(3, 4), before);
        assert!(client.drain_slot_changes().contains(&(3, 4)), "a re-offset member is reported");
    }
}
