//! Datagram byte accounting: packet-local LEB128 id gaps and greedy MTU packing.
//!
//! Ported from /root/workspace/destruction-codec/src/codec.rs (2026-08-10).
//! This module models sizes and packet composition; the real serializer in
//! `wire` uses it as the accounting source of truth so encoded packets can
//! never exceed the MTU.

use crate::quant::{DATAGRAM_HEADER, FIXED_BODY_ID_BYTES, MAX_DATAGRAM};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WireChoice {
    Absolute,
    Delta,
    MotionAbsolute,
    MotionDelta,
    Ballistic,
}

#[derive(Clone, Copy, Debug)]
pub struct DatagramRecord {
    pub body: u32,
    pub choice: WireChoice,
    pub bytes: usize,
}

#[derive(Clone, Debug)]
pub struct Datagram {
    pub sequence: u32,
    pub baseline_id: u32,
    pub tick: u32,
    pub records: Vec<DatagramRecord>,
    pub bytes: usize,
}

/// Bytes needed for a packet-local body id: the first record in a packet
/// carries the absolute id, later records carry unsigned LEB128 gaps from the
/// previous (ascending-sorted) body id.
pub fn relative_body_id_bytes(body: u32, previous_body: Option<u32>) -> usize {
    let value = previous_body.map_or(body, |previous| body.saturating_sub(previous));
    let bits = 32 - value.leading_zeros();
    bits.max(1).div_ceil(7) as usize
}

pub fn packed_record_bytes(logical_bytes: usize, body: u32, previous_body: Option<u32>) -> usize {
    debug_assert!(logical_bytes >= FIXED_BODY_ID_BYTES);
    logical_bytes - FIXED_BODY_ID_BYTES + relative_body_id_bytes(body, previous_body)
}

/// Greedy fill of ≤ MAX_DATAGRAM packets; every packet stays independently
/// decodable (its first record id is absolute).
pub fn packetize(
    records: &[DatagramRecord],
    sequence: &mut u32,
    baseline_id: u32,
    tick: u32,
) -> Vec<Datagram> {
    let mut packets = Vec::new();
    let mut current = Datagram {
        sequence: *sequence,
        baseline_id,
        tick,
        records: Vec::new(),
        bytes: DATAGRAM_HEADER,
    };
    for record in records {
        let previous_body = current.records.last().map(|previous| previous.body);
        let mut record_bytes = packed_record_bytes(record.bytes, record.body, previous_body);
        if current.bytes + record_bytes > MAX_DATAGRAM && !current.records.is_empty() {
            debug_assert!(current.bytes <= MAX_DATAGRAM);
            packets.push(current);
            *sequence += 1;
            current = Datagram {
                sequence: *sequence,
                baseline_id,
                tick,
                records: Vec::new(),
                bytes: DATAGRAM_HEADER,
            };
            record_bytes = packed_record_bytes(record.bytes, record.body, None);
        }
        current.bytes += record_bytes;
        current.records.push(*record);
    }
    if !current.records.is_empty() {
        debug_assert!(current.bytes <= MAX_DATAGRAM);
        packets.push(current);
        *sequence += 1;
    }
    packets
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quant::ABSOLUTE_BYTES;

    #[test]
    fn packet_size_never_exceeds_mtu() {
        let records: Vec<_> = (0..1000)
            .map(|body| DatagramRecord {
                body,
                choice: WireChoice::Absolute,
                bytes: ABSOLUTE_BYTES,
            })
            .collect();
        let mut sequence = 0;
        let packets = packetize(&records, &mut sequence, 1, 2);
        assert!(packets.iter().all(|p| p.bytes <= MAX_DATAGRAM));
        assert_eq!(packets.iter().map(|p| p.records.len()).sum::<usize>(), 1000);
        let packed_bytes: usize = packets.iter().map(|packet| packet.bytes).sum();
        let fixed_bytes = records.len() * ABSOLUTE_BYTES + packets.len() * DATAGRAM_HEADER;
        assert!(packed_bytes < fixed_bytes);
    }

    #[test]
    fn relative_body_ids_use_leb128_sized_gaps() {
        assert_eq!(relative_body_id_bytes(7, None), 1);
        assert_eq!(relative_body_id_bytes(200, None), 2);
        assert_eq!(relative_body_id_bytes(101, Some(100)), 1);
        assert_eq!(relative_body_id_bytes(10_000, Some(100)), 2);
    }
}
