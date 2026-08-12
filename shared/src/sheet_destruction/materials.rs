//! Static per-material parameter table for thin sheets.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SheetMaterialId {
    Drywall,
    Wood,
    Plaster,
}

impl SheetMaterialId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drywall => "drywall",
            Self::Wood => "wood",
            Self::Plaster => "plaster",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "drywall" => Some(Self::Drywall),
            "wood" => Some(Self::Wood),
            "plaster" => Some(Self::Plaster),
            _ => None,
        }
    }
}

pub const SHEET_MATERIAL_IDS: &[&str] = &["drywall", "wood", "plaster"];

#[derive(Clone, Copy, Debug)]
pub struct SheetMaterial {
    pub id: SheetMaterialId,
    pub cell_size: f32,
    /// Impulse (N·s) per cell required to carve an intact cell.
    pub break_flux: f32,
    pub break_flux_reinforced: f32,
    /// Below this, impact has no effect (elastic).
    pub damage_flux_min: f32,
    pub damage_to_break_ratio: f32,
    pub dilation_factor: f32,
    pub noise_amplitude: f32,
    pub noise_frequency: f32,
    pub anisotropy: f32,
    pub grain_dir: [f32; 2],
    pub seam_snap_dist: f32,
    pub penetration_cost_per_meter: f32,
    pub thickness: f32,
    pub max_dent_depth: f32,
    pub dent_flux_to_depth: f32,
    pub min_island_area: f32,
    pub island_density: f32,
}

const DRYWALL: SheetMaterial = SheetMaterial {
    id: SheetMaterialId::Drywall,
    // 2 cm cells: enough for ragged MS hole edges without meshing cost blowups.
    cell_size: 0.02,
    // Calibrated so a 10 g rifle round at ~720 m/s carves a multi-cell hole.
    break_flux: 1.0,
    break_flux_reinforced: 20.0,
    damage_flux_min: 0.2,
    damage_to_break_ratio: 40.0,
    // Play-distance readability: ~12 cm diameter ragged holes from a 6 mm round.
    dilation_factor: 10.0,
    noise_amplitude: 0.45,
    noise_frequency: 10.0,
    anisotropy: 0.1,
    grain_dir: [1.0, 0.0],
    seam_snap_dist: 0.0,
    penetration_cost_per_meter: 8.0,
    thickness: 0.012,
    max_dent_depth: 0.008,
    dent_flux_to_depth: 12.0,
    min_island_area: 0.08,
    island_density: 12.0,
};

const WOOD: SheetMaterial = SheetMaterial {
    id: SheetMaterialId::Wood,
    cell_size: 0.02,
    break_flux: 2.8,
    break_flux_reinforced: 40.0,
    damage_flux_min: 0.6,
    damage_to_break_ratio: 30.0,
    dilation_factor: 6.0,
    noise_amplitude: 0.5,
    noise_frequency: 25.0,
    anisotropy: 0.8,
    grain_dir: [1.0, 0.0],
    seam_snap_dist: 0.04,
    penetration_cost_per_meter: 40.0,
    thickness: 0.02,
    max_dent_depth: 0.006,
    dent_flux_to_depth: 8.0,
    min_island_area: 0.06,
    island_density: 18.0,
};

const PLASTER: SheetMaterial = SheetMaterial {
    id: SheetMaterialId::Plaster,
    cell_size: 0.02,
    break_flux: 1.8,
    break_flux_reinforced: 25.0,
    damage_flux_min: 0.35,
    damage_to_break_ratio: 50.0,
    dilation_factor: 7.0,
    noise_amplitude: 0.3,
    noise_frequency: 12.0,
    anisotropy: 0.15,
    grain_dir: [1.0, 0.0],
    seam_snap_dist: 0.0,
    penetration_cost_per_meter: 15.0,
    thickness: 0.015,
    max_dent_depth: 0.01,
    dent_flux_to_depth: 16.0,
    min_island_area: 0.07,
    island_density: 14.0,
};

pub fn lookup_sheet_material(id: SheetMaterialId) -> &'static SheetMaterial {
    match id {
        SheetMaterialId::Drywall => &DRYWALL,
        SheetMaterialId::Wood => &WOOD,
        SheetMaterialId::Plaster => &PLASTER,
    }
}

pub fn is_sheet_material(name: &str) -> bool {
    SheetMaterialId::parse(name).is_some()
}

/// Default rifle bullet parameters used when constructing flux from hitscan.
pub const RIFLE_BULLET_MASS_KG: f32 = 0.01;
pub const RIFLE_BULLET_SPEED_MPS: f32 = 720.0;
pub const RIFLE_BULLET_RADIUS_M: f32 = 0.006;
