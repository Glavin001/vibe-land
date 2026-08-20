//! Debris trajectory codec (v2 spec, WS1+WS2) measured offline on recorded traces.
//!
//! The live hierarchy path streams island-*root* trajectory segments over a
//! buffered GOP block and repairs every child with per-tick residuals. This
//! module measures a different decomposition: each body carries its own
//! analytic timeline, and the wire carries only the points where physics tells
//! the client something it could not have predicted.
//!
//! Four record types, in the order they matter:
//!
//! * `SEGMENT` opens a ballistic arc from a quantized state -- position,
//!   velocity, orientation, angular velocity. The client evaluates
//!   `p(t) = p0 + v0*d + g*d^2/2` and `q(t) = exp(w*d) * q0` until told otherwise.
//! * `IMPULSE` is the payoff record. At a contact the *velocity* jumps but the
//!   pose does not, so the client's own prediction supplies `p0` and `q0` and
//!   the wire carries only the velocity delta. Roughly half a segment.
//! * `SAMPLE_RUN` is the floor. A body that scrapes, rolls or precesses fits
//!   arcs badly; rather than emit a segment per tick, the encoder pays the
//!   sampled cost. This is what bounds the downside to "baseline + headers".
//! * `REST` terminates a body at the tick the solver sleeps it. Everything
//!   after that tick is free.
//!
//! The encoder needs hindsight for exactly one decision: whether a body's span
//! is cheaper as codec records or as samples. That is a per-body, per-span
//! comparison of two byte counts, so it is exact rather than heuristic -- which
//! is the whole reason the window exists. The window is one flush span
//! (default 50 ms), not the 150 ms the spec budgets.
//!
//! Two properties are load-bearing and easy to lose:
//!
//! 1. **Quantization feedback.** After emitting a record the fitter rebases its
//!    analytic state from the *dequantized* values, never the raw sim state. A
//!    fitter that tracks truth while the client tracks quantized values drifts
//!    apart, and the encoder spends its budget chasing an error the client
//!    never sees.
//! 2. **The error bound is checked against the same reconstruction the client
//!    builds.** Every tolerance decision here compares truth to a pose derived
//!    from quantized parameters, and the verification pass re-derives every
//!    displayed pose from re-parsed wire bytes.

use std::fs;
use std::path::PathBuf;

use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::time::Instant;

use anyhow::{Context, Result};
use glam::{Quat, Vec3};
use serde::Serialize;

use crate::codec::{
    angular_error_degrees, decode_quat32, encode_quat32, rigid_shell_error_meters, PhysicalClass,
};
use crate::evaluate::{
    assess_visual_acceptance, write_csv, TelemetryPass, VisualAcceptance,
};
use crate::mask::{motion_magnitude, MaskConfig};
use crate::metrics::ContinuityConfig;
use crate::presentation::{MotionSnapshot, PresentationConfig};
use crate::replay::ReplayWriter;
use crate::island::{encode_topology_block, IslandView, TopologyTickDelta};
use crate::trace::{ActorState, Pose, TraceReader};

/// Millimetre position grid, zigzag-varint coded so the range is unbounded.
///
/// A fixed 24-bit field spans only +/-8.4 km, which is not enough: traces park
/// not-yet-launched projectiles at -10 km sentinels, and clamping those to the
/// grid puts them kilometres from truth. Varints cost 3 bytes inside +/-1 km --
/// the same as the fixed field -- and simply grow for anything further out, so
/// no world size or parking convention can break the encoding.
const POSITION_STEP_M: f32 = 0.001;
const ROTATION_BYTES: usize = 4;
/// Body varint + tick varint + stride + last offset + packed step + count.
/// The historical ladder: 20 Hz down to every tick at 120 Hz physics.
pub const DEFAULT_STRIDE_LADDER: [u8; 5] = [6, 4, 3, 2, 1];
const SAMPLE_RUN_HEADER_BYTES: usize = 7;
/// A frame after the first cannot cost less than its mode byte plus one byte
/// per position axis.
const SAMPLE_FRAME_FLOOR_BYTES: usize = 4;
/// 2 cm/s velocity grid over s16: +/-655 m/s.
const VELOCITY_STEP_MPS: f32 = 0.02;
/// 0.01 rad/s angular grid over s16: +/-327 rad/s.
const ANGULAR_STEP_RPS: f32 = 0.01;


// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

fn quantize_position(value: Vec3) -> [i32; 3] {
    let mut out = [0; 3];
    for (slot, component) in out.iter_mut().zip(value.to_array()) {
        *slot = (component / POSITION_STEP_M)
            .round()
            .clamp(i32::MIN as f32, i32::MAX as f32) as i32;
    }
    out
}

fn dequantize_position(value: [i32; 3]) -> Vec3 {
    Vec3::new(
        value[0] as f32 * POSITION_STEP_M,
        value[1] as f32 * POSITION_STEP_M,
        value[2] as f32 * POSITION_STEP_M,
    )
}

fn quantize_scaled(value: Vec3, step: f32) -> [i16; 3] {
    let mut out = [0; 3];
    for (slot, component) in out.iter_mut().zip(value.to_array()) {
        *slot = (component / step)
            .round()
            .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
    }
    out
}

fn dequantize_scaled(value: [i16; 3], step: f32) -> Vec3 {
    Vec3::new(
        value[0] as f32 * step,
        value[1] as f32 * step,
        value[2] as f32 * step,
    )
}

/// Rotation values carry their own format in bit 63.
///
/// Clear: the incumbent 32-bit smallest-three quaternion in the low bits.
/// Set: a 16-bit-per-component ("wide") one. A member chunk of an island is
/// reconstructed from its ROOT's rotation at a lever arm, so the root's angular
/// quantum lands on the member scaled by that arm -- 2.77 mrad over 31 m is
/// 8.6 cm, which no amount of fitting can undo. Wide roots cut the quantum to
/// 43 microrad, which holds a 0.5 cm bound out past 100 m.
///
/// Tagging the value rather than the stream means a decoder never needs side
/// state to know which grid a rotation is on, so a body may switch formats
/// mid-run (its island grew) without a resync.
const ROTATION_WIDE_TAG: u64 = 1 << 63;
const ROTATION_WIDE_BYTES: usize = 7;
/// Scale of a wide component, mirroring `encode_quat32`'s `511 * sqrt(2)`.
const QUAT48_SCALE: f32 = 32767.0 * std::f32::consts::SQRT_2;

/// Decode a rotation on whichever grid it says it is on.
///
/// Reading a wide value's low 32 bits as a narrow quaternion yields a garbage
/// orientation, and on an island root that garbage is multiplied by every
/// member's lever arm -- it showed up as a 174 degree, 7.5 m outlier.
pub(crate) fn decode_rotation(rotation: u64) -> Quat {
    if is_wide_rotation(rotation) {
        decode_quat48(rotation)
    } else {
        decode_quat32(rotation as u32)
    }
}

pub(crate) fn is_wide_rotation(rotation: u64) -> bool {
    rotation & ROTATION_WIDE_TAG != 0
}

/// 2-bit largest-component index + three 16-bit signed components.
pub(crate) fn encode_quat48(input: Quat) -> u64 {
    let q = input.normalize();
    let mut values = [q.x, q.y, q.z, q.w];
    let mut largest = 0;
    for i in 1..4 {
        if values[i].abs() > values[largest].abs() {
            largest = i;
        }
    }
    if values[largest] < 0.0 {
        for value in &mut values {
            *value = -*value;
        }
    }
    let mut packed = ROTATION_WIDE_TAG | largest as u64;
    let mut shift = 2;
    for (index, value) in values.into_iter().enumerate() {
        if index == largest {
            continue;
        }
        let quantized = (value * QUAT48_SCALE)
            .round()
            .clamp(i16::MIN as f32, i16::MAX as f32) as i64;
        packed |= ((quantized as u64) & 0xffff) << shift;
        shift += 16;
    }
    packed
}

pub(crate) fn decode_quat48(packed: u64) -> Quat {
    let (index, components) = unpack_quat48(packed);
    let mut values = [0.0f32; 4];
    let mut slot = 0;
    let mut sum = 0.0f32;
    for (position, value) in values.iter_mut().enumerate() {
        if position == index as usize {
            continue;
        }
        let component = components[slot] as f32 / QUAT48_SCALE;
        *value = component;
        sum += component * component;
        slot += 1;
    }
    values[index as usize] = (1.0 - sum).max(0.0).sqrt();
    Quat::from_xyzw(values[0], values[1], values[2], values[3]).normalize()
}

fn quantize_pose(pose: Pose) -> ([i32; 3], u64) {
    (
        quantize_position(pose.position),
        encode_quat32(pose.rotation) as u64,
    )
}

/// Quantize onto the grid this body is entitled to.
fn quantize_pose_with(pose: Pose, wide: bool) -> ([i32; 3], u64) {
    if wide {
        (quantize_position(pose.position), encode_quat48(pose.rotation))
    } else {
        quantize_pose(pose)
    }
}

fn dequantize_pose(position: [i32; 3], rotation: u64) -> Pose {
    Pose {
        position: dequantize_position(position),
        rotation: decode_rotation(rotation),
    }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Record {
    /// Opens an analytic arc from a fully specified quantized state.
    ///
    /// `gravity` distinguishes free flight from *supported* motion. A brick
    /// resting on rubble or still held by an unbroken joint is not accelerating
    /// downward, and integrating gravity into its prediction walks it through
    /// the floor within a few ticks -- which is what forces an otherwise-free
    /// body into the sampled fallback. The flag costs no bytes: segments are
    /// written in two groups and the group implies the mode.
    Segment {
        body: u32,
        tick: u32,
        gravity: bool,
        position: [i32; 3],
        rotation: u64,
        velocity: [i16; 3],
        angular: [i16; 3],
    },
    /// Velocity discontinuity. Pose is implied by the client's own prediction.
    Impulse {
        body: u32,
        tick: u32,
        delta_velocity: [i16; 3],
        delta_angular: [i16; 3],
    },
    /// Sampled fallback for motion the analytic forms track badly.
    ///
    /// Frames sit at `tick + i*stride` except the last, which is pinned to
    /// `tick + last_offset` so the run always closes on the span's final tick.
    /// The receiver needs that offset to map a tick into the right interval.
    SampleRun {
        body: u32,
        tick: u32,
        stride: u8,
        last_offset: u8,
        /// Open this run from the body's previous sampled chain instead of an
        /// absolute pose. Every run used to restart absolute, which cost a full
        /// pose per run and -- worse -- paid back the coarse chain's accumulated
        /// drift as a backwards snap at the span boundary, which is what the
        /// excess-step and reversal gates were seeing.
        continuity: bool,
        /// Second-order framing: code each interior delta as its change from
        /// the previous delta. Slow contact motion is near-constant-velocity,
        /// so the second difference is much smaller than the first. Lossless --
        /// the same chain, framed differently -- and chosen per record by
        /// whichever actually encodes smaller.
        second_order: bool,
        /// Delta grid for frames after the first: step = 1 mm << `step_exp`.
        ///
        /// A body slow enough to be in the sampled fallback is usually also a
        /// body whose masked bound is far looser than a millimetre, and coding
        /// its deltas on the fine grid spends bytes on precision no viewer can
        /// resolve. The frames stored here are the reconstructed chain, so the
        /// grid is already folded in and playback needs no knowledge of it.
        step_exp: u8,
        frames: Vec<([i32; 3], u64)>,
    },
    /// Terminal: the solver slept this body. Free from here on.
    Rest {
        body: u32,
        tick: u32,
        position: [i32; 3],
        rotation: u64,
    },
}

impl Record {
    pub fn body(&self) -> u32 {
        match self {
            Record::Segment { body, .. }
            | Record::Impulse { body, .. }
            | Record::SampleRun { body, .. }
            | Record::Rest { body, .. } => *body,
        }
    }

    pub fn tick(&self) -> u32 {
        match self {
            Record::Segment { tick, .. }
            | Record::Impulse { tick, .. }
            | Record::SampleRun { tick, .. }
            | Record::Rest { tick, .. } => *tick,
        }
    }

    fn kind_index(&self) -> usize {
        match self {
            Record::Segment { gravity: true, .. } => 0,
            Record::Impulse { .. } => 1,
            Record::SampleRun { .. } => 2,
            Record::Rest { .. } => 3,
            Record::Segment { gravity: false, .. } => 4,
        }
    }

    /// Encoded size in the block payload, computed by encoding rather than by
    /// a parallel formula that could drift from the writer.
    pub fn encoded_len(
        &self,
        block_first_tick: u32,
        tails: &[Option<([i32; 3], u64)>],
        wire_v2: bool,
    ) -> usize {
        let mut scratch = Vec::with_capacity(64);
        write_record(&mut scratch, self, block_first_tick, tails, wire_v2);
        scratch.len()
    }
}

fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

fn unzigzag(value: u64) -> i64 {
    ((value >> 1) as i64) ^ -((value & 1) as i64)
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(input: &[u8], cursor: &mut usize) -> Result<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        anyhow::ensure!(*cursor < input.len(), "varint truncated");
        let byte = input[*cursor];
        *cursor += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
        anyhow::ensure!(shift <= 63, "varint overflow");
    }
}

fn write_position(out: &mut Vec<u8>, value: [i32; 3]) {
    for component in value {
        write_varint(out, zigzag(component as i64));
    }
}

fn read_position(input: &[u8], cursor: &mut usize) -> Result<[i32; 3]> {
    let mut out = [0; 3];
    for slot in out.iter_mut() {
        *slot = unzigzag(read_varint(input, cursor)?) as i32;
    }
    Ok(out)
}

fn write_s16x3(out: &mut Vec<u8>, value: [i16; 3]) {
    for component in value {
        out.extend_from_slice(&component.to_le_bytes());
    }
}

fn read_s16x3(input: &[u8], cursor: &mut usize) -> Result<[i16; 3]> {
    anyhow::ensure!(*cursor + 6 <= input.len(), "s16x3 truncated");
    let mut out = [0; 3];
    for slot in out.iter_mut() {
        *slot = i16::from_le_bytes([input[*cursor], input[*cursor + 1]]);
        *cursor += 2;
    }
    Ok(out)
}

fn write_u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn read_u32le(input: &[u8], cursor: &mut usize) -> Result<u32> {
    anyhow::ensure!(*cursor + 4 <= input.len(), "u32 truncated");
    let value = u32::from_le_bytes([
        input[*cursor],
        input[*cursor + 1],
        input[*cursor + 2],
        input[*cursor + 3],
    ]);
    *cursor += 4;
    Ok(value)
}

/// Records are grouped by type inside a block, so no per-record tag is written.
fn write_record(
    out: &mut Vec<u8>,
    record: &Record,
    block_first_tick: u32,
    tails: &[Option<([i32; 3], u64)>],
    wire_v2: bool,
) {
    match record {
        Record::Segment {
            body,
            tick,
            gravity: _,
            position,
            rotation,
            velocity,
            angular,
        } => {
            write_varint(out, *body as u64);
            write_varint(out, (tick - block_first_tick) as u64);
            write_position(out, *position);
            write_absolute_rotation(out, *rotation, wire_v2);
            write_s16x3(out, *velocity);
            write_s16x3(out, *angular);
        }
        Record::Impulse {
            body,
            tick,
            delta_velocity,
            delta_angular,
        } => {
            write_varint(out, *body as u64);
            write_varint(out, (tick - block_first_tick) as u64);
            write_s16x3(out, *delta_velocity);
            write_s16x3(out, *delta_angular);
        }
        Record::SampleRun {
            body,
            tick,
            stride,
            last_offset,
            continuity,
            second_order,
            step_exp,
            frames,
        } => {
            write_varint(out, *body as u64);
            write_varint(out, (tick - block_first_tick) as u64);
            out.push(*stride);
            out.push(*last_offset);
            out.push(*step_exp | (u8::from(*continuity) << 6) | (u8::from(*second_order) << 7));
            write_varint(out, frames.len() as u64);
            // Only the first frame is absolute. A body slow enough to have been
            // pushed into the sampled fallback moves millimetres per frame, so
            // the delta costs a byte or two per axis instead of three, and its
            // quantized orientation is often bit-identical to the last one.
            // Lossless: the reconstructed values are exactly the absolute ones.
            // A continuity run opens against the tail the receiver already
            // holds, so its first frame codes like any interior one.
            let mut previous: Option<([i32; 3], u64)> = if *continuity {
                tails.get(*body as usize).copied().flatten()
            } else {
                None
            };
            let mut previous_delta = [0_i64; 3];
            for (position, rotation) in frames {
                match previous {
                    None => {
                        write_position(out, *position);
                        write_absolute_rotation(out, *rotation, wire_v2);
                    }
                    Some((last_position, last_rotation)) => {
                        let mode = rotation_mode(Some(last_rotation), *rotation);
                        out.push(mode);
                        for axis in 0..3 {
                            // Divisible by the step by construction: the chain
                            // was built on this grid.
                            let delta = position[axis] as i64 - last_position[axis] as i64;
                            let coded = if *second_order {
                                delta - previous_delta[axis]
                            } else {
                                delta
                            };
                            previous_delta[axis] = delta;
                            write_varint(out, zigzag(coded >> *step_exp));
                        }
                        write_rotation(out, mode, Some(last_rotation), *rotation);
                    }
                }
                previous = Some((*position, *rotation));
            }
        }
        Record::Rest {
            body,
            tick,
            position,
            rotation,
        } => {
            write_varint(out, *body as u64);
            write_varint(out, (tick - block_first_tick) as u64);
            write_position(out, *position);
            write_absolute_rotation(out, *rotation, wire_v2);
        }
    }
}

fn read_record(
    input: &[u8],
    cursor: &mut usize,
    kind: usize,
    block_first_tick: u32,
    tails: &[Option<([i32; 3], u64)>],
    wire_v2: bool,
) -> Result<Record> {
    let body = read_varint(input, cursor)? as u32;
    let tick = block_first_tick + read_varint(input, cursor)? as u32;
    Ok(match kind {
        0 | 4 => Record::Segment {
            body,
            tick,
            gravity: kind == 0,
            position: read_position(input, cursor)?,
            rotation: read_absolute_rotation(input, cursor, wire_v2)?,
            velocity: read_s16x3(input, cursor)?,
            angular: read_s16x3(input, cursor)?,
        },
        1 => Record::Impulse {
            body,
            tick,
            delta_velocity: read_s16x3(input, cursor)?,
            delta_angular: read_s16x3(input, cursor)?,
        },
        2 => {
            anyhow::ensure!(*cursor + 2 < input.len(), "sample run truncated");
            let stride = input[*cursor];
            let last_offset = input[*cursor + 1];
            let packed = input[*cursor + 2];
            let step_exp = packed & 0x3f;
            let continuity = packed & 0x40 != 0;
            let second_order = packed & 0x80 != 0;
            *cursor += 3;
            let count = read_varint(input, cursor)? as usize;
            let mut frames: Vec<([i32; 3], u64)> = Vec::with_capacity(count);
            let mut previous_delta = [0_i64; 3];
            let seed = if continuity {
                tails.get(body as usize).copied().flatten()
            } else {
                None
            };
            for index in 0..count {
                if index == 0 && seed.is_none() {
                    let position = read_position(input, cursor)?;
                    let rotation = read_absolute_rotation(input, cursor, wire_v2)?;
                    frames.push((position, rotation));
                    continue;
                }
                let (last_position, last_rotation) = if index == 0 {
                    seed.expect("continuity run without a tail")
                } else {
                    frames[index - 1]
                };
                anyhow::ensure!(*cursor < input.len(), "sample frame truncated");
                let mode = input[*cursor];
                *cursor += 1;
                let mut position = [0i32; 3];
                for axis in 0..3 {
                    let coded = unzigzag(read_varint(input, cursor)?) << step_exp;
                    let delta = if second_order {
                        previous_delta[axis] + coded
                    } else {
                        coded
                    };
                    previous_delta[axis] = delta;
                    position[axis] = (last_position[axis] as i64 + delta) as i32;
                }
                let rotation = read_rotation(input, cursor, mode, Some(last_rotation))?;
                frames.push((position, rotation));
            }
            Record::SampleRun {
                body,
                tick,
                stride,
                last_offset,
                continuity,
                second_order,
                step_exp,
                frames,
            }
        }
        _ => Record::Rest {
            body,
            tick,
            position: read_position(input, cursor)?,
            rotation: read_absolute_rotation(input, cursor, wire_v2)?,
        },
    })
}

/// `tails` is stream state: the last sampled frame per body, carried across
/// blocks so a run can open against what the receiver already holds. Both
/// sides update it in the same order, so it never has to go on the wire.
/// The receiver's tail is simply the last sampled frame seen for a body. The
/// encoder only sets the continuity bit when its own lane agrees with that, so
/// a stale tail is never consulted.
/// Rotation cost census: how many sampled frames re-send a full orientation,
/// and what that costs. Rotation is the one stream that has never had a delta
/// tier, so its share decides whether building one is worth it.
/// Rotation coding modes for a sampled frame, cheapest first.
///
/// The wire carries the packed smallest-three word, and these code *that word*
/// rather than the orientation it represents, so every mode reproduces the
/// exact same bits: no drift, no extra validation, and the record keeps its
/// existing representation. Delta modes require the omitted-component index to
/// match, since a different index is a different parameterisation.
const ROT_HELD: u8 = 0;
const ROT_DELTA4: u8 = 1;
const ROT_DELTA8: u8 = 2;
const ROT_FULL: u8 = 3;
/// Wide modes. A mode byte names its own format, so narrow and wide bodies
/// share one stream and a body may change format between records.
const ROT_WFULL: u8 = 4;
const ROT_WDELTA8: u8 = 5;
const ROT_WDELTA16: u8 = 6;

fn unpack_quat32(packed: u32) -> (u8, [i32; 3]) {
    let index = (packed & 3) as u8;
    let mut components = [0_i32; 3];
    for (slot, component) in components.iter_mut().enumerate() {
        let raw = ((packed >> (2 + 10 * slot)) & 0x3ff) as i32;
        *component = if raw & 0x200 != 0 { raw - 0x400 } else { raw };
    }
    (index, components)
}

fn unpack_quat48(packed: u64) -> (u8, [i32; 3]) {
    let index = (packed & 3) as u8;
    let mut components = [0_i32; 3];
    for (slot, component) in components.iter_mut().enumerate() {
        let raw = ((packed >> (2 + 16 * slot)) & 0xffff) as i32;
        *component = if raw & 0x8000 != 0 { raw - 0x10000 } else { raw };
    }
    (index, components)
}

fn pack_quat48(index: u8, components: [i32; 3]) -> u64 {
    let mut packed = ROTATION_WIDE_TAG | index as u64;
    for (slot, component) in components.into_iter().enumerate() {
        packed |= ((component as u64) & 0xffff) << (2 + 16 * slot);
    }
    packed
}

fn pack_quat32(index: u8, components: [i32; 3]) -> u32 {
    let mut packed = index as u32;
    for (slot, component) in components.into_iter().enumerate() {
        packed |= ((component & 0x3ff) as u32) << (2 + 10 * slot);
    }
    packed
}

/// Cheapest mode that reproduces `rotation` exactly given `previous`.
fn rotation_mode(previous: Option<u64>, rotation: u64) -> u8 {
    let wide = is_wide_rotation(rotation);
    let full = if wide { ROT_WFULL } else { ROT_FULL };
    let Some(previous) = previous else {
        return full;
    };
    if previous == rotation {
        return ROT_HELD;
    }
    // A format change is a different parameterisation, so it restarts the
    // delta chain rather than coding against a grid the predecessor is not on.
    if is_wide_rotation(previous) != wide {
        return full;
    }
    let (last_index, last) = if wide {
        unpack_quat48(previous)
    } else {
        unpack_quat32(previous as u32)
    };
    let (index, current) = if wide {
        unpack_quat48(rotation)
    } else {
        unpack_quat32(rotation as u32)
    };
    if index != last_index {
        return full;
    }
    let deltas = [
        current[0] - last[0],
        current[1] - last[1],
        current[2] - last[2],
    ];
    if wide {
        if deltas.iter().all(|delta| (-127..=127).contains(delta)) {
            ROT_WDELTA8
        } else if deltas.iter().all(|delta| (-32767..=32767).contains(delta)) {
            ROT_WDELTA16
        } else {
            ROT_WFULL
        }
    } else if deltas.iter().all(|delta| (-7..=7).contains(delta)) {
        ROT_DELTA4
    } else if deltas.iter().all(|delta| (-127..=127).contains(delta)) {
        ROT_DELTA8
    } else {
        ROT_FULL
    }
}

fn write_rotation(out: &mut Vec<u8>, mode: u8, previous: Option<u64>, rotation: u64) {
    match mode {
        ROT_HELD => {}
        ROT_DELTA4 => {
            let (_, last) = unpack_quat32(previous.expect("delta needs a predecessor") as u32);
            let (_, current) = unpack_quat32(rotation as u32);
            // Three 4-bit signed deltas in 12 bits.
            let mut bits = 0_u16;
            for slot in 0..3 {
                let delta = (current[slot] - last[slot]) as i16;
                bits |= ((delta & 0xf) as u16) << (4 * slot);
            }
            out.extend_from_slice(&bits.to_le_bytes());
        }
        ROT_DELTA8 => {
            let (_, last) = unpack_quat32(previous.expect("delta needs a predecessor") as u32);
            let (_, current) = unpack_quat32(rotation as u32);
            for slot in 0..3 {
                out.push((current[slot] - last[slot]) as i8 as u8);
            }
        }
        ROT_WDELTA8 => {
            let (_, last) = unpack_quat48(previous.expect("delta needs a predecessor"));
            let (_, current) = unpack_quat48(rotation);
            for slot in 0..3 {
                out.push((current[slot] - last[slot]) as i8 as u8);
            }
        }
        ROT_WDELTA16 => {
            let (_, last) = unpack_quat48(previous.expect("delta needs a predecessor"));
            let (_, current) = unpack_quat48(rotation);
            for slot in 0..3 {
                out.extend_from_slice(&((current[slot] - last[slot]) as i16).to_le_bytes());
            }
        }
        ROT_WFULL => write_wide_rotation(out, rotation),
        _ => write_u32le(out, rotation as u32),
    }
}

/// Wide absolute: index byte then three 16-bit components. Seven bytes against
/// the narrow four, paid only by roots whose island is big enough to need it.
/// Absolute rotation at a record's opening pose.
///
/// v1 wrote a bare 32-bit value with no mode byte, so it could only ever carry
/// one format. v2 prefixes the mode, which is what lets a wide root and a
/// narrow chunk share a stream.
fn write_absolute_rotation(out: &mut Vec<u8>, rotation: u64, wire_v2: bool) {
    if wire_v2 {
        let mode = if is_wide_rotation(rotation) {
            ROT_WFULL
        } else {
            ROT_FULL
        };
        out.push(mode);
        write_rotation(out, mode, None, rotation);
    } else {
        write_u32le(out, rotation as u32);
    }
}

fn read_absolute_rotation(input: &[u8], cursor: &mut usize, wire_v2: bool) -> Result<u64> {
    if !wire_v2 {
        return Ok(read_u32le(input, cursor)? as u64);
    }
    anyhow::ensure!(*cursor < input.len(), "absolute rotation truncated");
    let mode = input[*cursor];
    *cursor += 1;
    read_rotation(input, cursor, mode, None)
}

fn write_wide_rotation(out: &mut Vec<u8>, rotation: u64) {
    let (index, components) = unpack_quat48(rotation);
    out.push(index);
    for component in components {
        out.extend_from_slice(&(component as i16).to_le_bytes());
    }
}

fn read_wide_rotation(input: &[u8], cursor: &mut usize) -> Result<u64> {
    anyhow::ensure!(*cursor + ROTATION_WIDE_BYTES <= input.len(), "wide rotation truncated");
    let index = input[*cursor];
    anyhow::ensure!(index < 4, "wide rotation index out of range");
    *cursor += 1;
    let mut components = [0_i32; 3];
    for component in components.iter_mut() {
        let raw = i16::from_le_bytes([input[*cursor], input[*cursor + 1]]);
        *cursor += 2;
        *component = raw as i32;
    }
    Ok(pack_quat48(index, components))
}

fn read_rotation(
    input: &[u8],
    cursor: &mut usize,
    mode: u8,
    previous: Option<u64>,
) -> Result<u64> {
    Ok(match mode {
        ROT_HELD => previous.ok_or_else(|| anyhow::anyhow!("held rotation without a predecessor"))?,
        ROT_DELTA4 => {
            anyhow::ensure!(*cursor + 2 <= input.len(), "rotation delta truncated");
            let bits = u16::from_le_bytes([input[*cursor], input[*cursor + 1]]);
            *cursor += 2;
            let (index, last) =
                unpack_quat32(previous.expect("delta needs a predecessor") as u32);
            let mut components = [0_i32; 3];
            for slot in 0..3 {
                let nibble = ((bits >> (4 * slot)) & 0xf) as i32;
                let delta = if nibble & 0x8 != 0 { nibble - 16 } else { nibble };
                components[slot] = last[slot] + delta;
            }
            pack_quat32(index, components) as u64
        }
        ROT_DELTA8 => {
            anyhow::ensure!(*cursor + 3 <= input.len(), "rotation delta truncated");
            let (index, last) =
                unpack_quat32(previous.expect("delta needs a predecessor") as u32);
            let mut components = [0_i32; 3];
            for (slot, component) in components.iter_mut().enumerate() {
                *component = last[slot] + input[*cursor + slot] as i8 as i32;
            }
            *cursor += 3;
            pack_quat32(index, components) as u64
        }
        ROT_WDELTA8 => {
            anyhow::ensure!(*cursor + 3 <= input.len(), "wide rotation delta truncated");
            let (index, last) = unpack_quat48(previous.expect("delta needs a predecessor"));
            let mut components = [0_i32; 3];
            for (slot, component) in components.iter_mut().enumerate() {
                *component = last[slot] + input[*cursor + slot] as i8 as i32;
            }
            *cursor += 3;
            pack_quat48(index, components)
        }
        ROT_WDELTA16 => {
            anyhow::ensure!(*cursor + 6 <= input.len(), "wide rotation delta truncated");
            let (index, last) = unpack_quat48(previous.expect("delta needs a predecessor"));
            let mut components = [0_i32; 3];
            for (slot, component) in components.iter_mut().enumerate() {
                let raw = i16::from_le_bytes([input[*cursor], input[*cursor + 1]]);
                *cursor += 2;
                *component = last[slot] + raw as i32;
            }
            pack_quat48(index, components)
        }
        ROT_WFULL => read_wide_rotation(input, cursor)?,
        _ => read_u32le(input, cursor)? as u64,
    })
}

fn rotation_census(record: &Record) -> (u64, u64, u64) {
    let Record::SampleRun {
        frames, continuity, ..
    } = record
    else {
        return (0, 0, 0);
    };
    let mut resends = 0;
    let mut held = 0;
    let mut bytes = 0;
    let mut previous: Option<u64> = None;
    for (index, (_, rotation)) in frames.iter().enumerate() {
        if index == 0 && !*continuity {
            // The opening absolute pose always carries an orientation.
            previous = Some(*rotation);
            bytes += ROTATION_BYTES as u64;
            continue;
        }
        // Actual coded cost, so the share reported is what rotation now costs
        // rather than what it used to.
        let mode = rotation_mode(previous, *rotation);
        bytes += match mode {
            ROT_HELD => 0,
            ROT_DELTA4 => 2,
            ROT_DELTA8 => 3,
            _ => ROTATION_BYTES as u64,
        };
        if mode == ROT_HELD {
            held += 1;
        } else {
            resends += 1;
        }
        previous = Some(*rotation);
    }
    (resends, held, bytes)
}

fn update_tail(tails: &mut [Option<([i32; 3], u64)>], record: &Record) {
    if let Record::SampleRun { body, frames, .. } = record {
        if let (Some(slot), Some(last)) = (tails.get_mut(*body as usize), frames.last()) {
            *slot = Some(*last);
        }
    }
}

pub fn encode_block(
    records: &mut [Record],
    first_tick: u32,
    tails: &mut [Option<([i32; 3], u64)>],
    wire_v2: bool,
) -> Vec<u8> {
    // Deterministic order, grouped by type so the tag byte is implicit and
    // like fields sit next to like fields for the entropy stage.
    records.sort_by_key(|record| (record.kind_index(), record.body(), record.tick()));
    let mut payload = Vec::with_capacity(records.len() * 24);
    write_u32le(&mut payload, first_tick);
    for kind in 0..5 {
        let group: Vec<&Record> = records
            .iter()
            .filter(|record| record.kind_index() == kind)
            .collect();
        write_varint(&mut payload, group.len() as u64);
        for record in group {
            write_record(&mut payload, record, first_tick, tails, wire_v2);
            update_tail(tails, record);
        }
    }
    payload
}

/// Mirrors `encode_block`'s tail bookkeeping on the receiving side.
/// A parse-safe placeholder tail.
///
/// Continuity records are DELTA-coded against the receiver's tail, but their
/// byte LENGTHS never depend on the tail's values -- varints of deltas and
/// mode-tagged rotations parse identically against any seed. So a decoder that
/// lost a lane's history can still parse the packet against this placeholder
/// and let its gap rule discard the garbage records, instead of aborting the
/// whole packet and losing every innocent lane in it.
pub fn placeholder_tail() -> ([i32; 3], u64) {
    ([0, 0, 0], encode_quat32(Quat::IDENTITY) as u64)
}

pub fn decode_block(
    payload: &[u8],
    tails: &mut [Option<([i32; 3], u64)>],
    wire_v2: bool,
) -> Result<Vec<Record>> {
    let mut cursor = 0;
    let first_tick = read_u32le(payload, &mut cursor)?;
    let mut records = Vec::new();
    for kind in 0..5 {
        let count = read_varint(payload, &mut cursor)? as usize;
        for _ in 0..count {
            let record = read_record(payload, &mut cursor, kind, first_tick, tails, wire_v2)?;
            update_tail(tails, &record);
            records.push(record);
        }
    }
    anyhow::ensure!(cursor == payload.len(), "block has trailing bytes");
    Ok(records)
}

// ---------------------------------------------------------------------------
// Analytic evaluation -- shared by encoder and client model
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Analytic {
    tick: u32,
    position: Vec3,
    velocity: Vec3,
    rotation: Quat,
    angular: Vec3,
    /// False for supported motion, where the contact cancels gravity.
    gravity: bool,
}

impl Analytic {
    fn elapsed(&self, tick: u32, dt: f32) -> f32 {
        (tick.saturating_sub(self.tick)) as f32 * dt
    }

    fn acceleration(&self, gravity: Vec3) -> Vec3 {
        if self.gravity {
            gravity
        } else {
            Vec3::ZERO
        }
    }

    fn pose_at(&self, tick: u32, dt: f32, gravity: Vec3) -> Pose {
        let d = self.elapsed(tick, dt);
        let acceleration = self.acceleration(gravity);
        Pose {
            position: self.position + self.velocity * d + 0.5 * acceleration * d * d,
            rotation: (Quat::from_scaled_axis(self.angular * d) * self.rotation).normalize(),
        }
    }

    fn velocity_at(&self, tick: u32, dt: f32, gravity: Vec3) -> Vec3 {
        self.velocity + self.acceleration(gravity) * self.elapsed(tick, dt)
    }
}

fn interpolate_samples(a: Pose, b: Pose, t: f32) -> Pose {
    Pose {
        position: a.position.lerp(b.position, t),
        rotation: a.rotation.slerp(b.rotation, t).normalize(),
    }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Frame {
    tick: u32,
    pose: Pose,
    velocity: Vec3,
    angular: Vec3,
}

#[derive(Clone, Copy, Default)]
struct BodyFitter {
    analytic: Option<Analytic>,
    /// True once a REST has been emitted and nothing has moved since.
    parked: bool,
    /// Tick of the most recent segment open, used to detect a segment that
    /// died immediately -- the signal that the gravity mode was guessed wrong.
    last_open_tick: Option<u32>,
    last_gravity: bool,
    /// Consecutive sub-threshold ticks, for the modelled debris sleep policy.
    quiet_ticks: u32,
    /// Last sampled chain frame emitted for this body, or None when a segment,
    /// impulse or rest has since reset the receiver's basis. Lives on the
    /// fitter so the rate controller's rewind restores it with everything else.
    chain_tail: Option<([i32; 3], u64)>,
    /// Pose the client is holding while this body is parked. Waking is decided
    /// by how far truth has drifted from it, never by speed: a body creeping
    /// under the wake threshold would otherwise slide metres while the client
    /// shows it motionless.
    parked_pose: Option<Pose>,
}

#[derive(Clone, Copy)]
pub struct Tolerances {
    shell_m: f32,
    rotation_deg: f32,
    velocity_mps: f32,
    angular_rps: f32,
    /// Motion-masked precision, mirroring the live path so the byte comparison
    /// is against the same fidelity contract rather than a flat bound.
    mask: MaskConfig,
    /// Multiplier applied by the block rate controller; 1.0 when under budget.
    rate_scale: f32,
}

impl Tolerances {
    pub fn new(
        shell_m: f32,
        rotation_deg: f32,
        velocity_mps: f32,
        angular_rps: f32,
        mask: MaskConfig,
    ) -> Self {
        Self {
            shell_m,
            rotation_deg,
            velocity_mps,
            angular_rps,
            mask,
            rate_scale: 1.0,
        }
    }

    /// Per-body shell bound for this tick. With masking off this is the flat
    /// bound; with it on, a fast body is allowed the same slack the incumbent
    /// grants it.
    /// Bound for a body that other bodies are reconstructed from.
    ///
    /// Masking hands a body slack in proportion to ITS motion, but an island
    /// root's error lands on every member, and a member near the rotation axis
    /// moves slowly -- so it is held to a tighter bound than the root was
    /// fitted to, and the difference shows up as violations on the member. The
    /// base shell is the floor of `shell_for`, so holding a root to it is
    /// guaranteed to be inside every member's allowance. Derived, not tuned.
    fn shell_for_source(&self, state: &ActorState, radius: f32, strict: bool) -> f32 {
        if strict {
            self.shell_m * self.rate_scale
        } else {
            self.shell_for(state, radius)
        }
    }

    fn shell_for(&self, state: &ActorState, radius: f32) -> f32 {
        let masked = if self.mask.enabled {
            let motion = motion_magnitude(state.linear_velocity, state.angular_velocity, radius);
            (self.shell_m * self.mask.target_scale(motion)).min(self.mask.cap_m)
        } else {
            self.shell_m
        };
        // Rate control multiplies the *masked* bound, so an over-budget block
        // degrades precision on top of whatever masking already allowed rather
        // than fighting it. Scale is 1.0 unless a block busted its budget.
        masked * self.rate_scale
    }
}

/// Spec section 3.4: with only a short window there is no skip-to-rest, so the
/// lever is to sleep debris harder than the solver would. The encoder can model
/// that policy without touching the simulation -- a body under threshold for
/// `ticks` consecutive frames is declared at rest and costs nothing until it
/// moves again. Fidelity cost is real and shows up in the error statistics.
#[derive(Clone, Copy)]
pub struct SleepPolicy {
    pub linear_mps: f32,
    pub angular_rps: f32,
    pub ticks: u32,
}

impl SleepPolicy {
    /// Solver-reported sleep only; no modelled early rest.
    pub(crate) fn off() -> Self {
        Self {
            linear_mps: 0.0,
            angular_rps: 0.0,
            ticks: 0,
        }
    }

    fn enabled(&self) -> bool {
        self.ticks > 0
    }
}

/// Everything the fitter reads but never writes. Split out from the mutable
/// per-body state so a span can be finalized across bodies in parallel: each
/// lane touches only its own column, and the shared side is read-only.
pub(crate) struct EncoderConfig {
    dt: f32,
    gravity: Vec3,
    radii: Vec<f32>,
    tolerances: Tolerances,
    sleep: SleepPolicy,
    step_max_exp: u8,
    /// Sampled-run strides to consider, descending. The default caps a 120 Hz
    /// stream at 20 Hz effective sampling; a coarse LOD tier needs far longer
    /// strides, because loosening precision alone barely moves the rate --
    /// temporal reduction is what makes a coarse tier cheap.
    stride_ladder: Vec<u8>,
    second_order: bool,
    sync_min_radius_m: f32,
    /// Motion above which a sampled chain must actually move; see the coarse
    /// grid's continuity guard.
    continuity_epsilon_m: f32,
    /// Live wire: never emit continuity runs, so every record decodes with no
    /// carried tail state. This is what makes a datagram packet droppable --
    /// the measured cost of giving up cross-block continuation is 0.31% (R6).
    self_contained: bool,
    /// v2 prefixes every absolute rotation with its mode byte, which is what
    /// allows wide and narrow rotations in one stream. Set only by the island
    /// path, so the incumbent per-chunk wire stays byte-identical.
    wire_v2: bool,
    /// Bodies whose rotation is quantized on the wide grid. An island root
    /// earns this by its REACH: its members are rebuilt at a lever arm, so the
    /// root's angular quantum is multiplied by that arm before it lands on a
    /// member. Members themselves are never wide -- their own radius is the
    /// only arm they have.
    wide: Vec<bool>,
    /// Bodies other bodies are reconstructed from: island roots with derived
    /// members. They forgo masking slack; see `shell_for_source`.
    strict: Vec<bool>,
}

/// One body's private encoder state. Bodies are independent by construction --
/// no record references another body -- which is what makes the fan-out
/// byte-identical to the serial path rather than merely equivalent.
#[derive(Default)]
struct BodyLane {
    fitter: BodyFitter,
    frames: Vec<Frame>,
    records: Vec<Record>,
    has_rest: bool,
    records_total: u32,
    bytes_total: u64,
    rotation_resends: u64,
    rotation_held: u64,
    rotation_bytes: u64,
    spans_active: u64,
    spans_fallback: u64,
    kind_counts: [u64; 5],
    kind_bytes: [u64; 5],
}

/// One body's finalized span, returned by value so workers share nothing.
#[derive(Default)]
struct SpanOutcome {
    records: Vec<Record>,
    spans_active: u64,
    spans_fallback: u64,
    reopen: bool,
    chain_tail: Option<([i32; 3], u64)>,
    rotation_resends: u64,
    rotation_held: u64,
    rotation_bytes: u64,
    kind_counts: [u64; 5],
    kind_bytes: [u64; 5],
    records_total: u32,
    bytes_total: u64,
}

pub struct Encoder {
    config: EncoderConfig,
    lanes: Vec<BodyLane>,
    /// Mirror of the receiver's tail state, used for exact cost accounting.
    encode_tails: Vec<Option<([i32; 3], u64)>>,
    parallel: bool,
    impulse_candidates: u64,
    impulse_taken: u64,
    forced_rests: u64,
}

impl Encoder {
    pub fn new(
        body_count: usize,
        dt: f32,
        gravity: Vec3,
        radii: Vec<f32>,
        tolerances: Tolerances,
        sleep: SleepPolicy,
        step_max_exp: u8,
        stride_ladder: Vec<u8>,
        second_order: bool,
        sync_min_radius_m: f32,
        parallel: bool,
    ) -> Self {
        Self {
            config: EncoderConfig {
                dt,
                gravity,
                radii,
                tolerances,
                sleep,
                step_max_exp,
                stride_ladder,
                second_order,
                sync_min_radius_m,
                continuity_epsilon_m: tolerances.shell_m,
                wire_v2: false,
                wide: vec![false; body_count],
                strict: vec![false; body_count],
                self_contained: false,
            },
            lanes: (0..body_count).map(|_| BodyLane::default()).collect(),
            encode_tails: vec![None; body_count],
            parallel,
            impulse_candidates: 0,
            impulse_taken: 0,
            forced_rests: 0,
        }
    }

    /// Fitter state as of now, so a block can be re-encoded from its start.
    fn fitter_snapshot(&self) -> Vec<BodyFitter> {
        self.lanes.iter().map(|lane| lane.fitter).collect()
    }

    fn restore_fitters(&mut self, snapshot: &[BodyFitter]) {
        for (lane, fitter) in self.lanes.iter_mut().zip(snapshot) {
            lane.fitter = *fitter;
            lane.frames.clear();
            lane.records.clear();
            lane.has_rest = false;
        }
    }

    /// Encodes one block, re-running it at progressively looser bounds while it
    /// exceeds `budget_bytes`. Hindsight makes this exact: the block is already
    /// in the past, so its true compressed size is known before committing.
    /// Coverage is never dropped -- only precision -- which is the only
    /// degradation a full-world stream can afford.
    #[allow(clippy::too_many_arguments)]
    fn encode_block_within_budget(
        &mut self,
        pending: &mut Vec<Record>,
        block_first_tick: u32,
        span_ticks: u32,
        budget_bytes: Option<usize>,
        ladder: &[f32],
        block_states: &[Vec<ActorState>],
        block_open_fitters: &[BodyFitter],
    ) -> Result<(Vec<u8>, f32)> {
        // Tails advance as a block is written, so a retry must rewind them
        // alongside the fitters or the re-encode would code against state the
        // receiver never reaches.
        let tails_at_block_start = self.encode_tails.clone();
        let mut payload = encode_block(pending, block_first_tick, &mut self.encode_tails, self.config.wire_v2);
        let Some(budget) = budget_bytes else {
            return Ok((payload, 1.0));
        };
        if block_states.is_empty() {
            return Ok((payload, 1.0));
        }
        let mut applied = 1.0_f32;
        for &scale in ladder {
            if zstd::bulk::compress(&payload, 3)?.len() + 12 <= budget {
                break;
            }
            // Rewind to the block boundary and re-run it at a looser bound.
            self.config.tolerances.rate_scale = scale;
            self.restore_fitters(block_open_fitters);
            self.encode_tails.clone_from(&tails_at_block_start);
            pending.clear();
            for (offset, states) in block_states.iter().enumerate() {
                let tick = block_first_tick + offset as u32;
                self.push_tick(tick, states);
                if (tick + 1) % span_ticks == 0 {
                    self.finalize_span(block_first_tick, pending);
                }
            }
            self.finalize_span(block_first_tick, pending);
            payload = encode_block(pending, block_first_tick, &mut self.encode_tails, self.config.wire_v2);
            applied = scale;
        }
        self.config.tolerances.rate_scale = 1.0;
        Ok((payload, applied))
    }

    /// Forces this body's next record to stand alone: no carried chain, no
    /// running segment. Used when a body moves between tracks, since a track
    /// that references state published on a *different* track is not
    /// independently decodable, which is the whole point of splitting.
    pub fn force_restart(&mut self, body: usize) {
        if let Some(lane) = self.lanes.get_mut(body) {
            lane.fitter.analytic = None;
            lane.fitter.chain_tail = None;
            lane.fitter.parked = false;
            lane.fitter.parked_pose = None;
        }
        if let Some(tail) = self.encode_tails.get_mut(body) {
            *tail = None;
        }
    }

    /// Opens a recovery point: every body restarts absolute, and every body the
    /// stream is currently holding still is restated so a joining subscriber
    /// learns about it without having heard the original REST.
    ///
    /// This is what makes a track joinable mid-stream. Without it a subscriber
    /// inherits nothing and cannot place bodies that settled before it arrived.
    /// Restate one body absolutely: restart its fitter so the next emission
    /// opens absolute, and re-emit the Rest of a parked body (which would
    /// otherwise never speak again). The single-body form of `begin_keyframe`,
    /// for smearing restatement across spans instead of bursting it.
    /// Mirror externally-managed wire tails into the pricing state.
    ///
    /// `finalize_span` prices continuity candidates against
    /// `self.encode_tails`, which this encoder's own block path maintains. A
    /// caller that encodes through the free `encode_block` (the live wire)
    /// must hand its tails back, or every continuity candidate is priced with
    /// an absolute opening frame and loses the cost comparison it should win.
    /// Found as a 5.6 MB / trace regression: chains broke on cost, not
    /// mechanics, and only a record-level diff between drivers exposed it.
    pub fn sync_encode_tails(&mut self, tails: &[Option<([i32; 3], u64)>]) {
        self.encode_tails.clone_from_slice(tails);
    }

    /// Periodic absolute restatement for a live lossy wire, costing as little
    /// as each body's state allows.
    ///
    /// `force_restart` was measured to be the wrong tool for this: nuking the
    /// whole fitter breaks a healthy sampled chain AND its analytic, and the
    /// knock-on re-fitting halved the continuity share (86% -> 52%). What loss
    /// recovery actually requires is one ABSOLUTE record per body per period:
    ///
    ///   * sampled-chain rider  -> clear only the chain seed; the next run
    ///     opens absolute, the fitter state is untouched;
    ///   * analytic rider       -> full restart; re-opening a segment is one
    ///     ~30 B record and there is no chain to damage;
    ///   * parked               -> re-emit the Rest (caller budgets repeats).
    pub fn restate_body_live(&mut self, body: usize, tick: u32, out: &mut Vec<Record>) {
        if self.lanes[body].fitter.parked {
            self.restate_body(body, tick, out);
            return;
        }
        if self.lanes[body].fitter.chain_tail.is_some() {
            // Riding a sampled chain (the analytic is merely its shadow
            // predictor): clear only the seed so the next run opens absolute.
            self.lanes[body].fitter.chain_tail = None;
            if let Some(slot) = self.encode_tails.get_mut(body) {
                *slot = None;
            }
            return;
        }
        // Analytic rider: re-opening a segment is one ~30 B record and there
        // is no chain to damage.
        self.force_restart(body);
    }

    /// Whether a body is parked (at rest, represented by a terminal Rest).
    pub fn is_parked(&self, body: usize) -> bool {
        self.lanes[body].fitter.parked
    }

    pub fn restate_body(&mut self, body: usize, tick: u32, out: &mut Vec<Record>) {
        let parked_pose = self.lanes[body].fitter.parked_pose;
        self.force_restart(body);
        if let Some(pose) = parked_pose {
            let (position, rotation) = quantize_pose_with(pose, self.config.wide[body]);
            out.push(Record::Rest {
                body: body as u32,
                tick,
                position,
                rotation,
            });
            self.lanes[body].fitter.parked = true;
            self.lanes[body].fitter.parked_pose = Some(pose);
        }
    }

    pub fn begin_keyframe(&mut self, tick: u32, out: &mut Vec<Record>) {
        for body in 0..self.lanes.len() {
            let parked_pose = self.lanes[body].fitter.parked_pose;
            self.force_restart(body);
            if let Some(pose) = parked_pose {
                let (position, rotation) = quantize_pose_with(pose, self.config.wide[body]);
                // Restated as a rest record, and the lane goes back to parked so
                // the body stays free until it actually moves again.
                out.push(Record::Rest {
                    body: body as u32,
                    tick,
                    position,
                    rotation,
                });
                self.lanes[body].fitter.parked = true;
                self.lanes[body].fitter.parked_pose = Some(pose);
            }
        }
    }

    pub(crate) fn kind_count(&self, kind: usize) -> u64 {
        self.lanes.iter().map(|lane| lane.kind_counts[kind]).sum()
    }

    pub(crate) fn kind_byte(&self, kind: usize) -> u64 {
        self.lanes.iter().map(|lane| lane.kind_bytes[kind]).sum()
    }

    fn rotation_resends(&self) -> u64 {
        self.lanes.iter().map(|lane| lane.rotation_resends).sum()
    }

    fn rotation_held(&self) -> u64 {
        self.lanes.iter().map(|lane| lane.rotation_held).sum()
    }

    fn rotation_bytes(&self) -> u64 {
        self.lanes.iter().map(|lane| lane.rotation_bytes).sum()
    }

    fn spans_active(&self) -> u64 {
        self.lanes.iter().map(|lane| lane.spans_active).sum()
    }

    fn spans_fallback(&self) -> u64 {
        self.lanes.iter().map(|lane| lane.spans_fallback).sum()
    }

    /// One tick of every body.
    pub fn push_tick_public(&mut self, tick: u32, states: &[ActorState]) {
        self.push_tick(tick, states);
    }

    fn push_tick(&mut self, tick: u32, states: &[ActorState]) {
        for (body, state) in states.iter().enumerate() {
            self.push(body, tick, state);
        }
    }

    /// Turn on the v2 wire. Absolute rotations gain a mode byte, so this is a
    /// format change and only the island path takes it.
    /// Live wire mode: self-contained records only (no continuity tails).
    pub fn set_self_contained(&mut self, enabled: bool) {
        self.config.self_contained = enabled;
    }

    pub fn enable_wire_v2(&mut self) {
        self.config.wire_v2 = true;
    }

    /// Restate which bodies quantize rotation on the wide grid.
    pub fn set_wide(&mut self, wide: &[bool]) {
        self.config.wide.copy_from_slice(wide);
    }

    /// Restate which bodies are reconstruction sources for others.
    pub fn set_strict(&mut self, strict: &[bool]) {
        self.config.strict.copy_from_slice(strict);
    }

    /// Restate a body's shell radius.
    ///
    /// Island membership changes what a root has to hold: the bound covers the
    /// whole island's reach, not the root chunk's own size.
    pub fn set_radii(&mut self, radii: &[f32]) {
        self.config.radii.copy_from_slice(radii);
    }

    /// One tick of one body. Emits into the span buffer; the span is finalized
    /// later, once hindsight is available.
    pub fn push(&mut self, body: usize, tick: u32, state: &ActorState) {
        let pose = state.pose;
        let radius = self.config.radii[body];
        // Class C: below the sync threshold a body is never replicated at all.
        // The client is expected to substitute a locally simulated cosmetic
        // piece seeded from the fracture event; measuring that client is out of
        // scope here, so this measures only the size of the lever.
        if radius < self.config.sync_min_radius_m {
            return;
        }

        // Asleep or still kinematic: one REST, then free. Kinematic parts are
        // the not-yet-broken structure; they cost a single record each.
        if state.sleeping() || state.kinematic() {
            if !self.lanes[body].fitter.parked {
                let (position, rotation) = quantize_pose_with(pose, self.config.wide[body]);
                self.emit(
                    body,
                    Record::Rest {
                        body: body as u32,
                        tick,
                        position,
                        rotation,
                    },
                );
                self.lanes[body].has_rest = true;
                self.lanes[body].fitter.parked = true;
                self.lanes[body].fitter.parked_pose = Some(dequantize_pose(position, rotation));
                self.lanes[body].fitter.analytic = None;
            }
            return;
        }

        if self.config.sleep.enabled() {
            let speed = state.linear_velocity.length();
            let spin = state.angular_velocity.length();
            if speed <= self.config.sleep.linear_mps && spin <= self.config.sleep.angular_rps {
                self.lanes[body].fitter.quiet_ticks += 1;
            } else {
                self.lanes[body].fitter.quiet_ticks = 0;
            }
            if self.lanes[body].fitter.parked {
                // Stay parked only while the held pose still represents truth.
                let drifted = self.lanes[body].fitter.parked_pose.is_none_or(|held| {
                    rigid_shell_error_meters(pose, held, radius)
                        > self.config.tolerances.shell_for_source(
                            state,
                            radius,
                            self.config.strict[body],
                        )
                });
                if !drifted {
                    return;
                }
                self.lanes[body].fitter.quiet_ticks = 0;
                self.lanes[body].fitter.parked_pose = None;
            } else if self.lanes[body].fitter.quiet_ticks >= self.config.sleep.ticks {
                let (position, rotation) = quantize_pose_with(pose, self.config.wide[body]);
                self.emit(
                    body,
                    Record::Rest {
                        body: body as u32,
                        tick,
                        position,
                        rotation,
                    },
                );
                self.lanes[body].has_rest = true;
                self.lanes[body].fitter.parked = true;
                self.lanes[body].fitter.parked_pose = Some(dequantize_pose(position, rotation));
                self.lanes[body].fitter.analytic = None;
                self.forced_rests += 1;
                return;
            }
        }

        self.lanes[body].fitter.parked = false;
        self.lanes[body].fitter.parked_pose = None;
        self.lanes[body].frames.push(Frame {
            tick,
            pose,
            velocity: state.linear_velocity,
            angular: state.angular_velocity,
        });

        let Some(analytic) = self.lanes[body].fitter.analytic else {
            self.open_segment(body, tick, state, None);
            return;
        };

        let predicted = analytic.pose_at(tick, self.config.dt, self.config.gravity);
        let shell = rigid_shell_error_meters(pose, predicted, radius);
        let rotation_error = angular_error_degrees(pose.rotation, predicted.rotation);
        // A large body's shell error is dominated by orientation: at radius 4 m
        // a single smallest-three quantum already costs centimetres. Holding
        // such a body to a tolerance the wire cannot represent makes the fitter
        // reopen a segment every tick and never improve. The achievable floor is
        // the error of re-encoding truth itself.
        let (floor_position, floor_rotation) = quantize_pose_with(pose, self.config.wide[body]);
        let floor = rigid_shell_error_meters(
            pose,
            dequantize_pose(floor_position, floor_rotation),
            radius,
        );
        let shell_tolerance = self
            .config
            .tolerances
            .shell_for_source(state, radius, self.config.strict[body])
            .max(floor * 1.05);
        let predicted_velocity = analytic.velocity_at(tick, self.config.dt, self.config.gravity);
        let delta_velocity = state.linear_velocity - predicted_velocity;
        let delta_angular = state.angular_velocity - analytic.angular;

        let discontinuity = delta_velocity.length() > self.config.tolerances.velocity_mps
            || delta_angular.length() > self.config.tolerances.angular_rps;

        if discontinuity {
            self.impulse_candidates += 1;
            // An impulse cannot correct position: the client continues from its
            // own prediction. It is only admissible while the pose it would
            // inherit is still inside tolerance.
            if shell <= shell_tolerance && rotation_error <= self.config.tolerances.rotation_deg {
                let quantized_velocity = quantize_scaled(delta_velocity, VELOCITY_STEP_MPS);
                let quantized_angular = quantize_scaled(delta_angular, ANGULAR_STEP_RPS);
                self.lanes[body].fitter.analytic = Some(Analytic {
                    tick,
                    position: predicted.position,
                    velocity: predicted_velocity
                        + dequantize_scaled(quantized_velocity, VELOCITY_STEP_MPS),
                    rotation: predicted.rotation,
                    angular: analytic.angular
                        + dequantize_scaled(quantized_angular, ANGULAR_STEP_RPS),
                    gravity: analytic.gravity,
                });
                self.emit(
                    body,
                    Record::Impulse {
                        body: body as u32,
                        tick,
                        delta_velocity: quantized_velocity,
                        delta_angular: quantized_angular,
                    },
                );
                self.impulse_taken += 1;
                return;
            }
            self.open_segment(body, tick, state, Some(analytic));
            return;
        }

        if shell > shell_tolerance || rotation_error > self.config.tolerances.rotation_deg {
            self.open_segment(body, tick, state, Some(analytic));
        }
        // Otherwise the tick is free: the client's evaluation already agrees.
    }

    /// Opens a segment. `previous` is the arc being replaced, if any; a segment
    /// that survived only one tick means the gravity mode was guessed wrong, so
    /// the replacement flips it rather than repeating the mistake.
    fn open_segment(
        &mut self,
        body: usize,
        tick: u32,
        state: &ActorState,
        previous: Option<Analytic>,
    ) {
        let died_immediately = previous.is_some()
            && self.lanes[body].fitter
                .last_open_tick
                .is_some_and(|opened| tick.saturating_sub(opened) <= 1);
        let use_gravity = if died_immediately {
            !self.lanes[body].fitter.last_gravity
        } else {
            // A body in contact is being held up by something; free bodies fall.
            state.contacts == 0
        };

        let (position, rotation) = quantize_pose_with(state.pose, self.config.wide[body]);
        let velocity = quantize_scaled(state.linear_velocity, VELOCITY_STEP_MPS);
        let angular = quantize_scaled(state.angular_velocity, ANGULAR_STEP_RPS);
        // Quantization feedback: the fitter now tracks exactly what the client
        // will reconstruct, not what the simulation reported.
        self.lanes[body].fitter.analytic = Some(Analytic {
            tick,
            position: dequantize_position(position),
            velocity: dequantize_scaled(velocity, VELOCITY_STEP_MPS),
            rotation: decode_rotation(rotation),
            angular: dequantize_scaled(angular, ANGULAR_STEP_RPS),
            gravity: use_gravity,
        });
        self.lanes[body].fitter.last_open_tick = Some(tick);
        self.lanes[body].fitter.last_gravity = use_gravity;
        self.emit(
            body,
            Record::Segment {
                body: body as u32,
                tick,
                gravity: use_gravity,
                position,
                rotation,
                velocity,
                angular,
            },
        );
    }

    fn emit(&mut self, body: usize, record: Record) {
        self.lanes[body].records.push(record);
    }

    /// Closes every body's span: picks codec records or the sampled floor,
    /// whichever is cheaper, and hands the winner to the block assembler.
    ///
    /// Bodies are finalized independently, so this is the fan-out point. The
    /// output is appended in body order regardless of completion order, which
    /// is what keeps the parallel path byte-identical to the serial one.
    pub fn finalize_span(&mut self, block_first_tick: u32, out: &mut Vec<Record>) {
        let config = &self.config;
        let tails = &self.encode_tails;
        let finalize = |body: usize,
                        frames: &mut Vec<Frame>,
                        records: &mut Vec<Record>,
                        had_rest: bool,
                        tail: Option<([i32; 3], u64)>|
         -> SpanOutcome {
            let frames = std::mem::take(frames);
            let mut records = std::mem::take(records);
            let mut outcome = SpanOutcome::default();

            if records.is_empty() {
                // Either free-running inside an open segment, or parked.
                if !frames.is_empty() {
                    outcome.spans_active = 1;
                }
                return outcome;
            }
            outcome.spans_active = 1;

            let codec_bytes: usize = records
                .iter()
                .map(|record| record.encoded_len(block_first_tick, tails, self.config.wire_v2))
                .sum();

            // A span holding a single analytic record is a model that is
            // *working*: that record can run free across later spans, so its
            // real cost is amortized over a lifetime the per-span comparison
            // cannot see. Trading it for samples that must be re-paid every span
            // is a false economy -- and worse, the teardown forces a fresh
            // segment next span, so the body thrashes between modes forever.
            // Only bodies emitting repeatedly within one span are genuinely
            // failing to fit, and those are the ones the fallback is for.
            let model_is_struggling = records.len() >= 2;

            // REST is terminal and already minimal; never trade it for samples.
            if !had_rest && model_is_struggling && frames.len() > 1 {
                if let Some(sample) = config.best_sample_run(body, &frames, tail, tails) {
                    let sample_bytes = sample.encoded_len(block_first_tick, tails, self.config.wire_v2);
                    if sample_bytes < codec_bytes {
                        // The sampled span supersedes the analytic one, so the
                        // body must reopen with a fresh segment next span.
                        outcome.reopen = true;
                        records = vec![sample];
                        outcome.spans_fallback = 1;
                    }
                }
            }

            for record in &records {
                let (resends, held, rotation_bytes) = rotation_census(record);
                outcome.rotation_resends += resends;
                outcome.rotation_held += held;
                outcome.rotation_bytes += rotation_bytes;
                let bytes = record.encoded_len(block_first_tick, tails, self.config.wire_v2) as u64;
                outcome.kind_bytes[record.kind_index()] += bytes;
                outcome.kind_counts[record.kind_index()] += 1;
                outcome.records_total += 1;
                outcome.bytes_total += bytes;
            }
            // The receiver's basis after this span: a lone sampled run leaves a
            // chain to continue from, anything else resets it.
            outcome.chain_tail = match records.as_slice() {
                [Record::SampleRun { frames, .. }] => frames.last().copied(),
                _ => None,
            };
            outcome.records = records;
            outcome
        };

        // Take each body's span data out first, so every job owns what it
        // touches and the workers need nothing but the shared read-only config.
        let mut jobs: Vec<(
            usize,
            Vec<Frame>,
            Vec<Record>,
            bool,
            Option<([i32; 3], u64)>,
        )> = Vec::new();
        for (body, lane) in self.lanes.iter_mut().enumerate() {
            if lane.frames.is_empty() && lane.records.is_empty() {
                continue;
            }
            jobs.push((
                body,
                std::mem::take(&mut lane.frames),
                std::mem::take(&mut lane.records),
                std::mem::replace(&mut lane.has_rest, false),
                if self.config.self_contained {
                    // No chain seed: every sampled run opens absolute.
                    None
                } else {
                    lane.fitter.chain_tail
                },
            ));
        }

        let threads = if self.parallel {
            std::thread::available_parallelism()
                .map_or(1, |count| count.get())
                .min(jobs.len().max(1))
        } else {
            1
        };

        let mut results: Vec<Option<SpanOutcome>> = (0..jobs.len()).map(|_| None).collect();
        if threads <= 1 {
            for (slot, job) in results.iter_mut().zip(&mut jobs) {
                *slot = Some(finalize(job.0, &mut job.1, &mut job.2, job.3, job.4));
            }
        } else {
            let next = AtomicUsize::new(0);
            let jobs_ref = &jobs;
            let finalize_ref = &finalize;
            let completed: Vec<(usize, SpanOutcome)> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..threads)
                    .map(|_| {
                        scope.spawn(|| {
                            let mut local = Vec::new();
                            loop {
                                // Dynamic hand-out: a settled body finalizes in
                                // nanoseconds while a tumbling one runs the full
                                // stride x step search, so fixed ranges would
                                // leave most threads idle.
                                let index = next.fetch_add(1, AtomicOrdering::Relaxed);
                                let Some((body, frames, records, had_rest, tail)) =
                                    jobs_ref.get(index)
                                else {
                                    break;
                                };
                                let mut frames = frames.clone();
                                let mut records = records.clone();
                                local.push((
                                    index,
                                    finalize_ref(
                                        *body,
                                        &mut frames,
                                        &mut records,
                                        *had_rest,
                                        *tail,
                                    ),
                                ));
                            }
                            local
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .flat_map(|handle| handle.join().expect("span worker panicked"))
                    .collect()
            });
            // Keyed by job index, never by completion order.
            for (index, outcome) in completed {
                results[index] = Some(outcome);
            }
        }

        for (job, outcome) in jobs.iter().zip(results) {
            let Some(outcome) = outcome else { continue };
            let lane = &mut self.lanes[job.0];
            lane.spans_active += outcome.spans_active;
            lane.spans_fallback += outcome.spans_fallback;
            if outcome.reopen {
                lane.fitter.analytic = None;
            }
            lane.fitter.chain_tail = if self.config.self_contained {
                None
            } else {
                outcome.chain_tail
            };
            for kind in 0..5 {
                lane.kind_counts[kind] += outcome.kind_counts[kind];
                lane.kind_bytes[kind] += outcome.kind_bytes[kind];
            }
            lane.records_total += outcome.records_total;
            lane.bytes_total += outcome.bytes_total;
            lane.rotation_resends += outcome.rotation_resends;
            lane.rotation_held += outcome.rotation_held;
            lane.rotation_bytes += outcome.rotation_bytes;
            out.extend(outcome.records);
        }
    }

}

impl EncoderConfig {
    /// Cheapest sampled representation of this span that still holds the
    /// bound: the largest stride and coarsest delta grid whose *reconstructed
    /// chain* -- the exact positions the client will rebuild -- stays inside
    /// every frame's masked tolerance. Hindsight makes this an exact search
    /// rather than a heuristic, which is the whole reason the window exists.
    fn best_sample_run(
        &self,
        body: usize,
        frames: &[Frame],
        tail: Option<([i32; 3], u64)>,
        tails: &[Option<([i32; 3], u64)>],
    ) -> Option<Record> {
        // Frame index must equal tick offset, or the receiver cannot map a tick
        // back to an interval. A body that slept mid-span leaves a gap.
        let contiguous = frames
            .iter()
            .enumerate()
            .all(|(index, frame)| frame.tick == frames[0].tick + index as u32);
        if !contiguous {
            return None;
        }
        let last_offset = frames[frames.len() - 1].tick - frames[0].tick;
        if last_offset > u8::MAX as u32 {
            return None;
        }
        // Coarser grids drift up to half a step from truth, and every span
        // restarts on the fine grid, so that drift is paid back as a backwards
        // snap at the boundary -- a reversal. The cap is what keeps the snap
        // under the artifact gates.
        let ladder: Vec<u8> = (0..=self.step_max_exp).rev().collect();
        let mut best: Option<(usize, Record)> = None;
        // A continuity run is nearly always cheaper, but it can fail the
        // validator when the carried chain has drifted, so both are offered
        // and the measured cost decides.
        let seeds: Vec<Option<([i32; 3], u64)>> = match tail {
            Some(tail) => vec![Some(tail), None],
            None => vec![None],
        };
        // Descending, so the cheapest candidate is priced first and the cost
        // floor can stop the search early.
        for stride in self.stride_ladder.clone() {
            // Cost floor for this stride: every candidate at this stride emits
            // at least this many bytes, whatever grid or framing it picks. Once
            // the floor exceeds the best measured candidate, no finer stride
            // can win either -- strides only get more expensive from here --
            // so the search stops rather than validating hundreds of ticks for
            // a candidate that cannot be chosen. Byte-identical by
            // construction: only provably-losing candidates are skipped.
            let frame_count = frames.len().div_ceil(stride as usize).max(2);
            let floor = SAMPLE_RUN_HEADER_BYTES + SAMPLE_FRAME_FLOOR_BYTES * (frame_count - 1);
            if best.as_ref().is_some_and(|(cost, _)| floor >= *cost) {
                break;
            }
            for &step_exp in &ladder {
              for &seed in &seeds {
                let Some((record, indices)) =
                    self.sample_candidate(body, frames, stride, step_exp, seed)
                else {
                    continue;
                };
                // Both framings describe the identical chain, so the choice is
                // decided by measured output, never by an estimate.
                let mut cheapest: Option<(usize, Record)> = None;
                for second_order in [false, true] {
                    if second_order && !self.second_order {
                        continue;
                    }
                    let mut candidate = record.clone();
                    if let Record::SampleRun { second_order: flag, .. } = &mut candidate {
                        *flag = second_order;
                    }
                    let cost = candidate.encoded_len(frames[0].tick, tails, self.wire_v2);
                    if cheapest.as_ref().is_none_or(|(best, _)| cost < *best) {
                        cheapest = Some((cost, candidate));
                    }
                }
                let Some((cost, candidate)) = cheapest else {
                    continue;
                };
                // Price before validating: validation walks every tick of the
                // span, and a candidate that cannot beat the incumbent will not
                // be chosen however valid it is. Skipping only provably-losing
                // candidates keeps the output byte-identical.
                if best.as_ref().is_some_and(|(best_cost, _)| cost >= *best_cost) {
                    continue;
                }
                if !self.validate_sample_candidate(body, frames, &candidate, &indices) {
                    continue;
                }
                best = Some((cost, candidate));
              }
            }
        }
        best.map(|(_, record)| record)
    }

    /// Builds one (stride, step) candidate and validates it, or `None` if the
    /// reconstruction leaves tolerance at any tick of the span.
    #[allow(clippy::too_many_arguments)]
    fn sample_candidate(
        &self,
        body: usize,
        frames: &[Frame],
        stride: u8,
        step_exp: u8,
        tail: Option<([i32; 3], u64)>,
    ) -> Option<(Record, Vec<usize>)> {
        let stride_usize = stride as usize;
        let mut indices: Vec<usize> = (0..frames.len()).step_by(stride_usize).collect();
        if *indices.last()? != frames.len() - 1 {
            indices.push(frames.len() - 1);
        }
        if indices.len() < 2 {
            return None;
        }

        // Build the chain exactly as the receiver will: the first frame is
        // absolute on the millimetre grid, and every later frame is the
        // previous one plus a delta rounded onto the coarse grid. Validating
        // anything other than this chain would measure a stream we do not send.
        let step = 1_i64 << step_exp;
        let mut chain: Vec<([i32; 3], u64)> = Vec::with_capacity(indices.len());
        for (slot, &index) in indices.iter().enumerate() {
            let (target, rotation) = quantize_pose_with(frames[index].pose, self.wide[body]);
            if slot == 0 && tail.is_none() {
                chain.push((target, rotation));
                continue;
            }
            let previous = if slot == 0 {
                tail.expect("continuity seed").0
            } else {
                chain[slot - 1].0
            };
            let mut position = [0_i32; 3];
            let mut moved = false;
            for axis in 0..3 {
                let delta = target[axis] as i64 - previous[axis] as i64;
                let rounded = (delta as f64 / step as f64).round() as i64 * step;
                moved |= rounded != 0;
                position[axis] = (previous[axis] as i64 + rounded) as i32;
            }
            // Precision may loosen; continuity may not. A coarse grid rounds a
            // slow body's delta to zero, and the chain then holds position
            // while truth keeps sliding -- inside the error bound the whole
            // time, but visibly stop-motion. This is the same failure the L1
            // masking-continuity fix addressed, and the error bound alone
            // cannot see it, so reject the candidate outright.
            let travelled = if slot == 0 {
                // Seeded from the tail: the guard has no earlier frame to
                // compare against, so only the coded motion matters.
                f32::INFINITY
            } else {
                frames[index]
                    .pose
                    .position
                    .distance(frames[indices[slot - 1]].pose.position)
            };
            if !moved && travelled > self.continuity_epsilon_m {
                return None;
            }
            chain.push((position, rotation));
        }
        Some((
            Record::SampleRun {
                body: body as u32,
                tick: frames[0].tick,
                stride,
                last_offset: (frames[frames.len() - 1].tick - frames[0].tick) as u8,
                continuity: tail.is_some(),
                second_order: false,
                step_exp,
                frames: chain,
            },
            indices,
        ))
    }

    /// Checks a built candidate against truth at every tick of the span.
    ///
    /// Split from construction because it is the expensive half -- O(span
    /// ticks) shell evaluations -- and the search can price a candidate before
    /// deciding whether it is even worth validating.
    fn validate_sample_candidate(
        &self,
        body: usize,
        frames: &[Frame],
        record: &Record,
        indices: &[usize],
    ) -> bool {
        let radius = self.radii[body];
        let Record::SampleRun { frames: chain, .. } = record else {
            return false;
        };
        let reconstructed: Vec<Pose> = chain
            .iter()
            .map(|&(position, rotation)| dequantize_pose(position, rotation))
            .collect();

        for (slot, window) in indices.windows(2).enumerate() {
            let (start, end) = (window[0], window[1]);
            let span = (end - start) as f32;
            for index in start..=end {
                let t = if span > 0.0 {
                    (index - start) as f32 / span
                } else {
                    0.0
                };
                let sampled = interpolate_samples(reconstructed[slot], reconstructed[slot + 1], t);
                let truth = frames[index].pose;
                let (floor_position, floor_rotation) = quantize_pose_with(truth, self.wide[body]);
                let floor = rigid_shell_error_meters(
                    truth,
                    dequantize_pose(floor_position, floor_rotation),
                    radius,
                );
                let frame_state = ActorState {
                    pose: truth,
                    linear_velocity: frames[index].velocity,
                    angular_velocity: frames[index].angular,
                    contacts: 0,
                    intact_joints: 0,
                    flags: 0,
                };
                if rigid_shell_error_meters(truth, sampled, radius)
                    > self
                        .tolerances
                        .shell_for_source(&frame_state, radius, self.strict[body])
                        .max(floor * 1.05)
                    || angular_error_degrees(truth.rotation, sampled.rotation)
                        > self.tolerances.rotation_deg
                {
                    return false;
                }
            }
        }
        true
    }
}

// ---------------------------------------------------------------------------
// Client model -- rebuilds every displayed pose from re-parsed wire bytes
// ---------------------------------------------------------------------------

struct SampleWindow {
    start: u32,
    stride: u32,
    last_offset: u32,
    poses: Vec<Pose>,
}

impl SampleWindow {
    /// Tick offset of frame `index`; the final frame is pinned to the span end.
    fn offset_of(&self, index: usize) -> u32 {
        if index + 1 == self.poses.len() {
            self.last_offset
        } else {
            (index as u32 * self.stride).min(self.last_offset)
        }
    }

    fn pose_at(&self, tick: u32) -> Option<Pose> {
        if tick < self.start {
            return None;
        }
        let offset = tick - self.start;
        if offset > self.last_offset {
            // Run expired; the caller falls back to hold-last.
            return self.poses.last().copied();
        }
        let slot = ((offset / self.stride) as usize).min(self.poses.len().saturating_sub(2));
        let (from, to) = (self.offset_of(slot), self.offset_of(slot + 1));
        let span = to.saturating_sub(from);
        let t = if span == 0 {
            0.0
        } else {
            (offset - from) as f32 / span as f32
        };
        Some(interpolate_samples(self.poses[slot], self.poses[slot + 1], t))
    }
}

#[derive(Default)]
pub struct Playback {
    pub events: Vec<Record>,
    cursor: usize,
    analytic: Option<Analytic>,
    samples: Option<SampleWindow>,
    parked: Option<Pose>,
}

impl Playback {
    pub fn advance_to(&mut self, tick: u32, dt: f32, gravity: Vec3) {
        while self.cursor < self.events.len() && self.events[self.cursor].tick() <= tick {
            let event = self.events[self.cursor].clone();
            self.cursor += 1;
            match event {
                Record::Segment {
                    tick,
                    gravity: uses_gravity,
                    position,
                    rotation,
                    velocity,
                    angular,
                    ..
                } => {
                    self.samples = None;
                    self.parked = None;
                    self.analytic = Some(Analytic {
                        tick,
                        position: dequantize_position(position),
                        velocity: dequantize_scaled(velocity, VELOCITY_STEP_MPS),
                        rotation: decode_rotation(rotation),
                        angular: dequantize_scaled(angular, ANGULAR_STEP_RPS),
                        gravity: uses_gravity,
                    });
                }
                Record::Impulse {
                    tick,
                    delta_velocity,
                    delta_angular,
                    ..
                } => {
                    if let Some(analytic) = self.analytic {
                        let pose = analytic.pose_at(tick, dt, gravity);
                        let velocity = analytic.velocity_at(tick, dt, gravity);
                        self.analytic = Some(Analytic {
                            tick,
                            position: pose.position,
                            velocity: velocity
                                + dequantize_scaled(delta_velocity, VELOCITY_STEP_MPS),
                            rotation: pose.rotation,
                            angular: analytic.angular
                                + dequantize_scaled(delta_angular, ANGULAR_STEP_RPS),
                            gravity: analytic.gravity,
                        });
                    }
                }
                Record::SampleRun {
                    tick,
                    stride,
                    last_offset,
                    frames,
                    ..
                } => {
                    self.analytic = None;
                    self.parked = None;
                    let poses: Vec<Pose> = frames
                        .into_iter()
                        .map(|(position, rotation)| dequantize_pose(position, rotation))
                        .collect();
                    self.samples = Some(SampleWindow {
                        start: tick,
                        stride: (stride as u32).max(1),
                        last_offset: last_offset as u32,
                        poses,
                    });
                }
                Record::Rest {
                    position, rotation, ..
                } => {
                    self.analytic = None;
                    self.samples = None;
                    self.parked = Some(dequantize_pose(position, rotation));
                }
            }
        }
    }

    pub fn pose_at(&self, tick: u32, dt: f32, gravity: Vec3) -> Option<Pose> {
        if let Some(window) = &self.samples {
            if let Some(pose) = window.pose_at(tick) {
                return Some(pose);
            }
        }
        if let Some(analytic) = self.analytic {
            return Some(analytic.pose_at(tick, dt, gravity));
        }
        self.parked
    }

    /// True while the client is deliberately holding this body still, so the
    /// freeze detector can tell intended stillness from a stalled stream.
    /// Rewinds to before the first record so the same decoded stream can be
    /// replayed for another viewer without decoding it again.
    pub fn rewind(&mut self) {
        self.cursor = 0;
        self.analytic = None;
        self.samples = None;
        self.parked = None;
    }

    /// Tick of the most recent record applied, or None if nothing has been
    /// applied yet. A subscriber uses this to pick between two tracks that both
    /// carry a body: the freshest one is the one that currently owns it.
    pub fn last_event_tick(&self) -> Option<u32> {
        self.cursor
            .checked_sub(1)
            .and_then(|index| self.events.get(index))
            .map(|record| record.tick())
    }

    pub fn is_parked(&self) -> bool {
        self.samples.is_none() && self.analytic.is_none() && self.parked.is_some()
    }

    /// Velocity the wire states directly. `None` for sampled runs, which carry
    /// poses only and must be finite-differenced like any sampled stream.
    pub fn velocity_at(&self, tick: u32, dt: f32, gravity: Vec3) -> Option<(Vec3, Vec3)> {
        if self.samples.is_some() {
            return None;
        }
        let analytic = self.analytic?;
        Some((analytic.velocity_at(tick, dt, gravity), analytic.angular))
    }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct BlockReport {
    first_tick: u32,
    payload_bytes: usize,
    compressed_bytes: usize,
    mbps: f64,
}

#[derive(Serialize)]
struct DebrisReport {
    trace: String,
    bodies: usize,
    ticks: u32,
    physics_hz: u32,
    duration_seconds: f64,
    shell_tolerance_cm: f32,
    rotation_tolerance_degrees: f32,
    velocity_tolerance_mps: f32,
    flush_span_ticks: u32,
    block_ticks: u32,
    required_lead_ms: f64,
    uncompressed_bytes: u64,
    compressed_bytes: u64,
    header_bytes: u64,
    /// Island-stream mode only. Zero elsewhere, so a report from the per-chunk
    /// path stays comparable field for field.
    island_stream: bool,
    islands_peak: u64,
    topology_bytes: u64,
    topology_blocks: u64,
    total_with_topology_bytes: u64,
    average_mbps: f64,
    p50_block_mbps: f64,
    p95_block_mbps: f64,
    peak_block_mbps: f64,
    bytes_per_body_tick: f64,
    segments: u64,
    ballistic_segments: u64,
    supported_segments: u64,
    impulses: u64,
    sample_runs: u64,
    rests: u64,
    forced_rests: u64,
    sleep_ticks: u32,
    records_per_body_second: f64,
    impulse_admission_rate: f64,
    fallback_fraction: f64,
    sampled_frames: u64,
    rotation_resends: u64,
    rotation_held: u64,
    rotation_bytes: u64,
    rotation_pct_of_payload: f64,
    segment_bytes: u64,
    impulse_bytes: u64,
    sample_run_bytes: u64,
    rest_bytes: u64,
    max_shell_error_cm: f32,
    p95_shell_error_cm: f32,
    max_rotation_error_degrees: f32,
    tolerance_violations: u64,
    evaluated_samples: u64,
    out_of_world_samples: u64,
    sync_min_radius_m: f32,
    unsynced_bodies: usize,
    budget_mbps: Option<f64>,
    rate_limited_blocks: usize,
    max_rate_scale: f32,
    encode_seconds: f64,
    realtime_encode_factor: f64,
    encode_ms_p50_per_block: f64,
    encode_ms_p95_per_block: f64,
    encode_ms_max_per_block: f64,
    acceptance: VisualAcceptance,
    live_reference_bytes: u64,
    ratio_vs_live: f64,
    archive_reference_bytes: u64,
    ratio_vs_archive: f64,
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

pub struct DebrisCodecOptions {
    pub trace: PathBuf,
    pub out_dir: PathBuf,
    pub shell_cm: f32,
    pub rotation_deg: f32,
    pub velocity_mps: f32,
    pub angular_rps: f32,
    pub flush_ms: f32,
    pub block_ms: f32,
    pub max_ticks: Option<u32>,
    pub sleep_linear_mps: f32,
    pub sleep_angular_rps: f32,
    pub sleep_ticks: u32,
    pub sample_step_max_exp: u8,
    pub sample_second_order: bool,
    pub sync_min_radius_m: f32,
    pub encode_parallel: bool,
    pub budget_mbps: Option<f64>,
    pub mask_precision: bool,
    pub mask_cap_mm: f32,
    pub output_fps: u32,
    pub interpolation_delay_ms: u32,
    pub max_extrapolation_ms: u32,
    pub correction_ms: u32,
    pub snap_distance_m: f32,
    pub pixel_budget: f32,
    /// Encode one stream per ISLAND rather than per chunk.
    ///
    /// Only meaningful on a Blast-model trace, where chunks sharing an island
    /// are rigid with respect to each other and the trace's topology names the
    /// membership. Default off, so every existing measurement is untouched.
    pub island_stream: bool,
    pub live_reference_bytes: u64,
    pub archive_reference_bytes: u64,
}

const LIVE_REFERENCE_BYTES: u64 = 33_079_411;
const ARCHIVE_REFERENCE_BYTES: u64 = 36_646_007;

pub fn run(options: DebrisCodecOptions) -> Result<()> {
    fs::create_dir_all(&options.out_dir)
        .with_context(|| format!("create {}", options.out_dir.display()))?;

    let mut reader = TraceReader::open(&options.trace)?;
    let physics_hz = reader.header.physics_hz;
    let dt = 1.0 / physics_hz as f32;
    let gravity = reader.header.gravity;
    let body_count = reader.actors.len();
    let radii: Vec<f32> = reader
        .actors
        .iter()
        .map(|actor| actor.bounding_radius.max(0.01))
        .collect();
    let reader_header = reader.header.clone();
    let actor_defs = reader.actors.clone();

    let span_ticks = ((options.flush_ms / 1000.0) * physics_hz as f32).round().max(1.0) as u32;
    let mut block_ticks = ((options.block_ms / 1000.0) * physics_hz as f32)
        .round()
        .max(span_ticks as f32) as u32;
    // Keep spans from straddling block boundaries so a span's records always
    // land in one block.
    block_ticks -= block_ticks % span_ticks;

    let tolerances = Tolerances {
        shell_m: options.shell_cm / 100.0,
        rotation_deg: options.rotation_deg,
        velocity_mps: options.velocity_mps,
        angular_rps: options.angular_rps,
        rate_scale: 1.0,
        mask: MaskConfig {
            enabled: options.mask_precision,
            base_m: options.shell_cm / 100.0,
            cap_m: options.mask_cap_mm / 1000.0,
            ..MaskConfig::default()
        },
    };

    let sleep = SleepPolicy {
        linear_mps: options.sleep_linear_mps,
        angular_rps: options.sleep_angular_rps,
        ticks: options.sleep_ticks,
    };
    let mut encoder = Encoder::new(
        body_count,
        dt,
        gravity,
        radii.clone(),
        tolerances,
        sleep,
        options.sample_step_max_exp,
        DEFAULT_STRIDE_LADDER.to_vec(),
        options.sample_second_order,
        options.sync_min_radius_m,
        options.encode_parallel,
    );
    if options.island_stream {
        encoder.enable_wire_v2();
    }
    let mut encode_island = IslandView::new(body_count);
    let mut encode_derivable = vec![false; body_count];
    let mut wide_peak = 0usize;
    let mut topology_deltas: Vec<TopologyTickDelta> = Vec::new();
    let mut islands_peak = 0usize;
    let mut blocks: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut pending: Vec<Record> = Vec::new();
    let mut block_first_tick = 0u32;
    let mut ticks_seen = 0u32;

    // Encode-only accounting: the clock runs over fitting, span finalization,
    // block assembly and compression, and stops for trace I/O and for the
    // verification pass. Anything else would measure the harness, not the
    // encoder, and the number this produces is meant to sit beside the
    // incumbent's realtime_encode_factor.
    let mut encode_seconds = 0.0_f64;
    let mut block_encode_ms: Vec<f64> = Vec::new();
    // Rate control: a block that busts its budget is re-encoded from the block
    // boundary with a looser bound. That needs the block's ticks and the
    // fitter state as they were when the block opened, so both are held while
    // a block is in flight -- only when a budget is actually set.
    let block_seconds_budget = block_ticks as f64 / physics_hz as f64;
    let budget_bytes = options
        .budget_mbps
        .map(|mbps| (mbps * 1.0e6 * block_seconds_budget / 8.0) as usize);
    // Precision may degrade to 4x the masked ceiling: the measured perceptual
    // limit from the Phase C recalibration. Beyond it, coverage would have to
    // go instead, which full-world streaming cannot do.
    const RATE_LADDER: [f32; 4] = [1.5, 2.0, 3.0, 4.0];
    let mut block_states: Vec<Vec<ActorState>> = Vec::new();
    let mut block_open_fitters: Vec<BodyFitter> = encoder.fitter_snapshot();
    let mut rate_scales: Vec<f32> = Vec::new();

    while let Some(tick) = reader.next_tick()? {
        if let Some(limit) = options.max_ticks {
            if tick.index >= limit {
                break;
            }
        }
        ticks_seen = tick.index + 1;
        let encode_started = Instant::now();
        let block_index = tick.index / block_ticks;
        let current_block_first = block_index * block_ticks;
        if current_block_first != block_first_tick {
            let block_started = Instant::now();
            let (payload, scale) = encoder.encode_block_within_budget(
                &mut pending,
                block_first_tick,
                span_ticks,
                budget_bytes,
                &RATE_LADDER,
                &block_states,
                &block_open_fitters,
            )?;
            rate_scales.push(scale);
            blocks.push((block_first_tick, payload));
            block_encode_ms.push(block_started.elapsed().as_secs_f64() * 1000.0);
            pending.clear();
            block_first_tick = current_block_first;
            block_states.clear();
            block_open_fitters = encoder.fitter_snapshot();
        }

        if budget_bytes.is_some() {
            block_states.push(tick.states.clone());
        }
        if options.island_stream {
            // Membership first: a chunk promoted this tick belongs to its new
            // island for this tick's pose, not the previous one.
            encode_island.update(&tick);
            if let Some(delta) = TopologyTickDelta::from_tick(&tick) {
                topology_deltas.push(delta);
                // Membership moved, so the reach of at least one island moved
                // with it. Restate every root's bound before this tick is fitted,
                // and re-decide which islands are precise enough to derive.
                encoder.set_radii(&encode_island.island_radii(&radii));
                encode_derivable = encode_island.derivable(&radii, options.shell_cm / 100.0);
                // Spend precision only where a lever arm exists to amplify it:
                // roots whose island the narrow grid cannot hold.
                let wide = encode_island.wide_roots(&radii, options.shell_cm / 100.0);
                wide_peak = wide_peak.max(wide.iter().filter(|w| **w).count());
                encoder.set_wide(&wide);
                // A root only forgoes masking slack if something is actually
                // reconstructed from it; a one-chunk island keeps the slack,
                // because it is its own only member.
                let mut strict = vec![false; body_count];
                for body in 0..body_count {
                    let root = encode_island.root_of(body);
                    if root != body && encode_derivable[root] {
                        strict[root] = true;
                    }
                }
                encoder.set_strict(&strict);
            }
            // Only island roots reach the wire. Every other chunk is rigid
            // with respect to its root, so its pose is implied.
            for (body, state) in tick.states.iter().enumerate() {
                if encode_island.is_root(body) || !encode_derivable[encode_island.root_of(body)] {
                    encoder.push(body, tick.index, state);
                }
            }
            islands_peak = islands_peak.max(encode_island.island_count());
        } else {
            encoder.push_tick(tick.index, &tick.states);
        }

        if (tick.index + 1) % span_ticks == 0 {
            let before = pending.len();
            encoder.finalize_span(block_first_tick, &mut pending);
            // Diagnostic census, env-gated, output-only: the live driver and
            // this one disagreed by 5.6 MB with nominally identical inputs,
            // and reading the code failed to find why three times.
            if let Ok(dump) = std::env::var("DEBRIS_DUMP_RECORDS") {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dump)
                    .expect("dump file");
                for record in &pending[before..] {
                    let (kind, extra) = match record {
                        Record::Segment { gravity, .. } => ("seg", i64::from(*gravity)),
                        Record::Impulse { .. } => ("imp", 0),
                        Record::SampleRun {
                            continuity,
                            stride,
                            frames,
                            ..
                        } => ("run", i64::from(*continuity) * 1000 + i64::from(*stride) * 100 + frames.len() as i64),
                        Record::Rest { .. } => ("rest", 0),
                    };
                    writeln!(file, "{},{},{},{}", record.tick(), record.body(), kind, extra)
                        .expect("dump write");
                }
            }
        }
        encode_seconds += encode_started.elapsed().as_secs_f64();
    }
    let tail_started = Instant::now();
    encoder.finalize_span(block_first_tick, &mut pending);
    let (payload, scale) = encoder.encode_block_within_budget(
        &mut pending,
        block_first_tick,
        span_ticks,
        budget_bytes,
        &RATE_LADDER,
        &block_states,
        &block_open_fitters,
    )?;
    rate_scales.push(scale);
    blocks.push((block_first_tick, payload));
    encode_seconds += tail_started.elapsed().as_secs_f64();

    // ----- compression + rate profile -----
    let mut uncompressed_bytes = 0u64;
    let mut compressed_bytes = 0u64;
    let mut block_reports = Vec::new();
    let block_seconds = block_ticks as f64 / physics_hz as f64;
    const BLOCK_HEADER_BYTES: usize = 12;
    for (first_tick, payload) in &blocks {
        let compress_started = Instant::now();
        let compressed = zstd::bulk::compress(payload, 3)?;
        let compress_ms = compress_started.elapsed().as_secs_f64() * 1000.0;
        encode_seconds += compress_ms / 1000.0;
        let framed = compressed.len() + BLOCK_HEADER_BYTES;
        uncompressed_bytes += payload.len() as u64;
        compressed_bytes += framed as u64;
        block_reports.push(BlockReport {
            first_tick: *first_tick,
            payload_bytes: payload.len(),
            compressed_bytes: framed,
            mbps: (framed as f64 * 8.0) / block_seconds / 1.0e6,
        });
    }

    // The topology track: which chunk belongs to which island, and which bonds
    // broke. It is small but it is not free, and it has to be RELIABLE where
    // the pose stream is loss-tolerant -- so it is counted as its own stream
    // rather than folded into the pose bitrate.
    let mut topology_bytes = 0u64;
    let mut topology_blocks = 0u64;
    if options.island_stream && !topology_deltas.is_empty() {
        let mut start = 0usize;
        while start < topology_deltas.len() {
            let block_first = topology_deltas[start].tick - (topology_deltas[start].tick % block_ticks);
            let mut end = start;
            while end < topology_deltas.len() && topology_deltas[end].tick < block_first + block_ticks {
                end += 1;
            }
            let encoded = encode_topology_block(&topology_deltas[start..end], block_first)?;
            topology_bytes += (encoded.len() + BLOCK_HEADER_BYTES) as u64;
            topology_blocks += 1;
            start = end;
        }
    }

    // ----- verification pass: rebuild every pose from re-parsed bytes -----
    let mut playbacks: Vec<Playback> = (0..body_count).map(|_| Playback::default()).collect();
    let mut decode_tails: Vec<Option<([i32; 3], u64)>> = vec![None; body_count];
    for (_, payload) in &blocks {
        for record in decode_block(payload, &mut decode_tails, options.island_stream)? {
            playbacks[record.body() as usize].events.push(record);
        }
    }
    for playback in &mut playbacks {
        playback.events.sort_by_key(|record| record.tick());
    }

    // The artifact gates are the fidelity contract (standing rule 5), so the
    // decoded stream is driven through the same receiver model and the same
    // 22-criterion assessment the live path uses. The only difference is what
    // feeds it: analytic evaluation instead of hierarchy reconstruction.
    let interp_ticks = ((options.interpolation_delay_ms as f32 / 1000.0) * physics_hz as f32)
        .round()
        .max(0.0) as u32;
    let presentation_config = PresentationConfig {
        // A record cannot be presented before its span closes, so the encode
        // window is charged as delay exactly as the live path charges its GOP.
        interpolation_delay_ticks: span_ticks + interp_ticks,
        max_extrapolation_ticks: ((options.max_extrapolation_ms as f32 / 1000.0)
            * physics_hz as f32)
            .round() as u32,
        correction_seconds: options.correction_ms as f32 / 1000.0,
        dt,
        gravity,
        snap_distance_meters: options.snap_distance_m,
    };
    let continuity_config = ContinuityConfig {
        truth_moving_speed: 0.5,
        presented_still_speed: 0.05,
        angular_moving_speed: 0.1,
        dt,
    };
    let replay = ReplayWriter::create(
        &options.out_dir.join("reconstructed.towerstate"),
        &reader_header,
        &actor_defs,
        options.output_fps,
    )?;
    let mut telemetry = TelemetryPass::new(
        &actor_defs,
        reader_header.pane_width,
        reader_header.pane_height,
        physics_hz,
        options.output_fps,
        reader_header.cameras,
        false,
        false,
        options.pixel_budget,
        presentation_config,
        continuity_config,
        Some(replay),
    );
    telemetry.warmup_ticks = presentation_config.interpolation_delay_ticks;
    telemetry.freeze_tolerance_cm = options.shell_cm;
    telemetry.replay_truth_sleeping = true;

    let mut previous_pose: Vec<Option<Pose>> = vec![None; body_count];
    let mut previous_hold = vec![false; body_count];
    let mut update_history: Vec<std::collections::VecDeque<u32>> =
        vec![std::collections::VecDeque::new(); body_count];
    let mut receiver_class = vec![PhysicalClass::ContactActive; body_count];
    let mut tick_bytes = vec![0u64; ticks_seen as usize];
    for (block_index, (first_tick, _)) in blocks.iter().enumerate() {
        // Charge each block at its close, matching the live path's burst ledger.
        let close = (*first_tick + block_ticks - 1).min(ticks_seen.saturating_sub(1)) as usize;
        if let Some(slot) = tick_bytes.get_mut(close) {
            *slot += block_reports[block_index].compressed_bytes as u64;
        }
    }

    let mut reader = TraceReader::open(&options.trace)?;
    let mut verify_island = IslandView::new(body_count);
    let mut verify_derivable = vec![false; body_count];
    let mut island_resolved: Vec<Option<Pose>> = vec![None; body_count];
    let mut max_shell = 0.0f32;
    let mut max_rotation = 0.0f32;
    let mut violations = 0u64;
    let mut evaluated = 0u64;
    let mut shell_samples: Vec<f32> = Vec::new();
    let mut worst: Option<(u32, u32, Vec3, Vec3)> = None;
    let out_of_world = 0u64;
    let mut unsynced_bodies = std::collections::BTreeSet::new();
    while let Some(tick) = reader.next_tick()? {
        if tick.index >= ticks_seen {
            break;
        }
        telemetry.begin_tick(&tick);
        if options.island_stream {
            verify_island.update(&tick);
            if !tick.topology.changed_roots.is_empty() {
                verify_derivable = verify_island.derivable(&radii, options.shell_cm / 100.0);
            }
            // Roots are the lowest index in their island, so a root is always
            // resolved before the members that read it.
            island_resolved.iter_mut().for_each(|slot| *slot = None);
        }
        for (body, state) in tick.states.iter().enumerate() {
            if radii[body] < options.sync_min_radius_m {
                // Not on the wire: the client renders its own cosmetic piece,
                // so feed truth into presentation and leave it out of the wire
                // error statistics. Gates therefore judge synced bodies only.
                unsynced_bodies.insert(body);
                telemetry.presentation[body].push(MotionSnapshot {
                    tick: tick.index,
                    pose: state.pose,
                    linear_velocity: state.linear_velocity,
                    angular_velocity: state.angular_velocity,
                    class: PhysicalClass::ContactActive,
                });
                update_history[body].push_back(tick.index);
                continue;
            }
            // A member chunk carries no records: it is rebuilt from its
            // island root's decoded pose, which is the whole claim being
            // measured. If islands were not rigid this is where it would show
            // up -- as shell-bound violations and failed artifact gates, not as
            // a quietly larger stream.
            let composed = if options.island_stream
                && !verify_island.is_root(body)
                && verify_derivable[verify_island.root_of(body)]
            {
                island_resolved[verify_island.root_of(body)]
                    .map(|root_pose| verify_island.compose(body, root_pose))
            } else {
                None
            };
            let playback = &mut playbacks[body];
            let pose = match composed {
                Some(pose) => pose,
                None => {
                    playback.advance_to(tick.index, dt, gravity);
                    match playback.pose_at(tick.index, dt, gravity) {
                        Some(pose) => pose,
                        None => continue,
                    }
                }
            };
            if options.island_stream {
                island_resolved[body] = Some(pose);
            }
            // Feed presentation with the same hold-coalescing the live path
            // uses: a body the wire is deliberately holding still must not be
            // scored as a freeze, and the closing synthetic snapshot keeps
            // interpolation from spanning the held gap.
            let hold = playback.is_parked()
                && previous_pose[body].is_some_and(|previous| {
                    previous.position == pose.position && previous.rotation == pose.rotation
                });
            if hold && previous_hold[body] {
                previous_pose[body] = Some(pose);
            } else {
                if !hold && previous_hold[body] {
                    if let Some(previous) = previous_pose[body] {
                        telemetry.presentation[body].push(MotionSnapshot {
                            tick: tick.index.saturating_sub(1),
                            pose: previous,
                            linear_velocity: Vec3::ZERO,
                            angular_velocity: Vec3::ZERO,
                            class: PhysicalClass::Quiescent,
                        });
                    }
                }
                // Segments carry velocity on the wire, so presentation gets it
                // analytically; sampled runs do not, so they finite-difference
                // exactly as the incumbent's receiver must for every body.
                let (linear_velocity, angular_velocity) = if hold {
                    (Vec3::ZERO, Vec3::ZERO)
                } else if let Some((linear, angular)) = playback.velocity_at(tick.index, dt, gravity)
                {
                    (linear, angular)
                } else if let Some(previous) = previous_pose[body] {
                    let step = pose.position - previous.position;
                    if step.length() > options.snap_distance_m {
                        (Vec3::ZERO, Vec3::ZERO)
                    } else {
                        let mut delta = pose.rotation * previous.rotation.conjugate();
                        if delta.w < 0.0 {
                            delta = -delta;
                        }
                        (step / dt, delta.to_scaled_axis() / dt)
                    }
                } else {
                    (Vec3::ZERO, Vec3::ZERO)
                };
                receiver_class[body] = if hold {
                    PhysicalClass::Quiescent
                } else {
                    PhysicalClass::ContactActive
                };
                if !hold {
                    update_history[body].push_back(tick.index);
                }
                telemetry.presentation[body].push(MotionSnapshot {
                    tick: tick.index,
                    pose,
                    linear_velocity,
                    angular_velocity,
                    class: receiver_class[body],
                });
                previous_pose[body] = Some(pose);
                previous_hold[body] = hold;
            }
            let shell = rigid_shell_error_meters(state.pose, pose, radii[body]);
            let rotation = angular_error_degrees(state.pose.rotation, pose.rotation);
            evaluated += 1;
            if shell > max_shell {
                max_shell = shell;
                worst = Some((body as u32, tick.index, state.pose.position, pose.position));
            }
            if rotation > max_rotation {
                max_rotation = rotation;
            }
            let allowed = tolerances.shell_for(state, radii[body]).max({
                let (fp, fr) = quantize_pose(state.pose);
                rigid_shell_error_meters(state.pose, dequantize_pose(fp, fr), radii[body]) * 1.05
            });
            if shell > allowed + 1e-4 || rotation > tolerances.rotation_deg + 1e-2 {
                violations += 1;
            }
            // Reservoir-free subsample keeps the percentile cheap and stable.
            if (tick.index as usize + body) % 97 == 0 {
                shell_samples.push(shell);
            }
        }

        // Staleness is scored on the displayed (delay-shifted) timeline.
        let target = tick
            .index
            .saturating_sub(presentation_config.interpolation_delay_ticks);
        for history in update_history.iter_mut() {
            while history.len() >= 2 && history[1] <= target {
                history.pop_front();
            }
        }
        telemetry.observe_tick(
            tick.index,
            0,
            0,
            &|body| {
                let last = update_history[body]
                    .front()
                    .copied()
                    .filter(|&t| t <= target)
                    .unwrap_or(0);
                tick.index - target + last
            },
            &|body| receiver_class[body] == PhysicalClass::Quiescent,
        )?;
    }
    telemetry.backfill_frame_rates(&tick_bytes);
    telemetry.finish_replay()?;
    let acceptance = assess_visual_acceptance(&telemetry.frame_telemetry);
    write_csv(
        options.out_dir.join("presentation_frame_telemetry.csv"),
        &telemetry.frame_telemetry,
    )?;
    shell_samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p95_shell = if shell_samples.is_empty() {
        0.0
    } else {
        shell_samples[((shell_samples.len() as f64 * 0.95) as usize).min(shell_samples.len() - 1)]
    };

    // ----- report -----
    let duration_seconds = ticks_seen as f64 / physics_hz as f64;
    let mut sorted_encode_ms = block_encode_ms.clone();
    sorted_encode_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut rates: Vec<f64> = block_reports.iter().map(|block| block.mbps).collect();
    rates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let percentile = |sorted: &[f64], q: f64| -> f64 {
        if sorted.is_empty() {
            return 0.0;
        }
        sorted[((sorted.len() as f64 * q) as usize).min(sorted.len() - 1)]
    };
    let mut frame_tails: Vec<Option<([i32; 3], u64)>> = vec![None; body_count];
    let sampled_frames: u64 = blocks
        .iter()
        .map(|(_, payload)| decode_block(payload, &mut frame_tails, options.island_stream).map(|records| {
            records
                .iter()
                .map(|record| match record {
                    Record::SampleRun { frames, .. } => frames.len() as u64,
                    _ => 0,
                })
                .sum::<u64>()
        }))
        .collect::<Result<Vec<u64>>>()?
        .into_iter()
        .sum();

    let total_records: u64 = (0..5).map(|kind| encoder.kind_count(kind)).sum();
    let report = DebrisReport {
        island_stream: options.island_stream,
        islands_peak: islands_peak as u64,
        topology_bytes,
        topology_blocks,
        total_with_topology_bytes: compressed_bytes + topology_bytes,
        trace: options.trace.display().to_string(),
        bodies: body_count,
        ticks: ticks_seen,
        physics_hz,
        duration_seconds,
        shell_tolerance_cm: options.shell_cm,
        rotation_tolerance_degrees: options.rotation_deg,
        velocity_tolerance_mps: options.velocity_mps,
        flush_span_ticks: span_ticks,
        block_ticks,
        required_lead_ms: (span_ticks as f64 / physics_hz as f64) * 1000.0,
        uncompressed_bytes,
        compressed_bytes,
        header_bytes: (blocks.len() * BLOCK_HEADER_BYTES) as u64,
        average_mbps: (compressed_bytes as f64 * 8.0) / duration_seconds / 1.0e6,
        p50_block_mbps: percentile(&rates, 0.5),
        p95_block_mbps: percentile(&rates, 0.95),
        peak_block_mbps: rates.last().copied().unwrap_or(0.0),
        bytes_per_body_tick: compressed_bytes as f64 / body_count as f64 / ticks_seen as f64,
        segments: encoder.kind_count(0) + encoder.kind_count(4),
        ballistic_segments: encoder.kind_count(0),
        supported_segments: encoder.kind_count(4),
        impulses: encoder.kind_count(1),
        sample_runs: encoder.kind_count(2),
        rests: encoder.kind_count(3),
        forced_rests: encoder.forced_rests,
        sleep_ticks: options.sleep_ticks,
        records_per_body_second: total_records as f64 / body_count as f64 / duration_seconds,
        impulse_admission_rate: if encoder.impulse_candidates == 0 {
            0.0
        } else {
            encoder.impulse_taken as f64 / encoder.impulse_candidates as f64
        },
        fallback_fraction: if encoder.spans_active() == 0 {
            0.0
        } else {
            encoder.spans_fallback() as f64 / encoder.spans_active() as f64
        },
        sampled_frames,
        rotation_resends: encoder.rotation_resends(),
        rotation_held: encoder.rotation_held(),
        rotation_bytes: encoder.rotation_bytes(),
        rotation_pct_of_payload: encoder.rotation_bytes() as f64 * 100.0
            / uncompressed_bytes.max(1) as f64,
        segment_bytes: encoder.kind_byte(0) + encoder.kind_byte(4),
        impulse_bytes: encoder.kind_byte(1),
        sample_run_bytes: encoder.kind_byte(2),
        rest_bytes: encoder.kind_byte(3),
        max_shell_error_cm: max_shell * 100.0,
        p95_shell_error_cm: p95_shell * 100.0,
        max_rotation_error_degrees: max_rotation,
        tolerance_violations: violations,
        evaluated_samples: evaluated,
        out_of_world_samples: out_of_world,
        sync_min_radius_m: options.sync_min_radius_m,
        unsynced_bodies: unsynced_bodies.len(),
        budget_mbps: options.budget_mbps,
        rate_limited_blocks: rate_scales.iter().filter(|scale| **scale > 1.0).count(),
        max_rate_scale: rate_scales.iter().copied().fold(1.0_f32, f32::max),
        encode_seconds,
        realtime_encode_factor: encode_seconds / duration_seconds.max(1e-9),
        encode_ms_p50_per_block: percentile(&sorted_encode_ms, 0.5),
        encode_ms_p95_per_block: percentile(&sorted_encode_ms, 0.95),
        encode_ms_max_per_block: sorted_encode_ms.last().copied().unwrap_or(0.0),
        acceptance,
        live_reference_bytes: options.live_reference_bytes,
        ratio_vs_live: options.live_reference_bytes as f64 / compressed_bytes as f64,
        archive_reference_bytes: options.archive_reference_bytes,
        ratio_vs_archive: options.archive_reference_bytes as f64 / compressed_bytes as f64,
    };

    fs::write(
        options.out_dir.join("debris_report.json"),
        serde_json::to_string_pretty(&report)?,
    )?;

    let mut blocks_csv = String::from("first_tick,payload_bytes,compressed_bytes,mbps\n");
    for block in &block_reports {
        blocks_csv.push_str(&format!(
            "{},{},{},{:.4}\n",
            block.first_tick, block.payload_bytes, block.compressed_bytes, block.mbps
        ));
    }
    fs::write(options.out_dir.join("debris_blocks.csv"), blocks_csv)?;

    let mut bodies_csv = String::from("body,records,bytes,bounding_radius\n");
    for body in 0..body_count {
        bodies_csv.push_str(&format!(
            "{},{},{},{:.4}\n",
            body, encoder.lanes[body].records_total, encoder.lanes[body].bytes_total, radii[body]
        ));
    }
    fs::write(options.out_dir.join("debris_bodies.csv"), bodies_csv)?;

    print_summary(&report);
    if let Some((body, tick, truth, reconstructed)) = worst {
        println!(
            "  worst body     : {body} at tick {tick}, truth {truth:?} vs reconstructed {reconstructed:?}"
        );
    }
    Ok(())
}

fn print_summary(report: &DebrisReport) {
    println!("debris-codec: {} bodies, {} ticks", report.bodies, report.ticks);
    println!(
        "  tolerance      : {:.2} cm shell / {:.1} deg / {:.2} m/s",
        report.shell_tolerance_cm, report.rotation_tolerance_degrees, report.velocity_tolerance_mps
    );
    println!(
        "  required lead  : {:.1} ms (flush span {} ticks)",
        report.required_lead_ms, report.flush_span_ticks
    );
    println!(
        "  compressed     : {} bytes ({:.3} Mbps avg, p95 {:.3}, peak {:.3})",
        report.compressed_bytes, report.average_mbps, report.p95_block_mbps, report.peak_block_mbps
    );
    println!(
        "  bytes/body/tick: {:.4}   vs live {:.2}x   vs archive {:.2}x",
        report.bytes_per_body_tick, report.ratio_vs_live, report.ratio_vs_archive
    );
    if report.island_stream {
        let seconds = report.ticks as f64 / report.physics_hz as f64;
        println!(
            "  island stream  : peak {} islands of {} chunks ({:.1}% carry records)",
            report.islands_peak,
            report.bodies,
            100.0 * report.islands_peak as f64 / report.bodies as f64
        );
        println!(
            "  topology track : {} bytes over {} blocks ({:.3} Mbps) -- reliable",
            report.topology_bytes,
            report.topology_blocks,
            (report.topology_bytes as f64 * 8.0) / seconds / 1.0e6
        );
        println!(
            "  TOTAL          : {} bytes ({:.3} Mbps) = poses + topology",
            report.total_with_topology_bytes,
            (report.total_with_topology_bytes as f64 * 8.0) / seconds / 1.0e6
        );
    }
    println!(
        "  records        : {} seg ({} ballistic / {} supported) / {} imp / {} sample-run ({} frames) / {} rest",
        report.segments,
        report.ballistic_segments,
        report.supported_segments,
        report.impulses,
        report.sample_runs,
        report.sampled_frames,
        report.rests
    );
    println!(
        "  payload split  : {:.1}% segment / {:.1}% impulse / {:.1}% sample-run / {:.1}% rest",
        report.segment_bytes as f64 * 100.0 / report.uncompressed_bytes.max(1) as f64,
        report.impulse_bytes as f64 * 100.0 / report.uncompressed_bytes.max(1) as f64,
        report.sample_run_bytes as f64 * 100.0 / report.uncompressed_bytes.max(1) as f64,
        report.rest_bytes as f64 * 100.0 / report.uncompressed_bytes.max(1) as f64
    );
    if report.sync_min_radius_m > 0.0 {
        println!(
            "  class C        : {} bodies below {:.2} m never synced",
            report.unsynced_bodies, report.sync_min_radius_m
        );
    }
    println!(
        "  rotation       : {} re-sends / {} held ({:.1}% of payload, {} B)",
        report.rotation_resends,
        report.rotation_held,
        report.rotation_pct_of_payload,
        report.rotation_bytes
    );
    println!(
        "  rec/body/s     : {:.3}   fallback {:.1}%   impulse admission {:.1}%",
        report.records_per_body_second,
        report.fallback_fraction * 100.0,
        report.impulse_admission_rate * 100.0
    );
    if let Some(budget) = report.budget_mbps {
        println!(
            "  rate control   : {:.1} Mbps budget; {} block(s) loosened, max scale {:.1}x",
            budget, report.rate_limited_blocks, report.max_rate_scale
        );
    }
    println!(
        "  encode         : {:.3}x realtime ({:.2} s; block p50 {:.1} / p95 {:.1} / max {:.1} ms)",
        report.realtime_encode_factor,
        report.encode_seconds,
        report.encode_ms_p50_per_block,
        report.encode_ms_p95_per_block,
        report.encode_ms_max_per_block
    );
    println!(
        "  gates          : {}  freeze_run {:.0} ms / freeze {:.3}% / reversal p99 {:.3} max {:.3} / stale_max {:.0} ms",
        if report.acceptance.pass { "PASS" } else { "FAIL" },
        report.acceptance.frame_freeze_run_ms_max,
        report.acceptance.frame_freeze_pct_max,
        report.acceptance.frame_linear_reversal_pct_p99,
        report.acceptance.frame_linear_reversal_pct_max,
        report.acceptance.moving_stale_ms_max
    );
    println!(
        "  decoded error  : max {:.3} cm / p95 {:.3} cm / max rot {:.2} deg / violations {}",
        report.max_shell_error_cm,
        report.p95_shell_error_cm,
        report.max_rotation_error_degrees,
        report.tolerance_violations
    );
}

pub fn default_live_reference() -> u64 {
    LIVE_REFERENCE_BYTES
}

pub fn default_archive_reference() -> u64 {
    ARCHIVE_REFERENCE_BYTES
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(dead_code)]
fn pack_quat32_u64(index: u8, components: [i32; 3]) -> u64 {
    pack_quat32(index, components) as u64
}

#[cfg(test)]
#[allow(dead_code)]
fn narrow(rotation: Quat) -> u64 {
    encode_quat32(rotation) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_tolerances() -> Tolerances {
        Tolerances {
            shell_m: 0.02,
            rotation_deg: 3.0,
            velocity_mps: 0.15,
            angular_rps: 0.5,
            mask: MaskConfig::default(),
            rate_scale: 1.0,
        }
    }

    fn no_sleep() -> SleepPolicy {
        SleepPolicy {
            linear_mps: 0.0,
            angular_rps: 0.0,
            ticks: 0,
        }
    }

    fn state(pose: Pose, velocity: Vec3, angular: Vec3) -> ActorState {
        ActorState {
            pose,
            linear_velocity: velocity,
            angular_velocity: angular,
            contacts: 0,
            intact_joints: 0,
            flags: 0,
        }
    }

    #[test]
    fn position_quantization_round_trips_to_the_millimetre() {
        let value = Vec3::new(12.3456, -998.0021, 0.0004);
        let restored = dequantize_position(quantize_position(value));
        assert!((restored - value).abs().max_element() <= 0.0006);
    }

    #[test]
    fn positions_survive_the_whole_world_including_sentinels() {
        // -10 km is where traces park not-yet-launched projectiles; a fixed
        // 24-bit field clamped those to 8.4 km and put them kilometres off.
        for value in [[-8_000_000, 42, -1], [-10_000_000; 3], [i32::MIN / 2, 0, i32::MAX / 2]] {
            let mut buffer = Vec::new();
            write_position(&mut buffer, value);
            let mut cursor = 0;
            assert_eq!(read_position(&buffer, &mut cursor).unwrap(), value);
            assert_eq!(cursor, buffer.len());
        }
    }

    #[test]
    fn every_record_type_survives_a_block_round_trip() {
        let mut records = vec![
            Record::Segment {
                body: 7,
                tick: 130,
                gravity: true,
                position: [1000, -2000, 3000],
                rotation: narrow(Quat::from_rotation_x(0.4)),
                velocity: [10, -20, 30],
                angular: [1, 2, 3],
            },
            Record::Impulse {
                body: 9,
                tick: 131,
                delta_velocity: [-5, 6, -7],
                delta_angular: [8, -9, 10],
            },
            Record::SampleRun {
                body: 11,
                tick: 132,
                stride: 2,
                last_offset: 2,
                continuity: false,
                second_order: false,
                step_exp: 0,
                frames: vec![
                    ([1, 2, 3], narrow(Quat::IDENTITY)),
                    ([4, 5, 6], narrow(Quat::from_rotation_y(0.2))),
                ],
            },
            Record::Rest {
                body: 13,
                tick: 133,
                position: [7, 8, 9],
                rotation: narrow(Quat::IDENTITY),
            },
        ];
        let expected = {
            let mut sorted = records.clone();
            sorted.sort_by_key(|record| (record.kind_index(), record.body(), record.tick()));
            sorted
        };
        let mut tails = vec![None; 32];
        let payload = encode_block(&mut records, 128, &mut tails, false);
        let mut decode_tails = vec![None; 32];
        assert_eq!(decode_block(&payload, &mut decode_tails, false).unwrap(), expected);
    }

    #[test]
    fn a_clean_ballistic_arc_costs_one_segment() {
        let dt = 1.0 / 120.0;
        let gravity = Vec3::new(0.0, -9.81, 0.0);
        let tolerances = test_tolerances();
        let mut encoder = Encoder::new(1, dt, gravity, vec![0.5], tolerances, no_sleep(), 2, DEFAULT_STRIDE_LADDER.to_vec(), true, 0.0, false);
        let p0 = Vec3::new(0.0, 10.0, 0.0);
        let v0 = Vec3::new(3.0, 4.0, 0.0);
        let angular = Vec3::new(0.0, 2.0, 0.0);

        let mut records = Vec::new();
        for tick in 0..120u32 {
            let d = tick as f32 * dt;
            let pose = Pose {
                position: p0 + v0 * d + 0.5 * gravity * d * d,
                rotation: Quat::from_scaled_axis(angular * d),
            };
            encoder.push(0, tick, &state(pose, v0 + gravity * d, angular));
            if (tick + 1) % 6 == 0 {
                encoder.finalize_span(0, &mut records);
            }
        }
        encoder.finalize_span(0, &mut records);

        assert_eq!(
            records.len(),
            1,
            "a free-flight arc should need exactly one record, got {records:?}"
        );
        assert!(matches!(records[0], Record::Segment { .. }));
    }

    #[test]
    fn a_bounce_is_coded_as_an_impulse_not_a_segment() {
        let dt = 1.0 / 120.0;
        let gravity = Vec3::new(0.0, -9.81, 0.0);
        let tolerances = test_tolerances();
        let mut encoder = Encoder::new(1, dt, gravity, vec![0.2], tolerances, no_sleep(), 2, DEFAULT_STRIDE_LADDER.to_vec(), true, 0.0, false);

        // Fall for 30 ticks, reverse velocity in one tick, continue.
        let mut position = Vec3::new(0.0, 5.0, 0.0);
        let mut velocity = Vec3::new(1.0, -4.0, 0.0);
        let mut records = Vec::new();
        for tick in 0..60u32 {
            if tick == 30 {
                velocity.y = -velocity.y * 0.6;
            }
            let pose = Pose {
                position,
                rotation: Quat::IDENTITY,
            };
            encoder.push(0, tick, &state(pose, velocity, Vec3::ZERO));
            velocity += gravity * dt;
            position += velocity * dt;
            if (tick + 1) % 6 == 0 {
                encoder.finalize_span(0, &mut records);
            }
        }
        encoder.finalize_span(0, &mut records);

        let impulses = records
            .iter()
            .filter(|record| matches!(record, Record::Impulse { .. }))
            .count();
        assert!(
            impulses >= 1,
            "the bounce should produce an impulse record, got {records:?}"
        );
    }

    #[test]
    fn a_sleeping_body_costs_one_rest_record() {
        let dt = 1.0 / 120.0;
        let tolerances = test_tolerances();
        let mut encoder = Encoder::new(1, dt, Vec3::new(0.0, -9.81, 0.0), vec![0.3], tolerances, no_sleep(), 2, DEFAULT_STRIDE_LADDER.to_vec(), true, 0.0, false);
        let mut records = Vec::new();
        for tick in 0..240u32 {
            let mut actor = state(
                Pose {
                    position: Vec3::new(1.0, 0.5, 2.0),
                    rotation: Quat::IDENTITY,
                },
                Vec3::ZERO,
                Vec3::ZERO,
            );
            actor.flags = 1; // sleeping
            encoder.push(0, tick, &actor);
            if (tick + 1) % 6 == 0 {
                encoder.finalize_span(0, &mut records);
            }
        }
        encoder.finalize_span(0, &mut records);
        assert_eq!(records.len(), 1);
        assert!(matches!(records[0], Record::Rest { .. }));
    }

    #[test]
    fn a_coarse_sample_grid_round_trips_the_exact_chain() {
        // The record holds the reconstructed chain, so whatever grid the
        // encoder chose must come back bit-identical through the wire.
        for step_exp in 0..5u8 {
            let step = 1_i32 << step_exp;
            let frames: Vec<([i32; 3], u64)> = (0..5)
                .map(|i| {
                    (
                        [1000 + i * step * 3, -2000 - i * step, 7 * step * i],
                        narrow(Quat::from_rotation_y(0.05 * i as f32)),
                    )
                })
                .collect();
            let mut records = vec![Record::SampleRun {
                body: 3,
                tick: 40,
                stride: 1,
                last_offset: 4,
                continuity: false,
                second_order: step_exp % 2 == 1,
                step_exp,
                frames: frames.clone(),
            }];
            let mut tails = vec![None; 8];
            let payload = encode_block(&mut records, 40, &mut tails, false);
            let mut decode_tails = vec![None; 8];
            let decoded = decode_block(&payload, &mut decode_tails, false).unwrap();
            match &decoded[0] {
                Record::SampleRun {
                    frames: out,
                    step_exp: out_step,
                    ..
                } => {
                    assert_eq!(*out_step, step_exp);
                    assert_eq!(*out, frames, "chain must survive step_exp {step_exp}");
                }
                other => panic!("expected a sample run, got {other:?}"),
            }
        }
    }

    #[test]
    fn rotation_delta_modes_reproduce_the_packed_word_exactly() {
        // Every mode codes the packed smallest-three word itself, so decode
        // must return the identical bits -- that is what keeps rotation delta
        // coding free of drift.
        let base = narrow(Quat::from_rotation_y(0.3));
        let (index, components) = unpack_quat32(base as u32);
        let cases = [
            (base, ROT_HELD),
            (pack_quat32_u64(index, [components[0] + 3, components[1] - 2, components[2] + 1]), ROT_DELTA4),
            (pack_quat32_u64(index, [components[0] + 40, components[1] - 90, components[2] + 12]), ROT_DELTA8),
            (narrow(Quat::from_rotation_x(1.4)), ROT_FULL),
        ];
        for (target, expected_mode) in cases {
            let mode = rotation_mode(Some(base), target);
            assert_eq!(mode, expected_mode, "mode choice for {target:#x}");
            let mut buffer = Vec::new();
            write_rotation(&mut buffer, mode, Some(base), target);
            let mut cursor = 0;
            let decoded = read_rotation(&buffer, &mut cursor, mode, Some(base)).unwrap();
            assert_eq!(decoded, target, "mode {mode} must round-trip exactly");
            assert_eq!(cursor, buffer.len());
        }
    }

    #[test]
    fn a_continuity_run_decodes_against_the_carried_tail() {
        // Two runs for one body: the second opens against the first's tail, so
        // the decoder must reproduce it only from carried state.
        let first = Record::SampleRun {
            body: 2,
            tick: 0,
            stride: 1,
            last_offset: 1,
            continuity: false,
            second_order: false,
            step_exp: 0,
            frames: vec![
                ([5000, 100, -300], narrow(Quat::IDENTITY)),
                ([5040, 90, -280], narrow(Quat::IDENTITY)),
            ],
        };
        let second = Record::SampleRun {
            body: 2,
            tick: 2,
            stride: 1,
            last_offset: 1,
            continuity: true,
            second_order: false,
            step_exp: 0,
            frames: vec![
                ([5080, 80, -260], narrow(Quat::IDENTITY)),
                ([5120, 70, -240], narrow(Quat::IDENTITY)),
            ],
        };
        let mut tails = vec![None; 8];
        let mut block_a = vec![first.clone()];
        let payload_a = encode_block(&mut block_a, 0, &mut tails, false);
        let mut block_b = vec![second.clone()];
        let payload_b = encode_block(&mut block_b, 2, &mut tails, false);

        let mut decode_tails = vec![None; 8];
        assert_eq!(decode_block(&payload_a, &mut decode_tails, false).unwrap(), vec![first]);
        assert_eq!(
            decode_block(&payload_b, &mut decode_tails, false).unwrap(),
            vec![second],
            "continuity run must rebuild from the carried tail alone"
        );
        // The continuity run codes one fewer absolute pose.
        assert!(payload_b.len() < payload_a.len());
    }

    #[test]
    fn playback_reproduces_the_encoder_analytic_state() {
        let dt = 1.0 / 120.0;
        let gravity = Vec3::new(0.0, -9.81, 0.0);
        let mut playback = Playback::default();
        playback.events = vec![
            Record::Segment {
                body: 0,
                tick: 0,
                gravity: true,
                position: quantize_position(Vec3::new(0.0, 10.0, 0.0)),
                rotation: narrow(Quat::IDENTITY),
                velocity: quantize_scaled(Vec3::new(2.0, 0.0, 0.0), VELOCITY_STEP_MPS),
                angular: quantize_scaled(Vec3::ZERO, ANGULAR_STEP_RPS),
            },
            Record::Impulse {
                body: 0,
                tick: 60,
                delta_velocity: quantize_scaled(Vec3::new(0.0, 5.0, 0.0), VELOCITY_STEP_MPS),
                delta_angular: quantize_scaled(Vec3::ZERO, ANGULAR_STEP_RPS),
            },
        ];
        playback.advance_to(0, dt, gravity);
        let start = playback.pose_at(0, dt, gravity).unwrap();
        assert!((start.position.y - 10.0).abs() < 0.01);

        playback.advance_to(60, dt, gravity);
        let after = playback.pose_at(60, dt, gravity).unwrap();
        // Position is continuous across the impulse; only velocity jumps.
        assert!((after.position.x - 1.0).abs() < 0.05);
        let later = playback.pose_at(90, dt, gravity).unwrap();
        assert!(later.position.y > after.position.y - 0.5);
    }
}

#[cfg(test)]
mod wide_rotation {
    use super::*;

    /// Angular error in degrees, computed in f64.
    ///
    /// The production `angular_error_degrees` uses `acos(dot)` in f32, whose
    /// conditioning near identity puts a ~0.04 deg floor under any measurement
    /// -- coarser than the wide grid itself, so it would report the metric's
    /// noise as the codec's error. `theta = 4*asin(|a-b|/2)` stays conditioned
    /// exactly where this test looks.
    fn precise_angle_deg(a: Quat, b: Quat) -> f64 {
        let (a, b) = (a.normalize(), b.normalize());
        let diff = |s: f32| -> f64 {
            let d = [
                (a.x - s * b.x) as f64,
                (a.y - s * b.y) as f64,
                (a.z - s * b.z) as f64,
                (a.w - s * b.w) as f64,
            ];
            d.iter().map(|v| v * v).sum::<f64>().sqrt()
        };
        let chord = diff(1.0).min(diff(-1.0));
        (4.0 * (chord / 2.0).clamp(-1.0, 1.0).asin()).to_degrees()
    }

    fn spread() -> Vec<Quat> {
        let mut out = Vec::new();
        for i in 0..24 {
            let a = i as f32 * 0.37;
            out.push(
                (Quat::from_rotation_x(a) * Quat::from_rotation_y(a * 1.7)
                    * Quat::from_rotation_z(a * 0.3))
                .normalize(),
            );
        }
        out
    }

    /// The whole justification for the wide grid: it has to actually be ~64x
    /// finer, and comfortably inside the quantum the island limits assume.
    #[test]
    fn wide_is_far_more_precise_than_narrow() {
        let mut worst_wide = 0.0f64;
        let mut worst_narrow = 0.0f64;
        for q in spread() {
            worst_wide = worst_wide.max(precise_angle_deg(q, decode_quat48(encode_quat48(q))));
            worst_narrow = worst_narrow.max(precise_angle_deg(q, decode_quat32(encode_quat32(q))));
        }
        // The island limits are derived from this quantum, so if the grid is
        // coarser than advertised every derivable-radius decision is wrong.
        let limit_deg = crate::island::WIDE_ROTATION_QUANTUM_RAD.to_degrees() as f64;
        assert!(worst_wide < limit_deg, "wide error {worst_wide} deg >= limit {limit_deg}");
        assert!(
            worst_narrow / worst_wide > 32.0,
            "expected ~64x finer, got {:.1}x (narrow {worst_narrow}, wide {worst_wide})",
            worst_narrow / worst_wide
        );
    }

    #[test]
    fn wide_values_are_self_describing() {
        for q in spread() {
            assert!(is_wide_rotation(encode_quat48(q)));
            assert!(!is_wide_rotation(encode_quat32(q) as u64));
        }
    }

    /// Mode selection has to pick the cheapest coding that reproduces the exact
    /// bits, and never mix grids across a delta.
    #[test]
    fn mode_ladder_covers_both_grids_and_round_trips() {
        let base = encode_quat48(Quat::from_rotation_x(0.4));
        let (index, components) = unpack_quat48(base);
        let cases = [
            (base, ROT_HELD),
            (pack_quat48(index, [components[0] + 5, components[1] - 3, components[2] + 1]), ROT_WDELTA8),
            (pack_quat48(index, [components[0] + 900, components[1] - 400, components[2] + 12]), ROT_WDELTA16),
            // A different largest component is a different parameterisation,
            // so it cannot be coded as a delta.
            (pack_quat48((index + 1) % 4, components), ROT_WFULL),
            // Crossing grids restarts the chain with an absolute of the new format.
            (narrow(Quat::from_rotation_x(0.4)), ROT_FULL),
        ];
        for (target, want) in cases {
            let mode = rotation_mode(Some(base), target);
            assert_eq!(mode, want, "mode for {target:#x}");
            let mut buffer = Vec::new();
            write_rotation(&mut buffer, mode, Some(base), target);
            let mut cursor = 0;
            let decoded = read_rotation(&buffer, &mut cursor, mode, Some(base)).unwrap();
            assert_eq!(decoded, target, "round trip for mode {mode}");
            assert_eq!(cursor, buffer.len(), "mode {mode} left bytes unread");
        }
    }

    /// A wide absolute costs 7 bytes against the narrow 4. That is the entire
    /// price of the mechanism, so pin it.
    #[test]
    fn wide_absolute_costs_seven_bytes() {
        let mut buffer = Vec::new();
        write_rotation(&mut buffer, ROT_WFULL, None, encode_quat48(Quat::from_rotation_z(0.9)));
        assert_eq!(buffer.len(), ROTATION_WIDE_BYTES);
    }

    /// Wide rotations must survive the block boundary through the carried tail,
    /// byte-exactly, or a body that spans blocks decodes onto the wrong grid.
    #[test]
    fn wide_rotations_survive_a_block_boundary() {
        let wide = encode_quat48(Quat::from_rotation_y(0.31));
        let mut records = vec![Record::SampleRun {
            body: 2,
            tick: 8,
            stride: 1,
            last_offset: 1,
            continuity: false,
            second_order: false,
            step_exp: 0,
            frames: vec![([10, 20, 30], wide), ([11, 20, 30], wide)],
        }];
        let mut tails = vec![None; 4];
        let payload = encode_block(&mut records, 8, &mut tails, true);
        let mut decode_tails = vec![None; 4];
        let decoded = decode_block(&payload, &mut decode_tails, true).unwrap();
        assert_eq!(decoded, records);
        assert_eq!(tails[2], Some(([11, 20, 30], wide)));
        assert_eq!(decode_tails[2], tails[2]);
    }

    /// The v1 wire must not move a byte: it is guarded by two tripwires and a
    /// regression suite, and a silent change there invalidates every number.
    #[test]
    fn v1_wire_never_carries_a_mode_byte_on_absolutes() {
        let rotation = narrow(Quat::from_rotation_x(0.2));
        let mut v1 = Vec::new();
        write_absolute_rotation(&mut v1, rotation, false);
        assert_eq!(v1.len(), ROTATION_BYTES, "v1 absolute must stay 4 raw bytes");
        let mut v2 = Vec::new();
        write_absolute_rotation(&mut v2, rotation, true);
        assert_eq!(v2.len(), ROTATION_BYTES + 1, "v2 absolute prefixes a mode");
        assert_eq!(v2[0], ROT_FULL);
        let mut cursor = 0;
        assert_eq!(read_absolute_rotation(&v1, &mut cursor, false).unwrap(), rotation);
        cursor = 0;
        assert_eq!(read_absolute_rotation(&v2, &mut cursor, true).unwrap(), rotation);
    }
}
