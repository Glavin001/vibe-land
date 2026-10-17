//! What just broke, where, and how badly: destruction sources for sound and dust.
//!
//! A port of the web's source extraction (client/src/city/destructionEvents.ts) and impact
//! classifier (client/src/audio/motion.ts) onto the per-player stream's own fracture events. The
//! wire says which bonds broke; the manifest says where each bond is and how big it is. Breaks are
//! clustered per structure in 4 m cells into sources with a world position, a magnitude in the
//! web's dust units and the material of the largest bond; a chunk removed by a fracture (crushed to
//! dust) is a source of its whole mass; a body whose velocity drops sharply hit something.
//!
//! Not yet ported: the entry (first break of a shot), shed (a moving island's birth) and collapse
//! wave kinds, and bonds broken between two moving bodies are placed at their rest positions.
//! Positions are in server space.

use std::collections::HashMap;

use glam::{Quat, Vec3};
use vibe_land_destruction::manifest::DestructionManifest;

use crate::audio::{acoustic_material, physical_intensity, AcousticMaterial, SoundEvent, SoundKind};

/// Breaks closer than this are one source (destructionEvents.ts DEFAULT_DUST_EXTRACT_OPTIONS).
const CELL_SIZE_M: f32 = 4.0;
/// Largest sources kept per fracture.
const MAX_SOURCES_PER_FRACTURE: usize = 32;
/// Dust units per square metre of broken bond.
const FRACTURE_UNITS_PER_M2: f32 = 3.0;
/// A bond that broke without its chunks parting counts this much.
const UNSEPARATED_WEIGHT: f32 = 0.15;
/// Dust units per kilogram of crushed chunk.
const CRUSH_KG_PER_UNIT: f32 = 100.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Fracture,
    Crush,
    Impact,
}

/// One clustered destruction event (destructionEvents.ts `DustSource`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Source {
    pub kind: SourceKind,
    pub structure: u32,
    pub tick: u32,
    /// Rank within (structure, tick): with them, the deterministic seed root.
    pub ordinal: u32,
    pub position: Vec3,
    /// Outward face direction for a fracture (unit, or zero).
    pub normal: Vec3,
    /// The web's dust units (fracture: 3·Σarea; crush: mass/100; impact: mass·|Δv|²/2 / 5000).
    pub magnitude: f32,
    pub count: u32,
    /// Manifest material index of the largest contributor.
    pub material: u32,
    /// Perceptual impact intensity (impacts only; 0 otherwise).
    pub intensity: f32,
}

struct BondInfo {
    node0: u32,
    node1: u32,
    centroid: Vec3,
    normal: Vec3,
    area: f32,
    material: u32,
}

struct StructureInfo {
    bonds: HashMap<u32, BondInfo>,
    chunk_pos: HashMap<u32, Vec3>,
    chunk_mass: HashMap<u32, f32>,
    chunk_material: HashMap<u32, u32>,
}

/// The manifest facts the extractor needs, in world space at rest.
pub struct SourceTable {
    structures: HashMap<u32, StructureInfo>,
    /// Per manifest material: its acoustic material.
    acoustics: Vec<AcousticMaterial>,
}

impl SourceTable {
    pub fn new(manifest: &DestructionManifest) -> Self {
        let mut structures = HashMap::new();
        for s in &manifest.structures {
            let p = Vec3::from_array(s.world_position);
            let q = Quat::from_array(s.world_rotation).normalize();
            let world = |v: [f32; 3]| p + q * Vec3::from_array(v);
            let bonds = s
                .bonds
                .iter()
                .map(|b| {
                    (
                        b.bond_index,
                        BondInfo {
                            node0: b.node0,
                            node1: b.node1,
                            centroid: world(b.centroid),
                            normal: (q * Vec3::from_array(b.normal)).normalize_or_zero(),
                            area: b.area,
                            material: b.material,
                        },
                    )
                })
                .collect();
            structures.insert(
                s.structure_id,
                StructureInfo {
                    bonds,
                    chunk_pos: s.chunks.iter().map(|c| (c.node_index, world(c.centroid))).collect(),
                    chunk_mass: s.chunks.iter().map(|c| (c.node_index, c.mass)).collect(),
                    chunk_material: s.chunks.iter().map(|c| (c.node_index, c.material)).collect(),
                },
            );
        }
        let acoustics = manifest
            .material_appearance
            .iter()
            .map(|a| acoustic_material(a.name.as_deref().unwrap_or(""), a.metalness.unwrap_or(0.0)))
            .collect();
        Self { structures, acoustics }
    }

    pub fn acoustic(&self, material: u32) -> AcousticMaterial {
        self.acoustics.get(material as usize).copied().unwrap_or(AcousticMaterial::Concrete)
    }

    /// The sources of one fracture: broken bonds clustered per 4 m cell (weighted by area, a bond
    /// whose chunks did not part at 15%), and each removed chunk as a crush source of its mass.
    /// `parted(a, b)` says whether two chunks of `structure` now ride different bodies.
    pub fn fracture_sources(
        &self,
        structure: u32,
        tick: u32,
        broken_bonds: &[u32],
        removed_chunks: &[u32],
        parted: impl Fn(u32, u32) -> bool,
        out: &mut Vec<Source>,
    ) {
        let Some(s) = self.structures.get(&structure) else { return };
        // (kind, cell) -> accumulator: Σw·pos, Σw, Σnormal, magnitude, count, (largest w, material)
        struct Acc {
            wpos: Vec3,
            w: f32,
            normal: Vec3,
            magnitude: f32,
            count: u32,
            largest: f32,
            material: u32,
        }
        let mut cells: HashMap<(u8, i32, i32, i32), Acc> = HashMap::new();
        let mut add = |kind: u8, pos: Vec3, w: f32, normal: Vec3, magnitude: f32, material: u32| {
            let key = (
                kind,
                (pos.x / CELL_SIZE_M).floor() as i32,
                (pos.y / CELL_SIZE_M).floor() as i32,
                (pos.z / CELL_SIZE_M).floor() as i32,
            );
            let a = cells.entry(key).or_insert(Acc { wpos: Vec3::ZERO, w: 0.0, normal: Vec3::ZERO, magnitude: 0.0, count: 0, largest: 0.0, material: 0 });
            a.wpos += pos * w;
            a.w += w;
            a.normal += normal;
            a.magnitude += magnitude;
            a.count += 1;
            if w > a.largest {
                a.largest = w;
                a.material = material;
            }
        };
        for bond in broken_bonds {
            let Some(b) = s.bonds.get(bond) else { continue };
            let w = b.area * if parted(b.node0, b.node1) { 1.0 } else { UNSEPARATED_WEIGHT };
            add(0, b.centroid, w, b.normal, w * FRACTURE_UNITS_PER_M2, b.material);
        }
        for chunk in removed_chunks {
            let (Some(&pos), Some(&mass)) = (s.chunk_pos.get(chunk), s.chunk_mass.get(chunk)) else { continue };
            let material = s.chunk_material.get(chunk).copied().unwrap_or(0);
            add(1, pos, mass, Vec3::ZERO, mass / CRUSH_KG_PER_UNIT, material);
        }
        // Ordinals by cell key (stable for a given fracture), then the largest kept.
        let mut keyed: Vec<_> = cells.into_iter().collect();
        keyed.sort_by_key(|(k, _)| *k);
        let mut sources: Vec<Source> = keyed
            .into_iter()
            .enumerate()
            .filter(|(_, (_, a))| a.w > 0.0)
            .map(|(ordinal, ((kind, ..), a))| Source {
                kind: if kind == 0 { SourceKind::Fracture } else { SourceKind::Crush },
                structure,
                tick,
                ordinal: ordinal as u32,
                position: a.wpos / a.w,
                normal: a.normal.normalize_or_zero(),
                magnitude: a.magnitude,
                count: a.count,
                material: a.material,
                intensity: 0.0,
            })
            .collect();
        sources.sort_by(|a, b| b.magnitude.total_cmp(&a.magnitude));
        sources.truncate(MAX_SOURCES_PER_FRACTURE);
        out.extend(sources);
    }

    /// Mass of a set of chunks of `structure`, kg.
    pub fn mass_of(&self, structure: u32, chunks: &[u32]) -> f32 {
        self.structures.get(&structure).map_or(0.0, |s| chunks.iter().filter_map(|c| s.chunk_mass.get(c)).sum())
    }

    /// Manifest material of a chunk.
    pub fn material_of(&self, structure: u32, chunk: u32) -> u32 {
        self.structures.get(&structure).and_then(|s| s.chunk_material.get(&chunk)).copied().unwrap_or(0)
    }
}

/// One body sample for the impact classifier.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionSample {
    pub position: Vec3,
    pub velocity: Vec3,
    pub time_ms: f64,
    pub mass: f32,
}

/// `classifyMotionImpact` (motion.ts): a sudden velocity drop (gravity removed) is a hit; returns
/// (energy J, perceptual intensity).
pub fn classify_motion_impact(previous: &MotionSample, current: &MotionSample) -> Option<(f32, f32)> {
    if current.mass <= 0.0 || !current.mass.is_finite() {
        return None;
    }
    let dt = ((current.time_ms - previous.time_ms) / 1000.0) as f32;
    if !dt.is_finite() || dt <= 0.0 || dt > 0.25 {
        return None;
    }
    if !(previous.position.is_finite() && current.position.is_finite() && previous.velocity.is_finite() && current.velocity.is_finite()) {
        return None;
    }
    let (before, after) = (previous.velocity.length(), current.velocity.length());
    let heavy = current.mass >= 250.0;
    if before < if heavy { 1.5 } else { 3.0 } || after >= before * 0.85 {
        return None;
    }
    if previous.position.distance(current.position) > before.max(after) * dt * 1.8 + 2.0 {
        return None;
    }
    let dv = current.velocity - previous.velocity;
    let delta = Vec3::new(dv.x, dv.y + 9.81 * dt, dv.z).length();
    let raw = dv.length();
    if delta.min(raw) < (if heavy { 1.2f32 } else { 3.0 }).max((if heavy { 10.0f32 } else { 20.0 }) * dt) {
        return None;
    }
    let lost = before * before - after * after;
    Some((0.5 * current.mass * lost, physical_intensity(current.mass * lost.sqrt(), current.mass)))
}

/// `soundFromDestruction` (gameEvents.ts): a fracture or crush source as a sound.
pub fn sound_from_source(source: &Source, material: AcousticMaterial, at_ms: f64) -> Option<SoundEvent> {
    let kind = match source.kind {
        SourceKind::Impact => SoundKind::Impact,
        SourceKind::Fracture | SourceKind::Crush => SoundKind::Fracture,
    };
    let magnitude = source.magnitude.max(0.0);
    let (intensity, size) = if source.kind == SourceKind::Impact {
        (source.intensity.clamp(0.0, 1.0), (magnitude.cbrt()).max(0.1))
    } else {
        // Fracture magnitude is three times broken bond area; not mass or impulse.
        ((0.12 + 0.86 * (1.0 - (-magnitude.sqrt() / 2.5).exp())).clamp(0.08, 0.98), magnitude.cbrt().max(0.2))
    };
    let seed = (source.tick.wrapping_mul(997)) ^ (source.structure.wrapping_mul(65537)) ^ source.ordinal;
    Some(SoundEvent {
        id: (u64::from(source.structure) << 40) ^ (u64::from(source.tick) << 8) ^ u64::from(source.ordinal) ^ ((source.kind as u64) << 60),
        kind,
        position: source.position,
        material,
        intensity,
        size,
        seed,
        at_ms,
        protected: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> SourceTable {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../destruction/assets/scenes/house-1story.json");
        let pack = vibe_land_destruction::scene_pack::load_scene_pack_file(&path).unwrap();
        let desc = vibe_land_destruction::city::CitySceneDesc { grid: 1, ..Default::default() };
        let manifest = DestructionManifest::from_city(&vibe_land_destruction::city::build_city_scene(&pack, desc).unwrap());
        SourceTable::new(&manifest)
    }

    #[test]
    fn broken_bonds_cluster_by_cell_with_area_magnitude() {
        let t = table();
        let (&structure, s) = t.structures.iter().next().unwrap();
        // Two bonds near each other and one far away.
        let mut bonds: Vec<(&u32, &BondInfo)> = s.bonds.iter().collect();
        bonds.sort_by_key(|(k, _)| **k);
        let first = bonds[0].1.centroid;
        let near: Vec<u32> = bonds.iter().filter(|(_, b)| b.centroid.distance(first) < 0.5).map(|(k, _)| **k).take(2).collect();
        let far = bonds.iter().max_by(|a, b| a.1.centroid.distance(first).total_cmp(&b.1.centroid.distance(first))).map(|(k, _)| **k).unwrap();
        let mut broken = near.clone();
        broken.push(far);
        let mut out = Vec::new();
        t.fracture_sources(structure, 10, &broken, &[], |_, _| true, &mut out);
        assert!(out.len() >= 2, "the far bond is its own source");
        let total: f32 = out.iter().map(|s| s.magnitude).sum();
        let area: f32 = broken.iter().map(|b| s.bonds[b].area).sum();
        assert!((total - 3.0 * area).abs() < 1e-3 * total.max(1.0), "magnitude = 3·Σarea");
        // Unparted bonds count 15%.
        let mut unparted = Vec::new();
        t.fracture_sources(structure, 10, &broken, &[], |_, _| false, &mut unparted);
        let total_u: f32 = unparted.iter().map(|s| s.magnitude).sum();
        assert!((total_u - 0.15 * total).abs() < 1e-3 * total.max(1.0));
    }

    #[test]
    fn crushed_chunks_are_sources_of_their_mass() {
        let t = table();
        let (&structure, s) = t.structures.iter().next().unwrap();
        let (&chunk, &mass) = s.chunk_mass.iter().next().unwrap();
        let mut out = Vec::new();
        t.fracture_sources(structure, 3, &[], &[chunk], |_, _| true, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, SourceKind::Crush);
        assert!((out[0].magnitude - mass / 100.0).abs() < 1e-3);
    }

    #[test]
    fn impacts_need_a_sudden_drop_not_a_ballistic_arc() {
        let at = |t: f64, v: Vec3| MotionSample { position: Vec3::ZERO, velocity: v, time_ms: t, mass: 500.0 };
        // Falling 8 m/s, stopped in one tick: a hit.
        let hit = classify_motion_impact(&at(0.0, Vec3::new(0.0, -8.0, 0.0)), &at(16.7, Vec3::ZERO));
        assert!(hit.is_some_and(|(e, i)| e > 15000.0 && i > 0.5));
        // Free fall over one tick (gravity only): not a hit.
        assert!(classify_motion_impact(&at(0.0, Vec3::new(0.0, -8.0, 0.0)), &at(16.7, Vec3::new(0.0, -8.164, 0.0))).is_none());
        // Slow drift slowing down: not a hit.
        assert!(classify_motion_impact(&at(0.0, Vec3::new(1.0, 0.0, 0.0)), &at(16.7, Vec3::ZERO)).is_none());
    }
}
