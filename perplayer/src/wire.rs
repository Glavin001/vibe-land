//! The per-player wire (city wire 4): what each packet carries, byte for
//! byte, encoded and decoded by the same code on both ends.
//!
//! - `PKT_PP_KEYFRAMES` (datagram): the error-driven keyframes for one
//!   client, with the client's datagram ordinal for acks.
//! - `PKT_PP_EVENTS` (reliable, ordered): what broke, what settled, what
//!   woke, and the structure hash. Each event names the tick it applies at.
//! - `PKT_PP_BOOTSTRAP` (reliable): a joining client's structural state as
//!   bitsets, plus every body's pose.
//! - `PKT_PP_ACK` (client to server): the newest datagram ordinal received
//!   and a mask of the 64 before it.
//!
//! Positions are quantised per keyframe at the coarsest of four grids whose
//! error stays under half the client's tolerance (`Precision`); rotations as
//! smallest-three (2 + 3 x 10 bits); velocities at 1 cm/s and 2 mrad/s.

use glam::{Quat, Vec3};

use crate::predict::{Keyframe, Mode};

pub const PKT_PP_KEYFRAMES: u8 = 132;
pub const PKT_PP_EVENTS: u8 = 133;
pub const PKT_PP_BOOTSTRAP: u8 = 134;
pub const PKT_PP_ACK: u8 = 135;

/// Position grids, metres: tier 0 is the finest.
pub const POSITION_STEPS: [f32; 4] = [0.001, 0.004, 0.016, 0.064];
const LINEAR_STEP: f32 = 0.01;
const ANGULAR_STEP: f32 = 0.002;

// ── bytes ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct Writer {
    pub out: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, v: u8) {
        self.out.push(v);
    }
    pub fn u16(&mut self, v: u16) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i16(&mut self, v: i16) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn f32(&mut self, v: f32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn varint(&mut self, mut v: u64) {
        loop {
            let byte = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.out.push(byte);
                return;
            }
            self.out.push(byte | 0x80);
        }
    }
    pub fn svarint(&mut self, v: i64) {
        self.varint(((v << 1) ^ (v >> 63)) as u64);
    }
}

pub struct Reader<'a> {
    pub bytes: &'a [u8],
    pub at: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Truncated;

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], Truncated> {
        let slice = self.bytes.get(self.at..self.at + n).ok_or(Truncated)?;
        self.at += n;
        Ok(slice)
    }
    pub fn u8(&mut self) -> Result<u8, Truncated> {
        Ok(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16, Truncated> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    pub fn u32(&mut self) -> Result<u32, Truncated> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn u64(&mut self) -> Result<u64, Truncated> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    pub fn i16(&mut self) -> Result<i16, Truncated> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    pub fn f32(&mut self) -> Result<f32, Truncated> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn varint(&mut self) -> Result<u64, Truncated> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.u8()?;
            v |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(Truncated)
    }
    pub fn svarint(&mut self) -> Result<i64, Truncated> {
        let v = self.varint()?;
        Ok(((v >> 1) as i64) ^ -((v & 1) as i64))
    }
    pub fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }
}

// ── quantisation ────────────────────────────────────────────────────────────

/// Smallest-three: the index of the largest component (2 bits) and the other
/// three at 10 bits each over [-1/sqrt 2, 1/sqrt 2].
pub fn encode_quat(q: Quat) -> u32 {
    let q = q.normalize();
    let c = [q.x, q.y, q.z, q.w];
    let mut largest = 0;
    for i in 1..4 {
        if c[i].abs() > c[largest].abs() {
            largest = i;
        }
    }
    let sign = if c[largest] < 0.0 { -1.0 } else { 1.0 };
    let mut bits = largest as u32;
    let range = std::f32::consts::FRAC_1_SQRT_2;
    let mut shift = 2;
    for (i, &v) in c.iter().enumerate() {
        if i == largest {
            continue;
        }
        let unit = ((v * sign / range).clamp(-1.0, 1.0) + 1.0) * 0.5;
        bits |= ((unit * 1023.0).round() as u32) << shift;
        shift += 10;
    }
    bits
}

pub fn decode_quat(bits: u32) -> Quat {
    let largest = (bits & 3) as usize;
    let range = std::f32::consts::FRAC_1_SQRT_2;
    let mut c = [0.0f32; 4];
    let mut shift = 2;
    let mut sum = 0.0;
    for i in 0..4 {
        if i == largest {
            continue;
        }
        let unit = ((bits >> shift) & 1023) as f32 / 1023.0;
        c[i] = (unit * 2.0 - 1.0) * range;
        sum += c[i] * c[i];
        shift += 10;
    }
    c[largest] = (1.0 - sum).max(0.0).sqrt();
    Quat::from_xyzw(c[0], c[1], c[2], c[3]).normalize()
}

fn quantise(v: f32, step: f32) -> i64 {
    (v / step).round() as i64
}

fn clamp_i16(v: f32, step: f32) -> i16 {
    (v / step).round().clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

/// A keyframe as the client will decode it: what the server's error model
/// must use as the client's baseline.
pub fn quantised(kf: &Keyframe, tier: u8) -> Keyframe {
    let step = POSITION_STEPS[tier as usize & 3];
    let p = |v: f32| quantise(v, step) as f32 * step;
    let lin = |v: f32| f32::from(clamp_i16(v, LINEAR_STEP)) * LINEAR_STEP;
    let ang = |v: f32| f32::from(clamp_i16(v, ANGULAR_STEP)) * ANGULAR_STEP;
    let moving = kf.mode != Mode::Resting;
    Keyframe {
        tick: kf.tick,
        position: Vec3::new(p(kf.position.x), p(kf.position.y), p(kf.position.z)),
        rotation: decode_quat(encode_quat(kf.rotation)),
        linear_velocity: if moving {
            Vec3::new(lin(kf.linear_velocity.x), lin(kf.linear_velocity.y), lin(kf.linear_velocity.z))
        } else {
            Vec3::ZERO
        },
        angular_velocity: if moving {
            Vec3::new(ang(kf.angular_velocity.x), ang(kf.angular_velocity.y), ang(kf.angular_velocity.z))
        } else {
            Vec3::ZERO
        },
        mode: kf.mode,
    }
}

// ── keyframes ───────────────────────────────────────────────────────────────

/// A body on the wire: its structure and its id (the lowest chunk).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BodyKey {
    pub structure: u32,
    pub body: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyframeRecord {
    pub key: BodyKey,
    pub tier: u8,
    pub keyframe: Keyframe,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeyframePacket {
    /// The server's tick when the packet was made (the client's clock).
    pub server_tick: u32,
    /// This client's datagram ordinal (acks name it).
    pub ordinal: u32,
    pub records: Vec<KeyframeRecord>,
}

pub fn encode_keyframes(packet: &KeyframePacket) -> Vec<u8> {
    let mut w = Writer::default();
    w.u8(PKT_PP_KEYFRAMES);
    w.u32(packet.server_tick);
    w.u32(packet.ordinal);
    w.varint(packet.records.len() as u64);
    let mut records = packet.records.clone();
    records.sort_by_key(|r| r.key);
    let mut last = BodyKey { structure: 0, body: 0 };
    for record in &records {
        let k = record.key;
        let kf = &record.keyframe;
        // Structure as a gap; body as a gap within the same structure.
        w.varint(u64::from(k.structure - last.structure));
        let base = if k.structure == last.structure { last.body } else { 0 };
        w.varint(u64::from(k.body.wrapping_sub(base)));
        last = k;
        // Tick relative to the packet's.
        w.svarint(i64::from(kf.tick) - i64::from(packet.server_tick));
        w.u8((kf.mode as u8) | ((record.tier & 3) << 2));
        let step = POSITION_STEPS[record.tier as usize & 3];
        for v in kf.position.to_array() {
            w.svarint(quantise(v, step));
        }
        w.u32(encode_quat(kf.rotation));
        if kf.mode != Mode::Resting {
            for v in kf.linear_velocity.to_array() {
                w.i16(clamp_i16(v, LINEAR_STEP));
            }
            for v in kf.angular_velocity.to_array() {
                w.i16(clamp_i16(v, ANGULAR_STEP));
            }
        }
    }
    w.out
}

pub fn decode_keyframes(bytes: &[u8]) -> Result<KeyframePacket, Truncated> {
    let mut r = Reader::new(bytes);
    if r.u8()? != PKT_PP_KEYFRAMES {
        return Err(Truncated);
    }
    let server_tick = r.u32()?;
    let ordinal = r.u32()?;
    let count = r.varint()? as usize;
    let mut records = Vec::with_capacity(count.min(4096));
    let mut last = BodyKey { structure: 0, body: 0 };
    for _ in 0..count {
        let structure = last.structure + r.varint()? as u32;
        let base = if structure == last.structure { last.body } else { 0 };
        let body = base.wrapping_add(r.varint()? as u32);
        let key = BodyKey { structure, body };
        last = key;
        let tick = (i64::from(server_tick) + r.svarint()?) as u32;
        let flags = r.u8()?;
        let mode = Mode::from_u8(flags);
        let tier = (flags >> 2) & 3;
        let step = POSITION_STEPS[tier as usize];
        let mut p = [0.0f32; 3];
        for v in &mut p {
            *v = r.svarint()? as f32 * step;
        }
        let rotation = decode_quat(r.u32()?);
        let (mut lin, mut ang) = (Vec3::ZERO, Vec3::ZERO);
        if mode != Mode::Resting {
            lin = Vec3::new(
                f32::from(r.i16()?) * LINEAR_STEP,
                f32::from(r.i16()?) * LINEAR_STEP,
                f32::from(r.i16()?) * LINEAR_STEP,
            );
            ang = Vec3::new(
                f32::from(r.i16()?) * ANGULAR_STEP,
                f32::from(r.i16()?) * ANGULAR_STEP,
                f32::from(r.i16()?) * ANGULAR_STEP,
            );
        }
        records.push(KeyframeRecord {
            key,
            tier,
            keyframe: Keyframe {
                tick,
                position: Vec3::from_array(p),
                rotation,
                linear_velocity: lin,
                angular_velocity: ang,
                mode,
            },
        });
    }
    Ok(KeyframePacket { server_tick, ordinal, records })
}

// ── events ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// Bonds broke and chunks were removed in one structure at `tick`.
    Fracture { tick: u32, structure: u32, broken_bonds: Vec<u32>, removed_chunks: Vec<u32> },
    /// A body came to rest at a pose: static until a wake.
    Settle { tick: u32, key: BodyKey, position: Vec3, rotation: Quat },
    Wake { tick: u32, key: BodyKey },
    /// The structure hash both ends compare (gate G1).
    Hash { tick: u32, structure: u32, hash: u64 },
}

impl Event {
    pub fn tick(&self) -> u32 {
        match self {
            Event::Fracture { tick, .. } | Event::Settle { tick, .. } | Event::Wake { tick, .. } | Event::Hash { tick, .. } => *tick,
        }
    }
}

fn gaps(w: &mut Writer, values: &[u32]) {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    w.varint(sorted.len() as u64);
    let mut last = 0u32;
    for (i, v) in sorted.iter().enumerate() {
        w.varint(u64::from(if i == 0 { *v } else { v - last }));
        last = *v;
    }
}

fn read_gaps(r: &mut Reader) -> Result<Vec<u32>, Truncated> {
    let n = r.varint()? as usize;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    let mut last = 0u32;
    for i in 0..n {
        let v = r.varint()? as u32;
        last = if i == 0 { v } else { last + v };
        out.push(last);
    }
    Ok(out)
}

/// An events packet: `seq` orders the reliable stream (and dedups the
/// datagram copies of it).
pub fn encode_events(seq: u32, events: &[Event]) -> Vec<u8> {
    let mut w = Writer::default();
    w.u8(PKT_PP_EVENTS);
    w.u32(seq);
    w.varint(events.len() as u64);
    for event in events {
        match event {
            Event::Fracture { tick, structure, broken_bonds, removed_chunks } => {
                w.u8(0);
                w.u32(*tick);
                w.varint(u64::from(*structure));
                gaps(&mut w, broken_bonds);
                gaps(&mut w, removed_chunks);
            }
            Event::Settle { tick, key, position, rotation } => {
                w.u8(1);
                w.u32(*tick);
                w.varint(u64::from(key.structure));
                w.varint(u64::from(key.body));
                for v in position.to_array() {
                    w.svarint(quantise(v, POSITION_STEPS[0]));
                }
                w.u32(encode_quat(*rotation));
            }
            Event::Wake { tick, key } => {
                w.u8(2);
                w.u32(*tick);
                w.varint(u64::from(key.structure));
                w.varint(u64::from(key.body));
            }
            Event::Hash { tick, structure, hash } => {
                w.u8(3);
                w.u32(*tick);
                w.varint(u64::from(*structure));
                w.u64(*hash);
            }
        }
    }
    w.out
}

pub fn decode_events(bytes: &[u8]) -> Result<(u32, Vec<Event>), Truncated> {
    let mut r = Reader::new(bytes);
    if r.u8()? != PKT_PP_EVENTS {
        return Err(Truncated);
    }
    let seq = r.u32()?;
    let n = r.varint()? as usize;
    let mut events = Vec::with_capacity(n.min(4096));
    for _ in 0..n {
        let kind = r.u8()?;
        let tick = r.u32()?;
        events.push(match kind {
            0 => {
                let structure = r.varint()? as u32;
                let broken_bonds = read_gaps(&mut r)?;
                let removed_chunks = read_gaps(&mut r)?;
                Event::Fracture { tick, structure, broken_bonds, removed_chunks }
            }
            1 => {
                let key = BodyKey { structure: r.varint()? as u32, body: r.varint()? as u32 };
                let position = Vec3::new(
                    r.svarint()? as f32 * POSITION_STEPS[0],
                    r.svarint()? as f32 * POSITION_STEPS[0],
                    r.svarint()? as f32 * POSITION_STEPS[0],
                );
                let rotation = decode_quat(r.u32()?);
                Event::Settle { tick, key, position, rotation }
            }
            2 => Event::Wake { tick, key: BodyKey { structure: r.varint()? as u32, body: r.varint()? as u32 } },
            3 => Event::Hash { tick, structure: r.varint()? as u32, hash: r.u64()? },
            _ => return Err(Truncated),
        });
    }
    Ok((seq, events))
}

// ── bootstrap ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct BootstrapStructure {
    pub structure: u32,
    pub alive_bonds: Vec<u64>,
    pub removed_chunks: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bootstrap {
    pub tick: u32,
    /// The next events sequence the client will see.
    pub next_event_seq: u32,
    pub structures: Vec<BootstrapStructure>,
    /// Settled bodies: their rest pose.
    pub settled: Vec<(BodyKey, Vec3, Quat)>,
    /// Awake bodies: their keyframe.
    pub awake: Vec<(BodyKey, Keyframe)>,
}

fn bits_rle(w: &mut Writer, words: &[u64]) {
    // Runs of identical words: (count, word). All-ones and all-zeros
    // dominate (intact or gone), so a 150,000-bond city is a few bytes until
    // it breaks.
    w.varint(words.len() as u64);
    let mut i = 0;
    while i < words.len() {
        let mut j = i + 1;
        while j < words.len() && words[j] == words[i] {
            j += 1;
        }
        w.varint((j - i) as u64);
        w.u64(words[i]);
        i = j;
    }
}

fn read_bits_rle(r: &mut Reader) -> Result<Vec<u64>, Truncated> {
    let n = r.varint()? as usize;
    let mut out = Vec::with_capacity(n.min(1 << 20));
    while out.len() < n {
        let run = r.varint()? as usize;
        let word = r.u64()?;
        if run == 0 || out.len() + run > n {
            return Err(Truncated);
        }
        out.extend(std::iter::repeat(word).take(run));
    }
    Ok(out)
}

pub fn encode_bootstrap(b: &Bootstrap) -> Vec<u8> {
    let mut w = Writer::default();
    w.u8(PKT_PP_BOOTSTRAP);
    w.u32(b.tick);
    w.u32(b.next_event_seq);
    w.varint(b.structures.len() as u64);
    for s in &b.structures {
        w.varint(u64::from(s.structure));
        bits_rle(&mut w, &s.alive_bonds);
        bits_rle(&mut w, &s.removed_chunks);
    }
    w.varint(b.settled.len() as u64);
    for (key, p, q) in &b.settled {
        w.varint(u64::from(key.structure));
        w.varint(u64::from(key.body));
        for v in p.to_array() {
            w.svarint(quantise(v, POSITION_STEPS[0]));
        }
        w.u32(encode_quat(*q));
    }
    let packet = KeyframePacket {
        server_tick: b.tick,
        ordinal: 0,
        records: b.awake.iter().map(|(key, kf)| KeyframeRecord { key: *key, tier: 0, keyframe: *kf }).collect(),
    };
    w.out.extend_from_slice(&encode_keyframes(&packet)[1..]);
    w.out
}

pub fn decode_bootstrap(bytes: &[u8]) -> Result<Bootstrap, Truncated> {
    let mut r = Reader::new(bytes);
    if r.u8()? != PKT_PP_BOOTSTRAP {
        return Err(Truncated);
    }
    let tick = r.u32()?;
    let next_event_seq = r.u32()?;
    let n = r.varint()? as usize;
    let mut structures = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let structure = r.varint()? as u32;
        let alive_bonds = read_bits_rle(&mut r)?;
        let removed_chunks = read_bits_rle(&mut r)?;
        structures.push(BootstrapStructure { structure, alive_bonds, removed_chunks });
    }
    let n = r.varint()? as usize;
    let mut settled = Vec::with_capacity(n.min(1 << 20));
    for _ in 0..n {
        let key = BodyKey { structure: r.varint()? as u32, body: r.varint()? as u32 };
        let p = Vec3::new(
            r.svarint()? as f32 * POSITION_STEPS[0],
            r.svarint()? as f32 * POSITION_STEPS[0],
            r.svarint()? as f32 * POSITION_STEPS[0],
        );
        settled.push((key, p, decode_quat(r.u32()?)));
    }
    let mut rest = vec![PKT_PP_KEYFRAMES];
    rest.extend_from_slice(&bytes[r.at..]);
    let keyframes = decode_keyframes(&rest)?;
    Ok(Bootstrap {
        tick,
        next_event_seq,
        structures,
        settled,
        awake: keyframes.records.into_iter().map(|r| (r.key, r.keyframe)).collect(),
    })
}

// ── acks ────────────────────────────────────────────────────────────────────

pub fn encode_ack(newest: u32, mask: u64) -> Vec<u8> {
    let mut w = Writer::default();
    w.u8(PKT_PP_ACK);
    w.u32(newest);
    w.u64(mask);
    w.out
}

pub fn decode_ack(bytes: &[u8]) -> Result<(u32, u64), Truncated> {
    let mut r = Reader::new(bytes);
    if r.u8()? != PKT_PP_ACK {
        return Err(Truncated);
    }
    Ok((r.u32()?, r.u64()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(tick: u32, mode: Mode) -> Keyframe {
        Keyframe {
            tick,
            position: Vec3::new(-123.4567, 17.891, 250.25),
            rotation: Quat::from_euler(glam::EulerRot::XYZ, 0.3, -1.2, 2.0),
            linear_velocity: Vec3::new(3.21, -9.87, 0.5),
            angular_velocity: Vec3::new(1.0, -2.5, 0.25),
            mode,
        }
    }

    #[test]
    fn keyframes_round_trip_at_their_tier() {
        let packet = KeyframePacket {
            server_tick: 1000,
            ordinal: 77,
            records: vec![
                KeyframeRecord { key: BodyKey { structure: 4, body: 120 }, tier: 0, keyframe: kf(998, Mode::Ballistic) },
                KeyframeRecord { key: BodyKey { structure: 4, body: 7 }, tier: 2, keyframe: kf(1000, Mode::Sliding) },
                KeyframeRecord { key: BodyKey { structure: 9, body: 3 }, tier: 3, keyframe: kf(1001, Mode::Resting) },
            ],
        };
        let bytes = encode_keyframes(&packet);
        let back = decode_keyframes(&bytes).unwrap();
        assert_eq!(back.ordinal, 77);
        assert_eq!(back.records.len(), 3);
        for record in &packet.records {
            let got = back.records.iter().find(|r| r.key == record.key).unwrap();
            // Exactly what `quantised` says the client decodes.
            let expect = quantised(&record.keyframe, record.tier);
            assert_eq!(got.keyframe.tick, expect.tick);
            assert!((got.keyframe.position - expect.position).length() < 1e-4);
            assert!(got.keyframe.rotation.dot(expect.rotation).abs() > 0.99999);
            assert!((got.keyframe.linear_velocity - expect.linear_velocity).length() < 1e-5);
            assert!((got.keyframe.position - record.keyframe.position).abs().max_element() <= POSITION_STEPS[record.tier as usize] * 0.5 + 1e-4);
        }
        // A ballistic keyframe at the finest tier, 250 m out: 29 bytes (9 of
        // them position at 1 mm). Coarser tiers and 12-bit velocities are the
        // measured next steps toward the spec's 16-22.
        let one = encode_keyframes(&KeyframePacket { server_tick: 1000, ordinal: 1, records: packet.records[..1].to_vec() });
        assert!(one.len() - 10 <= 30, "{} bytes", one.len() - 10);
    }

    #[test]
    fn events_and_acks_round_trip() {
        let events = vec![
            Event::Fracture { tick: 50, structure: 3, broken_bonds: vec![900, 12, 13, 400], removed_chunks: vec![7] },
            Event::Settle { tick: 51, key: BodyKey { structure: 3, body: 12 }, position: Vec3::new(1.0, 2.0, 3.0), rotation: Quat::IDENTITY },
            Event::Wake { tick: 52, key: BodyKey { structure: 3, body: 12 } },
            Event::Hash { tick: 60, structure: 3, hash: 0xdead_beef_cafe },
        ];
        let (seq, back) = decode_events(&encode_events(9, &events)).unwrap();
        assert_eq!(seq, 9);
        assert_eq!(back[0], Event::Fracture { tick: 50, structure: 3, broken_bonds: vec![12, 13, 400, 900], removed_chunks: vec![7] });
        assert_eq!(back[2..], events[2..]);
        assert_eq!(decode_ack(&encode_ack(5, 0b1011)).unwrap(), (5, 0b1011));
    }

    #[test]
    fn a_bootstrap_of_an_intact_city_is_tiny() {
        let b = Bootstrap {
            tick: 10,
            next_event_seq: 4,
            structures: (0..16).map(|s| BootstrapStructure { structure: s, alive_bonds: vec![u64::MAX; 150], removed_chunks: vec![0; 50] }).collect(),
            settled: vec![(BodyKey { structure: 1, body: 5 }, Vec3::ONE, Quat::IDENTITY)],
            awake: vec![(BodyKey { structure: 2, body: 9 }, kf(10, Mode::Ballistic))],
        };
        let bytes = encode_bootstrap(&b);
        assert!(bytes.len() < 16 * 24 + 80, "{} bytes", bytes.len());
        let back = decode_bootstrap(&bytes).unwrap();
        assert_eq!(back.structures, b.structures);
        assert_eq!(back.settled.len(), 1);
        assert_eq!(back.awake[0].0, BodyKey { structure: 2, body: 9 });
    }
}
