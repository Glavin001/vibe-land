//! Engine-neutral contracts for authoritative server physics.
//!
//! Game code should exchange stable entity IDs and these project-owned DTOs.
//! Engine handles and engine-specific math types must remain inside adapters.

use nalgebra::{DMatrix, Vector3};

use crate::movement::MoveConfig;
use crate::physics_arena::DynamicArena;

pub const PHYSICS_BACKEND_RAPIER: u8 = 0;
pub const PHYSICS_BACKEND_PHYSX_GPU: u8 = 1;

pub const CLIENT_MOVEMENT_FULL_PREDICTION: u8 = 0;
pub const CLIENT_MOVEMENT_THIN_AUTHORITATIVE: u8 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PhysicsBackendKind {
    #[default]
    Rapier,
    PhysxGpu,
}

impl PhysicsBackendKind {
    pub const fn wire_id(self) -> u8 {
        match self {
            Self::Rapier => PHYSICS_BACKEND_RAPIER,
            Self::PhysxGpu => PHYSICS_BACKEND_PHYSX_GPU,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Rapier => "rapier",
            Self::PhysxGpu => "physx_gpu",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "rapier" => Ok(Self::Rapier),
            "physx" | "physx_gpu" | "physx-gpu" => Ok(Self::PhysxGpu),
            other => Err(format!(
                "unsupported physics backend {other:?}; expected rapier or physx_gpu"
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicsCapabilities {
    pub backend: PhysicsBackendKind,
    pub gpu_required: bool,
    pub snapshot_hz: u16,
    pub client_movement_mode: u8,
}

impl PhysicsCapabilities {
    pub const fn rapier(snapshot_hz: u16) -> Self {
        Self {
            backend: PhysicsBackendKind::Rapier,
            gpu_required: false,
            snapshot_hz,
            client_movement_mode: CLIENT_MOVEMENT_FULL_PREDICTION,
        }
    }

    pub const fn physx_gpu(snapshot_hz: u16) -> Self {
        Self {
            backend: PhysicsBackendKind::PhysxGpu,
            gpu_required: true,
            snapshot_hz,
            client_movement_mode: CLIENT_MOVEMENT_THIN_AUTHORITATIVE,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BodySnapshot {
    pub id: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub half_extents: [f32; 3],
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub shape_type: u8,
    pub sleeping: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RayHit {
    pub entity_id: u32,
    pub distance: f32,
    pub position: [f32; 3],
    pub normal: [f32; 3],
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PhysicsStepStats {
    pub simulate_ms: f32,
    pub fetch_ms: f32,
    pub active_bodies: u32,
    pub sleeping_bodies: u32,
    pub gpu_active: bool,
}

/// Low-level rigid-world port shared by native authoritative adapters.
///
/// Player motors, vehicles, and gameplay state build on this port in the
/// server adapter layer. The trait intentionally avoids exposing Rapier or
/// PhysX handles.
pub trait RigidWorldBackend {
    fn capabilities(&self) -> PhysicsCapabilities;
    fn config(&self) -> &MoveConfig;

    fn add_static_box(
        &mut self,
        entity_id: u32,
        center: [f32; 3],
        rotation: [f32; 4],
        half_extents: [f32; 3],
    );

    fn add_static_heightfield(
        &mut self,
        entity_id: u32,
        center: [f32; 3],
        heights: DMatrix<f32>,
        scale: [f32; 3],
        friction: f32,
        restitution: f32,
    );

    fn spawn_dynamic_box(
        &mut self,
        id: u32,
        position: [f32; 3],
        rotation: [f32; 4],
        half_extents: [f32; 3],
    );

    fn spawn_dynamic_sphere(&mut self, id: u32, position: [f32; 3], radius: f32);
    fn remove_entity(&mut self, id: u32) -> bool;
    fn apply_impulse(&mut self, id: u32, impulse: [f32; 3], point: [f32; 3]) -> bool;
    fn raycast(&self, origin: [f32; 3], direction: [f32; 3], max_distance: f32) -> Option<RayHit>;
    fn step(&mut self, dt: f32) -> PhysicsStepStats;
    fn body_snapshots(&self) -> Vec<BodySnapshot>;
}

/// Adapter for the existing proven Rapier rigid-body implementation.
pub struct RapierRigidWorld {
    arena: DynamicArena,
    snapshot_hz: u16,
}

impl RapierRigidWorld {
    pub fn new(config: MoveConfig, snapshot_hz: u16) -> Self {
        Self {
            arena: DynamicArena::new(config),
            snapshot_hz,
        }
    }

    pub fn inner(&self) -> &DynamicArena {
        &self.arena
    }

    pub fn inner_mut(&mut self) -> &mut DynamicArena {
        &mut self.arena
    }
}

impl RigidWorldBackend for RapierRigidWorld {
    fn capabilities(&self) -> PhysicsCapabilities {
        PhysicsCapabilities::rapier(self.snapshot_hz)
    }

    fn config(&self) -> &MoveConfig {
        self.arena.config()
    }

    fn add_static_box(
        &mut self,
        entity_id: u32,
        center: [f32; 3],
        rotation: [f32; 4],
        half_extents: [f32; 3],
    ) {
        self.arena.add_static_cuboid_rotated(
            Vector3::from(center),
            rotation,
            Vector3::from(half_extents),
            entity_id as u128,
        );
    }

    fn add_static_heightfield(
        &mut self,
        entity_id: u32,
        center: [f32; 3],
        heights: DMatrix<f32>,
        scale: [f32; 3],
        friction: f32,
        restitution: f32,
    ) {
        self.arena.add_static_heightfield_with_material(
            Vector3::from(center),
            heights,
            Vector3::from(scale),
            entity_id as u128,
            friction,
            restitution,
        );
    }

    fn spawn_dynamic_box(
        &mut self,
        id: u32,
        position: [f32; 3],
        rotation: [f32; 4],
        half_extents: [f32; 3],
    ) {
        self.arena.spawn_dynamic_box_with_id(
            id,
            Vector3::from(position),
            rotation,
            Vector3::from(half_extents),
        );
    }

    fn spawn_dynamic_sphere(&mut self, id: u32, position: [f32; 3], radius: f32) {
        self.arena
            .spawn_dynamic_ball_with_id(id, Vector3::from(position), radius);
    }

    fn remove_entity(&mut self, id: u32) -> bool {
        let Some(body) = self.arena.dynamic_bodies.remove(&id) else {
            return false;
        };
        self.arena.sim.rigid_bodies.remove(
            body.body_handle,
            &mut self.arena.sim.island_manager,
            &mut self.arena.sim.colliders,
            &mut self.arena.impulse_joints,
            &mut self.arena.multibody_joints,
            true,
        );
        true
    }

    fn apply_impulse(&mut self, id: u32, impulse: [f32; 3], point: [f32; 3]) -> bool {
        let Some(body) = self.arena.dynamic_bodies.get(&id) else {
            return false;
        };
        let Some(rigid_body) = self.arena.sim.rigid_bodies.get_mut(body.body_handle) else {
            return false;
        };
        let impulse = Vector3::from(impulse);
        let point = nalgebra::Point3::from(point);
        let torque = (point - *rigid_body.center_of_mass()).cross(&impulse);
        rigid_body.apply_impulse(impulse, true);
        rigid_body.apply_torque_impulse(torque, true);
        true
    }

    fn raycast(&self, origin: [f32; 3], direction: [f32; 3], max_distance: f32) -> Option<RayHit> {
        let distance = self
            .arena
            .sim
            .cast_ray(origin, direction, max_distance, None)?;
        let position = [
            origin[0] + direction[0] * distance,
            origin[1] + direction[1] * distance,
            origin[2] + direction[2] * distance,
        ];
        Some(RayHit {
            distance,
            position,
            ..RayHit::default()
        })
    }

    fn step(&mut self, dt: f32) -> PhysicsStepStats {
        let started = std::time::Instant::now();
        self.arena.step_dynamics(dt);
        let simulate_ms = started.elapsed().as_secs_f32() * 1000.0;
        let mut active_bodies = 0;
        let mut sleeping_bodies = 0;
        for body in self.arena.dynamic_bodies.values() {
            if self
                .arena
                .sim
                .rigid_bodies
                .get(body.body_handle)
                .is_some_and(|body| body.is_sleeping())
            {
                sleeping_bodies += 1;
            } else {
                active_bodies += 1;
            }
        }
        PhysicsStepStats {
            simulate_ms,
            active_bodies,
            sleeping_bodies,
            ..PhysicsStepStats::default()
        }
    }

    fn body_snapshots(&self) -> Vec<BodySnapshot> {
        self.arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .map(
                |(
                    id,
                    position,
                    rotation,
                    half_extents,
                    linear_velocity,
                    angular_velocity,
                    shape_type,
                )| {
                    let sleeping = self
                        .arena
                        .dynamic_bodies
                        .get(&id)
                        .and_then(|body| self.arena.sim.rigid_bodies.get(body.body_handle))
                        .is_some_and(|body| body.is_sleeping());
                    BodySnapshot {
                        id,
                        position,
                        rotation,
                        half_extents,
                        linear_velocity,
                        angular_velocity,
                        shape_type,
                        sleeping,
                    }
                },
            )
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_names_and_wire_ids_are_stable() {
        assert_eq!(
            PhysicsBackendKind::parse("rapier"),
            Ok(PhysicsBackendKind::Rapier)
        );
        assert_eq!(
            PhysicsBackendKind::parse("physx_gpu"),
            Ok(PhysicsBackendKind::PhysxGpu)
        );
        assert_ne!(
            PhysicsBackendKind::Rapier.wire_id(),
            PhysicsBackendKind::PhysxGpu.wire_id()
        );
    }

    #[test]
    fn rapier_adapter_uses_project_owned_snapshots() {
        let mut backend = RapierRigidWorld::new(MoveConfig::default(), 30);
        backend.add_static_box(100, [0.0, -0.5, 0.0], [0.0, 0.0, 0.0, 1.0], [5.0, 0.5, 5.0]);
        backend.spawn_dynamic_sphere(7, [0.0, 2.0, 0.0], 0.5);
        backend.step(1.0 / 60.0);
        let snapshot = backend.body_snapshots();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].id, 7);
    }
}
