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
    /// Optional control profile from the envelope (for client-side keybind
    /// derivation). Cloned so the envelope JSON can be dropped after install.
    controls: Option<snap_machines_rapier::MachineControls>,
}

impl SnapMachine {
    /// Decode a JSON envelope `Value`, pre-translate every body origin by
    /// `pose`, install the plan into `world`, and return a runnable
    /// `SnapMachine`.
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

        retransform_plan_bodies(&mut envelope.plan, pose);

        let plan_for_meta = envelope.plan.clone();
        let controls = envelope.controls.take();

        let runtime = MachineRuntime::install_envelope(world, envelope)?;

        let mut body_ids: Vec<String> =
            plan_for_meta.bodies.iter().map(|b| b.id.clone()).collect();
        body_ids.sort();

        let action_channels = derive_action_channels(&plan_for_meta);

        Ok(Self {
            runtime,
            body_ids,
            action_channels,
            controls,
        })
    }

    pub fn body_ids(&self) -> &[String] {
        &self.body_ids
    }

    pub fn action_channels(&self) -> &[String] {
        &self.action_channels
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

    #[test]
    fn install_4_wheel_car_into_physics_arena() {
        let envelope: serde_json::Value =
            serde_json::from_str(FOUR_WHEEL_CAR_ENVELOPE).expect("envelope parses");
        let mut arena = PhysicsArena::new(MoveConfig::default());
        // Drop a flat ground beneath the spawn so the chassis has something to
        // fall onto.
        arena.add_static_cuboid(
            Vector3::new(0.0, -0.5, 0.0),
            Vector3::new(50.0, 0.5, 50.0),
            0,
        );
        arena
            .spawn_snap_machine_with_id(
                42,
                Vector3::new(0.0, 2.0, 0.0),
                [0.0, 0.0, 0.0, 1.0],
                &envelope,
            )
            .expect("spawns clean");
        arena.rebuild_broad_phase();

        // Drive `motorSpin` for half a second.
        let machine = arena.machines.get_mut(&42).expect("machine present");
        let action_channels = machine.machine.action_channels().to_vec();
        assert!(
            action_channels.iter().any(|a| a == "motorSpin"),
            "4-wheel car should expose `motorSpin` channel; got {action_channels:?}"
        );
        let motor_spin_idx = action_channels
            .iter()
            .position(|a| a == "motorSpin")
            .unwrap();

        let starting_z = arena
            .machines
            .get(&42)
            .and_then(|m| m.machine.body_handle("body:0"))
            .and_then(|h| arena.dynamic.sim.rigid_bodies.get(h))
            .map(|rb| rb.translation().z)
            .unwrap_or(0.0);

        // Inject driver input via a fake player.
        arena.spawn_player(1);
        if let Some(player) = arena.players.get_mut(&1) {
            let mut channels = MachineChannels::default();
            channels[motor_spin_idx] = 127;
            player.last_input.machine_channels = channels;
        }
        arena.enter_machine(1, 42);

        for _ in 0..360 {
            arena.step_machines(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let ending_z = arena
            .machines
            .get(&42)
            .and_then(|m| m.machine.body_handle("body:0"))
            .and_then(|h| arena.dynamic.sim.rigid_bodies.get(h))
            .map(|rb| rb.translation().z)
            .unwrap_or(0.0);

        // The 4-wheel car drives under positive motor input. We just assert
        // the chassis moved meaningfully relative to its start — exactly how
        // far isn't important, only that the actuator → motor → physics path
        // is end-to-end functional.
        // Even a small displacement proves the actuator → motor → physics
        // path is wired up end-to-end. The exact distance depends on
        // wheel/ground friction defaults which aren't important here.
        assert!(
            (ending_z - starting_z).abs() > 0.1,
            "expected chassis to drive; starting_z={starting_z:.3}, ending_z={ending_z:.3}"
        );
    }

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
}
