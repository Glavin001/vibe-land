//! Deterministic default key-binding table for snap-machine action
//! channels, plus an envelope-aware override resolver.
//!
//! Mirrors the upstream table at
//! `snap-machines/packages/snap-machines/src/control-map.ts:120` so a
//! server that never touched TypeScript and a client built against our
//! vendored rust crate agree on what "motorSpin" means in terms of keys.
//!
//! The loader for each snap-machine in `GameWorld.tsx` calls
//! [`derive_machine_bindings`] on enter, which:
//!
//! 1. Prefers `envelope.controls.profiles[0].bindings` if the envelope
//!    ships an explicit keyboard profile (the upstream snap-machines
//!    editor writes this for authored worlds).
//! 2. Otherwise iterates the envelope's `derive_action_channels` list
//!    and looks up each action in the default table below.

use crate::snap_machine::derive_action_channels;
use serde_json::Value;
use snap_machines_rapier::SerializedMachineEnvelope;

/// One player-facing binding for a single named action channel.
#[derive(Clone, Debug, PartialEq)]
pub struct MachineBinding {
    pub action: String,
    /// DOM `KeyboardEvent.code` for the positive key (drives channel
    /// toward `+scale`).
    pub pos_key: String,
    /// Optional DOM code for the negative key (drives channel toward
    /// `-scale`). `None` for trigger-only actions like `throttle`.
    pub neg_key: Option<String>,
    /// Multiplier applied to the raw `+1/-1` reading. Passed to the
    /// snap-machines runtime via the input-binding scale. The envelope
    /// version is authoritative when present.
    pub scale: f32,
}

/// Default key pair for a snap-machines action name. Mirrors
/// `DEFAULT_KEY_MAP` in the upstream library. `neg_key: None` means
/// this action is trigger-only (press to apply positive input).
pub fn default_action_key(action: &str) -> (&'static str, Option<&'static str>) {
    match action {
        // Velocity-mode drives: E forward, Q reverse.
        "motorSpin" | "hingeSpin" | "sliderPos" => ("KeyE", Some("KeyQ")),
        // Position-mode arm joints: W/S pitch (up/down), D/A yaw
        // (right/left). Matches snap-machines upstream DEFAULT_KEY_MAP.
        "armPitch" | "flapDeflect" => ("KeyW", Some("KeyS")),
        "armYaw" => ("KeyD", Some("KeyA")),
        // Per-joint disambiguation suffixes — used by the crane
        // fixture so the shoulder / elbow joints are controllable
        // independently instead of ganging onto one action channel.
        // Mapped to distinct key pairs so every joint has a unique
        // key binding (user requirement).
        "armPitchElbow" => ("KeyR", Some("KeyF")),
        "armYawTurret" => ("KeyD", Some("KeyA")),
        // Trigger actions fire on hold — no negative pair.
        "throttle" | "propellerSpin" => ("Space", None),
        "gripperClose" => ("KeyG", None),
        // Unknown action: fall back to the most common drive pair so
        // the HUD still renders a reasonable keycap.
        _ => ("KeyE", Some("KeyQ")),
    }
}

/// Build the player-facing binding list for a given envelope. Prefers
/// `envelope.controls.profiles[0].bindings` when present, otherwise
/// generates one binding per action channel from the default table.
pub fn derive_machine_bindings(envelope: &Value) -> Vec<MachineBinding> {
    // First try: the authored envelope controls block. Round-trip the
    // subset we need via `SerializedMachineEnvelope` so we can reuse
    // the same Serde shapes snap-machines-rapier already defines,
    // instead of hand-rolling JSON walkers.
    let parsed: Result<SerializedMachineEnvelope, _> =
        serde_json::from_value(envelope.clone());
    if let Ok(parsed) = parsed {
        if let Some(bindings) = bindings_from_controls_block(&parsed) {
            return bindings;
        }
        // Fall back to default keys for every action channel.
        return derive_action_channels(&parsed.plan)
            .into_iter()
            .map(|action| binding_from_defaults(action, 1.0))
            .collect();
    }
    Vec::new()
}

fn binding_from_defaults(action: String, scale: f32) -> MachineBinding {
    let (pos_key, neg_key) = default_action_key(&action);
    MachineBinding {
        action,
        pos_key: pos_key.to_owned(),
        neg_key: neg_key.map(str::to_owned),
        scale,
    }
}

/// Walk `envelope.controls.profiles[0].bindings` and convert each entry
/// to a [`MachineBinding`]. Each upstream binding targets a joint or
/// behavior id rather than an action name, so we look up the action
/// name via the plan's joint/behavior motor input definition.
fn bindings_from_controls_block(
    envelope: &SerializedMachineEnvelope,
) -> Option<Vec<MachineBinding>> {
    use snap_machines_rapier::{
        MachineControlProfileKind, MachineControlTargetKind,
    };
    let controls = envelope.controls.as_ref()?;
    let profile = controls
        .profiles
        .iter()
        .find(|p| p.id == controls.default_profile_id)
        .or_else(|| controls.profiles.first())?;
    if profile.kind != MachineControlProfileKind::Keyboard {
        return None;
    }

    // Collect the action for each binding target by looking it up in
    // the plan. Envelope targets point at joint / behavior ids, not
    // the action string, so we need the plan to resolve them.
    let mut out = Vec::new();
    for binding in &profile.bindings {
        if !binding.enabled {
            continue;
        }
        let action = match binding.target.kind {
            MachineControlTargetKind::Joint => envelope
                .plan
                .joints
                .iter()
                .find(|j| j.id == binding.target.id)
                .and_then(|j| j.motor.as_ref()?.input.as_ref().map(|i| i.action.clone())),
            MachineControlTargetKind::Behavior => envelope
                .plan
                .behaviors
                .iter()
                .find(|b| b.id == binding.target.id)
                .and_then(|b| b.input.as_ref().map(|i| i.action.clone())),
        };
        let Some(action) = action else {
            continue;
        };
        out.push(MachineBinding {
            action,
            pos_key: binding.positive.code.clone(),
            neg_key: binding.negative.as_ref().map(|k| k.code.clone()),
            scale: binding.scale,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRANE_ENVELOPE: &str = include_str!("../test-fixtures/crane.envelope.json");
    const FOUR_WHEEL_CAR_ENVELOPE: &str =
        include_str!("../test-fixtures/4-wheel-car.envelope.json");

    #[test]
    fn default_map_covers_every_snap_machines_default_action() {
        // Parity with the upstream DEFAULT_KEY_MAP at
        // `snap-machines/packages/snap-machines/src/control-map.ts`.
        let cases: &[(&str, (&str, Option<&str>))] = &[
            ("motorSpin", ("KeyE", Some("KeyQ"))),
            ("hingeSpin", ("KeyE", Some("KeyQ"))),
            ("sliderPos", ("KeyE", Some("KeyQ"))),
            ("armPitch", ("KeyW", Some("KeyS"))),
            ("flapDeflect", ("KeyW", Some("KeyS"))),
            ("armYaw", ("KeyD", Some("KeyA"))),
            ("throttle", ("Space", None)),
            ("propellerSpin", ("Space", None)),
            ("gripperClose", ("KeyG", None)),
        ];
        for (action, expected) in cases {
            assert_eq!(
                default_action_key(action),
                *expected,
                "default mapping drift for action `{action}`"
            );
        }
    }

    #[test]
    fn car_bindings_map_motor_spin_to_q_e() {
        let envelope: Value =
            serde_json::from_str(FOUR_WHEEL_CAR_ENVELOPE).expect("car envelope parses");
        let bindings = derive_machine_bindings(&envelope);
        assert_eq!(bindings.len(), 1, "car has one actuator channel");
        let b = &bindings[0];
        assert_eq!(b.action, "motorSpin");
        assert_eq!(b.pos_key, "KeyE");
        assert_eq!(b.neg_key.as_deref(), Some("KeyQ"));
    }

    #[test]
    fn crane_bindings_fall_back_to_defaults() {
        // The shipped crane envelope has no `controls` block, so
        // `derive_machine_bindings` should synthesize W/S + D/A from
        // the default table.
        let envelope: Value =
            serde_json::from_str(CRANE_ENVELOPE).expect("crane envelope parses");
        let bindings = derive_machine_bindings(&envelope);
        assert_eq!(bindings.len(), 2, "crane has armPitch + armYaw");
        let by_action: std::collections::HashMap<_, _> =
            bindings.iter().map(|b| (b.action.as_str(), b)).collect();
        let pitch = by_action.get("armPitch").expect("armPitch binding");
        assert_eq!(pitch.pos_key, "KeyW");
        assert_eq!(pitch.neg_key.as_deref(), Some("KeyS"));
        let yaw = by_action.get("armYaw").expect("armYaw binding");
        assert_eq!(yaw.pos_key, "KeyD");
        assert_eq!(yaw.neg_key.as_deref(), Some("KeyA"));
    }

    #[test]
    fn envelope_controls_block_overrides_defaults() {
        // Synthesize a minimal envelope with a single joint that has a
        // motor driven by a made-up action + a controls block that
        // binds that action to an unusual key pair. Assert the
        // envelope binding wins over the default fallback.
        let envelope: Value = serde_json::from_str(
            r#"{
              "schemaVersion": 2,
              "catalogVersion": "test",
              "plan": {
                "bodies": [
                  {
                    "id": "body:0",
                    "kind": "fixed",
                    "origin": {"position": {"x":0,"y":0,"z":0},"rotation": {"w":1,"x":0,"y":0,"z":0}},
                    "sourceBlocks": [],
                    "sourceParts": [],
                    "colliders": []
                  },
                  {
                    "id": "body:1",
                    "kind": "dynamic",
                    "origin": {"position": {"x":0,"y":0,"z":0},"rotation": {"w":1,"x":0,"y":0,"z":0}},
                    "sourceBlocks": [],
                    "sourceParts": [],
                    "colliders": []
                  }
                ],
                "joints": [
                  {
                    "id": "joint:a",
                    "blockId": "b",
                    "kind": "revolute",
                    "bodyAId": "body:0",
                    "bodyBId": "body:1",
                    "localAnchorA": {"x":0,"y":0,"z":0},
                    "localAnchorB": {"x":0,"y":0,"z":0},
                    "localAxisA": {"x":0,"y":0,"z":1},
                    "collideConnected": false,
                    "motor": {
                      "mode": "velocity",
                      "targetPosition": 0,
                      "targetVelocity": 0,
                      "stiffness": 0,
                      "damping": 1,
                      "maxForce": 10,
                      "input": {"action": "customAction", "scale": 2},
                      "inputTarget": "velocity"
                    }
                  }
                ],
                "mounts": [],
                "behaviors": [],
                "diagnostics": []
              },
              "controls": {
                "defaultProfileId": "kbd",
                "profiles": [
                  {
                    "id": "kbd",
                    "kind": "keyboard",
                    "bindings": [
                      {
                        "target": {"id": "joint:a", "kind": "joint"},
                        "positive": {"code": "KeyZ"},
                        "negative": {"code": "KeyX"},
                        "enabled": true,
                        "scale": 7
                      }
                    ]
                  }
                ]
              }
            }"#,
        )
        .expect("synthetic envelope parses");

        let bindings = derive_machine_bindings(&envelope);
        assert_eq!(bindings.len(), 1);
        let b = &bindings[0];
        assert_eq!(b.action, "customAction");
        // Envelope wins over the default `customAction → KeyE/KeyQ`.
        assert_eq!(b.pos_key, "KeyZ");
        assert_eq!(b.neg_key.as_deref(), Some("KeyX"));
        assert!((b.scale - 7.0).abs() < f32::EPSILON);
    }
}
