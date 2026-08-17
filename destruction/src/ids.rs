//! Stable network id packing for the destructible city.
//!
//! Namespacing follows server/src/physx_runtime.rs: the top nibble selects an
//! entity namespace; 0x8 is free and becomes NS_CHUNK. Within destruction:
//!
//! - chunk id     = (structure_id << 16) | node_index      (≤ 65536 nodes/structure)
//! - bond id      = (structure_id << 20) | bond_index      (≤ 1048576 bonds/structure)
//! - body entity  = NS_CHUNK | (structure_id << 22) | island_serial
//!
//! Island serials are monotonic per structure and never reused within a match,
//! so retired ids stay dead. Serial 0 is reserved for the intact support actor.
//!
//! Never reused means the serial space is consumed by *cumulative* body
//! creation, not by how many bodies are live. At 16 bits a long session with
//! continuous destruction can exhaust it, and past the wrap every new body
//! aliases onto a live one -- distinct bodies sharing a network id, so the
//! client draws both their chunk sets with a single pose. Hence 22 bits
//! (4.19M) for the serial and 6 for the structure: we place 16 structures and
//! will never place 64, whereas cumulative serials are genuinely unbounded.

pub const NS_CHUNK: u32 = 0x8000_0000;
pub const ID_MASK: u32 = 0x0fff_ffff;

/// Nodes per structure.
///
/// 16 bits, not 12. A structure is one *scene pack instance*, and a pack that
/// is an authored city district rather than a single building carries far more
/// than 4096 nodes -- fractured-district.json has 15,918. Past the old limit
/// the node index overflowed its field, bled into the structure id, and came
/// back out of `chunk_id_parts` masked down to `node_index % 4096`: a promoted
/// island's membership pointed at unrelated chunks hundreds of metres away, so
/// they rendered scattered around the building they were supposed to be part
/// of. 74% of that pack's chunks were affected.
pub const MAX_NODES_PER_STRUCTURE: u32 = 1 << 16;
/// Bonds per structure.
///
/// 20 bits, not 16. Bonds outnumber nodes roughly 3:1 in these packs, so the
/// bond field runs out first: a dense downtown of 27 buildings is 24,105 nodes
/// but 74,543 bonds, already past 1 << 16. Same failure mode as the node field
/// -- the index would have carried into the structure id and come back masked,
/// silently renaming which bond a break referred to.
pub const MAX_BONDS_PER_STRUCTURE: u32 = 1 << 20;
pub const MAX_ISLAND_SERIALS: u32 = 1 << 22;
/// Body entities pack the structure into 28 - 22 = 6 bits.
pub const MAX_STRUCTURES: u32 = 1 << 6;

pub const SUPPORT_ISLAND_SERIAL: u32 = 0;

#[inline]
pub fn chunk_id(structure_id: u32, node_index: u32) -> u32 {
    // Hard asserts, not debug_asserts. These bounds are fixed the moment a
    // scene pack is loaded, so a violation is a startup-time authoring error
    // that fails fast and loudly. As debug_asserts they vanished from the
    // release build and the overflow instead corrupted island membership
    // silently for an entire match -- far worse than a crash on load.
    assert!(structure_id < MAX_STRUCTURES, "structure {structure_id} exceeds id space");
    assert!(
        node_index < MAX_NODES_PER_STRUCTURE,
        "node {node_index} exceeds {MAX_NODES_PER_STRUCTURE} nodes/structure",
    );
    (structure_id << 16) | node_index
}

#[inline]
pub fn chunk_id_parts(chunk_id: u32) -> (u32, u32) {
    (chunk_id >> 16, chunk_id & (MAX_NODES_PER_STRUCTURE - 1))
}

#[inline]
pub fn bond_id(structure_id: u32, bond_index: u32) -> u32 {
    // Hard, for the same reason as chunk_id: silent overflow outlives a match.
    assert!(structure_id < MAX_STRUCTURES, "structure {structure_id} exceeds id space");
    assert!(
        bond_index < MAX_BONDS_PER_STRUCTURE,
        "bond {bond_index} exceeds {MAX_BONDS_PER_STRUCTURE} bonds/structure",
    );
    (structure_id << 20) | bond_index
}

#[inline]
pub fn bond_id_parts(bond_id: u32) -> (u32, u32) {
    (bond_id >> 20, bond_id & (MAX_BONDS_PER_STRUCTURE - 1))
}

#[inline]
pub fn body_entity(structure_id: u32, island_serial: u32) -> u32 {
    debug_assert!(structure_id < MAX_STRUCTURES);
    debug_assert!(island_serial < MAX_ISLAND_SERIALS);
    NS_CHUNK | (structure_id << 22) | island_serial
}

#[inline]
pub fn is_chunk_entity(entity: u32) -> bool {
    entity & 0xf000_0000 == NS_CHUNK
}

#[inline]
pub fn body_entity_parts(entity: u32) -> (u32, u32) {
    debug_assert!(is_chunk_entity(entity));
    ((entity & ID_MASK) >> 22, entity & (MAX_ISLAND_SERIALS - 1))
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
        // LEB128 gap coding stays 1 byte. Crossing structures now costs ≤ 3
        // bytes rather than 2, the price of the wider node field -- and only
        // for a list that mixes structures, which island membership never does.
        let a = chunk_id(3, 100);
        let b = chunk_id(3, 101);
        let c = chunk_id(4, 0);
        assert_eq!(b - a, 1);
        assert!(c - b < 1 << 21);
    }

    /// A district pack is a single structure with far more than 4096 nodes.
    ///
    /// At the old 12-bit field, node 15_917 packed into the structure field and
    /// `chunk_id_parts` handed back `15_917 % 4096 = 3_629` under structure 3 --
    /// so an island claimed a chunk from the other side of the map and drew it
    /// there. Silent in release, because the guard was a debug_assert.
    #[test]
    fn district_sized_structures_round_trip() {
        for node in [0, 1, 4_095, 4_096, 9_594, 15_917, MAX_NODES_PER_STRUCTURE - 1] {
            let id = chunk_id(0, node);
            assert_eq!(chunk_id_parts(id), (0, node), "node {node} did not round-trip");
        }
        // And the node index must never leak into the structure field.
        for structure in [0, 1, 5, MAX_STRUCTURES - 1] {
            let id = chunk_id(structure, 15_917);
            assert_eq!(chunk_id_parts(id), (structure, 15_917));
        }
    }

    #[test]
    #[should_panic(expected = "exceeds")]
    fn node_index_past_the_field_is_loud() {
        chunk_id(0, MAX_NODES_PER_STRUCTURE);
    }

    /// Bonds outrun nodes ~3:1, so the bond field is the one that fills first.
    /// A dense 27-building downtown is 24,105 nodes but 74,543 bonds.
    #[test]
    fn downtown_sized_structures_round_trip() {
        for node in [4_096, 24_104, MAX_NODES_PER_STRUCTURE - 1] {
            assert_eq!(chunk_id_parts(chunk_id(0, node)), (0, node));
        }
        for bond in [65_535, 65_536, 74_542, MAX_BONDS_PER_STRUCTURE - 1] {
            assert_eq!(bond_id_parts(bond_id(0, bond)), (0, bond), "bond {bond}");
            assert_eq!(bond_id_parts(bond_id(5, bond)), (5, bond), "bond {bond} @ structure 5");
        }
    }

    /// Every packed id has to stay inside the namespace mask, or it would
    /// collide with another entity namespace once ORed with NS_CHUNK.
    #[test]
    fn widened_fields_stay_inside_the_id_mask() {
        assert!(chunk_id(MAX_STRUCTURES - 1, MAX_NODES_PER_STRUCTURE - 1) <= ID_MASK);
        assert!(bond_id(MAX_STRUCTURES - 1, MAX_BONDS_PER_STRUCTURE - 1) <= ID_MASK);
    }

    #[test]
    #[should_panic(expected = "exceeds")]
    fn bond_index_past_the_field_is_loud() {
        bond_id(0, MAX_BONDS_PER_STRUCTURE);
    }
}
