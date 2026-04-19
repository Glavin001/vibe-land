use nalgebra::{Quaternion, UnitQuaternion};
use rapier3d::prelude::InteractionGroups;

use super::{elapsed_ms, now_marker, PhysicsArena, Vec3, Vehicle};
use crate::vehicle::{
    apply_vehicle_input_step_with_tuning, apply_vehicle_tuning_to_chassis,
    apply_vehicle_tuning_to_controller, canonical_vehicle_type, create_vehicle_physics_with_tuning,
    make_vehicle_snapshot, read_vehicle_chassis_state, refresh_vehicle_contacts,
    vehicle_exit_position, VehicleTuning, VEHICLE_CONTROLLER_SUBSTEPS,
};

impl PhysicsArena {
    pub fn spawn_vehicle(&mut self, vehicle_type: u8, position: Vec3) -> u32 {
        let id = self.next_vehicle_id;
        self.next_vehicle_id += 1;
        self.spawn_vehicle_with_id(id, vehicle_type, position, [0.0, 0.0, 0.0, 1.0]);
        id
    }

    pub fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vec3,
        rotation: [f32; 4],
    ) -> u32 {
        let vehicle_type = canonical_vehicle_type(vehicle_type);
        let pose = nalgebra::Isometry3::from_parts(
            nalgebra::Translation3::new(position.x, position.y, position.z),
            UnitQuaternion::from_quaternion(Quaternion::new(
                rotation[3],
                rotation[0],
                rotation[1],
                rotation[2],
            )),
        );
        let (chassis_body, chassis_collider, controller) = create_vehicle_physics_with_tuning(
            &mut self.dynamic.sim,
            vehicle_type,
            pose,
            &self.vehicle_tuning,
        );

        self.vehicles.insert(
            id,
            Vehicle {
                chassis_body,
                chassis_collider,
                controller,
                vehicle_type,
                driver_id: None,
            },
        );

        self.next_vehicle_id = self.next_vehicle_id.max(id.saturating_add(1));
        id
    }

    pub fn step_vehicles(&mut self, dt: f32) {
        if self.vehicles.is_empty() {
            return;
        }

        let vehicle_ids: Vec<u32> = self.vehicles.keys().copied().collect();
        for vid in vehicle_ids {
            if let Some(driver_id) = self
                .vehicles
                .get(&vid)
                .and_then(|vehicle| vehicle.driver_id)
            {
                if !self.players.contains_key(&driver_id) {
                    self.detach_player_from_vehicles(driver_id);
                } else if self.vehicle_of_player.get(&driver_id) != Some(&vid) {
                    self.vehicle_of_player.insert(driver_id, vid);
                }
            }

            let driver_input = {
                let vehicle = match self.vehicles.get(&vid) {
                    Some(v) => v,
                    None => continue,
                };
                if let Some(driver_id) = vehicle.driver_id {
                    if let Some(player) = self.players.get(&driver_id) {
                        player.last_input.clone()
                    } else {
                        crate::protocol::InputCmd::default()
                    }
                } else {
                    crate::protocol::InputCmd::default()
                }
            };

            let vehicle = self.vehicles.get_mut(&vid).unwrap();
            apply_vehicle_input_step_with_tuning(
                &mut self.dynamic.sim,
                vehicle.chassis_body,
                vehicle.chassis_collider,
                &mut vehicle.controller,
                &driver_input,
                dt,
                &self.vehicle_tuning,
            );
        }
    }

    pub fn set_vehicle_tuning(&mut self, tuning: VehicleTuning) {
        self.vehicle_tuning = tuning.sanitized();
        for vehicle in self.vehicles.values_mut() {
            apply_vehicle_tuning_to_controller(&mut vehicle.controller, &self.vehicle_tuning);
            apply_vehicle_tuning_to_chassis(
                &mut self.dynamic.sim,
                vehicle.chassis_body,
                vehicle.chassis_collider,
                &self.vehicle_tuning,
            );
            refresh_vehicle_contacts(
                &mut self.dynamic.sim,
                vehicle.chassis_collider,
                &mut vehicle.controller,
            );
        }
    }

    pub fn step_vehicles_and_dynamics(&mut self, dt: f32) -> (f32, f32) {
        if self.vehicles.is_empty() {
            let dynamics_started = now_marker();
            self.step_dynamics(dt);
            return (0.0, elapsed_ms(dynamics_started));
        }

        let substep_dt = dt / VEHICLE_CONTROLLER_SUBSTEPS as f32;
        let mut vehicle_ms = 0.0;
        let mut dynamics_ms = 0.0;
        for _ in 0..VEHICLE_CONTROLLER_SUBSTEPS {
            let vehicle_started = now_marker();
            self.step_vehicles(substep_dt);
            vehicle_ms += elapsed_ms(vehicle_started);

            let dynamics_started = now_marker();
            self.step_dynamics(substep_dt);
            dynamics_ms += elapsed_ms(dynamics_started);
        }
        self.dynamic.sim.integration_parameters.dt = dt;
        (vehicle_ms, dynamics_ms)
    }

    pub fn enter_vehicle(&mut self, player_id: u32, vehicle_id: u32) {
        if !self.players.contains_key(&player_id) || !self.vehicles.contains_key(&vehicle_id) {
            return;
        }

        self.detach_player_from_vehicles(player_id);

        if let Some(current_driver_id) = self
            .vehicles
            .get(&vehicle_id)
            .and_then(|vehicle| vehicle.driver_id)
        {
            if current_driver_id != player_id {
                if self.players.contains_key(&current_driver_id) {
                    self.vehicle_of_player.insert(current_driver_id, vehicle_id);
                    return;
                }
                self.detach_player_from_vehicles(current_driver_id);
            }
        }

        if let Some(player) = self.players.get(&player_id) {
            if let Some(c) = self.dynamic.sim.colliders.get_mut(player.collider) {
                c.set_collision_groups(InteractionGroups::none());
            }
        }
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            vehicle.driver_id = Some(player_id);
        }
        self.vehicle_of_player.insert(player_id, vehicle_id);
    }

    pub fn exit_vehicle(&mut self, player_id: u32) {
        if let Some(vehicle_id) = self.detach_player_from_vehicles(player_id) {
            if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
                if let Some(chassis_state) =
                    read_vehicle_chassis_state(&self.dynamic.sim, vehicle.chassis_body)
                {
                    if let Some(state) = self.players.get_mut(&player_id) {
                        state.position = vehicle_exit_position(&chassis_state);
                        if let Some(c) = self.dynamic.sim.colliders.get_mut(state.collider) {
                            c.set_collision_groups(InteractionGroups::all());
                        }
                        self.dynamic
                            .sim
                            .sync_player_collider(state.collider, &state.position);
                    }
                }
            }
        }
    }

    pub(super) fn detach_player_from_vehicles(&mut self, player_id: u32) -> Option<u32> {
        self.vehicle_of_player.remove(&player_id);

        let vehicle_ids: Vec<u32> = self
            .vehicles
            .iter()
            .filter_map(|(&vehicle_id, vehicle)| {
                (vehicle.driver_id == Some(player_id)).then_some(vehicle_id)
            })
            .collect();

        for vehicle_id in &vehicle_ids {
            if let Some(vehicle) = self.vehicles.get_mut(vehicle_id) {
                vehicle.driver_id = None;
            }
        }

        vehicle_ids.into_iter().next()
    }

    pub fn snapshot_vehicles(&self) -> Vec<crate::protocol::NetVehicleState> {
        self.vehicles
            .iter()
            .filter_map(|(&id, vehicle)| {
                make_vehicle_snapshot(
                    &self.dynamic.sim,
                    id,
                    vehicle.vehicle_type,
                    0,
                    vehicle.driver_id.unwrap_or(0),
                    vehicle.chassis_body,
                    &vehicle.controller,
                    &self.vehicle_tuning,
                )
            })
            .collect()
    }
}
