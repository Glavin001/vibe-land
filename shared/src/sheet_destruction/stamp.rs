//! Deterministic stamp generation for carve events.

use super::materials::SheetMaterial;
use super::mask::SheetMask;
use super::CarveEvent;

/// Counter-based PCG32 — all randomness in the carve pipeline derives from (seed, draw).
#[derive(Clone, Copy, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u32) -> Self {
        let mut rng = Self {
            state: 0,
            inc: ((seed as u64) << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed as u64 | 0x9e3779b97f4a7c15);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6364136223846793005)
            .wrapping_add(self.inc | 1);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Deterministic float in [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
}

/// Value noise on a fixed integer lattice, seeded.
fn value_noise_2d(x: i32, y: i32, seed: u32) -> f32 {
    let mut n = seed
        .wrapping_add(x as u32)
        .wrapping_mul(374761393)
        .wrapping_add(y as u32)
        .wrapping_mul(668265263);
    n = (n ^ (n >> 13)).wrapping_mul(1274126177);
    n ^= n >> 16;
    (n >> 8) as f32 / (1u32 << 24) as f32
}

fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn value_noise_fbm(x: f32, y: f32, seed: u32) -> f32 {
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let fx = smoothstep(x - x0 as f32);
    let fy = smoothstep(y - y0 as f32);
    let n00 = value_noise_2d(x0, y0, seed);
    let n10 = value_noise_2d(x0 + 1, y0, seed);
    let n01 = value_noise_2d(x0, y0 + 1, seed);
    let n11 = value_noise_2d(x0 + 1, y0 + 1, seed);
    let nx0 = n00 + (n10 - n00) * fx;
    let nx1 = n01 + (n11 - n01) * fx;
    // Remap [0,1] → [-1,1]
    (nx0 + (nx1 - nx0) * fy) * 2.0 - 1.0
}

#[derive(Clone, Debug)]
pub struct StampBitMask {
    pub width: u16,
    pub height: u16,
    bits: Vec<u8>,
    /// Inclusive stamped bounds; empty when nothing set.
    pub min_x: u16,
    pub min_y: u16,
    pub max_x: u16,
    pub max_y: u16,
    pub any: bool,
}

impl StampBitMask {
    pub fn new(width: u16, height: u16) -> Self {
        let cells = width as usize * height as usize;
        Self {
            width,
            height,
            bits: vec![0u8; (cells + 7) / 8],
            min_x: width,
            min_y: height,
            max_x: 0,
            max_y: 0,
            any: false,
        }
    }

    pub fn set(&mut self, x: u16, y: u16) {
        if x >= self.width || y >= self.height {
            return;
        }
        let idx = y as usize * self.width as usize + x as usize;
        self.bits[idx / 8] |= 1u8 << (idx % 8);
        if !self.any {
            self.any = true;
            self.min_x = x;
            self.max_x = x;
            self.min_y = y;
            self.max_y = y;
        } else {
            self.min_x = self.min_x.min(x);
            self.max_x = self.max_x.max(x);
            self.min_y = self.min_y.min(y);
            self.max_y = self.max_y.max(y);
        }
    }

    pub fn get(&self, x: u16, y: u16) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        let idx = y as usize * self.width as usize + x as usize;
        (self.bits[idx / 8] >> (idx % 8)) & 1 == 1
    }
}

/// Generate a carve stamp bit region in sheet mask space.
pub fn generate_stamp_mask(
    event: &CarveEvent,
    mat: &SheetMaterial,
    mask: &SheetMask,
) -> StampBitMask {
    let mut stamp = StampBitMask::new(mask.width, mask.height);
    let cell = mask.cell_size;
    // Quantized UV already in meters in sheet local space.
    let cx = event.uv[0];
    let cy = event.uv[1];

    // Base footprint radius (bullet disc). Clamp so tiny calibers still cover ≥1 cell
    // after dilation — sub-cell fidelity is explicitly out of scope.
    // Blunt vehicle/crate footprints already encode the desired hole size; do NOT
    // apply the bullet dilation factor (×6–10) or a 1 m smash becomes a 10 m stamp.
    let base_r = event.footprint_radius.max(cell * 0.5);
    let blunt = base_r >= 0.15;
    let dilated_r = if blunt {
        (base_r * 1.12).max(cell)
    } else {
        (base_r * mat.dilation_factor).max(cell)
    };

    // Sample boundary as a polygon, perturb, then rasterize.
    let circumference = std::f32::consts::TAU * dilated_r;
    // Blunt doorway stamps need denser boundaries than bullet freckles.
    let sample_cap = if blunt { 256 } else { 96 };
    let samples = ((circumference / cell).ceil() as i32).clamp(12, sample_cap) as usize;
    let grain = mat.grain_dir;
    let grain_len = (grain[0] * grain[0] + grain[1] * grain[1]).sqrt().max(1e-6);
    let gdir = [grain[0] / grain_len, grain[1] / grain_len];

    let mut poly: Vec<[f32; 2]> = Vec::with_capacity(samples);
    for i in 0..samples {
        let t = i as f32 / samples as f32;
        let angle = t * std::f32::consts::TAU;
        let nx = angle.cos();
        let ny = angle.sin();
        // Tangential direction for anisotropy.
        let tx = -ny;
        let ty = nx;
        let along = (tx * gdir[0] + ty * gdir[1]).abs();
        let aniso_scale = 1.0 + mat.anisotropy * (along * 2.0 - 1.0);
        let arc = t * circumference;
        let noise = value_noise_fbm(arc * mat.noise_frequency, event.seed as f32 * 0.001, event.seed);
        let r = dilated_r * (1.0 + mat.noise_amplitude * noise * aniso_scale);
        poly.push([cx + nx * r, cy + ny * r]);
    }

    // Optional seam snap for wood boards (horizontal planks every ~0.15 m).
    if mat.seam_snap_dist > 0.0 {
        let plank = 0.15_f32;
        for p in &mut poly {
            let nearest_seam = (p[1] / plank).round() * plank;
            if (p[1] - nearest_seam).abs() <= mat.seam_snap_dist {
                p[1] = nearest_seam;
            }
        }
    }

    rasterize_polygon(&mut stamp, &poly, cell);

    // Guarantee the impact cell is stamped (small discs can miss scanlines).
    let ix = (cx / cell).floor() as i32;
    let iy = (cy / cell).floor() as i32;
    if ix >= 0 && iy >= 0 && (ix as u16) < stamp.width && (iy as u16) < stamp.height {
        stamp.set(ix as u16, iy as u16);
    }
    stamp
}

/// Half-open scanline fill of a simple polygon into the stamp bitmask.
fn rasterize_polygon(stamp: &mut StampBitMask, poly: &[[f32; 2]], cell: f32) {
    if poly.len() < 3 {
        return;
    }
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for p in poly {
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    let y0 = ((min_y / cell).floor() as i32).max(0);
    let y1 = ((max_y / cell).ceil() as i32).min(stamp.height as i32 - 1);
    let n = poly.len();

    for y in y0..=y1 {
        let y_world = (y as f32 + 0.5) * cell;
        let mut xs: Vec<f32> = Vec::new();
        for i in 0..n {
            let a = poly[i];
            let b = poly[(i + 1) % n];
            let (y_a, y_b) = (a[1], b[1]);
            // Half-open: include lower endpoint, exclude upper.
            if (y_a <= y_world && y_b > y_world) || (y_b <= y_world && y_a > y_world) {
                let t = (y_world - y_a) / (y_b - y_a);
                xs.push(a[0] + t * (b[0] - a[0]));
            }
        }
        // Deterministic sort (insertion; n is tiny).
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut i = 0;
        while i + 1 < xs.len() {
            let x_start = ((xs[i] / cell).floor() as i32).max(0);
            let x_end = ((xs[i + 1] / cell).ceil() as i32).min(stamp.width as i32);
            for x in x_start..x_end {
                stamp.set(x as u16, y as u16);
            }
            i += 2;
        }
    }
}

/// Uniform flux over a disc centered at event UV (bullet model).
pub fn bullet_flux_at(event: &CarveEvent, mat: &SheetMaterial, cell_x: u16, cell_y: u16, cell_size: f32) -> f32 {
    let cx = (cell_x as f32 + 0.5) * cell_size;
    let cy = (cell_y as f32 + 0.5) * cell_size;
    let dx = cx - event.uv[0];
    let dy = cy - event.uv[1];
    let base_r = event.footprint_radius.max(cell_size * 0.5);
    let stamp_r = (base_r * mat.dilation_factor * (1.0 + mat.noise_amplitude)).max(cell_size);
    let dist2 = dx * dx + dy * dy;
    if dist2 > stamp_r * stamp_r {
        return 0.0;
    }
    // Momentum is concentrated on a small core (~base footprint), not the full
    // dilated stamp — dilation expands the carved region without diluting energy
    // below breakFlux.
    let p = event.mass_or_energy * event.normal_speed;
    let core_r = base_r.max(cell_size);
    let dist = dist2.sqrt();
    let falloff = (1.0 - dist / stamp_r).max(0.0);
    let peak = if base_r >= 0.15 {
        // Blunt smash: contact pressure stays above breakFlux across the hole.
        // Spreading vehicle momentum over πr² cells would drop below damageFluxMin
        // and carve nothing — which left cars soft-passing then wedging in solid
        // collision.
        (p * 0.05).max(mat.break_flux * 1.25)
    } else {
        let core_area = std::f32::consts::PI * core_r * core_r;
        let core_cells = (core_area / (cell_size * cell_size)).max(1.0);
        // Core gets full peak; outer stamp fringe still exceeds damageFluxMin.
        (p / core_cells) * 2.0
    };
    peak * (0.35 + 0.65 * falloff)
}
