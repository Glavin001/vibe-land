//! The real wire serializer for the city destruction streams.
//!
//! Little-endian throughout. Four packet families, each with its own sequence
//! space, layered on the byte-accounting model in `packet` (which the offline
//! codec validated for sizes/selection — it never serialized real bytes):
//!
//! - `PKT_CITY_CHUNKS` (datagram): per-island-body kinematic records against
//!   globally scheduled baselines. Packet-local LEB128 id gaps; every packet
//!   independently decodable.
//! - `PKT_CITY_TOPOLOGY` (reliable): fracture batches (broken bonds, island
//!   promotions with explicit membership, retirements), settle records, wakes.
//! - `PKT_CITY_BASELINE` (reliable, scheduled): byte-identical broadcast of
//!   all awake body poses; what DELTA records reference.
//! - `PKT_CITY_BOOTSTRAP` (reliable): late-join/resync state — manifest hash,
//!   per-structure alive-bond bitsets, live islands, settled poses.
//!
//! Golden-vector tests pin the exact bytes; the TypeScript decoder mirrors
//! them (the moq `wire.rs` ↔ `payload.test.ts` pattern).

use glam::Vec3;

use crate::ids;
use crate::quant::{
    decode_quat32, decode_region_position, encode_quat32, quantize_position_cm,
    quantize_vec_i16_raw, region_and_local, ANGULAR_VELOCITY_QUANTUM, LINEAR_VELOCITY_QUANTUM,
};
use crate::types::Pose;

pub const CITY_WIRE_VERSION: u8 = 1;

pub const PKT_CITY_CHUNKS: u8 = 119;
pub const PKT_CITY_TOPOLOGY: u8 = 120;
pub const PKT_CITY_BASELINE: u8 = 121;
pub const PKT_CITY_BOOTSTRAP: u8 = 122;
pub const PKT_CITY_RESYNC_REQUEST: u8 = 9;

pub const CHUNKS_HEADER_BYTES: usize = 16;

const RECORD_MODE_MASK: u8 = 0b0000_0111;
pub const RECORD_FLAG_SETTLED_HINT: u8 = 0b0000_1000;
pub const RECORD_FLAG_KINEMATIC_SUPPORT: u8 = 0b0001_0000;

const SECTION_FRACTURE: u8 = 0x01;
const SECTION_SETTLE: u8 = 0x02;
const SECTION_WAKE: u8 = 0x03;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordMode {
    Absolute = 0,
    Delta = 1,
    MotionAbsolute = 2,
    MotionDelta = 3,
    Ballistic = 4,
}

impl RecordMode {
    fn from_bits(bits: u8) -> Option<Self> {
        match bits & RECORD_MODE_MASK {
            0 => Some(Self::Absolute),
            1 => Some(Self::Delta),
            2 => Some(Self::MotionAbsolute),
            3 => Some(Self::MotionDelta),
            4 => Some(Self::Ballistic),
            _ => None,
        }
    }

    pub fn has_velocity(self) -> bool {
        matches!(
            self,
            Self::MotionAbsolute | Self::MotionDelta | Self::Ballistic
        )
    }

    pub fn is_delta(self) -> bool {
        matches!(self, Self::Delta | Self::MotionDelta)
    }
}

/// One encoded body record, ready for packet composition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodyRecord {
    pub body_entity: u32,
    pub mode: RecordMode,
    pub flags: u8,
    pub pose: Pose,
    /// For DELTA modes: position relative to the referenced baseline pose, cm
    /// quantized on encode.
    pub baseline_position: Vec3,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
}

impl BodyRecord {
    pub fn body_bytes(&self) -> usize {
        let pose_bytes = if self.mode.is_delta() { 10 } else { 16 };
        let velocity_bytes = if self.mode.has_velocity() { 12 } else { 0 };
        // tag + fixed 4-byte logical id + payload (packetize swaps the id for
        // the packet-local LEB128 gap).
        1 + 4 + pose_bytes + velocity_bytes
    }
}

/// A decoded record as the client sees it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecodedBodyRecord {
    pub body_entity: u32,
    pub mode: RecordMode,
    pub flags: u8,
    /// Absolute position for non-delta modes; baseline-relative offset for
    /// delta modes (the client adds its stored baseline position).
    pub position: Vec3,
    pub rotation: glam::Quat,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChunksDatagram {
    pub sequence: u32,
    pub baseline_id: u16,
    pub sim_tick: u32,
    pub records: Vec<DecodedBodyRecord>,
}

#[derive(Debug)]
pub enum WireError {
    Truncated,
    BadKind(u8),
    BadVersion(u8),
    BadMode(u8),
    BadSection(u8),
    Overflow,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => write!(f, "truncated packet"),
            Self::BadKind(kind) => write!(f, "unexpected packet kind {kind}"),
            Self::BadVersion(version) => write!(f, "unsupported wire version {version}"),
            Self::BadMode(mode) => write!(f, "invalid record mode {mode}"),
            Self::BadSection(section) => write!(f, "invalid topology section {section}"),
            Self::Overflow => write!(f, "varint overflow"),
        }
    }
}

impl std::error::Error for WireError {}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

pub fn write_leb128(out: &mut Vec<u8>, mut value: u32) {
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

pub struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len() - self.offset
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], WireError> {
        if self.remaining() < count {
            return Err(WireError::Truncated);
        }
        let slice = &self.data[self.offset..self.offset + count];
        self.offset += count;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, WireError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub fn i16(&mut self) -> Result<i16, WireError> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub fn u32(&mut self) -> Result<u32, WireError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub fn leb128(&mut self) -> Result<u32, WireError> {
        let mut value: u32 = 0;
        let mut shift = 0;
        loop {
            let byte = self.u8()?;
            if shift >= 32 {
                return Err(WireError::Overflow);
            }
            value |= ((byte & 0x7f) as u32) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }

    pub fn i16x3(&mut self) -> Result<[i16; 3], WireError> {
        Ok([self.i16()?, self.i16()?, self.i16()?])
    }
}

fn write_i16x3(out: &mut Vec<u8>, values: [i16; 3]) {
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn write_pose_absolute(out: &mut Vec<u8>, pose: Pose) {
    let (region, local) = region_and_local(pose.position);
    write_i16x3(out, region);
    write_i16x3(out, local);
    out.extend_from_slice(&encode_quat32(pose.rotation).to_le_bytes());
}

fn read_pose_absolute(reader: &mut Reader) -> Result<(Vec3, glam::Quat), WireError> {
    let region = reader.i16x3()?;
    let local = reader.i16x3()?;
    let rotation = decode_quat32(reader.u32()?);
    Ok((decode_region_position(region, local), rotation))
}

fn write_velocities(out: &mut Vec<u8>, linear: Vec3, angular: Vec3) {
    write_i16x3(out, quantize_vec_i16_raw(linear, LINEAR_VELOCITY_QUANTUM));
    write_i16x3(out, quantize_vec_i16_raw(angular, ANGULAR_VELOCITY_QUANTUM));
}

fn read_velocities(reader: &mut Reader) -> Result<(Vec3, Vec3), WireError> {
    let linear = reader.i16x3()?;
    let angular = reader.i16x3()?;
    Ok((
        Vec3::new(linear[0] as f32, linear[1] as f32, linear[2] as f32) * LINEAR_VELOCITY_QUANTUM,
        Vec3::new(angular[0] as f32, angular[1] as f32, angular[2] as f32)
            * ANGULAR_VELOCITY_QUANTUM,
    ))
}

/// Baseline-relative position delta in cm, saturating i16 per axis.
fn delta_cm(position: Vec3, baseline: Vec3) -> [i16; 3] {
    let position_cm = quantize_position_cm(position);
    let baseline_cm = quantize_position_cm(baseline);
    let mut out = [0_i16; 3];
    for axis in 0..3 {
        out[axis] = (position_cm[axis] - baseline_cm[axis])
            .clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    }
    out
}

/// Whether a delta against `baseline` is representable without saturation.
pub fn delta_fits(position: Vec3, baseline: Vec3) -> bool {
    let position_cm = quantize_position_cm(position);
    let baseline_cm = quantize_position_cm(baseline);
    (0..3).all(|axis| {
        let delta = position_cm[axis] - baseline_cm[axis];
        delta >= i16::MIN as i32 && delta <= i16::MAX as i32
    })
}

// ---------------------------------------------------------------------------
// PKT_CITY_CHUNKS — kinematic datagrams
// ---------------------------------------------------------------------------

/// Encode records (must be sorted ascending by body entity) into ≤ MTU
/// datagrams. Returns the encoded packets; `sequence` advances one per packet.
pub fn encode_chunks_datagrams(
    records: &[BodyRecord],
    sequence: &mut u32,
    baseline_id: u16,
    sim_tick: u32,
) -> Vec<Vec<u8>> {
    use crate::packet::{packed_record_bytes, relative_body_id_bytes};
    use crate::quant::MAX_DATAGRAM;

    debug_assert!(records.windows(2).all(|w| w[0].body_entity < w[1].body_entity));

    let mut packets: Vec<Vec<u8>> = Vec::new();
    let mut current: Vec<u8> = Vec::new();
    let mut current_records: Vec<&BodyRecord> = Vec::new();

    let flush = |packets: &mut Vec<Vec<u8>>,
                 current_records: &mut Vec<&BodyRecord>,
                 sequence: &mut u32| {
        if current_records.is_empty() {
            return;
        }
        let mut packet = Vec::with_capacity(MAX_DATAGRAM);
        packet.push(PKT_CITY_CHUNKS);
        packet.push(CITY_WIRE_VERSION);
        packet.extend_from_slice(&sequence.to_le_bytes());
        packet.extend_from_slice(&baseline_id.to_le_bytes());
        packet.extend_from_slice(&sim_tick.to_le_bytes());
        packet.extend_from_slice(&(current_records.len() as u16).to_le_bytes());
        packet.extend_from_slice(&[0, 0]);
        debug_assert_eq!(packet.len(), CHUNKS_HEADER_BYTES);
        let mut previous: Option<u32> = None;
        for record in current_records.iter() {
            packet.push(record.mode as u8 | record.flags);
            let id_value = previous.map_or(record.body_entity, |p| record.body_entity - p);
            write_leb128(&mut packet, id_value);
            previous = Some(record.body_entity);
            if record.mode.is_delta() {
                write_i16x3(&mut packet, delta_cm(record.pose.position, record.baseline_position));
                packet.extend_from_slice(&encode_quat32(record.pose.rotation).to_le_bytes());
            } else {
                write_pose_absolute(&mut packet, record.pose);
            }
            if record.mode.has_velocity() {
                write_velocities(&mut packet, record.linear_velocity, record.angular_velocity);
            }
        }
        debug_assert!(packet.len() <= MAX_DATAGRAM, "packet {} > MTU", packet.len());
        packets.push(packet);
        *sequence += 1;
        current_records.clear();
    };

    let mut current_bytes = CHUNKS_HEADER_BYTES;
    for record in records {
        let previous = current_records.last().map(|r| r.body_entity);
        let mut record_bytes = packed_record_bytes(record.body_bytes(), record.body_entity, previous);
        if current_bytes + record_bytes > MAX_DATAGRAM && !current_records.is_empty() {
            flush(&mut packets, &mut current_records, sequence);
            current_bytes = CHUNKS_HEADER_BYTES;
            record_bytes = record.body_bytes() - 4 + relative_body_id_bytes(record.body_entity, None);
        }
        current_bytes += record_bytes;
        current_records.push(record);
    }
    flush(&mut packets, &mut current_records, sequence);
    let _ = current;
    packets
}

pub fn decode_chunks_datagram(data: &[u8]) -> Result<ChunksDatagram, WireError> {
    let mut reader = Reader::new(data);
    let kind = reader.u8()?;
    if kind != PKT_CITY_CHUNKS {
        return Err(WireError::BadKind(kind));
    }
    let version = reader.u8()?;
    if version != CITY_WIRE_VERSION {
        return Err(WireError::BadVersion(version));
    }
    let sequence = reader.u32()?;
    let baseline_id = reader.u16()?;
    let sim_tick = reader.u32()?;
    let record_count = reader.u16()?;
    let _reserved = reader.u16()?;

    let mut records = Vec::with_capacity(record_count as usize);
    let mut previous: Option<u32> = None;
    for _ in 0..record_count {
        let tag = reader.u8()?;
        let mode = RecordMode::from_bits(tag).ok_or(WireError::BadMode(tag))?;
        let flags = tag & !RECORD_MODE_MASK;
        let id_value = reader.leb128()?;
        let body_entity = match previous {
            None => id_value,
            Some(p) => p + id_value,
        };
        previous = Some(body_entity);
        let (position, rotation) = if mode.is_delta() {
            let delta = reader.i16x3()?;
            let rotation = decode_quat32(reader.u32()?);
            (
                Vec3::new(delta[0] as f32, delta[1] as f32, delta[2] as f32) * 0.01,
                rotation,
            )
        } else {
            read_pose_absolute(&mut reader)?
        };
        let (linear_velocity, angular_velocity) = if mode.has_velocity() {
            read_velocities(&mut reader)?
        } else {
            (Vec3::ZERO, Vec3::ZERO)
        };
        records.push(DecodedBodyRecord {
            body_entity,
            mode,
            flags,
            position,
            rotation,
            linear_velocity,
            angular_velocity,
        });
    }
    Ok(ChunksDatagram {
        sequence,
        baseline_id,
        sim_tick,
        records,
    })
}

// ---------------------------------------------------------------------------
// PKT_CITY_TOPOLOGY — reliable fracture/settle/wake stream
// ---------------------------------------------------------------------------

use vibe_netcode::destruction_backend::{FractureBatch, SettleEvent};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TopologyMessage {
    pub topo_seq: u32,
    pub sim_tick: u32,
    pub batches: Vec<FractureBatch>,
    pub settled: Vec<SettleEvent>,
    /// (structure_id, island_serial) pairs that woke back up.
    pub wakes: Vec<(u32, u32)>,
}

pub fn encode_topology(message: &TopologyMessage) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(PKT_CITY_TOPOLOGY);
    out.push(CITY_WIRE_VERSION);
    out.extend_from_slice(&message.topo_seq.to_le_bytes());
    out.extend_from_slice(&message.sim_tick.to_le_bytes());
    let section_count = message.batches.len()
        + usize::from(!message.settled.is_empty())
        + usize::from(!message.wakes.is_empty());
    out.extend_from_slice(&(section_count as u16).to_le_bytes());

    for batch in &message.batches {
        out.push(SECTION_FRACTURE);
        write_leb128(&mut out, batch.structure_id);
        // Broken bonds: ascending bond-index gaps within the structure.
        let mut bond_indices: Vec<u32> = batch
            .broken_bond_ids
            .iter()
            .map(|&id| ids::bond_id_parts(id).1)
            .collect();
        bond_indices.sort_unstable();
        write_leb128(&mut out, bond_indices.len() as u32);
        let mut previous = 0;
        for (i, bond) in bond_indices.iter().enumerate() {
            let gap = if i == 0 { *bond } else { bond - previous };
            write_leb128(&mut out, gap);
            previous = *bond;
        }
        // Promotions with explicit membership (node-index gaps).
        write_leb128(&mut out, batch.promoted_islands.len() as u32);
        for promotion in &batch.promoted_islands {
            write_leb128(&mut out, promotion.island_id);
            let mut nodes: Vec<u32> = promotion
                .chunks
                .iter()
                .map(|&chunk| ids::chunk_id_parts(chunk).1)
                .collect();
            nodes.sort_unstable();
            write_leb128(&mut out, nodes.len() as u32);
            let mut previous_node = 0;
            for (i, node) in nodes.iter().enumerate() {
                let gap = if i == 0 { *node } else { node - previous_node };
                write_leb128(&mut out, gap);
                previous_node = *node;
            }
            write_pose_absolute(
                &mut out,
                Pose {
                    position: Vec3::from_array(promotion.position),
                    rotation: glam::Quat::from_array(promotion.rotation),
                },
            );
            write_velocities(
                &mut out,
                Vec3::from_array(promotion.linear_velocity),
                Vec3::from_array(promotion.angular_velocity),
            );
        }
        write_leb128(&mut out, batch.retired_island_ids.len() as u32);
        for retired in &batch.retired_island_ids {
            write_leb128(&mut out, *retired);
        }
    }

    if !message.settled.is_empty() {
        out.push(SECTION_SETTLE);
        write_leb128(&mut out, message.settled.len() as u32);
        for settle in &message.settled {
            write_leb128(&mut out, settle.structure_id);
            write_leb128(&mut out, settle.island_id);
            write_pose_absolute(
                &mut out,
                Pose {
                    position: Vec3::from_array(settle.position),
                    rotation: glam::Quat::from_array(settle.rotation),
                },
            );
        }
    }

    if !message.wakes.is_empty() {
        out.push(SECTION_WAKE);
        write_leb128(&mut out, message.wakes.len() as u32);
        for (structure_id, serial) in &message.wakes {
            write_leb128(&mut out, *structure_id);
            write_leb128(&mut out, *serial as u32);
        }
    }
    out
}

pub fn decode_topology(data: &[u8]) -> Result<TopologyMessage, WireError> {
    let mut reader = Reader::new(data);
    let kind = reader.u8()?;
    if kind != PKT_CITY_TOPOLOGY {
        return Err(WireError::BadKind(kind));
    }
    let version = reader.u8()?;
    if version != CITY_WIRE_VERSION {
        return Err(WireError::BadVersion(version));
    }
    let mut message = TopologyMessage {
        topo_seq: reader.u32()?,
        sim_tick: reader.u32()?,
        ..Default::default()
    };
    let section_count = reader.u16()?;
    for _ in 0..section_count {
        let section = reader.u8()?;
        match section {
            SECTION_FRACTURE => {
                let structure_id = reader.leb128()?;
                let bond_count = reader.leb128()?;
                let mut broken_bond_ids = Vec::with_capacity(bond_count as usize);
                let mut bond = 0;
                for i in 0..bond_count {
                    let gap = reader.leb128()?;
                    bond = if i == 0 { gap } else { bond + gap };
                    broken_bond_ids.push(ids::bond_id(structure_id, bond));
                }
                let promotion_count = reader.leb128()?;
                let mut promoted_islands = Vec::with_capacity(promotion_count as usize);
                for _ in 0..promotion_count {
                    let island_id = reader.leb128()?;
                    let node_count = reader.leb128()?;
                    let mut chunks = Vec::with_capacity(node_count as usize);
                    let mut node = 0;
                    for i in 0..node_count {
                        let gap = reader.leb128()?;
                        node = if i == 0 { gap } else { node + gap };
                        chunks.push(ids::chunk_id(structure_id, node));
                    }
                    let (position, rotation) = read_pose_absolute(&mut reader)?;
                    let (linear_velocity, angular_velocity) = read_velocities(&mut reader)?;
                    promoted_islands.push(vibe_netcode::destruction_backend::IslandPromotion {
                        structure_id,
                        island_id,
                        chunks,
                        mass: 0.0,
                        center_of_mass: [0.0; 3],
                        inertia_diagonal: [0.0; 3],
                        position: position.to_array(),
                        rotation: rotation.to_array(),
                        linear_velocity: linear_velocity.to_array(),
                        angular_velocity: angular_velocity.to_array(),
                        split_impulse: [0.0; 3],
                    });
                }
                let retired_count = reader.leb128()?;
                let mut retired_island_ids = Vec::with_capacity(retired_count as usize);
                for _ in 0..retired_count {
                    retired_island_ids.push(reader.leb128()?);
                }
                message.batches.push(FractureBatch {
                    structure_id,
                    broken_bond_ids,
                    migrations: Vec::new(),
                    promoted_islands,
                    retired_island_ids,
                });
            }
            SECTION_SETTLE => {
                let count = reader.leb128()?;
                for _ in 0..count {
                    let structure_id = reader.leb128()?;
                    let island_id = reader.leb128()?;
                    let (position, rotation) = read_pose_absolute(&mut reader)?;
                    message.settled.push(SettleEvent {
                        structure_id,
                        island_id,
                        position: position.to_array(),
                        rotation: rotation.to_array(),
                    });
                }
            }
            SECTION_WAKE => {
                let count = reader.leb128()?;
                for _ in 0..count {
                    let structure_id = reader.leb128()?;
                    let serial = reader.leb128()?;
                    message.wakes.push((structure_id, serial));
                }
            }
            other => return Err(WireError::BadSection(other)),
        }
    }
    Ok(message)
}

// ---------------------------------------------------------------------------
// PKT_CITY_BASELINE — scheduled global baselines
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BaselineRecord {
    pub body_entity: u32,
    pub pose: Pose,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BaselineMessage {
    pub baseline_id: u16,
    pub sim_tick: u32,
    pub part_index: u16,
    pub part_count: u16,
    pub records: Vec<BaselineRecord>,
}

pub fn encode_baseline(message: &BaselineMessage) -> Vec<u8> {
    debug_assert!(message
        .records
        .windows(2)
        .all(|w| w[0].body_entity < w[1].body_entity));
    let mut out = Vec::new();
    out.push(PKT_CITY_BASELINE);
    out.push(CITY_WIRE_VERSION);
    out.extend_from_slice(&message.baseline_id.to_le_bytes());
    out.extend_from_slice(&message.sim_tick.to_le_bytes());
    out.extend_from_slice(&message.part_index.to_le_bytes());
    out.extend_from_slice(&message.part_count.to_le_bytes());
    out.extend_from_slice(&(message.records.len() as u16).to_le_bytes());
    let mut previous: Option<u32> = None;
    for record in &message.records {
        let id_value = previous.map_or(record.body_entity, |p| record.body_entity - p);
        write_leb128(&mut out, id_value);
        previous = Some(record.body_entity);
        write_pose_absolute(&mut out, record.pose);
    }
    out
}

pub fn decode_baseline(data: &[u8]) -> Result<BaselineMessage, WireError> {
    let mut reader = Reader::new(data);
    let kind = reader.u8()?;
    if kind != PKT_CITY_BASELINE {
        return Err(WireError::BadKind(kind));
    }
    let version = reader.u8()?;
    if version != CITY_WIRE_VERSION {
        return Err(WireError::BadVersion(version));
    }
    let baseline_id = reader.u16()?;
    let sim_tick = reader.u32()?;
    let part_index = reader.u16()?;
    let part_count = reader.u16()?;
    let record_count = reader.u16()?;
    let mut records = Vec::with_capacity(record_count as usize);
    let mut previous: Option<u32> = None;
    for _ in 0..record_count {
        let id_value = reader.leb128()?;
        let body_entity = match previous {
            None => id_value,
            Some(p) => p + id_value,
        };
        previous = Some(body_entity);
        let (position, rotation) = read_pose_absolute(&mut reader)?;
        records.push(BaselineRecord {
            body_entity,
            pose: Pose { position, rotation },
        });
    }
    Ok(BaselineMessage {
        baseline_id,
        sim_tick,
        part_index,
        part_count,
        records,
    })
}

// ---------------------------------------------------------------------------
// PKT_CITY_BOOTSTRAP — late join / resync
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct BootstrapStructure {
    pub structure_id: u32,
    /// Bit `i` set = bond index `i` is still alive.
    pub alive_bonds: Vec<u8>,
    pub bond_count: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BootstrapIsland {
    pub structure_id: u32,
    pub island_id: u32,
    /// Node indices, ascending.
    pub nodes: Vec<u32>,
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub settled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BootstrapMessage {
    pub sim_tick: u32,
    pub manifest_hash: [u8; 32],
    pub baseline_id: u16,
    pub topo_seq: u32,
    pub structures: Vec<BootstrapStructure>,
    pub islands: Vec<BootstrapIsland>,
}

pub fn encode_bootstrap(message: &BootstrapMessage) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(PKT_CITY_BOOTSTRAP);
    out.push(CITY_WIRE_VERSION);
    out.extend_from_slice(&message.sim_tick.to_le_bytes());
    out.extend_from_slice(&message.manifest_hash);
    out.extend_from_slice(&message.baseline_id.to_le_bytes());
    out.extend_from_slice(&message.topo_seq.to_le_bytes());

    write_leb128(&mut out, message.structures.len() as u32);
    for structure in &message.structures {
        write_leb128(&mut out, structure.structure_id);
        write_leb128(&mut out, structure.bond_count);
        debug_assert_eq!(
            structure.alive_bonds.len(),
            structure.bond_count.div_ceil(8) as usize
        );
        out.extend_from_slice(&structure.alive_bonds);
    }

    write_leb128(&mut out, message.islands.len() as u32);
    for island in &message.islands {
        write_leb128(&mut out, island.structure_id);
        write_leb128(&mut out, island.island_id);
        write_leb128(&mut out, island.nodes.len() as u32);
        let mut previous = 0;
        for (i, node) in island.nodes.iter().enumerate() {
            let gap = if i == 0 { *node } else { node - previous };
            write_leb128(&mut out, gap);
            previous = *node;
        }
        write_pose_absolute(&mut out, island.pose);
        write_velocities(&mut out, island.linear_velocity, island.angular_velocity);
        out.push(island.settled as u8);
    }
    out
}

pub fn decode_bootstrap(data: &[u8]) -> Result<BootstrapMessage, WireError> {
    let mut reader = Reader::new(data);
    let kind = reader.u8()?;
    if kind != PKT_CITY_BOOTSTRAP {
        return Err(WireError::BadKind(kind));
    }
    let version = reader.u8()?;
    if version != CITY_WIRE_VERSION {
        return Err(WireError::BadVersion(version));
    }
    let sim_tick = reader.u32()?;
    let mut manifest_hash = [0_u8; 32];
    manifest_hash.copy_from_slice(reader.take(32)?);
    let baseline_id = reader.u16()?;
    let topo_seq = reader.u32()?;

    let structure_count = reader.leb128()?;
    let mut structures = Vec::with_capacity(structure_count as usize);
    for _ in 0..structure_count {
        let structure_id = reader.leb128()?;
        let bond_count = reader.leb128()?;
        let bytes = bond_count.div_ceil(8) as usize;
        structures.push(BootstrapStructure {
            structure_id,
            alive_bonds: reader.take(bytes)?.to_vec(),
            bond_count,
        });
    }

    let island_count = reader.leb128()?;
    let mut islands = Vec::with_capacity(island_count as usize);
    for _ in 0..island_count {
        let structure_id = reader.leb128()?;
        let island_id = reader.leb128()?;
        let node_count = reader.leb128()?;
        let mut nodes = Vec::with_capacity(node_count as usize);
        let mut node = 0;
        for i in 0..node_count {
            let gap = reader.leb128()?;
            node = if i == 0 { gap } else { node + gap };
            nodes.push(node);
        }
        let (position, rotation) = read_pose_absolute(&mut reader)?;
        let (linear_velocity, angular_velocity) = read_velocities(&mut reader)?;
        let settled = reader.u8()? != 0;
        islands.push(BootstrapIsland {
            structure_id,
            island_id,
            nodes,
            pose: Pose { position, rotation },
            linear_velocity,
            angular_velocity,
            settled,
        });
    }
    Ok(BootstrapMessage {
        sim_tick,
        manifest_hash,
        baseline_id,
        topo_seq,
        structures,
        islands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Quat;
    use vibe_netcode::destruction_backend::IslandPromotion;

    fn pose(x: f32, y: f32, z: f32) -> Pose {
        Pose {
            position: Vec3::new(x, y, z),
            rotation: Quat::from_rotation_y(0.5),
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn chunks_datagram_round_trips() {
        let baseline = Vec3::new(10.0, 5.0, -3.0);
        let records = vec![
            BodyRecord {
                body_entity: ids::body_entity(0, 1),
                mode: RecordMode::Absolute,
                flags: 0,
                pose: pose(1.0, 2.0, 3.0),
                baseline_position: Vec3::ZERO,
                linear_velocity: Vec3::ZERO,
                angular_velocity: Vec3::ZERO,
            },
            BodyRecord {
                body_entity: ids::body_entity(0, 2),
                mode: RecordMode::MotionDelta,
                flags: RECORD_FLAG_SETTLED_HINT,
                pose: pose(10.5, 5.25, -3.125),
                baseline_position: baseline,
                linear_velocity: Vec3::new(1.5, -2.0, 0.25),
                angular_velocity: Vec3::new(0.1, 0.0, -0.2),
            },
            BodyRecord {
                body_entity: ids::body_entity(2, 7),
                mode: RecordMode::Ballistic,
                flags: 0,
                pose: pose(-40.0, 12.0, 8.0),
                baseline_position: Vec3::ZERO,
                linear_velocity: Vec3::new(-8.0, 14.0, 0.0),
                angular_velocity: Vec3::new(0.0, 3.0, 0.0),
            },
        ];
        let mut sequence = 41;
        let packets = encode_chunks_datagrams(&records, &mut sequence, 6, 1234);
        assert_eq!(packets.len(), 1);
        assert_eq!(sequence, 42);

        let decoded = decode_chunks_datagram(&packets[0]).expect("decode");
        assert_eq!(decoded.sequence, 41);
        assert_eq!(decoded.baseline_id, 6);
        assert_eq!(decoded.sim_tick, 1234);
        assert_eq!(decoded.records.len(), 3);

        let absolute = &decoded.records[0];
        assert_eq!(absolute.body_entity, ids::body_entity(0, 1));
        assert!((absolute.position - Vec3::new(1.0, 2.0, 3.0)).length() < 0.0051 * 2.0);

        let delta = &decoded.records[1];
        assert_eq!(delta.mode, RecordMode::MotionDelta);
        assert_eq!(delta.flags, RECORD_FLAG_SETTLED_HINT);
        let reconstructed = baseline + delta.position;
        assert!((reconstructed - Vec3::new(10.5, 5.25, -3.125)).length() < 0.011);
        assert!((delta.linear_velocity - Vec3::new(1.5, -2.0, 0.25)).length() < 0.02);

        let ballistic = &decoded.records[2];
        assert_eq!(ballistic.body_entity, ids::body_entity(2, 7));
        assert!((ballistic.linear_velocity - Vec3::new(-8.0, 14.0, 0.0)).length() < 0.02);
    }

    #[test]
    fn chunks_datagrams_split_at_mtu_and_stay_decodable() {
        let records: Vec<BodyRecord> = (0..200)
            .map(|i| BodyRecord {
                body_entity: ids::body_entity(0, 1) + i * 3,
                mode: RecordMode::MotionAbsolute,
                flags: 0,
                pose: pose(i as f32, 1.0, -(i as f32)),
                baseline_position: Vec3::ZERO,
                linear_velocity: Vec3::X,
                angular_velocity: Vec3::ZERO,
            })
            .collect();
        let mut sequence = 0;
        let packets = encode_chunks_datagrams(&records, &mut sequence, 1, 9);
        assert!(packets.len() > 1);
        let mut total = 0;
        for (i, packet) in packets.iter().enumerate() {
            assert!(packet.len() <= crate::quant::MAX_DATAGRAM);
            let decoded = decode_chunks_datagram(packet).expect("decode");
            assert_eq!(decoded.sequence, i as u32);
            total += decoded.records.len();
        }
        assert_eq!(total, 200);
    }

    #[test]
    fn topology_round_trips() {
        let message = TopologyMessage {
            topo_seq: 9,
            sim_tick: 600,
            batches: vec![FractureBatch {
                structure_id: 3,
                broken_bond_ids: vec![ids::bond_id(3, 5), ids::bond_id(3, 6), ids::bond_id(3, 90)],
                migrations: Vec::new(),
                promoted_islands: vec![IslandPromotion {
                    structure_id: 3,
                    island_id: 2,
                    chunks: vec![ids::chunk_id(3, 10), ids::chunk_id(3, 11), ids::chunk_id(3, 40)],
                    position: [1.0, 2.0, 3.0],
                    rotation: Quat::from_rotation_y(0.5).to_array(),
                    linear_velocity: [0.5, -1.0, 0.0],
                    angular_velocity: [0.0, 0.1, 0.0],
                    ..Default::default()
                }],
                retired_island_ids: vec![1],
            }],
            settled: vec![SettleEvent {
                structure_id: 3,
                island_id: 2,
                position: [1.5, 0.0, 3.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
            }],
            wakes: vec![(3, 2)],
        };
        let bytes = encode_topology(&message);
        let decoded = decode_topology(&bytes).expect("decode");
        assert_eq!(decoded.topo_seq, 9);
        assert_eq!(decoded.batches.len(), 1);
        let batch = &decoded.batches[0];
        assert_eq!(batch.structure_id, 3);
        assert_eq!(batch.broken_bond_ids, message.batches[0].broken_bond_ids);
        assert_eq!(batch.promoted_islands[0].chunks, message.batches[0].promoted_islands[0].chunks);
        assert_eq!(batch.retired_island_ids, vec![1]);
        let promo = &batch.promoted_islands[0];
        assert!((Vec3::from_array(promo.position) - Vec3::new(1.0, 2.0, 3.0)).length() < 0.011);
        assert_eq!(decoded.settled.len(), 1);
        assert_eq!(decoded.wakes, vec![(3, 2)]);
    }

    #[test]
    fn baseline_round_trips() {
        let message = BaselineMessage {
            baseline_id: 3,
            sim_tick: 180,
            part_index: 0,
            part_count: 1,
            records: vec![
                BaselineRecord {
                    body_entity: ids::body_entity(0, 0),
                    pose: pose(0.0, 0.0, 0.0),
                },
                BaselineRecord {
                    body_entity: ids::body_entity(1, 4),
                    pose: pose(-27.0, 3.0, 9.0),
                },
            ],
        };
        let bytes = encode_baseline(&message);
        let decoded = decode_baseline(&bytes).expect("decode");
        assert_eq!(decoded.baseline_id, 3);
        assert_eq!(decoded.records.len(), 2);
        assert_eq!(decoded.records[1].body_entity, ids::body_entity(1, 4));
        assert!(
            (decoded.records[1].pose.position - Vec3::new(-27.0, 3.0, 9.0)).length() < 0.011
        );
    }

    #[test]
    fn bootstrap_round_trips() {
        let message = BootstrapMessage {
            sim_tick: 4242,
            manifest_hash: [7; 32],
            baseline_id: 2,
            topo_seq: 77,
            structures: vec![BootstrapStructure {
                structure_id: 0,
                bond_count: 10,
                alive_bonds: vec![0b1111_1101, 0b0000_0011],
            }],
            islands: vec![BootstrapIsland {
                structure_id: 0,
                island_id: 1,
                nodes: vec![3, 4, 9],
                pose: pose(5.0, 1.0, 5.0),
                linear_velocity: Vec3::ZERO,
                angular_velocity: Vec3::ZERO,
                settled: true,
            }],
        };
        let bytes = encode_bootstrap(&message);
        let decoded = decode_bootstrap(&bytes).expect("decode");
        assert_eq!(decoded.manifest_hash, [7; 32]);
        assert_eq!(decoded.topo_seq, 77);
        assert_eq!(decoded.structures[0].alive_bonds, message.structures[0].alive_bonds);
        assert_eq!(decoded.islands[0].nodes, vec![3, 4, 9]);
        assert!(decoded.islands[0].settled);
    }

    /// Golden vector pinned for the TypeScript decoder (client/src/city/wire.ts).
    /// If this changes, the wire format changed — update both sides.
    #[test]
    fn chunks_datagram_golden_vector() {
        let records = vec![BodyRecord {
            body_entity: ids::body_entity(0, 1),
            mode: RecordMode::Absolute,
            flags: 0,
            pose: Pose {
                position: Vec3::new(1.0, 2.0, 3.0),
                rotation: Quat::IDENTITY,
            },
            baseline_position: Vec3::ZERO,
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
        }];
        let mut sequence = 1;
        let packets = encode_chunks_datagrams(&records, &mut sequence, 2, 3);
        assert_eq!(
            hex(&packets[0]),
            // header(16): 77 | 01 | seq=01000000 | baseline=0200 | tick=03000000
            //             | count=0100 | reserved=0000
            // record: tag=00 | leb128(0x80000001)=8180808008
            //         | region=000000000000 | local cm=6400 c800 2c01 | quat32=03000000
            "770101000000020003000000010000000081808080080000000000006400c8002c0103000000"
        );
    }

    #[test]
    fn delta_fits_detects_saturation() {
        assert!(delta_fits(Vec3::new(100.0, 0.0, 0.0), Vec3::new(-100.0, 0.0, 0.0)));
        assert!(!delta_fits(Vec3::new(400.0, 0.0, 0.0), Vec3::ZERO));
    }
}
