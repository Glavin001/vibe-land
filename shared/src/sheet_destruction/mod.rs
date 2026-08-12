//! Carve-based destructible thin-sheet materials (drywall, wood, plaster).
//!
//! Destruction is a pure deterministic function of replicated carve events.
//! No geometry is synced — every peer rebuilds meshes from the same mask.

pub mod carve;
pub mod coarse_collision;
pub mod demo_huts;
pub mod falling_debris;
pub mod islands;
pub mod materials;
pub mod mask;
pub mod momentum_carve;
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
pub use falling_debris::{
    debris_spawns_from_islands, dropped_island_world_cuboid, is_debris_worthy,
    sheet_falling_debris_enabled, DEBRIS_MAX_CONCURRENT, DEBRIS_MIN_AREA_M2, DEBRIS_SPAWN_NUDGE_M,
    DEBRIS_TTL_SEC, SHEET_FALLING_DEBRIS,
};
pub use islands::{cull_dual_skin_islands, cull_sheet_islands, DroppedIsland};
pub use momentum_carve::{
    apply_soft_sheet_drag, finalize_soft_sheet_impacts, impact_to_carve_event,
    is_sheet_soft_collider, local_sheet_solid_fraction, sample_tunnel_sheet_impacts,
    sheet_collider_index, sheet_id_from_user_data, sheet_momentum_carve_enabled,
    tag_sheet_soft_user_data, MomentumCarveCooldown, MomentumSheetImpact,
    MomentumStrikerKind, SoftSheetDragSample, SoftSheetHook, SoftSheetStepCollector,
    StrikerRef, TerrainAndSoftSheetHook, MOMENTUM_CARVE_MAX_PER_TICK,
    SHEET_MOMENTUM_CARVE, SHEET_SOFT_ACTIVE_HOOKS, SHEET_SOFT_USER_DATA_FLAG,
    SOFT_SHEET_DRAG_K, SOFT_SHEET_DRAG_MAX_SPEED_FRAC, VEHICLE_CARVE_EFF_MASS_KG,
    VEHICLE_CARVE_FOOTPRINT_M, VEHICLE_CARVE_MIN_SPEED_MPS,
};
pub use materials::{
    is_sheet_material, lookup_sheet_material, SheetMaterial, SheetMaterialId, SHEET_MATERIAL_IDS,
    RIFLE_BULLET_MASS_KG, RIFLE_BULLET_RADIUS_M, RIFLE_BULLET_SPEED_MPS,
};
pub use mask::SheetMask;
pub use registry::{SheetInstance, SheetRegistry, SheetUvFrame};
pub use remesh::{remesh_sheet, remesh_sheet_skins, SheetMesh};
pub use stamp::generate_stamp_mask;
