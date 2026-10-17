//! Remote players' interpolation, exactly as the web client does it: `net/interpolation.ts`
//! `PlayerInterpolator` (with `insertWithRestHold`), ported in f64 and microseconds so both clients
//! place a remote player at the same point for the same render time (tests/interp_parity.rs replays
//! the web's own output, client/scripts/player-interp-fixture.mts).
//!
//! Each player keeps its newest samples by server time. A sample that follows a gap after the
//! player was at rest gets a rest hold first (a copy of the resting sample one snapshot interval
//! earlier), so a player the server left out while still does not start moving early. Sampling
//! between two samples interpolates position, velocity and angles (hp and flags switch at the
//! midpoint); past the newest it extrapolates along the newest velocity for at most 100 ms.

use std::collections::HashMap;

/// `MAX_PLAYER_EXTRAPOLATION_US`.
pub const MAX_PLAYER_EXTRAPOLATION_US: f64 = 100_000.0;
/// `REST_SPEED` (m/s): at or under this a player's sample is at rest.
pub const REST_SPEED: f64 = 0.05;
/// `REST_HOLD_TOLERANCE_M`: a late snapshot farther than this from a rest hold replaces it.
pub const REST_HOLD_TOLERANCE_M: f64 = 0.01;

/// `PlayerSample`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayerSample {
    pub server_time_us: f64,
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub yaw: f64,
    pub pitch: f64,
    pub hp: f64,
    pub flags: f64,
    /// A rest hold, not a snapshot.
    pub held: bool,
}

fn hypot3(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn distance3(a: [f64; 3], b: [f64; 3]) -> f64 {
    hypot3([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
}

fn at_rest(s: &PlayerSample) -> bool {
    hypot3(s.velocity) <= REST_SPEED
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn lerp3(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/// `lerpAngle`: the short way round.
fn lerp_angle(a: f64, b: f64, t: f64) -> f64 {
    let tau = std::f64::consts::PI * 2.0;
    let mut delta = b - a;
    while delta > std::f64::consts::PI {
        delta -= tau;
    }
    while delta < -std::f64::consts::PI {
        delta += tau;
    }
    a + delta * t
}

/// `insertWithRestHold` for players.
fn insert_with_rest_hold(queue: &mut Vec<PlayerSample>, sample: PlayerSample, snapshot_interval_us: f64) {
    let mut i = queue.len();
    while i > 0 {
        i -= 1;
        let hold = queue[i];
        if !hold.held || hold.server_time_us < sample.server_time_us {
            continue;
        }
        if hold.server_time_us == sample.server_time_us || distance3(hold.position, sample.position) > REST_HOLD_TOLERANCE_M {
            queue.remove(i);
        }
    }
    let mut at = queue.len();
    while at > 0 && queue[at - 1].server_time_us > sample.server_time_us {
        at -= 1;
    }
    queue.insert(at, sample);
    if at > 0 {
        let previous = queue[at - 1];
        if snapshot_interval_us > 0.0
            && sample.server_time_us - previous.server_time_us > 1.5 * snapshot_interval_us
            && at_rest(&previous)
        {
            queue.insert(at, PlayerSample { server_time_us: sample.server_time_us - snapshot_interval_us, held: true, ..previous });
        }
    }
}

/// `PlayerInterpolator`: samples by player, oldest first.
#[derive(Clone, Debug)]
pub struct PlayerInterpolator {
    by_entity: HashMap<u32, Vec<PlayerSample>>,
    max_samples: usize,
}

impl Default for PlayerInterpolator {
    fn default() -> Self {
        Self::new(32)
    }
}

impl PlayerInterpolator {
    pub fn new(max_samples: usize) -> Self {
        Self { by_entity: HashMap::new(), max_samples }
    }

    /// A snapshot's sample of `id`; `snapshot_interval_us` (0 for none) enables rest holds.
    pub fn push(&mut self, id: u32, sample: PlayerSample, snapshot_interval_us: f64) {
        let queue = self.by_entity.entry(id).or_default();
        insert_with_rest_hold(queue, PlayerSample { held: false, ..sample }, snapshot_interval_us);
        while queue.len() > self.max_samples {
            queue.remove(0);
        }
    }

    pub fn remove(&mut self, id: u32) {
        self.by_entity.remove(&id);
    }

    pub fn retain_only(&mut self, ids: &[u32]) {
        self.by_entity.retain(|id, _| ids.contains(id));
    }

    pub fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.by_entity.keys().copied()
    }

    /// Rest holds in every player's history now.
    pub fn holds(&self) -> usize {
        self.by_entity.values().flatten().filter(|s| s.held).count()
    }

    /// The newest snapshot sample (not a rest hold).
    pub fn latest(&self, id: u32) -> Option<PlayerSample> {
        self.by_entity.get(&id)?.iter().rev().find(|s| !s.held).copied()
    }

    /// The player at `target_us` of server time.
    pub fn sample(&self, id: u32, target_us: f64) -> Option<PlayerSample> {
        let queue = self.by_entity.get(&id)?;
        let first = *queue.first()?;
        if queue.len() == 1 || target_us <= first.server_time_us {
            return Some(first);
        }
        for pair in queue.windows(2) {
            let (prev, next) = (pair[0], pair[1]);
            if target_us <= next.server_time_us {
                if next.server_time_us == prev.server_time_us {
                    return Some(next);
                }
                let alpha = ((target_us - prev.server_time_us) / (next.server_time_us - prev.server_time_us)).clamp(0.0, 1.0);
                return Some(PlayerSample {
                    server_time_us: target_us,
                    position: lerp3(prev.position, next.position, alpha),
                    velocity: lerp3(prev.velocity, next.velocity, alpha),
                    yaw: lerp_angle(prev.yaw, next.yaw, alpha),
                    pitch: lerp_angle(prev.pitch, next.pitch, alpha),
                    hp: if alpha < 0.5 { prev.hp } else { next.hp },
                    flags: if alpha < 0.5 { prev.flags } else { next.flags },
                    held: false,
                });
            }
        }
        let latest = *queue.last()?;
        let extrapolate_us = (target_us - latest.server_time_us).min(MAX_PLAYER_EXTRAPOLATION_US);
        if extrapolate_us <= 0.0 {
            return Some(latest);
        }
        let s = extrapolate_us / 1_000_000.0;
        let p = latest.position;
        let v = latest.velocity;
        Some(PlayerSample { position: [p[0] + v[0] * s, p[1] + v[1] * s, p[2] + v[2] * s], ..latest })
    }
}
