use std::collections::{HashMap, VecDeque};

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
}

#[derive(Clone, Copy, Debug)]
pub struct HitResult {
    pub victim_id: u32,
    pub distance: f32,
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

    pub fn remove_player(&mut self, player_id: u32) {
        self.per_player.remove(&player_id);
    }

    pub fn resolve_hitscan(
        &self,
        shooter_id: u32,
        origin: [f32; 3],
        dir: [f32; 3],
        estimated_one_way_ms: u32,
        server_time_ms: u32,
        client_interp_ms: u32,
        world_toi: Option<f32>,
    ) -> Option<HitResult> {
        let mut dir = dir;
        normalize_in_place(&mut dir);

        let rewind_time_ms = server_time_ms
            .saturating_sub(estimated_one_way_ms)
            .saturating_sub(client_interp_ms);

        let mut best: Option<HitResult> = None;
        for (&victim_id, history) in &self.per_player {
            if victim_id == shooter_id {
                continue;
            }
            let Some(capsule) = sample_capsule(history, rewind_time_ms) else {
                continue;
            };
            if let Some(toi) = ray_capsule_intersection(origin, dir, capsule.center, capsule.half_segment, capsule.radius) {
                if toi < 0.0 {
                    continue;
                }
                if world_toi.map(|value| value < toi).unwrap_or(false) {
                    continue;
                }
                if best.map(|best_hit| toi < best_hit.distance).unwrap_or(true) {
                    best = Some(HitResult {
                        victim_id,
                        distance: toi,
                    });
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
                });
            }
            let span = (next.server_time_ms - prev.server_time_ms) as f32;
            let t = ((target_time_ms.saturating_sub(prev.server_time_ms)) as f32 / span).clamp(0.0, 1.0);
            return Some(InterpolatedCapsule {
                center: lerp3(prev.center, next.center, t),
                radius: prev.radius + (next.radius - prev.radius) * t,
                half_segment: prev.half_segment + (next.half_segment - prev.half_segment) * t,
            });
        }
        prev = next;
    }

    Some(InterpolatedCapsule {
        center: prev.center,
        radius: prev.radius,
        half_segment: prev.half_segment,
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

pub fn ray_capsule_intersection(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn capsule(tick: u32, time_ms: u32, center: [f32; 3]) -> HistoricalCapsule {
        HistoricalCapsule {
            server_tick: tick,
            server_time_ms: time_ms,
            center,
            radius: 0.35,
            half_segment: 0.45,
            alive: true,
        }
    }

    #[test]
    fn record_and_evict_by_max_age() {
        let mut hist = LagCompHistory::new(100);
        hist.record(1, capsule(1, 0, [0.0, 0.0, 0.0]));
        hist.record(1, capsule(2, 50, [1.0, 0.0, 0.0]));
        hist.record(1, capsule(3, 100, [2.0, 0.0, 0.0]));
        hist.record(1, capsule(4, 150, [3.0, 0.0, 0.0]));

        let queue = hist.per_player.get(&1).unwrap();
        assert!(queue.front().unwrap().server_time_ms >= 50);
    }

    #[test]
    fn remove_player_cleans_up() {
        let mut hist = LagCompHistory::new(1000);
        hist.record(1, capsule(1, 0, [0.0, 0.0, 0.0]));
        hist.record(2, capsule(1, 0, [1.0, 0.0, 0.0]));

        hist.remove_player(1);

        assert!(!hist.per_player.contains_key(&1));
        assert!(hist.per_player.contains_key(&2));
    }

    #[test]
    fn sample_single_entry_returns_it() {
        let mut queue = VecDeque::new();
        queue.push_back(capsule(1, 100, [5.0, 1.0, 3.0]));

        let result = sample_capsule(&queue, 100).unwrap();
        assert!((result.center[0] - 5.0).abs() < 0.001);
    }

    #[test]
    fn sample_interpolates_between_two_entries() {
        let mut queue = VecDeque::new();
        queue.push_back(capsule(1, 100, [0.0, 0.0, 0.0]));
        queue.push_back(capsule(2, 200, [10.0, 0.0, 0.0]));

        let result = sample_capsule(&queue, 150).unwrap();
        assert!((result.center[0] - 5.0).abs() < 0.01, "midpoint should be 5.0, got {}", result.center[0]);
    }

    #[test]
    fn hitscan_hits_victim() {
        let mut hist = LagCompHistory::new(1000);
        hist.record(1, capsule(1, 100, [0.0, 0.0, 0.0]));
        hist.record(2, capsule(1, 100, [5.0, 0.0, 0.0]));

        let result = hist.resolve_hitscan(1, [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 0, 100, 0, None);
        assert!(result.is_some());
        assert_eq!(result.unwrap().victim_id, 2);
    }

    #[test]
    fn hitscan_world_geometry_blocks_victim() {
        let mut hist = LagCompHistory::new(1000);
        hist.record(1, capsule(1, 100, [0.0, 0.0, 0.0]));
        hist.record(2, capsule(1, 100, [10.0, 0.0, 0.0]));

        let result = hist.resolve_hitscan(1, [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 0, 100, 0, Some(3.0));
        assert!(result.is_none());
    }

    #[test]
    fn ray_hits_capsule_body() {
        let result = ray_capsule_intersection(
            [-5.0, 0.0, 0.0], [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0], 0.45, 0.35,
        );
        assert!(result.is_some());
        let toi = result.unwrap();
        assert!(toi > 4.0 && toi < 5.0, "toi should be near 4.65, got {}", toi);
    }

    #[test]
    fn ray_misses_capsule() {
        let result = ray_capsule_intersection(
            [-5.0, 10.0, 0.0], [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0], 0.45, 0.35,
        );
        assert!(result.is_none());
    }
}
