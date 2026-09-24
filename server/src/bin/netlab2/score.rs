//! Scoring: what the client stage says the production client drew, against
//! the frozen truth it was drawn from.
//!
//! Two references per displayed entity per frame:
//!
//! - **at render time** -- truth interpolated at the server time the client
//!   says it is drawing (`renderUs`, or `dynRenderUs` for bodies). This is
//!   the interpolation/extrapolation error: zero for a client that draws the
//!   past exactly, whatever its delay.
//! - **now** -- truth at the tick the server had actually reached at that
//!   frame's wall time. The difference between the two is the latency the
//!   player sees; this one is what a viewer comparing screens would see.
//!
//! Entities are classified from truth kinematics (body classes) or by type,
//! and every metric is reported per class. City chunks are scored by the
//! existing destruction scorer (`vibe_land_destruction::netlab::score`) on
//! the VLPRES01 stream, chunk-weighted, unchanged.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

use crate::bundle::Bundle;
use crate::report::Pct;
use crate::session_capture::TickTruth;
use crate::StreamReport;

pub const KIND_PLAYER: u8 = 1;
pub const KIND_VEHICLE: u8 = 2;
pub const KIND_BODY: u8 = 3;
pub const KIND_METEOR: u8 = 4;
pub const FLAG_SAMPLED: u8 = 1;

/// Body class thresholds (truth kinematics).
pub const REST_SPEED_MPS: f32 = 0.05;
pub const REST_ANGULAR_RADPS: f32 = 0.05;
/// A resting body that moves faster than this within the lookahead is
/// "about to move".
pub const TRANSITION_SPEED_MPS: f32 = 0.5;
pub const TRANSITION_LOOKAHEAD_TICKS: u32 = 30;
pub const FAST_PROJECTILE_MPS: f32 = 20.0;
/// Free flight: acceleration within this of gravity.
pub const BALLISTIC_ACCEL_TOLERANCE: f32 = 3.0;
pub const GRAVITY: f32 = 9.81;

/// Artifact gate thresholds.
pub const FREEZE_TRUTH_MOVE_M: f32 = 0.05;
pub const FREEZE_SHOWN_MOVE_M: f32 = 0.001;
pub const REVERSAL_MIN_M: f32 = 0.05;
pub const SNAP_MIN_M: f32 = 0.5;
pub const SNAP_RATIO: f32 = 3.0;
pub const TELEPORT_M: f32 = 5.0;
pub const OVERSHOOT_M: f32 = 1.0;

// ── displayed stream reader ─────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct Entity {
    pub kind: u8,
    pub flags: u8,
    pub id: u32,
    pub position: [f32; 3],
    pub quaternion: [f32; 4],
    pub age_ms: f32,
}

#[derive(Clone, Debug, Default)]
pub struct DisplayFrame {
    /// The recorded frame time (clock probe), page clock ms.
    pub t_ms: f64,
    /// When the frame's entities were drawn, page clock ms.
    pub sample_ms: f64,
    pub offset_us: f64,
    pub interp_delay_ms: f32,
    pub dyn_delay_ms: f32,
    pub render_us: f64,
    pub dyn_render_us: f64,
    pub entities: Vec<Entity>,
}

pub struct Display {
    pub header: serde_json::Value,
    pub frames: Vec<DisplayFrame>,
}

pub const FRAME_HEADER_BYTES: usize = 52;
pub const ENTITY_BYTES: usize = 38;

pub fn parse_display(bytes: &[u8]) -> std::io::Result<Display> {
    if bytes.len() < 12 || &bytes[..8] != b"VLDISP01" {
        return Err(std::io::Error::other("not a VLDISP01 stream"));
    }
    let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let header = serde_json::from_slice(&bytes[12..12 + header_len])?;
    let mut at = 12 + header_len;
    let f64_at = |b: &[u8], o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let mut frames = Vec::new();
    while at + FRAME_HEADER_BYTES <= bytes.len() {
        let b = &bytes[at..];
        let n = u32::from_le_bytes(b[48..52].try_into().unwrap()) as usize;
        if FRAME_HEADER_BYTES + n * ENTITY_BYTES > b.len() {
            break;
        }
        let mut frame = DisplayFrame {
            t_ms: f64_at(b, 0),
            sample_ms: f64_at(b, 8),
            offset_us: f64_at(b, 16),
            interp_delay_ms: f32_at(b, 24),
            dyn_delay_ms: f32_at(b, 28),
            render_us: f64_at(b, 32),
            dyn_render_us: f64_at(b, 40),
            entities: Vec::with_capacity(n),
        };
        let mut e = FRAME_HEADER_BYTES;
        for _ in 0..n {
            frame.entities.push(Entity {
                kind: b[e],
                flags: b[e + 1],
                id: u32::from_le_bytes(b[e + 2..e + 6].try_into().unwrap()),
                position: [f32_at(b, e + 6), f32_at(b, e + 10), f32_at(b, e + 14)],
                quaternion: [f32_at(b, e + 18), f32_at(b, e + 22), f32_at(b, e + 26), f32_at(b, e + 30)],
                age_ms: f32_at(b, e + 34),
            });
            e += ENTITY_BYTES;
        }
        at += e;
        frames.push(frame);
    }
    Ok(Display { header, frames })
}

pub fn read_display(path: &Path) -> std::io::Result<Display> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.read_to_end(&mut bytes)?;
    parse_display(&bytes).map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))
}

// ── truth access ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct TruthPose {
    pub position: Vec3,
    pub rotation: Quat,
    pub velocity: Vec3,
}

/// Where the lab looks up truth: by tick. `Bundle` implements it; tests use
/// a synthetic world.
pub trait TruthSource {
    fn tick(&self, tick: u32) -> Option<&TickTruth>;
    fn sim_hz(&self) -> u32;
    /// First and last captured tick.
    fn window(&self) -> (u32, u32);
}

impl TruthSource for Bundle {
    fn tick(&self, tick: u32) -> Option<&TickTruth> {
        self.truth(tick)
    }
    fn sim_hz(&self) -> u32 {
        self.sim_hz
    }
    fn window(&self) -> (u32, u32) {
        (self.first_tick(), self.last_tick())
    }
}

fn pose_at_tick(tick: &TickTruth, kind: u8, id: u32) -> Option<TruthPose> {
    match kind {
        KIND_PLAYER => tick.players.iter().find(|p| p.id == id).map(|p| TruthPose {
            position: Vec3::from_array(p.position),
            rotation: Quat::IDENTITY,
            velocity: Vec3::from_array(p.velocity),
        }),
        // The client keys vehicles by their snapshot handle, not the server id.
        KIND_VEHICLE => tick.vehicles.iter().find(|v| u32::from(v.handle) == id).map(|v| TruthPose {
            position: Vec3::from_array(v.position),
            rotation: Quat::from_array(v.rotation).normalize(),
            velocity: Vec3::from_array(v.velocity),
        }),
        _ => tick.bodies.iter().find(|b| b.id == id).map(|b| TruthPose {
            position: Vec3::from_array(b.position),
            rotation: Quat::from_array(b.rotation).normalize(),
            velocity: Vec3::from_array(b.velocity),
        }),
    }
}

/// Truth at a server time (us), interpolated between the ticks around it.
pub fn truth_at_server_us<T: TruthSource>(truth: &T, kind: u8, id: u32, server_us: f64) -> Option<TruthPose> {
    let tick_us = 1e6 / f64::from(truth.sim_hz());
    let tick_f = server_us / tick_us;
    if !tick_f.is_finite() || tick_f < 0.0 {
        return None;
    }
    let t0 = tick_f.floor() as u32;
    let frac = (tick_f - f64::from(t0)) as f32;
    let a = truth.tick(t0).and_then(|t| pose_at_tick(t, kind, id));
    let b = truth.tick(t0 + 1).and_then(|t| pose_at_tick(t, kind, id));
    match (a, b) {
        (Some(a), Some(b)) => Some(TruthPose {
            position: a.position.lerp(b.position, frac),
            rotation: a.rotation.slerp(b.rotation, frac),
            velocity: a.velocity.lerp(b.velocity, frac),
        }),
        (Some(a), None) if frac < 0.5 => Some(a),
        (None, Some(b)) if frac >= 0.5 => Some(b),
        _ => None,
    }
}

pub fn truth_at_tick<T: TruthSource>(truth: &T, kind: u8, id: u32, tick: u32) -> Option<TruthPose> {
    truth.tick(tick).and_then(|t| pose_at_tick(t, kind, id))
}

/// A body's class at a tick, from truth kinematics.
pub fn classify_body<T: TruthSource>(truth: &T, id: u32, tick: u32, meteors: &HashSet<u32>) -> &'static str {
    if meteors.contains(&id) {
        // A meteor's body drawn as a plain ball: its flight has been forgotten
        // by the meteor layer but the netcode client still holds the body.
        return "meteor_body_after_flight";
    }
    let body = |t: u32| truth.tick(t).and_then(|tt| tt.bodies.iter().find(|b| b.id == id).copied());
    let Some(now) = body(tick) else {
        return "no_truth";
    };
    let speed = Vec3::from_array(now.velocity).length();
    let angular = Vec3::from_array(now.angular_velocity).length();
    if speed < REST_SPEED_MPS && angular < REST_ANGULAR_RADPS {
        for ahead in 1..=TRANSITION_LOOKAHEAD_TICKS {
            if let Some(later) = body(tick + ahead) {
                if Vec3::from_array(later.velocity).length() > TRANSITION_SPEED_MPS {
                    return "about_to_move";
                }
            }
        }
        return "resting";
    }
    if speed > FAST_PROJECTILE_MPS {
        return "fast_projectile";
    }
    let accel = body(tick.saturating_sub(1)).map(|prev| {
        (Vec3::from_array(now.velocity) - Vec3::from_array(prev.velocity)) * truth.sim_hz() as f32
    });
    match accel {
        Some(a) if (a - Vec3::new(0.0, -GRAVITY, 0.0)).length() < BALLISTIC_ACCEL_TOLERANCE => "ballistic",
        Some(_) => "colliding",
        None => "moving",
    }
}

// ── the scorecard ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ClassScore {
    pub entity_frames: u64,
    pub entities: u64,
    /// Displayed vs truth at the client's render time, metres.
    pub err_render_m: Pct,
    /// Displayed vs truth at the server's actual current tick, metres.
    pub err_now_m: Pct,
    /// Rotation error at render time, degrees (bodies, vehicles).
    pub rot_render_deg: Pct,
    /// Age of the newest server sample behind the drawn state, ms.
    pub age_ms: Pct,
    /// Drawn past the newest sample: share of entity-frames, and error then.
    pub extrapolated_share: f64,
    pub err_extrapolated_m: Pct,
    /// Drawn from the latest state because no interpolated sample existed.
    pub unsampled_share: f64,
    pub gates: Gates,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Gates {
    /// Truth moving (> 5 cm/frame) while the drawn entity stood still.
    pub freeze_frames: u64,
    /// Drawn motion against truth's direction (> 5 cm).
    pub reversal_frames: u64,
    /// A drawn step > max(0.5 m, 3x truth's step).
    pub snap_frames: u64,
    /// A drawn step > 5 m while truth moved < 1 m.
    pub teleport_frames: u64,
    /// Extrapolating and > 1 m from truth.
    pub overshoot_frames: u64,
    /// Snaps + reversals + teleports per minute of entity presence.
    pub artifacts_per_min: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ClockScore {
    pub frames: u64,
    /// Render time stepping backwards frame to frame (players / bodies).
    pub render_backsteps: u64,
    pub render_backstep_total_ms: f64,
    pub render_backstep_max_ms: f64,
    pub dyn_backsteps: u64,
    pub dyn_backstep_total_ms: f64,
    pub dyn_backstep_max_ms: f64,
    pub interp_delay_ms: Pct,
    pub dyn_delay_ms: Pct,
    /// How far the body render time is behind the tick the server had
    /// actually completed at each frame (the latency the player sees), ms;
    /// negative = drawing ahead of the server.
    pub dyn_behind_now_ms: Pct,
    /// Clock lag: the tick the server had completed at each frame's probe
    /// minus the client's server-time estimate there (render time plus the
    /// delay in use), ms. The render delay is excluded: this is the clock's
    /// own share of `dyn_behind_now_ms`.
    #[serde(default)]
    pub lag_ms: Pct,
}

/// Bodies drawn after the server stopped streaming them to this client:
/// either gone from truth (retired) or outside the recipient's interest
/// radius (`DYNAMIC_BODY_AOI_EXIT_RADIUS_M`) at the render tick. The time is
/// measured on the render clock from the last tick the body was in truth and
/// in interest, so a client that removes a body the moment it can know is
/// charged the detection window only.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StaleScore {
    /// Plain body frames (not meteors) drawn at all.
    pub body_frames: u64,
    /// Of those: truth no longer has the body.
    pub no_truth_frames: u64,
    /// Of those: truth has it, outside the interest radius.
    pub out_of_interest_frames: u64,
    /// How long after it left, per stale frame, ms (render clock).
    pub stale_ms: Pct,
    /// Split by the body's truth speed when it left: > 2 m/s (it cannot have
    /// come to rest unseen) or slower.
    pub fast_stale_ms: Pct,
    pub slow_stale_ms: Pct,
    /// Distinct bodies drawn stale.
    pub bodies: u64,
    /// Meteors drawn from their body (source body or hold) while it is out
    /// of truth or interest, and how long after it left, ms.
    pub meteor_frames: u64,
    pub meteor_stale_ms: Pct,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MeteorScore {
    pub flights: u64,
    pub frames_by_source: BTreeMap<String, u64>,
    pub err_render_m: Pct,
    /// Frame-to-frame drawn jumps when the source changes (arc -> body ...).
    pub handover_jump_m: Pct,
    /// Drawn backwards motion (> 5 cm against truth's travel).
    pub backward_frames: u64,
    /// Drawn below y = -0.5 m while truth is above ground.
    pub below_ground_frames: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Card {
    pub frames: u64,
    pub span_s: f64,
    pub clock: ClockScore,
    pub classes: BTreeMap<String, ClassScore>,
    pub meteors: MeteorScore,
    /// The destruction scorer's card for city chunks (chunk-weighted).
    pub city: Option<serde_json::Value>,
    pub city_error: Option<String>,
    /// The city client's ledger-sync counters (client-stats.json).
    #[serde(default)]
    pub city_sync: Option<CitySync>,
    /// Truth entities near the client (within 40 m) not drawn, per kind,
    /// sampled every 6th frame.
    pub missing_entity_frames: BTreeMap<String, u64>,
    #[serde(default)]
    pub stale: StaleScore,
    /// Frames whose render time lies outside the captured truth (the tape
    /// opens a little before the server capture): clock-scored only.
    pub frames_outside_truth: u64,
}

/// Whether the client's destructible-structure ledger stayed in sync with the
/// server's, from the city client's own counters. `repairs_asked` is what
/// drives the server's structure bootstraps (a repair per request), so on a
/// lossless link it must be 0.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct CitySync {
    pub hash_checks: u64,
    pub hash_mismatches: u64,
    /// Settles refused as a membership disagreement (each asks for a repair).
    pub settle_rejects: u64,
    /// Far settles applied because the stream had stopped showing the body.
    pub settles_after_silence: u64,
    pub topo_seq_gaps: u64,
    /// Resync / structure-repair requests the client sent upstream.
    pub repairs_asked: u64,
    /// Structure repairs the client applied (recorded, replayed open loop).
    pub structure_repairs_applied: u64,
    pub nacks_sent: u64,
}

impl CitySync {
    pub fn from_client_stats(stats: &serde_json::Value) -> Option<Self> {
        let city = stats.get("city")?;
        let n = |key: &str| city[key].as_u64().unwrap_or(0);
        Some(Self {
            hash_checks: n("hashChecks"),
            hash_mismatches: n("hashMismatches"),
            settle_rejects: n("settleRejects"),
            settles_after_silence: n("settlesAfterSilence"),
            topo_seq_gaps: n("topoSeqGaps"),
            repairs_asked: n("resyncRequestsSent"),
            structure_repairs_applied: n("structureRepairs"),
            nacks_sent: n("nacksSent"),
        })
    }
}

#[derive(Default)]
struct Acc {
    entity_frames: u64,
    ids: HashSet<u32>,
    err_render: Vec<f32>,
    err_now: Vec<f32>,
    rot: Vec<f32>,
    age: Vec<f32>,
    extrapolated: u64,
    err_extra: Vec<f32>,
    unsampled: u64,
    gates: Gates,
}

fn quat_angle_deg(a: Quat, b: Quat) -> f32 {
    let dot = a.dot(b).abs().min(1.0);
    (2.0 * dot.acos()).to_degrees()
}

/// The tick the server had completed at each tape-clock time.
#[derive(Clone, Debug, Default)]
pub struct Timeline {
    pub ends: Vec<(f64, u32)>,
}

impl Timeline {
    /// When the live server completed each tick (recorded pace).
    pub fn of(bundle: &Bundle) -> Self {
        let ends = bundle
            .timings
            .values()
            .map(|t| (bundle.server_to_tape_ms(t.mono_us), t.tick))
            .collect();
        Self { ends }
    }

    /// The timeline the server stage ran on: recorded, or ideal (ticks
    /// exactly 1/sim_hz apart from the first captured tick's start, each
    /// producing its packets at its start -- `stream::Clock`'s ideal pace).
    pub fn for_pace(bundle: &Bundle, pace: crate::stream::Pace) -> Self {
        match pace {
            crate::stream::Pace::Recorded => Self::of(bundle),
            crate::stream::Pace::Ideal => {
                let first = bundle.first_tick();
                let tick_ms = 1000.0 / f64::from(bundle.sim_hz);
                let first_start = bundle
                    .timings
                    .get(&first)
                    .map(|t| bundle.server_to_tape_ms(t.mono_us) - f64::from(t.total_ms))
                    .unwrap_or(0.0);
                let ends = bundle
                    .timings
                    .keys()
                    .map(|&tick| (first_start + f64::from(tick - first) * tick_ms, tick))
                    .collect();
                Self { ends }
            }
        }
    }

    /// The timeline a run's client stage used (`timeline.json`).
    pub fn read(path: &Path) -> std::io::Result<Self> {
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
        let ends = value["ticks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|pair| Some((pair[1].as_f64()?, pair[0].as_u64()? as u32)))
            .collect();
        Ok(Self { ends })
    }

    pub fn tick_at(&self, tape_ms: f64) -> Option<u32> {
        let index = self.ends.partition_point(|(end, _)| *end <= tape_ms);
        (index > 0).then(|| self.ends[index - 1].1)
    }

    pub fn ticks_json(&self) -> serde_json::Value {
        serde_json::json!({
            "clock": "tape ms",
            "ticks": self.ends.iter().map(|(end, tick)| serde_json::json!([tick, end])).collect::<Vec<_>>()
        })
    }
}

pub fn score_display<T: TruthSource>(
    truth: &T,
    timeline: &Timeline,
    player: u32,
    display: &Display,
) -> Card {
    let origin = display.header["clockOriginMs"].as_f64().unwrap_or(0.0);
    let tick_us = 1e6 / f64::from(truth.sim_hz());
    let mut card = Card { frames: display.frames.len() as u64, ..Default::default() };
    if let (Some(first), Some(last)) = (display.frames.first(), display.frames.last()) {
        card.span_s = (last.t_ms - first.t_ms) / 1000.0;
    }
    let meteor_ids: HashSet<u32> = display
        .frames
        .iter()
        .flat_map(|f| f.entities.iter().filter(|e| e.kind == KIND_METEOR).map(|e| e.id))
        .collect();

    let mut accs: BTreeMap<&'static str, Acc> = BTreeMap::new();
    let mut last_drawn: HashMap<(u8, u32), ([f32; 3], f64)> = HashMap::new();
    let mut prev_render = None::<(f64, f64)>;
    let (mut interp, mut dyn_delay, mut behind) = (Vec::new(), Vec::new(), Vec::new());
    let mut meteor_err = Vec::new();
    let mut handover = Vec::new();
    let mut last_meteor: HashMap<u32, (u8, [f32; 3], f64)> = HashMap::new();
    let mut lag = Vec::new();
    let mut interest = InterestTracker::default();
    let (mut stale_ms, mut fast_stale, mut slow_stale, mut meteor_stale) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut stale_ids: HashSet<u32> = HashSet::new();

    for frame in &display.frames {
        let tape_ms = frame.sample_ms - origin;
        let now_tick = timeline.tick_at(tape_ms);
        if let Some((render, dyn_render)) = prev_render {
            if frame.render_us < render {
                card.clock.render_backsteps += 1;
                let step = (render - frame.render_us) / 1000.0;
                card.clock.render_backstep_total_ms += step;
                card.clock.render_backstep_max_ms = card.clock.render_backstep_max_ms.max(step);
            }
            if frame.dyn_render_us < dyn_render {
                card.clock.dyn_backsteps += 1;
                let step = (dyn_render - frame.dyn_render_us) / 1000.0;
                card.clock.dyn_backstep_total_ms += step;
                card.clock.dyn_backstep_max_ms = card.clock.dyn_backstep_max_ms.max(step);
            }
        }
        prev_render = Some((frame.render_us, frame.dyn_render_us));
        interp.push(frame.interp_delay_ms);
        dyn_delay.push(frame.dyn_delay_ms);
        if let Some(tick) = now_tick {
            behind.push(((f64::from(tick) * tick_us - frame.dyn_render_us) / 1000.0) as f32);
        }
        if let Some(tick) = timeline.tick_at(frame.t_ms - origin) {
            // The probe's server-time estimate: page time + offset.
            let estimate_us = frame.t_ms * 1000.0 + frame.offset_us;
            lag.push(((f64::from(tick) * tick_us - estimate_us) / 1000.0) as f32);
        }
        // Entities are scored only while both render times fall inside the
        // captured truth (the tape starts a little before the capture).
        let (first_tick, last_tick) = truth.window();
        let inside = |us: f64| {
            let tick = us / tick_us;
            tick >= f64::from(first_tick) && tick <= f64::from(last_tick)
        };
        if !inside(frame.render_us) || !inside(frame.dyn_render_us) {
            card.frames_outside_truth += 1;
            continue;
        }

        for entity in &frame.entities {
            let render_us = if entity.kind == KIND_BODY || entity.kind == KIND_METEOR {
                frame.dyn_render_us
            } else {
                frame.render_us
            };
            let truth_kind = if entity.kind == KIND_METEOR { KIND_BODY } else { entity.kind };
            let shown = Vec3::from_array(entity.position);
            let at_render = truth_at_server_us(truth, truth_kind, entity.id, render_us);
            if entity.kind == KIND_METEOR {
                let source = match entity.flags {
                    0 => "arc",
                    1 => "body",
                    2 => "hold",
                    3 => "hidden",
                    _ => "other",
                };
                *card.meteors.frames_by_source.entry(source.into()).or_default() += 1;
                if entity.flags == 3 {
                    continue;
                }
                if entity.flags == 1 || entity.flags == 2 {
                    let render_tick = (render_us / tick_us).floor().max(0.0) as u32;
                    if let Some(gone) = interest.stale(truth, player, entity.id, render_tick) {
                        card.stale.meteor_frames += 1;
                        meteor_stale.push((gone.ticks as f64 * tick_us / 1000.0) as f32);
                    }
                }
                if let Some(t) = at_render {
                    meteor_err.push(shown.distance(t.position));
                    if shown.y < -0.5 && t.position.y > 0.0 {
                        card.meteors.below_ground_frames += 1;
                    }
                }
                if let Some((prev_source, prev_pos, prev_render_us)) = last_meteor.get(&entity.id) {
                    let step = shown - Vec3::from_array(*prev_pos);
                    if *prev_source != entity.flags {
                        handover.push(step.length());
                    }
                    if let (Some(a), Some(b)) =
                        (truth_at_server_us(truth, KIND_BODY, entity.id, *prev_render_us), at_render)
                    {
                        let travel = b.position - a.position;
                        if step.length() > REVERSAL_MIN_M && step.dot(travel) < 0.0 {
                            card.meteors.backward_frames += 1;
                        }
                    }
                }
                last_meteor.insert(entity.id, (entity.flags, entity.position, render_us));
                continue;
            }
            let class = match entity.kind {
                KIND_PLAYER if entity.id == player => "self_spectated",
                KIND_PLAYER => "player",
                KIND_VEHICLE => "vehicle",
                _ => classify_body(truth, entity.id, (render_us / tick_us).round().max(0.0) as u32, &meteor_ids),
            };
            if entity.kind == KIND_BODY {
                card.stale.body_frames += 1;
                let render_tick = (render_us / tick_us).floor().max(0.0) as u32;
                if let Some(gone) = interest.stale(truth, player, entity.id, render_tick) {
                    if gone.no_truth {
                        card.stale.no_truth_frames += 1;
                    } else {
                        card.stale.out_of_interest_frames += 1;
                    }
                    let ms = (gone.ticks as f64 * tick_us / 1000.0) as f32;
                    stale_ms.push(ms);
                    if gone.fast { fast_stale.push(ms) } else { slow_stale.push(ms) }
                    stale_ids.insert(entity.id);
                }
            }
            let acc = accs.entry(class).or_default();
            acc.entity_frames += 1;
            acc.ids.insert(entity.id);
            if entity.flags & FLAG_SAMPLED == 0 {
                acc.unsampled += 1;
            }
            if entity.age_ms.is_finite() {
                acc.age.push(entity.age_ms);
            }
            let delay = if entity.kind == KIND_BODY { frame.dyn_delay_ms } else { frame.interp_delay_ms };
            // Drawn past its newest sample while it is actually moving (a
            // resting entity's old sample is still right).
            let moving = at_render.is_some_and(|t| t.velocity.length() > REST_SPEED_MPS);
            let extrapolating = moving && entity.age_ms.is_finite() && entity.age_ms > delay + 0.5;
            if let Some(t) = at_render {
                let err = shown.distance(t.position);
                acc.err_render.push(err);
                if entity.kind != KIND_PLAYER {
                    acc.rot.push(quat_angle_deg(Quat::from_array(entity.quaternion).normalize(), t.rotation));
                }
                if extrapolating {
                    acc.extrapolated += 1;
                    acc.err_extra.push(err);
                    if err > OVERSHOOT_M {
                        acc.gates.overshoot_frames += 1;
                    }
                }
            }
            if let Some(tick) = now_tick {
                if let Some(t) = truth_at_tick(truth, truth_kind, entity.id, tick) {
                    acc.err_now.push(shown.distance(t.position));
                }
            }
            let key = (entity.kind, entity.id);
            if let Some((prev_pos, prev_render_us)) = last_drawn.get(&key) {
                let step = shown - Vec3::from_array(*prev_pos);
                if let (Some(a), Some(b)) =
                    (truth_at_server_us(truth, truth_kind, entity.id, *prev_render_us), at_render)
                {
                    let travel = b.position - a.position;
                    let (s, tr) = (step.length(), travel.length());
                    if tr > FREEZE_TRUTH_MOVE_M && s < FREEZE_SHOWN_MOVE_M {
                        acc.gates.freeze_frames += 1;
                    }
                    if s > REVERSAL_MIN_M && tr > 1e-4 && step.dot(travel) < -0.5 * s * tr {
                        acc.gates.reversal_frames += 1;
                    }
                    if s > SNAP_MIN_M.max(SNAP_RATIO * tr) {
                        acc.gates.snap_frames += 1;
                    }
                    if s > TELEPORT_M && tr < 1.0 {
                        acc.gates.teleport_frames += 1;
                    }
                }
            }
            last_drawn.insert(key, (entity.position, render_us));
        }
    }
    card.clock.frames = display.frames.len() as u64;
    card.clock.interp_delay_ms = Pct::of(interp);
    card.clock.dyn_delay_ms = Pct::of(dyn_delay);
    card.clock.dyn_behind_now_ms = Pct::of(behind);
    card.clock.lag_ms = Pct::of(lag);
    card.stale.stale_ms = Pct::of(stale_ms);
    card.stale.fast_stale_ms = Pct::of(fast_stale);
    card.stale.slow_stale_ms = Pct::of(slow_stale);
    card.stale.meteor_stale_ms = Pct::of(meteor_stale);
    card.stale.bodies = stale_ids.len() as u64;
    card.meteors.flights = meteor_ids.len() as u64;
    card.meteors.err_render_m = Pct::of(meteor_err);
    card.meteors.handover_jump_m = Pct::of(handover);
    let frame_s = if card.frames > 1 { card.span_s / (card.frames - 1) as f64 } else { 1.0 / 60.0 };
    for (class, acc) in accs {
        let minutes = acc.entity_frames as f64 * frame_s / 60.0;
        let mut gates = acc.gates.clone();
        gates.artifacts_per_min =
            (gates.snap_frames + gates.reversal_frames + gates.teleport_frames) as f64 / minutes.max(1e-9);
        card.classes.insert(
            class.to_string(),
            ClassScore {
                entity_frames: acc.entity_frames,
                entities: acc.ids.len() as u64,
                err_render_m: Pct::of(acc.err_render),
                err_now_m: Pct::of(acc.err_now),
                rot_render_deg: Pct::of(acc.rot),
                age_ms: Pct::of(acc.age),
                extrapolated_share: acc.extrapolated as f64 / acc.entity_frames.max(1) as f64,
                err_extrapolated_m: Pct::of(acc.err_extra),
                unsampled_share: acc.unsampled as f64 / acc.entity_frames.max(1) as f64,
                gates,
            },
        );
    }
    let mut missing: BTreeMap<String, u64> = BTreeMap::new();
    for frame in display.frames.iter().step_by(6) {
        let Some(tick) = timeline.tick_at(frame.sample_ms - origin) else { continue };
        let Some(tt) = truth.tick(tick) else { continue };
        let Some(me) = tt.players.iter().find(|p| p.id == player) else { continue };
        let me = Vec3::from_array(me.position);
        let drawn: HashSet<(u8, u32)> = frame.entities.iter().map(|e| (e.kind, e.id)).collect();
        for body in &tt.bodies {
            if Vec3::from_array(body.position).distance(me) < 40.0
                && Vec3::from_array(body.velocity).length() > TRANSITION_SPEED_MPS
                && !drawn.contains(&(KIND_BODY, body.id))
                && !meteor_ids.contains(&body.id)
            {
                *missing.entry("moving_body_within_40m".into()).or_default() += 1;
            }
        }
        for other in &tt.players {
            if other.id != player
                && Vec3::from_array(other.position).distance(me) < 40.0
                && !drawn.contains(&(KIND_PLAYER, other.id))
            {
                *missing.entry("player_within_40m".into()).or_default() += 1;
            }
        }
    }
    card.missing_entity_frames = missing;
    card
}

/// A body counts as streamed to the recipient while truth has it within the
/// dynamic-body interest exit radius of the recipient (the server's rule in
/// `snapshot_builder::dynamic_body_within_aoi`, production radius).
pub const INTEREST_RADIUS_M: f32 = vibe_land_shared::constants::DYNAMIC_BODY_AOI_EXIT_RADIUS_M;
/// Longest look-back for the tick a stale body left, ticks.
const STALE_LOOKBACK_TICKS: u32 = 3_600;
/// A body faster than this when it left cannot have come to rest unseen.
const STALE_FAST_MPS: f32 = 2.0;

struct Gone {
    no_truth: bool,
    /// Ticks from the last tick in truth and in interest to the render tick.
    ticks: u32,
    fast: bool,
}

/// Per body: the last tick it was in truth and in interest, found by
/// scanning back, cached so each tick is looked at once per body.
#[derive(Default)]
struct InterestTracker {
    /// id -> (newest tick examined, last good tick at or before it, fast then)
    seen: HashMap<u32, (u32, Option<(u32, bool)>)>,
}

impl InterestTracker {
    fn good<T: TruthSource>(truth: &T, player: u32, id: u32, tick: u32) -> Option<bool> {
        let tt = truth.tick(tick)?;
        let body = tt.bodies.iter().find(|b| b.id == id)?;
        let me = tt.players.iter().find(|p| p.id == player)?;
        let d = Vec3::from_array(body.position).distance(Vec3::from_array(me.position));
        (d <= INTEREST_RADIUS_M).then(|| Vec3::from_array(body.velocity).length() > STALE_FAST_MPS)
    }

    fn stale<T: TruthSource>(&mut self, truth: &T, player: u32, id: u32, tick: u32) -> Option<Gone> {
        let (first, _) = truth.window();
        if let Some(fast) = Self::good(truth, player, id, tick) {
            self.seen.insert(id, (tick, Some((tick, fast))));
            return None;
        }
        let no_truth = truth.tick(tick).is_some_and(|tt| !tt.bodies.iter().any(|b| b.id == id));
        let (examined, mut last) = self.seen.get(&id).copied().unwrap_or((0, None));
        if tick > examined {
            let floor = examined.max(tick.saturating_sub(STALE_LOOKBACK_TICKS)).max(first);
            let mut t = tick;
            while t > floor {
                t -= 1;
                if let Some(fast) = Self::good(truth, player, id, t) {
                    last = Some((t, fast));
                    break;
                }
            }
            self.seen.insert(id, (tick, last));
        }
        let (left, fast) = last?;
        Some(Gone { no_truth, ticks: tick - left, fast })
    }
}

/// Scores a run directory: displayed.bin (+ presented.bin for the city).
pub fn score_run(bundle: &Bundle, out: &Path, _stream: &StreamReport) -> std::io::Result<Card> {
    let display = read_display(&out.join("displayed.bin"))?;
    // The same timeline the client stage used (pace-consistent).
    let timeline = Timeline::read(&out.join("timeline.json")).unwrap_or_else(|_| Timeline::of(bundle));
    let mut card = score_display(bundle, &timeline, bundle.player, &display);
    card.city_sync = std::fs::read(out.join("client-stats.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|stats| CitySync::from_client_stats(&stats));
    let presented = out.join("presented.bin");
    if let (Some(city), true) = (&bundle.city, presented.is_file()) {
        use vibe_land_destruction::netlab::{cameras, score};
        let tracks = cameras::PlayerTracks::from_samples(&city.cameras);
        let camera = cameras::CameraSpec::parse(&format!("player:{}", bundle.player))
            .or_else(|_| cameras::CameraSpec::parse("overview"));
        match camera {
            Ok(camera) => {
                let options = score::ScoreOptions {
                    camera,
                    profile: "netlab2".into(),
                    window: None,
                    gravity: GRAVITY,
                    dump_worst: 0,
                };
                match score::score(
                    &city.dir.join(vibe_land_destruction::netlab::capture::TAPE_FILE),
                    &city.manifest,
                    &tracks,
                    &presented,
                    &options,
                ) {
                    Ok(scorecard) => card.city = serde_json::to_value(&scorecard).ok(),
                    Err(error) => card.city_error = Some(error.to_string()),
                }
            }
            Err(error) => card.city_error = Some(error),
        }
    }
    Ok(card)
}

// ── calibration (b) ─────────────────────────────────────────────────────────

/// A tick longer than this is a server stall for the steady-state filter.
pub const STALL_MS: f32 = 33.3;
/// How long after a stall the client clock is still considered disturbed
/// (its rate window is 1 s and its slew constant 0.3 s).
pub const STALL_MEMORY_MS: f64 = 3000.0;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ClientCalibration {
    pub frames_compared: u64,
    pub warmup_s: f64,
    /// Lab client clock vs the live client's recorded per-frame clock,
    /// after the warm-up (the live client had history the lab does not).
    pub offset_diff_us: Pct,
    pub interp_delay_diff_ms: Pct,
    pub dyn_delay_diff_ms: Pct,
    /// Same, over all frames including the warm-up.
    pub offset_diff_us_all: Pct,
    /// Frames with no server tick over `STALL_MS` in the preceding
    /// `STALL_MEMORY_MS` ("steady"): the clock comparison where the
    /// call-schedule seam (docs/netlab-v2.md S8) cannot act.
    pub steady_frames: u64,
    pub steady_offset_diff_us: Pct,
    pub steady_interp_delay_diff_ms: Pct,
    pub steady_dyn_delay_diff_ms: Pct,
    /// Per 10 s window of tape time: p99 |offset difference|, us.
    pub offset_diff_p99_by_10s: Vec<f64>,
    /// Lab drawn positions vs the same client code on the recorded tape.
    pub vs_reference_m: BTreeMap<String, Pct>,
    pub reference_entity_frames_missing_in_lab: u64,
    pub lab_entity_frames_missing_in_reference: u64,
    /// Reference (recorded tape) drawn positions vs the live renderers.
    pub reference_vs_live_m: BTreeMap<String, Pct>,
    /// Lab drawn positions vs the live renderers' samples.
    pub vs_live_m: BTreeMap<String, Pct>,
    pub live_samples: u64,
    pub notes: Vec<String>,
}

fn by_key(frame: &DisplayFrame) -> HashMap<(u8, u32), &Entity> {
    frame.entities.iter().map(|e| ((e.kind, e.id), e)).collect()
}

fn kind_label(kind: u8) -> &'static str {
    match kind {
        KIND_PLAYER => "player",
        KIND_VEHICLE => "vehicle",
        KIND_BODY => "body",
        KIND_METEOR => "meteor",
        _ => "other",
    }
}

/// Positions drawn by two display streams at the same frames, per kind.
pub fn display_diff(a: &Display, b: &Display) -> (BTreeMap<String, Pct>, u64, u64) {
    let frames_b: HashMap<u64, &DisplayFrame> =
        b.frames.iter().map(|f| ((f.t_ms * 1000.0).round() as u64, f)).collect();
    let mut diffs: BTreeMap<String, Vec<f32>> = BTreeMap::new();
    let (mut only_a, mut only_b) = (0u64, 0u64);
    for frame in &a.frames {
        let Some(other) = frames_b.get(&((frame.t_ms * 1000.0).round() as u64)) else { continue };
        let theirs = by_key(other);
        let mine = by_key(frame);
        for (key, entity) in &mine {
            match theirs.get(key) {
                Some(other) => diffs
                    .entry(kind_label(key.0).into())
                    .or_default()
                    .push(Vec3::from_array(entity.position).distance(Vec3::from_array(other.position))),
                None => only_a += 1,
            }
        }
        only_b += theirs.keys().filter(|key| !mine.contains_key(key)).count() as u64;
    }
    (diffs.into_iter().map(|(k, v)| (k, Pct::of(v))).collect(), only_b, only_a)
}

/// Drawn positions vs the live renderers' samples (`live-samples.json`,
/// written by client/e2e/tape-replay/record.mjs): each live sample is
/// matched to the frame the display drew at or just before its `atMs`.
pub fn vs_live(display: &Display, live_samples: &Path) -> std::io::Result<(BTreeMap<String, Pct>, u64)> {
    #[derive(Deserialize)]
    struct Sample {
        world: Option<serde_json::Value>,
    }
    // record.mjs writes a JSON array of {tapeMs, world}; the city bench
    // writes client-<n>-drawn.jsonl, one world per line.
    let text = std::fs::read_to_string(live_samples)?;
    let samples: Vec<Sample> = if text.trim_start().starts_with('[') {
        serde_json::from_str(&text)?
    } else {
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .map(|world| Sample { world: Some(world) })
            .collect()
    };
    let mut live: BTreeMap<String, Vec<f32>> = BTreeMap::new();
    let times: Vec<f64> = display.frames.iter().map(|f| f.sample_ms).collect();
    let mut used = 0u64;
    for sample in samples {
        let Some(world) = sample.world else { continue };
        let Some(at_ms) = world["atMs"].as_f64() else { continue };
        let index = times.partition_point(|t| *t <= at_ms + 0.05);
        if index == 0 {
            continue;
        }
        let frame = &display.frames[index - 1];
        if (at_ms - frame.sample_ms).abs() > 1.0 {
            continue;
        }
        used += 1;
        let mine = by_key(frame);
        for (field, kind) in [("bodies", KIND_BODY), ("vehicles", KIND_VEHICLE), ("players", KIND_PLAYER)] {
            for item in world[field].as_array().into_iter().flatten() {
                let (Some(id), Some(pos)) = (item["id"].as_u64(), item["position"].as_array()) else { continue };
                let p: Vec<f32> = pos.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect();
                if p.len() != 3 {
                    continue;
                }
                if let Some(entity) = mine.get(&(kind, id as u32)) {
                    live.entry(kind_label(kind).into())
                        .or_default()
                        .push(Vec3::from_array(entity.position).distance(Vec3::new(p[0], p[1], p[2])));
                }
            }
        }
    }
    Ok((live.into_iter().map(|(k, v)| (k, Pct::of(v))).collect(), used))
}

pub fn client_calibration(
    bundle: &Bundle,
    lab_dir: &Path,
    reference_dir: &Path,
    live_samples: Option<&Path>,
) -> std::io::Result<ClientCalibration> {
    let lab = read_display(&lab_dir.join("displayed.bin"))?;
    let reference = read_display(&reference_dir.join("displayed.bin"))?;
    let mut cal = ClientCalibration { warmup_s: 2.0, ..Default::default() };
    let origin = bundle.tape.clock_origin_ms();
    let recorded: HashMap<u64, &crate::vltape::Frame> = bundle
        .tape
        .frames
        .iter()
        .map(|f| (((f64::from(f.t_ms) + origin) * 1000.0).round() as u64, f))
        .collect();
    let first = lab.frames.first().map_or(0.0, |f| f.t_ms);
    // Server stalls on the page clock: ends of ticks that overran.
    let stalls: Vec<f64> = bundle
        .timings
        .values()
        .filter(|t| t.total_ms > STALL_MS)
        .map(|t| bundle.server_to_tape_ms(t.mono_us) + origin)
        .collect();
    let steady = |t_ms: f64| {
        let index = stalls.partition_point(|end| *end <= t_ms);
        index == 0 || t_ms - stalls[index - 1] > STALL_MEMORY_MS
    };
    let (mut off, mut off_all, mut id, mut dd) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut s_off, mut s_id, mut s_dd) = (Vec::new(), Vec::new(), Vec::new());
    let mut windows: BTreeMap<u64, Vec<f32>> = BTreeMap::new();
    for frame in &lab.frames {
        let Some(live) = recorded.get(&((frame.t_ms * 1000.0).round() as u64)) else { continue };
        if !live.offset_us.is_finite() {
            continue;
        }
        let diff = (frame.offset_us - live.offset_us) as f32;
        off_all.push(diff.abs());
        windows.entry(((frame.t_ms - origin) / 10_000.0).max(0.0) as u64).or_default().push(diff.abs());
        if frame.t_ms - first < cal.warmup_s * 1000.0 {
            continue;
        }
        cal.frames_compared += 1;
        off.push(diff.abs());
        let di = (frame.interp_delay_ms - live.interp_delay_ms).abs();
        let dy = (frame.dyn_delay_ms - live.dyn_delay_ms).abs();
        id.push(di);
        dd.push(dy);
        if steady(frame.t_ms) {
            cal.steady_frames += 1;
            s_off.push(diff.abs());
            s_id.push(di);
            s_dd.push(dy);
        }
    }
    cal.offset_diff_us = Pct::of(off);
    cal.offset_diff_us_all = Pct::of(off_all);
    cal.interp_delay_diff_ms = Pct::of(id);
    cal.dyn_delay_diff_ms = Pct::of(dd);
    cal.steady_offset_diff_us = Pct::of(s_off);
    cal.steady_interp_delay_diff_ms = Pct::of(s_id);
    cal.steady_dyn_delay_diff_ms = Pct::of(s_dd);
    cal.offset_diff_p99_by_10s = windows.into_values().map(|v| Pct::of(v).p99).collect();
    let (diffs, missing_in_lab, missing_in_reference) = display_diff(&lab, &reference);
    cal.vs_reference_m = diffs;
    cal.reference_entity_frames_missing_in_lab = missing_in_lab;
    cal.lab_entity_frames_missing_in_reference = missing_in_reference;
    if let Some(path) = live_samples {
        let (lab_live, used) = vs_live(&lab, path)?;
        let (reference_live, _) = vs_live(&reference, path)?;
        cal.vs_live_m = lab_live;
        cal.reference_vs_live_m = reference_live;
        cal.live_samples = used;
    } else {
        cal.notes.push("no live-samples.json beside the bundle: live renderer comparison skipped".into());
    }
    Ok(cal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_capture::{BodyTruth, PlayerTruth};

    /// A synthetic world: one body resting, then launched ballistically, then
    /// hitting the ground; one remote player walking.
    struct World {
        ticks: Vec<TickTruth>,
    }

    impl TruthSource for World {
        fn tick(&self, tick: u32) -> Option<&TickTruth> {
            self.ticks.get(tick as usize)
        }
        fn sim_hz(&self) -> u32 {
            60
        }
        fn window(&self) -> (u32, u32) {
            (0, self.ticks.len() as u32 - 1)
        }
    }

    fn world() -> World {
        let dt = 1.0 / 60.0;
        let mut ticks = Vec::new();
        let (mut pos, mut vel) = (Vec3::new(0.0, 1.0, 0.0), Vec3::ZERO);
        for tick in 0..300u32 {
            if tick == 60 {
                vel = Vec3::new(3.0, 8.0, 0.0);
            }
            if tick > 60 {
                vel.y -= GRAVITY * dt;
                pos += vel * dt;
                if pos.y < 1.0 {
                    pos.y = 1.0;
                    vel = Vec3::new(vel.x * 0.5, 0.0, 0.0);
                }
            }
            ticks.push(TickTruth {
                tick,
                players: vec![
                    PlayerTruth { id: 1, position: [0.0, 0.0, 0.0], ..Default::default() },
                    PlayerTruth {
                        id: 2,
                        position: [tick as f32 * 0.1, 0.0, 5.0],
                        velocity: [6.0, 0.0, 0.0],
                        ..Default::default()
                    },
                ],
                bodies: vec![BodyTruth {
                    id: 9,
                    handle: 1,
                    shape: 1,
                    position: pos.to_array(),
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    velocity: vel.to_array(),
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
        World { ticks }
    }

    #[test]
    fn classifies_rest_transition_flight_and_contact() {
        let w = world();
        let none = HashSet::new();
        assert_eq!(classify_body(&w, 9, 10, &none), "resting");
        assert_eq!(classify_body(&w, 9, 45, &none), "about_to_move");
        assert_eq!(classify_body(&w, 9, 80, &none), "ballistic");
        let landed = (61..300).find(|&t| w.ticks[t as usize].bodies[0].position[1] <= 1.0 && t > 70).unwrap();
        assert_eq!(classify_body(&w, 9, landed, &none), "colliding");
        let mut meteors = HashSet::new();
        meteors.insert(9);
        assert_eq!(classify_body(&w, 9, 80, &meteors), "meteor_body_after_flight");
    }

    fn frame_at(w: &World, t_ms: f64, delay_ms: f32, shift: Vec3, jump: Option<Vec3>) -> DisplayFrame {
        let render_us = t_ms * 1000.0 - f64::from(delay_ms) * 1000.0;
        let mut entities = Vec::new();
        for (kind, id) in [(KIND_BODY, 9u32), (KIND_PLAYER, 2u32)] {
            if let Some(t) = truth_at_server_us(w, kind, id, render_us) {
                let p = t.position + shift + jump.unwrap_or(Vec3::ZERO);
                entities.push(Entity {
                    kind,
                    flags: FLAG_SAMPLED,
                    id,
                    position: p.to_array(),
                    quaternion: [0.0, 0.0, 0.0, 1.0],
                    age_ms: delay_ms,
                });
            }
        }
        DisplayFrame {
            t_ms,
            sample_ms: t_ms,
            offset_us: 0.0,
            interp_delay_ms: delay_ms,
            dyn_delay_ms: delay_ms,
            render_us,
            dyn_render_us: render_us,
            entities,
        }
    }

    fn display(frames: Vec<DisplayFrame>) -> Display {
        Display { header: serde_json::json!({"clockOriginMs": 0.0}), frames }
    }

    fn timeline() -> Timeline {
        Timeline { ends: (0..300u32).map(|t| (f64::from(t) * 1000.0 / 60.0, t)).collect() }
    }

    #[test]
    fn a_perfect_client_scores_zero_at_render_time_and_its_delay_now() {
        let w = world();
        let frames = (60..280).map(|i| frame_at(&w, f64::from(i) * 1000.0 / 60.0, 50.0, Vec3::ZERO, None)).collect();
        let card = score_display(&w, &timeline(), 1, &display(frames));
        let player = &card.classes["player"];
        assert!(player.err_render_m.max < 1e-4, "{:?}", player.err_render_m);
        // 50 ms behind a 6 m/s walker: ~0.3 m "now" error.
        assert!((player.err_now_m.p50 - 0.3).abs() < 0.07, "{:?}", player.err_now_m);
        assert_eq!(player.gates, Gates::default());
        assert_eq!(card.clock.render_backsteps, 0);
        assert!(card.classes.contains_key("ballistic"));
    }

    #[test]
    fn gates_catch_a_rewind_and_a_teleport() {
        let w = world();
        let mut frames: Vec<DisplayFrame> =
            (60..200).map(|i| frame_at(&w, f64::from(i) * 1000.0 / 60.0, 50.0, Vec3::ZERO, None)).collect();
        // Render clock steps back 100 ms at one frame: drawn positions rewind.
        let rewound = frame_at(&w, frames[100].t_ms, 150.0, Vec3::ZERO, None);
        frames[100] = rewound;
        // And a 10 m teleport of everything for one frame.
        frames[120] = frame_at(&w, frames[120].t_ms, 50.0, Vec3::new(10.0, 0.0, 0.0), None);
        let card = score_display(&w, &timeline(), 1, &display(frames));
        assert!(card.clock.render_backsteps >= 1);
        // 100 ms more delay, one 16.7 ms frame later: an 83 ms step back.
        assert!((card.clock.render_backstep_max_ms - 83.3).abs() < 1.0, "{:?}", card.clock);
        let player = &card.classes["player"];
        assert!(player.gates.teleport_frames >= 1, "{:?}", player.gates);
        assert!(player.gates.snap_frames >= 1);
        assert!(player.err_render_m.max > 9.0);
    }

    #[test]
    fn a_stale_extrapolated_body_is_counted_as_extrapolating() {
        let w = world();
        let mut frames: Vec<DisplayFrame> =
            (70..100).map(|i| frame_at(&w, f64::from(i) * 1000.0 / 60.0, 50.0, Vec3::ZERO, None)).collect();
        for frame in &mut frames {
            for entity in &mut frame.entities {
                entity.age_ms = 120.0;
            }
        }
        let card = score_display(&w, &timeline(), 1, &display(frames));
        let flight = &card.classes["ballistic"];
        assert!(flight.extrapolated_share > 0.99);
    }

    #[test]
    fn a_body_drawn_after_it_left_truth_or_interest_is_stale_and_timed() {
        // Body 9 exists until tick 150; a client keeps drawing it at its last
        // pose until tick 200. Then body 9 is moved 100 m away (out of interest).
        let mut w = world();
        for tick in 150..300usize {
            w.ticks[tick].bodies.clear();
        }
        let last = w.ticks[149].bodies[0];
        let frame = |tick: u32| {
            let mut f = frame_at(&w, f64::from(tick) * 1000.0 / 60.0, 0.0, Vec3::ZERO, None);
            f.entities.retain(|e| e.kind != KIND_BODY);
            f.entities.push(Entity { kind: KIND_BODY, flags: 0, id: 9, position: last.position, quaternion: [0.0, 0.0, 0.0, 1.0], age_ms: 0.0 });
            f
        };
        let card = score_display(&w, &timeline(), 1, &display((140..=200).map(frame).collect()));
        assert_eq!(card.stale.no_truth_frames, 51);
        assert_eq!(card.stale.out_of_interest_frames, 0);
        // Drawn 51 ticks after its last tick in truth (149 -> 200).
        assert!((card.stale.stale_ms.max - 51.0 * 1000.0 / 60.0).abs() < 1.0, "{:?}", card.stale);

        let mut far = world();
        for tick in 100..300usize {
            far.ticks[tick].bodies[0].position = [100.0, 1.0, 0.0];
        }
        let frames = (90..=120).map(|tick| frame_at(&far, f64::from(tick) * 1000.0 / 60.0, 0.0, Vec3::ZERO, None)).collect();
        let card = score_display(&far, &timeline(), 1, &display(frames));
        assert_eq!(card.stale.no_truth_frames, 0);
        assert!(card.stale.out_of_interest_frames >= 20, "{:?}", card.stale);
        // The clock lag of a client whose estimate is the completed tick is ~0.
        assert!(card.clock.lag_ms.max.abs() < 17.0, "{:?}", card.clock.lag_ms);
    }

    #[test]
    fn display_stream_round_trips_through_the_reader() {
        // The TS writer's layout, byte for byte (displayFormat.ts).
        let mut bytes = Vec::new();
        let header = br#"{"clockOriginMs":5}"#;
        bytes.extend_from_slice(b"VLDISP01");
        bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
        bytes.extend_from_slice(header);
        for value in [10.5f64, 8.0, -3.0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&50f32.to_le_bytes());
        bytes.extend_from_slice(&40f32.to_le_bytes());
        for value in [1000.0f64, 900.0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.push(3);
        bytes.push(1);
        bytes.extend_from_slice(&42u32.to_le_bytes());
        for value in [1.0f32, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, 12.5] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let display = parse_display(&bytes).unwrap();
        assert_eq!(display.frames.len(), 1);
        let f = &display.frames[0];
        assert_eq!((f.t_ms, f.sample_ms, f.dyn_render_us, f.dyn_delay_ms), (10.5, 8.0, 900.0, 40.0));
        assert_eq!(f.entities[0].id, 42);
        assert_eq!(f.entities[0].position, [1.0, 2.0, 3.0]);
        assert_eq!(f.entities[0].age_ms, 12.5);
    }
}
