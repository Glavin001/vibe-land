//! Weather presets, shared by every renderer: shared/assets/weather/presets.json (the table the
//! web's weatherPresets.ts imports too) and fogSettings.ts's fog density. Each preset re-skins the
//! fog that ends sight at the server's area of interest as dust or snow, with a particle volume
//! wrapped around the camera.

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

/// The presets file both clients read (the web's weatherPresets.ts imports it too).
pub const PRESETS_JSON: &str = include_str!("../../shared/assets/weather/presets.json");

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    fog_color: String,
    particle_count: u32,
    particle_color: String,
    particle_size_px: f32,
    particle_blending: String,
    box_size_m: f32,
    fall_speed_mps: f32,
    tumble_hz: f32,
    tumble_amplitude_m: f32,
    wind_follow: f32,
}

#[derive(serde::Deserialize)]
struct Table {
    order: Vec<String>,
    presets: std::collections::HashMap<String, Preset>,
}

struct Presets {
    names: Vec<String>,
    presets: Vec<VlWeather>,
}

fn rgba(hex: &str) -> u32 {
    u32::from_str_radix(hex.trim_start_matches('#'), 16).map_or(0xFFFF_FFFF, |rgb| rgb << 8 | 0xFF)
}

fn table() -> &'static Presets {
    static TABLE: std::sync::OnceLock<Presets> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let t: Table = serde_json::from_str(PRESETS_JSON).expect("shared/assets/weather/presets.json");
        let presets = t
            .order
            .iter()
            .map(|name| {
                let p = &t.presets[name];
                VlWeather {
                    fog_rgba: rgba(&p.fog_color),
                    particle_count: p.particle_count,
                    particle_rgba: rgba(&p.particle_color),
                    particle_size_px: p.particle_size_px,
                    additive: u32::from(p.particle_blending == "additive"),
                    box_m: p.box_size_m,
                    fall_mps: p.fall_speed_mps,
                    tumble_hz: p.tumble_hz,
                    tumble_m: p.tumble_amplitude_m,
                    wind_follow: p.wind_follow,
                }
            })
            .collect();
        Presets { names: t.order, presets }
    })
}

/// The presets in the shared order (`VL_WEATHER_*`).
pub fn presets() -> &'static [VlWeather] {
    &table().presets
}

/// A preset's index from its name (`clear`, `dust_storm`, `snow_storm`).
pub fn by_name(name: &str) -> Option<u32> {
    table().names.iter().position(|n| n == name).map(|i| i as u32)
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
        assert_eq!(presets()[VL_WEATHER_SNOW_STORM as usize].particle_count, 5000);
        assert_eq!(presets()[VL_WEATHER_CLEAR as usize].particle_count, 0);
        assert_eq!(presets()[VL_WEATHER_DUST_STORM as usize].fog_rgba, 0xB899_68FF);
        assert_eq!(presets()[VL_WEATHER_SNOW_STORM as usize].additive, 1);
    }
}
