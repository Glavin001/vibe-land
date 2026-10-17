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

/// The core's 60 Hz input bundler (`input::InputBundler`) for the web: the frames due for a
/// renderer frame, as `FixedInputBundler` + `buildInputFromState` produce them. Behind
/// `?coreInput=1` (`client/src/runtime/fixedInputBundler.ts`).
#[wasm_bindgen]
pub struct CoreInputBundler {
    inner: vibe_client_core::input::InputBundler,
}

#[wasm_bindgen]
impl CoreInputBundler {
    #[wasm_bindgen(constructor)]
    pub fn new(fixed_dt_s: f64, max_catchup_steps: u32) -> Self {
        Self { inner: vibe_client_core::input::InputBundler::with_step(fixed_dt_s, max_catchup_steps) }
    }

    pub fn reset(&mut self, next_seq: u32) {
        self.inner.reset(next_seq as u16);
    }

    pub fn next_seq(&self) -> u32 {
        u32::from(self.inner.next_seq())
    }

    pub fn remainder_s(&self) -> f64 {
        self.inner.remainder_s()
    }

    /// Six numbers per frame due: seq, buttons, moveX, moveY, and yaw and pitch as the server will
    /// read them (quantised and back, as the web's `buildInputFromState` gives them).
    pub fn produce(&mut self, dt_s: f64, move_x: f64, move_y: f64, yaw: f64, pitch: f64, buttons: u32) -> Box<[f64]> {
        use vibe_land_shared::net_client::client_angle_i16;
        let view = |a: f64| f64::from(client_angle_i16(a) as u16) / 65535.0 * std::f64::consts::PI * 2.0;
        let frames = self
            .inner
            .produce_with(dt_s, |seq| vibe_client_core::input::quantise_web(seq, move_x, move_y, yaw, pitch, buttons as u16));
        frames
            .iter()
            .flat_map(|f| [f64::from(f.seq), f64::from(f.buttons), f64::from(f.move_x), f64::from(f.move_y), view(yaw), view(pitch)])
            .collect()
    }
}
