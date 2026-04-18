//! Vehicle-vs-player contact damage.
//!
//! Vehicle chassis colliders and player capsules live in disjoint collision
//! groups (chassis = GROUP_1 filtered to GROUP_1|GROUP_2, player = GROUP_3),
//! so the narrow phase never produces contact manifolds between them and
//! players simply ghost through vehicles. We layer a pure contact query on
//! top of that physical behaviour so a speeding vehicle damages any player
//! capsule it happens to be overlapping this tick.
//!
//! Damage scales with chassis speed and how deep into the capsule the
//! chassis has penetrated; a top-speed direct hit deals a full 100 HP
//! (instant kill) while a slow or glancing hit leaves the victim alive but
//! injured.

use rapier3d::parry::query;

use super::PhysicsArena;
use crate::movement::{
    VEHICLE_DAMAGE_MIN_DIRECT_FACTOR, VEHICLE_DAMAGE_MIN_SPEED_M_S, VEHICLE_LETHAL_SPEED_M_S,
};

/// Player capsule radius used as the reference for "full directness".
/// Mirrors `vibe_netcode::movement::MoveConfig::capsule_radius` default
/// (0.35 m). Kept as a local constant so this module has no runtime
/// dependency on a `MoveConfig` lookup.
const PLAYER_CAPSULE_RADIUS: f32 = 0.35;

impl PhysicsArena {
    /// Run one pass of vehicle-vs-player damage.
    ///
    /// For each vehicle moving faster than `VEHICLE_DAMAGE_MIN_SPEED_M_S`,
    /// query the contact between its chassis collider and every alive
    /// player capsule that is NOT currently riding a vehicle. If the shapes
    /// overlap, apply speed- and penetration-scaled HP damage via
    /// [`PhysicsArena::apply_player_damage`].
    ///
    /// Returns the IDs of players whose HP dropped to 0 this pass so the
    /// caller can run its usual death flow (respawn timer, battery drop,
    /// etc.).
    pub fn apply_vehicle_player_collisions(&mut self) -> Vec<u32> {
        let mut killed: Vec<u32> = Vec::new();
        if self.vehicles.is_empty() || self.players.is_empty() {
            return killed;
        }

        // Snapshot the player->vehicle mapping so we can cheaply skip any
        // player that is currently inside a vehicle (their capsule is
        // effectively parked at its last on-foot position while they ride).
        let players_in_vehicles: Vec<u32> = self.vehicle_of_player.keys().copied().collect();

        let vehicle_ids: Vec<u32> = self.vehicles.keys().copied().collect();
        let player_ids: Vec<u32> = self.players.keys().copied().collect();

        for vid in vehicle_ids {
            let Some(vehicle) = self.vehicles.get(&vid) else {
                continue;
            };
            let chassis_body = vehicle.chassis_body;
            let chassis_collider = vehicle.chassis_collider;
            let driver_id = vehicle.driver_id;

            let Some(rb) = self.dynamic.sim.rigid_bodies.get(chassis_body) else {
                continue;
            };
            let speed = rb.linvel().norm();
            if speed < VEHICLE_DAMAGE_MIN_SPEED_M_S {
                continue;
            }

            let Some(chassis_col) = self.dynamic.sim.colliders.get(chassis_collider) else {
                continue;
            };
            let chassis_pose = *chassis_col.position();
            // `shape()` returns a trait object whose lifetime is tied to
            // the collider borrow, so clone it into an owned box to
            // release the immutable borrow on `self.dynamic.sim.colliders`
            // before we take a mutable borrow via `apply_player_damage`.
            let chassis_shape = chassis_col.shape().clone_dyn();

            let speed_factor = (speed / VEHICLE_LETHAL_SPEED_M_S).clamp(0.0, 1.0);

            for &pid in &player_ids {
                if Some(pid) == driver_id {
                    continue;
                }
                if players_in_vehicles.contains(&pid) {
                    continue;
                }

                let Some(state) = self.players.get(&pid) else {
                    continue;
                };
                if state.dead || state.hp == 0 {
                    continue;
                }
                let player_collider_handle = state.collider;

                let Some(player_col) = self.dynamic.sim.colliders.get(player_collider_handle)
                else {
                    continue;
                };
                let player_pose = *player_col.position();
                let player_shape = player_col.shape().clone_dyn();

                let contact = match query::contact(
                    &chassis_pose,
                    chassis_shape.as_ref(),
                    &player_pose,
                    player_shape.as_ref(),
                    0.0,
                ) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let Some(contact) = contact else { continue };
                if contact.dist >= 0.0 {
                    continue;
                }

                let penetration = -contact.dist;
                let directness = (penetration / PLAYER_CAPSULE_RADIUS).clamp(0.0, 1.0);
                let damage_fraction = speed_factor
                    * (VEHICLE_DAMAGE_MIN_DIRECT_FACTOR
                        + (1.0 - VEHICLE_DAMAGE_MIN_DIRECT_FACTOR) * directness);
                let damage = (100.0 * damage_fraction).round().clamp(0.0, 255.0) as u8;
                if damage == 0 {
                    continue;
                }

                if self.apply_player_damage(pid, damage) {
                    killed.push(pid);
                }
            }
        }

        killed
    }
}

#[cfg(test)]
mod tests {
    use nalgebra::vector;
    use rapier3d::prelude::RigidBodyHandle;

    use super::*;
    use crate::movement::Vec3d;
    use crate::physics_arena::{MoveConfig, PhysicsArena, Vec3};

    fn make_arena() -> PhysicsArena {
        PhysicsArena::new(MoveConfig::default())
    }

    /// Spawn a vehicle at `position` and set its velocity to `speed` m/s
    /// along +X. Returns the chassis rigid-body handle.
    fn spawn_vehicle_moving(
        arena: &mut PhysicsArena,
        position: Vec3,
        speed_m_s: f32,
    ) -> RigidBodyHandle {
        let vid = arena.spawn_vehicle(0, position);
        let rb = arena.vehicles.get(&vid).unwrap().chassis_body;
        if let Some(body) = arena.dynamic.sim.rigid_bodies.get_mut(rb) {
            body.set_linvel(vector![speed_m_s, 0.0, 0.0], true);
        }
        rb
    }

    /// Spawn a player then overwrite their collider position so they sit
    /// at `position`, ignoring whatever spawn lane the arena picked.
    fn spawn_player_at(arena: &mut PhysicsArena, id: u32, position: Vec3d) {
        arena.spawn_player(id);
        if let Some(state) = arena.players.get_mut(&id) {
            state.position = position;
            let collider = state.collider;
            arena.dynamic.sim.sync_player_collider(collider, &position);
        }
    }

    #[test]
    fn top_speed_direct_hit_kills() {
        let mut arena = make_arena();
        spawn_player_at(&mut arena, 1, Vec3d::new(0.0, 0.0, 0.0));
        let _rb = spawn_vehicle_moving(
            &mut arena,
            Vec3::new(0.0, 0.0, 0.0),
            VEHICLE_LETHAL_SPEED_M_S + 5.0,
        );

        let killed = arena.apply_vehicle_player_collisions();
        assert_eq!(killed, vec![1], "expected player 1 to be killed");
        assert_eq!(arena.players.get(&1).unwrap().hp, 0);
    }

    #[test]
    fn below_threshold_speed_deals_no_damage() {
        let mut arena = make_arena();
        spawn_player_at(&mut arena, 2, Vec3d::new(0.0, 0.0, 0.0));
        let _rb = spawn_vehicle_moving(
            &mut arena,
            Vec3::new(0.0, 0.0, 0.0),
            VEHICLE_DAMAGE_MIN_SPEED_M_S - 0.5,
        );

        let initial_hp = arena.players.get(&2).unwrap().hp;
        let killed = arena.apply_vehicle_player_collisions();
        assert!(killed.is_empty());
        assert_eq!(arena.players.get(&2).unwrap().hp, initial_hp);
    }

    #[test]
    fn half_speed_direct_hit_leaves_survivor() {
        let mut arena = make_arena();
        spawn_player_at(&mut arena, 3, Vec3d::new(0.0, 0.0, 0.0));
        let _rb = spawn_vehicle_moving(
            &mut arena,
            Vec3::new(0.0, 0.0, 0.0),
            VEHICLE_LETHAL_SPEED_M_S * 0.5,
        );

        let killed = arena.apply_vehicle_player_collisions();
        assert!(killed.is_empty(), "half-speed direct should not kill");
        let hp = arena.players.get(&3).unwrap().hp;
        assert!((30..=70).contains(&hp), "expected ~half damage, hp={}", hp,);
    }

    #[test]
    fn driver_is_immune_to_own_vehicle() {
        let mut arena = make_arena();
        spawn_player_at(&mut arena, 4, Vec3d::new(0.0, 0.0, 0.0));
        let vid = arena.spawn_vehicle(0, Vec3::new(0.0, 0.0, 0.0));
        let rb = arena.vehicles.get(&vid).unwrap().chassis_body;
        if let Some(body) = arena.dynamic.sim.rigid_bodies.get_mut(rb) {
            body.set_linvel(vector![VEHICLE_LETHAL_SPEED_M_S + 5.0, 0.0, 0.0], true);
        }
        // Mark the player as the driver without calling `enter_vehicle`
        // (which would disable the capsule collider and defeat the test).
        arena.vehicles.get_mut(&vid).unwrap().driver_id = Some(4);

        let initial_hp = arena.players.get(&4).unwrap().hp;
        let killed = arena.apply_vehicle_player_collisions();
        assert!(killed.is_empty());
        assert_eq!(arena.players.get(&4).unwrap().hp, initial_hp);
    }

    #[test]
    fn far_player_takes_no_damage() {
        let mut arena = make_arena();
        spawn_player_at(&mut arena, 5, Vec3d::new(50.0, 0.0, 50.0));
        let _rb = spawn_vehicle_moving(
            &mut arena,
            Vec3::new(0.0, 0.0, 0.0),
            VEHICLE_LETHAL_SPEED_M_S + 5.0,
        );

        let initial_hp = arena.players.get(&5).unwrap().hp;
        let killed = arena.apply_vehicle_player_collisions();
        assert!(killed.is_empty());
        assert_eq!(arena.players.get(&5).unwrap().hp, initial_hp);
    }
}
