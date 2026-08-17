//! R6: compression context that continues across block boundaries.
//!
//! Every block was compressed in isolation, so zstd rebuilt its match tables
//! from nothing 120 times over a 30 s stream. Segment and residual records are
//! highly self-similar between adjacent blocks -- the same bodies, the same
//! islands, similar deltas -- so that context is worth carrying.
//!
//! The carrier is the previous block's *uncompressed payload*, used as a raw
//! zstd dictionary. This adds no dependency the stream did not already have:
//! a delta block already cannot be decoded without its predecessor, because it
//! resolves segments and locals against the carried `TopologyState`.
//!
//! Keyframes are the exception and stay standalone. They are the stream's
//! recovery points -- a receiver joining late, or resynchronising after loss,
//! decodes a keyframe with no history -- so giving one a dictionary would break
//! the one property that makes recovery possible.

use anyhow::Result;

/// Compresses stream blocks, carrying context from the previous block.
#[derive(Default)]
pub(crate) struct BlockCompressor {
    previous: Option<Vec<u8>>,
    enabled: bool,
}

impl BlockCompressor {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            previous: None,
            enabled,
        }
    }

    /// Compresses one block. `keyframe` blocks reset the context.
    pub(crate) fn compress(&mut self, payload: &[u8], keyframe: bool) -> Result<Vec<u8>> {
        let dictionary = if keyframe { None } else { self.previous.as_deref() };
        let compressed = match dictionary.filter(|_| self.enabled) {
            Some(dictionary) => {
                zstd::bulk::Compressor::with_dictionary(3, dictionary)?.compress(payload)?
            }
            None => zstd::bulk::compress(payload, 3)?,
        };
        // A keyframe clears history so the next delta block references the
        // keyframe itself, matching what a receiver that just joined holds.
        self.previous = Some(payload.to_vec());
        Ok(compressed)
    }
}

/// Mirrors `BlockCompressor` on the receiving side.
#[derive(Default)]
pub(crate) struct BlockDecompressor {
    previous: Option<Vec<u8>>,
    enabled: bool,
}

impl BlockDecompressor {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            previous: None,
            enabled,
        }
    }

    pub(crate) fn decompress(
        &mut self,
        compressed: &[u8],
        capacity: usize,
        keyframe: bool,
    ) -> Result<Vec<u8>> {
        let dictionary = if keyframe { None } else { self.previous.as_deref() };
        let payload = match dictionary.filter(|_| self.enabled) {
            Some(dictionary) => zstd::bulk::Decompressor::with_dictionary(dictionary)?
                .decompress(compressed, capacity)?,
            None => zstd::bulk::decompress(compressed, capacity)?,
        };
        self.previous = Some(payload.clone());
        Ok(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property that matters: a receiver reconstructing the stream in order
    /// recovers every block exactly, and keyframes decode without history.
    #[test]
    fn round_trips_a_stream_with_keyframes() {
        let blocks: Vec<(Vec<u8>, bool)> = (0..12)
            .map(|index| {
                let keyframe = index % 5 == 0;
                let body: Vec<u8> = (0..2048_u32)
                    .map(|byte| (byte.wrapping_mul(index + 7) % 251) as u8)
                    .collect();
                (body, keyframe)
            })
            .collect();

        let mut compressor = BlockCompressor::new(true);
        let wire: Vec<Vec<u8>> = blocks
            .iter()
            .map(|(payload, keyframe)| compressor.compress(payload, *keyframe).unwrap())
            .collect();

        let mut decompressor = BlockDecompressor::new(true);
        for ((payload, keyframe), compressed) in blocks.iter().zip(&wire) {
            let decoded = decompressor
                .decompress(compressed, payload.len(), *keyframe)
                .unwrap();
            assert_eq!(&decoded, payload);
        }
    }

    /// A receiver that joins at a keyframe must decode from there onward with
    /// no prior history -- the recovery guarantee.
    #[test]
    fn resumes_from_a_keyframe_without_history() {
        let blocks: Vec<(Vec<u8>, bool)> = (0..8)
            .map(|index| {
                let body: Vec<u8> = (0..1500_u32)
                    .map(|byte| (byte.wrapping_add(index * 31) % 199) as u8)
                    .collect();
                (body, index == 0 || index == 4)
            })
            .collect();

        let mut compressor = BlockCompressor::new(true);
        let wire: Vec<Vec<u8>> = blocks
            .iter()
            .map(|(payload, keyframe)| compressor.compress(payload, *keyframe).unwrap())
            .collect();

        // Join at block 4, the second keyframe, with an empty decompressor.
        let mut late = BlockDecompressor::new(true);
        for index in 4..blocks.len() {
            let (payload, keyframe) = &blocks[index];
            let decoded = late
                .decompress(&wire[index], payload.len(), *keyframe)
                .unwrap();
            assert_eq!(&decoded, payload, "block {index} failed after late join");
        }
    }

    /// Disabled, the carrier must be byte-identical to plain per-block zstd.
    #[test]
    fn disabled_matches_standalone_compression() {
        let payload: Vec<u8> = (0..4096_u32).map(|byte| (byte % 253) as u8).collect();
        let mut compressor = BlockCompressor::new(false);
        assert_eq!(
            compressor.compress(&payload, true).unwrap(),
            zstd::bulk::compress(&payload, 3).unwrap()
        );
        assert_eq!(
            compressor.compress(&payload, false).unwrap(),
            zstd::bulk::compress(&payload, 3).unwrap()
        );
    }
}
