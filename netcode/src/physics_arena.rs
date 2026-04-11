use std::collections::HashMap;

use nalgebra::{vector, DMatrix, Vector3};
use rapier3d::prelude::*;

use crate::movement::MoveConfig;
use crate::sim_world::SimWorld;

pub type Vec3 = Vector3<f32>;

/// A dynamic rigid body tracked by the server-side physics pipeline.
pub struct DynamicBody {
    pub body_handle: RigidBodyHandle,
    pub collider_handle: ColliderHandle,
    pub half_extents: Vec3,
    /// `0` = box (SHAPE_BOX), `1` = sphere (SHAPE_SPHERE)
    pub shape_type: u8,
}

/// Server-side physics world: wraps `SimWorld` (KCC + static geometry) and
/// adds a `PhysicsPipeline` for dynamic rigid bodies (boxes, balls, etc.).
///
/// This is the generic, game-independent container.  Game code (e.g. vibe-land
/// server) adds player state on top.
pub struct DynamicArena {
    pub sim: SimWorld,

    pub dynamic_bodies: HashMap<u32, DynamicBody>,
    next_dynamic_id: u32,

    pipeline: PhysicsPipeline,
    pub impulse_joints: ImpulseJointSet,
    pub multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
    gravity: Vec3,
}

impl DynamicArena {
    pub fn new(config: MoveConfig) -> Self {
        Self {
            sim: SimWorld::new(config),
            dynamic_bodies: HashMap::new(),
            next_dynamic_id: 1,
            pipeline: PhysicsPipeline::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            gravity: vector![0.0, -20.0, 0.0],
        }
    }

    /// Convenience accessor for the shared config.
    pub fn config(&self) -> &MoveConfig {
        &self.sim.config
    }

    /// Flush pending collider changes into the broad-phase BVH.
    pub fn sync_broad_phase(&mut self) {
        self.sim.sync_broad_phase();
    }

    /// Bootstrap the broad-phase BVH with all current colliders.  Call once
    /// after bulk seeding, before the first tick.
    pub fn rebuild_broad_phase(&mut self) {
        self.sim.rebuild_broad_phase();
    }

    pub fn add_static_cuboid(
        &mut self,
        center: Vec3,
        half_extents: Vec3,
        user_data: u128,
    ) -> ColliderHandle {
        self.sim.add_static_cuboid(center, half_extents, user_data)
    }

    pub fn add_static_heightfield(
        &mut self,
        heights: DMatrix<f32>,
        scale: Vec3,
        user_data: u128,
    ) -> ColliderHandle {
        self.sim.add_static_heightfield(heights, scale, user_data)
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.sim.remove_collider(handle);
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.sim.collider_user_data(handle)
    }

    /// Wake up all dynamic bodies whose center is within `radius` of `center`.
    /// Call after removing a static collider so sleeping bodies notice the gap.
    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        let r2 = radius * radius;
        for (_, db) in &self.dynamic_bodies {
            if let Some(rb) = self.sim.rigid_bodies.get(db.body_handle) {
                let pos = *rb.translation();
                let dx = pos.x - center.x;
                let dy = pos.y - center.y;
                let dz = pos.z - center.z;
                if dx * dx + dy * dy + dz * dz < r2 {
                    self.sim.island_manager.wake_up(
                        &mut self.sim.rigid_bodies,
                        db.body_handle,
                        true,
                    );
                }
            }
        }
    }

    pub fn spawn_dynamic_box(&mut self, position: Vec3, half_extents: Vec3) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id += 1;

        let body = RigidBodyBuilder::dynamic()
            .translation(position)
            .linear_damping(0.3)
            .angular_damping(0.5)
            .build();
        let body_handle = self.sim.rigid_bodies.insert(body);

        // GROUP_2 = dynamic bodies; suspension raycasts only query GROUP_1 (terrain)
        // so the vehicle chassis pushes boxes directly rather than climbing over them.
        let collider = ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
            .restitution(0.3)
            .friction(0.6)
            .density(2.0)
            .collision_groups(InteractionGroups::new(
                Group::GROUP_2,
                Group::GROUP_1 | Group::GROUP_2,
            ))
            .build();
        let collider_handle = self.sim.colliders.insert_with_parent(
            collider,
            body_handle,
            &mut self.sim.rigid_bodies,
        );

        self.dynamic_bodies.insert(
            id,
            DynamicBody {
                body_handle,
                collider_handle,
                half_extents,
                shape_type: 0, // SHAPE_BOX
            },
        );

        id
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vec3, radius: f32) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id += 1;

        let body = RigidBodyBuilder::dynamic()
            .translation(position)
            .linear_damping(0.3)
            .angular_damping(0.5)
            .build();
        let body_handle = self.sim.rigid_bodies.insert(body);

        let collider = ColliderBuilder::ball(radius)
            .restitution(0.6)
            .friction(0.2)
            .density(1.0)
            .collision_groups(InteractionGroups::new(
                Group::GROUP_2,
                Group::GROUP_1 | Group::GROUP_2,
            ))
            .build();
        let collider_handle = self.sim.colliders.insert_with_parent(
            collider,
            body_handle,
            &mut self.sim.rigid_bodies,
        );

        self.dynamic_bodies.insert(
            id,
            DynamicBody {
                body_handle,
                collider_handle,
                half_extents: vector![radius, radius, radius],
                shape_type: 1, // SHAPE_SPHERE
            },
        );

        id
    }

    pub fn step_dynamics(&mut self, dt: f32) {
        self.sim.integration_parameters.dt = dt;
        self.pipeline.step(
            &self.gravity,
            &self.sim.integration_parameters,
            &mut self.sim.island_manager,
            &mut self.sim.broad_phase,
            &mut self.sim.narrow_phase,
            &mut self.sim.rigid_bodies,
            &mut self.sim.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            &(),
            &(),
        );
    }

    /// Returns `(id, position, quaternion [x,y,z,w], half_extents, linvel, shape_type)`
    /// for each dynamic body.
    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], u8)> {
        let mut out = Vec::with_capacity(self.dynamic_bodies.len());
        for (&id, db) in &self.dynamic_bodies {
            if let Some(rb) = self.sim.rigid_bodies.get(db.body_handle) {
                let pos = rb.translation();
                let rot = rb.rotation();
                let vel = rb.linvel();
                out.push((
                    id,
                    [pos.x, pos.y, pos.z],
                    [rot.i, rot.j, rot.k, rot.w],
                    [db.half_extents.x, db.half_extents.y, db.half_extents.z],
                    [vel.x, vel.y, vel.z],
                    db.shape_type,
                ));
            }
        }
        out
    }
}
