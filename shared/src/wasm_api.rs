#![cfg(target_arch = "wasm32")]

use std::collections::HashMap;
use std::sync::Once;

use nalgebra::{vector, Quaternion, UnitQuaternion, Vector3};
use rapier3d::control::DynamicRayCastVehicleController;
use rapier3d::prelude::*;
use wasm_bindgen::prelude::*;

use crate::debug_render::{default_debug_pipeline, render_debug_buffers, DebugLineBuffers};
use crate::local_session::LocalSession;
use crate::movement::{MoveConfig, Vec3d, VEHICLE_SUSPENSION_REST_LENGTH, VEHICLE_WHEEL_RADIUS};
use crate::protocol::{
    FireCmd, InputCmd, NetBatteryState, NetDynamicBodyState, NetPlayerState, NetVehicleState,
};
use crate::seq::seq_is_newer;
use crate::simulation::{simulate_player_tick, SimWorld};
use crate::terrain::{build_demo_heightfield, demo_ball_pit_wall_cuboids};
use crate::vehicle::{
    apply_vehicle_input_step, create_vehicle_physics, read_vehicle_chassis_state,
    read_vehicle_debug_snapshot, refresh_vehicle_contacts, step_vehicle_dynamics,
    vehicle_exit_position, VEHICLE_CHASSIS_HALF_EXTENTS, VEHICLE_CONTROLLER_SUBSTEPS,
    VEHICLE_WHEEL_OFFSETS,
};
use crate::world_document::{StaticPropKind, WorldDocument};
use vibe_netcode::clock_sync::ServerClockEstimator;
use vibe_netcode::lag_comp::{classify_player_hitscan, HitZone};

static PANIC_HOOK: Once = Once::new();

fn install_panic_hook_once() {
    PANIC_HOOK.call_once(console_error_panic_hook::set_once);
}

/// Returns chassis half-extents as [x, y, z].
#[wasm_bindgen]
pub fn vehicle_chassis_half_extents() -> Box<[f32]> {
    Box::new(VEHICLE_CHASSIS_HALF_EXTENTS)
}

/// Returns wheel offsets as a flat array [x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3] (FL, FR, RL, RR).
#[wasm_bindgen]
pub fn vehicle_wheel_offsets() -> Box<[f32]> {
    VEHICLE_WHEEL_OFFSETS.concat().into_boxed_slice()
}

/// Returns the suspension rest length in metres.
#[wasm_bindgen]
pub fn vehicle_suspension_rest_length() -> f32 {
    VEHICLE_SUSPENSION_REST_LENGTH
}

/// Returns the wheel radius in metres.
#[wasm_bindgen]
pub fn vehicle_wheel_radius() -> f32 {
    VEHICLE_WHEEL_RADIUS
}

struct WasmVehicle {
    chassis_body: RigidBodyHandle,
    chassis_collider: ColliderHandle,
    controller: DynamicRayCastVehicleController,
}

#[wasm_bindgen]
pub struct DebugRenderBuffers {
    vertices: Box<[f32]>,
    colors: Box<[f32]>,
}

impl DebugRenderBuffers {
    fn from_line_buffers(buffers: DebugLineBuffers) -> Self {
        Self {
            vertices: buffers.vertices.into_boxed_slice(),
            colors: buffers.colors.into_boxed_slice(),
        }
    }
}

#[wasm_bindgen]
impl DebugRenderBuffers {
    #[wasm_bindgen(getter)]
    pub fn vertices(&self) -> Box<[f32]> {
        self.vertices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn colors(&self) -> Box<[f32]> {
        self.colors.clone()
    }
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

    // Dynamic body rigid bodies (server ID → Rapier RigidBodyHandle)
    dynamic_colliders: HashMap<u32, RigidBodyHandle>,

    // Vehicle simulation (driver-side prediction)
    vehicle_pipeline: Option<PhysicsPipeline>,
    vehicle_joints: ImpulseJointSet,
    vehicle_multibody_joints: MultibodyJointSet,
    vehicle_ccd: CCDSolver,
    vehicles: HashMap<u32, WasmVehicle>,
    local_vehicle_id: Option<u32>,
    vehicle_pending_inputs: Vec<InputCmd>,
    gravity: Vector3<f32>,
    debug_pipeline: DebugRenderPipeline,
}

#[wasm_bindgen]
impl WasmSimWorld {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        install_panic_hook_once();
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
            vehicle_pipeline: Some(PhysicsPipeline::new()),
            vehicle_joints: ImpulseJointSet::new(),
            vehicle_multibody_joints: MultibodyJointSet::new(),
            vehicle_ccd: CCDSolver::new(),
            vehicles: HashMap::new(),
            local_vehicle_id: None,
            vehicle_pending_inputs: Vec::new(),
            gravity: vector![0.0, -20.0, 0.0],
            debug_pipeline: default_debug_pipeline(),
        }
    }

    // ── Collider management ──────────────────────────

    /// Add a static cuboid collider.  Returns a unique ID for later removal.
    #[wasm_bindgen(js_name = addCuboid)]
    pub fn add_cuboid(&mut self, cx: f32, cy: f32, cz: f32, hx: f32, hy: f32, hz: f32) -> u32 {
        let handle = self
            .sim
            .add_static_cuboid(vector![cx, cy, cz], vector![hx, hy, hz], 0);
        let id = self.next_collider_id;
        self.next_collider_id += 1;
        self.collider_ids.insert(id, handle);
        id
    }

    #[wasm_bindgen(js_name = seedDemoTerrain)]
    pub fn seed_demo_terrain(&mut self) -> u32 {
        let (heights, scale) = build_demo_heightfield();
        let handle = self
            .sim
            .add_static_heightfield(vector![0.0, 0.0, 0.0], heights, scale, 0);
        let id = self.next_collider_id;
        self.next_collider_id += 1;
        self.collider_ids.insert(id, handle);
        for (center, half_extents) in demo_ball_pit_wall_cuboids() {
            let wall_handle = self.sim.add_static_cuboid(center, half_extents, 0);
            let wall_id = self.next_collider_id;
            self.next_collider_id += 1;
            self.collider_ids.insert(wall_id, wall_handle);
        }
        id
    }

    #[wasm_bindgen(js_name = loadWorldDocument)]
    pub fn load_world_document(&mut self, world_json: &str) -> Result<(), JsValue> {
        let world: WorldDocument = serde_json::from_str(world_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        for tile in &world.terrain.tiles {
            let (center_x, center_z) = world.terrain_tile_center(tile.tile_x, tile.tile_z);
            let handle = self.sim.add_static_heightfield(
                vector![center_x, 0.0, center_z],
                world
                    .terrain_tile_matrix(tile)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?,
                world.terrain_tile_scale(),
                0,
            );
            let id = self.next_collider_id;
            self.next_collider_id += 1;
            self.collider_ids.insert(id, handle);
        }

        for prop in &world.static_props {
            if matches!(prop.kind, StaticPropKind::Cuboid) {
                let handle = self.sim.add_static_cuboid_rotated(
                    vector![prop.position[0], prop.position[1], prop.position[2]],
                    prop.rotation,
                    vector![
                        prop.half_extents[0],
                        prop.half_extents[1],
                        prop.half_extents[2]
                    ],
                    prop.id as u128,
                );
                let id = self.next_collider_id;
                self.next_collider_id += 1;
                self.collider_ids.insert(id, handle);
            }
        }

        Ok(())
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

    /// Flush incremental collider changes into the broad-phase BVH.
    #[wasm_bindgen(js_name = syncBroadPhase)]
    pub fn sync_broad_phase(&mut self) {
        self.sim.sync_broad_phase();
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
        // Put the player capsule in GROUP_3 so the vehicle chassis (GROUP_1, filter=GROUP_1|GROUP_2)
        // does not physically collide with it.  The capsule still collides with terrain (GROUP_1)
        // and dynamic balls (GROUP_2) via the filter mask.
        if let Some(col) = self.sim.colliders.get_mut(handle) {
            col.set_collision_groups(InteractionGroups::new(
                Group::GROUP_3,
                Group::GROUP_1 | Group::GROUP_2 | Group::GROUP_3,
            ));
        }
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
        let tick = simulate_player_tick(
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
        for impulse in &tick.dynamic_impulses {
            let _ = self.apply_dynamic_body_impulse(
                impulse.body_id,
                impulse.impulse[0],
                impulse.impulse[1],
                impulse.impulse[2],
                impulse.contact_point[0],
                impulse.contact_point[1],
                impulse.contact_point[2],
            );
        }
        self.sim.sync_player_collider(collider, &self.position);
        // Do not free-run the full rigid-body world every on-foot prediction
        // tick. That makes nearby dynamic bodies diverge locally between sparse
        // authoritative snapshots, which shows up as local-only jitter and
        // props briefly falling through the ground before being corrected.
        //
        // Keep stepping when a local vehicle is active, or when this KCC tick
        // actually applied dynamic-body impulses so the contact response starts
        // immediately for the local player.
        if self.local_vehicle_id.is_some() || !tick.dynamic_impulses.is_empty() {
            self.step_vehicle_pipeline(dt);
        }

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
            let tick = simulate_player_tick(
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
            for impulse in &tick.dynamic_impulses {
                let _ = self.apply_dynamic_body_impulse(
                    impulse.body_id,
                    impulse.impulse[0],
                    impulse.impulse[1],
                    impulse.impulse[2],
                    impulse.contact_point[0],
                    impulse.contact_point[1],
                    impulse.contact_point[2],
                );
            }
            self.sim.sync_player_collider(collider, &self.position);
            if self.local_vehicle_id.is_some() || !tick.dynamic_impulses.is_empty() {
                self.step_vehicle_pipeline(dt);
            }
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

    /// Classify a ray against a single remote player using the same Rust logic
    /// the server uses for authoritative body/head resolution.
    ///
    /// Returns `[distance, kind]`, where `kind` is `1` for body and `2` for
    /// head, or an empty array on miss.
    #[wasm_bindgen(js_name = classifyHitscanPlayer)]
    pub fn classify_hitscan_player(
        &self,
        ox: f32,
        oy: f32,
        oz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        body_x: f32,
        body_y: f32,
        body_z: f32,
        blocker_toi: f32,
    ) -> Box<[f32]> {
        let blocker = if blocker_toi.is_finite() {
            Some(blocker_toi)
        } else {
            None
        };
        match classify_player_hitscan(
            [ox, oy, oz],
            [dx, dy, dz],
            [body_x, body_y, body_z],
            self.sim.config.capsule_half_segment,
            self.sim.config.capsule_radius,
            blocker,
        ) {
            Some(hit) => Box::new([
                hit.distance,
                match hit.zone {
                    HitZone::Body => 1.0,
                    HitZone::Head => 2.0,
                },
            ]),
            None => Box::new([]),
        }
    }

    // ── Dynamic body colliders ───────────────────────

    /// Add or create a dynamic body rigid body for physics simulation.
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
        vx: f32,
        vy: f32,
        vz: f32,
        wx: f32,
        wy: f32,
        wz: f32,
    ) {
        if let Some(&body_handle) = self.dynamic_colliders.get(&id) {
            // Update existing rigid body state and mark colliders modified so
            // the broad-phase BVH reflects the new position on the next sync.
            if let Some(rb) = self.sim.rigid_bodies.get_mut(body_handle) {
                rb.set_translation(vector![px, py, pz], true);
                rb.set_rotation(
                    UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz)),
                    true,
                );
                rb.set_linvel(vector![vx, vy, vz], true);
                rb.set_angvel(vector![wx, wy, wz], true);
            }
            if let Some(rb) = self.sim.rigid_bodies.get(body_handle) {
                for ch in rb.colliders() {
                    self.sim.modified_colliders.push(*ch);
                }
            }
        } else {
            // Create new dynamic rigid body with collider parented to it.
            let iso = UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz));
            let body = RigidBodyBuilder::dynamic()
                .pose(nalgebra::Isometry3::from_parts(
                    nalgebra::Translation3::new(px, py, pz),
                    iso,
                ))
                .linvel(vector![vx, vy, vz])
                .angvel(vector![wx, wy, wz])
                .linear_damping(0.3)
                .angular_damping(0.5)
                .can_sleep(false)
                .build();
            let body_handle = self.sim.rigid_bodies.insert(body);

            // GROUP_2 = dynamic-body proxies. They collide with terrain/chassis
            // (GROUP_1) and other dynamic proxies (GROUP_2) so local contacts
            // feel immediate for both walking and driving.
            let dyn_groups =
                InteractionGroups::new(Group::GROUP_2, Group::GROUP_1 | Group::GROUP_2);
            let collider = if shape_type == 1 {
                ColliderBuilder::ball(hx)
                    .density(1.0)
                    .restitution(0.6)
                    .friction(0.2)
                    .collision_groups(dyn_groups)
                    .user_data(id as u128)
                    .build()
            } else {
                ColliderBuilder::cuboid(hx, hy, hz)
                    .density(2.0)
                    .restitution(0.3)
                    .friction(0.6)
                    .collision_groups(dyn_groups)
                    .user_data(id as u128)
                    .build()
            };
            let col_handle = self.sim.colliders.insert_with_parent(
                collider,
                body_handle,
                &mut self.sim.rigid_bodies,
            );
            self.sim.modified_colliders.push(col_handle);
            self.dynamic_colliders.insert(id, body_handle);
        }
    }

    /// Remove a dynamic body rigid body.
    #[wasm_bindgen(js_name = removeDynamicBody)]
    pub fn remove_dynamic_body(&mut self, id: u32) {
        if let Some(body_handle) = self.dynamic_colliders.remove(&id) {
            self.sim.rigid_bodies.remove(
                body_handle,
                &mut self.sim.island_manager,
                &mut self.sim.colliders,
                &mut self.vehicle_joints,
                &mut self.vehicle_multibody_joints,
                true,
            );
        }
    }

    /// Remove all dynamic body colliders not in the given ID list.
    #[wasm_bindgen(js_name = removeStaleeDynamicBodies)]
    pub fn remove_stale_dynamic_bodies(&mut self, active_ids: &[u32]) {
        let active_set: std::collections::HashSet<u32> = active_ids.iter().copied().collect();
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

    #[wasm_bindgen(js_name = getDynamicBodyState)]
    pub fn get_dynamic_body_state(&self, id: u32) -> Box<[f64]> {
        let Some(&body_handle) = self.dynamic_colliders.get(&id) else {
            return Box::new([]);
        };
        let Some(rb) = self.sim.rigid_bodies.get(body_handle) else {
            return Box::new([]);
        };
        let p = rb.translation();
        let r = rb.rotation();
        let lv = rb.linvel();
        let av = rb.angvel();
        Box::new([
            p.x as f64,
            p.y as f64,
            p.z as f64,
            r.i as f64,
            r.j as f64,
            r.k as f64,
            r.w as f64,
            lv.x as f64,
            lv.y as f64,
            lv.z as f64,
            av.x as f64,
            av.y as f64,
            av.z as f64,
        ])
    }

    #[wasm_bindgen(js_name = reconcileDynamicBody)]
    pub fn reconcile_dynamic_body(
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
        vx: f32,
        vy: f32,
        vz: f32,
        wx: f32,
        wy: f32,
        wz: f32,
        pos_threshold: f32,
        rot_threshold: f32,
        hard_snap_distance: f32,
        hard_snap_rot_rad: f32,
        correction_time: f32,
    ) -> bool {
        let Some(&body_handle) = self.dynamic_colliders.get(&id) else {
            self.sync_dynamic_body(
                id, shape_type, hx, hy, hz, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz,
            );
            return true;
        };

        let Some(rb) = self.sim.rigid_bodies.get_mut(body_handle) else {
            self.sync_dynamic_body(
                id, shape_type, hx, hy, hz, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz,
            );
            return true;
        };

        let target_rot = UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz));
        let current_pos = *rb.translation();
        let current_rot = *rb.rotation();
        let pos_error = vector![px - current_pos.x, py - current_pos.y, pz - current_pos.z];
        let pos_error_mag = pos_error.norm();
        let rot_delta = target_rot * current_rot.inverse();
        let rot_error = rot_delta.angle();

        if pos_error_mag > hard_snap_distance || rot_error > hard_snap_rot_rad {
            rb.set_position(
                nalgebra::Isometry3::from_parts(
                    nalgebra::Translation3::new(px, py, pz),
                    target_rot,
                ),
                true,
            );
            rb.set_linvel(vector![vx, vy, vz], true);
            rb.set_angvel(vector![wx, wy, wz], true);
            if let Some(rb_ro) = self.sim.rigid_bodies.get(body_handle) {
                for ch in rb_ro.colliders() {
                    self.sim.modified_colliders.push(*ch);
                }
            }
            return true;
        }

        let correction_horizon = correction_time.max(0.001);
        let desired_linvel = if pos_error_mag > pos_threshold {
            vector![vx, vy, vz] + pos_error / correction_horizon
        } else {
            vector![vx, vy, vz]
        };
        rb.set_linvel(desired_linvel, true);

        let desired_angvel = if rot_error > rot_threshold {
            let bias = rot_delta
                .axis()
                .map(|axis| axis.into_inner() * (rot_error / correction_horizon))
                .unwrap_or_else(Vector3::zeros);
            vector![wx, wy, wz] + bias
        } else {
            vector![wx, wy, wz]
        };
        rb.set_angvel(desired_angvel, true);

        if let Some(rb_ro) = self.sim.rigid_bodies.get(body_handle) {
            for ch in rb_ro.colliders() {
                self.sim.modified_colliders.push(*ch);
            }
        }
        false
    }

    #[wasm_bindgen(js_name = castDynamicBodyRay)]
    pub fn cast_dynamic_body_ray(
        &mut self,
        ox: f32,
        oy: f32,
        oz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        max_toi: f32,
    ) -> Box<[f64]> {
        self.sim
            .rigid_bodies
            .propagate_modified_body_positions_to_colliders(&mut self.sim.colliders);
        self.sim.sync_broad_phase();
        let ray = rapier3d::prelude::Ray::new(nalgebra::point![ox, oy, oz], vector![dx, dy, dz]);
        let mut best: Option<(u32, f32, [f32; 3])> = None;
        for (&id, &body_handle) in &self.dynamic_colliders {
            let Some(rb) = self.sim.rigid_bodies.get(body_handle) else {
                continue;
            };
            for collider_handle in rb.colliders() {
                let Some(collider) = self.sim.colliders.get(*collider_handle) else {
                    continue;
                };
                let collider_pose = collider
                    .parent()
                    .and_then(|parent| self.sim.rigid_bodies.get(parent))
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
        }

        let Some((id, toi, normal)) = best else {
            return Box::new([]);
        };
        Box::new([
            id as f64,
            toi as f64,
            normal[0] as f64,
            normal[1] as f64,
            normal[2] as f64,
        ])
    }

    #[wasm_bindgen(js_name = applyDynamicBodyImpulse)]
    pub fn apply_dynamic_body_impulse(
        &mut self,
        id: u32,
        ix: f32,
        iy: f32,
        iz: f32,
        px: f32,
        py: f32,
        pz: f32,
    ) -> bool {
        let Some(&body_handle) = self.dynamic_colliders.get(&id) else {
            return false;
        };
        let Some(rb) = self.sim.rigid_bodies.get_mut(body_handle) else {
            return false;
        };
        let world_com = *rb.center_of_mass();
        let impulse = vector![ix, iy, iz];
        let point = nalgebra::point![px, py, pz];
        let torque = (point - world_com).cross(&impulse);
        rb.apply_impulse(impulse, true);
        rb.apply_torque_impulse(torque, true);
        true
    }

    #[wasm_bindgen(js_name = stepDynamics)]
    pub fn step_dynamics(&mut self, dt: f32) {
        self.step_vehicle_pipeline(dt);
    }

    #[wasm_bindgen(js_name = debugRender)]
    pub fn debug_render(&mut self, mode_bits: u32) -> DebugRenderBuffers {
        // Keep collider world-poses in sync with any rigid bodies we moved
        // manually from snapshots/reconciliation. This updates attached collider
        // transforms without advancing the simulation.
        self.sim
            .rigid_bodies
            .propagate_modified_body_positions_to_colliders(&mut self.sim.colliders);
        // Observer clients may update collider transforms from snapshots without
        // advancing local physics. Flush those pending collider changes so the
        // debug draw reflects current proxy positions rather than stale AABBs.
        self.sim.sync_broad_phase();
        let buffers = render_debug_buffers(
            &mut self.debug_pipeline,
            mode_bits,
            &self.sim.rigid_bodies,
            &self.sim.colliders,
            &self.vehicle_joints,
            &self.vehicle_multibody_joints,
            &self.sim.narrow_phase,
        );
        DebugRenderBuffers::from_line_buffers(buffers)
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
        px: f32,
        py: f32,
        pz: f32,
        qx: f32,
        qy: f32,
        qz: f32,
        qw: f32,
    ) {
        // Remove existing vehicle with same ID if present.
        self.remove_vehicle(id);

        let iso = UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz));
        let pose = nalgebra::Isometry3::from_parts(nalgebra::Translation3::new(px, py, pz), iso);
        let (chassis_body, chassis_collider, controller) =
            create_vehicle_physics(&mut self.sim, pose);

        self.vehicles.insert(
            id,
            WasmVehicle {
                chassis_body,
                chassis_collider,
                controller,
            },
        );
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
                self.vehicle_pending_inputs.clear();
            }
        }
    }

    /// Mark `vehicle_id` as the locally-driven vehicle (activates prediction pipeline).
    #[wasm_bindgen(js_name = setLocalVehicle)]
    pub fn set_local_vehicle(&mut self, vehicle_id: u32) {
        self.local_vehicle_id = Some(vehicle_id);
        self.vehicle_pending_inputs.clear();
        self.refresh_local_vehicle_contacts();
    }

    /// Clear the local vehicle (called on exit).
    #[wasm_bindgen(js_name = clearLocalVehicle)]
    pub fn clear_local_vehicle(&mut self) {
        if let Some(vehicle_id) = self.local_vehicle_id {
            if let Some(vehicle) = self.vehicles.get(&vehicle_id) {
                if let Some(chassis_state) =
                    read_vehicle_chassis_state(&self.sim, vehicle.chassis_body)
                {
                    self.position = vehicle_exit_position(&chassis_state);
                    if let Some(collider) = self.player_collider {
                        self.sim.sync_player_collider(collider, &self.position);
                    }
                }
            }
        }
        self.local_vehicle_id = None;
        self.vehicle_pending_inputs.clear();
    }

    /// Sync a remote vehicle's chassis pose/velocity (kinematic update).
    /// Returns `[px, py, pz, qx, qy, qz, qw]`.
    #[wasm_bindgen(js_name = syncRemoteVehicle)]
    pub fn sync_remote_vehicle(
        &mut self,
        id: u32,
        px: f32,
        py: f32,
        pz: f32,
        qx: f32,
        qy: f32,
        qz: f32,
        qw: f32,
        vx: f32,
        vy: f32,
        vz: f32,
    ) {
        let Some(vehicle) = self.vehicles.get(&id) else {
            return;
        };
        if Some(id) == self.local_vehicle_id {
            return;
        } // local vehicle is predicted, not synced
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

        let input = InputCmd {
            seq,
            buttons,
            move_x,
            move_y,
            yaw,
            pitch,
        };
        self.vehicle_pending_inputs.push(input.clone());
        const MAX_ROLLBACK: usize = 100;
        if self.vehicle_pending_inputs.len() > MAX_ROLLBACK {
            let excess = self.vehicle_pending_inputs.len() - MAX_ROLLBACK;
            self.vehicle_pending_inputs.drain(0..excess);
        }

        self.step_local_vehicle_input(vid, &input, dt);

        self.get_vehicle_state(vid)
    }

    /// Reconcile local vehicle with an authoritative server snapshot.
    /// Returns `[px, py, pz, qx, qy, qz, qw, vx, vy, vz, dx, dy, dz, did_correct]`.
    #[wasm_bindgen(js_name = reconcileVehicle)]
    pub fn reconcile_vehicle(
        &mut self,
        pos_threshold: f32,
        rot_threshold: f32,
        vel_threshold: f32,
        angvel_threshold: f32,
        ack_seq: u16,
        server_px: f32,
        server_py: f32,
        server_pz: f32,
        server_qx: f32,
        server_qy: f32,
        server_qz: f32,
        server_qw: f32,
        server_vx: f32,
        server_vy: f32,
        server_vz: f32,
        server_wx: f32,
        server_wy: f32,
        server_wz: f32,
        dt: f32,
    ) -> Box<[f64]> {
        let Some(vid) = self.local_vehicle_id else {
            return Box::new([0.0; 14]);
        };

        self.vehicle_pending_inputs
            .retain(|i| seq_is_newer(i.seq, ack_seq));

        let Some(v) = self.vehicles.get(&vid) else {
            return Box::new([0.0; 14]);
        };
        let Some(rb) = self.sim.rigid_bodies.get(v.chassis_body) else {
            return Box::new([0.0; 14]);
        };
        let before_p = *rb.translation();
        let before_q = *rb.rotation();
        let before_v = *rb.linvel();
        let before_w = *rb.angvel();
        let (before_px, before_py, before_pz) = (before_p.x, before_p.y, before_p.z);
        let (before_vx, before_vy, before_vz) = (before_v.x, before_v.y, before_v.z);
        let (before_wx, before_wy, before_wz) = (before_w.x, before_w.y, before_w.z);
        let (before_qx, before_qy, before_qz, before_qw) =
            (before_q.i, before_q.j, before_q.k, before_q.w);

        let pos_error = ((before_px - server_px).powi(2)
            + (before_py - server_py).powi(2)
            + (before_pz - server_pz).powi(2))
        .sqrt();
        let vel_error = ((before_vx - server_vx).powi(2)
            + (before_vy - server_vy).powi(2)
            + (before_vz - server_vz).powi(2))
        .sqrt();
        let angvel_error = ((before_wx - server_wx).powi(2)
            + (before_wy - server_wy).powi(2)
            + (before_wz - server_wz).powi(2))
        .sqrt();
        let dot = (before_qx * server_qx
            + before_qy * server_qy
            + before_qz * server_qz
            + before_qw * server_qw)
            .abs()
            .min(1.0);
        let rot_error_rad = 2.0 * dot.acos();

        let needs_correction = pos_error > pos_threshold
            || rot_error_rad > rot_threshold
            || vel_error > vel_threshold
            || angvel_error > angvel_threshold;

        if !needs_correction {
            let state = self.get_vehicle_state(vid);
            let mut out = state.to_vec();
            out.extend_from_slice(&[0.0, 0.0, 0.0, 0.0]);
            return out.into_boxed_slice();
        }

        // Reset chassis to server state.
        if let Some(v) = self.vehicles.get(&vid) {
            if let Some(rb) = self.sim.rigid_bodies.get_mut(v.chassis_body) {
                let iso = UnitQuaternion::from_quaternion(Quaternion::new(
                    server_qw, server_qx, server_qy, server_qz,
                ));
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

        // Refresh wheel raycasts from the reset pose without advancing time.
        // Stepping full dynamics here would incorrectly add extra vehicle motion
        // before replaying the pending input history.
        self.refresh_local_vehicle_contacts();

        // Replay pending inputs.
        let inputs: Vec<InputCmd> = self.vehicle_pending_inputs.clone();
        for input in &inputs {
            self.step_local_vehicle_input(vid, input, dt);
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

    #[wasm_bindgen(js_name = getVehicleDebug)]
    pub fn get_vehicle_debug(&self, vid: u32) -> Box<[f64]> {
        let Some(vehicle) = self.vehicles.get(&vid) else {
            return Box::new([]);
        };
        let Some(debug) =
            read_vehicle_debug_snapshot(&self.sim, vehicle.chassis_body, &vehicle.controller)
        else {
            return Box::new([]);
        };
        let mut out = Vec::with_capacity(64);
        out.push(debug.speed as f64);
        out.push(debug.grounded_wheels as f64);
        out.push(debug.steering as f64);
        out.push(debug.engine_force as f64);
        out.push(debug.brake as f64);
        out.push(debug.linear_velocity[0] as f64);
        out.push(debug.linear_velocity[1] as f64);
        out.push(debug.linear_velocity[2] as f64);
        out.push(debug.angular_velocity[0] as f64);
        out.push(debug.angular_velocity[1] as f64);
        out.push(debug.angular_velocity[2] as f64);
        out.push(debug.wheel_contact_bits as f64);
        out.extend(debug.suspension_lengths.into_iter().map(|v| v as f64));
        out.extend(debug.suspension_forces.into_iter().map(|v| v as f64));
        out.extend(
            debug
                .suspension_relative_velocities
                .into_iter()
                .map(|v| v as f64),
        );
        for point in debug.wheel_hard_points {
            out.extend(point.into_iter().map(|v| v as f64));
        }
        for point in debug.wheel_contact_points {
            out.extend(point.into_iter().map(|v| v as f64));
        }
        for normal in debug.wheel_contact_normals {
            out.extend(normal.into_iter().map(|v| v as f64));
        }
        out.extend(debug.wheel_ground_object_ids.into_iter().map(|v| v as f64));
        out.into_boxed_slice()
    }

    #[wasm_bindgen(js_name = getVehiclePendingCount)]
    pub fn get_vehicle_pending_count(&self) -> u32 {
        self.vehicle_pending_inputs.len() as u32
    }

    #[wasm_bindgen(js_name = pruneVehiclePendingInputsThrough)]
    pub fn prune_vehicle_pending_inputs_through(&mut self, ack_seq: u16) {
        self.vehicle_pending_inputs
            .retain(|input| seq_is_newer(input.seq, ack_seq));
    }
}

// ── Vehicle helper methods (not exposed to WASM) ────────────────────────────

impl WasmSimWorld {
    fn refresh_local_vehicle_contacts(&mut self) {
        let Some(vid) = self.local_vehicle_id else {
            return;
        };
        let Some(vehicle) = self.vehicles.get_mut(&vid) else {
            return;
        };
        refresh_vehicle_contacts(
            &mut self.sim,
            vehicle.chassis_collider,
            &mut vehicle.controller,
        );
    }

    fn apply_vehicle_input(&mut self, vid: u32, input: &InputCmd, dt: f32) {
        let Some(vehicle) = self.vehicles.get_mut(&vid) else {
            return;
        };
        apply_vehicle_input_step(
            &mut self.sim,
            vehicle.chassis_body,
            vehicle.chassis_collider,
            &mut vehicle.controller,
            input,
            dt,
        );
    }

    fn step_local_vehicle_input(&mut self, vid: u32, input: &InputCmd, dt: f32) {
        let substep_dt = dt / VEHICLE_CONTROLLER_SUBSTEPS as f32;
        for _ in 0..VEHICLE_CONTROLLER_SUBSTEPS {
            self.apply_vehicle_input(vid, input, substep_dt);
            self.step_vehicle_pipeline(substep_dt);
        }
    }

    fn step_vehicle_pipeline(&mut self, dt: f32) {
        let Some(pipeline) = &mut self.vehicle_pipeline else {
            return;
        };
        step_vehicle_dynamics(
            &mut self.sim,
            &self.gravity,
            pipeline,
            &mut self.vehicle_joints,
            &mut self.vehicle_multibody_joints,
            &mut self.vehicle_ccd,
            dt,
        );
    }

    fn get_vehicle_state(&self, vid: u32) -> Box<[f64]> {
        let Some(vehicle) = self.vehicles.get(&vid) else {
            return Box::new([0.0; 10]);
        };
        let Some(state) = read_vehicle_chassis_state(&self.sim, vehicle.chassis_body) else {
            return Box::new([0.0; 10]);
        };
        Box::new([
            state.position[0] as f64,
            state.position[1] as f64,
            state.position[2] as f64,
            state.quaternion[0] as f64,
            state.quaternion[1] as f64,
            state.quaternion[2] as f64,
            state.quaternion[3] as f64,
            state.linear_velocity[0] as f64,
            state.linear_velocity[1] as f64,
            state.linear_velocity[2] as f64,
        ])
    }
}

#[wasm_bindgen]
pub struct WasmLocalSession {
    inner: LocalSession,
}

const LOCAL_DYNAMIC_BODY_STATE_STRIDE: usize = 18;
const LOCAL_VEHICLE_STATE_STRIDE: usize = 21;
const LOCAL_BATTERY_STATE_STRIDE: usize = 7;

#[wasm_bindgen]
impl WasmLocalSession {
    #[wasm_bindgen(constructor)]
    pub fn new(world_json: Option<String>) -> Result<Self, JsValue> {
        install_panic_hook_once();
        let inner = match world_json {
            Some(world_json) => {
                LocalSession::from_world_json(&world_json).map_err(|err| JsValue::from_str(&err))?
            }
            None => LocalSession::new(),
        };
        Ok(Self { inner })
    }

    pub fn connect(&mut self) {
        self.inner.connect();
    }

    pub fn disconnect(&mut self) {
        self.inner.disconnect();
    }

    #[wasm_bindgen(js_name = handleClientPacket)]
    pub fn handle_client_packet(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .handle_client_packet(bytes)
            .map_err(|err| JsValue::from_str(&err))
    }

    #[wasm_bindgen(js_name = enqueueInput)]
    pub fn enqueue_input(
        &mut self,
        seq: u16,
        buttons: u16,
        move_x: i8,
        move_y: i8,
        yaw: f32,
        pitch: f32,
    ) {
        self.inner.enqueue_input(InputCmd {
            seq,
            buttons,
            move_x,
            move_y,
            yaw,
            pitch,
        });
    }

    #[wasm_bindgen(js_name = queueFire)]
    pub fn queue_fire(
        &mut self,
        seq: u16,
        shot_id: u32,
        weapon: u8,
        client_fire_time_us: f64,
        client_interp_ms: u16,
        client_dynamic_interp_ms: u16,
        dir_x: f32,
        dir_y: f32,
        dir_z: f32,
    ) {
        self.inner.queue_fire_cmd(FireCmd {
            seq,
            shot_id,
            weapon,
            client_fire_time_us: client_fire_time_us.max(0.0).round() as u64,
            client_interp_ms,
            client_dynamic_interp_ms,
            dir: [dir_x, dir_y, dir_z],
        });
    }

    #[wasm_bindgen(js_name = enterVehicle)]
    pub fn enter_vehicle(&mut self, vehicle_id: u32) {
        self.inner.enter_vehicle(vehicle_id);
    }

    #[wasm_bindgen(js_name = exitVehicle)]
    pub fn exit_vehicle(&mut self, vehicle_id: u32) {
        self.inner.exit_vehicle(vehicle_id);
    }

    pub fn tick(&mut self, dt: f32) {
        self.inner.tick(dt);
    }

    #[wasm_bindgen(js_name = getSnapshotMeta)]
    pub fn get_snapshot_meta(&self) -> Box<[f64]> {
        Box::new([
            self.inner.server_time_us() as f64,
            self.inner.server_tick() as f64,
            self.inner.ack_input_seq() as f64,
            self.inner.player_id() as f64,
        ])
    }

    #[wasm_bindgen(js_name = getLocalPlayerState)]
    pub fn get_local_player_state(&self) -> Box<[f64]> {
        flatten_player_state(self.inner.local_player_state())
    }

    #[wasm_bindgen(js_name = getDynamicBodyStates)]
    pub fn get_dynamic_body_states(&self) -> Box<[f64]> {
        let states = self.inner.dynamic_body_states();
        let mut out = Vec::with_capacity(states.len() * LOCAL_DYNAMIC_BODY_STATE_STRIDE);
        for state in &states {
            push_dynamic_body_state(&mut out, state);
        }
        out.into_boxed_slice()
    }

    #[wasm_bindgen(js_name = getVehicleStates)]
    pub fn get_vehicle_states(&self) -> Box<[f64]> {
        let states = self.inner.vehicle_states();
        let mut out = Vec::with_capacity(states.len() * LOCAL_VEHICLE_STATE_STRIDE);
        for state in &states {
            push_vehicle_state(&mut out, state);
        }
        out.into_boxed_slice()
    }

    #[wasm_bindgen(js_name = getBatteryStates)]
    pub fn get_battery_states(&self) -> Box<[f64]> {
        let states = self.inner.battery_states();
        let mut out = Vec::with_capacity(states.len() * LOCAL_BATTERY_STATE_STRIDE);
        for state in &states {
            push_battery_state(&mut out, state);
        }
        out.into_boxed_slice()
    }

    #[wasm_bindgen(js_name = castSceneRay)]
    pub fn cast_scene_ray(
        &self,
        ox: f32,
        oy: f32,
        oz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        max_toi: f32,
    ) -> Box<[f32]> {
        match self
            .inner
            .cast_scene_ray([ox, oy, oz], [dx, dy, dz], max_toi)
        {
            Some(toi) => Box::new([toi]),
            None => Box::new([]),
        }
    }

    #[wasm_bindgen(js_name = getVehicleDebug)]
    pub fn get_vehicle_debug(&self, vehicle_id: u32) -> Box<[f64]> {
        let Some(debug) = self.inner.vehicle_debug(vehicle_id) else {
            return Box::new([]);
        };
        let mut out = Vec::with_capacity(64);
        out.push(debug.speed as f64);
        out.push(debug.grounded_wheels as f64);
        out.push(debug.steering as f64);
        out.push(debug.engine_force as f64);
        out.push(debug.brake as f64);
        out.push(debug.linear_velocity[0] as f64);
        out.push(debug.linear_velocity[1] as f64);
        out.push(debug.linear_velocity[2] as f64);
        out.push(debug.angular_velocity[0] as f64);
        out.push(debug.angular_velocity[1] as f64);
        out.push(debug.angular_velocity[2] as f64);
        out.push(debug.wheel_contact_bits as f64);
        out.extend(debug.suspension_lengths.into_iter().map(|v| v as f64));
        out.extend(debug.suspension_forces.into_iter().map(|v| v as f64));
        out.extend(
            debug
                .suspension_relative_velocities
                .into_iter()
                .map(|v| v as f64),
        );
        for point in debug.wheel_hard_points {
            out.extend(point.into_iter().map(|v| v as f64));
        }
        for point in debug.wheel_contact_points {
            out.extend(point.into_iter().map(|v| v as f64));
        }
        for normal in debug.wheel_contact_normals {
            out.extend(normal.into_iter().map(|v| v as f64));
        }
        out.extend(debug.wheel_ground_object_ids.into_iter().map(|v| v as f64));
        out.into_boxed_slice()
    }

    #[wasm_bindgen(js_name = drainPackets)]
    pub fn drain_packets(&mut self) -> Box<[u8]> {
        self.inner.drain_packet_blob().into_boxed_slice()
    }
}

fn flatten_player_state(state: Option<NetPlayerState>) -> Box<[f64]> {
    let Some(state) = state else {
        return Box::new([]);
    };
    Box::new([
        state.id as f64,
        state.px_mm as f64,
        state.py_mm as f64,
        state.pz_mm as f64,
        state.vx_cms as f64,
        state.vy_cms as f64,
        state.vz_cms as f64,
        state.yaw_i16 as f64,
        state.pitch_i16 as f64,
        state.hp as f64,
        state.flags as f64,
        state.energy_centi as f64,
    ])
}

fn push_dynamic_body_state(out: &mut Vec<f64>, state: &NetDynamicBodyState) {
    out.extend_from_slice(&[
        state.id as f64,
        state.shape_type as f64,
        state.px_mm as f64,
        state.py_mm as f64,
        state.pz_mm as f64,
        state.qx_snorm as f64,
        state.qy_snorm as f64,
        state.qz_snorm as f64,
        state.qw_snorm as f64,
        state.hx_cm as f64,
        state.hy_cm as f64,
        state.hz_cm as f64,
        state.vx_cms as f64,
        state.vy_cms as f64,
        state.vz_cms as f64,
        state.wx_mrads as f64,
        state.wy_mrads as f64,
        state.wz_mrads as f64,
    ]);
}

fn push_vehicle_state(out: &mut Vec<f64>, state: &NetVehicleState) {
    out.extend_from_slice(&[
        state.id as f64,
        state.vehicle_type as f64,
        state.flags as f64,
        state.driver_id as f64,
        state.px_mm as f64,
        state.py_mm as f64,
        state.pz_mm as f64,
        state.qx_snorm as f64,
        state.qy_snorm as f64,
        state.qz_snorm as f64,
        state.qw_snorm as f64,
        state.vx_cms as f64,
        state.vy_cms as f64,
        state.vz_cms as f64,
        state.wx_mrads as f64,
        state.wy_mrads as f64,
        state.wz_mrads as f64,
        state.wheel_data[0] as f64,
        state.wheel_data[1] as f64,
        state.wheel_data[2] as f64,
        state.wheel_data[3] as f64,
    ]);
}

fn push_battery_state(out: &mut Vec<f64>, state: &NetBatteryState) {
    out.extend_from_slice(&[
        state.id as f64,
        state.px_mm as f64,
        state.py_mm as f64,
        state.pz_mm as f64,
        state.energy_centi as f64,
        state.radius_cm as f64,
        state.height_cm as f64,
    ]);
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
        self.estimator
            .observe_server_time(server_us as i64, local_us as i64);
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
