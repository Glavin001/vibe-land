//! Cosmetic falling debris for culled sheet islands.
//!
//! When a large unsupported patch drops from a sheet, we spawn a short-lived
//! local-only rigid body so the cutout is seen falling out of the hole.
//! Not networked — each peer derives the same island from CarveEvent.
//!
//! Feature flag: built-in `SHEET_FALLING_DEBRIS` (default **on**). Set env
//! `SHEET_FALLING_DEBRIS=0`/`false`/`off` to disable at runtime.

use std::sync::OnceLock;

use super::coarse_collision::OrientedWorldCuboid;
use super::islands::DroppedIsland;
use super::registry::SheetUvFrame;

/// Built-in default. Flip to `false` to disable falling debris in source.
pub const SHEET_FALLING_DEBRIS: bool = true;

/// Minimum island area (m²) before we spawn a falling piece.
pub const DEBRIS_MIN_AREA_M2: f32 = 0.18;
/// Minimum shorter side of the UV bbox (m).
pub const DEBRIS_MIN_SIDE_M: f32 = 0.30;
/// Lifetime before despawn.
pub const DEBRIS_TTL_SEC: f32 = 3.5;
/// Cap concurrent debris bodies per session (practice).
pub const DEBRIS_MAX_CONCURRENT: usize = 12;
/// Nudge out of the parent wall along thickness so spawn isn't interpenetrating.
pub const DEBRIS_SPAWN_NUDGE_M: f32 = 0.03;

pub fn sheet_falling_debris_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        if !SHEET_FALLING_DEBRIS {
            return false;
        }
        #[cfg(target_arch = "wasm32")]
        {
            true
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            match std::env::var("SHEET_FALLING_DEBRIS") {
                Ok(v) => {
                    let v = v.trim().to_ascii_lowercase();
                    !matches!(v.as_str(), "0" | "false" | "off" | "no")
                }
                Err(_) => true,
            }
        }
    })
}

pub fn is_debris_worthy(island: &DroppedIsland) -> bool {
    if island.area + 1e-6 < DEBRIS_MIN_AREA_M2 {
        return false;
    }
    let w = (island.u1 - island.u0).abs();
    let h = (island.v1 - island.v0).abs();
    w.min(h) + 1e-6 >= DEBRIS_MIN_SIDE_M && w.max(h) + 1e-6 >= DEBRIS_MIN_SIDE_M
}

/// Oriented world cuboid for a dropped UV island (same frame as sheet collision).
pub fn dropped_island_world_cuboid(
    island: &DroppedIsland,
    frame: &SheetUvFrame,
) -> OrientedWorldCuboid {
    use nalgebra::{Matrix3, UnitQuaternion, Vector3};
    let u0 = island.u0.clamp(0.0, frame.size_u);
    let u1 = island.u1.clamp(0.0, frame.size_u);
    let v0 = island.v0.clamp(0.0, frame.size_v);
    let v1 = island.v1.clamp(0.0, frame.size_v);
    let cu = (u0 + u1) * 0.5;
    let cv = (v0 + v1) * 0.5;
    let center = [
        frame.origin[0] + frame.axis_u[0] * cu + frame.axis_v[0] * cv,
        frame.origin[1] + frame.axis_u[1] * cu + frame.axis_v[1] * cv,
        frame.origin[2] + frame.axis_u[2] * cu + frame.axis_v[2] * cv,
    ];
    let u = Vector3::new(frame.axis_u[0], frame.axis_u[1], frame.axis_u[2]).normalize();
    let t = Vector3::new(
        frame.axis_thickness[0],
        frame.axis_thickness[1],
        frame.axis_thickness[2],
    );
    let t = (t - u * t.dot(&u)).normalize();
    let v = u.cross(&t).normalize();
    let m = Matrix3::from_columns(&[u, t, v]);
    let q = UnitQuaternion::from_matrix(&m);
    OrientedWorldCuboid {
        center,
        half_extents: [
            ((u1 - u0) * 0.5).max(0.01),
            (frame.thickness * 0.5).max(0.005),
            ((v1 - v0) * 0.5).max(0.01),
        ],
        rotation_xyzw: [q.i, q.j, q.k, q.w],
    }
}

/// Filter + convert dropped islands into spawn payloads.
pub fn debris_spawns_from_islands(
    islands: &[DroppedIsland],
    frame: &SheetUvFrame,
) -> Vec<OrientedWorldCuboid> {
    if !sheet_falling_debris_enabled() {
        return Vec::new();
    }
    islands
        .iter()
        .filter(|i| is_debris_worthy(i))
        .map(|i| dropped_island_world_cuboid(i, frame))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freckle_is_not_worthy() {
        let i = DroppedIsland {
            u0: 1.0,
            v0: 1.0,
            u1: 1.08,
            v1: 1.08,
            area: 0.0064,
        };
        assert!(!is_debris_worthy(&i));
    }

    #[test]
    fn doorway_chunk_is_worthy() {
        let i = DroppedIsland {
            u0: 1.2,
            v0: 0.0,
            u1: 2.8,
            v1: 2.0,
            area: 1.6 * 2.0,
        };
        assert!(is_debris_worthy(&i));
    }
}
