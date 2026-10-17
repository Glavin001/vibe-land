//! `/city` on rubble: the destructible city's structures as rubble bodies.
//!
//! Each structure is one rubble body made of its chunks' shapes, anchored to
//! the ground (static): the architecture's "intact structure = one rigid body
//! of many chunk shapes", with chunks never joined by constraints. Fired balls
//! and meteors are rubble bodies in the same world, so they strike the real
//! chunk colliders.
//!
//! rubble's stress solver is not in vibe-land yet, so nothing decides fracture
//! and every structure holds -- which AGENTS.md defines as correct behaviour
//! when the solver breaks nothing. The stream sees an anchored structure only
//! (no body rows, an empty `DestructionTickOutput`). When the solver lands it
//! plugs in here: loads in (gravity and `RubbleWorld` contact impulses), broken
//! bonds out, and this module splits the compound into new bodies.

use std::sync::{Arc, Mutex};

use vibe_land_destruction::manifest::{ChunkGeometry, DestructionManifest};
use vibe_land_rubble_bridge::{BodyId, BoxPart, RubbleWorld};
use vibe_netcode::destruction_backend::{DestructionStats, DestructionTickOutput};

/// Where a released structure is parked: rubble bodies are append-only.
const PARKED_Y: f32 = -20_000.0;

pub struct RubbleCityDestruction {
    world: Arc<Mutex<RubbleWorld>>,
    /// (structure id, its rubble body).
    structures: Vec<(u32, BodyId)>,
    /// Chunks rubble could not represent yet (convex-hull chunks), left out.
    skipped_chunks: usize,
}

impl RubbleCityDestruction {
    pub fn build(manifest: &DestructionManifest, world: Arc<Mutex<RubbleWorld>>) -> Self {
        let mut structures = Vec::with_capacity(manifest.structures.len());
        let mut skipped_chunks = 0;
        {
            let mut w = world.lock().expect("rubble world poisoned");
            for structure in &manifest.structures {
                let parts: Vec<BoxPart> = structure
                    .chunks
                    .iter()
                    .filter_map(|chunk| match &chunk.geometry {
                        ChunkGeometry::Cuboid { half_extents } => Some(BoxPart {
                            center: chunk.centroid,
                            rotation: [0.0, 0.0, 0.0, 1.0],
                            half_extents: *half_extents,
                        }),
                        ChunkGeometry::ConvexHull { .. } => {
                            skipped_chunks += 1;
                            None
                        }
                    })
                    .collect();
                let body = w.add_static_compound(structure.world_position, structure.world_rotation, &parts, 0);
                structures.push((structure.structure_id, body));
            }
        }
        if skipped_chunks > 0 {
            tracing::warn!(
                skipped_chunks,
                "rubble city: convex-hull chunks are not built yet (the bridge has box compounds only)"
            );
        }
        Self { world, structures, skipped_chunks }
    }

    pub fn world(&self) -> Arc<Mutex<RubbleWorld>> {
        self.world.clone()
    }

    pub fn structure_bodies(&self) -> &[(u32, BodyId)] {
        &self.structures
    }

    pub fn skipped_chunks(&self) -> usize {
        self.skipped_chunks
    }

    /// Take this city's bodies out of the world (first half of a reset).
    pub fn release(&mut self) {
        let mut w = self.world.lock().expect("rubble world poisoned");
        for &(_, body) in &self.structures {
            w.park(body, [0.0, PARKED_Y, 0.0]);
        }
        self.structures.clear();
    }

    /// The structure a ray strikes first, if it strikes one: `(structure id,
    /// distance, point)`.
    pub fn ray_hit(&self, origin: [f32; 3], direction: [f32; 3], max_distance: f32) -> Option<(u32, f32, [f32; 3])> {
        let hit = self.world.lock().expect("rubble world poisoned").raycast(&[(origin, direction, max_distance, None)])[0]?;
        let &(structure, _) = self.structures.iter().find(|(_, body)| *body == hit.body)?;
        Some((structure, hit.distance, hit.point))
    }

    /// No stress solver yet: nothing fractures this tick.
    pub fn tick(&mut self) -> DestructionTickOutput {
        DestructionTickOutput::default()
    }

    pub fn stats(&self) -> DestructionStats {
        DestructionStats::default()
    }
}
