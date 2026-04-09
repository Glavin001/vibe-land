#![cfg(target_arch = "wasm32")]

use std::collections::HashMap;

use nalgebra::{point, vector, Quaternion, UnitQuaternion, Vector3};
use rapier3d::control::{DynamicRayCastVehicleController, WheelTuning};
use rapier3d::prelude::*;
use wasm_bindgen::prelude::*;

use crate::movement::{
    input_to_vehicle_cmd, MoveConfig, Vec3d, VEHICLE_BRAKE_FORCE, VEHICLE_CHASSIS_DENSITY,
    VEHICLE_ENGINE_FORCE, VEHICLE_FRICTION_SLIP, VEHICLE_MAX_STEER_RAD, VEHICLE_SUSPENSION_DAMPING,
    VEHICLE_SUSPENSION_REST_LENGTH, VEHICLE_SUSPENSION_STIFFNESS, VEHICLE_SUSPENSION_TRAVEL,
    VEHICLE_WHEEL_RADIUS,
};
use crate::protocol::InputCmd;
use crate::seq::seq_is_newer;
use crate::simulation::{simulate_player_tick, SimWorld};
use vibe_netcode::clock_sync::ServerClockEstimator;

struct WasmVehicle {
    chassis_body: RigidBodyHandle,
    chassis_collider: ColliderHandle,
    controller: DynamicRayCastVehicleController,
}

/// Client-side physics simulation exposed to JavaScript via WASM.
///
/// Wraps `SimWorld` and adds single-player state management, pending input
/// tracking for reconciliation, and dynamic body collider support.
#[wasm_bindgen]
pub struct WasmSimWorld {
    sim: SimWorld,

    // Player state
    player_collider: Option<ColliderHandle>,
    position: Vec3d,
    velocity: Vec3d,
    yaw: f64,
    pitch: f64,
    on_ground: bool,

    // Pending inputs for reconciliation
    pending_inputs: Vec<InputCmd>,

    // Collider ID mapping (our ID → rapier handle)
    next_collider_id: u32,
    collider_ids: HashMap<u32, ColliderHandle>,

    // Dynamic body colliders (server ID → our collider ID)
    dynamic_colliders: HashMap<u32, u32>,

    // Vehicle simulation (driver-side prediction)
    vehicle_pipeline: Option<PhysicsPipeline>,
    vehicle_joints: ImpulseJointSet,
    vehicle_multibody_joints: MultibodyJointSet,
    vehicle_ccd: CCDSolver,
    vehicles: HashMap<u32, WasmVehicle>,
    local_vehicle_id: Option<u32>,
    vehicle_pending_inputs: Vec<InputCmd>,
    gravity: Vector3<f32>,
}

#[wasm_bindgen]
impl WasmSimWorld {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            sim: SimWorld::new(MoveConfig::default()),
            player_collider: None,
            position: Vec3d::zeros(),
            velocity: Vec3d::zeros(),
            yaw: 0.0,
            pitch: 0.0,
            on_ground: false,
            pending_inputs: Vec::new(),
            next_collider_id: 1,
            collider_ids: HashMap::new(),
            dynamic_colliders: HashMap::new(),
            vehicle_pipeline: None,
            vehicle_joints: ImpulseJointSet::new(),
            vehicle_multibody_joints: MultibodyJointSet::new(),
            vehicle_ccd: CCDSolver::new(),
            vehicles: HashMap::new(),
            local_vehicle_id: None,
            vehicle_pending_inputs: Vec::new(),
            gravity: vector![0.0, -20.0, 0.0],
        }
    }

    // ── Collider management ──────────────────────────

    /// Add a static cuboid collider.  Returns a unique ID for later removal.
    #[wasm_bindgen(js_name = addCuboid)]
    pub fn add_cuboid(
        &mut self,
        cx: f32,
        cy: f32,
        cz: f32,
        hx: f32,
        hy: f32,
        hz: f32,
    ) -> u32 {
        let handle = self.sim.add_static_cuboid(vector![cx, cy, cz], vector![hx, hy, hz], 0);
        let id = self.next_collider_id;
        self.next_collider_id += 1;
        self.collider_ids.insert(id, handle);
        id
    }

    /// Remove a collider by its ID (returned from `addCuboid`).
    #[wasm_bindgen(js_name = removeCuboid)]
    pub fn remove_cuboid(&mut self, id: u32) {
        if let Some(handle) = self.collider_ids.remove(&id) {
            self.sim.remove_collider(handle);
        }
    }

    /// Rebuild the broad-phase BVH.  Call after adding/removing colliders.
    #[wasm_bindgen(js_name = rebuildBroadPhase)]
    pub fn rebuild_broad_phase(&mut self) {
        self.sim.rebuild_broad_phase();
    }

    // ── Player management ────────────────────────────

    /// Spawn the local player capsule at the given position.
    #[wasm_bindgen(js_name = spawnPlayer)]
    pub fn spawn_player(&mut self, x: f64, y: f64, z: f64) {
        self.position = Vec3d::new(x, y, z);
        self.velocity = Vec3d::zeros();
        self.yaw = 0.0;
        self.pitch = 0.0;
        self.on_ground = false;
        self.pending_inputs.clear();
        let handle = self.sim.create_player_collider(self.position, 0);
        self.player_collider = Some(handle);
    }

    /// Run one simulation tick.  Stores the input for reconciliation.
    /// Returns `[px, py, pz, vx, vy, vz, on_ground]`.
    pub fn tick(
        &mut self,
        seq: u16,
        buttons: u16,
        move_x: i8,
        move_y: i8,
        yaw: f32,
        pitch: f32,
        dt: f32,
    ) -> Box<[f64]> {
        let input = InputCmd {
            seq,
            buttons,
            move_x,
            move_y,
            yaw,
            pitch,
        };
        self.pending_inputs.push(input.clone());
        // Cap rollback depth: replaying too many inputs causes CPU spikes on packet loss.
        // Lightyear uses 100 ticks as the default max; inputs older than that are unreachable.
        const MAX_ROLLBACK_INPUTS: usize = 100;
        if self.pending_inputs.len() > MAX_ROLLBACK_INPUTS {
            let excess = self.pending_inputs.len() - MAX_ROLLBACK_INPUTS;
            self.pending_inputs.drain(0..excess);
        }

        let collider = self.player_collider.expect("spawn_player not called");
        let _collisions = simulate_player_tick(
            &self.sim,
            collider,
            &mut self.position,
            &mut self.velocity,
            &mut self.yaw,
            &mut self.pitch,
            &mut self.on_ground,
            &input,
            dt,
        );
        self.sim.sync_player_collider(collider, &self.position);

        Box::new([
            self.position.x,
            self.position.y,
            self.position.z,
            self.velocity.x,
            self.velocity.y,
            self.velocity.z,
            if self.on_ground { 1.0 } else { 0.0 },
        ])
    }

    /// Set the full player state (used for initial sync).
    #[wasm_bindgen(js_name = setFullState)]
    pub fn set_full_state(
        &mut self,
        px: f64,
        py: f64,
        pz: f64,
        vx: f64,
        vy: f64,
        vz: f64,
        yaw: f64,
        pitch: f64,
        on_ground: bool,
    ) {
        self.position = Vec3d::new(px, py, pz);
        self.velocity = Vec3d::new(vx, vy, vz);
        self.yaw = yaw;
        self.pitch = pitch;
        self.on_ground = on_ground;
        if let Some(collider) = self.player_collider {
            self.sim.sync_player_collider(collider, &self.position);
        }
    }

    /// Reconcile with a server snapshot.  Filters pending inputs by ack seq,
    /// checks prediction error, resets to server state if needed, and replays
    /// unacked inputs.
    ///
    /// Returns `[px, py, pz, vx, vy, vz, on_ground, dx, dy, dz, did_correct]`.
    pub fn reconcile(
        &mut self,
        correction_distance: f64,
        ack_seq: u16,
        server_px: f64,
        server_py: f64,
        server_pz: f64,
        server_vx: f64,
        server_vy: f64,
        server_vz: f64,
        server_yaw: f64,
        server_pitch: f64,
        server_on_ground: bool,
        dt: f32,
    ) -> Box<[f64]> {
        self.pending_inputs
            .retain(|input| seq_is_newer(input.seq, ack_seq));

        // Flush any pending broad-phase updates from dynamic body syncs before
        // running the replay loop. Without this the KCC operates against stale
        // AABBs and may miss or double-count collisions with moved objects.
        self.sim.sync_broad_phase();

        let before_x = self.position.x;
        let before_y = self.position.y;
        let before_z = self.position.z;

        let ex = before_x - server_px;
        let ey = before_y - server_py;
        let ez = before_z - server_pz;
        let error_sq = ex * ex + ey * ey + ez * ez;

        if error_sq <= correction_distance * correction_distance {
            return Box::new([
                self.position.x,
                self.position.y,
                self.position.z,
                self.velocity.x,
                self.velocity.y,
                self.velocity.z,
                if self.on_ground { 1.0 } else { 0.0 },
                0.0,
                0.0,
                0.0,
                0.0,
            ]);
        }

        // Reset to server authoritative state
        self.set_full_state(
            server_px,
            server_py,
            server_pz,
            server_vx,
            server_vy,
            server_vz,
            server_yaw,
            server_pitch,
            server_on_ground,
        );

        // Replay all unacked inputs
        let collider = self.player_collider.expect("spawn_player not called");
        let inputs: Vec<InputCmd> = self.pending_inputs.clone();
        for input in &inputs {
            let _collisions = simulate_player_tick(
                &self.sim,
                collider,
                &mut self.position,
                &mut self.velocity,
                &mut self.yaw,
                &mut self.pitch,
                &mut self.on_ground,
                input,
                dt,
            );
            self.sim.sync_player_collider(collider, &self.position);
        }

        let dx = self.position.x - before_x;
        let dy = self.position.y - before_y;
        let dz = self.position.z - before_z;

        Box::new([
            self.position.x,
            self.position.y,
            self.position.z,
            self.velocity.x,
            self.velocity.y,
            self.velocity.z,
            if self.on_ground { 1.0 } else { 0.0 },
            dx,
            dy,
            dz,
            1.0,
        ])
    }

    /// Get the current position.  Returns `[px, py, pz]`.
    #[wasm_bindgen(js_name = getPosition)]
    pub fn get_position(&self) -> Box<[f64]> {
        Box::new([self.position.x, self.position.y, self.position.z])
    }

    /// Number of pending (unacked) inputs.
    #[wasm_bindgen(js_name = getPendingCount)]
    pub fn get_pending_count(&self) -> u32 {
        self.pending_inputs.len() as u32
    }

    // ── Raycasting ───────────────────────────────────

    /// Cast a ray and return `[toi, nx, ny, nz]`, or empty array on miss.
    #[wasm_bindgen(js_name = castRayAndGetNormal)]
    pub fn cast_ray_and_get_normal(
        &self,
        ox: f32,
        oy: f32,
        oz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        max_toi: f32,
    ) -> Box<[f32]> {
        match self.sim.cast_ray_and_get_normal(
            [ox, oy, oz],
            [dx, dy, dz],
            max_toi,
            self.player_collider,
        ) {
            Some((toi, normal)) => Box::new([toi, normal[0], normal[1], normal[2]]),
            None => Box::new([]),
        }
    }

    // ── Dynamic body colliders ───────────────────────

    /// Add or create a dynamic body collider for KCC collision.
    #[wasm_bindgen(js_name = syncDynamicBody)]
    pub fn sync_dynamic_body(
        &mut self,
        id: u32,
        shape_type: u8,
        hx: f32,
        hy: f32,
        hz: f32,
        px: f32,
        py: f32,
        pz: f32,
        qx: f32,
        qy: f32,
        qz: f32,
        qw: f32,
    ) {
        if let Some(&collider_id) = self.dynamic_colliders.get(&id) {
            // Update existing collider position/rotation and mark it modified so
            // the broad-phase BVH reflects the new position on the next sync.
            // Without this, the KCC casts against stale AABBs and misses collisions.
            if let Some(&handle) = self.collider_ids.get(&collider_id) {
                if let Some(collider) = self.sim.colliders.get_mut(handle) {
                    collider.set_translation(vector![px, py, pz]);
                    collider.set_rotation(UnitQuaternion::from_quaternion(
                        Quaternion::new(qw, qx, qy, qz),
                    ));
                }
                self.sim.modified_colliders.push(handle);
            }
        } else {
            // Create new collider.
            // GROUP_2 = dynamic-body proxies; the vehicle chassis (GROUP_1) filters
            // these out so client prediction doesn't collide with static-proxy balls
            // that the server treats as dynamic (pushable) rigid bodies.
            let dyn_groups = InteractionGroups::new(Group::GROUP_2, Group::GROUP_1);
            let handle = if shape_type == 1 {
                self.sim.colliders.insert(
                    ColliderBuilder::ball(hx)
                        .translation(vector![px, py, pz])
                        .rotation(
                            UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz))
                                .scaled_axis(),
                        )
                        .collision_groups(dyn_groups)
                        .build(),
                )
            } else {
                self.sim.colliders.insert(
                    ColliderBuilder::cuboid(hx, hy, hz)
                        .translation(vector![px, py, pz])
                        .rotation(
                            UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz))
                                .scaled_axis(),
                        )
                        .collision_groups(dyn_groups)
                        .build(),
                )
            };
            let collider_id = self.next_collider_id;
            self.next_collider_id += 1;
            self.collider_ids.insert(collider_id, handle);
            self.dynamic_colliders.insert(id, collider_id);
        }
    }

    /// Remove a dynamic body collider.
    #[wasm_bindgen(js_name = removeDynamicBody)]
    pub fn remove_dynamic_body(&mut self, id: u32) {
        if let Some(collider_id) = self.dynamic_colliders.remove(&id) {
            if let Some(handle) = self.collider_ids.remove(&collider_id) {
                self.sim.remove_collider(handle);
            }
        }
    }

    /// Remove all dynamic body colliders not in the given ID list.
    #[wasm_bindgen(js_name = removeStaleeDynamicBodies)]
    pub fn remove_stale_dynamic_bodies(&mut self, active_ids: &[u32]) {
        let active_set: std::collections::HashSet<u32> =
            active_ids.iter().copied().collect();
        let stale: Vec<u32> = self
            .dynamic_colliders
            .keys()
            .filter(|id| !active_set.contains(id))
            .copied()
            .collect();
        for id in stale {
            self.remove_dynamic_body(id);
        }
    }

    // ── Vehicle simulation (driver-side prediction) ──────────────────────────

    /// Spawn a vehicle chassis in the shared physics world.
    /// Call this for ALL vehicles (local and remote) so their colliders participate
    /// in broad-phase queries.
    #[wasm_bindgen(js_name = spawnVehicle)]
    pub fn spawn_vehicle(
        &mut self,
        id: u32,
        _vehicle_type: u8,
        px: f32, py: f32, pz: f32,
        qx: f32, qy: f32, qz: f32, qw: f32,
    ) {
        // Remove existing vehicle with same ID if present.
        self.remove_vehicle(id);

        let iso = UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz));
        let body = RigidBodyBuilder::dynamic()
            .pose(nalgebra::Isometry3::from_parts(
                nalgebra::Translation3::new(px, py, pz),
                iso,
            ))
            .linear_damping(0.1)
            .angular_damping(0.5)
            .sleeping(false)
            .can_sleep(false)
            .build();
        let chassis_body = self.sim.rigid_bodies.insert(body);

        // GROUP_1 = terrain/chassis; filter GROUP_1 only so dynamic-proxy balls
        // (GROUP_2) don't block client vehicle physics (on server they're real dynamic bodies).
        let chassis_groups = InteractionGroups::new(Group::GROUP_1, Group::GROUP_1);
        let collider = ColliderBuilder::cuboid(0.9, 0.3, 1.8)
            .friction(0.3)
            .restitution(0.1)
            .density(VEHICLE_CHASSIS_DENSITY)
            .collision_groups(chassis_groups)
            .build();
        let chassis_collider = self.sim.colliders.insert_with_parent(
            collider,
            chassis_body,
            &mut self.sim.rigid_bodies,
        );

        // Build vehicle controller.
        // index_forward_axis=2 → chassis +Z is forward (wheels placed at ±z=1.1).
        let mut controller = DynamicRayCastVehicleController::new(chassis_body);
        controller.index_forward_axis = 2;
        let tuning = WheelTuning {
            suspension_stiffness: VEHICLE_SUSPENSION_STIFFNESS,
            suspension_damping: VEHICLE_SUSPENSION_DAMPING,
            friction_slip: VEHICLE_FRICTION_SLIP,
            max_suspension_travel: VEHICLE_SUSPENSION_TRAVEL,
            ..WheelTuning::default()
        };
        let wheel_offsets = [
            point![-0.9_f32, 0.0, 1.1],
            point![ 0.9_f32, 0.0, 1.1],
            point![-0.9_f32, 0.0, -1.1],
            point![ 0.9_f32, 0.0, -1.1],
        ];
        for offset in wheel_offsets {
            controller.add_wheel(
                offset,
                -Vector3::y(),
                Vector3::x(),
                VEHICLE_SUSPENSION_REST_LENGTH,
                VEHICLE_WHEEL_RADIUS,
                &tuning,
            );
        }

        // Mark collider so BVH is updated.
        self.sim.modified_colliders.push(chassis_collider);

        self.vehicles.insert(id, WasmVehicle { chassis_body, chassis_collider, controller });
    }

    /// Remove a vehicle from the simulation.
    #[wasm_bindgen(js_name = removeVehicle)]
    pub fn remove_vehicle(&mut self, id: u32) {
        if let Some(vehicle) = self.vehicles.remove(&id) {
            self.sim.colliders.remove(
                vehicle.chassis_collider,
                &mut self.sim.island_manager,
                &mut self.sim.rigid_bodies,
                true,
            );
            self.sim.rigid_bodies.remove(
                vehicle.chassis_body,
                &mut self.sim.island_manager,
                &mut self.sim.colliders,
                &mut self.vehicle_joints,
                &mut self.vehicle_multibody_joints,
                true,
            );
            if self.local_vehicle_id == Some(id) {
                self.local_vehicle_id = None;
                self.vehicle_pipeline = None;
                self.vehicle_pending_inputs.clear();
            }
        }
    }

    /// Mark `vehicle_id` as the locally-driven vehicle (activates prediction pipeline).
    #[wasm_bindgen(js_name = setLocalVehicle)]
    pub fn set_local_vehicle(&mut self, vehicle_id: u32) {
        self.local_vehicle_id = Some(vehicle_id);
        self.vehicle_pipeline = Some(PhysicsPipeline::new());
        self.vehicle_pending_inputs.clear();
    }

    /// Clear the local vehicle (called on exit).
    #[wasm_bindgen(js_name = clearLocalVehicle)]
    pub fn clear_local_vehicle(&mut self) {
        self.local_vehicle_id = None;
        self.vehicle_pipeline = None;
        self.vehicle_pending_inputs.clear();
    }

    /// Sync a remote vehicle's chassis pose/velocity (kinematic update).
    /// Returns `[px, py, pz, qx, qy, qz, qw]`.
    #[wasm_bindgen(js_name = syncRemoteVehicle)]
    pub fn sync_remote_vehicle(
        &mut self,
        id: u32,
        px: f32, py: f32, pz: f32,
        qx: f32, qy: f32, qz: f32, qw: f32,
        vx: f32, vy: f32, vz: f32,
    ) {
        let Some(vehicle) = self.vehicles.get(&id) else { return; };
        if Some(id) == self.local_vehicle_id { return; } // local vehicle is predicted, not synced
        let body_handle = vehicle.chassis_body;
        if let Some(rb) = self.sim.rigid_bodies.get_mut(body_handle) {
            let iso = UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz));
            rb.set_position(
                nalgebra::Isometry3::from_parts(nalgebra::Translation3::new(px, py, pz), iso),
                true,
            );
            rb.set_linvel(vector![vx, vy, vz], true);
            rb.set_angvel(vector![0.0, 0.0, 0.0], true);
        }
        if let Some(handle) = self.vehicles.get(&id).map(|v| v.chassis_collider) {
            self.sim.modified_colliders.push(handle);
        }
    }

    /// Tick the local vehicle for one fixed-step.
    /// Returns `[px, py, pz, qx, qy, qz, qw, vx, vy, vz]`.
    #[wasm_bindgen(js_name = tickVehicle)]
    pub fn tick_vehicle(
        &mut self,
        seq: u16,
        buttons: u16,
        move_x: i8,
        move_y: i8,
        yaw: f32,
        pitch: f32,
        dt: f32,
    ) -> Box<[f64]> {
        let Some(vid) = self.local_vehicle_id else {
            return Box::new([0.0; 10]);
        };

        let input = InputCmd { seq, buttons, move_x, move_y, yaw, pitch };
        self.vehicle_pending_inputs.push(input.clone());
        const MAX_ROLLBACK: usize = 100;
        if self.vehicle_pending_inputs.len() > MAX_ROLLBACK {
            let excess = self.vehicle_pending_inputs.len() - MAX_ROLLBACK;
            self.vehicle_pending_inputs.drain(0..excess);
        }

        self.apply_vehicle_input(vid, &input);
        self.step_vehicle_pipeline(dt);

        self.get_vehicle_state(vid)
    }

    /// Reconcile local vehicle with an authoritative server snapshot.
    /// Returns `[px, py, pz, qx, qy, qz, qw, vx, vy, vz, dx, dy, dz, did_correct]`.
    #[wasm_bindgen(js_name = reconcileVehicle)]
    pub fn reconcile_vehicle(
        &mut self,
        correction_distance: f32,
        ack_seq: u16,
        server_px: f32, server_py: f32, server_pz: f32,
        server_qx: f32, server_qy: f32, server_qz: f32, server_qw: f32,
        server_vx: f32, server_vy: f32, server_vz: f32,
        server_wx: f32, server_wy: f32, server_wz: f32,
        dt: f32,
    ) -> Box<[f64]> {
        let Some(vid) = self.local_vehicle_id else {
            return Box::new([0.0; 14]);
        };

        self.vehicle_pending_inputs.retain(|i| seq_is_newer(i.seq, ack_seq));

        let (before_px, before_py, before_pz) = if let Some(v) = self.vehicles.get(&vid) {
            if let Some(rb) = self.sim.rigid_bodies.get(v.chassis_body) {
                let p = rb.translation();
                (p.x, p.y, p.z)
            } else { (0.0, 0.0, 0.0) }
        } else { return Box::new([0.0; 14]); };

        let error = ((before_px - server_px).powi(2)
            + (before_py - server_py).powi(2)
            + (before_pz - server_pz).powi(2))
            .sqrt();

        if error <= correction_distance {
            let state = self.get_vehicle_state(vid);
            let mut out = state.to_vec();
            out.extend_from_slice(&[0.0, 0.0, 0.0, 0.0]);
            return out.into_boxed_slice();
        }

        // Reset chassis to server state.
        if let Some(v) = self.vehicles.get(&vid) {
            if let Some(rb) = self.sim.rigid_bodies.get_mut(v.chassis_body) {
                let iso = UnitQuaternion::from_quaternion(
                    Quaternion::new(server_qw, server_qx, server_qy, server_qz),
                );
                rb.set_position(
                    nalgebra::Isometry3::from_parts(
                        nalgebra::Translation3::new(server_px, server_py, server_pz),
                        iso,
                    ),
                    true,
                );
                rb.set_linvel(vector![server_vx, server_vy, server_vz], true);
                rb.set_angvel(vector![server_wx, server_wy, server_wz], true);
            }
        }

        // Warm up contacts before replay: run a few zero-input steps so the
        // pipeline builds constraint data from the server-reset position.
        // Without this, the first replay steps use cold (uninitialized) contact
        // data, producing different forces than the warm-started server physics.
        for _ in 0..3 {
            self.step_vehicle_pipeline(dt);
        }

        // Replay pending inputs.
        let inputs: Vec<InputCmd> = self.vehicle_pending_inputs.clone();
        for input in &inputs {
            self.apply_vehicle_input(vid, input);
            self.step_vehicle_pipeline(dt);
        }

        let state = self.get_vehicle_state(vid);
        let (after_px, after_py, after_pz) = (state[0] as f32, state[1] as f32, state[2] as f32);
        let dx = (after_px - before_px) as f64;
        let dy = (after_py - before_py) as f64;
        let dz = (after_pz - before_pz) as f64;

        let mut out = state.to_vec();
        out.extend_from_slice(&[dx, dy, dz, 1.0]);
        out.into_boxed_slice()
    }
}

// ── Vehicle helper methods (not exposed to WASM) ────────────────────────────

impl WasmSimWorld {
    fn apply_vehicle_input(&mut self, vid: u32, input: &InputCmd) {
        let v = input_to_vehicle_cmd(input);
        let steering = v.steer * VEHICLE_MAX_STEER_RAD;
        let engine_force = (v.throttle - v.reverse * 0.5) * VEHICLE_ENGINE_FORCE;
        let brake = if v.handbrake { VEHICLE_BRAKE_FORCE * 2.0 } else { v.reverse * VEHICLE_BRAKE_FORCE * 0.3 };

        let Some(vehicle) = self.vehicles.get_mut(&vid) else { return };
        for (i, wheel) in vehicle.controller.wheels_mut().iter_mut().enumerate() {
            if i < 2 { wheel.steering = steering; }
            wheel.engine_force = if i >= 2 { engine_force } else { 0.0 };
            wheel.brake = brake;
        }

        let chassis_collider = vehicle.chassis_collider;
        // Exclude chassis itself and dynamic-body proxy colliders (GROUP_2) —
        // suspension raycasts should only hit terrain.
        let filter = QueryFilter::default()
            .exclude_collider(chassis_collider)
            .groups(InteractionGroups::new(Group::GROUP_1, Group::GROUP_1));
        let dt = 1.0_f32 / 60.0; // used internally for suspension forces
        let queries = self.sim.broad_phase.as_query_pipeline_mut(
            self.sim.narrow_phase.query_dispatcher(),
            &mut self.sim.rigid_bodies,
            &mut self.sim.colliders,
            filter,
        );
        // update_vehicle applies suspension impulses but not integration
        let Some(vehicle) = self.vehicles.get_mut(&vid) else { return };
        vehicle.controller.update_vehicle(dt, queries);
    }

    fn step_vehicle_pipeline(&mut self, dt: f32) {
        let Some(pipeline) = &mut self.vehicle_pipeline else { return };
        // Use the same integration parameters as the server (num_solver_iterations=2)
        // so client and server produce identical physics outputs.
        let mut params = self.sim.integration_parameters;
        params.dt = dt;
        pipeline.step(
            &self.gravity,
            &params,
            &mut self.sim.island_manager,
            &mut self.sim.broad_phase,
            &mut self.sim.narrow_phase,
            &mut self.sim.rigid_bodies,
            &mut self.sim.colliders,
            &mut self.vehicle_joints,
            &mut self.vehicle_multibody_joints,
            &mut self.vehicle_ccd,
            &(),
            &(),
        );
    }

    fn get_vehicle_state(&self, vid: u32) -> Box<[f64]> {
        let Some(vehicle) = self.vehicles.get(&vid) else {
            return Box::new([0.0; 10]);
        };
        let Some(rb) = self.sim.rigid_bodies.get(vehicle.chassis_body) else {
            return Box::new([0.0; 10]);
        };
        let p = rb.translation();
        let r = rb.rotation();
        let v = rb.linvel();
        Box::new([
            p.x as f64, p.y as f64, p.z as f64,
            r.i as f64, r.j as f64, r.k as f64, r.w as f64,
            v.x as f64, v.y as f64, v.z as f64,
        ])
    }
}

/// Clock-sync estimator exposed to JavaScript via WASM.
///
/// Implements Lightyear's adaptive-alpha EMA clock offset tracking with:
/// - Jacobson EWMA RTT estimation (α=1/12, β=1/6)
/// - Adaptive alpha 0.02–0.10 based on jitter
/// - Speed-adjustment hysteresis (3-state: DoNothing/SpeedAdjust/Resync)
/// - Adaptive interpolation delay (jitter*4 + 5 ms)
#[wasm_bindgen]
pub struct WasmClockSync {
    estimator: ServerClockEstimator,
}

#[wasm_bindgen]
impl WasmClockSync {
    /// Create a new clock-sync estimator.
    ///
    /// `sim_hz` — server simulation tick rate (e.g. 20).
    #[wasm_bindgen(constructor)]
    pub fn new(sim_hz: f64) -> Self {
        Self {
            estimator: ServerClockEstimator::new(sim_hz),
        }
    }

    /// Feed a smoothed RTT measurement in milliseconds.
    ///
    /// Call this each time the client computes a round-trip time.
    #[wasm_bindgen(js_name = observeRtt)]
    pub fn observe_rtt(&mut self, rtt_ms: f64) {
        self.estimator.observe_rtt(rtt_ms);
    }

    /// Feed a server-time observation.
    ///
    /// `server_us` — server monotonic timestamp (µs) from the snapshot packet.
    /// `local_us`  — local monotonic timestamp (µs) at packet receipt
    ///               (`performance.now() * 1000` is suitable).
    #[wasm_bindgen(js_name = observeServerTime)]
    pub fn observe_server_time(&mut self, server_us: f64, local_us: f64) {
        self.estimator.observe_server_time(server_us as i64, local_us as i64);
    }

    /// Estimated clock offset in microseconds: `server_time ≈ local_time + offset`.
    #[wasm_bindgen(js_name = getClockOffsetUs)]
    pub fn get_clock_offset_us(&self) -> f64 {
        self.estimator.clock_offset_us()
    }

    /// Current jitter estimate in microseconds.
    #[wasm_bindgen(js_name = getJitterUs)]
    pub fn get_jitter_us(&self) -> f64 {
        self.estimator.jitter_us()
    }

    /// Recommended interpolation delay in milliseconds (jitter*4 + 5 ms, min 5 ms).
    #[wasm_bindgen(js_name = getInterpolationDelayMs)]
    pub fn get_interpolation_delay_ms(&self) -> f64 {
        self.estimator.interpolation_delay_ms()
    }

    /// Smoothed RTT in milliseconds.
    #[wasm_bindgen(js_name = getRttMs)]
    pub fn get_rtt_ms(&self) -> f64 {
        self.estimator.rtt_ms()
    }
}
