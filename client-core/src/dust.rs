//! How much dust a break makes, and how each parcel of it grows: a port of the web's
//! `city/dustPolicy.ts` (`DustPolicy`, `hash32`, its LCG, `paletteFromAppearance`) and the shape
//! curves and evaluation of `vfx/dustParcelStore.ts` (`DUST_SHAPES`, `evalParcel`).
//!
//! A source ("this much material let go, here, this way") becomes parcels: how many, how big, how
//! thick, thrown where, on sub-linear curves, under a per-tick cap (sources arrive largest-first so
//! the cap keeps the puffs that matter). Every random-looking number comes from a hash of
//! (structure, tick, ordinal, index), so the same fracture makes the same dust on either client.
//! Fractures, entries and crushes keep their 4 m cell smouldering for a while after.
//!
//! Server space (metres, Y up) and f64 throughout, as the TypeScript computes; held equal to it by
//! `tests/dust_parity.rs` on `client/scripts/dust-fixture.mts`'s output. One input the web has and
//! this does not: the renderer's room measurement (`clearanceOf`), which keeps a parcel out of the
//! walls; without it (as on the web before a city is measured) parcels are born on the side the
//! source names.

/// What kind of cloud: picks the growth curve, not the colour (`DustShape`).
pub const VL_DUST_FRACTURE: u32 = 0;
pub const VL_DUST_IMPACT: u32 = 1;
pub const VL_DUST_SMOULDER: u32 = 2;
pub const VL_DUST_ENTRY: u32 = 3;
pub const VL_DUST_WAVE: u32 = 4;

/// What the dust is made of (`DustPalette`): concrete, wood, metal; glass makes none.
pub const VL_PALETTE_CONCRETE: u32 = 0;
pub const VL_PALETTE_WOOD: u32 = 1;
pub const VL_PALETTE_METAL: u32 = 2;
pub const VL_PALETTE_NONE: u32 = 3;

/// The source kinds the policy distinguishes (destructionEvents.ts `DustSourceKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DustKind {
    Fracture,
    Crush,
    Impact,
    Entry,
    Shed,
    Wave,
}

/// One dust source (destructionEvents.ts `DustSource`), server space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DustSource {
    pub kind: DustKind,
    pub structure: u32,
    pub tick: u32,
    pub ordinal: u32,
    pub position: [f64; 3],
    pub normal: [f64; 3],
    /// Mean velocity of the emitting material, m/s.
    pub velocity: [f64; 3],
    pub magnitude: f64,
    pub material: u32,
    pub at_ms: f64,
}

/// One parcel of dust (dustParcelStore.ts `DustParcel`, without the room measurement). A
/// renderer keeps it until its shape's life is over and draws it through [`eval_parcel`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlDustParcel {
    /// Birth position and the push it was thrown with (server space, or the renderer's: see
    /// `ClientCore`), m and m/s.
    pub position: [f32; 3],
    pub velocity: [f32; 3],
    pub radius0: f32,
    /// Optical thickness, 0..1.
    pub intensity: f32,
    /// When it was born, in the core's clock (ms).
    pub born_ms: f64,
    pub seed: u32,
    /// `VL_DUST_*`.
    pub shape: u32,
    /// `VL_PALETTE_*`.
    pub palette: u32,
    /// Its age when the frame carried it, s (a smoulder parcel can be born a little before).
    pub age_s: f32,
    /// The palette's colour (the web's dust renderers'), 0xRRGGBBAA.
    pub color_rgba: u32,
    pub _pad: u32,
}

/// The web's dust colour per palette (DustSprites.tsx, DustVolumeRenderer.ts): concrete #b3afa8,
/// wood #8f7250, metal #66686c.
pub fn palette_rgba(palette: u32) -> u32 {
    match palette {
        VL_PALETTE_WOOD => 0x8f72_50ff,
        VL_PALETTE_METAL => 0x6668_6cff,
        _ => 0xb3af_a8ff,
    }
}

impl Parcel {
    /// For a renderer in `space`, at the core's `now_ms`.
    pub fn to_vl(&self, now_ms: f64, space: crate::coords::Space) -> VlDustParcel {
        let v = |a: [f64; 3]| glam::Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32);
        VlDustParcel {
            position: space.pos(v(self.position)),
            velocity: space.pos(v(self.velocity)),
            radius0: self.radius0 as f32 * space.metres(),
            intensity: self.intensity as f32,
            born_ms: self.born_ms,
            seed: self.seed,
            shape: self.shape,
            palette: self.palette,
            age_s: ((now_ms - self.born_ms) / 1000.0).max(0.0) as f32,
            color_rgba: palette_rgba(self.palette),
            _pad: 0,
        }
    }
}

/// [`eval_parcel`] for a renderer's parcel `p` at age `age_s`, in a wind of `wind` (server space,
/// m/s): the cloud's box in the renderer's space, or `None` once its life is over.
pub fn eval_vl(
    p: &VlDustParcel,
    age_s: f32,
    wind: [f32; 3],
    space: crate::coords::Space,
) -> Option<VlDustEval> {
    let to_server = |a: [f32; 3]| {
        let s = space.pos_to_server(a);
        [f64::from(s.x), f64::from(s.y), f64::from(s.z)]
    };
    let parcel = Parcel {
        born_ms: 0.0,
        position: to_server(p.position),
        velocity: to_server(p.velocity),
        radius0: f64::from(p.radius0 / space.metres()),
        intensity: f64::from(p.intensity),
        seed: p.seed,
        shape: p.shape,
        palette: p.palette,
    };
    let ((c, size), r, t, fraction) = eval_parcel(
        &parcel,
        f64::from(age_s) * 1000.0,
        f64::from(wind[0]),
        f64::from(wind[2]),
    )?;
    let centre = space.pos(glam::Vec3::new(c[0] as f32, c[1] as f32, c[2] as f32));
    let size = space
        .pos(glam::Vec3::new(
            size[0] as f32,
            size[1] as f32,
            size[2] as f32,
        ))
        .map(f32::abs);
    Some(VlDustEval {
        centre,
        size,
        radius: r as f32 * space.metres(),
        age_s: t as f32,
        life_fraction: fraction as f32,
        density: DUST_SHAPES[p.shape as usize].density as f32,
        erosion: (DUST_SHAPES[p.shape as usize].erosion * fraction) as f32,
    })
}

/// Parcel as spawned, f64, before the renderer's space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Parcel {
    pub born_ms: f64,
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub radius0: f64,
    pub intensity: f64,
    pub seed: u32,
    pub shape: u32,
    pub palette: u32,
}

/// A shape's growth curve (`DustShapeCurve`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapeCurve {
    /// Radius at birth, before the parcel's scale.
    pub r0: f64,
    /// Radius grows as sqrt(age) * growth.
    pub growth: f64,
    /// Total rise, m, approached as 1 - e^(-0.35 age).
    pub rise: f64,
    /// Seconds until the parcel is gone.
    pub life: f64,
    /// Height / width.
    pub aspect_y: f64,
    /// Initial-velocity drag rate, 1/s.
    pub drag: f64,
    pub density: f64,
    pub erosion: f64,
}

/// Indexed by shape (`DUST_SHAPES`).
pub const DUST_SHAPES: [ShapeCurve; 5] = [
    ShapeCurve {
        r0: 1.0,
        growth: 0.9,
        rise: 2.0,
        life: 10.0,
        aspect_y: 0.75,
        drag: 1.4,
        density: 1.6,
        erosion: 0.55,
    },
    ShapeCurve {
        r0: 1.2,
        growth: 1.3,
        rise: 1.2,
        life: 14.0,
        aspect_y: 0.40,
        drag: 1.4,
        density: 1.2,
        erosion: 0.50,
    },
    ShapeCurve {
        r0: 0.8,
        growth: 0.9,
        rise: 2.0,
        life: 12.0,
        aspect_y: 0.90,
        drag: 0.9,
        density: 0.7,
        erosion: 0.60,
    },
    ShapeCurve {
        r0: 0.6,
        growth: 1.1,
        rise: 0.4,
        life: 5.0,
        aspect_y: 0.80,
        drag: 2.2,
        density: 1.8,
        erosion: 0.70,
    },
    ShapeCurve {
        r0: 1.5,
        growth: 1.6,
        rise: 0.8,
        life: 24.0,
        aspect_y: 0.30,
        drag: 0.8,
        density: 1.0,
        erosion: 0.45,
    },
];

/// A parcel drawn now (`DustEval`): the cloud's box centre and size, server space.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlDustEval {
    pub centre: [f32; 3],
    pub size: [f32; 3],
    pub radius: f32,
    pub age_s: f32,
    /// age / life, 0..1.
    pub life_fraction: f32,
    pub density: f32,
    /// How much of the cloud the erosion noise has eaten by now: the shape's erosion times the
    /// life fraction (dustParcelStore.ts `DustShapeCurve::erosion`).
    pub erosion: f32,
}

/// `evalParcel` without the room measurement: where parcel `p` is at `now_ms` in a wind of
/// (`wind_x`, `wind_z`) m/s, or `None` before its birth or after its life.
pub fn eval_parcel(
    p: &Parcel,
    now_ms: f64,
    wind_x: f64,
    wind_z: f64,
) -> Option<(([f64; 3], [f64; 3]), f64, f64, f64)> {
    let curve = DUST_SHAPES.get(p.shape as usize)?;
    let t = (now_ms - p.born_ms) / 1000.0;
    if t < 0.0 || t >= curve.life {
        return None;
    }
    let r = (curve.r0 + t.sqrt() * curve.growth) * p.radius0;
    let spent = (1.0 - (-curve.drag * t).exp()) / curve.drag;
    let rise = curve.rise * (1.0 - (-0.35 * t).exp());
    let carried = t - spent;
    let c = [
        p.position[0] + p.velocity[0] * spent + wind_x * carried * 0.35,
        p.position[1] + p.velocity[1] * spent + rise,
        p.position[2] + p.velocity[2] * spent + wind_z * carried * 0.35,
    ];
    let size = [r * 2.0, r * curve.aspect_y * 2.0, r * 2.0];
    Some(((c, size), r, t, t / curve.life))
}

/// The policy's knobs (`DustPolicyConfig`, `DEFAULT_DUST_POLICY`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DustPolicyConfig {
    pub parcels_per_tick_cap: u32,
    pub parcels_per_source_max: u32,
    pub parcels_scale: f64,
    pub radius_scale: f64,
    pub radius_min: f64,
    pub radius_max: f64,
    pub smoulder_hold_ms: f64,
    pub smoulder_interval_ms: f64,
    pub smoulder_max_cells: usize,
    pub smoulder_cell_m: f64,
    pub normal_offset_m: f64,
}

impl Default for DustPolicyConfig {
    fn default() -> Self {
        Self {
            parcels_per_tick_cap: 32,
            parcels_per_source_max: 8,
            parcels_scale: 0.55,
            radius_scale: 0.45,
            radius_min: 0.4,
            radius_max: 3.0,
            smoulder_hold_ms: 1500.0,
            smoulder_interval_ms: 350.0,
            smoulder_max_cells: 16,
            smoulder_cell_m: 4.0,
            normal_offset_m: 0.4,
        }
    }
}

/// How thick each palette's dust is (`PALETTE_FACTOR`).
pub fn palette_factor(palette: u32) -> f64 {
    match palette {
        VL_PALETTE_CONCRETE => 1.0,
        VL_PALETTE_WOOD => 0.7,
        VL_PALETTE_METAL => 0.3,
        _ => 0.0,
    }
}

/// `paletteFromAppearance`: what a material looks like as dust, by its appearance name and texture
/// key (absent: concrete).
pub fn palette_from_appearance(name: Option<&str>, texture_key: Option<&str>) -> u32 {
    let text = format!("{} {}", name.unwrap_or(""), texture_key.unwrap_or("")).to_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| text.contains(w));
    if any(&["glass", "glazing", "window"]) {
        VL_PALETTE_NONE
    } else if any(&["wood", "timber", "plank"]) {
        VL_PALETTE_WOOD
    } else if any(&["steel", "metal", "iron", "girder"]) {
        VL_PALETTE_METAL
    } else {
        VL_PALETTE_CONCRETE
    }
}

fn imul(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

/// `hash32`: a 32-bit mix of four ints (the JavaScript's i32 arguments, as u32).
pub fn hash32(a: u32, b: u32, c: u32, d: u32) -> u32 {
    let mut h = imul(a, 0x9e37_79b1);
    h = imul(h ^ b.wrapping_add(0x85eb_ca77), 0xc2b2_ae3d) ^ (h >> 15);
    h = imul(h ^ c.wrapping_add(0x27d4_eb2f), 0x1656_67b1) ^ (h >> 13);
    h = imul(h ^ d.wrapping_add(0x9e37_79b1), 0x85eb_ca77) ^ (h >> 16);
    h
}

/// The policy's LCG on a seed: unit floats, deterministic.
struct Rng {
    state: u32,
}

impl Rng {
    fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 1 } else { seed },
        }
    }
    fn next(&mut self) -> f64 {
        self.state = imul(self.state, 1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.state) / 4_294_967_296.0
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
}

struct SmoulderCell {
    position: [f64; 3],
    structure: u32,
    ordinal: u32,
    last_fed_ms: f64,
    next_ms: f64,
    magnitude: f64,
    palette: u32,
    serial: u32,
}

/// Counters (`DustPolicyStats`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DustPolicyStats {
    pub emitted: u64,
    pub dropped_by_tick_cap: u64,
    pub dropped_by_palette: u64,
    pub smoulder_cells: usize,
}

/// `DustPolicy`.
pub struct DustPolicy {
    pub config: DustPolicyConfig,
    pub stats: DustPolicyStats,
    current_tick: i64,
    tick_budget: u32,
    /// Smoulder cells in insertion order (a JavaScript `Map` iterates so: the eviction and the
    /// emission order follow it).
    smoulder: Vec<(u32, SmoulderCell)>,
}

impl Default for DustPolicy {
    fn default() -> Self {
        Self::new(DustPolicyConfig::default())
    }
}

impl DustPolicy {
    pub fn new(config: DustPolicyConfig) -> Self {
        Self {
            config,
            stats: DustPolicyStats::default(),
            current_tick: -1,
            tick_budget: 0,
            smoulder: Vec::new(),
        }
    }

    /// Burst emission for one source of palette `palette`, into `out`; returns parcels spawned.
    pub fn emit(&mut self, source: &DustSource, palette: u32, out: &mut Vec<Parcel>) -> u32 {
        let cfg = self.config;
        if i64::from(source.tick) != self.current_tick {
            self.current_tick = i64::from(source.tick);
            self.tick_budget = cfg.parcels_per_tick_cap;
        }
        let factor = palette_factor(palette);
        if factor <= 0.0 {
            self.stats.dropped_by_palette += 1;
            return 0;
        }
        let m = source.magnitude.max(0.0);
        // Math.round: halves round up.
        let mut n = ((cfg.parcels_scale * m.sqrt() + 0.5).floor() as u32)
            .clamp(1, cfg.parcels_per_source_max.max(1));
        let kind = source.kind;
        if kind == DustKind::Wave {
            n = n.max(6);
        }
        if n > self.tick_budget {
            self.stats.dropped_by_tick_cap += u64::from(n - self.tick_budget);
            n = self.tick_budget;
        }
        if n == 0 {
            return 0;
        }
        self.tick_budget -= n;

        let wave = kind == DustKind::Wave;
        let impact = kind == DustKind::Impact || wave;
        let entry = kind == DustKind::Entry;
        let radius0 = (cfg.radius_scale * m.cbrt()).clamp(cfg.radius_min, cfg.radius_max)
            * if wave {
                2.0
            } else if impact {
                1.5
            } else if entry {
                0.6
            } else {
                1.0
            };
        let intensity = (0.35 + 0.15 * (1.0 + m).log2()).min(1.0) * factor;
        let shape = if wave {
            VL_DUST_WAVE
        } else if impact {
            VL_DUST_IMPACT
        } else if entry {
            VL_DUST_ENTRY
        } else {
            VL_DUST_FRACTURE
        };
        let [mut nx, mut ny, mut nz] = source.normal;
        let o = [
            source.position[0] + nx * cfg.normal_offset_m,
            source.position[1] + ny * cfg.normal_offset_m,
            source.position[2] + nz * cfg.normal_offset_m,
        ];
        // A tangent basis around the normal, for the discs and the ring.
        let nl = (nx * nx + ny * ny + nz * nz).sqrt();
        if nl < 1e-6 {
            (nx, ny, nz) = (0.0, 1.0, 0.0);
        } else {
            (nx, ny, nz) = (nx / nl, ny / nl, nz / nl);
        }
        let (hx, hy) = if ny.abs() < 0.9 {
            (0.0, 1.0)
        } else {
            (1.0, 0.0)
        };
        let (mut tx, mut ty, mut tz) = (hy * nz - 0.0 * ny, 0.0 * nx - hx * nz, hx * ny - hy * nx);
        let tl = (tx * tx + ty * ty + tz * tz).sqrt();
        let tl = if tl == 0.0 { 1.0 } else { tl };
        (tx, ty, tz) = (tx / tl, ty / tl, tz / tl);
        let (bx, by, bz) = (ny * tz - nz * ty, nz * tx - nx * tz, nx * ty - ny * tx);
        let [svx, svy, svz] = source.velocity;
        let [snx, sny, snz] = source.normal;

        for i in 0..n {
            let seed = hash32(source.structure, source.tick, source.ordinal, i);
            let mut rng = Rng::new(seed);
            let theta = if wave {
                (f64::from(i) / f64::from(n)) * std::f64::consts::PI * 2.0 + rng.range(-0.3, 0.3)
            } else {
                rng.range(0.0, std::f64::consts::PI * 2.0)
            };
            let (ct, st) = (theta.cos(), theta.sin());
            let (position, velocity);
            if wave {
                let r = radius0 * 0.8;
                position = [
                    o[0] + (tx * ct + bx * st) * r,
                    o[1] + 0.3,
                    o[2] + (tz * ct + bz * st) * r,
                ];
                let push = rng.range(5.0, 9.0);
                velocity = [(tx * ct + bx * st) * push, 0.3, (tz * ct + bz * st) * push];
            } else if impact {
                let r = radius0 * 1.2 * rng.next().sqrt();
                position = [
                    o[0] + (tx * ct + bx * st) * r,
                    o[1] + (ty * ct + by * st) * r + ny * 0.2,
                    o[2] + (tz * ct + bz * st) * r,
                ];
                let push = rng.range(1.5, 3.0);
                velocity = [
                    (tx * ct + bx * st) * push,
                    (ty * ct + by * st) * push,
                    (tz * ct + bz * st) * push,
                ];
            } else if entry {
                let r = radius0 * 0.5 * rng.next().sqrt();
                position = [
                    o[0] + (tx * ct + bx * st) * r,
                    o[1] + (ty * ct + by * st) * r,
                    o[2] + (tz * ct + bz * st) * r,
                ];
                let push = rng.range(4.0, 8.0);
                let spread = rng.range(0.0, 0.35);
                velocity = [
                    svx + (nx + (tx * ct + bx * st) * spread) * push,
                    svy + (ny + (ty * ct + by * st) * spread) * push,
                    svz + (nz + (tz * ct + bz * st) * spread) * push,
                ];
            } else {
                let r = radius0 * 0.6 * rng.next().cbrt();
                let phi = rng.range(-1.0, 1.0).acos();
                position = [
                    o[0] + phi.sin() * ct * r,
                    o[1] + phi.cos() * r,
                    o[2] + phi.sin() * st * r,
                ];
                let push = rng.range(0.5, 1.5);
                let phi2 = rng.range(-1.0, 1.0).acos();
                let theta2 = rng.range(0.0, std::f64::consts::PI * 2.0);
                velocity = [
                    svx + phi2.sin() * theta2.cos() * push + snx * push,
                    svy + phi2.cos() * push + 0.8 + sny * push,
                    svz + phi2.sin() * theta2.sin() * push + snz * push,
                ];
            }
            let radius = radius0 * rng.range(0.8, 1.2);
            let thickness = intensity * rng.range(0.8, 1.0);
            out.push(Parcel {
                born_ms: source.at_ms,
                position,
                velocity,
                radius0: radius,
                intensity: thickness,
                seed,
                shape,
                palette,
            });
        }
        self.stats.emitted += u64::from(n);
        if matches!(kind, DustKind::Fracture | DustKind::Entry | DustKind::Crush) {
            self.feed_smoulder(source, palette);
        }
        n
    }

    /// Keeps a cell smouldering after a break; more breaks there keep it going.
    fn feed_smoulder(&mut self, source: &DustSource, palette: u32) {
        let size = self.config.smoulder_cell_m;
        let cell = |v: f64| ((v / size).floor() as i64 + 100_000) as u32;
        let key = hash32(
            source.structure,
            cell(source.position[0]),
            cell(source.position[1]),
            cell(source.position[2]),
        );
        if let Some((_, c)) = self.smoulder.iter_mut().find(|(k, _)| *k == key) {
            c.last_fed_ms = source.at_ms;
            c.magnitude = c.magnitude.max(source.magnitude);
            return;
        }
        if self.smoulder.len() >= self.config.smoulder_max_cells {
            // The stalest (first in insertion order on a tie, as the JavaScript's strict `<`).
            let mut stalest: Option<usize> = None;
            let mut stalest_ms = f64::INFINITY;
            for (i, (_, c)) in self.smoulder.iter().enumerate() {
                if c.last_fed_ms < stalest_ms {
                    stalest_ms = c.last_fed_ms;
                    stalest = Some(i);
                }
            }
            if let Some(i) = stalest {
                self.smoulder.remove(i);
            }
        }
        self.smoulder.push((
            key,
            SmoulderCell {
                position: source.position,
                structure: source.structure,
                ordinal: source.ordinal,
                last_fed_ms: source.at_ms,
                next_ms: source.at_ms + self.config.smoulder_interval_ms,
                magnitude: source.magnitude,
                palette,
                serial: 0,
            },
        ));
    }

    /// Per frame: advances the smoulder emitters, into `out`.
    pub fn tick(&mut self, now_ms: f64, out: &mut Vec<Parcel>) {
        let cfg = self.config;
        let mut emitted = 0u64;
        self.smoulder.retain_mut(|(_, cell)| {
            if now_ms - cell.last_fed_ms > cfg.smoulder_hold_ms {
                return false;
            }
            // Bounded catch-up after a stall: never more than one interval behind.
            cell.next_ms = cell.next_ms.max(now_ms - cfg.smoulder_interval_ms);
            while cell.next_ms <= now_ms {
                let seed = hash32(cell.structure, 0xfff0, cell.ordinal, cell.serial);
                cell.serial += 1;
                let mut rng = Rng::new(seed);
                let theta = rng.range(0.0, std::f64::consts::PI * 2.0);
                let r = rng.range(0.0, 1.5);
                let position = [
                    cell.position[0] + theta.cos() * r,
                    cell.position[1] + rng.range(-0.5, 0.5),
                    cell.position[2] + theta.sin() * r,
                ];
                let velocity = [rng.range(-0.3, 0.3), 0.6, rng.range(-0.3, 0.3)];
                out.push(Parcel {
                    born_ms: cell.next_ms,
                    position,
                    velocity,
                    radius0: 0.8,
                    intensity: 0.25
                        * (cell.magnitude / 40.0).min(1.0)
                        * palette_factor(cell.palette),
                    seed,
                    shape: VL_DUST_SMOULDER,
                    palette: cell.palette,
                });
                emitted += 1;
                cell.next_ms += cfg.smoulder_interval_ms;
            }
            true
        });
        self.stats.emitted += emitted;
        self.stats.smoulder_cells = self.smoulder.len();
    }

    pub fn clear(&mut self) {
        self.smoulder.clear();
        self.current_tick = -1;
        self.tick_budget = 0;
        self.stats.smoulder_cells = 0;
    }
}
