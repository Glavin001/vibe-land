use std::collections::{HashMap, VecDeque};

use nalgebra::{Quaternion, UnitQuaternion};
use rapier3d::prelude::{point, Ball, Capsule, Cuboid, Isometry, Ray, RayCast, Vector};

const HEAD_CENTER_OFFSET_Y: f32 = 0.75;
const HEAD_RADIUS: f32 = 0.22;

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
pub struct HistoricalDynamicBody {
    pub server_tick: u32,
    pub server_time_ms: u32,
    pub position: [f32; 3],
    pub quaternion: [f32; 4],
    pub half_extents: [f32; 3],
    pub shape_type: u8,
    pub alive: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct InterpolatedDynamicBody {
    pub position: [f32; 3],
    pub quaternion: [f32; 4],
    pub half_extents: [f32; 3],
    pub shape_type: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct DynamicBodyHit {
    pub body_id: u32,
    pub distance: f32,
    pub normal: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
pub struct HitResult {
    pub victim_id: u32,
    pub distance: f32,
    pub zone: HitZone,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HitZone {
    Body,
    Head,
}

#[derive(Clone, Copy, Debug)]
pub struct PlayerHit {
    pub distance: f32,
    pub zone: HitZone,
}

pub struct LagCompHistory {
    max_age_ms: u32,
    per_player: HashMap<u32, VecDeque<HistoricalCapsule>>,
    per_dynamic_body: HashMap<u32, VecDeque<HistoricalDynamicBody>>,
}

impl LagCompHistory {
    pub fn new(max_age_ms: u32) -> Self {
        Self {
            max_age_ms,
            per_player: HashMap::new(),
            per_dynamic_body: HashMap::new(),
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

    pub fn record_dynamic_body(&mut self, body_id: u32, snapshot: HistoricalDynamicBody) {
        let queue = self.per_dynamic_body.entry(body_id).or_default();
        queue.push_back(snapshot);
        while let Some(front) = queue.front() {
            if snapshot.server_time_ms.saturating_sub(front.server_time_ms) > self.max_age_ms {
                queue.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn remove_dynamic_body(&mut self, body_id: u32) {
        self.per_dynamic_body.remove(&body_id);
    }

    pub fn resolve_hitscan(
        &self,
        shooter_id: u32,
        origin: [f32; 3],
        dir: [f32; 3],
        target_time_ms: u32,
        blocker_toi: Option<f32>,
    ) -> Option<HitResult> {
        let mut dir = dir;
        normalize_in_place(&mut dir);

        let mut best: Option<HitResult> = None;
        for (&victim_id, history) in &self.per_player {
            if victim_id == shooter_id {
                continue;
            }
            let Some(capsule) = sample_capsule(history, target_time_ms) else {
                continue;
            };
            let Some(hit) = classify_player_hitscan(
                origin,
                dir,
                capsule.center,
                capsule.half_segment,
                capsule.radius,
                blocker_toi,
            ) else {
                continue;
            };
            if best
                .map(|best_hit| hit.distance < best_hit.distance)
                .unwrap_or(true)
            {
                best = Some(HitResult {
                    victim_id,
                    distance: hit.distance,
                    zone: hit.zone,
                });
            }
        }

        best
    }

    pub fn sample_player(
        &self,
        player_id: u32,
        target_time_ms: u32,
    ) -> Option<InterpolatedCapsule> {
        let history = self.per_player.get(&player_id)?;
        sample_capsule(history, target_time_ms)
    }

    pub fn resolve_dynamic_body_hitscan(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        target_time_ms: u32,
        max_toi: f32,
    ) -> Option<DynamicBodyHit> {
        let mut dir = dir;
        normalize_in_place(&mut dir);

        let mut best: Option<DynamicBodyHit> = None;
        for (&body_id, history) in &self.per_dynamic_body {
            let Some(body) = sample_dynamic_body(history, target_time_ms) else {
                continue;
            };
            let Some((distance, normal)) =
                ray_dynamic_body_intersection(origin, dir, body, max_toi)
            else {
                continue;
            };
            if best
                .map(|best_hit| distance < best_hit.distance)
                .unwrap_or(true)
            {
                best = Some(DynamicBodyHit {
                    body_id,
                    distance,
                    normal,
                });
            }
        }
        best
    }

    pub fn sample_dynamic_body(
        &self,
        body_id: u32,
        target_time_ms: u32,
    ) -> Option<InterpolatedDynamicBody> {
        let history = self.per_dynamic_body.get(&body_id)?;
        sample_dynamic_body(history, target_time_ms)
    }
}

fn sample_capsule(
    queue: &VecDeque<HistoricalCapsule>,
    target_time_ms: u32,
) -> Option<InterpolatedCapsule> {
    if queue.is_empty() {
        return None;
    }
    if queue.len() == 1 {
        let only = queue[0];
        if !only.alive {
            return None;
        }
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
                if !next.alive {
                    return None;
                }
                return Some(InterpolatedCapsule {
                    center: next.center,
                    radius: next.radius,
                    half_segment: next.half_segment,
                });
            }
            let span = (next.server_time_ms - prev.server_time_ms) as f32;
            let t = ((target_time_ms.saturating_sub(prev.server_time_ms)) as f32 / span)
                .clamp(0.0, 1.0);
            if (!prev.alive && t < 0.5) || (!next.alive && t >= 0.5) {
                return None;
            }
            return Some(InterpolatedCapsule {
                center: lerp3(prev.center, next.center, t),
                radius: prev.radius + (next.radius - prev.radius) * t,
                half_segment: prev.half_segment + (next.half_segment - prev.half_segment) * t,
            });
        }
        prev = next;
    }

    if !prev.alive {
        return None;
    }
    Some(InterpolatedCapsule {
        center: prev.center,
        radius: prev.radius,
        half_segment: prev.half_segment,
    })
}

fn sample_dynamic_body(
    queue: &VecDeque<HistoricalDynamicBody>,
    target_time_ms: u32,
) -> Option<InterpolatedDynamicBody> {
    if queue.is_empty() {
        return None;
    }
    if queue.len() == 1 {
        let only = queue[0];
        if !only.alive {
            return None;
        }
        return Some(InterpolatedDynamicBody {
            position: only.position,
            quaternion: only.quaternion,
            half_extents: only.half_extents,
            shape_type: only.shape_type,
        });
    }

    let mut prev = queue.front().copied()?;
    for &next in queue.iter().skip(1) {
        if target_time_ms <= next.server_time_ms {
            if next.server_time_ms == prev.server_time_ms {
                if !next.alive {
                    return None;
                }
                return Some(InterpolatedDynamicBody {
                    position: next.position,
                    quaternion: next.quaternion,
                    half_extents: next.half_extents,
                    shape_type: next.shape_type,
                });
            }
            let span = (next.server_time_ms - prev.server_time_ms) as f32;
            let t = ((target_time_ms.saturating_sub(prev.server_time_ms)) as f32 / span)
                .clamp(0.0, 1.0);
            if (!prev.alive && t < 0.5) || (!next.alive && t >= 0.5) {
                return None;
            }
            return Some(InterpolatedDynamicBody {
                position: lerp3(prev.position, next.position, t),
                quaternion: slerp_quat(prev.quaternion, next.quaternion, t),
                half_extents: lerp3(prev.half_extents, next.half_extents, t),
                shape_type: if t < 0.5 {
                    prev.shape_type
                } else {
                    next.shape_type
                },
            });
        }
        prev = next;
    }

    if !prev.alive {
        return None;
    }
    Some(InterpolatedDynamicBody {
        position: prev.position,
        quaternion: prev.quaternion,
        half_extents: prev.half_extents,
        shape_type: prev.shape_type,
    })
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn slerp_quat(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    let qa = UnitQuaternion::from_quaternion(Quaternion::new(a[3], a[0], a[1], a[2]));
    let qb = UnitQuaternion::from_quaternion(Quaternion::new(b[3], b[0], b[1], b[2]));
    let q = qa.slerp(&qb, t);
    [q.i, q.j, q.k, q.w]
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
    let mut dir = dir;
    normalize_in_place(&mut dir);
    let ray = Ray::new(
        point![origin[0], origin[1], origin[2]],
        Vector::new(dir[0], dir[1], dir[2]),
    );
    let shape = Capsule::new_y(half_segment, radius);
    let pose = Isometry::translation(center[0], center[1], center[2]);
    shape
        .cast_ray_and_get_normal(&pose, &ray, f32::MAX, false)
        .map(|hit| hit.time_of_impact)
}

pub fn classify_player_hitscan(
    origin: [f32; 3],
    dir: [f32; 3],
    center: [f32; 3],
    half_segment: f32,
    radius: f32,
    blocker_toi: Option<f32>,
) -> Option<PlayerHit> {
    let mut dir = dir;
    normalize_in_place(&mut dir);

    let max_toi = blocker_toi.unwrap_or(f32::MAX);
    let ray = Ray::new(
        point![origin[0], origin[1], origin[2]],
        Vector::new(dir[0], dir[1], dir[2]),
    );

    let body_pose = Isometry::translation(center[0], center[1], center[2]);
    let body_shape = Capsule::new_y(half_segment, radius);
    let body_hit = body_shape.cast_ray_and_get_normal(&body_pose, &ray, max_toi, false);

    let head_pose = Isometry::translation(center[0], center[1] + HEAD_CENTER_OFFSET_Y, center[2]);
    let head_shape = Ball::new(HEAD_RADIUS);
    let head_hit = head_shape.cast_ray_and_get_normal(&head_pose, &ray, max_toi, false);

    match (body_hit, head_hit) {
        (None, None) => None,
        (Some(body), None) => Some(PlayerHit {
            distance: body.time_of_impact,
            zone: HitZone::Body,
        }),
        (None, Some(head)) => Some(PlayerHit {
            distance: head.time_of_impact,
            zone: HitZone::Head,
        }),
        (Some(body), Some(head)) => Some(PlayerHit {
            distance: body.time_of_impact.min(head.time_of_impact),
            zone: HitZone::Head,
        }),
    }
}

pub fn ray_dynamic_body_intersection(
    origin: [f32; 3],
    dir: [f32; 3],
    body: InterpolatedDynamicBody,
    max_toi: f32,
) -> Option<(f32, [f32; 3])> {
    let mut dir = dir;
    normalize_in_place(&mut dir);

    let ray = Ray::new(
        point![origin[0], origin[1], origin[2]],
        Vector::new(dir[0], dir[1], dir[2]),
    );
    let rotation = UnitQuaternion::from_quaternion(Quaternion::new(
        body.quaternion[3],
        body.quaternion[0],
        body.quaternion[1],
        body.quaternion[2],
    ));
    let pose = Isometry::from_parts(
        point![body.position[0], body.position[1], body.position[2]]
            .coords
            .into(),
        rotation,
    );

    let hit = if body.shape_type == 1 {
        Ball::new(body.half_extents[0]).cast_ray_and_get_normal(&pose, &ray, max_toi, true)
    } else {
        Cuboid::new(Vector::new(
            body.half_extents[0],
            body.half_extents[1],
            body.half_extents[2],
        ))
        .cast_ray_and_get_normal(&pose, &ray, max_toi, true)
    }?;
    Some((
        hit.time_of_impact,
        [hit.normal.x, hit.normal.y, hit.normal.z],
    ))
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

    fn dynamic_body(
        tick: u32,
        time_ms: u32,
        position: [f32; 3],
        shape_type: u8,
    ) -> HistoricalDynamicBody {
        HistoricalDynamicBody {
            server_tick: tick,
            server_time_ms: time_ms,
            position,
            quaternion: [0.0, 0.0, 0.0, 1.0],
            half_extents: if shape_type == 1 {
                [0.5, 0.0, 0.0]
            } else {
                [0.5, 0.5, 0.5]
            },
            shape_type,
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
        assert!(
            (result.center[0] - 5.0).abs() < 0.01,
            "midpoint should be 5.0, got {}",
            result.center[0]
        );
    }

    #[test]
    fn hitscan_hits_victim() {
        let mut hist = LagCompHistory::new(1000);
        hist.record(1, capsule(1, 100, [0.0, 0.0, 0.0]));
        hist.record(2, capsule(1, 100, [5.0, 0.0, 0.0]));

        let result = hist.resolve_hitscan(1, [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 100, None);
        assert!(result.is_some());
        assert_eq!(result.unwrap().victim_id, 2);
    }

    #[test]
    fn hitscan_world_geometry_blocks_victim() {
        let mut hist = LagCompHistory::new(1000);
        hist.record(1, capsule(1, 100, [0.0, 0.0, 0.0]));
        hist.record(2, capsule(1, 100, [10.0, 0.0, 0.0]));

        let result = hist.resolve_hitscan(1, [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 100, Some(3.0));
        assert!(result.is_none());
    }

    #[test]
    fn sample_dynamic_body_interpolates_position() {
        let mut hist = LagCompHistory::new(1000);
        hist.record_dynamic_body(7, dynamic_body(1, 100, [0.0, 0.0, 0.0], 1));
        hist.record_dynamic_body(7, dynamic_body(2, 200, [10.0, 0.0, 0.0], 1));

        let body = hist.sample_dynamic_body(7, 150).unwrap();
        assert!((body.position[0] - 5.0).abs() < 0.01);
    }

    #[test]
    fn resolve_dynamic_body_hitscan_rewinds_moving_body() {
        let mut hist = LagCompHistory::new(1000);
        hist.record_dynamic_body(9, dynamic_body(1, 100, [5.0, 0.0, 0.0], 1));
        hist.record_dynamic_body(9, dynamic_body(2, 200, [5.0, 0.0, 4.0], 1));

        let hit = hist
            .resolve_dynamic_body_hitscan([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 100, f32::MAX)
            .expect("rewound ray should hit old body position");
        assert_eq!(hit.body_id, 9);
        assert!(hit.distance > 4.0 && hit.distance < 6.0);

        let miss_now =
            hist.resolve_dynamic_body_hitscan([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 200, f32::MAX);
        assert!(
            miss_now.is_none(),
            "same ray should miss current moved body pose"
        );
    }

    #[test]
    fn ray_hits_capsule_body() {
        let result = ray_capsule_intersection(
            [-5.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            0.45,
            0.35,
        );
        assert!(result.is_some());
        let toi = result.unwrap();
        assert!(
            toi > 4.0 && toi < 5.0,
            "toi should be near 4.65, got {}",
            toi
        );
    }

    #[test]
    fn ray_misses_capsule() {
        let result = ray_capsule_intersection(
            [-5.0, 10.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            0.45,
            0.35,
        );
        assert!(result.is_none());
    }

    #[test]
    fn classify_hitscan_body() {
        let result = classify_player_hitscan(
            [0.0, 0.0, -5.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0],
            0.45,
            0.35,
            None,
        )
        .unwrap();
        assert_eq!(result.zone, HitZone::Body);
    }

    #[test]
    fn classify_hitscan_head() {
        let result = classify_player_hitscan(
            [0.0, 0.75, -5.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0],
            0.45,
            0.35,
            None,
        )
        .unwrap();
        assert_eq!(result.zone, HitZone::Head);
    }

    #[test]
    fn classify_hitscan_respects_blocker() {
        let result = classify_player_hitscan(
            [0.0, 0.75, -5.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0],
            0.45,
            0.35,
            Some(4.0),
        );
        assert!(result.is_none());
    }
}
