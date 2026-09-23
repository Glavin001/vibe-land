//! What every PhysX-backed backend (Blast and native) shares: collision
//! groups, the error type, and the manifest-to-bridge conversions.
//!
//! Pure Rust over the bridge's plain types, so it needs no Blast code.

use vibe_land_physx_bridge::{ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, Pose, Quat, Vec3};
use vibe_netcode::destruction_backend::StressSolverSettings;

use crate::manifest::{ChunkGeometry, DestructionManifest};

pub const GROUP_CHUNK: u32 = 1 << 5;
pub const GROUP_STATIC: u32 = 1 << 0;
pub const GROUP_DYNAMIC: u32 = 1 << 1;
pub const GROUP_PLAYER: u32 = 1 << 2;
pub const GROUP_VEHICLE: u32 = 1 << 3;
pub const GROUP_BATTERY: u32 = 1 << 4;

pub const CHUNK_COLLISION_MASK: u32 =
    GROUP_STATIC | GROUP_DYNAMIC | GROUP_PLAYER | GROUP_VEHICLE | GROUP_BATTERY | GROUP_CHUNK;

#[derive(Debug)]
pub enum CityDestructionError {
    Bridge(String),
    Degraded,
}

impl std::fmt::Display for CityDestructionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bridge(message) => write!(f, "physx destruction bridge: {message}"),
            Self::Degraded => write!(f, "city destruction degraded"),
        }
    }
}

impl std::error::Error for CityDestructionError {}

/// One structure's authored pose, chunks and bonds, as the bridge takes them.
///
/// Shared by every PhysX-backed backend so they all install the *same* asset
/// from the same manifest: a second copy of this conversion is a second place
/// for geometry to drift, and a backend comparison is only meaningful when both
/// are handed identical inputs.
pub(crate) fn authored_structure(
    manifest: &DestructionManifest,
    structure: &crate::manifest::StructureManifest,
) -> (Pose, Vec<ChunkNodeDesc>, Vec<ChunkBondDesc>) {
    let nodes: Vec<ChunkNodeDesc> = structure
        .chunks
        .iter()
        .map(|chunk| {
            let (geom_kind, half_extents, convex_points) = match &chunk.geometry {
                ChunkGeometry::Cuboid { half_extents } => (
                    0,
                    Vec3::new(half_extents[0], half_extents[1], half_extents[2]),
                    Vec::new(),
                ),
                ChunkGeometry::ConvexHull { .. } => {
                    let points = manifest.hull_points(&chunk.geometry);
                    // Duplicate positions only -- authored point buffers often
                    // repeat corners per face, and the repeats are
                    // byte-identical. This is lossless; the shape is untouched.
                    //
                    // NO geometric thinning happens here. An earlier version
                    // strided every Nth point to fit the GPU's 64-vertex hull
                    // cap, silently deforming colliders away from the rendered
                    // geometry. The cap is enforced where it belongs: the
                    // PhysX cooker's own vertex limit, which computes the
                    // optimal bounded hull when an asset exceeds it.
                    let mut seen = std::collections::HashSet::new();
                    let pts: Vec<Vec3> = points
                        .chunks_exact(3)
                        .filter(|p| seen.insert([p[0].to_bits(), p[1].to_bits(), p[2].to_bits()]))
                        .map(|p| Vec3::new(p[0], p[1], p[2]))
                        .collect();
                    (1, Vec3::new(0.5, 0.5, 0.5), pts)
                }
            };
            ChunkNodeDesc {
                node_index: chunk.node_index,
                centroid: Vec3::new(chunk.centroid[0], chunk.centroid[1], chunk.centroid[2]),
                mass: chunk.mass,
                volume: chunk.volume,
                geom_kind,
                half_extents,
                convex_points,
            }
        })
        .collect();
    let bonds: Vec<ChunkBondDesc> = structure
        .bonds
        .iter()
        .map(|bond| ChunkBondDesc {
            bond_index: bond.bond_index,
            node0: bond.node0,
            node1: bond.node1,
            centroid: Vec3::new(bond.centroid[0], bond.centroid[1], bond.centroid[2]),
            normal: Vec3::new(bond.normal[0], bond.normal[1], bond.normal[2]),
            area: bond.area,
            material: bond.material,
        })
        .collect();
    let pose = Pose {
        position: Vec3::new(
            structure.world_position[0],
            structure.world_position[1],
            structure.world_position[2],
        ),
        rotation: Quat {
            x: structure.world_rotation[0],
            y: structure.world_rotation[1],
            z: structure.world_rotation[2],
            w: structure.world_rotation[3],
        },
    };
    (pose, nodes, bonds)
}

/// The bridge's view of the solver settings.
///
/// Shared with the native backend so both are configured from the same
/// authored table -- a comparison between backends means nothing if their
/// material limits arrive by different routes.
pub(crate) fn ffi_settings(settings: &StressSolverSettings) -> DestructibleSettings {
    DestructibleSettings {
        max_solver_iterations_per_frame: settings.max_solver_iterations_per_frame,
        graph_reduction_level: settings.graph_reduction_level,
        materials: settings
            .materials
            .iter()
            .map(|material| vibe_land_physx_bridge::StressMaterialDesc {
                compression_elastic: material.compression_elastic_mpa,
                compression_fatal: material.compression_fatal_mpa,
                tension_elastic: material.tension_elastic_mpa,
                tension_fatal: material.tension_fatal_mpa,
                shear_elastic: material.shear_elastic_mpa,
                shear_fatal: material.shear_fatal_mpa,
                elastic_modulus: material.elastic_modulus_pa,
                residual_area_fraction: material.residual_area_fraction,
            })
            .collect(),
        maximum_bodies: settings.maximum_bodies,
        maximum_fractures_per_actor_per_tick: settings.maximum_fractures_per_actor_per_tick,
        apply_excess_forces: settings.apply_excess_forces,
        apply_centrifugal: settings.apply_centrifugal,
        excess_force_scale: settings.excess_force_scale,
        linear_damping: settings.linear_damping,
        angular_damping: settings.angular_damping,
    }
}
