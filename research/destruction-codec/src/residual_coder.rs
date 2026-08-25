//! rANS coding of the hierarchy residual stream.
//!
//! The packed byte form and this coder describe exactly the same records, so a
//! GOP can be emitted either way and the smaller kept. That makes the coder
//! incapable of being worse than the bytes it replaces, and gives a defined
//! fallback if it ever misbehaves.
//!
//! Field decomposition mirrors the packed form one-for-one: what the byte form
//! writes as a varint, this writes as an adaptive magnitude bucket plus raw low
//! bits; what the byte form writes as fixed-width payload, this bypasses
//! verbatim. Nothing is quantized differently, so reconstruction is unchanged.

use anyhow::{ensure, Result};

use crate::rans::{
    exp_bucket, unzigzag, zigzag, AdaptiveModel, RansDecoder, RansEncoder, EXP_SYMBOLS,
};

/// Exactly what `write_packed_residual` chose, so both forms agree by
/// construction rather than by a parallel reimplementation.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ResidualCoding {
    /// bit 0 position tier, bits 1-2 rotation tier.
    pub(crate) tag: u8,
    pub(crate) delta: [i16; 3],
    pub(crate) absolute_cell: [i32; 3],
    pub(crate) absolute_local: [u16; 3],
    pub(crate) quat32: u32,
    pub(crate) snorm: [i16; 4],
    pub(crate) full: [f32; 4],
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ResidualRecord {
    pub(crate) rel_tick: u32,
    pub(crate) actor: u32,
    pub(crate) coding: ResidualCoding,
}

// Model ids. Small, fixed, and reset per GOP so blocks stay independently
// decodable -- a lost block must cost one block, never the rest of the stream.
const M_TICK_STEP: u16 = 0;
const M_ACTOR_GAP: u16 = 1;
const M_TAG: u16 = 2;
const M_DELTA_X: u16 = 3;
const M_DELTA_Y: u16 = 4;
const M_DELTA_Z: u16 = 5;
const M_CELL: u16 = 6;
const MODEL_COUNT: usize = 7;

fn models() -> Vec<AdaptiveModel> {
    let mut models = Vec::with_capacity(MODEL_COUNT);
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // tick step
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // actor gap
    models.push(AdaptiveModel::new(8)); // tag
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // delta x
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // delta y
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // delta z
    models.push(AdaptiveModel::new(EXP_SYMBOLS)); // absolute cell
    models
}

const DELTA_MODELS: [u16; 3] = [M_DELTA_X, M_DELTA_Y, M_DELTA_Z];

pub(crate) fn encode(records: &[ResidualRecord]) -> Vec<u8> {
    let mut models = models();
    let mut encoder = RansEncoder::default();
    let mut previous_tick = 0_u32;
    let mut previous_actor = 0_u32;
    let mut first_of_tick = true;

    for record in records {
        // Records are emitted tick-ascending, and actor-ascending within a tick.
        encoder.encode_uint(M_TICK_STEP, record.rel_tick - previous_tick);
        if record.rel_tick != previous_tick {
            first_of_tick = true;
        }
        let gap = if first_of_tick {
            record.actor
        } else {
            record.actor - previous_actor - 1
        };
        encoder.encode_uint(M_ACTOR_GAP, gap);
        previous_tick = record.rel_tick;
        previous_actor = record.actor;
        first_of_tick = false;

        let coding = &record.coding;
        encoder.encode(M_TAG, coding.tag as usize);
        if coding.tag & 1 == 0 {
            for axis in 0..3 {
                encoder.encode_uint(DELTA_MODELS[axis], zigzag(coding.delta[axis]));
            }
        } else {
            for axis in 0..3 {
                encoder.encode_uint(M_CELL, zigzag_i32(coding.absolute_cell[axis]));
                encoder.bypass(16, coding.absolute_local[axis] as u32);
            }
        }
        match (coding.tag >> 1) & 0b11 {
            0 => {}
            1 => encoder.bypass(32, coding.quat32),
            2 => {
                for component in coding.snorm {
                    encoder.bypass(16, component as u16 as u32);
                }
            }
            _ => {
                for component in coding.full {
                    encoder.bypass(32, component.to_bits());
                }
            }
        }
    }
    encoder.finish(&mut models)
}

pub(crate) fn decode(bytes: &[u8], count: usize) -> Result<Vec<ResidualRecord>> {
    let mut models = models();
    let mut decoder = RansDecoder::new(bytes)?;
    let mut records = Vec::with_capacity(count);
    let mut previous_tick = 0_u32;
    let mut previous_actor = 0_u32;
    let mut first_of_tick = true;

    for _ in 0..count {
        let step = decoder.decode_uint(&mut models[M_TICK_STEP as usize])?;
        let rel_tick = previous_tick
            .checked_add(step)
            .context_overflow("residual tick step")?;
        if rel_tick != previous_tick {
            first_of_tick = true;
        }
        let gap = decoder.decode_uint(&mut models[M_ACTOR_GAP as usize])?;
        let actor = if first_of_tick {
            gap
        } else {
            previous_actor
                .checked_add(gap)
                .and_then(|actor| actor.checked_add(1))
                .context_overflow("residual actor gap")?
        };
        previous_tick = rel_tick;
        previous_actor = actor;
        first_of_tick = false;

        let tag = decoder.decode(&mut models[M_TAG as usize])? as u8;
        ensure!(tag < 8, "residual tag out of range");
        let mut coding = ResidualCoding {
            tag,
            ..Default::default()
        };
        if tag & 1 == 0 {
            for axis in 0..3 {
                let raw = decoder.decode_uint(&mut models[DELTA_MODELS[axis] as usize])?;
                coding.delta[axis] = unzigzag(raw);
            }
        } else {
            for axis in 0..3 {
                let raw = decoder.decode_uint(&mut models[M_CELL as usize])?;
                coding.absolute_cell[axis] = unzigzag_i32(raw);
                coding.absolute_local[axis] = decoder.decode_bypass(16)? as u16;
            }
        }
        match (tag >> 1) & 0b11 {
            0 => {}
            1 => coding.quat32 = decoder.decode_bypass(32)?,
            2 => {
                for index in 0..4 {
                    coding.snorm[index] = decoder.decode_bypass(16)? as u16 as i16;
                }
            }
            _ => {
                for index in 0..4 {
                    coding.full[index] = f32::from_bits(decoder.decode_bypass(32)?);
                }
            }
        }
        records.push(ResidualRecord {
            rel_tick,
            actor,
            coding,
        });
    }
    Ok(records)
}

fn zigzag_i32(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

fn unzigzag_i32(value: u32) -> i32 {
    (value >> 1) as i32 ^ -((value & 1) as i32)
}

trait ContextOverflow<T> {
    fn context_overflow(self, what: &str) -> Result<T>;
}

impl<T> ContextOverflow<T> for Option<T> {
    fn context_overflow(self, what: &str) -> Result<T> {
        self.ok_or_else(|| anyhow::anyhow!("{what} overflowed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_records() -> Vec<ResidualRecord> {
        let mut records = Vec::new();
        let mut seed = 0x9E3779B97F4A7C15_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut actor = 0_u32;
        for tick in 0..120_u32 {
            actor = 0;
            let per_tick = (next() % 40) as u32;
            for _ in 0..per_tick {
                actor += 1 + (next() % 30) as u32;
                let rotation_tier = (next() % 4) as u8;
                let position_tier = u8::from(next() % 32 == 0);
                let mut coding = ResidualCoding {
                    tag: position_tier | (rotation_tier << 1),
                    ..Default::default()
                };
                if position_tier == 0 {
                    for axis in 0..3 {
                        // Concentrated near zero, like real repairs.
                        coding.delta[axis] = ((next() % 41) as i32 - 20) as i16;
                    }
                } else {
                    for axis in 0..3 {
                        coding.absolute_cell[axis] = (next() % 200) as i32 - 100;
                        coding.absolute_local[axis] = (next() % 65536) as u16;
                    }
                }
                match rotation_tier {
                    1 => coding.quat32 = next() as u32,
                    2 => {
                        for index in 0..4 {
                            coding.snorm[index] = next() as u16 as i16;
                        }
                    }
                    3 => {
                        for index in 0..4 {
                            coding.full[index] = (next() % 2000) as f32 / 1000.0 - 1.0;
                        }
                    }
                    _ => {}
                }
                records.push(ResidualRecord {
                    rel_tick: tick,
                    actor,
                    coding,
                });
            }
        }
        records
    }

    #[test]
    fn round_trips_every_tier_combination() {
        let records = sample_records();
        assert!(records.len() > 1000, "fixture too small to be meaningful");
        let bytes = encode(&records);
        let decoded = decode(&bytes, records.len()).expect("decode");
        assert_eq!(decoded.len(), records.len());
        for (index, (got, want)) in decoded.iter().zip(records.iter()).enumerate() {
            assert_eq!(got.rel_tick, want.rel_tick, "tick at {index}");
            assert_eq!(got.actor, want.actor, "actor at {index}");
            assert_eq!(got.coding.tag, want.coding.tag, "tag at {index}");
            if want.coding.tag & 1 == 0 {
                assert_eq!(got.coding.delta, want.coding.delta, "delta at {index}");
            } else {
                assert_eq!(got.coding.absolute_cell, want.coding.absolute_cell);
                assert_eq!(got.coding.absolute_local, want.coding.absolute_local);
            }
            match (want.coding.tag >> 1) & 0b11 {
                1 => assert_eq!(got.coding.quat32, want.coding.quat32, "quat32 at {index}"),
                2 => assert_eq!(got.coding.snorm, want.coding.snorm, "snorm at {index}"),
                3 => assert_eq!(
                    got.coding.full.map(f32::to_bits),
                    want.coding.full.map(f32::to_bits),
                    "full quat at {index}"
                ),
                _ => {}
            }
        }
    }

    #[test]
    fn beats_the_packed_form_on_concentrated_deltas() {
        let records = sample_records();
        let coded = encode(&records).len();
        // Packed form: 1 tick + 1 gap + 1 tag + 6 delta + rotation payload.
        let packed: usize = records
            .iter()
            .map(|record| {
                3 + if record.coding.tag & 1 == 0 { 6 } else { 12 }
                    + match (record.coding.tag >> 1) & 0b11 {
                        0 => 0,
                        1 => 4,
                        2 => 8,
                        _ => 16,
                    }
            })
            .sum();
        assert!(
            coded < packed,
            "rANS {coded} did not beat packed {packed} bytes"
        );
    }

    #[test]
    fn empty_stream_round_trips() {
        let bytes = encode(&[]);
        assert!(decode(&bytes, 0).expect("decode").is_empty());
    }
}
