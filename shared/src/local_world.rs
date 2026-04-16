use std::collections::HashMap;

use rapier3d::prelude::ColliderHandle;

use crate::{
    constants::{BLOCK_ADD, BLOCK_REMOVE},
    physics_arena::{PhysicsArena, Vec3},
    protocol::{BlockCell, BlockEditCmd, BlockEditNet, ChunkDiffPacket, ChunkFullPacket},
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
        Self {
            chunks: HashMap::new(),
        }
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

        self.seed_ball_pit(arena);
        self.rebuild_all_chunk_colliders(arena);
    }

    fn seed_ball_pit(&mut self, arena: &mut PhysicsArena) {
        let pit_x = 8;
        let pit_z = 8;
        let pit_w = 8;
        let pit_d = 8;
        let wall_h = 3;

        for y in 1..=wall_h {
            for i in 0..pit_w {
                self.set_block_deferred(
                    world_to_chunk_and_local(pit_x + i, y, pit_z + pit_d - 1),
                    3,
                );
            }
            for j in 0..pit_d {
                self.set_block_deferred(world_to_chunk_and_local(pit_x, y, pit_z + j), 3);
                self.set_block_deferred(
                    world_to_chunk_and_local(pit_x + pit_w - 1, y, pit_z + j),
                    3,
                );
            }
        }

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
                    arena.spawn_dynamic_ball(Vec3::new(x, y, z), radius);
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

    pub fn apply_edit(
        &mut self,
        arena: &mut PhysicsArena,
        cmd: &BlockEditCmd,
    ) -> Result<ChunkDiffPacket, String> {
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
            chunk.dirty_edits.push(BlockEditNet {
                x: cmd.local[0],
                y: cmd.local[1],
                z: cmd.local[2],
                op: cmd.op,
                material: cmd.material,
            });
        }

        {
            let idx = pack_local_index(cmd.local[0], cmd.local[1], cmd.local[2]);
            let chunk = self.chunks.get_mut(&key).unwrap();

            match cmd.op {
                BLOCK_ADD => {
                    let world = chunk_local_to_world_center(
                        key,
                        [cmd.local[0], cmd.local[1], cmd.local[2]],
                    );
                    let handle = arena.add_static_cuboid(
                        world,
                        Vec3::new(0.5, 0.5, 0.5),
                        encode_block_user_data(key, idx, cmd.material),
                    );
                    chunk.colliders.push(handle);
                }
                BLOCK_REMOVE => {
                    let user_data = encode_block_user_data(key, idx, 0);
                    let mask: u128 = !0xffff_u128;
                    if let Some(pos) = chunk.colliders.iter().position(|&h| {
                        arena
                            .collider_user_data(h)
                            .is_some_and(|ud| (ud & mask) == (user_data & mask))
                    }) {
                        let handle = chunk.colliders.swap_remove(pos);
                        arena.remove_collider(handle);
                    }
                    let world = chunk_local_to_world_center(
                        key,
                        [cmd.local[0], cmd.local[1], cmd.local[2]],
                    );
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

    fn set_block_deferred(&mut self, (key, local): (ChunkKey, [u8; 3]), material: u16) {
        let chunk = self.chunks.entry(key).or_default();
        chunk
            .blocks
            .insert(pack_local_index(local[0], local[1], local[2]), material);
        chunk.version += 1;
    }

    fn rebuild_all_chunk_colliders(&mut self, arena: &mut PhysicsArena) {
        let keys: Vec<ChunkKey> = self.chunks.keys().copied().collect();
        for key in keys {
            let _ = self.rebuild_chunk_colliders(arena, key);
        }
    }

    fn rebuild_chunk_colliders(
        &mut self,
        arena: &mut PhysicsArena,
        key: ChunkKey,
    ) -> Result<(), String> {
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
            let handle = arena.add_static_cuboid(
                world,
                Vec3::new(0.5, 0.5, 0.5),
                encode_block_user_data(key, idx, material),
            );
            chunk.colliders.push(handle);
        }

        Ok(())
    }
}

fn encode_block_user_data(key: ChunkKey, idx: u16, material: u16) -> u128 {
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
    [
        ((v >> 8) & 0x0f) as u8,
        ((v >> 4) & 0x0f) as u8,
        (v & 0x0f) as u8,
    ]
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
    if r < 0 {
        r + b
    } else {
        r
    }
}
