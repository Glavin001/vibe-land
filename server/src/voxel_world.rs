use std::collections::HashMap;

use rapier3d::prelude::ColliderHandle;

use crate::{
    movement::{PhysicsArena, Vec3},
    protocol::{BlockCell, BlockEditCmd, BlockEditNet, ChunkDiffPacket, ChunkFullPacket, BLOCK_ADD, BLOCK_REMOVE},
};

pub const CHUNK_SIZE: i32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChunkKey {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

#[derive(Default)]
pub struct Chunk {
    pub version: u32,
    pub blocks: HashMap<u16, u16>,
    pub dirty_edits: Vec<BlockEditNet>,
    pub colliders: Vec<ColliderHandle>,
}

pub struct VoxelWorld {
    pub chunks: HashMap<ChunkKey, Chunk>,
}

impl VoxelWorld {
    pub fn new() -> Self {
        Self { chunks: HashMap::new() }
    }

    pub fn seed_demo_world(&mut self, arena: &mut PhysicsArena) {
        for x in -24..24 {
            for z in -24..24 {
                self.set_block_deferred(world_to_chunk_and_local(x, 0, z), 1);
            }
        }

        for y in 1..4 {
            self.set_block_deferred(world_to_chunk_and_local(2, y, 2), 2);
        }
        self.set_block_deferred(world_to_chunk_and_local(3, 1, 2), 2);
        self.set_block_deferred(world_to_chunk_and_local(3, 2, 2), 2);

        // Ball pit enclosure
        self.seed_ball_pit(arena);

        // Rebuild all chunk colliders once after all blocks are placed
        self.rebuild_all_chunk_colliders(arena);
    }

    fn seed_ball_pit(&mut self, arena: &mut PhysicsArena) {
        let pit_x = 8;
        let pit_z = 8;
        let pit_w = 8; // width (x)
        let pit_d = 8; // depth (z)
        let wall_h = 3;

        // Build walls (material 3 for a distinct look)
        // Skip front wall entirely to leave an open entrance
        for y in 1..=wall_h {
            for i in 0..pit_w {
                // Back wall (z = pit_z + pit_d - 1)
                self.set_block_deferred(world_to_chunk_and_local(pit_x + i, y, pit_z + pit_d - 1), 3);
            }
            for j in 0..pit_d {
                // Left wall (x = pit_x)
                self.set_block_deferred(world_to_chunk_and_local(pit_x, y, pit_z + j), 3);
                // Right wall (x = pit_x + pit_w - 1)
                self.set_block_deferred(world_to_chunk_and_local(pit_x + pit_w - 1, y, pit_z + j), 3);
            }
        }

        // Spawn balls above the pit — they'll fall and settle on the ground
        let radius = 0.3_f32;
        let inner_min_x = pit_x as f32 + 1.5;
        let inner_min_z = pit_z as f32 + 1.5;
        let spacing = 0.8;
        let cols = 5;
        let rows = 5;
        let layers = 2;

        for layer in 0..layers {
            for row in 0..rows {
                for col in 0..cols {
                    let x = inner_min_x + col as f32 * spacing;
                    let y = 2.0 + layer as f32 * 0.8;
                    let z = inner_min_z + row as f32 * spacing;
                    arena.spawn_dynamic_ball(
                        Vec3::new(x, y, z),
                        radius,
                    );
                }
            }
        }
    }

    pub fn visible_chunks_around(&self, pos: [f32; 3], radius_chunks: i32) -> Vec<ChunkKey> {
        let base = world_to_chunk(
            pos[0].floor() as i32,
            pos[1].floor() as i32,
            pos[2].floor() as i32,
        );
        let mut out = Vec::new();
        for dx in -radius_chunks..=radius_chunks {
            for dy in -1..=1 {
                for dz in -radius_chunks..=radius_chunks {
                    let key = ChunkKey {
                        x: base.x + dx,
                        y: base.y + dy,
                        z: base.z + dz,
                    };
                    if self.chunks.contains_key(&key) {
                        out.push(key);
                    }
                }
            }
        }
        out
    }

    pub fn chunk_full_packet(&self, key: ChunkKey) -> Option<ChunkFullPacket> {
        let chunk = self.chunks.get(&key)?;
        let mut blocks = Vec::with_capacity(chunk.blocks.len());
        for (&idx, &material) in &chunk.blocks {
            let [x, y, z] = unpack_local_index(idx);
            blocks.push(BlockCell { x, y, z, material });
        }
        Some(ChunkFullPacket {
            chunk: [key.x as i16, key.y as i16, key.z as i16],
            version: chunk.version,
            blocks,
        })
    }

    pub fn chunk_full_for_coords(&self, coords: [i16; 3]) -> Option<ChunkFullPacket> {
        self.chunk_full_packet(ChunkKey {
            x: coords[0] as i32,
            y: coords[1] as i32,
            z: coords[2] as i32,
        })
    }

    pub fn apply_edit(&mut self, arena: &mut PhysicsArena, cmd: &BlockEditCmd) -> Result<ChunkDiffPacket, String> {
        let key = ChunkKey {
            x: cmd.chunk[0] as i32,
            y: cmd.chunk[1] as i32,
            z: cmd.chunk[2] as i32,
        };

        {
            let chunk = self.chunks.entry(key).or_default();
            if chunk.version != cmd.expected_version {
                return Err(format!(
                    "chunk version mismatch: expected {}, actual {}",
                    cmd.expected_version, chunk.version
                ));
            }

            let idx = pack_local_index(cmd.local[0], cmd.local[1], cmd.local[2]);
            match cmd.op {
                BLOCK_ADD => {
                    chunk.blocks.insert(idx, cmd.material);
                }
                BLOCK_REMOVE => {
                    chunk.blocks.remove(&idx);
                }
                other => return Err(format!("unsupported block op {other}")),
            }

            chunk.version += 1;
            let net_edit = BlockEditNet {
                x: cmd.local[0],
                y: cmd.local[1],
                z: cmd.local[2],
                op: cmd.op,
                material: cmd.material,
            };
            chunk.dirty_edits.push(net_edit);
        }

        // Surgically add/remove only the single affected collider rather than
        // rebuilding the entire chunk.  Rebuilding hundreds of colliders in one
        // batch corrupts Rapier's BroadPhaseBvh incremental state.
        {
            let idx = pack_local_index(cmd.local[0], cmd.local[1], cmd.local[2]);
            let chunk = self.chunks.get_mut(&key).unwrap();

            match cmd.op {
                BLOCK_ADD => {
                    let world = chunk_local_to_world_center(key, [cmd.local[0], cmd.local[1], cmd.local[2]]);
                    let handle = arena.add_static_cuboid(
                        world,
                        Vec3::new(0.5, 0.5, 0.5),
                        encode_block_user_data(key, idx, cmd.material),
                    );
                    chunk.colliders.push(handle);
                }
                BLOCK_REMOVE => {
                    let user_data = encode_block_user_data(key, idx, 0);
                    // Match on chunk+idx portion of user_data (ignore 16-bit material field)
                    let mask: u128 = !0xffff_u128;
                    if let Some(pos) = chunk.colliders.iter().position(|&h| {
                        arena.collider_user_data(h).map_or(false, |ud| (ud & mask) == (user_data & mask))
                    }) {
                        let handle = chunk.colliders.swap_remove(pos);
                        arena.remove_collider(handle);
                    }
                    // Wake sleeping dynamic bodies near the removed block so they
                    // notice the gap and fall through.
                    let world = chunk_local_to_world_center(key, [cmd.local[0], cmd.local[1], cmd.local[2]]);
                    arena.wake_bodies_near(world, 2.0);
                }
                _ => {}
            }
        }

        let chunk = self.chunks.get(&key).unwrap();
        let last_edit = chunk.dirty_edits.last().copied().unwrap();
        Ok(ChunkDiffPacket {
            chunk: [key.x as i16, key.y as i16, key.z as i16],
            version: chunk.version,
            edits: vec![last_edit],
        })
    }

    pub fn take_dirty_chunk_diffs(&mut self) -> Vec<ChunkDiffPacket> {
        let mut out = Vec::new();
        for (&key, chunk) in &mut self.chunks {
            if chunk.dirty_edits.is_empty() {
                continue;
            }
            out.push(ChunkDiffPacket {
                chunk: [key.x as i16, key.y as i16, key.z as i16],
                version: chunk.version,
                edits: std::mem::take(&mut chunk.dirty_edits),
            });
        }
        out
    }

    fn set_block(&mut self, arena: &mut PhysicsArena, (key, local): (ChunkKey, [u8; 3]), material: u16) {
        let chunk = self.chunks.entry(key).or_default();
        chunk.blocks.insert(pack_local_index(local[0], local[1], local[2]), material);
        chunk.version += 1;
        let _ = self.rebuild_chunk_colliders(arena, key);
    }

    /// Set block data without rebuilding colliders. Call `rebuild_all_chunk_colliders`
    /// after bulk placement is complete.
    fn set_block_deferred(&mut self, (key, local): (ChunkKey, [u8; 3]), material: u16) {
        let chunk = self.chunks.entry(key).or_default();
        chunk.blocks.insert(pack_local_index(local[0], local[1], local[2]), material);
        chunk.version += 1;
    }

    /// Rebuild colliders for every chunk. Used once after bulk seeding to avoid
    /// per-block rebuild overhead and stale-handle accumulation.
    fn rebuild_all_chunk_colliders(&mut self, arena: &mut PhysicsArena) {
        let keys: Vec<ChunkKey> = self.chunks.keys().copied().collect();
        for key in keys {
            let _ = self.rebuild_chunk_colliders(arena, key);
        }
    }

    fn rebuild_chunk_colliders(&mut self, arena: &mut PhysicsArena, key: ChunkKey) -> Result<(), String> {
        let Some(chunk) = self.chunks.get_mut(&key) else {
            return Ok(());
        };

        for handle in chunk.colliders.drain(..) {
            arena.remove_collider(handle);
        }

        for (&idx, &material) in &chunk.blocks {
            if material == 0 {
                continue;
            }
            let [lx, ly, lz] = unpack_local_index(idx);
            let world = chunk_local_to_world_center(key, [lx, ly, lz]);
            let handle = arena.add_static_cuboid(world, Vec3::new(0.5, 0.5, 0.5), encode_block_user_data(key, idx, material));
            chunk.colliders.push(handle);
        }

        Ok(())
    }
}

fn encode_block_user_data(key: ChunkKey, idx: u16, material: u16) -> u128 {
    // Layout (128 bits, non-overlapping):
    //   [127:96] chunk_x (32 bits, from i32 → u32)
    //   [95:64]  chunk_y (32 bits)
    //   [63:32]  chunk_z (32 bits)
    //   [31:16]  local_idx (16 bits — pack_local_index produces up to 12 bits)
    //   [15:0]   material (16 bits)
    let cx = (key.x as u32) as u128;
    let cy = (key.y as u32) as u128;
    let cz = (key.z as u32) as u128;
    (cx << 96) | (cy << 64) | (cz << 32) | ((idx as u128) << 16) | (material as u128)
}

pub fn world_to_chunk_and_local(wx: i32, wy: i32, wz: i32) -> (ChunkKey, [u8; 3]) {
    let key = world_to_chunk(wx, wy, wz);
    let local = [
        mod_floor(wx, CHUNK_SIZE) as u8,
        mod_floor(wy, CHUNK_SIZE) as u8,
        mod_floor(wz, CHUNK_SIZE) as u8,
    ];
    (key, local)
}

pub fn world_to_chunk(wx: i32, wy: i32, wz: i32) -> ChunkKey {
    ChunkKey {
        x: div_floor(wx, CHUNK_SIZE),
        y: div_floor(wy, CHUNK_SIZE),
        z: div_floor(wz, CHUNK_SIZE),
    }
}

pub fn chunk_local_to_world_center(key: ChunkKey, local: [u8; 3]) -> Vec3 {
    Vec3::new(
        (key.x * CHUNK_SIZE + local[0] as i32) as f32 + 0.5,
        (key.y * CHUNK_SIZE + local[1] as i32) as f32 + 0.5,
        (key.z * CHUNK_SIZE + local[2] as i32) as f32 + 0.5,
    )
}

fn pack_local_index(x: u8, y: u8, z: u8) -> u16 {
    ((x as u16) << 8) | ((y as u16) << 4) | (z as u16)
}

fn unpack_local_index(v: u16) -> [u8; 3] {
    [((v >> 8) & 0x0f) as u8, ((v >> 4) & 0x0f) as u8, (v & 0x0f) as u8]
}

fn div_floor(a: i32, b: i32) -> i32 {
    let mut q = a / b;
    let r = a % b;
    if r != 0 && (r < 0) != (b < 0) {
        q -= 1;
    }
    q
}

fn mod_floor(a: i32, b: i32) -> i32 {
    let r = a % b;
    if r < 0 { r + b } else { r }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BLOCK_ADD, BLOCK_REMOVE, BlockEditCmd};
    use crate::movement::MoveConfig;

    fn make_arena() -> PhysicsArena {
        PhysicsArena::new(MoveConfig::default())
    }

    // ── div_floor / mod_floor ──────────────────────

    #[test]
    fn div_floor_positive() {
        assert_eq!(div_floor(17, 16), 1);
        assert_eq!(div_floor(16, 16), 1);
        assert_eq!(div_floor(15, 16), 0);
        assert_eq!(div_floor(0, 16), 0);
    }

    #[test]
    fn div_floor_negative() {
        assert_eq!(div_floor(-1, 16), -1);
        assert_eq!(div_floor(-16, 16), -1);
        assert_eq!(div_floor(-17, 16), -2);
        assert_eq!(div_floor(-32, 16), -2);
        assert_eq!(div_floor(-33, 16), -3);
    }

    #[test]
    fn mod_floor_positive() {
        assert_eq!(mod_floor(0, 16), 0);
        assert_eq!(mod_floor(1, 16), 1);
        assert_eq!(mod_floor(15, 16), 15);
        assert_eq!(mod_floor(16, 16), 0);
        assert_eq!(mod_floor(17, 16), 1);
    }

    #[test]
    fn mod_floor_negative() {
        assert_eq!(mod_floor(-1, 16), 15);
        assert_eq!(mod_floor(-16, 16), 0);
        assert_eq!(mod_floor(-17, 16), 15);
        assert_eq!(mod_floor(-15, 16), 1);
    }

    // ── pack / unpack local index ──────────────────

    #[test]
    fn pack_unpack_roundtrip_origin() {
        let packed = pack_local_index(0, 0, 0);
        assert_eq!(unpack_local_index(packed), [0, 0, 0]);
    }

    #[test]
    fn pack_unpack_roundtrip_max() {
        let packed = pack_local_index(15, 15, 15);
        assert_eq!(unpack_local_index(packed), [15, 15, 15]);
    }

    #[test]
    fn pack_unpack_roundtrip_mixed() {
        let packed = pack_local_index(7, 8, 9);
        assert_eq!(unpack_local_index(packed), [7, 8, 9]);
    }

    // ── world_to_chunk_and_local ───────────────────

    #[test]
    fn world_to_chunk_and_local_positive() {
        let (key, local) = world_to_chunk_and_local(5, 3, 7);
        assert_eq!(key, ChunkKey { x: 0, y: 0, z: 0 });
        assert_eq!(local, [5, 3, 7]);
    }

    #[test]
    fn world_to_chunk_and_local_at_chunk_boundary_16() {
        let (key, local) = world_to_chunk_and_local(16, 0, 0);
        assert_eq!(key, ChunkKey { x: 1, y: 0, z: 0 });
        assert_eq!(local, [0, 0, 0]);
    }

    #[test]
    fn world_to_chunk_and_local_at_zero() {
        let (key, local) = world_to_chunk_and_local(0, 0, 0);
        assert_eq!(key, ChunkKey { x: 0, y: 0, z: 0 });
        assert_eq!(local, [0, 0, 0]);
    }

    #[test]
    fn world_to_chunk_and_local_negative_minus_one() {
        let (key, local) = world_to_chunk_and_local(-1, -1, -1);
        assert_eq!(key, ChunkKey { x: -1, y: -1, z: -1 });
        assert_eq!(local, [15, 15, 15]);
    }

    #[test]
    fn world_to_chunk_and_local_negative_minus_16() {
        let (key, local) = world_to_chunk_and_local(-16, 0, 0);
        assert_eq!(key, ChunkKey { x: -1, y: 0, z: 0 });
        assert_eq!(local, [0, 0, 0]);
    }

    #[test]
    fn world_to_chunk_and_local_negative_minus_17() {
        let (key, local) = world_to_chunk_and_local(-17, 0, 0);
        assert_eq!(key, ChunkKey { x: -2, y: 0, z: 0 });
        assert_eq!(local, [15, 0, 0]);
    }

    // ── chunk_local_to_world_center ────────────────

    #[test]
    fn chunk_local_to_world_center_origin_chunk() {
        let center = chunk_local_to_world_center(
            ChunkKey { x: 0, y: 0, z: 0 },
            [0, 0, 0],
        );
        assert!((center.x - 0.5).abs() < 1e-5);
        assert!((center.y - 0.5).abs() < 1e-5);
        assert!((center.z - 0.5).abs() < 1e-5);
    }

    #[test]
    fn chunk_local_to_world_center_offset_chunk() {
        let center = chunk_local_to_world_center(
            ChunkKey { x: 1, y: 0, z: -1 },
            [3, 5, 7],
        );
        // world x = 1*16 + 3 + 0.5 = 19.5
        assert!((center.x - 19.5).abs() < 1e-5);
        // world y = 0*16 + 5 + 0.5 = 5.5
        assert!((center.y - 5.5).abs() < 1e-5);
        // world z = -1*16 + 7 + 0.5 = -8.5
        assert!((center.z - (-8.5)).abs() < 1e-5);
    }

    // ── apply_edit ─────────────────────────────────

    #[test]
    fn apply_edit_version_mismatch() {
        let mut world = VoxelWorld::new();
        let mut arena = make_arena();

        // Insert a block to create chunk at (0,0,0) with version 1
        let (key, local) = world_to_chunk_and_local(0, 0, 0);
        let chunk = world.chunks.entry(key).or_default();
        chunk.blocks.insert(pack_local_index(local[0], local[1], local[2]), 1);
        chunk.version = 1;

        let cmd = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 99, // wrong version
            local: [1, 1, 1],
            op: BLOCK_ADD,
            material: 2,
        };

        let result = world.apply_edit(&mut arena, &cmd);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("version mismatch"));
    }

    #[test]
    fn apply_edit_add_block_succeeds() {
        let mut world = VoxelWorld::new();
        let mut arena = make_arena();

        let cmd = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 0, // default version for new chunk
            local: [3, 4, 5],
            op: BLOCK_ADD,
            material: 7,
        };

        let result = world.apply_edit(&mut arena, &cmd);
        assert!(result.is_ok());

        let diff = result.unwrap();
        assert_eq!(diff.chunk, [0, 0, 0]);
        assert_eq!(diff.version, 1);
        assert_eq!(diff.edits.len(), 1);
        assert_eq!(diff.edits[0].op, BLOCK_ADD);
        assert_eq!(diff.edits[0].material, 7);

        // Verify block is stored
        let key = ChunkKey { x: 0, y: 0, z: 0 };
        let idx = pack_local_index(3, 4, 5);
        assert_eq!(world.chunks[&key].blocks[&idx], 7);
    }

    #[test]
    fn apply_edit_remove_block() {
        let mut world = VoxelWorld::new();
        let mut arena = make_arena();

        // First add a block
        let add_cmd = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 0,
            local: [3, 4, 5],
            op: BLOCK_ADD,
            material: 7,
        };
        world.apply_edit(&mut arena, &add_cmd).unwrap();

        // Now remove it
        let remove_cmd = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 1, // version was bumped by the add
            local: [3, 4, 5],
            op: BLOCK_REMOVE,
            material: 0,
        };
        let result = world.apply_edit(&mut arena, &remove_cmd);
        assert!(result.is_ok());

        let key = ChunkKey { x: 0, y: 0, z: 0 };
        let idx = pack_local_index(3, 4, 5);
        assert!(!world.chunks[&key].blocks.contains_key(&idx));
    }

    // ── take_dirty_chunk_diffs ─────────────────────

    #[test]
    fn take_dirty_chunk_diffs_returns_and_clears() {
        let mut world = VoxelWorld::new();
        let mut arena = make_arena();

        let cmd = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 0,
            local: [1, 2, 3],
            op: BLOCK_ADD,
            material: 5,
        };
        world.apply_edit(&mut arena, &cmd).unwrap();

        let diffs = world.take_dirty_chunk_diffs();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].edits.len(), 1);
        assert_eq!(diffs[0].edits[0].x, 1);
        assert_eq!(diffs[0].edits[0].y, 2);
        assert_eq!(diffs[0].edits[0].z, 3);

        // Second call should be empty
        let diffs2 = world.take_dirty_chunk_diffs();
        assert!(diffs2.is_empty());
    }

    // ── chunk_full_packet ──────────────────────────

    #[test]
    fn chunk_full_packet_returns_correct_blocks() {
        let mut world = VoxelWorld::new();
        let mut arena = make_arena();

        // Add two blocks
        let cmd1 = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 0,
            local: [1, 2, 3],
            op: BLOCK_ADD,
            material: 10,
        };
        world.apply_edit(&mut arena, &cmd1).unwrap();

        let cmd2 = BlockEditCmd {
            chunk: [0, 0, 0],
            expected_version: 1,
            local: [4, 5, 6],
            op: BLOCK_ADD,
            material: 20,
        };
        world.apply_edit(&mut arena, &cmd2).unwrap();

        let packet = world.chunk_full_packet(ChunkKey { x: 0, y: 0, z: 0 }).unwrap();
        assert_eq!(packet.chunk, [0, 0, 0]);
        assert_eq!(packet.version, 2);
        assert_eq!(packet.blocks.len(), 2);

        // Check both blocks are present (order may vary)
        let has_block_1 = packet.blocks.iter().any(|b| b.x == 1 && b.y == 2 && b.z == 3 && b.material == 10);
        let has_block_2 = packet.blocks.iter().any(|b| b.x == 4 && b.y == 5 && b.z == 6 && b.material == 20);
        assert!(has_block_1, "first block missing");
        assert!(has_block_2, "second block missing");
    }

    #[test]
    fn chunk_full_packet_missing_chunk_returns_none() {
        let world = VoxelWorld::new();
        assert!(world.chunk_full_packet(ChunkKey { x: 99, y: 99, z: 99 }).is_none());
    }
}

#[cfg(test)]
mod ball_pit_tests {
    use super::*;
    use crate::movement::MoveConfig;

    #[test]
    fn ball_pit_spawns_balls() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);

        let snapshot = arena.snapshot_dynamic_bodies();
        eprintln!("Dynamic bodies count: {}", snapshot.len());
        for (id, pos, _quat, he, shape_type) in &snapshot {
            if *shape_type == 1 {
                eprintln!("Ball {}: pos={:?} he={:?}", id, pos, he);
            }
        }
        // Should have balls (128 = 8*8*2) + possibly the existing box
        assert!(snapshot.len() > 10, "Expected many dynamic bodies, got {}", snapshot.len());

        // Check balls are above ground
        for (_, pos, _, _, shape_type) in &snapshot {
            if *shape_type == 1 {
                assert!(pos[1] > 0.5, "Ball at y={} is below ground", pos[1]);
            }
        }
    }
}

#[cfg(test)]
mod ball_pit_physics_tests {
    use super::*;
    use crate::movement::MoveConfig;

    #[test]
    fn balls_dont_fall_through_ground() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);

        // Step physics for 5 seconds (300 steps at 60Hz)
        for _ in 0..300 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let snapshot = arena.snapshot_dynamic_bodies();
        let balls: Vec<_> = snapshot.iter().filter(|s| s.4 == 1).collect();
        eprintln!("After 5s: {} balls remain above y=0", balls.iter().filter(|b| b.1[1] > 0.0).count());
        eprintln!("Balls below y=0: {}", balls.iter().filter(|b| b.1[1] < 0.0).count());
        
        // Sample some positions
        for b in balls.iter().take(5) {
            eprintln!("Ball {}: y={:.3}", b.0, b.1[1]);
        }

        // All balls should still be above ground (y > 0.5)
        let fallen = balls.iter().filter(|b| b.1[1] < 0.0).count();
        assert_eq!(fallen, 0, "{} balls fell through the ground!", fallen);
    }
}
