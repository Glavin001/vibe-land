//! Integer range-asymmetric-numeral-system coder with adaptive order-0 models.
//!
//! Everything here is integer arithmetic. No floating point appears in the
//! encode or decode path, so the coder is bit-reproducible across x86-64, ARM
//! and wasm32 regardless of FMA contraction or SIMD width. That property is not
//! a nicety: one differing probability desynchronizes the decoder and corrupts
//! the remainder of the block.
//!
//! The models are adaptive, so no frequency table is transmitted. Encoder and
//! decoder start from the same uniform prior and apply the same update after
//! every symbol, which keeps them in lockstep by construction.
//!
//! rANS encodes in reverse and decodes forward. That costs nothing here because
//! `encode_gop_block` already buffers a whole GOP before compressing it.

use anyhow::{ensure, Result};

/// Total frequency mass. A power of two so normalization is shifts, not
/// division, and small enough that `state * total` cannot overflow `u64`.
pub(crate) const TOTAL_BITS: u32 = 12;
pub(crate) const TOTAL: u32 = 1 << TOTAL_BITS;

const STATE_LOWER_BOUND: u64 = 1 << 23;
const STREAM_BITS: u32 = 16;
const STREAM_MASK: u64 = (1 << STREAM_BITS) - 1;

/// Frequency model contract shared by the coder's model types. `span` returns
/// `(cumulative, frequency, total)` for a symbol; `symbol_for` inverts a slot
/// in `[0, total)`; `update` must be applied identically on both sides after
/// every coded symbol, which is what keeps encoder and decoder in lockstep.
pub(crate) trait RansModel {
    fn span(&mut self, symbol: usize) -> (u32, u32, u32);
    fn symbol_for(&mut self, slot: u32) -> usize;
    fn update(&mut self, symbol: usize);
    fn total(&mut self) -> u32;
}

/// Adaptive order-0 frequency model over a fixed alphabet.
///
/// Counts are halved when they would overflow the total, which both bounds the
/// arithmetic and gives the model a recency bias. Every symbol keeps a floor of
/// one so nothing is ever unencodable.
#[derive(Clone, Debug)]
pub(crate) struct AdaptiveModel {
    /// Raw observation counts.
    counts: Vec<u32>,
    count_total: u32,
    /// Counts normalized to sum to exactly `TOTAL`, each at least 1.
    frequencies: Vec<u16>,
    cumulative: Vec<u32>,
    dirty: bool,
}

/// Counts are halved once they reach this, bounding the arithmetic and giving
/// the model a recency bias.
const COUNT_RESCALE: u32 = 1 << 16;
const INCREMENT: u32 = 32;

impl AdaptiveModel {
    pub(crate) fn new(symbols: usize) -> Self {
        assert!(
            symbols > 0 && symbols <= TOTAL as usize,
            "alphabet must fit in the frequency total"
        );
        let mut model = Self {
            counts: vec![1; symbols],
            count_total: symbols as u32,
            frequencies: vec![0; symbols],
            cumulative: vec![0; symbols + 1],
            dirty: true,
        };
        model.ensure_current();
        model
    }

    /// Normalizes counts to sum to exactly `TOTAL`. Keeping the total a fixed
    /// power of two is what makes the encoder's renormalization bound and the
    /// decoder's `state & (TOTAL - 1)` an exact pair; with a varying total the
    /// two can disagree by one stream word and desynchronize.
    fn rebuild(&mut self) {
        let symbols = self.counts.len();
        // Reserve one unit per symbol so nothing is ever unencodable, then
        // hand out the remaining mass proportionally. Allocating only upward
        // from the floor means the correction is always non-negative -- an
        // approach that scales down and then patches the difference can need a
        // negative correction on a large alphabet, silently clamp at 1, and
        // leave the frequencies not summing to TOTAL, which desynchronizes the
        // decoder thousands of symbols later.
        let headroom = TOTAL - symbols as u32;
        let mut allocated = 0_u32;
        let mut largest = 0_usize;
        for index in 0..symbols {
            let extra =
                (self.counts[index] as u64 * headroom as u64 / self.count_total as u64) as u32;
            self.frequencies[index] = (1 + extra) as u16;
            allocated += extra;
            if self.frequencies[index] > self.frequencies[largest] {
                largest = index;
            }
        }
        self.frequencies[largest] += (headroom - allocated) as u16;
        let mut running = 0_u32;
        for index in 0..symbols {
            self.cumulative[index] = running;
            running += self.frequencies[index] as u32;
        }
        self.cumulative[symbols] = running;
        debug_assert_eq!(running, TOTAL, "normalized frequencies must sum to TOTAL");
        self.dirty = false;
    }

    fn ensure_current(&mut self) {
        if self.dirty {
            self.rebuild();
        }
    }

    /// Both sides call this with the same symbol, in the same order.
    fn update(&mut self, symbol: usize) {
        self.counts[symbol] += INCREMENT;
        self.count_total += INCREMENT;
        if self.count_total >= COUNT_RESCALE {
            self.count_total = 0;
            for count in &mut self.counts {
                *count = (*count >> 1).max(1);
                self.count_total += *count;
            }
        }
        self.dirty = true;
    }

    fn span(&mut self, symbol: usize) -> (u32, u32, u32) {
        self.ensure_current();
        (
            self.cumulative[symbol],
            self.frequencies[symbol] as u32,
            TOTAL,
        )
    }

    fn symbol_for_slot(&mut self, slot: u32) -> usize {
        self.ensure_current();
        // Linear scan: alphabets here are small and a scan is exactly
        // reproducible, unlike anything involving floating point.
        let mut symbol = 0;
        while symbol + 1 < self.frequencies.len() && self.cumulative[symbol + 1] <= slot {
            symbol += 1;
        }
        symbol
    }
}

impl RansModel for AdaptiveModel {
    fn span(&mut self, symbol: usize) -> (u32, u32, u32) {
        AdaptiveModel::span(self, symbol)
    }
    fn symbol_for(&mut self, slot: u32) -> usize {
        self.symbol_for_slot(slot)
    }
    fn update(&mut self, symbol: usize) {
        AdaptiveModel::update(self, symbol)
    }
    fn total(&mut self) -> u32 {
        TOTAL
    }
}

/// Adaptive frequency model over large alphabets, counts held in a Fenwick
/// tree so update and prefix-search are O(log n). `AdaptiveModel::rebuild` is
/// O(alphabet) per symbol, which is unusable above a few hundred symbols; the
/// direct delta alphabets of the root coder need thousands.
///
/// Spans are presented to the coder scaled onto a fixed power-of-two total.
/// This is not cosmetic: rANS renormalization intervals only align when the
/// state's lower bound is divisible by the model total, and raw adaptive
/// totals are arbitrary -- coding against them desynchronizes the decoder
/// (observed, not theorized). Floor-scaling is monotone so the scaled spans
/// partition the total exactly, and keeping the raw total below the scaled
/// total guarantees every symbol's scaled frequency stays at least one.
#[derive(Clone, Debug)]
pub(crate) struct FenwickModel {
    tree: Vec<u32>,
    symbols: usize,
    total: u32,
}

const FENWICK_INCREMENT: u32 = 32;
/// Raw-count ceiling. Strictly below `FENWICK_SCALED_TOTAL` so scaled
/// frequencies never floor to zero, with headroom for one increment.
const FENWICK_RESCALE: u32 = (1 << 16) - 64;
pub(crate) const FENWICK_SCALED_TOTAL: u32 = 1 << 16;

impl FenwickModel {
    pub(crate) fn new(symbols: usize) -> Self {
        assert!(symbols > 0, "empty alphabet");
        assert!(
            (symbols as u32) < FENWICK_RESCALE,
            "alphabet larger than the raw-count ceiling"
        );
        let mut model = Self {
            tree: vec![0; symbols + 1],
            symbols,
            total: 0,
        };
        for symbol in 0..symbols {
            model.add(symbol, 1);
        }
        model
    }

    fn add(&mut self, symbol: usize, amount: u32) {
        let mut index = symbol + 1;
        while index <= self.symbols {
            self.tree[index] += amount;
            index += index & index.wrapping_neg();
        }
        self.total += amount;
    }

    /// Sum of raw counts of symbols strictly below `symbol`.
    fn prefix(&self, symbol: usize) -> u32 {
        let mut index = symbol;
        let mut sum = 0;
        while index > 0 {
            sum += self.tree[index];
            index -= index & index.wrapping_neg();
        }
        sum
    }

    fn count(&self, symbol: usize) -> u32 {
        self.prefix(symbol + 1) - self.prefix(symbol)
    }

    /// Maps a raw cumulative count onto the fixed scaled total.
    fn scale(&self, raw: u32) -> u32 {
        ((raw as u64 * FENWICK_SCALED_TOTAL as u64) / self.total as u64) as u32
    }

    fn rescale(&mut self) {
        // Halve every count (floor 1) and rebuild. Rare -- roughly every two
        // thousand updates -- so the O(n) rebuild amortizes away.
        let counts: Vec<u32> = (0..self.symbols)
            .map(|symbol| (self.count(symbol) >> 1).max(1))
            .collect();
        self.tree.iter_mut().for_each(|node| *node = 0);
        self.total = 0;
        for (symbol, &count) in counts.iter().enumerate() {
            self.add(symbol, count);
        }
    }
}

impl RansModel for FenwickModel {
    fn span(&mut self, symbol: usize) -> (u32, u32, u32) {
        let low = self.prefix(symbol);
        let high = low + self.count(symbol);
        let start = self.scale(low);
        let frequency = self.scale(high) - start;
        debug_assert!(frequency > 0, "scaled frequency floored to zero");
        (start, frequency, FENWICK_SCALED_TOTAL)
    }

    fn symbol_for(&mut self, slot: u32) -> usize {
        // Fenwick descend over raw prefixes, comparing in scaled space: the
        // largest symbol whose scaled cumulative is <= slot.
        let mut index = 0_usize;
        let mut raw_prefix = 0_u32;
        let mut mask = self.symbols.next_power_of_two();
        while mask > 0 {
            let probe = index + mask;
            if probe <= self.symbols && self.scale(raw_prefix + self.tree[probe]) <= slot {
                raw_prefix += self.tree[probe];
                index = probe;
            }
            mask >>= 1;
        }
        index.min(self.symbols - 1)
    }

    fn update(&mut self, symbol: usize) {
        self.add(symbol, FENWICK_INCREMENT);
        if self.total >= FENWICK_RESCALE {
            self.rescale();
        }
    }

    fn total(&mut self) -> u32 {
        FENWICK_SCALED_TOTAL
    }
}

/// One buffered coding operation.
#[derive(Clone, Copy, Debug)]
enum Op {
    /// Adaptive model `id` codes `symbol`.
    Model { id: u16, symbol: u16 },
    /// `bits` raw bits, coded against a uniform distribution. Exact and cheap:
    /// a bypass is just a span of frequency 1 over a total of `1 << bits`.
    Bypass { bits: u8, value: u32 },
}

/// Encoder. Operations are buffered and emitted in reverse on `finish`.
#[derive(Default)]
pub(crate) struct RansEncoder {
    pending: Vec<Op>,
}

impl RansEncoder {
    pub(crate) fn encode(&mut self, model: u16, symbol: usize) {
        self.pending.push(Op::Model {
            id: model,
            symbol: symbol as u16,
        });
    }

    /// Raw bits, in chunks of at most 16 so the span stays inside the coder's
    /// total budget.
    pub(crate) fn bypass(&mut self, bits: u32, value: u32) {
        let mut remaining = bits;
        while remaining > 0 {
            let chunk = remaining.min(12);
            remaining -= chunk;
            self.pending.push(Op::Bypass {
                bits: chunk as u8,
                value: (value >> remaining) & ((1 << chunk) - 1),
            });
        }
    }

    /// Magnitude bucket through an adaptive model, then the low bits raw. Turns
    /// a 32-bit alphabet into a 33-symbol model plus bypass, which is what keeps
    /// the tables small while still capturing concentration near zero.
    pub(crate) fn encode_uint(&mut self, model: u16, value: u32) {
        let bucket = exp_bucket(value);
        self.encode(model, bucket);
        if bucket >= 2 {
            let bits = bucket as u32 - 1;
            self.bypass(bits, value & ((1 << bits) - 1));
        }
    }

    pub(crate) fn symbol_count(&self) -> usize {
        self.pending.len()
    }

    /// Replays operations forward to reconstruct each model's state history,
    /// then encodes backwards using the state each symbol was actually coded
    /// against. The decoder rebuilds the identical sequence going forward.
    pub(crate) fn finish<M: RansModel>(self, models: &mut [M]) -> Vec<u8> {
        let mut spans = Vec::with_capacity(self.pending.len());
        for op in &self.pending {
            match *op {
                Op::Model { id, symbol } => {
                    spans.push(models[id as usize].span(symbol as usize));
                    models[id as usize].update(symbol as usize);
                }
                Op::Bypass { bits, value } => spans.push((value, 1, 1 << bits)),
            }
        }

        let mut state = STATE_LOWER_BOUND;
        let mut bytes = Vec::new();
        for &(start, frequency, total) in spans.iter().rev() {
            debug_assert!(frequency > 0);
            let maximum = ((STATE_LOWER_BOUND / total as u64) << STREAM_BITS) * frequency as u64;
            while state >= maximum {
                bytes.extend_from_slice(&((state & STREAM_MASK) as u16).to_le_bytes());
                state >>= STREAM_BITS;
            }
            state = (state / frequency as u64) * total as u64
                + (state % frequency as u64)
                + start as u64;
        }
        bytes.extend_from_slice(&state.to_le_bytes());
        bytes
    }
}

/// Decoder. Consumes the byte stream produced by `RansEncoder::finish`.
pub(crate) struct RansDecoder<'a> {
    bytes: &'a [u8],
    cursor: usize,
    state: u64,
}

impl<'a> RansDecoder<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Result<Self> {
        ensure!(bytes.len() >= 8, "rANS stream shorter than its final state");
        let split = bytes.len() - 8;
        let state = u64::from_le_bytes(bytes[split..].try_into()?);
        Ok(Self {
            bytes: &bytes[..split],
            cursor: split,
            state,
        })
    }

    pub(crate) fn decode<M: RansModel>(&mut self, model: &mut M) -> Result<usize> {
        let total = model.total() as u64;
        let slot = (self.state % total) as u32;
        let symbol = model.symbol_for(slot);
        let (start, frequency, _) = model.span(symbol);
        self.state = frequency as u64 * (self.state / total) + (slot as u64 - start as u64);
        while self.state < STATE_LOWER_BOUND {
            ensure!(self.cursor >= 2, "rANS stream exhausted");
            self.cursor -= 2;
            let word = u16::from_le_bytes(self.bytes[self.cursor..self.cursor + 2].try_into()?);
            self.state = (self.state << STREAM_BITS) | word as u64;
        }
        model.update(symbol);
        Ok(symbol)
    }

    pub(crate) fn decode_bypass(&mut self, bits: u32) -> Result<u32> {
        let mut value = 0_u32;
        let mut remaining = bits;
        while remaining > 0 {
            let chunk = remaining.min(12);
            remaining -= chunk;
            let total = 1_u64 << chunk;
            let slot = (self.state % total) as u32;
            self.state /= total;
            while self.state < STATE_LOWER_BOUND {
                ensure!(self.cursor >= 2, "rANS stream exhausted");
                self.cursor -= 2;
                let word = u16::from_le_bytes(self.bytes[self.cursor..self.cursor + 2].try_into()?);
                self.state = (self.state << STREAM_BITS) | word as u64;
            }
            value |= slot << remaining;
        }
        Ok(value)
    }

    pub(crate) fn decode_uint<M: RansModel>(&mut self, model: &mut M) -> Result<u32> {
        let bucket = self.decode(model)?;
        if bucket < 2 {
            return Ok(bucket as u32);
        }
        let bits = bucket as u32 - 1;
        Ok((1 << bits) | self.decode_bypass(bits)?)
    }
}

/// Splits a value into a magnitude bucket plus explicit low bits, so a 16-bit
/// alphabet becomes a small adaptive-codable symbol and a raw remainder. This
/// is what keeps the model tables tiny while still capturing the heavy
/// concentration of residual deltas near zero.
pub(crate) fn zigzag(value: i16) -> u32 {
    ((value as i32) << 1 ^ (value as i32) >> 31) as u32
}

pub(crate) fn unzigzag(value: u32) -> i16 {
    ((value >> 1) as i32 ^ -((value & 1) as i32)) as i16
}

/// Number of buckets for a 32-bit zigzag magnitude: bucket k holds values whose
/// high bit is k, so bucket k carries k raw low bits.
pub(crate) const EXP_SYMBOLS: usize = 33;

pub(crate) fn exp_bucket(value: u32) -> usize {
    (32 - value.leading_zeros()) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(symbols: &[(u16, usize)], alphabets: &[usize]) {
        let mut encode_models: Vec<_> = alphabets.iter().map(|&n| AdaptiveModel::new(n)).collect();
        let mut encoder = RansEncoder::default();
        for &(model, symbol) in symbols {
            encoder.encode(model, symbol);
        }
        let bytes = encoder.finish(&mut encode_models);

        let mut decode_models: Vec<_> = alphabets.iter().map(|&n| AdaptiveModel::new(n)).collect();
        let mut decoder = RansDecoder::new(&bytes).expect("decoder");
        for &(model, expected) in symbols {
            let got = decoder
                .decode(&mut decode_models[model as usize])
                .expect("decode");
            assert_eq!(got, expected, "symbol mismatch");
        }
    }

    #[test]
    fn round_trips_a_single_model() {
        let symbols: Vec<_> = (0..2000).map(|i| (0_u16, (i * 7 % 17) as usize)).collect();
        round_trip(&symbols, &[17]);
    }

    #[test]
    fn round_trips_interleaved_models() {
        let mut symbols = Vec::new();
        for i in 0..5000_usize {
            symbols.push((0, i % 3));
            symbols.push((1, i % 251));
            symbols.push((2, i % 2));
        }
        round_trip(&symbols, &[3, 251, 2]);
    }

    #[test]
    fn round_trips_a_highly_skewed_source() {
        // 99% zeros: the case that drives the residual occupancy and tag fields.
        let symbols: Vec<_> = (0..20000)
            .map(|i| (0_u16, if i % 100 == 0 { 1 } else { 0 }))
            .collect();
        round_trip(&symbols, &[2]);
    }

    #[test]
    fn skewed_source_costs_far_less_than_one_bit_per_symbol() {
        let mut models = vec![AdaptiveModel::new(2)];
        let mut encoder = RansEncoder::default();
        for i in 0..20000 {
            encoder.encode(0, usize::from(i % 100 == 0));
        }
        let bytes = encoder.finish(&mut models);
        // Order-0 entropy of a 1% source is ~0.081 bits; allow coder overhead.
        assert!(
            bytes.len() < 20000 / 8,
            "skewed source did not compress: {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn zigzag_round_trips_the_full_range() {
        for value in [i16::MIN, -1234, -1, 0, 1, 1234, i16::MAX] {
            assert_eq!(unzigzag(zigzag(value)), value);
        }
    }

    #[test]
    fn exp_buckets_partition_by_high_bit() {
        assert_eq!(exp_bucket(0), 0);
        assert_eq!(exp_bucket(1), 1);
        assert_eq!(exp_bucket(2), 2);
        assert_eq!(exp_bucket(3), 2);
        assert_eq!(exp_bucket(4), 3);
        assert_eq!(exp_bucket(u32::from(u16::MAX)), 16);
    }
}

#[cfg(test)]
mod bypass_tests {
    use super::*;
#[test]
fn minimal_bypass_repro() {
    use super::*;
    for bits in [1u32,4,8,12,16,32] {
        for &v in &[0u32, 1, 5, 0xABCD, 0xFFFFFFFF] {
            let value = if bits>=32 { v } else { v & ((1u32<<bits)-1) };
            let mut m = vec![AdaptiveModel::new(8)];
            let mut e = RansEncoder::default();
            e.encode(0, 3);
            e.bypass(bits, value);
            e.encode(0, 5);
            let b = e.finish(&mut m);
            let mut m = vec![AdaptiveModel::new(8)];
            let mut d = RansDecoder::new(&b).unwrap();
            let a1 = d.decode(&mut m[0]).unwrap();
            let a2 = d.decode_bypass(bits).unwrap();
            let a3 = d.decode(&mut m[0]).unwrap();
            assert_eq!((a1,a2,a3),(3,value,5),"bits={bits} value={value:#x}");
        }
    }
}


    #[test]
    fn bypass_and_uint_round_trip_interleaved_with_models() {
        // Mixes every coding path in the order the residual coder uses them.
        let values: Vec<u32> = (0..4000).map(|i: u32| (i * 2654435761) % 70000).collect();
        let mut models = vec![AdaptiveModel::new(EXP_SYMBOLS), AdaptiveModel::new(8)];
        let mut encoder = RansEncoder::default();
        for (index, &value) in values.iter().enumerate() {
            encoder.encode(1, index % 8);
            encoder.encode_uint(0, value);
            encoder.bypass(32, value.wrapping_mul(7));
        }
        let bytes = encoder.finish(&mut models);

        let mut models = vec![AdaptiveModel::new(EXP_SYMBOLS), AdaptiveModel::new(8)];
        let mut decoder = RansDecoder::new(&bytes).expect("decoder");
        for (index, &value) in values.iter().enumerate() {
            assert_eq!(decoder.decode(&mut models[1]).unwrap(), index % 8);
            assert_eq!(decoder.decode_uint(&mut models[0]).unwrap(), value);
            assert_eq!(decoder.decode_bypass(32).unwrap(), value.wrapping_mul(7));
        }
    }

    #[test]
    fn stress_round_trips_mixed_streams() {
        // Deterministic xorshift: many models, many alphabets, long stream.
        let mut seed = 0x2545F4914F6CDD1D_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let alphabets = [2_usize, 3, 8, 33, 129, 256, 1024];
        let mut ops: Vec<(usize, u32, bool)> = Vec::new();
        for _ in 0..60000 {
            let which = (next() % alphabets.len() as u64) as usize;
            let raw = next() as u32;
            let uint_path = next() % 3 == 0;
            let symbol = if uint_path {
                raw % 100000
            } else {
                raw % alphabets[which] as u32
            };
            ops.push((which, symbol, uint_path));
        }

        let build = || -> Vec<AdaptiveModel> {
            alphabets.iter().map(|&n| AdaptiveModel::new(n)).collect()
        };
        let mut models = build();
        let mut encoder = RansEncoder::default();
        for &(which, symbol, uint_path) in &ops {
            if uint_path {
                encoder.encode_uint(3, symbol);
            } else {
                encoder.encode(which as u16, symbol as usize);
            }
        }
        let bytes = encoder.finish(&mut models);

        let mut models = build();
        let mut decoder = RansDecoder::new(&bytes).expect("decoder");
        for (index, &(which, symbol, uint_path)) in ops.iter().enumerate() {
            if uint_path {
                assert_eq!(
                    decoder.decode_uint(&mut models[3]).unwrap(),
                    symbol,
                    "uint mismatch at {index}"
                );
            } else {
                assert_eq!(
                    decoder.decode(&mut models[which]).unwrap(),
                    symbol as usize,
                    "symbol mismatch at {index}"
                );
            }
        }
    }

    #[test]
    fn fenwick_round_trips_a_large_alphabet() {
        let mut seed = 0xD1B5_4A32_D192_ED03_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        // Zipf-ish source over 4096 symbols: mostly tiny values, a long tail.
        let symbols: Vec<usize> = (0..40_000)
            .map(|_| {
                let raw = next();
                if raw % 4 != 0 {
                    (raw % 8) as usize
                } else {
                    (raw % 4096) as usize
                }
            })
            .collect();
        let mut models = vec![FenwickModel::new(4096)];
        let mut encoder = RansEncoder::default();
        for &symbol in &symbols {
            encoder.encode(0, symbol);
        }
        let bytes = encoder.finish(&mut models);
        let mut models = vec![FenwickModel::new(4096)];
        let mut decoder = RansDecoder::new(&bytes).expect("decoder");
        for (index, &symbol) in symbols.iter().enumerate() {
            assert_eq!(
                decoder.decode(&mut models[0]).unwrap(),
                symbol,
                "mismatch at {index}"
            );
        }
        // The skew must be captured: uniform coding would cost 12 bits/symbol.
        assert!(
            bytes.len() < 40_000 * 12 / 8,
            "fenwick model failed to beat uniform: {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn fenwick_survives_rescale_in_lockstep() {
        // Enough updates on one symbol to force several rescales.
        let symbols: Vec<usize> = (0..10_000).map(|i| if i % 50 == 0 { 7 } else { 0 }).collect();
        let mut models = vec![FenwickModel::new(64)];
        let mut encoder = RansEncoder::default();
        for &symbol in &symbols {
            encoder.encode(0, symbol);
        }
        let bytes = encoder.finish(&mut models);
        let mut models = vec![FenwickModel::new(64)];
        let mut decoder = RansDecoder::new(&bytes).expect("decoder");
        for &symbol in &symbols {
            assert_eq!(decoder.decode(&mut models[0]).unwrap(), symbol);
        }
    }

    #[test]
    fn uint_round_trips_boundary_values() {
        let values = [0, 1, 2, 3, 4, 255, 256, 65535, 65536, u32::MAX];
        let mut models = vec![AdaptiveModel::new(EXP_SYMBOLS)];
        let mut encoder = RansEncoder::default();
        for &value in &values {
            encoder.encode_uint(0, value);
        }
        let bytes = encoder.finish(&mut models);
        let mut models = vec![AdaptiveModel::new(EXP_SYMBOLS)];
        let mut decoder = RansDecoder::new(&bytes).expect("decoder");
        for &value in &values {
            assert_eq!(decoder.decode_uint(&mut models[0]).unwrap(), value);
        }
    }
}
