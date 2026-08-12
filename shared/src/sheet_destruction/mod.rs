//! Carve-based destructible thin-sheet materials (drywall, wood, plaster).
//!
//! Destruction is a pure deterministic function of replicated carve events.
//! No geometry is synced — every peer rebuilds meshes from the same mask.

pub mod carve;
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
pub use demo_huts::append_destructible_demo_huts;
pub use materials::{
    is_sheet_material, lookup_sheet_material, SheetMaterial, SheetMaterialId, SHEET_MATERIAL_IDS,
    RIFLE_BULLET_MASS_KG, RIFLE_BULLET_RADIUS_M, RIFLE_BULLET_SPEED_MPS,
};
pub use mask::SheetMask;
pub use registry::{SheetInstance, SheetRegistry, SheetUvFrame};
pub use remesh::{remesh_sheet, SheetMesh};
pub use stamp::generate_stamp_mask;
