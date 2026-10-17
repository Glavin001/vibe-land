//! Weather presets, shared by every renderer: a port of the web's table
//! (client/src/graphics/weatherPresets.ts, fogSettings.ts). Each preset re-skins the fog that ends
//! sight at the server's area of interest as dust or snow, with a particle volume wrapped around
//! the camera.

use vibe_land_shared::constants::PLAYER_AOI_RADIUS_M;

/// fogSettings.ts `FOG_OPACITY_AT_AOI`: the fog's opacity at the area-of-interest radius.
pub const FOG_OPACITY_AT_AOI: f32 = 0.55;

/// fogSettings.ts `DEFAULT_FOG_SETTINGS`: wind 8 m/s toward compass 45° (0° = server +z).
pub const DEFAULT_WIND_MPS: f32 = 8.0;
pub const DEFAULT_WIND_DIRECTION_DEG: f32 = 45.0;

/// One preset (weatherPresets.ts `WeatherPresetConfig`), in SI units and linear-free sRGB colours.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VlWeather {
    /// Fog and background colour, 0xRRGGBBAA (sRGB).
    pub fog_rgba: u32,
    /// Particles in the volume around the camera (0: none).
    pub particle_count: u32,
    pub particle_rgba: u32,
    /// Sprite size in pixels at 1 m (the web's point size, `size / distance` pixels).
    pub particle_size_px: f32,
    /// 1: additive (snow glows), 0: normal.
    pub additive: u32,
    /// Edge of the cube around the camera the particles wrap inside, metres.
    pub box_m: f32,
    pub fall_mps: f32,
    pub tumble_hz: f32,
    pub tumble_m: f32,
    /// Share of the wind the particles follow (grit drifts less than snow).
    pub wind_follow: f32,
}

pub const VL_WEATHER_CLEAR: u32 = 0;
pub const VL_WEATHER_DUST_STORM: u32 = 1;
pub const VL_WEATHER_SNOW_STORM: u32 = 2;

/// weatherPresets.ts `WEATHER_PRESETS`, in `WEATHER_PRESET_ORDER`.
pub const PRESETS: [VlWeather; 3] = [
    VlWeather { fog_rgba: 0xB7C7_D8FF, particle_count: 0, particle_rgba: 0xFFFF_FFFF, particle_size_px: 0.0, additive: 0, box_m: 60.0, fall_mps: 0.0, tumble_hz: 0.0, tumble_m: 0.0, wind_follow: 0.0 },
    VlWeather { fog_rgba: 0xB899_68FF, particle_count: 3500, particle_rgba: 0xD9B5_7AFF, particle_size_px: 36.0, additive: 0, box_m: 60.0, fall_mps: 1.5, tumble_hz: 0.6, tumble_m: 0.35, wind_follow: 1.0 },
    VlWeather { fog_rgba: 0xE4EC_F3FF, particle_count: 5000, particle_rgba: 0xFFFF_FFFF, particle_size_px: 52.0, additive: 1, box_m: 60.0, fall_mps: 2.5, tumble_hz: 1.1, tumble_m: 0.55, wind_follow: 0.75 },
];

/// The preset names the web stores (`'clear' | 'dust_storm' | 'snow_storm'`).
pub const NAMES: [&str; 3] = ["clear", "dust_storm", "snow_storm"];

pub fn by_name(name: &str) -> Option<u32> {
    NAMES.iter().position(|n| *n == name).map(|i| i as u32)
}

/// fogSettings.ts `fogDensityForAoi`: the FogExp2 density (per metre) whose opacity,
/// 1 − exp(−(ρd)²), reaches [`FOG_OPACITY_AT_AOI`] at `radius_m`.
pub fn fog_exp2_density(radius_m: f32) -> f32 {
    (-(1.0 - FOG_OPACITY_AT_AOI).ln()).sqrt() / radius_m
}

/// The web's default fog density, at the server's area of interest.
pub fn default_fog_exp2_density() -> f32 {
    fog_exp2_density(PLAYER_AOI_RADIUS_M)
}

/// weatherPresets.ts `windVectorFromSettings`: compass 0° → server +z, 90° → +x, metres per second.
pub fn wind_vector(strength_mps: f32, direction_deg: f32) -> [f32; 3] {
    let r = direction_deg.to_radians();
    [r.sin() * strength_mps, 0.0, r.cos() * strength_mps]
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures from the TypeScript (tsx): fogDensityForAoi()'s formula at the 80 m AOI (fogSettings.ts
    // reads import.meta.env, so tsx evaluates its expression) and windVectorFromSettings(8, 45).
    #[test]
    fn fog_and_wind_match_the_web() {
        assert!((default_fog_exp2_density() - 0.011169907_f32).abs() < 1e-7, "{}", default_fog_exp2_density());
        let w = wind_vector(8.0, 45.0);
        assert!((w[0] - 5.656854).abs() < 1e-5 && w[1] == 0.0 && (w[2] - 5.656854).abs() < 1e-5);
        let d = default_fog_exp2_density();
        assert!(((1.0 - (-(d * 80.0).powi(2)).exp()) - FOG_OPACITY_AT_AOI).abs() < 1e-6);
    }

    #[test]
    fn presets_in_the_web_order() {
        assert_eq!(by_name("dust_storm"), Some(VL_WEATHER_DUST_STORM));
        assert_eq!(PRESETS[VL_WEATHER_SNOW_STORM as usize].particle_count, 5000);
        assert_eq!(PRESETS[VL_WEATHER_CLEAR as usize].particle_count, 0);
    }
}
