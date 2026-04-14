//! Snap-machine integration for vibe-land.
//!
//! Wraps `snap_machines_rapier::MachineRuntime` so it lives inside our existing
//! Rapier sets (the same `RigidBodySet`, `ColliderSet`, and `ImpulseJointSet`
//! that the rest of the world already uses), and provides a deterministic
//! mapping between the wire-format actuator-channel array carried on
//! `InputCmd` and the named `RuntimeInputState` actions that snap-machines
//! use internally.
//!
//! Both server (`PhysicsArena`) and client wasm (`WasmSimWorld`) drive the
//! exact same code in here — that is the entire point: client-side prediction
//! is byte-for-byte identical to the authoritative server step.

use std::collections::HashMap;

use nalgebra::{Isometry3, Quaternion, Translation3, UnitQuaternion, Vector3};
use rapier3d::prelude::*;
use serde_json::Value;
use snap_machines_rapier::{
    JointKind, MachineBehaviorPlan, MachineBodyPlan, MachineJointPlan, MachinePlan,
    MachineWorldMut, MachineWorldRemove, MachineRuntime, Quat as SmQuat, RuntimeBuildError,
    RuntimeInputState, RuntimeInputValue, SerializedMachineEnvelope, Transform as SmTransform,
    Vec3 as SmVec3,
};

/// Maximum number of named actuator channels carried per `InputCmd`.
pub const MAX_MACHINE_CHANNELS: usize = 8;

/// Flat byte size of a serialized `NetSnapBodyState` on the wire (matches
/// `protocol.rs::NetSnapBodyState`'s little-endian encoding).
pub const NET_SNAP_BODY_STATE_BYTES: usize = 2 + 12 + 8 + 6 + 6;

/// Hard cap on the number of bodies a single snap-machine can have. Keeps
/// snapshot framing predictable for AOI-filtering.
pub const MAX_MACHINE_BODIES: usize = 32;

/// Multiplier applied to every joint motor's `max_force` at install
/// time. The shipped snap-machines viewer fixtures are tuned for the
/// library's default gravity (−9.81 m/s²), while vibe-land runs
/// `−20 m/s²` and a heavier vehicle fleet. Multiplying at install
/// keeps the fixture JSON byte-identical to upstream while letting
/// motors overcome weight + friction without wheelying the machine.
/// If a machine feels sluggish this is the first knob to tune.
pub const MOTOR_MAX_FORCE_MULTIPLIER: f32 = 50.0;

/// Bumped alongside the max-force multiplier so the Rapier 0.30
/// acceleration-based motor solver tightens the control loop on every
/// tick. Necessary for symmetric vehicles (4-wheel car / rover) where
/// the default damping lets only two of four motors engage per step
/// — observed directly with upstream snap-machines-rapier against an
/// unmodified envelope during development.
pub const MOTOR_DAMPING_MULTIPLIER: f32 = 10.0;

/// Multiplier applied to every collider's explicit `mass` override on
/// install. The shipped fixtures author toy-scale masses (chassis 1
/// kg, wheels 1.5 kg each → total ~8 kg) which means the vibe-land
/// vehicle (~300 kg chassis) would trivially shove a parked
/// snap-machine aside and look like it phased through. This scales
/// the whole machine mass up to roughly vehicle-weight range so
/// contacts feel solid. The force multiplier is set proportionally
/// larger so torque budget stays ahead of the extra inertia.
pub const COLLIDER_MASS_MULTIPLIER: f32 = 30.0;

#[derive(Debug)]
pub enum SnapMachineError {
    InvalidEnvelope(String),
    Build(String),
    TooManyBodies { count: usize, max: usize },
}

impl std::fmt::Display for SnapMachineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEnvelope(e) => write!(f, "invalid snap-machine envelope: {e}"),
            Self::Build(e) => write!(f, "snap-machine build error: {e}"),
            Self::TooManyBodies { count, max } => {
                write!(f, "snap-machine has {count} bodies (max {max})")
            }
        }
    }
}

impl std::error::Error for SnapMachineError {}

impl From<RuntimeBuildError> for SnapMachineError {
    fn from(value: RuntimeBuildError) -> Self {
        Self::Build(value.to_string())
    }
}

impl From<serde_json::Error> for SnapMachineError {
    fn from(value: serde_json::Error) -> Self {
        Self::InvalidEnvelope(value.to_string())
    }
}

/// One installed snap-machine instance, sharing rapier sets with the
/// surrounding world.
pub struct SnapMachine {
    runtime: MachineRuntime,
    /// Stable, sorted-by-body-id list of body identifiers in the plan.
    /// Network snapshots address bodies by index into this vec.
    body_ids: Vec<String>,
    /// Stable, sorted-alphabetically list of action names. Wire-format
    /// channel index → action name lives here. Both server and client must
    /// derive this identically.
    action_channels: Vec<String>,
    /// Envelope-resolved keyboard bindings (defaults + `controls` overrides).
    /// Stored at install so wasm can expose the same table the HUD walks.
    bindings: Vec<crate::snap_machine_controls::MachineBinding>,
    /// Optional control profile from the envelope (for client-side keybind
    /// derivation). Cloned so the envelope JSON can be dropped after install.
    controls: Option<snap_machines_rapier::MachineControls>,
    /// Human-readable name captured from `envelope.metadata.presetName`
    /// (falls back to `displayName`, then `None`). Surfaced in the HUD so
    /// the player sees "4-Wheel Car" / "Crane" instead of "On Foot" while
    /// operating the machine.
    display_name: Option<String>,
}

impl SnapMachine {
    /// Decode a JSON envelope `Value`, pre-translate every body origin by
    /// `pose`, install the plan into `world`, and return a runnable
    /// `SnapMachine`.
    ///
    /// Body origins are first shifted so the envelope's lowest collider
    /// sits at envelope-local `y = 0`. This means the caller can pass a
    /// spawn pose `y` that directly corresponds to "put the machine's
    /// floor here" rather than having to know each envelope's internal
    /// authoring convention.
    pub fn install_envelope_at_pose(
        world: &mut MachineWorldMut<'_>,
        envelope_json: &Value,
        pose: Isometry3<f32>,
    ) -> Result<Self, SnapMachineError> {
        let mut envelope: SerializedMachineEnvelope =
            serde_json::from_value(envelope_json.clone())?;

        if envelope.plan.bodies.len() > MAX_MACHINE_BODIES {
            return Err(SnapMachineError::TooManyBodies {
                count: envelope.plan.bodies.len(),
                max: MAX_MACHINE_BODIES,
            });
        }

        // Drop every body so the envelope's lowest collider ends up at
        // local y = 0. Callers can then specify a spawn y that means
        // "put the floor of the machine here" — no envelope-specific
        // tuning needed.
        let min_y = envelope_min_y(&envelope.plan);
        if min_y.is_finite() && min_y != 0.0 {
            for body in &mut envelope.plan.bodies {
                body.origin.position.y -= min_y;
            }
        }

        // Scale every joint motor's max_force so the machine can fight
        // vibe-land's stronger gravity, and bump damping the same
        // amount so the Rapier 0.30 acceleration-based motor solver
        // converges fast enough for all 4 wheels of a symmetric
        // vehicle to engage on every tick. Without the damping bump
        // the solver settles into a diagonal-pair cooperation where
        // only two wheels spin (observed directly in the
        // `raw_rapier_simulation_drives_4_wheel_car` control test).
        for joint in &mut envelope.plan.joints {
            if let Some(motor) = joint.motor.as_mut() {
                if let Some(max_force) = motor.max_force.as_mut() {
                    *max_force *= MOTOR_MAX_FORCE_MULTIPLIER;
                }
                motor.damping *= MOTOR_DAMPING_MULTIPLIER;
            }
        }

        // Scale every collider's explicit mass override. Fixtures are
        // authored at toy scale (~15 kg cars); without this the
        // 300 kg vehicle chassis trivially shoves a parked machine.
        for body in &mut envelope.plan.bodies {
            for collider in &mut body.colliders {
                if let Some(mass) = collider.mass.as_mut() {
                    *mass *= COLLIDER_MASS_MULTIPLIER;
                }
            }
        }

        retransform_plan_bodies(&mut envelope.plan, pose);

        // Capture the display name before `envelope` is moved into the
        // runtime installer. The metadata field is an optional JSON
        // object on `SerializedMachineEnvelope`.
        let display_name = envelope
            .metadata
            .as_ref()
            .and_then(|meta| {
                meta.get("presetName")
                    .or_else(|| meta.get("displayName"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            });

        let plan_for_meta = envelope.plan.clone();
        let controls = envelope.controls.take();

        let bindings = crate::snap_machine_controls::derive_machine_bindings(envelope_json);

        let runtime = MachineRuntime::install_envelope(world, envelope)?;

        let mut body_ids: Vec<String> =
            plan_for_meta.bodies.iter().map(|b| b.id.clone()).collect();
        body_ids.sort();

        let action_channels = derive_action_channels(&plan_for_meta);

        Ok(Self {
            runtime,
            body_ids,
            action_channels,
            bindings,
            controls,
            display_name,
        })
    }

    /// Machine display name from `envelope.metadata.presetName`, if
    /// present.
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    pub fn body_ids(&self) -> &[String] {
        &self.body_ids
    }

    pub fn action_channels(&self) -> &[String] {
        &self.action_channels
    }

    /// Player-facing bindings captured at install (envelope `controls` or
    /// defaults). Same row format as [`SnapMachine::bindings_wire_string`].
    pub fn machine_bindings(&self) -> &[crate::snap_machine_controls::MachineBinding] {
        &self.bindings
    }

    /// `\n`-delimited rows: `action\tposKey\tnegKey\tscale` (`negKey` may be
    /// empty).
    pub fn bindings_wire_string(&self) -> String {
        self.bindings
            .iter()
            .map(|b| {
                let neg = b.neg_key.as_deref().unwrap_or("");
                format!("{}\t{}\t{}\t{}", b.action, b.pos_key, neg, b.scale)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn controls(&self) -> Option<&snap_machines_rapier::MachineControls> {
        self.controls.as_ref()
    }

    pub fn plan(&self) -> &MachinePlan {
        self.runtime.plan()
    }

    pub fn body_handle(&self, body_id: &str) -> Option<RigidBodyHandle> {
        self.runtime.body_handle(body_id)
    }

    pub fn joint_handle(&self, joint_id: &str) -> Option<rapier3d::dynamics::ImpulseJointHandle> {
        self.runtime.joint_handle(joint_id)
    }

    /// Step the machine one tick. Caller is responsible for stepping the
    /// surrounding rapier `PhysicsPipeline` separately — this function only
    /// updates motor targets and applies thruster forces.
    pub fn apply_input(
        &mut self,
        world: &mut MachineWorldMut<'_>,
        channels: &[i8; MAX_MACHINE_CHANNELS],
        dt: f32,
    ) {
        let mut state: RuntimeInputState = HashMap::new();
        for (idx, action) in self.action_channels.iter().enumerate() {
            if idx >= MAX_MACHINE_CHANNELS {
                break;
            }
            let raw = channels[idx] as f32 / 127.0;
            state.insert(action.clone(), RuntimeInputValue::Scalar(raw));
        }
        self.runtime.update_in_world(world, &state, dt);
    }

    /// Snapshot every body's pose + linear/angular velocity, in
    /// `body_ids()` order.
    pub fn snapshot_bodies(&self, bodies: &RigidBodySet) -> Vec<MachineBodySnapshot> {
        let mut out = Vec::with_capacity(self.body_ids.len());
        for (index, id) in self.body_ids.iter().enumerate() {
            let Some(handle) = self.runtime.body_handle(id) else {
                continue;
            };
            let Some(rb) = bodies.get(handle) else {
                continue;
            };
            let p = rb.translation();
            let r = rb.rotation();
            let lv = rb.linvel();
            let av = rb.angvel();
            out.push(MachineBodySnapshot {
                index: index as u16,
                position: [p.x, p.y, p.z],
                rotation: [r.i, r.j, r.k, r.w],
                linvel: [lv.x, lv.y, lv.z],
                angvel: [av.x, av.y, av.z],
            });
        }
        out
    }

    /// Convert every rigid-body owned by this machine to
    /// `KinematicPositionBased` and zero out linear + angular velocity.
    ///
    /// Used exclusively by the **client** wasm world (see
    /// `WasmSimWorld::spawn_snap_machine`). On the client, the server's
    /// `PhysicsArena` is the authoritative physics owner; the client
    /// wasm world only mirrors server snapshots via
    /// `apply_body_snapshot`. If the client bodies stayed dynamic, the
    /// dynamic-body proxy pipeline (`step_vehicle_pipeline`, triggered
    /// whenever balls or vehicles are nearby) would integrate machine
    /// bodies forward under gravity between snapshots, causing a
    /// tug-of-war with incoming server state that users see as a
    /// visible flicker between two poses. Flipping to
    /// `KinematicPositionBased` makes the integrator ignore these
    /// bodies — only explicit `set_position` / `apply_body_snapshot`
    /// calls move them — so the client renders a stable mirror of the
    /// authoritative server state.
    ///
    /// Safe to call on the server side too, but do NOT — the server
    /// needs dynamic bodies so the motor solver can actually drive the
    /// joints.
    pub fn freeze_to_kinematic(&self, bodies: &mut RigidBodySet) {
        for id in &self.body_ids {
            let Some(handle) = self.runtime.body_handle(id) else {
                continue;
            };
            let Some(rb) = bodies.get_mut(handle) else {
                continue;
            };
            rb.set_body_type(RigidBodyType::KinematicPositionBased, true);
            rb.set_linvel(Vector3::zeros(), false);
            rb.set_angvel(Vector3::zeros(), false);
        }
    }

    /// Restore dynamic bodies so [`Self::apply_input`] can integrate motors.
    /// Used by client wasm for the locally operated machine only.
    pub fn unfreeze_to_dynamic(&self, bodies: &mut RigidBodySet) {
        for id in &self.body_ids {
            let Some(handle) = self.runtime.body_handle(id) else {
                continue;
            };
            let Some(rb) = bodies.get_mut(handle) else {
                continue;
            };
            rb.set_body_type(RigidBodyType::Dynamic, true);
        }
    }

    /// Server → client reconcile: overwrite each body's pose/velocity from
    /// an authoritative snapshot. `bodies_by_index` is parallel to
    /// `body_ids()`.
    pub fn apply_body_snapshot(
        &mut self,
        bodies: &mut RigidBodySet,
        modified_colliders: &mut Vec<ColliderHandle>,
        snapshots: &[MachineBodySnapshot],
    ) {
        for snap in snapshots {
            let Some(id) = self.body_ids.get(snap.index as usize) else {
                continue;
            };
            let Some(handle) = self.runtime.body_handle(id) else {
                continue;
            };
            let Some(rb) = bodies.get_mut(handle) else {
                continue;
            };
            let iso = Isometry3::from_parts(
                Translation3::new(snap.position[0], snap.position[1], snap.position[2]),
                UnitQuaternion::from_quaternion(Quaternion::new(
                    snap.rotation[3],
                    snap.rotation[0],
                    snap.rotation[1],
                    snap.rotation[2],
                )),
            );
            rb.set_position(iso, true);
            rb.set_linvel(
                Vector3::new(snap.linvel[0], snap.linvel[1], snap.linvel[2]),
                true,
            );
            rb.set_angvel(
                Vector3::new(snap.angvel[0], snap.angvel[1], snap.angvel[2]),
                true,
            );
            for ch in rb.colliders() {
                modified_colliders.push(*ch);
            }
        }
    }

    /// Tear down all bodies/joints owned by this machine.
    pub fn remove(self, world: &mut MachineWorldRemove<'_>) {
        let _ = self.runtime.remove_from_world(world);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MachineBodySnapshot {
    pub index: u16,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub linvel: [f32; 3],
    pub angvel: [f32; 3],
}

/// Minimum collider Y in envelope-local coordinates across every body.
///
/// Computes a per-collider Y extent that is tight for axis-aligned
/// authoring (the common case — body origins and collider local
/// transforms default to identity rotations) and falls back to a loose
/// rotation-invariant bound under arbitrary rotation via
/// `|R[1,*]| · half_extents`. Exact for cylinders / capsules because we
/// use each collider's explicit `axis` hint to figure out which
/// dimension is the radial one before rotating.
fn envelope_min_y(plan: &MachinePlan) -> f32 {
    use snap_machines_rapier::{AxisName, ColliderKind};

    fn y_extent_after_rot(half: (f32, f32, f32), rot: UnitQuaternion<f32>) -> f32 {
        let m = rot.to_rotation_matrix();
        m[(1, 0)].abs() * half.0 + m[(1, 1)].abs() * half.1 + m[(1, 2)].abs() * half.2
    }

    fn quat_from_sm(q: SmQuat) -> UnitQuaternion<f32> {
        UnitQuaternion::from_quaternion(Quaternion::new(q.w, q.x, q.y, q.z))
    }

    let mut min_y = f32::INFINITY;
    for body in &plan.bodies {
        let body_rot = quat_from_sm(body.origin.rotation);
        let body_pos = Vector3::new(
            body.origin.position.x,
            body.origin.position.y,
            body.origin.position.z,
        );

        for col in &body.colliders {
            // Axis-aware half extents. Snap-machines' `local_shape_isometry`
            // rotates Y-aligned primitives into the declared axis at build
            // time, so the effective box the physics engine sees already
            // has its radial/height dimensions rearranged.
            let axis = col.axis.unwrap_or(AxisName::Y);
            let r = col.radius.unwrap_or(0.0);
            let hh = col.half_height.unwrap_or(0.0);
            let half = match col.kind {
                ColliderKind::Box => {
                    let h = col.half_extents.unwrap_or(SmVec3 { x: 0.0, y: 0.0, z: 0.0 });
                    (h.x, h.y, h.z)
                }
                ColliderKind::Sphere => (r, r, r),
                ColliderKind::Cylinder => match axis {
                    AxisName::Y => (r, hh, r),
                    AxisName::X => (hh, r, r),
                    AxisName::Z => (r, r, hh),
                },
                ColliderKind::Capsule => match axis {
                    AxisName::Y => (r, hh + r, r),
                    AxisName::X => (hh + r, r, r),
                    AxisName::Z => (r, r, hh + r),
                },
                _ => (0.1, 0.1, 0.1),
            };

            let stored_rot = quat_from_sm(col.local_transform.rotation);
            let full_rot = body_rot * stored_rot;
            let y_ext = y_extent_after_rot(half, full_rot);

            let col_local_pos = Vector3::new(
                col.local_transform.position.x,
                col.local_transform.position.y,
                col.local_transform.position.z,
            );
            let col_world = body_pos + body_rot * col_local_pos;
            let low = col_world.y - y_ext;
            if low < min_y {
                min_y = low;
            }
        }
    }
    if min_y.is_finite() { min_y } else { 0.0 }
}

/// Read `envelope.metadata.presetName` / `displayName` out of a raw
/// JSON envelope without deserializing the whole plan. Used by the
/// client HUD so it can show the name before a full install.
pub fn machine_display_name(envelope: &Value) -> Option<String> {
    envelope
        .get("metadata")?
        .as_object()?
        .get("presetName")
        .or_else(|| envelope.get("metadata")?.as_object()?.get("displayName"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

/// Single source of truth for the wire-format channel ordering. Both
/// server and client (and the Rust reference for the TS implementation in
/// `client/src/physics/machinePredictionManager.ts`) call this against the
/// same `MachinePlan` and get the same `Vec<String>` back.
///
/// Ordering rules (deterministic):
/// 1. Collect every `motor.input.action` from `plan.joints`.
/// 2. Collect every `behaviors[].input.action`.
/// 3. Deduplicate, sort lexicographically.
pub fn derive_action_channels(plan: &MachinePlan) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for joint in &plan.joints {
        if let Some(motor) = &joint.motor {
            if let Some(input) = &motor.input {
                set.insert(input.action.clone());
            }
        }
    }
    for behavior in &plan.behaviors {
        if let Some(input) = &behavior.input {
            set.insert(input.action.clone());
        }
    }
    set.into_iter().take(MAX_MACHINE_CHANNELS).collect()
}

/// Pre-transform every body origin in `plan` by `pose`, so installing the
/// plan places the whole machine at `pose` in world space.
fn retransform_plan_bodies(plan: &mut MachinePlan, pose: Isometry3<f32>) {
    for body in &mut plan.bodies {
        let local_iso = sm_transform_to_isometry(body.origin);
        let world_iso = pose * local_iso;
        body.origin = isometry_to_sm_transform(&world_iso);
    }
    // Joints carry local anchors (rigid-body local space), so they need no
    // adjustment — the body re-anchoring happens automatically because the
    // bodies themselves moved.
    let _ = plan_alias(plan);
}

// Small helper to keep the compiler happy that we touched `plan.joints` /
// `plan.behaviors` even though we didn't need to rewrite them.
fn plan_alias(_: &MachinePlan) -> Option<&MachineBodyPlan> {
    None
}

fn sm_transform_to_isometry(t: SmTransform) -> Isometry3<f32> {
    Isometry3::from_parts(
        Translation3::new(t.position.x, t.position.y, t.position.z),
        UnitQuaternion::from_quaternion(Quaternion::new(
            t.rotation.w,
            t.rotation.x,
            t.rotation.y,
            t.rotation.z,
        )),
    )
}

fn isometry_to_sm_transform(iso: &Isometry3<f32>) -> SmTransform {
    let q = iso.rotation.quaternion();
    SmTransform {
        position: SmVec3 {
            x: iso.translation.x,
            y: iso.translation.y,
            z: iso.translation.z,
        },
        rotation: SmQuat {
            x: q.i,
            y: q.j,
            z: q.k,
            w: q.w,
        },
    }
}

// Suppress unused-import warnings for items we re-export through the
// SnapMachine API surface above.
#[allow(dead_code)]
fn _force_imports_used(p: &MachineJointPlan, b: &MachineBehaviorPlan) -> JointKind {
    let _ = b;
    p.kind
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_arena::PhysicsArena;
    use crate::movement::MoveConfig;
    use crate::protocol::MachineChannels;

    const FOUR_WHEEL_CAR_ENVELOPE: &str =
        include_str!("../test-fixtures/4-wheel-car.envelope.json");

    fn spawn_test_car(arena: &mut PhysicsArena, spawn_y: f32) -> serde_json::Value {
        let envelope: serde_json::Value =
            serde_json::from_str(FOUR_WHEEL_CAR_ENVELOPE).expect("envelope parses");
        arena.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        arena
            .spawn_snap_machine_with_id(
                42,
                Vector3::new(0.0, spawn_y, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("spawns clean");
        arena.rebuild_broad_phase();
        envelope
    }

    fn chassis_y(arena: &PhysicsArena, machine_id: u32) -> f32 {
        arena
            .machines
            .get(&machine_id)
            .and_then(|m| m.machine.body_handle("body:0"))
            .and_then(|h| arena.dynamic.sim.rigid_bodies.get(h))
            .map(|rb| rb.translation().y)
            .expect("chassis body exists")
    }

    #[test]
    fn envelope_min_y_auto_shifts_floor_to_zero() {
        // The 4-wheel-car envelope authors body:0 at (0, 2, 0) with a
        // chassis that extends ~0.8 m below the body origin, so its
        // unshifted floor sits at envelope-y ≈ 1.19. After install the
        // first body should be at roughly `spawn_y + 0.81` (origin),
        // with the collider bottom almost exactly at `spawn_y`.
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let _envelope = spawn_test_car(&mut arena, 5.0);

        let body_y = chassis_y(&arena, 42);
        // The chassis origin is the old 2.0 minus the envelope min-y
        // (~1.19), so body center ends up at `spawn_y + ~0.81`. Allow a
        // generous window so the test is robust to small bounding-sphere
        // tweaks in `envelope_min_y`.
        assert!(
            (body_y - 5.0 - 0.81).abs() < 0.5,
            "expected chassis center near spawn_y + 0.81 after auto-shift, got {body_y:.3}"
        );
    }

    #[test]
    fn chassis_falls_under_gravity() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        // Spawn well above the static ground so the first physics tick
        // has no chance of immediately resting on anything. No driver,
        // no motor input — just gravity.
        let _envelope = spawn_test_car(&mut arena, 5.0);

        let y_start = chassis_y(&arena, 42);
        for _ in 0..15 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        let y_quarter_sec = chassis_y(&arena, 42);
        for _ in 0..45 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        let y_one_sec = chassis_y(&arena, 42);

        assert!(
            y_quarter_sec < y_start - 0.1,
            "chassis should fall within 0.25 s: start={y_start:.3}, after 0.25s={y_quarter_sec:.3}"
        );
        assert!(
            y_one_sec < y_quarter_sec,
            "chassis should keep falling: 0.25s={y_quarter_sec:.3}, 1.0s={y_one_sec:.3}"
        );
        assert!(
            y_one_sec < y_start - 0.5,
            "chassis should have fallen at least 0.5 m after 1 s: start={y_start:.3}, 1.0s={y_one_sec:.3}"
        );
    }

    #[test]
    fn chassis_settles_on_ground() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        // Ground is a 1-m-thick slab centred at y=-0.5 (top at y=0).
        let _envelope = spawn_test_car(&mut arena, 2.0);

        // Step enough ticks for suspension/wheels to settle.
        for _ in 0..240 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        let y_final = chassis_y(&arena, 42);

        // Chassis origin (center) ends up at roughly `wheel_radius +
        // chassis_half_height` above the ground. For the 4-wheel-car:
        //   wheel radius ≈ 0.8, chassis half-extents ≈ 0.5..0.8 around
        //   the origin → center settles around y ≈ 0.8..1.5.
        assert!(
            y_final > 0.1,
            "chassis should not tunnel below the ground: y_final={y_final:.3}"
        );
        assert!(
            y_final < 2.0,
            "chassis should have settled close to ground (below its 2 m spawn): y_final={y_final:.3}"
        );
    }

    /// End-to-end drivability: spawn a 4-wheel-car, attach a driver,
    /// hold `motorSpin` at maximum for 6 s, and assert the chassis
    /// has driven at least 3 m along the X/Z plane. This is the real
    /// check that `MOTOR_MAX_FORCE_MULTIPLIER` is tuned sensibly for
    /// vibe-land's stronger gravity — if a future change drops the
    /// multiplier too low, or breaks the driver→channel wiring, this
    /// test catches it before the live game does.
    #[test]
    fn chassis_drives_forward_under_motor_input() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let _envelope = spawn_test_car(&mut arena, 2.0);

        let action_channels = arena
            .machines
            .get(&42)
            .expect("machine present")
            .machine
            .action_channels()
            .to_vec();
        let motor_spin_idx = action_channels
            .iter()
            .position(|a| a == "motorSpin")
            .expect("4-wheel car exposes motorSpin action channel");

        // Grab the starting chassis XZ position.
        let start = arena
            .machines
            .get(&42)
            .and_then(|m| m.machine.body_handle("body:0"))
            .and_then(|h| arena.dynamic.sim.rigid_bodies.get(h))
            .map(|rb| *rb.translation())
            .expect("chassis body");
        let (start_x, start_z) = (start.x, start.z);

        // Spawn a driver *without* any motor input so the chassis can
        // settle onto its wheels cleanly. Only then flip motorSpin to
        // max — this isolates "driving distance" from "falling and
        // settling distance" and keeps the assert tight.
        arena.spawn_player(1);
        arena.enter_machine(1, 42);
        for _ in 0..60 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        if let Some(player) = arena.players.get_mut(&1) {
            let mut channels = MachineChannels::default();
            channels[motor_spin_idx] = 127;
            player.last_input.machine_channels = channels;
        }
        // Rapier lets dynamic bodies fall asleep after settling; the
        // motor constraint alone does not wake them, so force-wake
        // every machine body before the drive phase.
        for bid in ["body:0", "body:1", "body:2", "body:3", "body:4"] {
            if let Some(h) = arena
                .machines
                .get(&42)
                .and_then(|m| m.machine.body_handle(bid))
            {
                if let Some(rb) = arena.dynamic.sim.rigid_bodies.get_mut(h) {
                    rb.wake_up(true);
                }
            }
        }
        let settled = arena
            .machines
            .get(&42)
            .and_then(|m| m.machine.body_handle("body:0"))
            .and_then(|h| arena.dynamic.sim.rigid_bodies.get(h))
            .map(|rb| *rb.translation())
            .expect("chassis body");
        let (settled_x, settled_z) = (settled.x, settled.z);

        // Now drive for 6 more seconds.
        for _ in 0..360 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        let end = arena
            .machines
            .get(&42)
            .and_then(|m| m.machine.body_handle("body:0"))
            .and_then(|h| arena.dynamic.sim.rigid_bodies.get(h))
            .map(|rb| *rb.translation())
            .expect("chassis body");
        let (end_x, end_z) = (end.x, end.z);

        // Motion from settling is usually sub-metre; motion from
        // driving should be many metres. Use the settled pose as the
        // reference so we only measure the driving phase.
        let dist_driving = ((end_x - settled_x).powi(2) + (end_z - settled_z).powi(2)).sqrt();
        let dist_total = ((end_x - start_x).powi(2) + (end_z - start_z).powi(2)).sqrt();
        assert!(
            dist_driving >= 3.0,
            "chassis should drive at least 3 m during the 6 s input hold; \
             settled=({settled_x:.3},{settled_z:.3}) end=({end_x:.3},{end_z:.3}) \
             distance={dist_driving:.3} m (total from spawn={dist_total:.3} m)"
        );
    }

    #[test]
    fn crane_installs_and_reports_display_name() {
        let envelope: serde_json::Value = serde_json::from_str(CRANE_ENVELOPE).expect("crane parses");
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        arena
            .spawn_snap_machine_with_id(
                99,
                Vector3::new(0.0, 0.5, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("crane installs clean");
        arena.rebuild_broad_phase();

        let machine = arena.machines.get(&99).expect("crane in arena");
        assert_eq!(machine.machine.display_name(), Some("Crane"));
        // The crane fixture has `armPitch` and `armYaw` channels (confirmed
        // by inspecting the envelope). Order is alphabetical.
        assert_eq!(
            machine.machine.action_channels(),
            &["armPitch".to_string(), "armYaw".to_string()]
        );
    }

    /// End-to-end check that the crane's position-mode motors actually
    /// swing the arm when the operator holds `armPitch`. If this test
    /// fails, the damping / force multiplier tuning is probably
    /// breaking position-mode motors or the driver→channel wiring has
    /// regressed.
    #[test]
    fn crane_arm_swings_when_pitch_input_held() {
        let envelope: serde_json::Value =
            serde_json::from_str(CRANE_ENVELOPE).expect("crane parses");
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        arena
            .spawn_snap_machine_with_id(
                99,
                Vector3::new(0.0, 0.5, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("crane installs clean");
        arena.rebuild_broad_phase();

        // Pick the tip body (body:3 — the arm's far end). We don't know
        // the exact id ordering but the crane plan has bodies 0..3; the
        // tip is the heaviest at y ≈ 5 m.
        let tip_body = "body:3";
        let tip_handle = arena
            .machines
            .get(&99)
            .and_then(|m| m.machine.body_handle(tip_body))
            .expect("tip body present");

        let action_channels = arena
            .machines
            .get(&99)
            .expect("crane")
            .machine
            .action_channels()
            .to_vec();
        let pitch_idx = action_channels
            .iter()
            .position(|a| a == "armPitch")
            .expect("crane has armPitch");

        // Settle for a few ticks so the arm is at rest before we drive it.
        arena.spawn_player(1);
        arena.enter_machine(1, 99);
        for _ in 0..30 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        let start_pos = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(tip_handle)
            .expect("tip body")
            .translation();

        // Push armPitch full positive for 1 second.
        if let Some(player) = arena.players.get_mut(&1) {
            let mut channels = MachineChannels::default();
            channels[pitch_idx] = 127;
            player.last_input.machine_channels = channels;
        }
        // Wake bodies — position-mode motors don't wake sleeping bodies
        // on their own, matching the car driving case.
        for bid in ["body:0", "body:1", "body:2", "body:3"] {
            if let Some(h) = arena
                .machines
                .get(&99)
                .and_then(|m| m.machine.body_handle(bid))
            {
                if let Some(rb) = arena.dynamic.sim.rigid_bodies.get_mut(h) {
                    rb.wake_up(true);
                }
            }
        }
        for _ in 0..60 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }
        let end_pos = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(tip_handle)
            .expect("tip body after drive")
            .translation();

        let dx = end_pos.x - start_pos.x;
        let dy = end_pos.y - start_pos.y;
        let dz = end_pos.z - start_pos.z;
        let dist = (dx * dx + dy * dy + dz * dz).sqrt();
        assert!(
            dist > 0.25,
            "crane tip should have moved when armPitch is held: \
             start=({:.2},{:.2},{:.2}) end=({:.2},{:.2},{:.2}) dist={dist:.3}",
            start_pos.x, start_pos.y, start_pos.z,
            end_pos.x, end_pos.y, end_pos.z
        );
    }

    /// If you drive the built-in 4-wheel vehicle into a snap-machine, the
    /// snap machine's rigid-bodies should push back through contact
    /// instead of letting the vehicle tunnel through. This exercises
    /// `vehicle.chassis_collider` ↔ `machine_body.collider` pairing in
    /// the shared Rapier pipeline and catches any collision-group
    /// regression (the vehicle uses GROUP_1 with filter GROUP_1|GROUP_2
    /// while snap-machine colliders default to `Group::all()`).
    #[test]
    fn vehicle_collides_with_snap_machine() {
        let envelope: serde_json::Value =
            serde_json::from_str(FOUR_WHEEL_CAR_ENVELOPE).expect("parse car envelope");
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        // Parked snap machine at the origin.
        arena
            .spawn_snap_machine_with_id(
                99,
                Vector3::new(0.0, 0.2, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("snap-machine installs");
        // Vehicle starts 5 m in front of the snap-machine (the
        // vehicle's `forward_axis = 2` / +Z convention) with a large
        // initial linvel so the first few ticks of contact are all
        // that matter; we don't care about the long-term behaviour,
        // we just want a detectable shove on the machine when the
        // vehicle rams it.
        let vehicle_id = arena.spawn_vehicle_with_id(
            1,
            0,
            Vector3::new(0.0, 0.6, 5.0),
            [0.0, 0.0, 0.0, 1.0],
        );
        arena.rebuild_broad_phase();

        let chassis_body = arena
            .vehicles
            .get(&vehicle_id)
            .expect("vehicle in arena")
            .chassis_body;

        // Grab the snap-machine chassis (body:0) starting position.
        let sm_body0 = arena
            .machines
            .get(&99)
            .and_then(|m| m.machine.body_handle("body:0"))
            .expect("snap machine body:0");
        let sm_start = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(sm_body0)
            .expect("body:0")
            .translation();

        // Apply a single strong impulse to the chassis pointing
        // toward -Z (the vehicle's forward direction in the plan) so
        // we exercise the natural contact response when the vehicle
        // rams the parked machine. After that the simulation runs
        // free — no `set_linvel` override, so contact impulses can
        // decelerate the chassis normally.
        if let Some(rb) = arena.dynamic.sim.rigid_bodies.get_mut(chassis_body) {
            // 300 kg chassis × 12 m/s target = 3600 N·s impulse.
            rb.apply_impulse(Vector3::new(0.0, 0.0, -3600.0), true);
        }
        for _ in 0..90 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let vehicle_end = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(chassis_body)
            .expect("vehicle chassis")
            .translation();
        let sm_end = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(sm_body0)
            .expect("body:0 after collision")
            .translation();
        let sm_delta = (sm_end - sm_start).norm();

        // Two assertions together prove the contact actually resolved:
        //   1. The snap machine was shoved along the hit direction
        //      (sm_delta > 0.3 m) — it wasn't ignored entirely.
        //   2. The vehicle chassis did NOT pass through the machine —
        //      the vehicle's final Z is still in front of the
        //      machine's final Z (vehicle.z > snap.z + a small
        //      buffer). Without contact resolution the vehicle would
        //      have kept going and ended up several metres past.
        assert!(
            sm_delta > 0.3,
            "snap machine should have been shoved at least 0.3 m when the \
             vehicle rammed it, but sm_delta={sm_delta:.3}. \
             vehicle_end={vehicle_end:?} sm_end={sm_end:?}"
        );
        assert!(
            vehicle_end.z > sm_end.z,
            "vehicle should not have passed through the snap machine: \
             vehicle.z={:.3}, sm.z={:.3}",
            vehicle_end.z,
            sm_end.z,
        );
    }

    const CRANE_ENVELOPE: &str = include_str!("../test-fixtures/crane.envelope.json");


    #[test]
    fn snapshot_round_trips_through_apply_body_snapshot() {
        let envelope: serde_json::Value =
            serde_json::from_str(FOUR_WHEEL_CAR_ENVELOPE).expect("envelope parses");
        let mut arena_a = PhysicsArena::new(MoveConfig::default());
        arena_a.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        arena_a
            .spawn_snap_machine_with_id(
                7,
                Vector3::new(0.0, 2.0, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("spawn");
        arena_a.rebuild_broad_phase();

        // Step a bit so bodies have non-trivial poses.
        for _ in 0..30 {
            arena_a.step_dynamics(1.0 / 60.0);
        }
        let snapshot = arena_a.snapshot_machines();
        assert_eq!(snapshot.len(), 1);

        let mut arena_b = PhysicsArena::new(MoveConfig::default());
        arena_b.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        arena_b
            .spawn_snap_machine_with_id(
                7,
                Vector3::new(0.0, 2.0, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("spawn b");
        arena_b.rebuild_broad_phase();

        // Convert net states back to local body snapshots and apply.
        let body_snaps: Vec<MachineBodySnapshot> = snapshot[0]
            .bodies
            .iter()
            .map(|b| MachineBodySnapshot {
                index: b.index,
                position: [
                    b.px_mm as f32 / 1000.0,
                    b.py_mm as f32 / 1000.0,
                    b.pz_mm as f32 / 1000.0,
                ],
                rotation: [
                    b.qx_snorm as f32 / 32767.0,
                    b.qy_snorm as f32 / 32767.0,
                    b.qz_snorm as f32 / 32767.0,
                    b.qw_snorm as f32 / 32767.0,
                ],
                linvel: [
                    b.vx_cms as f32 / 100.0,
                    b.vy_cms as f32 / 100.0,
                    b.vz_cms as f32 / 100.0,
                ],
                angvel: [
                    b.wx_mrads as f32 / 1000.0,
                    b.wy_mrads as f32 / 1000.0,
                    b.wz_mrads as f32 / 1000.0,
                ],
            })
            .collect();
        arena_b.apply_machine_snapshot(7, &body_snaps);

        let snapshot_b = arena_b.snapshot_machines();
        assert_eq!(snapshot_b.len(), 1);
        // Body counts and indices should match exactly.
        assert_eq!(snapshot_b[0].bodies.len(), snapshot[0].bodies.len());
    }

    /// Regression for the practice-mode flicker bug: after
    /// `SnapMachine::freeze_to_kinematic`, the machine's rigid bodies
    /// must not drift under gravity even when the surrounding dynamics
    /// pipeline is stepped repeatedly. The client wasm world calls
    /// this inside `spawn_snap_machine` specifically so the
    /// dynamic-body proxy pipeline (`step_vehicle_pipeline`, triggered
    /// whenever balls / vehicles are nearby) does not tug-of-war with
    /// incoming authoritative snapshots from the server. If this ever
    /// regresses, the user sees the crane collapse and the car
    /// "shuffle" between two flickering poses in practice mode.
    #[test]
    fn freeze_to_kinematic_stops_bodies_from_drifting_under_gravity() {
        // Use PhysicsArena purely as a convenient Rapier-world host —
        // we are *not* calling `step_machines`, just `step_dynamics`,
        // to mimic the client wasm's `stepDynamics` → `step_vehicle_pipeline`
        // call chain that was causing the flicker.
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let _envelope = spawn_test_car(&mut arena, 5.0);

        // Capture the pose of every machine body immediately after
        // install, then freeze them.
        let machine_id = 42;
        let body_ids_and_start: Vec<(String, Vector3<f32>)> = {
            let machine = arena
                .machines
                .get(&machine_id)
                .expect("machine present");
            machine
                .machine
                .body_ids()
                .iter()
                .filter_map(|id| {
                    let handle = machine.machine.body_handle(id)?;
                    let rb = arena.dynamic.sim.rigid_bodies.get(handle)?;
                    Some((id.clone(), *rb.translation()))
                })
                .collect()
        };
        assert!(!body_ids_and_start.is_empty(), "car has at least one body");

        {
            let machine = arena
                .machines
                .get(&machine_id)
                .expect("machine present");
            machine
                .machine
                .freeze_to_kinematic(&mut arena.dynamic.sim.rigid_bodies);
        }

        // Step the dynamics pipeline for 2 s — exactly the scenario the
        // client wasm world was hitting under the old bug: dynamic
        // bodies nearby forced `step_vehicle_pipeline` to run every
        // proxy tick, which integrated the machine bodies forward
        // under gravity.
        for _ in 0..120 {
            arena.step_dynamics(1.0 / 60.0);
        }

        // Verify every body is still within 1 cm of its frozen pose.
        // Without the fix, the chassis would drop ≈ 40 m in 2 s under
        // vibe-land's `-20 m/s²` gravity, so this bound is far from
        // noisy.
        let body_ids: Vec<String> = body_ids_and_start.iter().map(|(id, _)| id.clone()).collect();
        for (body_id, start) in body_ids_and_start {
            let handle = arena
                .machines
                .get(&machine_id)
                .and_then(|m| m.machine.body_handle(&body_id))
                .unwrap_or_else(|| panic!("body {body_id} missing after freeze"));
            let rb = arena
                .dynamic
                .sim
                .rigid_bodies
                .get(handle)
                .unwrap_or_else(|| panic!("body {body_id} handle unresolved after freeze"));
            let now = *rb.translation();
            let drift = (now - start).norm();
            assert!(
                drift < 0.01,
                "kinematic-frozen body {body_id} drifted {drift:.4} m (start={start:?} \
                 now={now:?}); all body ids: {body_ids:?}"
            );
            assert_eq!(
                rb.body_type(),
                RigidBodyType::KinematicPositionBased,
                "body {body_id} should still be kinematic after stepping"
            );
            // Velocities should still read as zero — kinematic bodies
            // ignore linvel updates from the integrator.
            assert!(
                rb.linvel().norm() < 1e-4,
                "kinematic body {body_id} linvel should stay zero, got {:?}",
                rb.linvel()
            );
        }
    }

    /// After freezing, `apply_body_snapshot` must still be able to
    /// teleport every body to the incoming server pose. This is the
    /// path that keeps the client wasm's rendered machine synced to
    /// the authoritative `LocalPreviewSession` or remote server.
    #[test]
    fn apply_body_snapshot_still_teleports_frozen_bodies() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let _envelope = spawn_test_car(&mut arena, 5.0);

        {
            let machine = arena.machines.get(&42).expect("machine present");
            machine
                .machine
                .freeze_to_kinematic(&mut arena.dynamic.sim.rigid_bodies);
        }

        // Build a synthetic snapshot that translates body:0 by 10 m.
        let body0_handle = arena
            .machines
            .get(&42)
            .and_then(|m| m.machine.body_handle("body:0"))
            .expect("body:0");
        let before = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(body0_handle)
            .expect("body:0")
            .translation();
        let target = MachineBodySnapshot {
            index: 0,
            position: [before.x + 10.0, before.y, before.z],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linvel: [0.0, 0.0, 0.0],
            angvel: [0.0, 0.0, 0.0],
        };

        let mut modified = Vec::new();
        {
            let machine = arena.machines.get_mut(&42).expect("machine present");
            machine.machine.apply_body_snapshot(
                &mut arena.dynamic.sim.rigid_bodies,
                &mut modified,
                &[target],
            );
        }

        let after = *arena
            .dynamic
            .sim
            .rigid_bodies
            .get(body0_handle)
            .expect("body:0 after snapshot")
            .translation();
        assert!(
            (after.x - (before.x + 10.0)).abs() < 1e-4,
            "expected body:0 to teleport +10 m in X after snapshot, before={before:?} after={after:?}"
        );
    }
}
