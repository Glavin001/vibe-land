use std::f64::consts::{FRAC_PI_4, FRAC_PI_8};

use nalgebra::Vector3;

use super::{PhysicsArena, PlayerMotorState};
use crate::constants::PLAYER_AOI_RADIUS_M;
use crate::movement::Vec3d;
use crate::protocol::InputCmd;

/// Hard minimum separation between a new spawn and any existing threat.
/// Below this, capsule colliders would overlap and the newcomer would be
/// within melee range (MELEE_RANGE_M = 1 m + capsule radius) on the first
/// frame. Used as a bool filter in legacy lane mode; area-mode scoring
/// always picks the max-distance candidate, so this acts only as a
/// final-resort floor.
const SPAWN_MIN_CLEARANCE_M: f64 = 2.5;

/// A spawn is "visible" when at least one other living player is within
/// this radius — otherwise the newcomer falls outside every other
/// player's area-of-interest and sees an empty world until someone
/// walks close enough to be replicated. We rank visible candidates
/// ahead of invisible ones so the anti-camper scoring doesn't fling
/// fresh spawns to opposite corners of maps where authored spawn areas
/// sit farther apart than `PLAYER_AOI_RADIUS_M`. 0.9 keeps a small
/// buffer so a candidate right at the AOI edge doesn't flicker in and
/// out on the other player's first step.
const SPAWN_VISIBILITY_RADIUS_M: f64 = PLAYER_AOI_RADIUS_M as f64 * 0.9;

impl PhysicsArena {
    fn spawn_lane_position(lane: u32) -> (f64, f64) {
        (lane as f64 * 2.0, 0.0)
    }

    /// Squared distance in the X/Z plane from (x, z) to the nearest living
    /// player. Only players are scored as combat threats — inanimate dynamic
    /// bodies (crates, ragdolls) and unoccupied vehicles can't smack the
    /// newcomer, so pulling spawns away from them would just distort the
    /// distribution without preventing the "swarmed at spawn" problem.
    /// Dead players are skipped since they can't attack until they respawn.
    /// Returns `f64::INFINITY` when no live players are present.
    fn min_player_distance_sq(&self, x: f64, z: f64) -> f64 {
        let mut best = f64::INFINITY;
        for player in self.players.values() {
            if player.dead {
                continue;
            }
            let dx = player.position.x - x;
            let dz = player.position.z - z;
            let d = dx * dx + dz * dz;
            if d < best {
                best = d;
            }
        }
        best
    }

    /// True if (x, z) has no rigid body within `SPAWN_MIN_CLEARANCE_M`. This
    /// is a physical-overlap guard distinct from combat scoring: a newcomer
    /// must not spawn inside a player capsule, a crate, or a parked car.
    fn spawn_lane_is_clear(&self, x: f64, z: f64) -> bool {
        let clearance_sq = SPAWN_MIN_CLEARANCE_M * SPAWN_MIN_CLEARANCE_M;

        for player in self.players.values() {
            let dx = player.position.x - x;
            let dz = player.position.z - z;
            if dx * dx + dz * dz < clearance_sq {
                return false;
            }
        }
        for body in self.dynamic.dynamic_bodies.values() {
            if let Some(rb) = self.dynamic.sim.rigid_bodies.get(body.body_handle) {
                let pos = rb.translation();
                let dx = pos.x as f64 - x;
                let dz = pos.z as f64 - z;
                if dx * dx + dz * dz < clearance_sq {
                    return false;
                }
            }
        }
        for vehicle in self.vehicles.values() {
            if let Some(rb) = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body) {
                let pos = rb.translation();
                let dx = pos.x as f64 - x;
                let dz = pos.z as f64 - z;
                if dx * dx + dz * dz < clearance_sq {
                    return false;
                }
            }
        }
        true
    }

    pub fn terrain_y_at(&self, x: f64, z: f64) -> f64 {
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

    fn next_spawn_position_from_areas(&mut self) -> Vec3d {
        // Enumerate every candidate across every spawn area and score each
        // by squared distance to the nearest living player. Visibility
        // (min distance ≤ SPAWN_VISIBILITY_RADIUS_M) ranks above raw
        // score so the newcomer stays inside someone else's AOI —
        // otherwise on maps with widely-spaced spawn areas the
        // anti-camper bias can fling the spawn beyond replication
        // range and make the match look empty. Within each visibility
        // bucket the candidate with the greatest minimum distance wins,
        // picking the area farthest from spawn campers and within that
        // area the spot with the most breathing room. Candidates that
        // physically overlap an existing collider (player, crate,
        // vehicle) are demoted behind clear ones so we don't spawn
        // inside something; on a densely occupied map we still return
        // the best we have as a last resort.
        //
        // When no players are alive, every candidate ties on score (∞)
        // and visibility doesn't apply (no one to be visible to). Ties
        // are broken by round-robin rotation starting at
        // `next_spawn_index`, then by candidate index within the area,
        // so successive empty-map spawns still distribute across areas.
        // After picking, we advance `next_spawn_index` past the chosen
        // area so the next spawn prefers a different one.
        let area_count = self.spawn_areas.len() as u32;
        let rotation_base = self.next_spawn_index;
        let visibility_sq = SPAWN_VISIBILITY_RADIUS_M * SPAWN_VISIBILITY_RADIUS_M;
        let has_live_players = self.players.values().any(|p| !p.dead);

        let mut best_x = 0.0_f64;
        let mut best_z = 0.0_f64;
        let mut best_area_idx: u32 = 0;
        let mut best_score = f64::NEG_INFINITY;
        let mut best_clear = false;
        let mut best_visible = false;
        let mut best_rotation_rank: u32 = u32::MAX;
        let mut best_candidate_rank: u32 = u32::MAX;

        for area_offset in 0..area_count {
            let area_idx = (rotation_base.wrapping_add(area_offset)) % area_count;
            let (cx, cz, radius) = {
                let area = &self.spawn_areas[area_idx as usize];
                (
                    area.position[0] as f64,
                    area.position[2] as f64,
                    area.radius as f64,
                )
            };
            for (candidate_rank, (x, z)) in spawn_area_candidates(cx, cz, radius).enumerate() {
                let score = self.min_player_distance_sq(x, z);
                let clear = self.spawn_lane_is_clear(x, z);
                // A candidate is "visible" when at least one other live
                // player sits within AOI. Irrelevant on empty maps —
                // fold it out so round-robin still distributes evenly.
                let visible = !has_live_players || score <= visibility_sq;
                let candidate_rank = candidate_rank as u32;
                // Prefer (visible, physically clear, higher player score).
                // Break floating-point ties on the score with an epsilon
                // so near-identical candidates don't churn the winner.
                let better = if best_rotation_rank == u32::MAX {
                    true
                } else if visible != best_visible {
                    visible && !best_visible
                } else if clear != best_clear {
                    clear && !best_clear
                } else if score > best_score + 1e-3 {
                    true
                } else if score + 1e-3 < best_score {
                    false
                } else if area_offset != best_rotation_rank {
                    area_offset < best_rotation_rank
                } else {
                    candidate_rank < best_candidate_rank
                };
                if better {
                    best_x = x;
                    best_z = z;
                    best_area_idx = area_idx;
                    best_score = score;
                    best_clear = clear;
                    best_visible = visible;
                    best_rotation_rank = area_offset;
                    best_candidate_rank = candidate_rank;
                }
            }
        }

        self.next_spawn_index = best_area_idx.wrapping_add(1);
        let terrain_y = self.terrain_y_at(best_x, best_z);
        Vector3::<f64>::new(best_x, terrain_y + 2.0, best_z)
    }

    fn next_spawn_position(&mut self) -> Vec3d {
        if !self.spawn_areas.is_empty() {
            return self.next_spawn_position_from_areas();
        }
        self.next_spawn_position_legacy()
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3d {
        let spawn = self.next_spawn_position();

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
                spawn_protected: false,
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

    pub fn respawn_player(&mut self, player_id: u32) -> Option<[f32; 3]> {
        let spawn = self.next_spawn_position();
        let state = self.players.get_mut(&player_id)?;
        state.position = spawn;
        state.velocity = Vec3d::zeros();
        state.yaw = 0.0;
        state.pitch = 0.0;
        state.on_ground = false;
        state.hp = 100;
        state.dead = false;
        state.spawn_protected = false;
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
    use crate::{movement::MoveConfig, physics_arena::PhysicsArena, world_document::SpawnArea};

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
        let spawn = arena.spawn_player(1);
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
        arena.spawn_player(1);
        let pos = arena.respawn_player(1).expect("respawn should succeed");
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
        // Area B sits ~57 m from A — far enough that the anti-camper
        // scorer clearly prefers it over A when a camper is present,
        // but inside the AOI visibility radius so the newcomer can
        // still see (and be seen by) the camper. Tests upstream of the
        // visibility constraint used artificial 200 m spacing, which
        // collided with the SPAWN_VISIBILITY_RADIUS_M guard.
        let mut arena = arena_with_areas(vec![
            SpawnArea {
                id: 1,
                position: [0.0, 0.0, 0.0],
                radius: 5.0,
            },
            SpawnArea {
                id: 2,
                position: [40.0, 0.0, 40.0],
                radius: 5.0,
            },
        ]);

        let s1 = arena.spawn_player(1);
        let s2 = arena.spawn_player(2);

        // Empty map → round-robin tie-break puts player 1 in area A.
        // Player 1 then becomes a threat at A's centre, so the scorer
        // sends player 2 to area B (40,40).
        let dist1_a = ((s1.x * s1.x + s1.z * s1.z) as f32).sqrt();
        let dist2_b = (((s2.x - 40.0).powi(2) + (s2.z - 40.0).powi(2)) as f32).sqrt();
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
        let spawn = arena.spawn_player(1);
        // Legacy lane 0 → x=0.0, z=0.0
        assert!(
            spawn.x.abs() < 0.5,
            "legacy spawn should be near x=0, got x={:.2}",
            spawn.x
        );
    }

    #[test]
    fn spawn_maximizes_distance_from_occupying_player() {
        // With a single wide area and a player camping dead-center, the
        // scoring algorithm should push the newcomer to the outer ring
        // (≈ 0.85 · radius away) — far more than the 2.5 m hard minimum.
        let radius = 20.0_f32;
        let mut arena = arena_with_areas(vec![single_area(0.0, 0.0, radius)]);
        arena.spawn_player(1); // occupies center (0, 0)
        let s2 = arena.spawn_player(2);
        let dist = ((s2.x * s2.x + s2.z * s2.z) as f32).sqrt();
        // Outer ring sits at 0.85 · radius. Allow a small epsilon for
        // terrain sampling / floating-point drift.
        let expected_outer_ring = 0.85 * radius;
        assert!(
            dist >= expected_outer_ring - 0.1,
            "player 2 spawn ({:.2},{:.2}) should land on the outer ring (~{:.1} m) \
             to maximize separation from player 1 at origin, got {:.2} m",
            s2.x,
            s2.z,
            expected_outer_ring,
            dist,
        );
    }

    #[test]
    fn crowded_area_still_returns_position_within_radius() {
        // Tiny area where every candidate ends up near-overlapping a
        // previous spawn. The scorer has no good answer, but it must
        // still return *some* position inside the area rather than
        // bailing out or returning off-map junk.
        let mut arena = arena_with_areas(vec![single_area(50.0, 50.0, 0.5)]);
        for id in 1..=17 {
            arena.spawn_player(id);
        }
        let crowded = arena.spawn_player(18);
        let dx = crowded.x as f32 - 50.0;
        let dz = crowded.z as f32 - 50.0;
        // Every candidate sits within 0.85·radius = 0.425 m of center,
        // so the returned spawn must stay within a tight disc.
        assert!(
            dx * dx + dz * dz < 1.0,
            "crowded-area spawn ({:.2},{:.2}) should still land inside the area near (50,50)",
            crowded.x,
            crowded.z
        );
    }

    #[test]
    fn spawn_prefers_area_farthest_from_existing_threat() {
        // Spawn-camper scenario: a hostile player is stationed at area A.
        // New spawns must prefer area B even if A appears first in the
        // round-robin rotation. B sits within the AOI visibility radius
        // so the newcomer still replicates to the camper — the scorer
        // used to allow 150 m here but that's beyond AOI in a real
        // match, so the visibility guard now rejects such positions.
        let mut arena = arena_with_areas(vec![
            SpawnArea {
                id: 1,
                position: [0.0, 0.0, 0.0],
                radius: 4.0,
            },
            SpawnArea {
                id: 2,
                position: [50.0, 0.0, 0.0],
                radius: 4.0,
            },
        ]);

        // Place a spawn camper at area A's centre by having player 1
        // spawn there first (no threats yet → round-robin picks A).
        let s1 = arena.spawn_player(1);
        assert!(
            s1.x.abs() <= 4.0 && s1.z.abs() <= 4.0,
            "setup: player 1 should land in area A at origin"
        );

        // Every subsequent spawn should flee to area B — the camper in A
        // keeps the "min distance to threat" much smaller for any
        // candidate inside A than for any candidate inside B.
        for id in 2..=5 {
            let spawn = arena.spawn_player(id);
            let dist_from_b = ((spawn.x - 50.0).powi(2) + spawn.z.powi(2)).sqrt();
            assert!(
                dist_from_b <= 4.0,
                "player {id} spawn ({:.2},{:.2}) should land in area B (50,0), \
                 not next to the camper in area A",
                spawn.x,
                spawn.z
            );
        }
    }

    #[test]
    fn spawn_picks_opposite_side_of_single_area_from_threat() {
        // With a single big area and one threat parked off-centre, the
        // scorer must pick the candidate diametrically opposite so the
        // newcomer gets the most breathing room available.
        let radius = 15.0_f32;
        let mut arena = arena_with_areas(vec![single_area(0.0, 0.0, radius)]);
        arena.spawn_player(1);

        // Forcibly move player 1 to +X edge (simulate a camper pushing
        // forward) so the scorer sees a lopsided threat distribution.
        {
            let state = arena.players.get_mut(&1).expect("player 1 exists");
            state.position.x = 12.0;
            state.position.z = 0.0;
        }

        let s2 = arena.spawn_player(2);
        // Expect the winning candidate to have negative x (opposite the
        // camper). The outer ring at 0.85·15 ≈ 12.75 m should be picked
        // on the -X side.
        assert!(
            s2.x < -5.0,
            "player 2 spawn ({:.2},{:.2}) should land on the far side from the \
             camper at (12, 0), got x={:.2}",
            s2.x,
            s2.z,
            s2.x,
        );
    }

    #[test]
    fn empty_map_spawns_round_robin_across_areas() {
        // On an empty map all candidates tie on score (∞). The tie-break
        // is round-robin rotation so successive spawns spread out
        // instead of piling into one area.
        let mut arena = arena_with_areas(vec![
            SpawnArea {
                id: 1,
                position: [0.0, 0.0, 0.0],
                radius: 3.0,
            },
            SpawnArea {
                id: 2,
                position: [1000.0, 0.0, 0.0],
                radius: 3.0,
            },
            SpawnArea {
                id: 3,
                position: [0.0, 0.0, 1000.0],
                radius: 3.0,
            },
        ]);

        // Remove each player right after spawning so the map stays empty
        // and we only observe the round-robin tiebreak behavior.
        let mut area_hits = [0u32; 3];
        for id in 1..=6u32 {
            let spawn = arena.spawn_player(id);
            let hit = if spawn.x.abs() < 50.0 && spawn.z.abs() < 50.0 {
                0
            } else if (spawn.x - 1000.0).abs() < 50.0 {
                1
            } else {
                2
            };
            area_hits[hit] += 1;
            arena.remove_player(id);
        }
        // Six spawns across three areas → each area sees exactly two.
        assert_eq!(
            area_hits,
            [2, 2, 2],
            "empty-map spawns should distribute evenly via round-robin, got {area_hits:?}"
        );
    }

    #[test]
    fn spawn_stays_visible_even_when_all_areas_are_beyond_aoi() {
        // Two spawn areas placed farther apart than the AOI visibility
        // radius. Without the visibility guard the anti-camper scorer
        // would happily send the newcomer to the invisible-far area,
        // breaking replication: neither client's snapshot would list
        // the other. With the guard, we take the closer area even
        // though it means landing next to the camper, because being
        // seen is worth more than a few extra metres of breathing
        // room.
        let mut arena = arena_with_areas(vec![
            SpawnArea {
                id: 1,
                position: [0.0, 0.0, 0.0],
                radius: 4.0,
            },
            SpawnArea {
                id: 2,
                position: [110.0, 0.0, 0.0],
                radius: 4.0,
            },
        ]);

        let s1 = arena.spawn_player(1);
        assert!(
            s1.x.abs() <= 4.0 && s1.z.abs() <= 4.0,
            "setup: player 1 should land in area A"
        );

        let s2 = arena.spawn_player(2);
        let dist_from_a = (s2.x.powi(2) + s2.z.powi(2)).sqrt();
        let dist_from_b = ((s2.x - 110.0).powi(2) + s2.z.powi(2)).sqrt();
        // Area B is 110 m from A, beyond SPAWN_VISIBILITY_RADIUS_M
        // (0.9 × PLAYER_AOI_RADIUS_M = 72 m). The visibility guard
        // must keep the newcomer in A where they can still replicate.
        assert!(
            dist_from_a <= 4.0,
            "player 2 ({:.1},{:.1}) should fall back to visible area A \
             (dist A = {:.1}, dist B = {:.1}) so both players can see each other",
            s2.x,
            s2.z,
            dist_from_a,
            dist_from_b,
        );
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
