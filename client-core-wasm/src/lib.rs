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

/// A shared grass layout (the web's `GrassPaint` document), parsed by the core (`grass::GrassPaint`).
#[wasm_bindgen]
pub struct CoreGrassPaint {
    inner: vibe_client_core::grass::GrassPaint,
}

#[wasm_bindgen]
impl CoreGrassPaint {
    /// From `GrassPaint.export()` / `patchDocument()` as JSON; throws on an invalid layout.
    #[wasm_bindgen(constructor)]
    pub fn new(document_json: &str) -> Result<CoreGrassPaint, JsValue> {
        vibe_client_core::grass::GrassPaint::from_layout_json(document_json.as_bytes())
            .map(|inner| CoreGrassPaint { inner })
            .map_err(JsValue::from_str)
    }
}

/// One patch packed as `grassPlacement.ts` `GrassPatchData` (roots: local x, local z, height, yaw;
/// shapes: width, lean, variation, rank as unorm16; colors: unorm8 RGB; traits: health, dryness,
/// stiffness, species).
#[wasm_bindgen]
pub struct CoreGrassPatch {
    roots: Vec<f32>,
    shapes: Vec<u16>,
    colors: Vec<u8>,
    traits: Vec<u8>,
    max_height: f32,
}

#[wasm_bindgen]
impl CoreGrassPatch {
    pub fn roots(&self) -> Box<[f32]> {
        self.roots.clone().into_boxed_slice()
    }
    pub fn shapes(&self) -> Box<[u16]> {
        self.shapes.clone().into_boxed_slice()
    }
    pub fn colors(&self) -> Box<[u8]> {
        self.colors.clone().into_boxed_slice()
    }
    pub fn traits(&self) -> Box<[u8]> {
        self.traits.clone().into_boxed_slice()
    }
    #[wasm_bindgen(getter)]
    pub fn max_height(&self) -> f32 {
        self.max_height
    }
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> u32 {
        (self.roots.len() / 4) as u32
    }
}

/// `generateGrassPatch(px, pz, quality, exclusions, paint)` from the core (`grass::generate_patch`,
/// the Unreal client's meadow): `density` is the quality's grass density, `exclusions` four floats
/// (minX, minZ, maxX, maxZ) per footprint. Behind `?coreGrass=1` (`scene/grass/grass.worker.ts`).
#[wasm_bindgen]
pub fn grass_patch(px: i32, pz: i32, density: f32, exclusions: &[f32], paint: Option<CoreGrassPaint>) -> CoreGrassPatch {
    use vibe_client_core::grass::{generate_patch, VlGrassExclusion, GRASS_PATCH_SIZE};
    let ex: Vec<VlGrassExclusion> = exclusions.chunks_exact(4).map(|e| VlGrassExclusion { min_x: e[0], min_z: e[1], max_x: e[2], max_z: e[3] }).collect();
    let mut blades = Vec::new();
    generate_patch(px, pz, density, &ex, paint.as_ref().map(|p| &p.inner), &mut blades);
    // JavaScript typed arrays truncate (ToUint16 / ToUint8 of values in range).
    let u16_of = |v: f32| (f64::from(v) * 65535.0) as u16;
    let u8_of = |v: f32| (f64::from(v) * 255.0) as u8;
    let n = blades.len();
    let (ox, oz) = (px as f32 * GRASS_PATCH_SIZE, pz as f32 * GRASS_PATCH_SIZE);
    let mut patch = CoreGrassPatch { roots: Vec::with_capacity(n * 4), shapes: Vec::with_capacity(n * 4), colors: Vec::with_capacity(n * 3), traits: Vec::with_capacity(n * 4), max_height: 0.0 };
    for (i, b) in blades.iter().enumerate() {
        patch.max_height = patch.max_height.max(b.height);
        patch.roots.extend([b.x - ox, b.z - oz, b.height, b.yaw]);
        patch.shapes.extend([u16_of(b.width), u16_of(b.lean), u16_of(b.variation), ((i as f64 / n as f64) * 65535.0).floor() as u16]);
        patch.colors.extend(b.color.map(u8_of));
        patch.traits.extend([u8_of(b.health), u8_of(b.dryness), u8_of(b.stiffness), b.species as u8]);
    }
    patch
}

/// The wire 4 city stream for a manifest, built by the shared core: the manifest bytes decoded and
/// the structures derived in Rust (`destruction::per_player::structure_defs`, the server's own
/// derivation, as the Unreal client builds its stream) rather than flattened in TypeScript
/// (`perPlayerCoreArgs`). The same `PerPlayerClient` surface the web's stream adapter reads.
/// Behind `?coreStream=1` (`client/src/city/perPlayerWasm.ts`). wasm32 only, like
/// `perplayer::wasm` (a native `cargo check` of the workspace builds this crate too).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn core_city_stream(manifest: &[u8], hz: u32, gravity_y: f32, delay_ticks: f32) -> Result<vibe_land_perplayer::wasm::PerPlayerClient, JsValue> {
    let manifest = vibe_client_core::city::decode_manifest(manifest, None).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let client = vibe_land_perplayer::client::Client::new(
        vibe_land_destruction::per_player::structure_defs(&manifest),
        vibe_land_perplayer::predict::Physics::at_hz(hz, gravity_y),
        hz,
        delay_ticks,
    );
    Ok(vibe_land_perplayer::wasm::PerPlayerClient::from_client(client))
}

/// The local player's bounded presentation lead (`predictor.rs`, the port of
/// `physics/thinAuthoritativePredictor.ts`), at the server's walk and sprint speeds. Behind
/// `?corePredictor=1` (`client/src/runtime/gameRuntime.ts`).
#[wasm_bindgen]
pub struct CorePredictor {
    inner: vibe_client_core::predictor::ThinPredictor,
}

impl Default for CorePredictor {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl CorePredictor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { inner: Default::default() }
    }
    pub fn set_speeds(&mut self, walk: f32, sprint: f32) {
        self.inner.set_speeds(walk, sprint);
    }
    pub fn reset(&mut self) {
        self.inner.reset();
    }
    /// The authoritative state this frame: velocity plus the support's (what the player stands on).
    pub fn observe(&mut self, vx: f32, vy: f32, vz: f32, grounded: bool, in_vehicle: bool, dt_s: f32) {
        self.inner.observe(glam::Vec3::new(vx, vy, vz), grounded, in_vehicle, dt_s);
    }
    /// The presented position: [x, y, z].
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, x: f32, y: f32, z: f32, dt_s: f32, move_x: f32, move_y: f32, yaw: f32, buttons: u16) -> Box<[f32]> {
        let input = vibe_client_core::input::InputState { move_x, move_y, yaw, pitch: 0.0, buttons };
        let p = self.inner.update(glam::Vec3::new(x, y, z), dt_s, &input);
        Box::new([p.x, p.y, p.z])
    }
    pub fn correction_magnitude(&self) -> f32 {
        self.inner.offset().length()
    }
}

/// One event's voices from the core (`audio::voice_plan`, engine.ts `play` with the original
/// palette): read with `len()` and the per-voice getters. Behind `?coreAudio=1`
/// (`client/src/audio/engine.ts`).
#[wasm_bindgen]
pub struct CoreVoicePlan {
    voices: Vec<vibe_client_core::audio::PlannedVoice>,
}

#[wasm_bindgen]
impl CoreVoicePlan {
    pub fn len(&self) -> usize {
        self.voices.len()
    }
    pub fn is_empty(&self) -> bool {
        self.voices.is_empty()
    }
    pub fn clip(&self, i: usize) -> String {
        self.voices[i].clip.clone()
    }
    pub fn level(&self, i: usize) -> f32 {
        self.voices[i].level
    }
    pub fn rate(&self, i: usize) -> f32 {
        self.voices[i].rate
    }
    pub fn delay_s(&self, i: usize) -> f32 {
        self.voices[i].delay_s
    }
    /// The web's voice role: '' (hit), 'body', 'detail' or 'threat'.
    pub fn role(&self, i: usize) -> String {
        use vibe_client_core::audio::VoiceRole::*;
        match self.voices[i].role {
            Hit => "",
            Body => "body",
            Detail => "detail",
            Threat => "threat",
        }
        .into()
    }
    pub fn protected(&self, i: usize) -> bool {
        self.voices[i].protected
    }
}

/// `kind`: impact, fracture, collapse, shot or flyby; `material`: an acoustic material name;
/// `dynamic_range`: balanced, night or cinematic; the mix as settings.ts holds it.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn voice_plan(kind: &str, material: &str, intensity: f32, size: f32, seed: u32, protected: bool, impact: f32, detail: f32, bass: f32, flyby: f32, dynamic_range: &str) -> Option<CoreVoicePlan> {
    use vibe_client_core::audio::{voice_plan, AcousticMaterial, DynamicRange, Mix, SoundEvent, SoundKind};
    let kind = match kind {
        "impact" => SoundKind::Impact,
        "fracture" => SoundKind::Fracture,
        "collapse" => SoundKind::Collapse,
        "shot" => SoundKind::Shot,
        "flyby" => SoundKind::Flyby,
        _ => return None,
    };
    let material = AcousticMaterial::from_name(material)?;
    let range = match dynamic_range {
        "night" => DynamicRange::Night,
        "cinematic" => DynamicRange::Cinematic,
        _ => DynamicRange::Balanced,
    };
    let e = SoundEvent { id: 0, kind, position: Default::default(), material, intensity, size, seed, at_ms: 0.0, protected };
    Some(CoreVoicePlan { voices: voice_plan(&e, Mix { impact, detail, bass, flyby, range }) })
}

/// The core's remote-player interpolation (`interp::PlayerInterpolator`, the web's
/// `PlayerInterpolator` ported) for the web, behind `?corePlayers=1` (`net/interpolation.ts`).
/// A sample is eleven numbers: server µs, position ×3, velocity ×3, yaw, pitch, hp, flags; then 1
/// when it is a rest hold, else 0.
#[wasm_bindgen]
pub struct CorePlayerInterpolator {
    inner: vibe_client_core::interp::PlayerInterpolator,
}

fn player_sample_out(s: vibe_client_core::interp::PlayerSample) -> Box<[f64]> {
    let [px, py, pz] = s.position;
    let [vx, vy, vz] = s.velocity;
    Box::new([s.server_time_us, px, py, pz, vx, vy, vz, s.yaw, s.pitch, s.hp, s.flags, f64::from(u8::from(s.held))])
}

#[wasm_bindgen]
impl CorePlayerInterpolator {
    #[wasm_bindgen(constructor)]
    pub fn new(max_samples: u32) -> Self {
        Self { inner: vibe_client_core::interp::PlayerInterpolator::new(max_samples as usize) }
    }

    /// One snapshot sample (`push`): `s` is the eleven numbers less the hold mark.
    pub fn push(&mut self, id: u32, s: &[f64], snapshot_interval_us: f64) {
        if s.len() < 11 {
            return;
        }
        let sample = vibe_client_core::interp::PlayerSample {
            server_time_us: s[0],
            position: [s[1], s[2], s[3]],
            velocity: [s[4], s[5], s[6]],
            yaw: s[7],
            pitch: s[8],
            hp: s[9],
            flags: s[10],
            held: false,
        };
        self.inner.push(id, sample, snapshot_interval_us);
    }

    pub fn remove(&mut self, id: u32) {
        self.inner.remove(id);
    }

    pub fn retain_only(&mut self, ids: &[u32]) {
        self.inner.retain_only(ids);
    }

    pub fn ids(&self) -> Box<[u32]> {
        self.inner.ids().collect()
    }

    pub fn latest(&self, id: u32) -> Option<Box<[f64]>> {
        self.inner.latest(id).map(player_sample_out)
    }

    pub fn sample(&self, id: u32, target_us: f64) -> Option<Box<[f64]>> {
        self.inner.sample(id, target_us).map(player_sample_out)
    }
}

/// A city manifest decoded by the shared decoder (`destruction::manifest_binary`, the Unreal
/// client's), laid out as the web's `decodeBinaryManifest` reads it: per structure, the chunks'
/// fields as parallel arrays and the bonds' as typed arrays. Behind `?coreManifest=1`
/// (`client/src/city/manifestCore.ts`).
#[wasm_bindgen]
pub struct CoreManifest {
    inner: vibe_land_destruction::manifest::DestructionManifest,
}

/// No shape-library entry (`NO_SHAPE` in manifestBinary.ts).
const NO_SHAPE: u32 = u32::MAX;

#[wasm_bindgen]
impl CoreManifest {
    pub fn version(&self) -> u32 {
        self.inner.version
    }

    /// Six floats per stress material (compression, tension, shear: elastic then fatal each).
    pub fn material_strength(&self) -> Box<[f32]> {
        self.inner
            .materials
            .iter()
            .flat_map(|m| [m.compression_elastic, m.compression_fatal, m.tension_elastic, m.tension_fatal, m.shear_elastic, m.shear_fatal])
            .collect()
    }

    pub fn shape_count(&self) -> u32 {
        self.inner.shape_library.len() as u32
    }

    pub fn shape(&self, i: u32) -> Box<[f32]> {
        self.inner.shape_library.get(i as usize).cloned().unwrap_or_default().into_boxed_slice()
    }

    /// The materials' appearance as JSON, or `undefined` when the pack has none.
    pub fn appearance_json(&self) -> Option<String> {
        (!self.inner.material_appearance.is_empty()).then(|| serde_json::to_string(&self.inner.material_appearance).unwrap_or_default())
    }

    pub fn structure_count(&self) -> u32 {
        self.inner.structures.len() as u32
    }

    fn structure(&self, s: u32) -> &vibe_land_destruction::manifest::StructureManifest {
        &self.inner.structures[s as usize]
    }

    pub fn structure_id(&self, s: u32) -> u32 {
        self.structure(s).structure_id
    }

    /// World position ×3 then rotation ×4.
    pub fn placement(&self, s: u32) -> Box<[f32]> {
        let st = self.structure(s);
        st.world_position.iter().chain(st.world_rotation.iter()).copied().collect()
    }

    /// Per chunk: centroid ×3, mass, volume, size ×3, radius, half extents ×3 (cuboid), mass offset ×3.
    pub fn chunk_floats(&self, s: u32) -> Box<[f32]> {
        use vibe_land_destruction::manifest::ChunkGeometry;
        let mut out = Vec::new();
        for c in &self.structure(s).chunks {
            out.extend(c.centroid);
            out.extend([c.mass, c.volume]);
            out.extend(c.size);
            out.push(c.radius);
            out.extend(match &c.geometry {
                ChunkGeometry::Cuboid { half_extents } => *half_extents,
                ChunkGeometry::ConvexHull { .. } => [0.0; 3],
            });
            out.extend(c.mass_offset);
        }
        out.into_boxed_slice()
    }

    /// Per chunk: node index, material, support (0/1), kind (0 cuboid, 1 hull), shape id (`NO_SHAPE`
    /// when none), inline point count.
    pub fn chunk_ints(&self, s: u32) -> Box<[u32]> {
        use vibe_land_destruction::manifest::ChunkGeometry;
        let mut out = Vec::new();
        for c in &self.structure(s).chunks {
            let (kind, shape, points) = match &c.geometry {
                ChunkGeometry::Cuboid { .. } => (0, NO_SHAPE, 0),
                ChunkGeometry::ConvexHull { points, shape_id } => (1, shape_id.unwrap_or(NO_SHAPE), points.len() as u32),
            };
            out.extend([c.node_index, c.material, u32::from(c.support), kind, shape, points]);
        }
        out.into_boxed_slice()
    }

    /// Every hull chunk's inline points, in chunk order (their counts are in `chunk_ints`).
    pub fn chunk_points(&self, s: u32) -> Box<[f32]> {
        use vibe_land_destruction::manifest::ChunkGeometry;
        self.structure(s)
            .chunks
            .iter()
            .flat_map(|c| match &c.geometry {
                ChunkGeometry::ConvexHull { points, .. } => points.clone(),
                ChunkGeometry::Cuboid { .. } => Vec::new(),
            })
            .collect()
    }

    pub fn bond_node0(&self, s: u32) -> Box<[u32]> {
        self.structure(s).bonds.iter().map(|b| b.node0).collect()
    }

    pub fn bond_node1(&self, s: u32) -> Box<[u32]> {
        self.structure(s).bonds.iter().map(|b| b.node1).collect()
    }

    pub fn bond_centroid(&self, s: u32) -> Box<[f32]> {
        self.structure(s).bonds.iter().flat_map(|b| b.centroid).collect()
    }

    pub fn bond_normal(&self, s: u32) -> Box<[f32]> {
        self.structure(s).bonds.iter().flat_map(|b| b.normal).collect()
    }

    pub fn bond_area(&self, s: u32) -> Box<[f32]> {
        self.structure(s).bonds.iter().map(|b| b.area).collect()
    }

    pub fn bond_material(&self, s: u32) -> Box<[u32]> {
        self.structure(s).bonds.iter().map(|b| b.material).collect()
    }
}

/// Decode a binary city manifest (VLCM) with the shared decoder.
#[wasm_bindgen]
pub fn decode_city_manifest(bytes: &[u8]) -> Result<CoreManifest, JsValue> {
    vibe_land_destruction::manifest_binary::decode(bytes)
        .map(|inner| CoreManifest { inner })
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// The debris beds from the core (`audio::Activity`, destructionActivity.ts's `DestructionActivity`),
/// behind `?coreAudio=1` (`client/src/audio/coreActivity.ts`).
#[wasm_bindgen]
pub struct CoreActivity {
    inner: vibe_client_core::audio::Activity,
    beds: Vec<vibe_client_core::audio::Bed>,
}

#[wasm_bindgen]
impl CoreActivity {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { inner: Default::default(), beds: Vec::new() }
    }

    /// An event at its arrival time; `id` is the web's event id (repeats within 3 s count once).
    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, id: &str, kind: &str, material: &str, x: f32, y: f32, z: f32, intensity: f32, size: f32, at_ms: f64, occlusion: f32, lx: f32, ly: f32, lz: f32, now_ms: f64) {
        use vibe_client_core::audio::{AcousticMaterial, SoundEvent, SoundKind};
        let kind = match kind {
            "impact" => SoundKind::Impact,
            "fracture" => SoundKind::Fracture,
            "collapse" => SoundKind::Collapse,
            _ => return,
        };
        let Some(material) = AcousticMaterial::from_name(material) else { return };
        // FNV-1a over the id: the region dedupe needs only identity.
        let id = id.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
        let e = SoundEvent { id, kind, position: glam_vec(x, y, z), material, intensity, size, seed: 0, at_ms, protected: false };
        self.inner.add(&e, glam_vec(lx, ly, lz), now_ms, occlusion);
    }

    /// Sample the beds now (at most four); read them with the getters.
    pub fn sample(&mut self, now_ms: f64, lx: f32, ly: f32, lz: f32) -> usize {
        self.beds = self.inner.sample(now_ms, glam_vec(lx, ly, lz));
        self.beds.len()
    }
    pub fn key(&self, i: usize) -> String {
        self.beds[i].key.clone()
    }
    pub fn material(&self, i: usize) -> String {
        self.beds[i].material.name().into()
    }
    pub fn intensity(&self, i: usize) -> f32 {
        self.beds[i].intensity
    }
    pub fn occlusion(&self, i: usize) -> f32 {
        self.beds[i].occlusion
    }
    /// The bed's position, x y z.
    pub fn position(&self, i: usize) -> Box<[f32]> {
        Box::new(self.beds[i].position.to_array())
    }
    pub fn clear(&mut self) {
        self.inner.clear();
        self.beds.clear();
    }
}

fn glam_vec(x: f32, y: f32, z: f32) -> glam::Vec3 {
    glam::Vec3::new(x, y, z)
}
