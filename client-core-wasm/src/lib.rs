//! The web client's bindings to the shared client core (`vibe-client-core`), the code the Unreal
//! client links natively through `client-core-ffi`. The web adopts the core one module at a time,
//! each behind a flag with a parity test against the TypeScript it replaces
//! (`client/src/core/`).

use wasm_bindgen::prelude::*;

/// The outward-wound convex hull of flat xyz `points` (the core's `geometry::convex_hull_triangles`,
/// parry's quickhull: the Unreal client's chunk and car hulls), as nine floats per triangle; `None`
/// when the points span no volume. The web's chunk hulls use it behind `?coreGeometry=1`
/// (`client/src/city/chunkGeometry.ts`).
#[wasm_bindgen]
pub fn convex_hull_triangles(points: &[f32]) -> Option<Box<[f32]>> {
    let mut triangles = Vec::new();
    if !vibe_client_core::geometry::convex_hull_triangles(points, &mut triangles) {
        return None;
    }
    Some(triangles.iter().flat_map(|t| t.iter().flat_map(|v| v.to_array())).collect())
}
