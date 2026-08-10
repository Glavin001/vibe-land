//! Stable network id packing for the destructible city.
//!
//! Namespacing follows server/src/physx_runtime.rs: the top nibble selects an
//! entity namespace; 0x8 is free and becomes NS_CHUNK. Within destruction:
//!
//! - chunk id     = (structure_id << 12) | node_index      (≤ 4096 nodes/structure)
//! - bond id      = (structure_id << 16) | bond_index      (≤ 65536 bonds/structure)
//! - body entity  = NS_CHUNK | (structure_id << 16) | island_serial
//!
//! Island serials are monotonic per structure and never reused within a match,
//! so retired ids stay dead. Serial 0 is reserved for the intact support actor.

pub const NS_CHUNK: u32 = 0x8000_0000;
pub const ID_MASK: u32 = 0x0fff_ffff;

pub const MAX_NODES_PER_STRUCTURE: u32 = 1 << 12;
pub const MAX_BONDS_PER_STRUCTURE: u32 = 1 << 16;
pub const MAX_ISLAND_SERIALS: u32 = 1 << 16;
/// Body entities pack the structure into 28 - 16 = 12 bits.
pub const MAX_STRUCTURES: u32 = 1 << 12;

pub const SUPPORT_ISLAND_SERIAL: u16 = 0;

#[inline]
pub fn chunk_id(structure_id: u32, node_index: u32) -> u32 {
    debug_assert!(structure_id < MAX_STRUCTURES);
    debug_assert!(node_index < MAX_NODES_PER_STRUCTURE);
    (structure_id << 12) | node_index
}

#[inline]
pub fn chunk_id_parts(chunk_id: u32) -> (u32, u32) {
    (chunk_id >> 12, chunk_id & (MAX_NODES_PER_STRUCTURE - 1))
}

#[inline]
pub fn bond_id(structure_id: u32, bond_index: u32) -> u32 {
    debug_assert!(structure_id < MAX_STRUCTURES);
    debug_assert!(bond_index < MAX_BONDS_PER_STRUCTURE);
    (structure_id << 16) | bond_index
}

#[inline]
pub fn bond_id_parts(bond_id: u32) -> (u32, u32) {
    (bond_id >> 16, bond_id & (MAX_BONDS_PER_STRUCTURE - 1))
}

#[inline]
pub fn body_entity(structure_id: u32, island_serial: u16) -> u32 {
    debug_assert!(structure_id < MAX_STRUCTURES);
    NS_CHUNK | (structure_id << 16) | island_serial as u32
}

#[inline]
pub fn is_chunk_entity(entity: u32) -> bool {
    entity & 0xf000_0000 == NS_CHUNK
}

#[inline]
pub fn body_entity_parts(entity: u32) -> (u32, u16) {
    debug_assert!(is_chunk_entity(entity));
    (
        (entity & ID_MASK) >> 16,
        (entity & (MAX_ISLAND_SERIALS - 1)) as u16,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_ids_round_trip() {
        let id = chunk_id(15, 203);
        assert_eq!(chunk_id_parts(id), (15, 203));
    }

    #[test]
    fn bond_ids_round_trip() {
        let id = bond_id(15, 545);
        assert_eq!(bond_id_parts(id), (15, 545));
    }

    #[test]
    fn body_entities_round_trip_and_namespace() {
        let entity = body_entity(15, 42);
        assert!(is_chunk_entity(entity));
        assert_eq!(body_entity_parts(entity), (15, 42));
        // Distinct from the existing NS_* namespaces (top nibble 0x1,2,4,6,7).
        for ns in [0x1000_0000_u32, 0x2000_0000, 0x4000_0000, 0x6000_0000, 0x7000_0000] {
            assert!(!is_chunk_entity(ns | 42));
        }
    }

    #[test]
    fn intra_structure_ids_are_dense_for_leb128_gaps() {
        // Consecutive chunk ids within one structure differ by 1, so packet
        // LEB128 gap coding stays 1 byte; crossing structures costs ≤ 2 bytes.
        let a = chunk_id(3, 100);
        let b = chunk_id(3, 101);
        let c = chunk_id(4, 0);
        assert_eq!(b - a, 1);
        assert!(c - b < 1 << 14);
    }
}
