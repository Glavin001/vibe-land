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
const GRASS_STIFFNESS: f32 = 0.3;

/// A building's original footprint, grown by the verge: no grass inside.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrassExclusion {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

/// `grassExclusionsFromManifest`: each structure's chunk-box bounds, rotated, plus 0.65 m.
pub fn exclusions_from_manifest(manifest: &DestructionManifest) -> Vec<GrassExclusion> {
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
            out.push(GrassExclusion { min_x: lo.x - 0.65, min_z: lo.z - 0.65, max_x: hi.x + 0.65, max_z: hi.z + 0.65 });
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

/// One patch's blades at `density` blades per m² (≤ the pretty density), as the web generates them.
pub fn generate_patch(px: i32, pz: i32, density: f32, exclusions: &[GrassExclusion], out: &mut Vec<VlGrassBlade>) {
    out.clear();
    // The default paint grid for the patch, with a one-cell border, as GrassPaint.sampler builds it.
    let stride = (CELLS + 2) as usize;
    let mut grid = vec![0.0f32; stride * stride * CHANNELS];
    for z in -1..=CELLS {
        for x in -1..=CELLS {
            let (ix, iz) = (px * CELLS + x, pz * CELLS + z);
            let at = (((z + 1) as usize) * stride + (x + 1) as usize) * CHANNELS;
            default_cell((ix as f32 + 0.5) * CELL, (iz as f32 + 0.5) * CELL, &mut grid[at..at + CHANNELS]);
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
    let nearby: Vec<&GrassExclusion> = exclusions
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
        // The default meadow is all grass (species 0).
        if i >= grass_limit {
            continue;
        }
        if coverage >= style[0] {
            continue;
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
            width: (0.009 + variation * 0.015) * (1.0 + tallness * 2.0) * (0.7 + style[6] * 0.3),
            lean: (0.18 + lean * 0.6) * (1.0 - tallness * 0.65),
            variation,
            color: [style[2], style[3], style[4]],
            stiffness: style[11] * 0.5 + GRASS_STIFFNESS * 0.5,
        });
    }
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
            generate_patch(px, pz, GRASS_DENSITY_PRETTY, &[], &mut out);
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
    fn exclusions_keep_footprints_bare() {
        let ex = [GrassExclusion { min_x: 1.0, min_z: 1.0, max_x: 6.0, max_z: 6.0 }];
        let mut out = Vec::new();
        generate_patch(0, 0, GRASS_DENSITY_PRETTY, &ex, &mut out);
        assert!(!out.is_empty());
        assert!(out.iter().all(|b| !(b.x >= 1.0 && b.x <= 6.0 && b.z >= 1.0 && b.z <= 6.0)));
    }

    #[test]
    fn lod_density_falls_with_distance() {
        assert_eq!(density_at_distance(0.0), 1.0);
        assert!(density_at_distance(16.0) < 0.5 && density_at_distance(40.0) < 0.2);
    }
}
