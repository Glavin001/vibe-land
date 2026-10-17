//! Car meshes from a prepared vehicle's `metadata.json` (`GET /vehicle-assets/<geometryHash>/
//! metadata.json`; the server's `vehicle_assets::PreparedGeometry`), for clients that draw cars
//! from the same parts the physics simulates.
//!
//! Every part is the convex hulls of its shapes, flat-shaded, in the car's actor frame: the
//! asset's source frame (+Y up, -Z front, metres) less `originHeight` in Y, as the web draws it
//! (`VehicleVisual.ts`, `group.position.y = -originHeight`). A shape's vertex sits at
//! `part.position + shape.position + v` (`vehicle_assets/fracture.rs`).
//!
//! Parts that move with a wheel are split out by corner, so a renderer can pose them from the
//! stream's wheel states (`VlCar::wheels`; stream wheel `i` is corner `["fr","fl","rr","rl"][i]`,
//! `configuration.mjs` `sourceCornerForWheel`): the wheel and hub spin about the car's X axis,
//! steer about Y and ride the suspension travel in Y; the knuckle steers and travels without
//! spinning. The suspension arms, springs and dampers stay at rest here (the web solves their
//! kinematics, `dune/visual-rig.mjs`; that is a follow-up).
//!
//! Colours are the web's palette (`dune/buggy.mjs` `materials`) with the car's configured paint
//! (`configuration.appearance`) applied as `VehicleVisual.ts` does.

use glam::Vec3;
use serde_json::Value;

use crate::coords::Space;
use crate::geometry::{convex_hull_triangles, flips_handedness};

/// Stream wheel index to rig corner (`configuration.mjs` `sourceCornerForWheel`).
pub const WHEEL_CORNERS: [&str; 4] = ["fr", "fl", "rr", "rl"];

/// [`VlVehicleVertex::section`]: the chassis (everything not posed by a wheel).
pub const VL_VEHICLE_SECTION_CHASSIS: u32 = 0;
/// Sections 1..=4: stream wheel `section - 1`'s spinning parts (wheel, hub).
pub const VL_VEHICLE_SECTION_WHEEL: u32 = 1;
/// Sections 5..=8: stream wheel `section - 5`'s steering parts that do not spin (knuckle).
pub const VL_VEHICLE_SECTION_KNUCKLE: u32 = 5;
pub const VL_VEHICLE_SECTIONS: u32 = 9;

/// One vertex of a car mesh, in the renderer's space and the car's actor frame. Three per triangle.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlVehicleVertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    /// 0xRRGGBBAA.
    pub color_rgba: u32,
    /// `VL_VEHICLE_SECTION_*`.
    pub section: u32,
}

/// A car mesh: triangles, and each wheel's hub (the pivot its sections turn about), actor frame.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VehicleMesh {
    pub vertices: Vec<VlVehicleVertex>,
    pub hubs: [[f32; 3]; 4],
    /// Tyre radius in the renderer's units.
    pub wheel_radius: f32,
}

#[derive(Debug, PartialEq)]
pub enum VehicleMeshError {
    Json(String),
    Missing(&'static str),
}

impl std::fmt::Display for VehicleMeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VehicleMeshError::Json(e) => write!(f, "vehicle metadata is not valid JSON: {e}"),
            VehicleMeshError::Missing(what) => write!(f, "vehicle metadata has no {what}"),
        }
    }
}

impl std::error::Error for VehicleMeshError {}

/// The web's palette (`dune/buggy.mjs` `materials`), 0xRRGGBB.
fn palette(material: &str) -> u32 {
    match material {
        "frame" => 0x344a4b,
        "orange" => 0xf36b29,
        "rubber" => 0x202224,
        "alloy" => 0xb0afa4,
        "steel" => 0x69737a,
        "dark" | "housing" => 0x242a2d,
        "seat" => 0x242729,
        "belt" => 0xd96b35,
        "red" => 0xb62e25,
        "glass" => 0x203c47,
        "race" => 0xeee7d4,
        "lens" => 0xe7e3c7,
        _ => 0x808080,
    }
}

fn hex_color(value: Option<&Value>) -> Option<u32> {
    let s = value?.as_str()?.trim_start_matches('#');
    (s.len() == 6).then(|| u32::from_str_radix(s, 16).ok()).flatten()
}

/// A part's colour: the palette, then the configured paint (`VehicleVisual.ts`: finish on frame,
/// body paint on the Body system's frame parts, accent on orange/belt/race, wheel paint on the
/// Wheels system's alloy, seats on seat).
fn part_color(material: &str, system: &str, configuration: Option<&Value>) -> u32 {
    let appearance = configuration.and_then(|c| c.get("appearance"));
    let paint = |key: &str| hex_color(appearance.and_then(|a| a.get(key)));
    let rgb = match material {
        "frame" if system == "Body" => paint("body").or_else(|| hex_color(configuration.and_then(|c| c.get("finish")))),
        "frame" => hex_color(configuration.and_then(|c| c.get("finish"))),
        "orange" | "belt" | "race" => paint("accent"),
        "alloy" if system == "Wheels" => paint("wheels"),
        "seat" => paint("seats"),
        _ => None,
    }
    .unwrap_or_else(|| palette(material));
    (rgb << 8) | 0xFF
}

fn vec3(v: Option<&Value>) -> Option<Vec3> {
    let a = v?.as_array()?;
    Some(Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32))
}

/// Build a car's mesh from its `metadata.json`, with its `configuration` (the vehicle asset's, for
/// paint; optional).
pub fn build_vehicle_mesh(metadata: &[u8], configuration: Option<&Value>, space: Space) -> Result<VehicleMesh, VehicleMeshError> {
    let meta: Value = serde_json::from_slice(metadata).map_err(|e| VehicleMeshError::Json(e.to_string()))?;
    let origin_height = meta.get("originHeight").and_then(Value::as_f64).ok_or(VehicleMeshError::Missing("originHeight"))? as f32;
    let parts = meta.get("parts").and_then(Value::as_array).ok_or(VehicleMeshError::Missing("parts"))?;
    let corners = meta.get("rig").and_then(|r| r.get("corners"));
    let to_actor = |p: Vec3| p - Vec3::Y * origin_height;

    let mut hubs = [[0.0f32; 3]; 4];
    for (i, corner) in WHEEL_CORNERS.iter().enumerate() {
        let hub = vec3(corners.and_then(|c| c.get(*corner)).and_then(|c| c.get("hub"))).ok_or(VehicleMeshError::Missing("rig hubs"))?;
        hubs[i] = space.pos(to_actor(hub));
    }
    let radius = meta
        .get("dimensions")
        .and_then(|d| d.get("tireRadius"))
        .and_then(Value::as_f64)
        .unwrap_or(f64::from(origin_height) - 0.25) as f32;

    let flip = flips_handedness(space);
    let mut vertices = Vec::new();
    let mut triangles = Vec::new();
    for part in parts {
        let Some(position) = vec3(part.get("position")) else { continue };
        let material = part.get("material").and_then(Value::as_str).unwrap_or("");
        let system = part.get("system").and_then(Value::as_str).unwrap_or("");
        let color = part_color(material, system, configuration);
        let motion = part.get("motion");
        let role = motion.and_then(|m| m.get("role")).and_then(Value::as_str);
        let corner = motion.and_then(|m| m.get("corner")).and_then(Value::as_str);
        let wheel = corner.and_then(|c| WHEEL_CORNERS.iter().position(|w| *w == c)).map(|i| i as u32);
        let section = match (role, wheel) {
            (Some("wheel" | "hub"), Some(i)) => VL_VEHICLE_SECTION_WHEEL + i,
            (Some("knuckle"), Some(i)) => VL_VEHICLE_SECTION_KNUCKLE + i,
            _ => VL_VEHICLE_SECTION_CHASSIS,
        };
        for shape in part.get("shapes").and_then(Value::as_array).into_iter().flatten() {
            let Some(offset) = vec3(shape.get("position")) else { continue };
            let base = position + offset;
            let mut points = Vec::new();
            for v in shape.get("vertices").and_then(Value::as_array).into_iter().flatten() {
                if let Some(v) = vec3(Some(v)) {
                    let p = to_actor(base + v);
                    points.extend_from_slice(&[p.x, p.y, p.z]);
                }
            }
            triangles.clear();
            if !convex_hull_triangles(&points, &mut triangles) {
                continue;
            }
            for [a, b, c] in &triangles {
                let n = (*b - *a).cross(*c - *a).normalize_or_zero();
                let normal = {
                    let m = space.pos(n);
                    let l = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt().max(1e-12);
                    [m[0] / l, m[1] / l, m[2] / l]
                };
                let corners = if flip { [*a, *c, *b] } else { [*a, *b, *c] };
                for p in corners {
                    vertices.push(VlVehicleVertex { pos: space.pos(p), normal, color_rgba: color, section });
                }
            }
        }
    }
    if vertices.is_empty() {
        return Err(VehicleMeshError::Missing("shapes with volume"));
    }
    Ok(VehicleMesh { vertices, hubs, wheel_radius: radius * space.metres() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A two-part car: a chassis box and the front-right wheel (a box standing in for its tyre).
    fn tiny_car() -> Vec<u8> {
        let cube = |h: f32| {
            let mut v = Vec::new();
            for x in [-h, h] {
                for y in [-h, h] {
                    for z in [-h, h] {
                        v.push(serde_json::json!([x, y, z]));
                    }
                }
            }
            v
        };
        let corner = |hub: [f32; 3]| serde_json::json!({ "hub": hub });
        serde_json::to_vec(&serde_json::json!({
            "originHeight": 1.0,
            "dimensions": { "tireRadius": 0.5 },
            "rig": { "corners": {
                "fr": corner([1.0, 0.5, -1.5]), "fl": corner([-1.0, 0.5, -1.5]),
                "rr": corner([1.0, 0.5, 1.5]), "rl": corner([-1.0, 0.5, 1.5]),
            }},
            "parts": [
                { "position": [0.0, 1.0, 0.0], "material": "frame", "system": "Body", "motion": null,
                  "shapes": [{ "position": [0.0, 0.0, 0.0], "vertices": cube(0.5) }] },
                { "position": [1.0, 0.5, -1.5], "material": "rubber", "system": "Wheels",
                  "motion": { "corner": "fr", "role": "wheel" },
                  "shapes": [{ "position": [0.0, 0.0, 0.0], "vertices": cube(0.25) }] },
            ],
        }))
        .unwrap()
    }

    #[test]
    fn parts_become_closed_hulls_in_the_actor_frame() {
        let mesh = build_vehicle_mesh(&tiny_car(), None, Space::Server).unwrap();
        assert_eq!(mesh.vertices.len() % 3, 0);
        // A cube's hull is 12 triangles: two cubes, 72 vertices.
        assert_eq!(mesh.vertices.len(), 72);
        // The chassis cube is centred at source y 1.0, actor y 0.0 (originHeight 1).
        let chassis: Vec<_> = mesh.vertices.iter().filter(|v| v.section == VL_VEHICLE_SECTION_CHASSIS).collect();
        let mean_y = chassis.iter().map(|v| v.pos[1]).sum::<f32>() / chassis.len() as f32;
        assert!(mean_y.abs() < 1e-5, "{mean_y}");
        // Each closed hull has zero net signed area: sum of normal * area per face is 0.
        let mut sum = Vec3::ZERO;
        for t in mesh.vertices.chunks_exact(3) {
            let (a, b, c) = (Vec3::from_array(t[0].pos), Vec3::from_array(t[1].pos), Vec3::from_array(t[2].pos));
            sum += (b - a).cross(c - a);
        }
        assert!(sum.length() < 1e-4, "{sum}");
        assert_eq!(mesh.hubs[0], [1.0, -0.5, -1.5]);
        assert_eq!(mesh.wheel_radius, 0.5);
    }

    #[test]
    fn the_wheel_part_rides_its_stream_wheel_and_paint_applies() {
        let config = serde_json::json!({ "appearance": { "body": "#112233" } });
        let mesh = build_vehicle_mesh(&tiny_car(), Some(&config), Space::Server).unwrap();
        let wheel: Vec<_> = mesh.vertices.iter().filter(|v| v.section == VL_VEHICLE_SECTION_WHEEL).collect();
        assert_eq!(wheel.len(), 36, "the fr wheel is stream wheel 0");
        assert!(mesh.vertices.iter().any(|v| v.color_rgba == 0x112233FF), "body paint on the Body frame part");
        assert!(wheel.iter().all(|v| v.color_rgba == 0x202224FF), "rubber from the palette");
    }

    #[test]
    fn unreal_space_keeps_faces_outward() {
        let mesh = build_vehicle_mesh(&tiny_car(), None, Space::Unreal).unwrap();
        // Outward: each face's normal points away from its hull's centre.
        let chassis: Vec<_> = mesh.vertices.iter().filter(|v| v.section == VL_VEHICLE_SECTION_CHASSIS).collect();
        let centre = chassis.iter().fold(Vec3::ZERO, |s, v| s + Vec3::from_array(v.pos)) / chassis.len() as f32;
        for t in chassis.chunks_exact(3) {
            let (a, b, c) = (Vec3::from_array(t[0].pos), Vec3::from_array(t[1].pos), Vec3::from_array(t[2].pos));
            let face = (a + b + c) / 3.0;
            // The chunk meshes' convention (geometry.rs, drawn front-facing by Unreal): wound so
            // (b - a) x (c - a), computed in Unreal's coordinates, points outward, like the normal.
            assert!(Vec3::from_array(t[0].normal).dot(face - centre) > 0.0);
            assert!((b - a).cross(c - a).dot(face - centre) > 0.0);
        }
    }

    #[test]
    fn every_cached_car_builds() {
        // The prepared assets in the repo's cache (present on dev machines; skipped elsewhere).
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/vehicle-assets");
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let mut built = 0;
        for entry in entries.flatten() {
            let Ok(bytes) = std::fs::read(entry.path().join("metadata.json")) else { continue };
            let mesh = build_vehicle_mesh(&bytes, None, Space::Unreal).unwrap_or_else(|e| panic!("{:?}: {e}", entry.path()));
            assert!(mesh.vertices.len() > 1000);
            for w in 0..4 {
                assert!(mesh.vertices.iter().any(|v| v.section == VL_VEHICLE_SECTION_WHEEL + w), "wheel {w} has no parts");
            }
            built += 1;
        }
        eprintln!("built {built} cached cars");
    }
}
