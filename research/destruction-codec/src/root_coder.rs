//! rANS transcoder for the hierarchy root-segment block.
//!
//! This is a *byte-stream* transcoder, not a second encoder: it parses the
//! packed root block into typed symbols, entropy-codes them, and on decode
//! rebuilds the identical packed bytes. `read_root_segments` and every
//! prediction/reconstruction path stay untouched, so the coder cannot change
//! what the receiver reconstructs -- only how many bytes carry it.
//!
//! The win is concentrated in the structured fields. After wire v7 most root
//! records carry a zero root gap, a zero start-tick continuation, a zero cell
//! delta per axis, and one of a handful of flag bytes. zstd sees those as
//! interleaved bytes inside variable-length records and models them poorly;
//! an adaptive per-field model prices them at their actual frequency. Fields
//! that are genuinely high-entropy -- quantized rotations, velocities, and
//! absolute cell-local coordinates -- are passed through as raw bypass bits,
//! because entropy coding cannot improve on near-uniform payloads.

use anyhow::{ensure, Context, Result};

use crate::rans::{AdaptiveModel, FenwickModel, RansDecoder, RansEncoder, EXP_SYMBOLS};

// Model ids, reset per GOP so blocks stay independently decodable.
const M_ROOT_GAP: u16 = 0;
const M_START: u16 = 1;
const M_DURATION: u16 = 2;
const M_FLAGS: u16 = 3;
const M_CELL: u16 = 4;
const M_DCELL: u16 = 5;
const M_DLOCAL: u16 = 6;
const M_VELOCITY_TAG: u16 = 7;
const MODEL_COUNT: usize = 8;

fn models() -> Vec<AdaptiveModel> {
    let mut models = Vec::with_capacity(MODEL_COUNT);
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // root gap
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // start tick / continuation
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // duration
    models.push(AdaptiveModel::new(128)); // flags (bit 7 is reserved zero)
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // absolute cell
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // cell delta
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // local delta
    models.push(AdaptiveModel::new(2)); // velocity tag
    models
}

/// Cursor over the packed block, mirroring `Reader` but local to this module.
struct Bytes<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Bytes<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        ensure!(
            self.offset + count <= self.data.len(),
            "root block truncated"
        );
        let slice = &self.data[self.offset..self.offset + count];
        self.offset += count;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn var_u32(&mut self) -> Result<u32> {
        let mut value = 0_u32;
        let mut shift = 0_u32;
        loop {
            let byte = self.u8()?;
            ensure!(shift < 32, "root block varint too long");
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }

    fn is_empty(&self) -> bool {
        self.offset == self.data.len()
    }
}

fn write_var_u32(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// Field layout of one record, derived entirely from its flags byte. Both
/// directions walk this so the grammars cannot drift apart.
struct Layout {
    start_continuity: bool,
    end_continuity: bool,
    rotation_inherit: bool,
    carries_end_position: bool,
    velocity_fields: usize,
    rotation_bytes: usize,
    slerp: bool,
}

fn layout(flags: u8) -> Layout {
    let position_model = flags & 0b11;
    let slerp = flags & 0b100 != 0;
    let full_precision = flags & 0b1000 != 0;
    Layout {
        start_continuity: flags & 0b1_0000 != 0,
        end_continuity: flags & 0b100_0000 != 0,
        rotation_inherit: flags & 0b10_0000 != 0,
        carries_end_position: position_model == 1 || position_model == 3,
        velocity_fields: match position_model {
            2 => 1,
            3 => 2,
            _ => 0,
        },
        rotation_bytes: if full_precision { 16 } else { 4 },
        slerp,
    }
}

/// One position field: three axes, each a cell/local pair coded either as a
/// delta against a prediction or absolutely.
fn encode_position(
    encoder: &mut RansEncoder,
    bytes: &mut Bytes<'_>,
    continuity: bool,
) -> Result<()> {
    for _ in 0..3 {
        if continuity {
            encoder.encode_uint(M_DCELL, bytes.var_u32()?);
            encoder.encode_uint(M_DLOCAL, bytes.var_u32()?);
        } else {
            encoder.encode_uint(M_CELL, bytes.var_u32()?);
            encoder.bypass(16, u32::from(u16::from_le_bytes(bytes.take(2)?.try_into()?)));
        }
    }
    Ok(())
}

fn decode_position(
    decoder: &mut RansDecoder<'_>,
    models: &mut [AdaptiveModel],
    out: &mut Vec<u8>,
    continuity: bool,
) -> Result<()> {
    for _ in 0..3 {
        if continuity {
            write_var_u32(out, decoder.decode_uint(&mut models[M_DCELL as usize])?);
            write_var_u32(out, decoder.decode_uint(&mut models[M_DLOCAL as usize])?);
        } else {
            write_var_u32(out, decoder.decode_uint(&mut models[M_CELL as usize])?);
            let local = decoder.decode_bypass(16)? as u16;
            out.extend_from_slice(&local.to_le_bytes());
        }
    }
    Ok(())
}

/// Parses the packed root block and entropy-codes it.
pub(crate) fn encode(packed: &[u8], segment_count: usize) -> Result<Vec<u8>> {
    let mut models = models();
    let mut encoder = RansEncoder::default();
    let mut bytes = Bytes::new(packed);

    for _ in 0..segment_count {
        encoder.encode_uint(M_ROOT_GAP, bytes.var_u32()?);
        encoder.encode_uint(M_START, bytes.var_u32()?);
        encoder.encode_uint(M_DURATION, bytes.var_u32()?);
        let flags = bytes.u8()?;
        ensure!(flags & 0b1000_0000 == 0, "root block flag bit 7 set");
        encoder.encode(M_FLAGS, flags as usize);
        let layout = layout(flags);

        encode_position(&mut encoder, &mut bytes, layout.start_continuity)?;
        if layout.carries_end_position {
            encode_position(&mut encoder, &mut bytes, layout.end_continuity)?;
        }

        for _ in 0..layout.velocity_fields {
            let tag = bytes.u8()?;
            ensure!(tag <= 1, "unknown root block velocity tag {tag}");
            encoder.encode(M_VELOCITY_TAG, tag as usize);
            let width = if tag == 0 { 2 } else { 4 };
            for _ in 0..3 {
                let raw = bytes.take(width)?;
                if width == 2 {
                    encoder.bypass(16, u32::from(u16::from_le_bytes(raw.try_into()?)));
                } else {
                    encoder.bypass(32, u32::from_le_bytes(raw.try_into()?));
                }
            }
        }

        if !layout.rotation_inherit {
            for chunk in bytes.take(layout.rotation_bytes)?.chunks_exact(4) {
                encoder.bypass(32, u32::from_le_bytes(chunk.try_into()?));
            }
        }
        if layout.slerp {
            for chunk in bytes.take(layout.rotation_bytes)?.chunks_exact(4) {
                encoder.bypass(32, u32::from_le_bytes(chunk.try_into()?));
            }
        }
    }
    ensure!(bytes.is_empty(), "trailing bytes in packed root block");
    Ok(encoder.finish(&mut models))
}

/// Rebuilds the packed root block from its entropy-coded form.
pub(crate) fn decode(coded: &[u8], segment_count: usize) -> Result<Vec<u8>> {
    let mut models = models();
    let mut decoder = RansDecoder::new(coded)?;
    let mut out = Vec::new();

    for _ in 0..segment_count {
        write_var_u32(&mut out, decoder.decode_uint(&mut models[M_ROOT_GAP as usize])?);
        write_var_u32(&mut out, decoder.decode_uint(&mut models[M_START as usize])?);
        write_var_u32(
            &mut out,
            decoder.decode_uint(&mut models[M_DURATION as usize])?,
        );
        let flags = decoder.decode(&mut models[M_FLAGS as usize])? as u8;
        ensure!(flags & 0b1000_0000 == 0, "root block flag bit 7 set");
        out.push(flags);
        let layout = layout(flags);

        decode_position(&mut decoder, &mut models, &mut out, layout.start_continuity)?;
        if layout.carries_end_position {
            decode_position(&mut decoder, &mut models, &mut out, layout.end_continuity)?;
        }

        for _ in 0..layout.velocity_fields {
            let tag = decoder.decode(&mut models[M_VELOCITY_TAG as usize])? as u8;
            out.push(tag);
            for _ in 0..3 {
                if tag == 0 {
                    let value = decoder.decode_bypass(16)? as u16;
                    out.extend_from_slice(&value.to_le_bytes());
                } else {
                    let value = decoder.decode_bypass(32)?;
                    out.extend_from_slice(&value.to_le_bytes());
                }
            }
        }

        if !layout.rotation_inherit {
            for _ in 0..layout.rotation_bytes / 4 {
                out.extend_from_slice(&decoder.decode_bypass(32)?.to_le_bytes());
            }
        }
        if layout.slerp {
            for _ in 0..layout.rotation_bytes / 4 {
                out.extend_from_slice(&decoder.decode_bypass(32)?.to_le_bytes());
            }
        }
    }
    Ok(out)
}

/// Entropy-codes the block and keeps it only when it is smaller, so the coder
/// can never cost more than the packed bytes it replaces.
pub(crate) fn encode_if_smaller(packed: &[u8], segment_count: usize) -> Result<Option<Vec<u8>>> {
    let coded = encode(packed, segment_count).context("entropy-code root block")?;
    Ok((coded.len() < packed.len()).then_some(coded))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    fn emit_position(out: &mut Vec<u8>, continuity: bool, rng: &mut Rng) {
        for _ in 0..3 {
            if continuity {
                // Deltas concentrate near zero, like real continuous segments.
                write_var_u32(out, (rng.next() % 8) as u32);
                write_var_u32(out, (rng.next() % 400) as u32);
            } else {
                write_var_u32(out, (rng.next() % 2000) as u32);
                out.extend_from_slice(&((rng.next() % 65536) as u16).to_le_bytes());
            }
        }
    }

    /// A packed block exercising every branch of the record grammar: all four
    /// position models, both rotation models, full-precision rotations, the
    /// velocity f32 escape, and each continuity flag set and clear.
    pub(crate) fn sample_block() -> (Vec<u8>, usize) {
        let mut out = Vec::new();
        let mut rng = Rng(0x1234_5678_9abc_def0);
        let count = 400_usize;
        for record in 0..count as u32 {
            let flags = (record % 4) as u8
                | (u8::from(record % 3 == 0) << 2)
                | (u8::from(record % 37 == 0) << 3)
                | (u8::from(record % 5 != 0) << 4)
                | (u8::from(record % 7 == 0) << 5)
                | (u8::from(record % 4 != 0) << 6);
            write_var_u32(&mut out, (rng.next() % 4) as u32);
            write_var_u32(&mut out, (rng.next() % 120) as u32);
            write_var_u32(&mut out, (rng.next() % 30) as u32);
            out.push(flags);
            let layout = layout(flags);
            emit_position(&mut out, layout.start_continuity, &mut rng);
            if layout.carries_end_position {
                emit_position(&mut out, layout.end_continuity, &mut rng);
            }
            for _ in 0..layout.velocity_fields {
                let tag = u8::from(record % 23 == 0);
                out.push(tag);
                for _ in 0..3 {
                    if tag == 0 {
                        out.extend_from_slice(&((rng.next() % 65536) as u16).to_le_bytes());
                    } else {
                        out.extend_from_slice(&(rng.next() as u32).to_le_bytes());
                    }
                }
            }
            if !layout.rotation_inherit {
                for _ in 0..layout.rotation_bytes / 4 {
                    out.extend_from_slice(&(rng.next() as u32).to_le_bytes());
                }
            }
            if layout.slerp {
                for _ in 0..layout.rotation_bytes / 4 {
                    out.extend_from_slice(&(rng.next() as u32).to_le_bytes());
                }
            }
        }
        (out, count)
    }

    #[test]
    fn transcodes_back_to_identical_packed_bytes() {
        let (packed, count) = sample_block();
        let coded = encode(&packed, count).expect("encode");
        let rebuilt = decode(&coded, count).expect("decode");
        assert_eq!(rebuilt, packed, "transcoder did not reproduce packed bytes");
    }

    #[test]
    fn beats_the_packed_form_on_structured_records() {
        let (packed, count) = sample_block();
        let coded = encode(&packed, count).expect("encode");
        assert!(
            coded.len() < packed.len(),
            "rANS {} did not beat packed {}",
            coded.len(),
            packed.len()
        );
    }

    #[test]
    fn empty_block_round_trips() {
        let coded = encode(&[], 0).expect("encode");
        assert!(decode(&coded, 0).expect("decode").is_empty());
    }

    #[test]
    fn rejects_a_truncated_block() {
        let (packed, count) = sample_block();
        assert!(encode(&packed[..packed.len() / 2], count).is_err());
    }
}


// ---------------------------------------------------------------------------
// v2: direct adaptive alphabets instead of exponent-bucket + raw low bits.
//
// The v1 transcoder above beat the packed form by 24% pre-zstd yet lost 0.65%
// post-zstd, because `encode_uint` ships `bucket - 1` bits of every value
// uncoded -- 3.5x the measured entropy on the structured fields. v2 models
// each field's actual alphabet directly (Fenwick-backed, so large alphabets
// stay O(log n)) and reserves an escape symbol for the tail. Genuinely
// near-uniform payloads -- rotations, velocity components, absolute locals --
// remain raw bypass, where entropy coding cannot win.
// ---------------------------------------------------------------------------

const V2_SMALL: usize = 256; // gaps, ticks, durations: direct 0..254, last = escape
const V2_DCELL: usize = 65; // zigzag cell deltas: direct 0..63, last = escape
const V2_DLOCAL: usize = 4097; // zigzag local deltas: direct 0..4095, last = escape
const V2_FLAGS: usize = 128;
const V2_VTAG: usize = 2;

const M2_ROOT_GAP: u16 = 0;
const M2_START: u16 = 1;
const M2_DURATION: u16 = 2;
const M2_FLAGS: u16 = 3;
const M2_CELL: u16 = 4;
const M2_DCELL: u16 = 5;
const M2_DLOCAL: u16 = 6;
const M2_VTAG: u16 = 7;

fn v2_models() -> Vec<FenwickModel> {
    vec![
        FenwickModel::new(V2_SMALL),
        FenwickModel::new(V2_SMALL),
        FenwickModel::new(V2_SMALL),
        FenwickModel::new(V2_FLAGS),
        FenwickModel::new(V2_DLOCAL), // absolute cells share the wide alphabet
        FenwickModel::new(V2_DCELL),
        FenwickModel::new(V2_DLOCAL),
        FenwickModel::new(V2_VTAG),
    ]
}

fn v2_encode_value(encoder: &mut RansEncoder, model: u16, alphabet: usize, value: u32) {
    let escape = alphabet as u32 - 1;
    if value < escape {
        encoder.encode(model, value as usize);
    } else {
        encoder.encode(model, escape as usize);
        encoder.bypass(32, value);
    }
}

fn v2_decode_value(
    decoder: &mut RansDecoder<'_>,
    model: &mut FenwickModel,
    alphabet: usize,
) -> Result<u32> {
    let symbol = decoder.decode(model)? as u32;
    if symbol < alphabet as u32 - 1 {
        Ok(symbol)
    } else {
        decoder.decode_bypass(32)
    }
}

fn v2_position(
    encoder: &mut RansEncoder,
    bytes: &mut Bytes<'_>,
    continuity: bool,
) -> Result<()> {
    for _ in 0..3 {
        if continuity {
            v2_encode_value(encoder, M2_DCELL, V2_DCELL, bytes.var_u32()?);
            v2_encode_value(encoder, M2_DLOCAL, V2_DLOCAL, bytes.var_u32()?);
        } else {
            v2_encode_value(encoder, M2_CELL, V2_DLOCAL, bytes.var_u32()?);
            encoder.bypass(16, u32::from(u16::from_le_bytes(bytes.take(2)?.try_into()?)));
        }
    }
    Ok(())
}

fn v2_position_decode(
    decoder: &mut RansDecoder<'_>,
    models: &mut [FenwickModel],
    out: &mut Vec<u8>,
    continuity: bool,
) -> Result<()> {
    for _ in 0..3 {
        if continuity {
            let dcell = v2_decode_value(decoder, &mut models[M2_DCELL as usize], V2_DCELL)?;
            write_var_u32(out, dcell);
            let dlocal = v2_decode_value(decoder, &mut models[M2_DLOCAL as usize], V2_DLOCAL)?;
            write_var_u32(out, dlocal);
        } else {
            let cell = v2_decode_value(decoder, &mut models[M2_CELL as usize], V2_DLOCAL)?;
            write_var_u32(out, cell);
            let local = decoder.decode_bypass(16)? as u16;
            out.extend_from_slice(&local.to_le_bytes());
        }
    }
    Ok(())
}

pub fn encode_v2(packed: &[u8], segment_count: usize) -> Result<Vec<u8>> {
    let mut models = v2_models();
    let mut encoder = RansEncoder::default();
    let mut bytes = Bytes::new(packed);

    for _ in 0..segment_count {
        v2_encode_value(&mut encoder, M2_ROOT_GAP, V2_SMALL, bytes.var_u32()?);
        v2_encode_value(&mut encoder, M2_START, V2_SMALL, bytes.var_u32()?);
        v2_encode_value(&mut encoder, M2_DURATION, V2_SMALL, bytes.var_u32()?);
        let flags = bytes.u8()?;
        ensure!(flags & 0b1000_0000 == 0, "root block flag bit 7 set");
        encoder.encode(M2_FLAGS, flags as usize);
        let layout = layout(flags);

        v2_position(&mut encoder, &mut bytes, layout.start_continuity)?;
        if layout.carries_end_position {
            v2_position(&mut encoder, &mut bytes, layout.end_continuity)?;
        }
        for _ in 0..layout.velocity_fields {
            let tag = bytes.u8()?;
            ensure!(tag <= 1, "unknown root block velocity tag {tag}");
            encoder.encode(M2_VTAG, tag as usize);
            let width = if tag == 0 { 2 } else { 4 };
            for _ in 0..3 {
                let raw = bytes.take(width)?;
                if width == 2 {
                    encoder.bypass(16, u32::from(u16::from_le_bytes(raw.try_into()?)));
                } else {
                    encoder.bypass(32, u32::from_le_bytes(raw.try_into()?));
                }
            }
        }
        if !layout.rotation_inherit {
            for chunk in bytes.take(layout.rotation_bytes)?.chunks_exact(4) {
                encoder.bypass(32, u32::from_le_bytes(chunk.try_into()?));
            }
        }
        if layout.slerp {
            for chunk in bytes.take(layout.rotation_bytes)?.chunks_exact(4) {
                encoder.bypass(32, u32::from_le_bytes(chunk.try_into()?));
            }
        }
    }
    ensure!(bytes.is_empty(), "trailing bytes in packed root block");
    Ok(encoder.finish(&mut models))
}

pub fn decode_v2(coded: &[u8], segment_count: usize) -> Result<Vec<u8>> {
    let mut models = v2_models();
    let mut decoder = RansDecoder::new(coded)?;
    let mut out = Vec::new();

    for _ in 0..segment_count {
        let gap = v2_decode_value(&mut decoder, &mut models[M2_ROOT_GAP as usize], V2_SMALL)?;
        write_var_u32(&mut out, gap);
        let start = v2_decode_value(&mut decoder, &mut models[M2_START as usize], V2_SMALL)?;
        write_var_u32(&mut out, start);
        let duration =
            v2_decode_value(&mut decoder, &mut models[M2_DURATION as usize], V2_SMALL)?;
        write_var_u32(&mut out, duration);
        let flags = decoder.decode(&mut models[M2_FLAGS as usize])? as u8;
        ensure!(flags & 0b1000_0000 == 0, "root block flag bit 7 set");
        out.push(flags);
        let layout = layout(flags);

        v2_position_decode(&mut decoder, &mut models, &mut out, layout.start_continuity)?;
        if layout.carries_end_position {
            v2_position_decode(&mut decoder, &mut models, &mut out, layout.end_continuity)?;
        }
        for _ in 0..layout.velocity_fields {
            let tag = decoder.decode(&mut models[M2_VTAG as usize])? as u8;
            out.push(tag);
            for _ in 0..3 {
                if tag == 0 {
                    let value = decoder.decode_bypass(16)? as u16;
                    out.extend_from_slice(&value.to_le_bytes());
                } else {
                    out.extend_from_slice(&decoder.decode_bypass(32)?.to_le_bytes());
                }
            }
        }
        if !layout.rotation_inherit {
            for _ in 0..layout.rotation_bytes / 4 {
                out.extend_from_slice(&decoder.decode_bypass(32)?.to_le_bytes());
            }
        }
        if layout.slerp {
            for _ in 0..layout.rotation_bytes / 4 {
                out.extend_from_slice(&decoder.decode_bypass(32)?.to_le_bytes());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    #[test]
    fn v2_transcodes_back_to_identical_packed_bytes() {
        let (packed, count) = tests::sample_block();
        let coded = encode_v2(&packed, count).expect("encode");
        let rebuilt = decode_v2(&coded, count).expect("decode");
        assert_eq!(rebuilt, packed);
    }

    // Deliberately no synthetic v1-vs-v2 size assertion: the synthetic
    // fixture draws near-uniform values, where direct alphabets have no
    // advantage over exponent buckets. The size question is settled by the
    // root-coder-bench gate on real dumped GOP blocks, per the fixture-first
    // rule.
}
