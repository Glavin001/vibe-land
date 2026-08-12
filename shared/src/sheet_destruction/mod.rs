//! Carve-based destructible thin-sheet materials (drywall, wood, plaster).
//!
//! Destruction is a pure deterministic function of replicated carve events.
//! No geometry is synced — every peer rebuilds meshes from the same mask.

pub mod carve;
pub mod coarse_collision;
pub mod demo_huts;
pub mod islands;
pub mod materials;
pub mod mask;
pub mod registry;
pub mod remesh;
pub mod stamp;

pub use carve::{
    apply_carve, carve_event_from_packet, carve_event_to_packet, encode_carve_event_packet,
    quantize_uv, CarveApplyResult, CarveEvent,
};
pub use coarse_collision::{
    build_greedy_collision_cuboids, compute_collision_snapshot, sheet_coarse_collision_enabled,
    should_rebuild_collision, take_collision_rebuild, CoarseCollisionSnapshot, OrientedWorldCuboid,
    COARSE_CELL_M, USEFULNESS_REBUILD_ALPHA,
};
pub use demo_huts::append_destructible_demo_huts;
pub use islands::{cull_dual_skin_islands, cull_sheet_islands};
pub use materials::{
    is_sheet_material, lookup_sheet_material, SheetMaterial, SheetMaterialId, SHEET_MATERIAL_IDS,
    RIFLE_BULLET_MASS_KG, RIFLE_BULLET_RADIUS_M, RIFLE_BULLET_SPEED_MPS,
};
pub use mask::SheetMask;
pub use registry::{SheetInstance, SheetRegistry, SheetUvFrame};
pub use remesh::{remesh_sheet, remesh_sheet_skins, SheetMesh};
pub use stamp::generate_stamp_mask;
