use nalgebra as na;

#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;

use super::{elapsed_ms, now_marker, PhysicsArena, PlayerDamageOutcome};
use crate::constants::{FLAG_DEAD, FLAG_IN_VEHICLE, FLAG_ON_GROUND, FLAG_SPAWN_PROTECTED};
use crate::protocol::InputCmd;

struct PlayerTickWork {
    player_id: u32,
    collider: rapier3d::prelude::ColliderHandle,
    position: super::Vec3d,
    velocity: super::Vec3d,
    yaw: f64,
    pitch: f64,
    on_ground: bool,
    input: InputCmd,
    ground_material_multiplier: f32,
    max_speed_override: Option<f64>,
}

struct PlayerTickOutput {
    player_id: u32,
    result: super::PlayerTickResult,
    new_position: super::Vec3d,
    new_velocity: super::Vec3d,
    new_yaw: f64,
    new_pitch: f64,
    new_on_ground: bool,
}

impl PhysicsArena {
    pub fn simulate_player_tick(
        &mut self,
        player_id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<super::PlayerTickResult> {
        if self.vehicle_of_player.contains_key(&player_id) {
            if let Some(state) = self.players.get_mut(&player_id) {
                state.last_input = input.clone();
            }
            return None;
        }

        let (player_x, player_z, max_speed_override) = {
            let Some(state) = self.players.get_mut(&player_id) else {
                return None;
            };
            if state.dead {
                state.last_input = InputCmd::default();
                state.velocity = super::Vec3d::zeros();
                return None;
            }
            state.last_input = input.clone();
            (
                state.position.x as f32,
                state.position.z as f32,
                state.max_speed_override,
            )
        };

        let ground_material_multiplier = self
            .sample_terrain_material(player_x, player_z)
            .friction_multiplier();

        let state = self
            .players
            .get_mut(&player_id)
            .expect("player existed a moment ago");
        let mut tick_result = super::simulate_player_tick(
            &self.dynamic.sim,
            state.collider,
            &mut state.position,
            &mut state.velocity,
            &mut state.yaw,
            &mut state.pitch,
            &mut state.on_ground,
            input,
            dt,
            ground_material_multiplier,
            max_speed_override,
        );
        let sync_started = now_marker();
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        tick_result.timings.collider_sync_ms = elapsed_ms(sync_started);

        let impulse_started = now_marker();
        let mut impulses_applied_count = 0usize;
        for impulse in &tick_result.dynamic_impulses {
            if self.apply_dynamic_body_impulse(
                impulse.body_id,
                impulse.impulse,
                impulse.contact_point,
            ) {
                impulses_applied_count += 1;
            }
        }
        tick_result.timings.dynamic_impulse_apply_ms = elapsed_ms(impulse_started);
        tick_result.dynamic_stats.impulses_applied_count = impulses_applied_count;

        Some(tick_result)
    }

    /// Run one simulation step for many players in a single batch.
    ///
    /// The read-only KCC/dynamic-contact computation runs on a rayon thread
    /// pool (on non-wasm targets); the write-back phase — collider sync and
    /// dynamic-body impulse application — stays serial and is iterated in
    /// `player_id` order for determinism. All players observe the
    /// start-of-tick world state, which is a small behavior change versus the
    /// old sequential loop (where later players saw earlier players' synced
    /// collider positions and applied impulses) but is the price of the
    /// parallel speed-up needed to push past ~150 concurrent players.
    ///
    /// Returns one `(player_id, Option<PlayerTickResult>)` per input, in the
    /// same order as `inputs`. `None` is returned for players that were in a
    /// vehicle, were dead, or no longer exist — matching the semantics of
    /// `simulate_player_tick`.
    pub fn simulate_players_tick(
        &mut self,
        inputs: &[(u32, InputCmd)],
        dt: f32,
    ) -> Vec<(u32, Option<super::PlayerTickResult>)> {
        let mut results: Vec<(u32, Option<super::PlayerTickResult>)> =
            Vec::with_capacity(inputs.len());
        let mut work_items: Vec<PlayerTickWork> = Vec::with_capacity(inputs.len());

        for (player_id, input) in inputs {
            let player_id = *player_id;

            if self.vehicle_of_player.contains_key(&player_id) {
                if let Some(state) = self.players.get_mut(&player_id) {
                    state.last_input = input.clone();
                }
                results.push((player_id, None));
                continue;
            }

            let (
                player_x,
                player_z,
                max_speed_override,
                collider,
                position,
                velocity,
                yaw,
                pitch,
                on_ground,
            ) = {
                let Some(state) = self.players.get_mut(&player_id) else {
                    results.push((player_id, None));
                    continue;
                };
                if state.dead {
                    state.last_input = InputCmd::default();
                    state.velocity = super::Vec3d::zeros();
                    results.push((player_id, None));
                    continue;
                }
                state.last_input = input.clone();
                (
                    state.position.x as f32,
                    state.position.z as f32,
                    state.max_speed_override,
                    state.collider,
                    state.position,
                    state.velocity,
                    state.yaw,
                    state.pitch,
                    state.on_ground,
                )
            };

            let ground_material_multiplier = self
                .sample_terrain_material(player_x, player_z)
                .friction_multiplier();

            work_items.push(PlayerTickWork {
                player_id,
                collider,
                position,
                velocity,
                yaw,
                pitch,
                on_ground,
                input: input.clone(),
                ground_material_multiplier,
                max_speed_override,
            });
            results.push((player_id, None));
        }

        let sim = &self.dynamic.sim;

        #[cfg(not(target_arch = "wasm32"))]
        let outputs: Vec<PlayerTickOutput> = work_items
            .into_par_iter()
            .map(|mut w| {
                let result = super::simulate_player_tick(
                    sim,
                    w.collider,
                    &mut w.position,
                    &mut w.velocity,
                    &mut w.yaw,
                    &mut w.pitch,
                    &mut w.on_ground,
                    &w.input,
                    dt,
                    w.ground_material_multiplier,
                    w.max_speed_override,
                );
                PlayerTickOutput {
                    player_id: w.player_id,
                    result,
                    new_position: w.position,
                    new_velocity: w.velocity,
                    new_yaw: w.yaw,
                    new_pitch: w.pitch,
                    new_on_ground: w.on_ground,
                }
            })
            .collect();

        #[cfg(target_arch = "wasm32")]
        let outputs: Vec<PlayerTickOutput> = work_items
            .into_iter()
            .map(|mut w| {
                let result = super::simulate_player_tick(
                    sim,
                    w.collider,
                    &mut w.position,
                    &mut w.velocity,
                    &mut w.yaw,
                    &mut w.pitch,
                    &mut w.on_ground,
                    &w.input,
                    dt,
                    w.ground_material_multiplier,
                    w.max_speed_override,
                );
                PlayerTickOutput {
                    player_id: w.player_id,
                    result,
                    new_position: w.position,
                    new_velocity: w.velocity,
                    new_yaw: w.yaw,
                    new_pitch: w.pitch,
                    new_on_ground: w.on_ground,
                }
            })
            .collect();

        let mut outputs_sorted = outputs;
        outputs_sorted.sort_by_key(|o| o.player_id);

        let mut final_results: std::collections::HashMap<u32, super::PlayerTickResult> =
            std::collections::HashMap::with_capacity(outputs_sorted.len());

        for mut output in outputs_sorted {
            if let Some(state) = self.players.get_mut(&output.player_id) {
                state.position = output.new_position;
                state.velocity = output.new_velocity;
                state.yaw = output.new_yaw;
                state.pitch = output.new_pitch;
                state.on_ground = output.new_on_ground;
            }

            let sync_started = now_marker();
            let collider_opt = self
                .players
                .get(&output.player_id)
                .map(|state| (state.collider, state.position));
            if let Some((collider, position)) = collider_opt {
                self.dynamic.sim.sync_player_collider(collider, &position);
            }
            output.result.timings.collider_sync_ms = elapsed_ms(sync_started);

            let impulse_started = now_marker();
            let mut impulses_applied_count = 0usize;
            for impulse in &output.result.dynamic_impulses {
                if self.apply_dynamic_body_impulse(
                    impulse.body_id,
                    impulse.impulse,
                    impulse.contact_point,
                ) {
                    impulses_applied_count += 1;
                }
            }
            output.result.timings.dynamic_impulse_apply_ms = elapsed_ms(impulse_started);
            output.result.dynamic_stats.impulses_applied_count = impulses_applied_count;

            final_results.insert(output.player_id, output.result);
        }

        for (player_id, slot) in results.iter_mut() {
            if let Some(r) = final_results.remove(player_id) {
                *slot = Some(r);
            }
        }

        results
    }

    pub fn snapshot_player(
        &self,
        player_id: u32,
    ) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        let state = self.players.get(&player_id)?;
        let mut flags = 0u16;
        if state.on_ground {
            flags |= FLAG_ON_GROUND;
        }
        if state.dead {
            flags |= FLAG_DEAD;
        }
        if state.spawn_protected {
            flags |= FLAG_SPAWN_PROTECTED;
        }

        if let Some(&vehicle_id) = self.vehicle_of_player.get(&player_id) {
            flags |= FLAG_IN_VEHICLE;
            if let Some(vehicle) = self.vehicles.get(&vehicle_id) {
                if let Some(rb) = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body) {
                    let p = rb.translation();
                    let v = rb.linvel();
                    return Some((
                        [p.x, p.y, p.z],
                        [v.x, v.y, v.z],
                        state.yaw as f32,
                        state.pitch as f32,
                        state.hp,
                        flags,
                    ));
                }
            }
        }

        Some((
            [
                state.position.x as f32,
                state.position.y as f32,
                state.position.z as f32,
            ],
            [
                state.velocity.x as f32,
                state.velocity.y as f32,
                state.velocity.z as f32,
            ],
            state.yaw as f32,
            state.pitch as f32,
            state.hp,
            flags,
        ))
    }

    pub fn cast_static_world_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_player: Option<u32>,
    ) -> Option<f32> {
        let exclude = exclude_player
            .and_then(|pid| self.players.get(&pid))
            .map(|p| p.collider);
        self.dynamic.sim.cast_ray(origin, dir, max_toi, exclude)
    }

    pub fn cast_dynamic_body_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_player: Option<u32>,
    ) -> Option<(u32, f32, [f32; 3])> {
        let exclude = exclude_player
            .and_then(|pid| self.players.get(&pid))
            .map(|p| p.collider);
        let ray = rapier3d::prelude::Ray::new(
            na::point![origin[0], origin[1], origin[2]],
            na::vector![dir[0], dir[1], dir[2]],
        );
        let mut best: Option<(u32, f32, [f32; 3])> = None;
        for (&id, db) in &self.dynamic.dynamic_bodies {
            if Some(db.collider_handle) == exclude {
                continue;
            }
            let Some(collider) = self.dynamic.sim.colliders.get(db.collider_handle) else {
                continue;
            };
            let collider_pose = collider
                .parent()
                .and_then(|parent| self.dynamic.sim.rigid_bodies.get(parent))
                .and_then(|parent_rb| {
                    collider
                        .position_wrt_parent()
                        .map(|wrt_parent| *parent_rb.position() * *wrt_parent)
                })
                .unwrap_or(*collider.position());
            let Some(hit) =
                collider
                    .shape()
                    .cast_ray_and_get_normal(&collider_pose, &ray, max_toi, true)
            else {
                continue;
            };
            if best
                .map(|(_, toi, _)| hit.time_of_impact < toi)
                .unwrap_or(true)
            {
                let n = hit.normal;
                best = Some((id, hit.time_of_impact, [n.x, n.y, n.z]));
            }
        }
        best
    }

    pub fn apply_dynamic_body_impulse(
        &mut self,
        dynamic_body_id: u32,
        impulse: [f32; 3],
        contact_point: [f32; 3],
    ) -> bool {
        let Some(db) = self.dynamic.dynamic_bodies.get(&dynamic_body_id) else {
            return false;
        };
        let Some(rb) = self.dynamic.sim.rigid_bodies.get_mut(db.body_handle) else {
            return false;
        };
        let world_com = *rb.center_of_mass();
        let impulse = na::vector![impulse[0], impulse[1], impulse[2]];
        let point = na::point![contact_point[0], contact_point[1], contact_point[2]];
        let torque = (point - world_com).cross(&impulse);
        rb.apply_impulse(impulse, true);
        rb.apply_torque_impulse(torque, true);
        true
    }

    pub fn set_player_dead(&mut self, player_id: u32, dead: bool) {
        if let Some(state) = self.players.get_mut(&player_id) {
            state.dead = dead;
            state.spawn_protected = false;
            if dead {
                state.hp = 0;
                state.velocity = super::Vec3d::zeros();
                state.on_ground = false;
            }
        }
    }

    pub fn set_player_spawn_protected(&mut self, player_id: u32, spawn_protected: bool) -> bool {
        let Some(state) = self.players.get_mut(&player_id) else {
            return false;
        };
        state.spawn_protected = spawn_protected;
        true
    }

    pub fn is_player_spawn_protected(&self, player_id: u32) -> bool {
        self.players
            .get(&player_id)
            .map(|state| state.spawn_protected && !state.dead)
            .unwrap_or(false)
    }

    pub fn set_player_max_speed_override(
        &mut self,
        player_id: u32,
        max_speed: Option<f64>,
    ) -> bool {
        if let Some(state) = self.players.get_mut(&player_id) {
            state.max_speed_override = max_speed;
            true
        } else {
            false
        }
    }

    pub fn apply_player_damage(&mut self, player_id: u32, damage: u8) -> PlayerDamageOutcome {
        let Some(state) = self.players.get_mut(&player_id) else {
            return PlayerDamageOutcome::Ignored;
        };
        if state.dead || state.hp == 0 || state.spawn_protected {
            return PlayerDamageOutcome::Ignored;
        }
        state.hp = state.hp.saturating_sub(damage);
        if state.hp == 0 {
            state.dead = true;
            state.spawn_protected = false;
            state.velocity = super::Vec3d::zeros();
            return PlayerDamageOutcome::Killed;
        }
        PlayerDamageOutcome::Damaged
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        constants::FLAG_SPAWN_PROTECTED,
        physics_arena::{MoveConfig, PhysicsArena, PlayerDamageOutcome},
    };

    #[test]
    fn spawn_protection_blocks_damage_until_cleared() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.spawn_player(1);
        assert!(arena.set_player_spawn_protected(1, true));

        assert_eq!(
            arena.apply_player_damage(1, 25),
            PlayerDamageOutcome::Ignored
        );
        assert_eq!(arena.players.get(&1).map(|state| state.hp), Some(100));

        assert!(arena.set_player_spawn_protected(1, false));
        assert_eq!(
            arena.apply_player_damage(1, 25),
            PlayerDamageOutcome::Damaged
        );
        assert_eq!(arena.players.get(&1).map(|state| state.hp), Some(75));
    }

    #[test]
    fn snapshot_player_sets_spawn_protected_flag() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.spawn_player(7);
        assert!(arena.set_player_spawn_protected(7, true));

        let (_, _, _, _, _, flags) = arena.snapshot_player(7).expect("player should exist");
        assert_ne!(flags & FLAG_SPAWN_PROTECTED, 0);
    }

    use crate::protocol::InputCmd;
    use nalgebra::vector;

    fn arena_with_ground(player_count: u32) -> PhysicsArena {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![500.0, 0.5, 500.0], 0);
        arena.rebuild_broad_phase();
        for id in 1..=player_count {
            arena.spawn_player(id);
        }
        arena.rebuild_broad_phase();
        arena
    }

    #[test]
    fn batch_and_sequential_player_tick_produce_identical_state() {
        // No dynamic bodies in the world, so the serial and parallel paths
        // should be bit-for-bit identical: the only cross-player side effect
        // (impulses on dynamic bodies) is absent, and KCC queries exclude
        // other players' capsules regardless of ordering.
        let player_count = 12;
        let mut sequential = arena_with_ground(player_count);
        let mut batched = arena_with_ground(player_count);

        let dt = 1.0 / 60.0;
        let mut rng_state: u32 = 0xC0FFEE;
        let mut next_input = |tick: u32, id: u32| {
            // Simple deterministic per-(tick, id) input jitter so different
            // players take different paths across the ground.
            rng_state = rng_state
                .wrapping_mul(1664525)
                .wrapping_add(1013904223 ^ tick.wrapping_mul(2654435761) ^ id);
            let yaw = ((rng_state >> 16) as f32) * std::f32::consts::TAU / 65535.0;
            let move_y = if (rng_state >> 8) & 1 == 0 {
                127i8
            } else {
                -127i8
            };
            let move_x = if (rng_state >> 9) & 1 == 0 {
                40i8
            } else {
                -40i8
            };
            InputCmd {
                seq: tick as u16,
                buttons: 0,
                move_x,
                move_y,
                yaw,
                pitch: 0.0,
            }
        };

        for tick in 0..30 {
            let mut batch_inputs = Vec::with_capacity(player_count as usize);
            for id in 1..=player_count {
                let input = next_input(tick, id);
                let _ = sequential.simulate_player_tick(id, &input, dt);
                batch_inputs.push((id, input));
            }
            let _ = batched.simulate_players_tick(&batch_inputs, dt);
        }

        for id in 1..=player_count {
            let s = sequential.players.get(&id).expect("sequential player");
            let b = batched.players.get(&id).expect("batched player");
            let dpos = s.position - b.position;
            let dvel = s.velocity - b.velocity;
            assert!(
                dpos.norm() < 1e-6,
                "player {id} position diverged: seq={:?} batch={:?}",
                s.position,
                b.position
            );
            assert!(
                dvel.norm() < 1e-6,
                "player {id} velocity diverged: seq={:?} batch={:?}",
                s.velocity,
                b.velocity
            );
            assert_eq!(
                s.on_ground, b.on_ground,
                "player {id} on_ground diverged: seq={} batch={}",
                s.on_ground, b.on_ground
            );
        }
    }

    #[test]
    fn batch_tick_returns_none_for_dead_and_vehicle_players() {
        let mut arena = arena_with_ground(3);
        arena.set_player_dead(2, true);

        let inputs = vec![
            (1, InputCmd::default()),
            (2, InputCmd::default()),
            (3, InputCmd::default()),
            (99, InputCmd::default()), // nonexistent
        ];
        let results = arena.simulate_players_tick(&inputs, 1.0 / 60.0);
        assert_eq!(results.len(), 4);
        assert_eq!(results[0].0, 1);
        assert!(results[0].1.is_some(), "alive player 1 should get a result");
        assert_eq!(results[1].0, 2);
        assert!(results[1].1.is_none(), "dead player 2 should be skipped");
        assert_eq!(results[2].0, 3);
        assert!(results[2].1.is_some(), "alive player 3 should get a result");
        assert_eq!(results[3].0, 99);
        assert!(
            results[3].1.is_none(),
            "nonexistent player should be skipped"
        );
    }
}
