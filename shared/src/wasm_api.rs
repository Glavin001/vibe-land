#![cfg(target_arch = "wasm32")]

use std::collections::HashMap;

use nalgebra::{vector, Quaternion, UnitQuaternion};
use rapier3d::prelude::*;
use wasm_bindgen::prelude::*;

use crate::movement::{MoveConfig, Vec3d};
use crate::protocol::InputCmd;
use crate::seq::seq_is_newer;
use crate::simulation::{simulate_player_tick, SimWorld};
use vibe_netcode::clock_sync::ServerClockEstimator;

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
            // Create new collider
            let handle = if shape_type == 1 {
                self.sim.colliders.insert(
                    ColliderBuilder::ball(hx)
                        .translation(vector![px, py, pz])
                        .rotation(
                            UnitQuaternion::from_quaternion(Quaternion::new(qw, qx, qy, qz))
                                .scaled_axis(),
                        )
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
