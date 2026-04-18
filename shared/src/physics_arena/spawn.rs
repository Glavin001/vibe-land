use std::f64::consts::{FRAC_PI_4, FRAC_PI_8};

use nalgebra::Vector3;

use super::{PhysicsArena, PlayerMotorState};
use crate::movement::Vec3d;
use crate::protocol::InputCmd;
use crate::world_document::PlayerKind;

impl PhysicsArena {
    fn spawn_lane_position(lane: u32) -> (f64, f64) {
        (lane as f64 * 2.0, 0.0)
    }

    fn spawn_lane_is_clear(&self, x: f64, z: f64) -> bool {
        const SPAWN_CLEARANCE_RADIUS_M: f64 = 2.5;
        let clearance_sq = SPAWN_CLEARANCE_RADIUS_M * SPAWN_CLEARANCE_RADIUS_M;

        if self.players.values().any(|player| {
            let dx = player.position.x - x;
            let dz = player.position.z - z;
            dx * dx + dz * dz < clearance_sq
        }) {
            return false;
        }

        if self.dynamic.dynamic_bodies.values().any(|body| {
            let Some(rb) = self.dynamic.sim.rigid_bodies.get(body.body_handle) else {
                return false;
            };
            let pos = rb.translation();
            let dx = pos.x as f64 - x;
            let dz = pos.z as f64 - z;
            dx * dx + dz * dz < clearance_sq
        }) {
            return false;
        }

        if self.vehicles.values().any(|vehicle| {
            let Some(rb) = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body) else {
                return false;
            };
            let pos = rb.translation();
            let dx = pos.x as f64 - x;
            let dz = pos.z as f64 - z;
            dx * dx + dz * dz < clearance_sq
        }) {
            return false;
        }

        true
    }

    fn terrain_y_at(&self, x: f64, z: f64) -> f64 {
        self.cast_static_world_ray([x as f32, 40.0, z as f32], [0.0, -1.0, 0.0], 100.0, None)
            .map(|toi| 40.0 - toi as f64)
            .unwrap_or(0.0)
    }

    fn next_spawn_position_legacy(&mut self) -> Vec3d {
        let selected_lane = (0..8)
            .map(|offset| self.next_spawn_index + offset)
            .find(|candidate| {
                let (x, z) = Self::spawn_lane_position(candidate % 8);
                self.spawn_lane_is_clear(x, z)
            })
            .unwrap_or(self.next_spawn_index);
        self.next_spawn_index = selected_lane.saturating_add(1);

        let lane = selected_lane % 8;
        let (x, z) = Self::spawn_lane_position(lane);
        let terrain_y = self.terrain_y_at(x, z);
        Vector3::<f64>::new(x, terrain_y + 2.0, z)
    }

    fn next_spawn_position_from_areas(&mut self, kind: PlayerKind) -> Vec3d {
        // Build an index list of areas that accept this player kind. Preserve
        // round-robin across the authored area order so two humans land in
        // different human-allowed areas even if bot-only areas are interleaved.
        let mut kind_indices: Vec<usize> = (0..self.spawn_areas.len())
            .filter(|&i| self.spawn_areas[i].allows(kind))
            .collect();
        if kind_indices.is_empty() {
            // No area allows this kind — fall back to any area, then legacy
            // lanes if even that is empty (preserves never-refuse-to-spawn).
            kind_indices = (0..self.spawn_areas.len()).collect();
            if kind_indices.is_empty() {
                return self.next_spawn_position_legacy();
            }
        }

        let area_count = kind_indices.len() as u32;

        for area_offset in 0..area_count {
            let list_idx = ((self.next_spawn_index + area_offset) % area_count) as usize;
            let area_idx = kind_indices[list_idx];
            let (cx, cz, radius) = {
                let area = &self.spawn_areas[area_idx];
                (
                    area.position[0] as f64,
                    area.position[2] as f64,
                    area.radius as f64,
                )
            };

            let candidates = spawn_area_candidates(cx, cz, radius);
            for (x, z) in candidates {
                if self.spawn_lane_is_clear(x, z) {
                    self.next_spawn_index = self.next_spawn_index.wrapping_add(1);
                    let terrain_y = self.terrain_y_at(x, z);
                    return Vector3::<f64>::new(x, terrain_y + 2.0, z);
                }
            }
        }

        self.next_spawn_index = self.next_spawn_index.wrapping_add(1);
        let list_idx = (self.next_spawn_index.wrapping_sub(1) % area_count) as usize;
        let area_idx = kind_indices[list_idx];
        let (cx, cz) = {
            let area = &self.spawn_areas[area_idx];
            (area.position[0] as f64, area.position[2] as f64)
        };
        let terrain_y = self.terrain_y_at(cx, cz);
        Vector3::<f64>::new(cx, terrain_y + 2.0, cz)
    }

    fn next_spawn_position(&mut self, kind: PlayerKind) -> Vec3d {
        if !self.spawn_areas.is_empty() {
            return self.next_spawn_position_from_areas(kind);
        }
        self.next_spawn_position_legacy()
    }

    pub fn spawn_player(&mut self, player_id: u32, kind: PlayerKind) -> Vec3d {
        let spawn = self.next_spawn_position(kind);

        let handle = self.dynamic.sim.create_player_collider(spawn, player_id);
        self.players.insert(
            player_id,
            PlayerMotorState {
                collider: handle,
                position: spawn,
                velocity: Vec3d::zeros(),
                yaw: 0.0,
                pitch: 0.0,
                on_ground: false,
                hp: 100,
                dead: false,
                last_input: InputCmd::default(),
                max_speed_override: None,
                energy: crate::constants::STARTING_ENERGY,
            },
        );

        spawn
    }

    pub fn remove_player(&mut self, player_id: u32) {
        self.detach_player_from_vehicles(player_id);
        if let Some(player) = self.players.remove(&player_id) {
            self.dynamic.sim.remove_player_collider(player.collider);
        }
    }

    pub fn respawn_player(&mut self, player_id: u32, kind: PlayerKind) -> Option<[f32; 3]> {
        let spawn = self.next_spawn_position(kind);
        let state = self.players.get_mut(&player_id)?;
        state.position = spawn;
        state.velocity = Vec3d::zeros();
        state.yaw = 0.0;
        state.pitch = 0.0;
        state.on_ground = false;
        state.hp = 100;
        state.dead = false;
        state.last_input = InputCmd::default();
        state.energy = crate::constants::STARTING_ENERGY;
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        Some([spawn.x as f32, spawn.y as f32, spawn.z as f32])
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        movement::MoveConfig,
        physics_arena::PhysicsArena,
        world_document::{PlayerKind, SpawnArea},
    };

    fn arena_with_areas(areas: Vec<SpawnArea>) -> PhysicsArena {
        let mut a = PhysicsArena::new(MoveConfig::default());
        a.set_spawn_areas(areas);
        a
    }

    fn single_area(cx: f32, cz: f32, radius: f32) -> SpawnArea {
        SpawnArea {
            id: 1,
            position: [cx, 0.0, cz],
            radius,
            allowed_kinds: vec![PlayerKind::Human, PlayerKind::Bot],
        }
    }

    #[test]
    fn spawn_area_candidates_yields_17_positions() {
        let pts: Vec<_> = super::spawn_area_candidates(0.0, 0.0, 10.0).collect();
        assert_eq!(pts.len(), 17); // 1 center + 8 inner + 8 outer
        assert_eq!(pts[0], (0.0, 0.0));
    }

    #[test]
    fn spawn_area_candidates_center_is_exact_area_center() {
        let first = super::spawn_area_candidates(7.0, -3.0, 5.0).next().unwrap();
        assert_eq!(first, (7.0, -3.0));
    }

    #[test]
    fn player_spawn_lands_within_area_radius() {
        let (cx, cz, radius) = (20.0_f32, -15.0_f32, 8.0_f32);
        let mut arena = arena_with_areas(vec![single_area(cx, cz, radius)]);
        let spawn = arena.spawn_player(1, PlayerKind::Human);
        let dx = spawn.x as f32 - cx;
        let dz = spawn.z as f32 - cz;
        assert!(
            dx * dx + dz * dz <= radius * radius,
            "spawn ({:.2}, {:.2}) is outside area (cx={cx}, cz={cz}, r={radius})",
            spawn.x,
            spawn.z,
        );
    }

    #[test]
    fn respawn_also_lands_within_area_radius() {
        let (cx, cz, radius) = (10.0_f32, 5.0_f32, 6.0_f32);
        let mut arena = arena_with_areas(vec![single_area(cx, cz, radius)]);
        arena.spawn_player(1, PlayerKind::Human);
        let pos = arena
            .respawn_player(1, PlayerKind::Human)
            .expect("respawn should succeed");
        let dx = pos[0] - cx;
        let dz = pos[2] - cz;
        assert!(
            dx * dx + dz * dz <= radius * radius,
            "respawn ({:.2}, {:.2}) is outside area (cx={cx}, cz={cz}, r={radius})",
            pos[0],
            pos[2],
        );
    }

    #[test]
    fn round_robin_distributes_across_two_areas() {
        let mut arena = arena_with_areas(vec![
            SpawnArea {
                id: 1,
                position: [0.0, 0.0, 0.0],
                radius: 5.0,
                allowed_kinds: vec![PlayerKind::Human, PlayerKind::Bot],
            },
            SpawnArea {
                id: 2,
                position: [200.0, 0.0, 200.0],
                radius: 5.0,
                allowed_kinds: vec![PlayerKind::Human, PlayerKind::Bot],
            },
        ]);

        let s1 = arena.spawn_player(1, PlayerKind::Human);
        let s2 = arena.spawn_player(2, PlayerKind::Human);

        // Round-robin: player 1 → area A (0,0), player 2 → area B (200,200)
        let dist1_a = ((s1.x * s1.x + s1.z * s1.z) as f32).sqrt();
        let dist2_b = (((s2.x - 200.0).powi(2) + (s2.z - 200.0).powi(2)) as f32).sqrt();
        assert!(
            dist1_a <= 5.0,
            "player 1 ({:.1},{:.1}) not in area A",
            s1.x,
            s1.z
        );
        assert!(
            dist2_b <= 5.0,
            "player 2 ({:.1},{:.1}) not in area B",
            s2.x,
            s2.z
        );
    }

    #[test]
    fn legacy_lane_spawn_used_when_no_areas() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        assert!(arena.spawn_areas.is_empty());
        let spawn = arena.spawn_player(1, PlayerKind::Human);
        // Legacy lane 0 → x=0.0, z=0.0
        assert!(
            spawn.x.abs() < 0.5,
            "legacy spawn should be near x=0, got x={:.2}",
            spawn.x
        );
    }

    #[test]
    fn clearance_check_avoids_occupied_center() {
        let mut arena = arena_with_areas(vec![single_area(0.0, 0.0, 20.0)]);
        arena.spawn_player(1, PlayerKind::Human); // occupies center (0, 0)
        let s2 = arena.spawn_player(2, PlayerKind::Human);
        // Player 2 must be > SPAWN_CLEARANCE_RADIUS_M (2.5 m) away from player 1 at (0,0)
        let dist = ((s2.x * s2.x + s2.z * s2.z) as f32).sqrt();
        assert!(
            dist > 2.5,
            "player 2 spawn ({:.2},{:.2}) collides with player 1 at origin",
            s2.x,
            s2.z
        );
    }

    #[test]
    fn fallback_to_area_center_when_all_positions_occupied() {
        // A tiny area that can only fit one player; a second spawn falls back to area center
        let mut arena = arena_with_areas(vec![single_area(50.0, 50.0, 0.5)]);
        // Fill all 17 candidate positions by spawning many players
        for id in 1..=17 {
            arena.spawn_player(id, PlayerKind::Human);
        }
        // 18th spawn hits the fallback path (area center)
        let fallback = arena.spawn_player(18, PlayerKind::Human);
        let dx = fallback.x as f32 - 50.0;
        let dz = fallback.z as f32 - 50.0;
        // Fallback returns the area center itself
        assert!(
            dx * dx + dz * dz < 1.0,
            "fallback spawn ({:.2},{:.2}) not near area center (50,50)",
            fallback.x,
            fallback.z
        );
    }

    fn kind_area(id: u32, cx: f32, cz: f32, kinds: Vec<PlayerKind>) -> SpawnArea {
        SpawnArea {
            id,
            position: [cx, 0.0, cz],
            radius: 3.0,
            allowed_kinds: kinds,
        }
    }

    #[test]
    fn human_only_area_rejects_bot_spawn() {
        let mut arena = arena_with_areas(vec![
            kind_area(1, 0.0, 0.0, vec![PlayerKind::Human]),
            kind_area(2, 100.0, 100.0, vec![PlayerKind::Bot]),
        ]);
        let bot_spawn = arena.spawn_player(1, PlayerKind::Bot);
        let dist_to_bot_area =
            (((bot_spawn.x - 100.0).powi(2) + (bot_spawn.z - 100.0).powi(2)) as f32).sqrt();
        assert!(
            dist_to_bot_area < 3.5,
            "bot should spawn in bot-only area at (100,100); got ({:.2},{:.2})",
            bot_spawn.x,
            bot_spawn.z,
        );
    }

    #[test]
    fn bot_only_area_rejects_human_spawn() {
        let mut arena = arena_with_areas(vec![
            kind_area(1, 0.0, 0.0, vec![PlayerKind::Bot]),
            kind_area(2, 100.0, 100.0, vec![PlayerKind::Human]),
        ]);
        let human_spawn = arena.spawn_player(1, PlayerKind::Human);
        let dist_to_human_area =
            (((human_spawn.x - 100.0).powi(2) + (human_spawn.z - 100.0).powi(2)) as f32).sqrt();
        assert!(
            dist_to_human_area < 3.5,
            "human should spawn in human-only area at (100,100); got ({:.2},{:.2})",
            human_spawn.x,
            human_spawn.z,
        );
    }

    #[test]
    fn no_area_allows_kind_falls_back_to_any_area() {
        // Both areas are bot-only; a human request should still spawn somewhere
        // rather than refuse. Fall-back picks from the full area list.
        let mut arena = arena_with_areas(vec![
            kind_area(1, 0.0, 0.0, vec![PlayerKind::Bot]),
            kind_area(2, 100.0, 100.0, vec![PlayerKind::Bot]),
        ]);
        let human_spawn = arena.spawn_player(1, PlayerKind::Human);
        // Must be near either (0,0) or (100,100); never at a default (0,0,0)-like lane
        let near_a = ((human_spawn.x.powi(2) + human_spawn.z.powi(2)) as f32).sqrt() < 3.5;
        let near_b = (((human_spawn.x - 100.0).powi(2)
            + (human_spawn.z - 100.0).powi(2)) as f32)
            .sqrt()
            < 3.5;
        assert!(
            near_a || near_b,
            "fallback should spawn human inside an authored area"
        );
    }

    #[test]
    fn default_allowed_kinds_accepts_all() {
        let mut arena = arena_with_areas(vec![single_area(0.0, 0.0, 3.0)]);
        let human = arena.spawn_player(1, PlayerKind::Human);
        let bot = arena.spawn_player(2, PlayerKind::Bot);
        assert!(((human.x.powi(2) + human.z.powi(2)) as f32).sqrt() < 3.5);
        assert!(((bot.x.powi(2) + bot.z.powi(2)) as f32).sqrt() < 3.5);
    }
}

/// Generate candidate spawn positions distributed across a circular area.
/// Returns center first, then inner ring (0.5r), then outer ring (0.85r).
fn spawn_area_candidates(cx: f64, cz: f64, radius: f64) -> impl Iterator<Item = (f64, f64)> {
    let inner_r = radius * 0.5;
    let outer_r = radius * 0.85;

    let center = std::iter::once((cx, cz));

    let inner = (0u32..8).map(move |i| {
        let angle = i as f64 * FRAC_PI_4;
        (cx + inner_r * angle.cos(), cz + inner_r * angle.sin())
    });

    let outer = (0u32..8).map(move |i| {
        let angle = i as f64 * FRAC_PI_4 + FRAC_PI_8;
        (cx + outer_r * angle.cos(), cz + outer_r * angle.sin())
    });

    center.chain(inner).chain(outer)
}
