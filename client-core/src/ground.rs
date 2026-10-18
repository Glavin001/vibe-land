//! The city ground's look, shared by every renderer: the macro noise the web's ground shader reads
//! (cityTextures.ts `cityMacroNoise`, cityHeroNodes.ts `macroField`) and the parameters that place
//! its dirt patches (cityMaterialShader.ts). A renderer samples the noise texture per pixel; the
//! paint's cover (grass.rs `ground_tint`) adds dirt where the meadow is thin.

/// Edge of the square noise texture, texels (it repeats).
pub const MACRO_NOISE_SIZE: usize = 256;
/// cityMaterialShader.ts tuning: the macro field's largest band, metres per repeat (`cityMacroSize`),
/// and its two smaller bands' weights (`cityMacroMid`, `cityMacroSmall`).
pub const MACRO_SIZE_M: f32 = 9.0;
pub const MACRO_MID: f32 = 0.42;
pub const MACRO_SMALL: f32 = 0.2;
/// groundNodes.ts: the dirt patches read the field at 0.31 × the position, and dirt rises from
/// `groundDirtStart` to `groundDirtEnd` of it.
pub const DIRT_FIELD_SCALE: f32 = 0.31;
pub const DIRT_START: f32 = 0.56;
pub const DIRT_END: f32 = 0.72;

/// `cityMacroNoise`: four octaves of tiling value noise, one byte per texel (row-major, y down
/// the rows). The hash runs in f64 as JavaScript's `Math.sin` does.
pub fn macro_noise() -> Vec<u8> {
    let size = MACRO_NOISE_SIZE;
    let fract = |x: f64| x - x.floor();
    let hash = |x: f64, y: f64, seed: f64| {
        fract((x * 127.1 + y * 311.7 + seed * 74.7).sin() * 43758.5453123)
    };
    let smooth = |t: f64| t * t * (3.0 - 2.0 * t);
    let noise = |x: f64, y: f64, period: f64, seed: f64| {
        let (ix, iy) = (x.floor(), y.floor());
        let wrap = |v: f64| ((v % period) + period) % period;
        let a = hash(wrap(ix), wrap(iy), seed);
        let b = hash(wrap(ix + 1.0), wrap(iy), seed);
        let c = hash(wrap(ix), wrap(iy + 1.0), seed);
        let d = hash(wrap(ix + 1.0), wrap(iy + 1.0), seed);
        let (ux, uy) = (smooth(x - ix), smooth(y - iy));
        (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy
    };
    let mut out = vec![0u8; size * size];
    for y in 0..size {
        for x in 0..size {
            let (u, v) = (x as f64 / size as f64, y as f64 / size as f64);
            let (mut sum, mut amp, mut norm) = (0.0, 0.5, 0.0);
            for octave in 0..4 {
                let period = f64::from(3u32 << octave);
                sum += amp
                    * noise(
                        u * period,
                        v * period,
                        period,
                        55.2 + f64::from(octave) * 17.31,
                    );
                norm += amp;
                amp *= 0.5;
            }
            // JS Math.round (half up).
            out[y * size + x] = ((sum / norm).clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // cityMacroNoise() texels from the TypeScript (tsx): (0, 0), (17, 3), (128, 200), (255, 255),
    // and the sum of all of them.
    #[test]
    fn noise_matches_the_web() {
        let n = macro_noise();
        let at = |x: usize, y: usize| n[y * MACRO_NOISE_SIZE + x];
        assert_eq!(
            [at(0, 0), at(17, 3), at(128, 200), at(255, 255)],
            WEB_TEXELS
        );
        assert_eq!(n.iter().map(|&b| u64::from(b)).sum::<u64>(), WEB_SUM);
    }

    const WEB_TEXELS: [u8; 4] = [136, 128, 120, 136];
    /// The sum of every texel, from the same run.
    const WEB_SUM: u64 = 7955094;
}
