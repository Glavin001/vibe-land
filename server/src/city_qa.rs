//! A scenario runner for the native destruction city, driven by a script.
//!
//! Exists because every hard bug in this backend was found by playing, and
//! every one of them was invisible to the tests that were supposed to catch it.
//! Shots that reached nothing still produced excellent frame times. Aim written
//! as coordinates stopped being right the moment a spawn moved, and nothing
//! said so. A projectile can be perfectly correct on the server and invisible
//! in the browser. So this drives the real entry points -- the same player
//! tick, the same shot routing, the same arena step production uses -- and
//! makes every step state what it expected and what it got.
//!
//! The scenario is a line-based script so a change of plan is a change of text,
//! not a rebuild. Run it through `scripts/qa.sh`.
//!
//! ```text
//! walk 60 1 0            # ticks, forward (-1..1), strafe (-1..1)
//! aim 0 1234             # face structure 0, chunk 1234
//! verify-aim 0 1234      # fail unless a ray from the eye reaches that chunk
//! fire ball              # or: fire rifle
//! wait 90
//! expect-detached 0 1234 # that chunk must have changed owner, i.e. come off
//! expect-bonds 1         # at least this many bonds broken since the last check
//! probe                  # name whichever chunk the current aim reaches
//! report                 # a stats line
//! ```

use std::fmt::Write as _;

use glam::Vec3;
use vibe_land_shared::constants::{BTN_FORWARD, BTN_BACK, BTN_LEFT, BTN_RIGHT, PLAYER_EYE_HEIGHT_M};
use vibe_land_shared::protocol::InputCmd;

/// What one scenario step did, in the caller's words and the world's.
pub struct StepOutcome {
    pub line: usize,
    pub command: String,
    pub ok: bool,
    pub detail: String,
}

/// Everything the run observed, so a failure reads as a report rather than a
/// panic message.
pub struct QaReport {
    pub steps: Vec<StepOutcome>,
    pub ticks: u32,
    pub broken_bonds: u32,
    pub chunk_bodies: u32,
    pub awake_bodies: u32,
    pub tick_ms_mean: f64,
    pub tick_ms_max: f64,
}

impl QaReport {
    pub fn failed(&self) -> bool {
        self.steps.iter().any(|step| !step.ok)
    }

    /// One line per step, then a summary. Deliberately plain text: the point is
    /// that a failure is readable without another tool.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for step in &self.steps {
            let mark = if step.ok { "ok  " } else { "FAIL" };
            let _ = writeln!(out, "  {mark} line {:<3} {:<28} {}", step.line, step.command, step.detail);
        }
        let _ = writeln!(
            out,
            "  -- {} ticks | {} bonds broken | {} bodies ({} awake) | tick mean {:.2} ms max {:.2} ms",
            self.ticks, self.broken_bonds, self.chunk_bodies, self.awake_bodies,
            self.tick_ms_mean, self.tick_ms_max
        );
        out
    }
}

/// Aim angles that point the eye at a world position.
///
/// Matches the client's own aimDirectionFromAngles convention, so a scenario
/// aims the way a player does rather than through a private shortcut that
/// could agree with nothing.
pub fn look_angles_at(eye: Vec3, target: Vec3) -> (f32, f32) {
    let to = target - eye;
    let flat = (to.x * to.x + to.z * to.z).sqrt();
    (to.x.atan2(-to.z), to.y.atan2(flat.max(1.0e-6)))
}

pub fn aim_direction(yaw: f32, pitch: f32) -> Vec3 {
    Vec3::new(
        yaw.sin() * pitch.cos(),
        pitch.sin(),
        -yaw.cos() * pitch.cos(),
    )
    .normalize_or_zero()
}

/// One parsed scenario step.
pub enum Step {
    Walk { ticks: u32, forward: f32, strafe: f32 },
    Look { yaw: f32, pitch: f32 },
    Aim { structure: u32, node: u32 },
    VerifyAim { structure: u32, node: u32 },
    Fire { ball: bool },
    Wait { ticks: u32 },
    ExpectDetached { structure: u32, node: u32 },
    ExpectBonds { at_least: u32 },
    /// Report whichever chunk the current aim reaches. How you find a target
    /// id without guessing at one.
    Probe,
    Report,
}

pub fn parse(script: &str) -> Result<Vec<(usize, String, Step)>, String> {
    let mut steps = Vec::new();
    for (index, raw) in script.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        let number = |i: usize| -> Result<f32, String> {
            parts
                .get(i)
                .ok_or_else(|| format!("line {}: '{}' needs more arguments", index + 1, parts[0]))?
                .parse::<f32>()
                .map_err(|_| format!("line {}: '{}' is not a number", index + 1, parts[i]))
        };
        let count = |i: usize| -> Result<u32, String> { number(i).map(|v| v as u32) };
        let step = match parts[0] {
            "walk" => Step::Walk { ticks: count(1)?, forward: number(2)?, strafe: number(3)? },
            "look" => Step::Look { yaw: number(1)?, pitch: number(2)? },
            "aim" => Step::Aim { structure: count(1)?, node: count(2)? },
            "verify-aim" => Step::VerifyAim { structure: count(1)?, node: count(2)? },
            "fire" => Step::Fire { ball: parts.get(1).copied().unwrap_or("rifle") == "ball" },
            "wait" => Step::Wait { ticks: count(1)? },
            "expect-detached" => Step::ExpectDetached { structure: count(1)?, node: count(2)? },
            "expect-bonds" => Step::ExpectBonds { at_least: count(1)? },
            "probe" => Step::Probe,
            "report" => Step::Report,
            other => return Err(format!("line {}: unknown command '{other}'", index + 1)),
        };
        steps.push((index + 1, line.to_string(), step));
    }
    Ok(steps)
}

/// Buttons for a walk step. move_x/move_y carry the analogue amount; the
/// buttons carry the same intent, because the server's movement reads both.
pub fn walk_input(seq: u16, yaw: f32, pitch: f32, forward: f32, strafe: f32) -> InputCmd {
    let mut buttons = 0u16;
    if forward > 0.05 {
        buttons |= BTN_FORWARD;
    } else if forward < -0.05 {
        buttons |= BTN_BACK;
    }
    if strafe > 0.05 {
        buttons |= BTN_RIGHT;
    } else if strafe < -0.05 {
        buttons |= BTN_LEFT;
    }
    InputCmd {
        seq,
        buttons,
        move_x: (strafe.clamp(-1.0, 1.0) * 127.0) as i8,
        move_y: (forward.clamp(-1.0, 1.0) * 127.0) as i8,
        yaw,
        pitch,
    }
}

/// Eye position for a player standing at `feet`.
pub fn eye_of(feet: vibe_netcode::movement::Vec3d) -> Vec3 {
    Vec3::new(
        feet.x as f32,
        feet.y as f32 + PLAYER_EYE_HEIGHT_M,
        feet.z as f32,
    )
}
