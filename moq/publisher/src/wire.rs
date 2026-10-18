//! Payload encoding for vibe-land world-state objects.
//!
//! MoQ moves opaque byte blobs; the bytes below are entirely ours. This module
//! is the encoder; `client/src/moq/payload.ts` is the matching decoder. The
//! golden-vector tests at the bottom of each file pin the two together — change
//! this format and both test suites fail until they agree again.
//!
//! Everything is little-endian.
//!
//! ```text
//! Header (14 bytes)
//!   u8  version        always 1
//!   u8  kind           1 = snapshot, 2 = delta, 3 = meta
//!   u32 tick           simulation tick the payload was produced on
//!   u64 published_at   unix epoch milliseconds, publisher's clock
//!
//! Snapshot / delta body
//!   u8  region
//!   u16 count
//!   count x chunk (12 bytes)
//!     u16 id
//!     u8  state        0 intact, 1 damaged, 2 falling, 3 rubble
//!     u8  hp
//!     i16 x            centimetres
//!     i16 y            centimetres
//!     i16 z            centimetres
//!     i16 yaw          milliradians
//!
//! Meta body
//!   u16 round
//!   u16 players_alive
//!   u8  destroyed_pct
//!   u8  headline_len
//!   headline_len x u8  UTF-8
//! ```

use bytes::{BufMut, Bytes, BytesMut};

pub const PAYLOAD_VERSION: u8 = 1;

pub const KIND_SNAPSHOT: u8 = 1;
pub const KIND_DELTA: u8 = 2;
pub const KIND_META: u8 = 3;

pub const HEADER_LEN: usize = 14;
pub const CHUNK_LEN: usize = 12;
pub const BENCHMARK_HEADER_LEN: usize = 32;
pub const BENCHMARK_MAGIC: &[u8; 4] = b"VMB1";

/// One destructible chunk as it goes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireChunk {
    pub id: u16,
    pub state: u8,
    pub hp: u8,
    pub x_cm: i16,
    pub y_cm: i16,
    pub z_cm: i16,
    pub yaw_mrad: i16,
}

fn put_header(buf: &mut BytesMut, kind: u8, tick: u32, published_at_ms: u64) {
    buf.put_u8(PAYLOAD_VERSION);
    buf.put_u8(kind);
    buf.put_u32_le(tick);
    buf.put_u64_le(published_at_ms);
}

/// Encode a snapshot (every chunk in the region) or a delta (only the chunks
/// that changed). Both share a body layout; only the `kind` byte differs, so a
/// decoder that can read one can read the other.
pub fn encode_region(
    kind: u8,
    tick: u32,
    published_at_ms: u64,
    region: u8,
    chunks: &[WireChunk],
) -> Bytes {
    debug_assert!(kind == KIND_SNAPSHOT || kind == KIND_DELTA);

    let mut buf = BytesMut::with_capacity(HEADER_LEN + 3 + chunks.len() * CHUNK_LEN);
    put_header(&mut buf, kind, tick, published_at_ms);
    buf.put_u8(region);
    buf.put_u16_le(chunks.len() as u16);

    for chunk in chunks {
        buf.put_u16_le(chunk.id);
        buf.put_u8(chunk.state);
        buf.put_u8(chunk.hp);
        buf.put_i16_le(chunk.x_cm);
        buf.put_i16_le(chunk.y_cm);
        buf.put_i16_le(chunk.z_cm);
        buf.put_i16_le(chunk.yaw_mrad);
    }

    buf.freeze()
}

/// Encode the low-frequency match state. The headline is truncated to 255
/// bytes on a UTF-8 boundary so the length fits its single byte.
pub fn encode_meta(
    tick: u32,
    published_at_ms: u64,
    round: u16,
    players_alive: u16,
    destroyed_pct: u8,
    headline: &str,
) -> Bytes {
    let headline = truncate_utf8(headline, u8::MAX as usize);

    let mut buf = BytesMut::with_capacity(HEADER_LEN + 6 + headline.len());
    put_header(&mut buf, KIND_META, tick, published_at_ms);
    buf.put_u16_le(round);
    buf.put_u16_le(players_alive);
    buf.put_u8(destroyed_pct);
    buf.put_u8(headline.len() as u8);
    buf.put_slice(headline.as_bytes());

    buf.freeze()
}

/// Synthetic load-test object. The timestamp uses microseconds so a browser on
/// the same clock can measure sub-millisecond queueing through the hosted relay.
///
/// ```text
/// 4 bytes magic "VMB1"
/// u32 track_id
/// u64 sequence
/// u64 published_at_us (unix epoch)
/// u32 payload_len
/// u32 reserved
/// remaining bytes are zero padding
/// ```
pub fn encode_benchmark(
    track_id: u32,
    sequence: u64,
    published_at_us: u64,
    payload_len: usize,
) -> Bytes {
    assert!(payload_len >= BENCHMARK_HEADER_LEN);
    assert!(u32::try_from(payload_len).is_ok());

    let mut buf = BytesMut::with_capacity(payload_len);
    buf.put_slice(BENCHMARK_MAGIC);
    buf.put_u32_le(track_id);
    buf.put_u64_le(sequence);
    buf.put_u64_le(published_at_us);
    buf.put_u32_le(payload_len as u32);
    buf.put_u32_le(0);
    buf.resize(payload_len, 0);
    buf.freeze()
}

/// Longest prefix of `s` that is at most `max_len` bytes and still valid UTF-8.
fn truncate_utf8(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden vector. `client/src/moq/payload.test.ts` decodes these exact bytes
    /// and asserts the same field values, which is what keeps the Rust encoder
    /// and the TypeScript decoder honest.
    #[test]
    fn region_golden_vector() {
        let chunks = [
            WireChunk {
                id: 7,
                state: 2,
                hp: 128,
                x_cm: -1600,
                y_cm: 450,
                z_cm: 1600,
                yaw_mrad: -3141,
            },
            WireChunk {
                id: 63,
                state: 3,
                hp: 0,
                x_cm: 0,
                y_cm: 0,
                z_cm: -32768,
                yaw_mrad: 32767,
            },
        ];

        let bytes = encode_region(KIND_DELTA, 0x0102_0304, 0x0000_0189_ABCD_EF01, 2, &chunks);

        assert_eq!(bytes.len(), HEADER_LEN + 3 + 2 * CHUNK_LEN);
        assert_eq!(
            hex(&bytes),
            concat!(
                "01",               // version
                "02",               // kind = delta
                "04030201",         // tick
                "01efcdab89010000", // published_at_ms
                "02",               // region
                "0200",             // count
                // chunk 0: id 7, falling, hp 128, (-16.00, 4.50, 16.00) m, yaw -3.141 rad
                "07000280c0f9c2014006bbf3",
                // chunk 1: id 63, rubble, hp 0, and the extremes of the i16 ranges
                "3f000300000000000080ff7f",
            )
        );
    }

    #[test]
    fn meta_golden_vector() {
        let bytes = encode_meta(9, 1, 3, 17, 42, "tower down");

        assert_eq!(
            hex(&bytes),
            concat!(
                "01",
                "03",
                "09000000",
                "0100000000000000",
                "0300", // round
                "1100", // players alive
                "2a",   // destroyed pct
                "0a",   // headline length
                "746f77657220646f776e",
            )
        );
    }

    #[test]
    fn headline_truncation_keeps_utf8_valid() {
        // 'é' is two bytes, so a 255-byte cut lands mid-character and must
        // back up to 254 rather than emit a broken code point.
        let headline = "é".repeat(200);
        let bytes = encode_meta(0, 0, 0, 0, 0, &headline);

        let len = bytes[HEADER_LEN + 5] as usize;
        assert_eq!(len, 254);
        std::str::from_utf8(&bytes[HEADER_LEN + 6..]).expect("headline stayed valid UTF-8");
    }

    #[test]
    fn empty_delta_is_header_plus_three_bytes() {
        let bytes = encode_region(KIND_DELTA, 1, 2, 0, &[]);
        assert_eq!(bytes.len(), HEADER_LEN + 3);
    }

    #[test]
    fn benchmark_payload_has_exact_requested_size_and_header() {
        let encoded = encode_benchmark(7, 99, 123_456, 4096);
        assert_eq!(encoded.len(), 4096);
        assert_eq!(&encoded[0..4], BENCHMARK_MAGIC);
        assert_eq!(u32::from_le_bytes(encoded[4..8].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(encoded[8..16].try_into().unwrap()), 99);
        assert_eq!(
            u64::from_le_bytes(encoded[16..24].try_into().unwrap()),
            123_456
        );
        assert_eq!(
            u32::from_le_bytes(encoded[24..28].try_into().unwrap()),
            4096
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
