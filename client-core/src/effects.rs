//! What just broke, where, and how badly: destruction sources for sound and dust.
//!
//! A port of the web's source extraction (client/src/city/destructionEvents.ts) and impact
//! classifier (client/src/audio/motion.ts) onto the per-player stream's own fracture events. The
//! wire says which bonds broke; the manifest says where each bond is and how big it is. Breaks are
//! clustered per structure in 4 m cells into sources with a world position, a magnitude in the
//! web's dust units and the material of the largest bond; a chunk removed by a fracture (crushed to
//! dust) is a source of its whole mass; a body whose velocity drops sharply hit something.
//!
//! Also as the web: the first break in a quiet cell along a recent shot is that shot's entry (spall
//! toward the shooter, twice the dust), a heavy island born in a fracture sheds dust of its own, and
//! many heavy impacts in one place within half a second raise a collapse wave. One approximation:
//! the per-player stream carries no velocity at an island's birth, so shedding goes by mass alone
//! (the web also sheds a light island moving faster than 1 m/s). Bonds broken between two moving
//! bodies are placed at their rest positions. Positions are in server space.

use std::collections::HashMap;

use glam::{Quat, Vec3};
use vibe_land_destruction::manifest::DestructionManifest;

use crate::audio::{
    acoustic_material, physical_intensity, AcousticMaterial, SoundEvent, SoundKind,
};

/// Unauthored materials' dust: the catalog's concrete wall (#8d8a86).
const CONCRETE_RGBA: u32 = 0x8d8a_86ff;
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
    /// The first break of a shot (destructionEvents.ts KIND_ENTRY).
    Entry,
    /// A heavy island born in a fracture (KIND_SHED).
    Shed,
    /// Many impacts in one place at once: a collapse front (dustImpacts.ts noteWave).
    Wave,
}

/// A cell with no fracture for this long is quiet; the next break there may be an entry.
const ENTRY_QUIET_MS: f64 = 1000.0;
/// An island at least this heavy sheds dust of its own (DEFAULT_DUST_EXTRACT_OPTIONS.minShedMassKg).
const MIN_SHED_MASS_KG: f32 = 5000.0;
/// Dust units per kilogram of shed island.
const SHED_KG_PER_UNIT: f32 = 500.0;
/// Collapse waves (dustImpacts.ts DEFAULT_DUST_IMPACT_OPTIONS).
const WAVE_CELL_M: f32 = 8.0;
const WAVE_WINDOW_MS: f64 = 500.0;
const WAVE_IMPULSE: f32 = 100_000.0;
const WAVE_COOLDOWN_MS: f64 = 2000.0;
const IMPULSE_PER_UNIT: f32 = 4000.0;
/// Shots remembered for entry matching (vfx/dustShots.ts).
const SHOT_TTL_MS: f64 = 5000.0;
const SHOT_MAX_USES: u32 = 3;
const SHOT_CORRIDOR_M: f32 = 5.0;
const SHOT_END_M: f32 = 6.0;
const MAX_SHOTS: usize = 32;

/// A shot remembered so the break it makes can be recognised (vfx/dustShots.ts `DustShot`).
#[derive(Clone, Copy, Debug)]
struct DustShot {
    origin: Vec3,
    dir: Vec3,
    end: Option<Vec3>,
    at_ms: f64,
    uses: u32,
}

/// Recent shots, oldest first.
#[derive(Default)]
pub struct ShotMemory {
    shots: Vec<DustShot>,
}

impl ShotMemory {
    /// A shot from `origin` along `dir`, ending at `end` when the server resolved it (hitscan).
    pub fn register(&mut self, origin: Vec3, dir: Vec3, end: Option<Vec3>, at_ms: f64) {
        let dir = dir.normalize_or_zero();
        if dir == Vec3::ZERO && end.is_none() {
            return;
        }
        self.shots.push(DustShot {
            origin,
            dir,
            end,
            at_ms,
            uses: 0,
        });
        if self.shots.len() > MAX_SHOTS {
            self.shots.remove(0);
        }
    }

    /// `matchDustShot`: the newest shot whose end or corridor (sagging for a thrown ball) passes
    /// `p`, used at most three times.
    fn match_shot(&mut self, p: Vec3, now_ms: f64) -> Option<Vec3> {
        self.shots.retain(|s| now_ms - s.at_ms <= SHOT_TTL_MS);
        for s in self.shots.iter_mut().rev() {
            if s.uses >= SHOT_MAX_USES {
                continue;
            }
            if let Some(end) = s.end {
                if p.distance(end) <= SHOT_END_M {
                    s.uses += 1;
                    return Some(s.origin);
                }
            }
            let t = (p - s.origin).dot(s.dir);
            if t < 0.0 {
                continue;
            }
            let sag = if s.end.is_none() {
                (0.5 * (t / 20.0) * (t / 20.0) * 9.81).min(12.0)
            } else {
                0.0
            };
            let c = s.origin + s.dir * t - Vec3::Y * (sag * 0.5);
            if p.distance(c) <= SHOT_CORRIDOR_M + sag * 0.5 {
                s.uses += 1;
                return Some(s.origin);
            }
        }
        None
    }
}

struct WaveCell {
    impulse: f32,
    since: f64,
    lowest_y: f32,
    x: f32,
    z: f32,
    count: u32,
    last_wave_ms: f64,
}

/// The per-session memory source extraction keeps: quiet cells for entries, shots, wave cells.
#[derive(Default)]
pub struct SourceState {
    quiet: HashMap<(u32, i32, i32, i32), f64>,
    pub shots: ShotMemory,
    waves: HashMap<(i32, i32), WaveCell>,
    wave_ordinal: u32,
}

impl SourceState {
    /// `noteWave`: an impact of `impulse` (N·s) at `p`; a collapse wave once a cell's impacts in
    /// half a second sum past 100 000 N·s (at most every 2 s per cell).
    pub fn note_impact(
        &mut self,
        structure: u32,
        tick: u32,
        p: Vec3,
        impulse: f32,
        at_ms: f64,
        out: &mut Vec<Source>,
    ) {
        let key = (
            (p.x / WAVE_CELL_M).floor() as i32,
            (p.z / WAVE_CELL_M).floor() as i32,
        );
        let cell = self.waves.entry(key).or_insert(WaveCell {
            impulse: 0.0,
            since: at_ms,
            lowest_y: f32::INFINITY,
            x: 0.0,
            z: 0.0,
            count: 0,
            last_wave_ms: f64::NEG_INFINITY,
        });
        if at_ms - cell.since > WAVE_WINDOW_MS {
            *cell = WaveCell {
                impulse: 0.0,
                since: at_ms,
                lowest_y: f32::INFINITY,
                x: 0.0,
                z: 0.0,
                count: 0,
                last_wave_ms: cell.last_wave_ms,
            };
        }
        cell.impulse += impulse;
        cell.count += 1;
        cell.x += p.x;
        cell.z += p.z;
        cell.lowest_y = cell.lowest_y.min(p.y);
        if cell.impulse < WAVE_IMPULSE || at_ms - cell.last_wave_ms < WAVE_COOLDOWN_MS {
            return;
        }
        cell.last_wave_ms = at_ms;
        self.wave_ordinal = (self.wave_ordinal + 1) & 0xffff;
        let n = cell.count as f32;
        out.push(Source {
            kind: SourceKind::Wave,
            structure,
            tick,
            ordinal: self.wave_ordinal,
            position: Vec3::new(cell.x / n, cell.lowest_y.max(0.3), cell.z / n),
            normal: Vec3::Y,
            magnitude: cell.impulse / IMPULSE_PER_UNIT,
            count: cell.count,
            material: 0,
            intensity: 0.0,
        });
        cell.impulse = 0.0;
        cell.count = 0;
        cell.x = 0.0;
        cell.z = 0.0;
        cell.lowest_y = f32::INFINITY;
        if self.waves.len() > 512 {
            self.waves
                .retain(|_, c| at_ms - c.since <= WAVE_WINDOW_MS * 4.0);
        }
    }
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
    chunk_radius: HashMap<u32, f32>,
    chunk_material: HashMap<u32, u32>,
}

/// The manifest facts the extractor needs, in world space at rest.
pub struct SourceTable {
    structures: HashMap<u32, StructureInfo>,
    /// Per manifest material: its acoustic material.
    acoustics: Vec<AcousticMaterial>,
    /// Per manifest material: its dust palette.
    palettes: Vec<u32>,
    /// Per manifest material: its authored colour (0xRRGGBBAA), or concrete grey.
    colors: Vec<u32>,
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
                    chunk_pos: s
                        .chunks
                        .iter()
                        .map(|c| (c.node_index, world(c.centroid)))
                        .collect(),
                    chunk_mass: s.chunks.iter().map(|c| (c.node_index, c.mass)).collect(),
                    chunk_radius: s.chunks.iter().map(|c| (c.node_index, c.radius)).collect(),
                    chunk_material: s
                        .chunks
                        .iter()
                        .map(|c| (c.node_index, c.material))
                        .collect(),
                },
            );
        }
        let acoustics = manifest
            .material_appearance
            .iter()
            .map(|a| acoustic_material(a.name.as_deref().unwrap_or(""), a.metalness.unwrap_or(0.0)))
            .collect();
        let colors = manifest
            .material_appearance
            .iter()
            .map(|a| {
                a.color
                    .as_deref()
                    .and_then(crate::materials::parse_hex_rgba)
                    .unwrap_or(CONCRETE_RGBA)
            })
            .collect();
        let palettes = manifest
            .material_appearance
            .iter()
            .map(|a| {
                crate::dust::palette_from_appearance(a.name.as_deref(), a.texture_key.as_deref())
            })
            .collect();
        Self {
            structures,
            acoustics,
            colors,
            palettes,
        }
    }

    /// A manifest material's dust palette (dustPolicy.ts `paletteFromAppearance`; absent: concrete).
    pub fn palette(&self, material: u32) -> u32 {
        self.palettes
            .get(material as usize)
            .copied()
            .unwrap_or(crate::dust::VL_PALETTE_CONCRETE)
    }

    /// A manifest material's colour, for its dust.
    pub fn color(&self, material: u32) -> u32 {
        self.colors
            .get(material as usize)
            .copied()
            .unwrap_or(CONCRETE_RGBA)
    }

    pub fn acoustic(&self, material: u32) -> AcousticMaterial {
        self.acoustics
            .get(material as usize)
            .copied()
            .unwrap_or(AcousticMaterial::Concrete)
    }

    /// The sources of one fracture: broken bonds clustered per 4 m cell (weighted by area, a bond
    /// whose chunks did not part at 15%), and each removed chunk as a crush source of its mass.
    /// `parted(a, b)` says whether two chunks of `structure` now ride different bodies.
    #[allow(clippy::too_many_arguments)]
    pub fn fracture_sources(
        &self,
        structure: u32,
        tick: u32,
        broken_bonds: &[u32],
        removed_chunks: &[u32],
        born: &[(Vec3, f32)],
        parted: impl Fn(u32, u32) -> bool,
        locate: impl Fn(u32, Vec3) -> Vec3,
        state: &mut SourceState,
        now_ms: f64,
        out: &mut Vec<Source>,
    ) {
        let Some(s) = self.structures.get(&structure) else {
            return;
        };
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
            let a = cells.entry(key).or_insert(Acc {
                wpos: Vec3::ZERO,
                w: 0.0,
                normal: Vec3::ZERO,
                magnitude: 0.0,
                count: 0,
                largest: 0.0,
                material: 0,
            });
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
            let w = b.area
                * if parted(b.node0, b.node1) {
                    1.0
                } else {
                    UNSEPARATED_WEIGHT
                };
            // Where the bond is now: it rides its first chunk (on a moving body, not at rest).
            add(
                0,
                locate(b.node0, b.centroid),
                w,
                b.normal,
                w * FRACTURE_UNITS_PER_M2,
                b.material,
            );
        }
        for chunk in removed_chunks {
            let (Some(&pos), Some(&mass)) = (s.chunk_pos.get(chunk), s.chunk_mass.get(chunk))
            else {
                continue;
            };
            let material = s.chunk_material.get(chunk).copied().unwrap_or(0);
            add(1, pos, mass, Vec3::ZERO, mass / CRUSH_KG_PER_UNIT, material);
        }
        // Islands born in this fracture: a heavy one sheds dust of its own; a light one adds a
        // quarter of its units to the fracture around it (the web's static-fracture rule).
        let mut folded: Vec<(Vec3, f32)> = Vec::new();
        for &(pos, mass) in born {
            let units = mass / SHED_KG_PER_UNIT;
            if mass >= MIN_SHED_MASS_KG {
                add(2, pos, mass, Vec3::ZERO, units, 0);
            } else {
                folded.push((pos, units * 0.25));
            }
        }
        for (pos, units) in folded {
            let key = (
                0u8,
                (pos.x / CELL_SIZE_M).floor() as i32,
                (pos.y / CELL_SIZE_M).floor() as i32,
                (pos.z / CELL_SIZE_M).floor() as i32,
            );
            if let Some(a) = cells.get_mut(&key) {
                a.magnitude += units;
            }
        }
        // Ordinals by cell key (stable for a given fracture), then the largest kept.
        let mut keyed: Vec<_> = cells.into_iter().collect();
        keyed.sort_by_key(|(k, _)| *k);
        let mut sources: Vec<Source> = keyed
            .into_iter()
            .enumerate()
            .filter(|(_, (_, a))| a.w > 0.0)
            .map(|(ordinal, ((kind, ..), a))| Source {
                kind: match kind {
                    0 => SourceKind::Fracture,
                    1 => SourceKind::Crush,
                    _ => SourceKind::Shed,
                },
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
        // The first break in a quiet cell along a shot's path is that shot landing: spall on the
        // near face, thrown back toward the shooter, twice the dust.
        for source in sources
            .iter_mut()
            .filter(|s| s.kind == SourceKind::Fracture)
        {
            let p = source.position;
            let key = (
                structure,
                (p.x / CELL_SIZE_M).floor() as i32,
                (p.y / CELL_SIZE_M).floor() as i32,
                (p.z / CELL_SIZE_M).floor() as i32,
            );
            let last = state.quiet.insert(key, now_ms);
            if last.is_none_or(|t| now_ms - t > ENTRY_QUIET_MS) {
                if let Some(origin) = state.shots.match_shot(p, now_ms) {
                    source.kind = SourceKind::Entry;
                    source.magnitude *= 2.0;
                    let toward = (origin - p).normalize_or_zero();
                    source.normal = (toward + source.normal * 0.5).normalize_or_zero();
                }
            }
        }
        if state.quiet.len() > 4096 {
            state.quiet.retain(|_, t| now_ms - *t <= ENTRY_QUIET_MS);
        }
        out.extend(sources);
    }

    /// An island of chunks at rest: its centre of mass (world, server space) and mass.
    pub fn island(&self, structure: u32, chunks: &[u32]) -> (Vec3, f32) {
        let Some(s) = self.structures.get(&structure) else {
            return (Vec3::ZERO, 0.0);
        };
        let (mut weighted, mut mass) = (Vec3::ZERO, 0.0f32);
        for c in chunks {
            if let (Some(&p), Some(&m)) = (s.chunk_pos.get(c), s.chunk_mass.get(c)) {
                weighted += p * m;
                mass += m;
            }
        }
        (
            if mass > 0.0 {
                weighted / mass
            } else {
                Vec3::ZERO
            },
            mass,
        )
    }

    /// A bond's two chunks (node indices).
    pub fn bond_nodes(&self, structure: u32, bond: u32) -> Option<(u32, u32)> {
        self.structures
            .get(&structure)?
            .bonds
            .get(&bond)
            .map(|b| (b.node0, b.node1))
    }

    /// Mass of a set of chunks of `structure`, kg.
    pub fn mass_of(&self, structure: u32, chunks: &[u32]) -> f32 {
        self.structures.get(&structure).map_or(0.0, |s| {
            chunks.iter().filter_map(|c| s.chunk_mass.get(c)).sum()
        })
    }

    /// A body's audible size (cityClient.ts `notePose`): its largest chunk's radius, grown with the
    /// chunk count (radius × (1 + ∛n / 2)), at most 6 m.
    pub fn radius_of(&self, structure: u32, chunks: &[u32]) -> f32 {
        let Some(s) = self.structures.get(&structure) else {
            return 0.0;
        };
        let largest = chunks
            .iter()
            .take(64)
            .filter_map(|c| s.chunk_radius.get(c))
            .fold(0.0f32, |a, &r| a.max(r));
        (largest * (1.0 + (chunks.len() as f32).cbrt() * 0.5)).min(6.0)
    }

    /// Manifest material of a chunk.
    pub fn material_of(&self, structure: u32, chunk: u32) -> u32 {
        self.structures
            .get(&structure)
            .and_then(|s| s.chunk_material.get(&chunk))
            .copied()
            .unwrap_or(0)
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
pub fn classify_motion_impact(
    previous: &MotionSample,
    current: &MotionSample,
) -> Option<(f32, f32)> {
    if current.mass <= 0.0 || !current.mass.is_finite() {
        return None;
    }
    let dt = ((current.time_ms - previous.time_ms) / 1000.0) as f32;
    if !dt.is_finite() || dt <= 0.0 || dt > 0.25 {
        return None;
    }
    if !(previous.position.is_finite()
        && current.position.is_finite()
        && previous.velocity.is_finite()
        && current.velocity.is_finite())
    {
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
    if delta.min(raw)
        < (if heavy { 1.2f32 } else { 3.0 }).max((if heavy { 10.0f32 } else { 20.0 }) * dt)
    {
        return None;
    }
    let lost = before * before - after * after;
    Some((
        0.5 * current.mass * lost,
        physical_intensity(current.mass * lost.sqrt(), current.mass),
    ))
}

/// `soundFromDestruction` (gameEvents.ts): a fracture or crush source as a sound.
pub fn sound_from_source(
    source: &Source,
    material: AcousticMaterial,
    at_ms: f64,
) -> Option<SoundEvent> {
    let kind = match source.kind {
        // Island release is not a collision (gameEvents.ts soundFromDestruction).
        SourceKind::Shed => return None,
        SourceKind::Impact => SoundKind::Impact,
        SourceKind::Wave => SoundKind::Collapse,
        SourceKind::Fracture | SourceKind::Crush | SourceKind::Entry => SoundKind::Fracture,
    };
    let magnitude = source.magnitude.max(0.0);
    let (intensity, size) = if source.kind == SourceKind::Impact {
        (
            source.intensity.clamp(0.0, 1.0),
            (magnitude.cbrt()).max(0.1),
        )
    } else {
        // Fracture magnitude is three times broken bond area; not mass or impulse.
        (
            (0.12 + 0.86 * (1.0 - (-magnitude.sqrt() / 2.5).exp())).clamp(0.08, 0.98),
            magnitude.cbrt().max(0.2),
        )
    };
    let seed =
        (source.tick.wrapping_mul(997)) ^ (source.structure.wrapping_mul(65537)) ^ source.ordinal;
    Some(SoundEvent {
        id: (u64::from(source.structure) << 40)
            ^ (u64::from(source.tick) << 8)
            ^ u64::from(source.ordinal)
            ^ ((source.kind as u64) << 60),
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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../destruction/assets/scenes/house-1story.json");
        let pack = vibe_land_destruction::scene_pack::load_scene_pack_file(&path).unwrap();
        let desc = vibe_land_destruction::city::CitySceneDesc {
            grid: 1,
            ..Default::default()
        };
        let manifest = DestructionManifest::from_city(
            &vibe_land_destruction::city::build_city_scene(&pack, desc).unwrap(),
        );
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
        let near: Vec<u32> = bonds
            .iter()
            .filter(|(_, b)| b.centroid.distance(first) < 0.5)
            .map(|(k, _)| **k)
            .take(2)
            .collect();
        let far = bonds
            .iter()
            .max_by(|a, b| {
                a.1.centroid
                    .distance(first)
                    .total_cmp(&b.1.centroid.distance(first))
            })
            .map(|(k, _)| **k)
            .unwrap();
        let mut broken = near.clone();
        broken.push(far);
        let mut out = Vec::new();
        t.fracture_sources(
            structure,
            10,
            &broken,
            &[],
            &[],
            |_, _| true,
            |_, p| p,
            &mut SourceState::default(),
            0.0,
            &mut out,
        );
        assert!(out.len() >= 2, "the far bond is its own source");
        let total: f32 = out.iter().map(|s| s.magnitude).sum();
        let area: f32 = broken.iter().map(|b| s.bonds[b].area).sum();
        assert!(
            (total - 3.0 * area).abs() < 1e-3 * total.max(1.0),
            "magnitude = 3·Σarea"
        );
        // Unparted bonds count 15%.
        let mut unparted = Vec::new();
        t.fracture_sources(
            structure,
            10,
            &broken,
            &[],
            &[],
            |_, _| false,
            |_, p| p,
            &mut SourceState::default(),
            0.0,
            &mut unparted,
        );
        let total_u: f32 = unparted.iter().map(|s| s.magnitude).sum();
        assert!((total_u - 0.15 * total).abs() < 1e-3 * total.max(1.0));
    }

    #[test]
    fn crushed_chunks_are_sources_of_their_mass() {
        let t = table();
        let (&structure, s) = t.structures.iter().next().unwrap();
        let (&chunk, &mass) = s.chunk_mass.iter().next().unwrap();
        let mut out = Vec::new();
        t.fracture_sources(
            structure,
            3,
            &[],
            &[chunk],
            &[],
            |_, _| true,
            |_, p| p,
            &mut SourceState::default(),
            0.0,
            &mut out,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, SourceKind::Crush);
        assert!((out[0].magnitude - mass / 100.0).abs() < 1e-3);
    }

    #[test]
    fn impacts_need_a_sudden_drop_not_a_ballistic_arc() {
        let at = |t: f64, v: Vec3| MotionSample {
            position: Vec3::ZERO,
            velocity: v,
            time_ms: t,
            mass: 500.0,
        };
        // Falling 8 m/s, stopped in one tick: a hit.
        let hit =
            classify_motion_impact(&at(0.0, Vec3::new(0.0, -8.0, 0.0)), &at(16.7, Vec3::ZERO));
        assert!(hit.is_some_and(|(e, i)| e > 15000.0 && i > 0.5));
        // Free fall over one tick (gravity only): not a hit.
        assert!(classify_motion_impact(
            &at(0.0, Vec3::new(0.0, -8.0, 0.0)),
            &at(16.7, Vec3::new(0.0, -8.164, 0.0))
        )
        .is_none());
        // Slow drift slowing down: not a hit.
        assert!(
            classify_motion_impact(&at(0.0, Vec3::new(1.0, 0.0, 0.0)), &at(16.7, Vec3::ZERO))
                .is_none()
        );
    }

    #[test]
    fn a_shots_first_break_is_its_entry_and_later_breaks_are_not() {
        let t = table();
        let (&structure, s) = t.structures.iter().next().unwrap();
        let (&bond, b) = s.bonds.iter().next().unwrap();
        let mut state = SourceState::default();
        // A rifle shot from 20 m away straight at the bond.
        let origin = b.centroid + Vec3::new(20.0, 0.0, 0.0);
        state
            .shots
            .register(origin, b.centroid - origin, Some(b.centroid), 0.0);
        let mut out = Vec::new();
        t.fracture_sources(
            structure,
            5,
            &[bond],
            &[],
            &[],
            |_, _| true,
            |_, p| p,
            &mut state,
            100.0,
            &mut out,
        );
        assert_eq!(out[0].kind, SourceKind::Entry);
        assert!(out[0].normal.x > 0.5, "faces the shooter");
        // The same cell breaking again 200 ms later is no longer quiet: a plain fracture.
        let mut again = Vec::new();
        t.fracture_sources(
            structure,
            6,
            &[bond],
            &[],
            &[],
            |_, _| true,
            |_, p| p,
            &mut state,
            300.0,
            &mut again,
        );
        assert_eq!(again[0].kind, SourceKind::Fracture);
        assert!((out[0].magnitude - 2.0 * again[0].magnitude).abs() < 1e-4);
    }

    #[test]
    fn heavy_islands_shed_and_light_ones_fold_into_their_fracture() {
        let t = table();
        let (&structure, s) = t.structures.iter().next().unwrap();
        let (&bond, b) = s.bonds.iter().next().unwrap();
        let mut out = Vec::new();
        t.fracture_sources(
            structure,
            5,
            &[bond],
            &[],
            &[(b.centroid + Vec3::Y * 20.0, 8000.0)],
            |_, _| true,
            |_, p| p,
            &mut SourceState::default(),
            0.0,
            &mut out,
        );
        assert!(out
            .iter()
            .any(|s| s.kind == SourceKind::Shed && (s.magnitude - 16.0).abs() < 1e-3));
        let mut light = Vec::new();
        t.fracture_sources(
            structure,
            5,
            &[bond],
            &[],
            &[(b.centroid, 1000.0)],
            |_, _| true,
            |_, p| p,
            &mut SourceState::default(),
            0.0,
            &mut light,
        );
        let plain = 3.0 * b.area;
        assert!(light.iter().all(|s| s.kind != SourceKind::Shed));
        assert!(
            (light[0].magnitude - (plain + 0.5)).abs() < 1e-3,
            "a quarter of 2 units folded in"
        );
    }

    #[test]
    fn many_heavy_impacts_in_one_place_raise_a_collapse_wave() {
        let mut state = SourceState::default();
        let mut out = Vec::new();
        for i in 0..4 {
            state.note_impact(
                1,
                10,
                Vec3::new(1.0 + i as f32, 2.0, 1.0),
                30_000.0,
                100.0 + f64::from(i) * 50.0,
                &mut out,
            );
        }
        assert_eq!(out.len(), 1, "120 000 N·s within 500 ms in one 8 m cell");
        assert_eq!(out[0].kind, SourceKind::Wave);
        assert!((out[0].magnitude - 120_000.0 / 4000.0).abs() < 1e-3);
        // Cooling down: more impacts right after raise nothing.
        for i in 0..4 {
            state.note_impact(
                1,
                11,
                Vec3::new(1.0, 2.0, 1.0),
                30_000.0,
                400.0 + f64::from(i) * 10.0,
                &mut out,
            );
        }
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn bonds_on_moving_bodies_break_where_the_bodies_are() {
        let t = table();
        let (&structure, s) = t.structures.iter().next().unwrap();
        let bond = *s.bonds.keys().min().unwrap();
        let mut out = Vec::new();
        let shift = Vec3::new(30.0, -5.0, 2.0);
        t.fracture_sources(
            structure,
            5,
            &[bond],
            &[],
            &[],
            |_, _| true,
            |_, p| p + shift,
            &mut SourceState::default(),
            0.0,
            &mut out,
        );
        let mut rest = Vec::new();
        t.fracture_sources(
            structure,
            5,
            &[bond],
            &[],
            &[],
            |_, _| true,
            |_, p| p,
            &mut SourceState::default(),
            0.0,
            &mut rest,
        );
        assert!((out[0].position - (rest[0].position + shift)).length() < 1e-4);
    }
}
