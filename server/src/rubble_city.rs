//! `/city` on rubble: every chunk a rubble body that starts asleep.
//!
//! Interim, by the owner's decision, until rubble's stress solver is ready:
//! there is no fracture decision. Each chunk is its own rubble body, created
//! asleep where the manifest puts it, so an untouched building stands still
//! (nothing integrates while asleep). A contact from an awake body -- a
//! cannonball, a meteor, a falling chunk -- wakes what it touches, and rubble
//! moves it. Support chunks are static.
//!
//! The stream sees that as fracture, in the contract every backend emits:
//! - a chunk that rubble has woken and moved off its rest pose by more than
//!   the contact offset is *freed*: its bonds break and it becomes an island
//!   of its own (`IslandPromotion`, centre-of-mass frame);
//! - anchored chunks that lose every bonded path to a support are freed too,
//!   and woken, so an undermined building comes down;
//! - a freed chunk rubble puts back to sleep is settled (`SettleEvent`), and
//!   announced in `wakes` if it moves again.
//!
//! Anchored chunks are island 0 (`ids`), which streams no rows.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use glam::{Quat, Vec3};
use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::{ChunkGeometry, DestructionManifest};
use vibe_land_destruction::types::FLAG_WAKE_EVENT;
use vibe_land_destruction::encoder::BodySnapshotInput;
use vibe_land_rubble_bridge::{BodyId, BodyPose, BoxBody, RubbleWorld};
use vibe_netcode::destruction_backend::{
    DestructionStats, DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
};

/// Where a released city is parked: rubble bodies are append-only.
const PARKED_Y: f32 = -20_000.0;

#[derive(Clone, Copy, Debug, PartialEq)]
enum ChunkState {
    /// Static ground anchor: never moves.
    Support,
    /// Asleep at rest, part of island 0.
    Anchored,
    /// An island of its own.
    Free { serial: u32, settled: bool, just_freed: bool },
}

#[derive(Clone, Debug)]
struct Chunk {
    node: u32,
    body: BodyId,
    /// Rest pose of the body (its centre of mass), world.
    rest_position: Vec3,
    rest_rotation: Quat,
    /// Centre of mass in structure-local space (manifest `mass_center`).
    mass_center: [f32; 3],
    mass: f32,
    state: ChunkState,
}

struct Structure {
    id: u32,
    chunks: Vec<Chunk>,
    /// (node0, node1, alive), indexed by bond index.
    bonds: Vec<(u32, u32, bool)>,
    /// Bond indices per node.
    node_bonds: Vec<Vec<u32>>,
    next_serial: u32,
}

pub struct RubbleCityDestruction {
    world: Arc<Mutex<RubbleWorld>>,
    structures: Vec<Structure>,
    /// rubble body -> (structure index, chunk index), for ray hits.
    by_body: HashMap<BodyId, (usize, usize)>,
    skipped_chunks: usize,
    contact_offset: f32,
    stats: DestructionStats,
}

impl RubbleCityDestruction {
    pub fn build(manifest: &DestructionManifest, world: Arc<Mutex<RubbleWorld>>) -> Self {
        let mut structures = Vec::with_capacity(manifest.structures.len());
        let mut boxes = Vec::new();
        let mut skipped_chunks = 0;
        for s in &manifest.structures {
            let origin = Vec3::from(s.world_position);
            let rotation = Quat::from_array(s.world_rotation);
            let mut chunks = Vec::with_capacity(s.chunks.len());
            for chunk in &s.chunks {
                let ChunkGeometry::Cuboid { half_extents } = chunk.geometry else {
                    skipped_chunks += 1;
                    continue;
                };
                let mass_center = chunk.mass_center();
                let position = origin + rotation * Vec3::from(mass_center);
                let support = chunk.support || chunk.mass <= 0.0;
                boxes.push(BoxBody {
                    position: position.to_array(),
                    rotation: rotation.to_array(),
                    half: half_extents,
                    // The box is centred on the centroid; the body on the
                    // centre of mass, `mass_offset` from it.
                    box_offset: (-Vec3::from(chunk.mass_offset)).to_array(),
                    mass: if support { 0.0 } else { chunk.mass },
                    asleep: true,
                });
                chunks.push(Chunk {
                    node: chunk.node_index,
                    body: 0,
                    rest_position: position,
                    rest_rotation: rotation,
                    mass_center,
                    mass: chunk.mass,
                    state: if support { ChunkState::Support } else { ChunkState::Anchored },
                });
            }
            let node_count = s.chunks.iter().map(|c| c.node_index as usize + 1).max().unwrap_or(0);
            let mut node_bonds = vec![Vec::new(); node_count];
            let bonds: Vec<(u32, u32, bool)> = s.bonds.iter().map(|b| (b.node0, b.node1, true)).collect();
            for (i, &(a, b, _)) in bonds.iter().enumerate() {
                if let Some(list) = node_bonds.get_mut(a as usize) {
                    list.push(i as u32);
                }
                if let Some(list) = node_bonds.get_mut(b as usize) {
                    list.push(i as u32);
                }
            }
            structures.push(Structure { id: s.structure_id, chunks, bonds, node_bonds, next_serial: 1 });
        }
        let (ids_made, contact_offset) = {
            let mut w = world.lock().expect("rubble world poisoned");
            (w.add_box_bodies(&boxes, 0), w.contact_offset())
        };
        let mut by_body = HashMap::with_capacity(ids_made.len());
        let mut next = ids_made.into_iter();
        for (si, structure) in structures.iter_mut().enumerate() {
            for (ci, chunk) in structure.chunks.iter_mut().enumerate() {
                chunk.body = next.next().expect("one body per chunk");
                by_body.insert(chunk.body, (si, ci));
            }
        }
        if skipped_chunks > 0 {
            tracing::warn!(skipped_chunks, "rubble city: convex-hull chunks are not built yet (box chunks only)");
        }
        let stats = DestructionStats { chunk_bodies: 0, ..DestructionStats::default() };
        Self { world, structures, by_body, skipped_chunks, contact_offset, stats }
    }

    pub fn world(&self) -> Arc<Mutex<RubbleWorld>> {
        self.world.clone()
    }

    pub fn skipped_chunks(&self) -> usize {
        self.skipped_chunks
    }

    /// Take this city's bodies out of the world (first half of a reset).
    pub fn release(&mut self) {
        let mut w = self.world.lock().expect("rubble world poisoned");
        for structure in &self.structures {
            for chunk in &structure.chunks {
                w.park(chunk.body, [0.0, PARKED_Y, 0.0]);
            }
        }
        self.structures.clear();
        self.by_body.clear();
    }

    /// The structure a ray strikes first, if it strikes one: `(structure id,
    /// distance, point)`.
    pub fn ray_hit(&self, origin: [f32; 3], direction: [f32; 3], max_distance: f32) -> Option<(u32, f32, [f32; 3])> {
        let hit = self.world.lock().expect("rubble world poisoned").raycast(&[(origin, direction, max_distance, None)])[0]?;
        let &(si, _) = self.by_body.get(&hit.body)?;
        Some((self.structures[si].id, hit.distance, hit.point))
    }

    fn moved_off_rest(&self, chunk: &Chunk, pose: &BodyPose) -> bool {
        let shift = (Vec3::from(pose.position) - chunk.rest_position).length();
        let turn = chunk.rest_rotation.angle_between(Quat::from_array(pose.rotation));
        shift > self.contact_offset || turn * 0.5 > self.contact_offset
    }

    /// One tick after rubble stepped: free what moved, free what lost its
    /// support, settle and re-wake freed chunks; and the rows to stream.
    pub fn tick(&mut self) -> (DestructionTickOutput, Vec<BodySnapshotInput>) {
        let poses = self.world.lock().expect("rubble world poisoned").bodies();
        let mut output = DestructionTickOutput::default();
        let mut to_wake = Vec::new();
        for si in 0..self.structures.len() {
            // 1. Anchored chunks rubble has woken and moved.
            let moved: Vec<usize> = self.structures[si]
                .chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| c.state == ChunkState::Anchored)
                .filter(|(_, c)| poses.get(c.body as usize).is_some_and(|p| !p.sleeping && self.moved_off_rest(c, p)))
                .map(|(i, _)| i)
                .collect();
            if moved.is_empty() {
                continue;
            }
            let structure = &mut self.structures[si];
            let mut freed = moved;
            // 2. Anchored chunks left without a bonded path to a support.
            let node_of: HashMap<u32, usize> = structure.chunks.iter().enumerate().map(|(i, c)| (c.node, i)).collect();
            let mut freeing: Vec<bool> = structure.chunks.iter().map(|_| false).collect();
            for &i in &freed {
                freeing[i] = true;
            }
            let held = |c: &Chunk, i: usize, freeing: &[bool]| c.state != ChunkState::Anchored || freeing[i];
            let mut supported = vec![false; structure.chunks.len()];
            let mut stack: Vec<usize> = structure
                .chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| c.state == ChunkState::Support)
                .map(|(i, _)| i)
                .collect();
            for &i in &stack {
                supported[i] = true;
            }
            while let Some(i) = stack.pop() {
                let node = structure.chunks[i].node as usize;
                for &bond in structure.node_bonds.get(node).map(Vec::as_slice).unwrap_or(&[]) {
                    let (a, b, alive) = structure.bonds[bond as usize];
                    if !alive {
                        continue;
                    }
                    let other = if a as usize == node { b } else { a };
                    let Some(&j) = node_of.get(&other) else { continue };
                    if supported[j] || freeing[j] || matches!(structure.chunks[j].state, ChunkState::Free { .. }) {
                        continue;
                    }
                    supported[j] = true;
                    stack.push(j);
                }
            }
            for (i, c) in structure.chunks.iter().enumerate() {
                if c.state == ChunkState::Anchored && !supported[i] && !held(c, i, &freeing) {
                    freed.push(i);
                    freeing[i] = true;
                    to_wake.push(c.body);
                }
            }
            // 3. Their bonds break; each becomes an island.
            let mut broken = Vec::new();
            let mut promoted = Vec::new();
            for &i in &freed {
                let node = structure.chunks[i].node as usize;
                for &bond in structure.node_bonds.get(node).map(Vec::as_slice).unwrap_or(&[]) {
                    if structure.bonds[bond as usize].2 {
                        structure.bonds[bond as usize].2 = false;
                        broken.push(ids::bond_id(structure.id, bond));
                    }
                }
                let serial = structure.next_serial;
                structure.next_serial += 1;
                let chunk = &mut structure.chunks[i];
                chunk.state = ChunkState::Free { serial, settled: false, just_freed: true };
                let p = poses.get(chunk.body as usize).copied();
                promoted.push(IslandPromotion {
                    structure_id: structure.id,
                    island_id: serial,
                    chunks: vec![ids::chunk_id(structure.id, chunk.node)],
                    mass: chunk.mass,
                    center_of_mass: chunk.mass_center,
                    position: p.map_or(chunk.rest_position.to_array(), |p| p.position),
                    rotation: p.map_or(chunk.rest_rotation.to_array(), |p| p.rotation),
                    linear_velocity: p.map_or([0.0; 3], |p| p.linear_velocity),
                    angular_velocity: p.map_or([0.0; 3], |p| p.angular_velocity),
                    ..Default::default()
                });
            }
            self.stats.broken_bonds += broken.len() as u32;
            output.batches.push(FractureBatch {
                structure_id: structure.id,
                broken_bond_ids: broken,
                migrations: Vec::new(),
                promoted_islands: promoted,
                retired_island_ids: Vec::new(),
            });
        }
        if !to_wake.is_empty() {
            let mut w = self.world.lock().expect("rubble world poisoned");
            for body in to_wake {
                w.wake(body);
            }
        }
        // 4. Freed chunks: rows while awake, settle when rubble sleeps them.
        let mut rows = Vec::new();
        let (mut free, mut awake) = (0u32, 0u32);
        for structure in &mut self.structures {
            for chunk in &mut structure.chunks {
                let ChunkState::Free { serial, settled, just_freed } = &mut chunk.state else { continue };
                free += 1;
                let Some(p) = poses.get(chunk.body as usize) else { continue };
                if p.sleeping {
                    if !*settled {
                        *settled = true;
                        output.settled.push(SettleEvent {
                            structure_id: structure.id,
                            island_id: *serial,
                            position: p.position,
                            rotation: p.rotation,
                        });
                    }
                    *just_freed = false;
                    continue;
                }
                if *settled {
                    *settled = false;
                    output.wakes.push((structure.id, *serial));
                }
                awake += 1;
                rows.push(BodySnapshotInput {
                    body_entity: ids::body_entity(structure.id, *serial),
                    position: p.position,
                    rotation: p.rotation,
                    linear_velocity: p.linear_velocity,
                    angular_velocity: p.angular_velocity,
                    contacts: 0,
                    flags: if *just_freed { FLAG_WAKE_EVENT } else { 0 },
                });
                *just_freed = false;
            }
        }
        self.stats.chunk_bodies = free;
        self.stats.awake_chunk_bodies = awake;
        (output, rows)
    }

    pub fn stats(&self) -> DestructionStats {
        self.stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A free-standing 3-high column on one support chunk, bonded vertically.
    fn column() -> DestructionManifest {
        use vibe_land_destruction::manifest::{BondDef, ChunkDef, StructureManifest};
        let chunk = |node: u32, y: f32, support: bool| ChunkDef {
            node_index: node,
            centroid: [0.0, y, 0.0],
            mass: if support { 0.0 } else { 100.0 },
            volume: 1.0,
            size: [1.0; 3],
            geometry: ChunkGeometry::Cuboid { half_extents: [0.5; 3] },
            radius: 0.87,
            support,
            material: 0,
            mass_offset: [0.0; 3],
        };
        let bond = |i: u32, a: u32, b: u32, y: f32| BondDef {
            bond_index: i,
            node0: a,
            node1: b,
            centroid: [0.0, y, 0.0],
            normal: [0.0, 1.0, 0.0],
            area: 1.0,
            material: 0,
        };
        DestructionManifest {
            version: 1,
            structures: vec![StructureManifest {
                structure_id: 1,
                world_position: [0.0; 3],
                world_rotation: [0.0, 0.0, 0.0, 1.0],
                chunks: vec![chunk(0, 0.5, true), chunk(1, 1.5, false), chunk(2, 2.5, false), chunk(3, 3.5, false)],
                bonds: vec![bond(0, 0, 1, 1.0), bond(1, 1, 2, 2.0), bond(2, 2, 3, 3.0)],
            }],
            materials: Vec::new(),
            material_appearance: Vec::new(),
            shape_library: Vec::new(),
        }
    }

    fn world() -> Arc<Mutex<RubbleWorld>> {
        let mut w = RubbleWorld::new(vibe_land_rubble_bridge::WorldConfig::default()).expect("wgpu device");
        w.set_material(0, 0.5, 0.1);
        w.add_static_box([0.0, -1.0, 0.0], [0.0, 0.0, 0.0, 1.0], [50.0, 1.0, 50.0], 0);
        Arc::new(Mutex::new(w))
    }

    fn run(world: &Arc<Mutex<RubbleWorld>>, city: &mut RubbleCityDestruction, ticks: u32) -> (Vec<DestructionTickOutput>, usize) {
        let mut outputs = Vec::new();
        let mut rows = 0;
        for _ in 0..ticks {
            world.lock().unwrap().step().unwrap();
            let (out, r) = city.tick();
            rows += r.len();
            outputs.push(out);
        }
        (outputs, rows)
    }

    /// A reset parks the old city and builds a new one in the same world;
    /// rays (shots, meteor aiming) must find the new one.
    #[test]
    fn a_rebuilt_city_is_hit_by_rays() {
        let world = world();
        let mut city = RubbleCityDestruction::build(&column(), world.clone());
        world.lock().unwrap().step().unwrap();
        assert!(city.ray_hit([5.0, 1.5, 0.0], [-1.0, 0.0, 0.0], 20.0).is_some(), "first city not hit");
        city.release();
        let city = RubbleCityDestruction::build(&column(), world.clone());
        world.lock().unwrap().step().unwrap();
        let hit = city.ray_hit([5.0, 1.5, 0.0], [-1.0, 0.0, 0.0], 20.0);
        assert!(hit.is_some(), "the rebuilt city is invisible to rays");
    }

    /// Untouched, the column stands asleep: nothing freed, nothing streamed.
    #[test]
    fn an_untouched_column_stands_and_streams_nothing() {
        let world = world();
        let mut city = RubbleCityDestruction::build(&column(), world.clone());
        let (outputs, rows) = run(&world, &mut city, 120);
        assert!(outputs.iter().all(|o| o.batches.is_empty()), "something was freed");
        assert_eq!(rows, 0);
    }

    /// A ball through the middle chunk frees it; the chunk above loses its
    /// path to the support and is freed and falls; the support stays. Every
    /// bond touching a freed chunk is reported broken, and each freed chunk is
    /// promoted once as an island of its own at its centre of mass.
    #[test]
    fn a_hit_frees_the_chunk_and_what_it_held_up() {
        let world = world();
        let mut city = RubbleCityDestruction::build(&column(), world.clone());
        {
            let mut w = world.lock().unwrap();
            let ball = w.add_dynamic_sphere([4.0, 1.5, 0.0], 0.3, 200.0, 0);
            w.set_velocity(ball, [-30.0, 0.0, 0.0], [0.0; 3]);
        }
        let (outputs, rows) = run(&world, &mut city, 180);
        let promoted: Vec<&IslandPromotion> = outputs.iter().flat_map(|o| &o.batches).flat_map(|b| &b.promoted_islands).collect();
        let freed: std::collections::BTreeSet<u32> = promoted.iter().map(|p| ids::chunk_id_parts(p.chunks[0]).1).collect();
        assert!(freed.contains(&1), "the struck chunk was not freed: {freed:?}");
        assert!(freed.contains(&2) && freed.contains(&3), "what it held up was not freed: {freed:?}");
        assert!(!freed.contains(&0), "the support moved");
        assert_eq!(promoted.len(), freed.len(), "a chunk was promoted twice");
        let broken: usize = outputs.iter().flat_map(|o| &o.batches).map(|b| b.broken_bond_ids.len()).sum();
        assert_eq!(broken, 3, "every bond touching a freed chunk breaks once");
        assert!(rows > 0, "freed chunks streamed no rows");
        // The top chunk fell: it is no longer 3.5 m up.
        let top = city.structures[0].chunks[3].body;
        assert!(world.lock().unwrap().body(top).position[1] < 3.0, "the unsupported chunk did not fall");
    }
}
