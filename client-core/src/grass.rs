//! The city's meadow: grass blades per 8 m patch, shared by every renderer.
//!
//! A port of the web client's default meadow (client/src/scene/grass: `grassPlacement.ts`
//! `generateGrassPatch` and `grassExclusionsFromManifest`, `GrassPaint.ts`'s default paint and
//! sampler, `foliageProfiles.ts`). With no painted grass the web shows this meadow over the whole
//! ±256 m ground, bare inside each building's original footprint (plus a 0.65 m verge). Blades are
//! deterministic per patch and in a random order whose every prefix covers the whole patch, so a
//! renderer's distance LOD is just "draw the first n".
//!
//! Positions are in server space (x, z on the ground plane; y up).

use std::collections::HashMap;

use glam::{Quat, Vec3};
use vibe_land_destruction::manifest::DestructionManifest;

pub const GRASS_PATCH_SIZE: f32 = 8.0;
pub const GRASS_WORLD_HALF_EXTENT: f32 = 256.0;
pub const GRASS_MAX_HEIGHT: f32 = 4.0;
/// Blades per m² at the highest quality (grassPlacement.ts GRASS_PROFILES.pretty).
pub const GRASS_DENSITY_PRETTY: f32 = 150.0;
const CELLS: i32 = 16;
const CELL: f32 = 0.5;
const CHANNELS: usize = 12;
/// The grass species' stiffness (foliageProfiles.ts).

/// A building's original footprint, grown by the verge: no grass inside.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlGrassExclusion {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

/// `grassExclusionsFromManifest`: each structure's chunk-box bounds, rotated, plus 0.65 m.
pub fn exclusions_from_manifest(manifest: &DestructionManifest) -> Vec<VlGrassExclusion> {
    let mut out = Vec::new();
    for s in &manifest.structures {
        let q = Quat::from_array(s.world_rotation).normalize();
        let p = Vec3::from_array(s.world_position);
        let (mut lo, mut hi) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
        for c in &s.chunks {
            for corner in 0..8 {
                let h = |bit: u32, i: usize| if corner & bit != 0 { 0.5 } else { -0.5 } * c.size[i];
                let local = Vec3::new(c.centroid[0] + h(1, 0), c.centroid[1] + h(2, 1), c.centroid[2] + h(4, 2));
                let w = q * local + p;
                lo = lo.min(w);
                hi = hi.max(w);
            }
        }
        if lo.x.is_finite() {
            out.push(VlGrassExclusion { min_x: lo.x - 0.65, min_z: lo.z - 0.65, max_x: hi.x + 0.65, max_z: hi.z + 0.65 });
        }
    }
    out
}

/// One blade. `x`, `z` are world metres; colour is linear RGB.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlGrassBlade {
    pub x: f32,
    pub z: f32,
    pub height: f32,
    /// Facing, radians about +y.
    pub yaw: f32,
    pub width: f32,
    /// How far the tip leans, as a fraction of the height.
    pub lean: f32,
    pub variation: f32,
    pub color: [f32; 3],
    pub stiffness: f32,
    /// foliageProfiles.ts `FOLIAGE_SPECIES` index: 0 grass, 1 reed, 2 wheat, 3 corn, 4 fern.
    pub species: u32,
}

/// foliageProfiles.ts `FOLIAGE_PROFILES`, by species id: (density per m², width, stiffness).
const FOLIAGE_PROFILES: [(f32, f32, f32); 5] = [(150.0, 1.0, 0.3), (28.0, 1.5, 0.7), (55.0, 0.7, 0.55), (3.0, 5.0, 0.8), (5.0, 2.5, 0.4)];

/// The shared painted grass (GrassPaint.ts): sparse 8 m tiles of 16 × 16 half-metre cells, 12
/// byte channels each (density, height/4 m, colour RGB, species, health, dryness, maturity, row
/// spacing/4 m, row angle/360°, stiffness). Unpainted ground is the default meadow.
#[derive(Clone, Debug, Default)]
pub struct GrassPaint {
    tiles: HashMap<(i32, i32), Vec<u8>>,
}

#[derive(serde::Deserialize)]
struct LayoutTile {
    x: i32,
    z: i32,
    data: Vec<u32>,
}

#[derive(serde::Deserialize)]
struct Layout {
    version: u32,
    tiles: Vec<LayoutTile>,
}

#[derive(serde::Deserialize)]
struct Snapshot {
    revision: String,
    layout: Layout,
}

impl GrassPaint {
    /// `GrassPaint.import`: a layout document (versions 1 to 3), validated as the web does.
    fn from_layout(doc: Layout) -> Result<Self, &'static str> {
        if !(1..=3).contains(&doc.version) || doc.tiles.len() > 4096 {
            return Err("invalid grass layout");
        }
        let channels = if doc.version == 3 { CHANNELS } else { 5 };
        let cells = (CELLS * CELLS) as usize;
        let mut tiles = HashMap::new();
        for tile in doc.tiles {
            if !(-32..32).contains(&tile.x) || !(-32..32).contains(&tile.z) || tile.data.len() != cells * channels || tile.data.iter().any(|&v| v > 255) {
                return Err("invalid grass tile");
            }
            let mut data = vec![0u8; cells * CHANNELS];
            for cell in 0..cells {
                let at = cell * CHANNELS;
                data[at..at + CHANNELS].copy_from_slice(&[0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 128]);
                for k in 0..channels {
                    data[at + k] = tile.data[cell * channels + k] as u8;
                }
                if data[at + 5] > 4 {
                    return Err("invalid foliage species");
                }
                if doc.version == 1 {
                    data[at + 1] = ((f32::from(data[at + 1]) * 2.0 / GRASS_MAX_HEIGHT) + 0.5).floor() as u8;
                }
            }
            if tiles.insert((tile.x, tile.z), data).is_some() {
                return Err("duplicate grass tile");
            }
        }
        Ok(Self { tiles })
    }

    /// A layout document (`{version, tiles}`) as JSON.
    pub fn from_layout_json(bytes: &[u8]) -> Result<Self, &'static str> {
        Self::from_layout(serde_json::from_slice(bytes).map_err(|_| "invalid grass layout")?)
    }

    /// The server's `/match-stats/<match>/grass` response (`{revision, layout}`): its revision and
    /// paint (GrassLayoutSync.ts `fetchSharedGrass`).
    pub fn from_snapshot_json(bytes: &[u8]) -> Result<(String, Self), &'static str> {
        let s: Snapshot = serde_json::from_slice(bytes).map_err(|_| "invalid shared grass response")?;
        if s.revision.len() != 64 || !s.revision.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || ![2, 3].contains(&s.layout.version) {
            return Err("invalid shared grass response");
        }
        Ok((s.revision, Self::from_layout(s.layout)?))
    }

    /// The ground's canopy tint at a world point (groundNodes.ts): the paint's cover texture (one
    /// 2 m texel, `GrassPaint.updateCover`) as `mix(cover.rgb · 0.7 / (0.3199, 0.236, 0.1062), 1,
    /// 1 − cover.density)`, a multiplier on the ochre grass photograph (linear RGB).
    pub fn ground_tint(&self, x: f32, z: f32) -> [f32; 3] {
        // updateCover: texel (tx, tz) over ±256 m reads the cell at (2t − 256 + 1) m.
        let texel = |v: f32| (((v + 256.0) / 2.0).floor().clamp(0.0, 255.0)) * 2.0 - 256.0 + 1.0;
        let (cx, cz) = (texel(x), texel(z));
        let mut cell = [0.0f32; CHANNELS];
        self.cell((cx / CELL).floor() as i32, (cz / CELL).floor() as i32, &mut cell);
        // The cover texture holds bytes; three samples it as unorm.
        let unorm = |b: f32| b / 255.0;
        let dirt = 1.0 - unorm(cell[0]);
        let canopy = [unorm(cell[2]) * 0.7 / 0.3199, unorm(cell[3]) * 0.7 / 0.236, unorm(cell[4]) * 0.7 / 0.1062];
        canopy.map(|c| c + (1.0 - c) * dirt)
    }

    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    /// `GrassPaint.cell`: a cell's channels, painted or default.
    fn cell(&self, ix: i32, iz: i32, out: &mut [f32]) {
        let (tx, tz) = (ix.div_euclid(CELLS), iz.div_euclid(CELLS));
        match self.tiles.get(&(tx, tz)) {
            None => default_cell((ix as f32 + 0.5) * CELL, (iz as f32 + 0.5) * CELL, out),
            Some(tile) => {
                let at = (((iz - tz * CELLS) * CELLS + ix - tx * CELLS) as usize) * CHANNELS;
                for c in 0..CHANNELS {
                    out[c] = f32::from(tile[at + c]);
                }
            }
        }
    }
}

/// grassPlacement.ts `randomFor` (a mulberry32 variant), bit-identical to the web's.
struct PatchRandom(i32);

impl PatchRandom {
    fn new(x: i32, z: i32) -> Self {
        Self(x.wrapping_mul(73856093) ^ z.wrapping_mul(19349663) ^ 0x65a73e91u32 as i32)
    }
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let s = self.0;
        let mut t = (s ^ ((s as u32) >> 15) as i32).wrapping_mul(1 | s);
        t ^= t.wrapping_add((t ^ ((t as u32) >> 7) as i32).wrapping_mul(61 | t));
        (f64::from((t ^ ((t as u32) >> 14) as i32) as u32) / 4294967296.0) as f32
    }
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// `new Color('#rrggbb')` in three.js (sRGB in, linear out).
fn hex_linear(hex: u32) -> [f32; 3] {
    [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff].map(|c| srgb_to_linear(c as f32 / 255.0))
}

/// GrassPaint.ts `defaults`: the unpainted meadow's 12 channels (bytes) at a world point.
fn default_cell(x: f32, z: f32, out: &mut [f32]) {
    let clamp = |v: f32| v.clamp(0.0, 1.0);
    let moisture = clamp(0.6 + 0.3 * (x * 0.047 + (z * 0.061).sin()).sin() + 0.18 * (z * 0.097 + x * 0.031).cos());
    let dry = clamp((0.4 - moisture) * 2.0);
    let (green, straw) = (hex_linear(0x7e9c46), hex_linear(0xb39a66));
    // JS Math.round: half up.
    let round = |v: f32| (v + 0.5).floor();
    out[0] = round((0.6 + moisture * 0.4) * 255.0);
    out[1] = round((0.32 + moisture * 0.24) / GRASS_MAX_HEIGHT * 255.0);
    for k in 0..3 {
        out[2 + k] = round((green[k] + (straw[k] - green[k]) * dry) * 255.0);
    }
    out[5] = 0.0;
    out[6] = 255.0;
    out[7] = 0.0;
    out[8] = 255.0;
    out[9] = 0.0;
    out[10] = 0.0;
    out[11] = 128.0;
}

/// One patch's blades at `density` blades per m² of grass (≤ the pretty density), as the web
/// generates them (grassPlacement.ts `generateGrassPatch`), over `paint` (none: the default meadow).
pub fn generate_patch(px: i32, pz: i32, density: f32, exclusions: &[VlGrassExclusion], paint: Option<&GrassPaint>, out: &mut Vec<VlGrassBlade>) {
    out.clear();
    let unpainted = GrassPaint::default();
    let paint = paint.unwrap_or(&unpainted);
    // The paint grid for the patch, with a one-cell border, as GrassPaint.sampler builds it.
    let stride = (CELLS + 2) as usize;
    let mut grid = vec![0.0f32; stride * stride * CHANNELS];
    for z in -1..=CELLS {
        for x in -1..=CELLS {
            let (ix, iz) = (px * CELLS + x, pz * CELLS + z);
            let at = (((z + 1) as usize) * stride + (x + 1) as usize) * CHANNELS;
            paint.cell(ix, iz, &mut grid[at..at + CHANNELS]);
        }
    }
    let mut style = [0.0f32; CHANNELS];
    let mut sample = |x: f32, z: f32, out: &mut [f32; CHANNELS]| {
        let (gx, gz) = (x / CELL + 0.5, z / CELL + 0.5);
        let (ix, iz) = (gx.floor(), gz.floor());
        let (fx, fz) = (gx - ix, gz - iz);
        let a = ((iz as usize) * stride + ix as usize) * CHANNELS;
        let (b, c) = (a + CHANNELS, a + stride * CHANNELS);
        let d = c + CHANNELS;
        for k in 0..CHANNELS {
            out[k] = if k == 5 || k == 9 || k == 10 {
                grid[(if fz < 0.5 { if fx < 0.5 { a } else { b } } else if fx < 0.5 { c } else { d }) + k] / 255.0
            } else {
                ((grid[a + k] * (1.0 - fx) + grid[b + k] * fx) * (1.0 - fz) + (grid[c + k] * (1.0 - fx) + grid[d + k] * fx) * fz) / 255.0
            };
        }
    };

    let count = (GRASS_DENSITY_PRETTY * GRASS_PATCH_SIZE * GRASS_PATCH_SIZE).round() as usize;
    let grass_limit = (density.min(GRASS_DENSITY_PRETTY) * GRASS_PATCH_SIZE * GRASS_PATCH_SIZE) as usize;
    let mut random = PatchRandom::new(px, pz);
    let (ox, oz) = (px as f32 * GRASS_PATCH_SIZE, pz as f32 * GRASS_PATCH_SIZE);
    let nearby: Vec<&VlGrassExclusion> = exclusions
        .iter()
        .filter(|b| b.max_x >= ox && b.min_x <= ox + GRASS_PATCH_SIZE && b.max_z >= oz && b.min_z <= oz + GRASS_PATCH_SIZE)
        .collect();
    for i in 0..count {
        let x = random.next() * GRASS_PATCH_SIZE;
        let z = random.next() * GRASS_PATCH_SIZE;
        let (wx, wz) = (ox + x, oz + z);
        let variation = random.next();
        let height = random.next();
        let yaw = random.next() * std::f32::consts::TAU;
        let lean = random.next();
        let coverage = random.next();
        if wx.abs() >= GRASS_WORLD_HALF_EXTENT || wz.abs() >= GRASS_WORLD_HALF_EXTENT {
            continue;
        }
        if nearby.iter().any(|b| wx >= b.min_x && wx <= b.max_x && wz >= b.min_z && wz <= b.max_z) {
            continue;
        }
        sample(x, z, &mut style);
        let species = ((style[5] * 255.0) + 0.5).floor() as usize;
        let species = if species < FOLIAGE_PROFILES.len() { species } else { 0 };
        let (profile_density, profile_width, profile_stiffness) = FOLIAGE_PROFILES[species];
        if species == 0 && i >= grass_limit {
            continue;
        }
        if coverage >= style[0] * (profile_density / GRASS_DENSITY_PRETTY).min(1.0) {
            continue;
        }
        // Crops in rows: only near a row line.
        let spacing = style[9] * 4.0;
        if spacing > 0.1 {
            let angle = style[10] * std::f32::consts::TAU;
            let across = wx * angle.cos() - wz * angle.sin();
            let to_row = (across / spacing - js_round(across / spacing)).abs() * spacing;
            if to_row > spacing * 0.3 {
                continue;
            }
        }
        let fertility = 0.5 + 0.25 * (wx * 0.23 + (wz * 0.31).sin()).sin() + 0.25 * (wz * 0.49 + wx * 0.17).sin();
        if variation < 0.08 * (1.0 - fertility) {
            continue;
        }
        let authored = style[1] * GRASS_MAX_HEIGHT;
        let tallness = ((authored - 1.25) / 1.25).clamp(0.0, 1.0);
        let minimum = 0.35 + tallness * 0.45;
        let blade_height = (0.45 + style[8] * 0.55) * (minimum + height * (1.0 - minimum)) * authored * (0.8 + fertility * 0.2);
        out.push(VlGrassBlade {
            x: wx,
            z: wz,
            height: blade_height,
            yaw,
            width: (0.009 + variation * 0.015) * (1.0 + tallness * 2.0) * profile_width * (0.7 + style[6] * 0.3),
            lean: (0.18 + lean * 0.6) * (1.0 - tallness * 0.65),
            variation,
            color: [style[2], style[3], style[4]],
            stiffness: style[11] * 0.5 + profile_stiffness * 0.5,
            species: species as u32,
        });
    }
}

/// JS `Math.round` (half toward +∞).
fn js_round(v: f32) -> f32 {
    (v + 0.5).floor()
}

/// grassPlacement.ts `grassDensityAtDistance`: the fraction of a patch's blades to draw at
/// `distance` (pretty: full to 8 m, 45% by 16 m, then down to ~16% by 30 m).
pub fn density_at_distance(distance: f32) -> f32 {
    let (near, middle) = (16.0f32, 30.0f32);
    let smooth = |a: f32, b: f32| {
        let t = ((distance - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    (1.0 - 0.55 * smooth(near * 0.5, near)) * (1.0 - 0.65 * smooth(middle * 0.65, middle))
}

/// The distance past which no grass is drawn (pretty).
pub const GRASS_DRAW_DISTANCE: f32 = 48.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_match_the_web() {
        // generateGrassPatch(px, pz, 'pretty', []) in client/src/scene/grass/grassPlacement.ts with
        // the default (unpainted) meadow, run with tsx: blade count and the first blade.
        let cases = WEB_PATCHES;
        let mut out = Vec::new();
        for &(px, pz, count, first) in cases {
            generate_patch(px, pz, GRASS_DENSITY_PRETTY, &[], None, &mut out);
            assert_eq!(out.len(), count, "patch {px},{pz} count");
            let b = out[0];
            let got = [b.x - px as f32 * GRASS_PATCH_SIZE, b.z - pz as f32 * GRASS_PATCH_SIZE, b.height, b.yaw];
            for (g, w) in got.iter().zip(first) {
                assert!((g - w).abs() < 1e-4, "patch {px},{pz}: {got:?} vs {first:?}");
            }
        }
    }

    // Filled from tsx; see patches_match_the_web.
    const WEB_PATCHES: &[(i32, i32, usize, [f32; 4])] = &[
        (0, 0, 8917, [1.7081564664840698, 2.4083120822906494, 0.4207504689693451, 4.649847507476807]),
        (3, -2, 9030, [5.308022499084473, 3.516209363937378, 0.3971720039844513, 2.478616237640381]),
        (-31, 31, 8725, [5.397045612335205, 1.262824535369873, 0.3389756381511688, 1.9606105089187622]),
        (12, 7, 6156, [7.132168292999268, 5.307011127471924, 0.26327240467071533, 0.5627699494361877]),
    ];

    #[test]
    fn painted_patches_match_the_web() {
        // client-core/tests/fixtures/grass_paint_web.json: GrassPaint.ts painted with the wheat
        // brush at (2.5, 2.5) r 2.2 and reeds at (5.5, 5.5) r 2, exported, and
        // generateGrassPatch(0, 0, 'pretty', [], paint), run with tsx.
        #[derive(serde::Deserialize)]
        struct Fixture {
            layout: serde_json::Value,
            count: usize,
            species: [usize; 5],
            first: [f32; 4],
            last: [f32; 4],
        }
        let f: Fixture = serde_json::from_str(include_str!("../tests/fixtures/grass_paint_web.json")).unwrap();
        let paint = GrassPaint::from_layout_json(f.layout.to_string().as_bytes()).unwrap();
        assert_eq!(paint.tile_count(), 1);
        let mut out = Vec::new();
        generate_patch(0, 0, GRASS_DENSITY_PRETTY, &[], Some(&paint), &mut out);
        assert_eq!(out.len(), f.count);
        let mut species = [0usize; 5];
        for b in &out {
            species[b.species as usize] += 1;
        }
        assert_eq!(species, f.species);
        for (b, w) in [(out[0], f.first), (out[out.len() - 1], f.last)] {
            let got = [b.x, b.z, b.height, b.yaw];
            for (g, w) in got.iter().zip(w) {
                assert!((g - w).abs() < 1e-4, "{got:?} vs {w:?}");
            }
        }
    }

    #[test]
    fn shared_snapshots_are_validated_like_the_web() {
        let ok = format!(r#"{{"revision":"{}","layout":{{"version":3,"tiles":[]}}}}"#, "a".repeat(64));
        let (revision, paint) = GrassPaint::from_snapshot_json(ok.as_bytes()).unwrap();
        assert_eq!((revision.len(), paint.tile_count()), (64, 0));
        assert!(GrassPaint::from_snapshot_json(br#"{"revision":"x","layout":{"version":3,"tiles":[]}}"#).is_err());
        let bad_species = format!(r#"{{"version":3,"tiles":[{{"x":0,"z":0,"data":[{}]}}]}}"#, vec!["0,0,0,0,0,9,0,0,0,0,0,0"; 256].join(","));
        assert!(GrassPaint::from_layout_json(bad_species.as_bytes()).is_err());
    }

    #[test]
    fn ground_tint_is_the_web_canopy() {
        // The default meadow at the origin: cell (0, 0) holds GrassPaint.defaults(0.25, 0.25).
        let mut cell = [0.0f32; CHANNELS];
        default_cell(1.25, 1.25, &mut cell);
        let tint = GrassPaint::default().ground_tint(1.0, 1.0);
        let dirt = 1.0 - cell[0] / 255.0;
        let want = (cell[3] / 255.0 * 0.7 / 0.236) * (1.0 - dirt) + dirt;
        assert!((tint[1] - want).abs() < 1e-6, "{tint:?} {want}");
        // Green canopy: the ochre photo's green channel is lifted the most.
        assert!(tint[1] > tint[0] && tint[1] > tint[2]);
    }

    #[test]
    fn exclusions_keep_footprints_bare() {
        let ex = [VlGrassExclusion { min_x: 1.0, min_z: 1.0, max_x: 6.0, max_z: 6.0 }];
        let mut out = Vec::new();
        generate_patch(0, 0, GRASS_DENSITY_PRETTY, &ex, None, &mut out);
        assert!(!out.is_empty());
        assert!(out.iter().all(|b| !(b.x >= 1.0 && b.x <= 6.0 && b.z >= 1.0 && b.z <= 6.0)));
    }

    #[test]
    fn lod_density_falls_with_distance() {
        assert_eq!(density_at_distance(0.0), 1.0);
        assert!(density_at_distance(16.0) < 0.5 && density_at_distance(40.0) < 0.2);
    }
}
