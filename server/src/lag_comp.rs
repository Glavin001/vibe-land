use std::collections::{HashMap, VecDeque};

use crate::protocol::FireCmd;

#[derive(Clone, Copy, Debug)]
pub struct HistoricalCapsule {
    pub server_tick: u32,
    pub server_time_ms: u32,
    pub center: [f32; 3],
    pub radius: f32,
    pub half_segment: f32,
    pub alive: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct InterpolatedCapsule {
    pub center: [f32; 3],
    pub radius: f32,
    pub half_segment: f32,
    pub alive: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct HitResult {
    pub victim_id: u32,
    pub distance: f32,
    pub point: [f32; 3],
    pub damage: u16,
}

pub struct LagCompHistory {
    max_age_ms: u32,
    per_player: HashMap<u32, VecDeque<HistoricalCapsule>>,
}

impl LagCompHistory {
    pub fn new(max_age_ms: u32) -> Self {
        Self {
            max_age_ms,
            per_player: HashMap::new(),
        }
    }

    pub fn record(&mut self, player_id: u32, snapshot: HistoricalCapsule) {
        let queue = self.per_player.entry(player_id).or_default();
        queue.push_back(snapshot);
        while let Some(front) = queue.front() {
            if snapshot.server_time_ms.saturating_sub(front.server_time_ms) > self.max_age_ms {
                queue.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn sample_player_at(&self, player_id: u32, target_time_ms: u32) -> Option<InterpolatedCapsule> {
        let queue = self.per_player.get(&player_id)?;
        sample_capsule(queue, target_time_ms)
    }

    pub fn resolve_hitscan<F>(
        &self,
        shooter_id: u32,
        estimated_one_way_ms: u32,
        server_time_ms: u32,
        shot: &FireCmd,
        mut world_block_toi: F,
    ) -> Option<HitResult>
    where
        F: FnMut(f32) -> Option<f32>,
    {
        let rewind_time_ms = server_time_ms
            .saturating_sub(estimated_one_way_ms)
            .saturating_sub(shot.client_interp_ms as u32);

        let mut dir = shot.dir;
        normalize_in_place(&mut dir);

        let mut best: Option<HitResult> = None;
        for (&victim_id, history) in &self.per_player {
            if victim_id == shooter_id {
                continue;
            }
            let Some(capsule) = sample_capsule(history, rewind_time_ms) else {
                continue;
            };
            if !capsule.alive {
                continue;
            }

            if let Some(toi) = ray_capsule_intersection(shot.origin, dir, capsule.center, capsule.half_segment, capsule.radius) {
                if toi < 0.0 {
                    continue;
                }
                let blocked = world_block_toi(toi).map(|world_toi| world_toi < toi).unwrap_or(false);
                if blocked {
                    continue;
                }
                let point = [
                    shot.origin[0] + dir[0] * toi,
                    shot.origin[1] + dir[1] * toi,
                    shot.origin[2] + dir[2] * toi,
                ];
                let candidate = HitResult {
                    victim_id,
                    distance: toi,
                    point,
                    damage: 34,
                };
                if best.map(|b| toi < b.distance).unwrap_or(true) {
                    best = Some(candidate);
                }
            }
        }
        best
    }
}

fn sample_capsule(queue: &VecDeque<HistoricalCapsule>, target_time_ms: u32) -> Option<InterpolatedCapsule> {
    if queue.is_empty() {
        return None;
    }
    if queue.len() == 1 {
        let only = queue[0];
        return Some(InterpolatedCapsule {
            center: only.center,
            radius: only.radius,
            half_segment: only.half_segment,
            alive: only.alive,
        });
    }

    let mut prev = queue.front().copied()?;
    for &next in queue.iter().skip(1) {
        if target_time_ms <= next.server_time_ms {
            if next.server_time_ms == prev.server_time_ms {
                return Some(InterpolatedCapsule {
                    center: next.center,
                    radius: next.radius,
                    half_segment: next.half_segment,
                    alive: next.alive,
                });
            }
            let span = (next.server_time_ms - prev.server_time_ms) as f32;
            let t = ((target_time_ms.saturating_sub(prev.server_time_ms)) as f32 / span).clamp(0.0, 1.0);
            return Some(InterpolatedCapsule {
                center: lerp3(prev.center, next.center, t),
                radius: prev.radius + (next.radius - prev.radius) * t,
                half_segment: prev.half_segment + (next.half_segment - prev.half_segment) * t,
                alive: if t < 0.5 { prev.alive } else { next.alive },
            });
        }
        prev = next;
    }

    Some(InterpolatedCapsule {
        center: prev.center,
        radius: prev.radius,
        half_segment: prev.half_segment,
        alive: prev.alive,
    })
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn normalize_in_place(v: &mut [f32; 3]) {
    let len_sq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if len_sq <= f32::EPSILON {
        *v = [0.0, 0.0, 1.0];
        return;
    }
    let inv = len_sq.sqrt().recip();
    v[0] *= inv;
    v[1] *= inv;
    v[2] *= inv;
}

/// Ray vs vertical capsule intersection.
///
/// The capsule is centered at `center` and extends along the Y axis from
/// `center.y - half_segment` to `center.y + half_segment`, plus spherical caps of `radius`.
///
/// This is adapted from the standard ray-capsule analytic intersection used in real-time graphics.
fn ray_capsule_intersection(
    origin: [f32; 3],
    dir: [f32; 3],
    center: [f32; 3],
    half_segment: f32,
    radius: f32,
) -> Option<f32> {
    let a = [center[0], center[1] - half_segment, center[2]];
    let b = [center[0], center[1] + half_segment, center[2]];
    let ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let oa = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];

    let baba = dot(ba, ba);
    let bard = dot(ba, dir);
    let baoa = dot(ba, oa);
    let rdoa = dot(dir, oa);
    let oaoa = dot(oa, oa);

    let qa = baba - bard * bard;
    let qb = baba * rdoa - baoa * bard;
    let qc = baba * oaoa - baoa * baoa - radius * radius * baba;
    let h = qb * qb - qa * qc;

    if h >= 0.0 {
        let t = (-qb - h.sqrt()) / qa.max(1e-6);
        let y = baoa + t * bard;
        if t >= 0.0 && y > 0.0 && y < baba {
            return Some(t);
        }

        // Fall through to the caps.
        let oc = if y <= 0.0 {
            oa
        } else {
            [origin[0] - b[0], origin[1] - b[1], origin[2] - b[2]]
        };
        return ray_sphere_intersection(oc, dir, radius);
    }

    None
}

fn ray_sphere_intersection(offset_origin: [f32; 3], dir: [f32; 3], radius: f32) -> Option<f32> {
    let b = dot(offset_origin, dir);
    let c = dot(offset_origin, offset_origin) - radius * radius;
    let h = b * b - c;
    if h < 0.0 {
        return None;
    }
    let t = -b - h.sqrt();
    (t >= 0.0).then_some(t)
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
