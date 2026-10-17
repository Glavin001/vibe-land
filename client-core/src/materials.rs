//! Which catalog material each chunk wears, shared by every renderer.
//!
//! The catalog (`shared/assets/materials/catalog.json`) names every surface the city can show; an
//! entry's index is its layer in the web's texture arrays. This module picks, per chunk, the
//! material for its walls and the one for its top-facing faces, by the web's rules
//! (`client/src/scene/cityTextures.ts`, `cityChunkMesh.ts`), so both clients dress a building the
//! same way:
//!
//! * a manifest that authors no appearance at all (the stock city) tells buildings apart by hashing
//!   each building's id (the root chunk of its bonded component) into a wall and a floor layer;
//! * an authored material picks by its texture key; one with none takes entry 0, except that this
//!   module also accepts the material's name (catalog `names`), so wood framing is timber rather
//!   than the web's fallback concrete;
//! * a material with an authored opacity is glass.

use std::collections::HashMap;
use std::sync::OnceLock;

use vibe_land_destruction::manifest::DestructionManifest;

/// The catalog, embedded so every build carries the same one.
pub const CATALOG_JSON: &str = include_str!("../../shared/assets/materials/catalog.json");

/// One catalog entry, as renderers read it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlMaterial {
    /// Real-world size of one texture tile, metres.
    pub metres_per_tile: f32,
    pub roughness: f32,
    pub metalness: f32,
    /// 0xRRGGBBAA.
    pub base_color_rgba: u32,
    /// The web texture-array layer, or -1 (glass).
    pub layer: i32,
    /// `VL_MATERIAL_*` bits.
    pub flags: u32,
    /// Real-world tile size of the entry's higher-resolution source (catalog `hd`), metres; 0 when
    /// it has none. A renderer drawing that source scales the core's tile UVs by
    /// `metres_per_tile / hd_metres_per_tile`.
    pub hd_metres_per_tile: f32,
}

pub const VL_MATERIAL_DIRECTIONAL: u32 = 1;
pub const VL_MATERIAL_GLASS: u32 = 2;
pub const VL_MATERIAL_WALL: u32 = 4;
pub const VL_MATERIAL_FLOOR: u32 = 8;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntryJson {
    id: String,
    layer: Option<i32>,
    role: String,
    metres_per_tile: f32,
    directional: bool,
    #[serde(default)]
    texture_keys: Vec<String>,
    #[serde(default)]
    names: Vec<String>,
    base_color: String,
    roughness: f32,
    metalness: f32,
    #[serde(default)]
    hd: Option<HdSourceJson>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HdSourceJson {
    metres_per_tile: f32,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct CatalogJson {
    version: u32,
    materials: Vec<CatalogEntryJson>,
}

/// The parsed catalog.
#[derive(Clone, Debug)]
pub struct Catalog {
    pub version: u32,
    pub ids: Vec<String>,
    pub materials: Vec<VlMaterial>,
    by_texture_key: HashMap<String, u16>,
    by_name: HashMap<String, u16>,
    wall_layers: u32,
    floor_layers: u32,
    glass: u16,
}

impl Catalog {
    /// The embedded catalog (parsed once).
    pub fn get() -> &'static Catalog {
        static CATALOG: OnceLock<Catalog> = OnceLock::new();
        CATALOG.get_or_init(|| Catalog::parse(CATALOG_JSON).expect("embedded material catalog"))
    }

    pub fn parse(json: &str) -> Result<Catalog, String> {
        let parsed: CatalogJson = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut catalog = Catalog {
            version: parsed.version,
            ids: Vec::new(),
            materials: Vec::new(),
            by_texture_key: HashMap::new(),
            by_name: HashMap::new(),
            wall_layers: 0,
            floor_layers: 0,
            glass: u16::MAX,
        };
        for (index, e) in parsed.materials.iter().enumerate() {
            let index = index as u16;
            if let Some(layer) = e.layer {
                if layer != i32::from(index) {
                    return Err(format!("catalog entry {} has layer {layer}; entries must be in layer order", e.id));
                }
            }
            let mut flags = if e.directional { VL_MATERIAL_DIRECTIONAL } else { 0 };
            match e.role.as_str() {
                "wall" => {
                    flags |= VL_MATERIAL_WALL;
                    catalog.wall_layers += 1;
                }
                "floor" => {
                    flags |= VL_MATERIAL_FLOOR;
                    catalog.floor_layers += 1;
                }
                "glass" => {
                    flags |= VL_MATERIAL_GLASS;
                    catalog.glass = index;
                }
                _ => {}
            }
            for key in &e.texture_keys {
                catalog.by_texture_key.insert(key.clone(), index);
            }
            for name in &e.names {
                catalog.by_name.insert(name.clone(), index);
            }
            catalog.ids.push(e.id.clone());
            catalog.materials.push(VlMaterial {
                metres_per_tile: e.metres_per_tile,
                roughness: e.roughness,
                metalness: e.metalness,
                base_color_rgba: parse_hex_rgba(&e.base_color).ok_or_else(|| format!("{}: bad baseColor", e.id))?,
                layer: e.layer.unwrap_or(-1),
                flags,
                hd_metres_per_tile: e.hd.as_ref().map_or(0.0, |h| h.metres_per_tile),
            });
        }
        if catalog.wall_layers == 0 || catalog.floor_layers == 0 || catalog.glass == u16::MAX {
            return Err("catalog needs wall, floor and glass entries".into());
        }
        Ok(catalog)
    }

    pub fn index_of(&self, id: &str) -> Option<u16> {
        self.ids.iter().position(|i| i == id).map(|i| i as u16)
    }

    /// The web's layer code for a texture key (`layerCodeForTextureKey`): `(wall, floor)`, or
    /// `None` for a key the catalog does not know. `""` (a material with appearance but no named
    /// surface) is entry 0.
    pub fn surfaces_for_texture_key(&self, key: &str) -> Option<(u16, u16)> {
        let wall = if key.is_empty() { 0 } else { *self.by_texture_key.get(key)? };
        Some((wall, self.floor_for(wall)))
    }

    /// Up-facing surfaces: metal and the authored sets keep their own texture; everything else
    /// shows worn concrete floor, which is what a slab top or a broken edge is.
    fn floor_for(&self, wall: u16) -> u16 {
        let keeps_own = matches!(self.ids[wall as usize].as_str(), "metal" | "white-limestone" | "roof-slate" | "aged-timber");
        if keeps_own {
            wall
        } else {
            self.index_of("concrete-floor").unwrap_or(self.wall_layers as u16)
        }
    }

    /// The web's `layerCodeForBuilding`: a murmur3 finaliser of the building id picks one of the
    /// wall layers and one of the floor layers.
    pub fn surfaces_for_building(&self, building: u32) -> (u16, u16) {
        let mut h = building;
        h ^= h >> 16;
        h = h.wrapping_mul(0x85eb_ca6b);
        h ^= h >> 13;
        h = h.wrapping_mul(0xc2b2_ae35);
        h ^= h >> 16;
        let wall = h % self.wall_layers;
        let floor = self.wall_layers + (h >> 8) % self.floor_layers;
        (wall as u16, floor as u16)
    }
}

/// One chunk's materials.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VlChunkSurface {
    /// Catalog index for side faces.
    pub wall: u16,
    /// Catalog index for top- (and bottom-) facing faces.
    pub floor: u16,
    /// The manifest material's authored colour, 0xRRGGBBAA (0 when unauthored).
    pub tint_rgba: u32,
}

/// Per chunk, in chunk-table order.
pub fn chunk_surfaces(manifest: &DestructionManifest, catalog: &Catalog) -> Vec<VlChunkSurface> {
    let authored = !manifest.material_appearance.is_empty();
    // Per manifest material: its surfaces, or None to fall back to the building hash.
    let by_material: Vec<(Option<(u16, u16)>, u32)> = manifest
        .material_appearance
        .iter()
        .map(|a| {
            let tint = a.color.as_deref().and_then(parse_hex_rgba).unwrap_or(0);
            if a.opacity.is_some() {
                return (Some((catalog.glass, catalog.glass)), tint);
            }
            let keyed = match a.texture_key.as_deref() {
                Some(key) => catalog.surfaces_for_texture_key(key),
                None => a
                    .name
                    .as_deref()
                    .and_then(|n| catalog.by_name.get(n))
                    .map(|&wall| (wall, catalog.floor_for(wall)))
                    .or_else(|| catalog.surfaces_for_texture_key("")),
            };
            (keyed, tint)
        })
        .collect();

    let buildings = if authored { Vec::new() } else { building_ids(manifest) };
    let mut out = Vec::new();
    let mut slot = 0usize;
    for structure in &manifest.structures {
        for chunk in &structure.chunks {
            let (keyed, tint) = if authored {
                by_material
                    .get(chunk.material as usize)
                    .copied()
                    // A material index past the table: the web reads its appearance as missing and
                    // asks for key "" (entry 0).
                    .unwrap_or((catalog.surfaces_for_texture_key(""), 0))
            } else {
                (None, 0)
            };
            let (wall, floor) = keyed.unwrap_or_else(|| catalog.surfaces_for_building(buildings.get(slot).copied().unwrap_or(0)));
            out.push(VlChunkSurface { wall, floor, tint_rgba: tint });
            slot += 1;
        }
    }
    out
}

/// Each chunk's building id (in chunk-table order), as the web computes it (`resolveBuildingIds`
/// over `CityTopology` slots): a chunk's slot is its structure's base (the chunk count of the
/// structures before it) plus its node index; union-find over every structure's bonds in manifest
/// order joins `find(node0)` under `find(node1)` with path halving. A building is a bonded
/// component; its id is its root's slot.
pub fn building_ids(manifest: &DestructionManifest) -> Vec<u32> {
    let mut bases = Vec::with_capacity(manifest.structures.len());
    let mut count = 0u32;
    for s in &manifest.structures {
        bases.push(count);
        count += s.chunks.len() as u32;
    }
    let mut parent: Vec<u32> = (0..count).collect();
    fn find(parent: &mut [u32], slot: u32) -> u32 {
        let mut node = slot;
        while parent[node as usize] != node {
            parent[node as usize] = parent[parent[node as usize] as usize];
            node = parent[node as usize];
        }
        node
    }
    for (s, &base) in manifest.structures.iter().zip(&bases) {
        let len = s.chunks.len() as u32;
        for b in &s.bonds {
            if b.node0 >= len || b.node1 >= len {
                continue;
            }
            let a = find(&mut parent, base + b.node0);
            let b = find(&mut parent, base + b.node1);
            if a != b {
                parent[a as usize] = b;
            }
        }
    }
    let mut out = Vec::with_capacity(count as usize);
    for (s, &base) in manifest.structures.iter().zip(&bases) {
        for c in &s.chunks {
            let slot = (base + c.node_index).min(count.saturating_sub(1));
            out.push(find(&mut parent, slot));
        }
    }
    out
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa` to 0xRRGGBBAA.
pub fn parse_hex_rgba(s: &str) -> Option<u32> {
    let hex = s.strip_prefix('#')?;
    let v = u32::from_str_radix(hex, 16).ok()?;
    match hex.len() {
        3 => {
            let (r, g, b) = ((v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
            Some(((r * 17) << 24) | ((g * 17) << 16) | ((b * 17) << 8) | 0xff)
        }
        6 => Some((v << 8) | 0xff),
        8 => Some(v),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `wall + 16 × floor`, the web's packed layer code.
    fn code((wall, floor): (u16, u16)) -> u32 {
        u32::from(wall) + 16 * u32::from(floor)
    }

    #[test]
    fn building_hash_matches_the_web() {
        // From client/src/scene/cityTextures.ts `layerCodeForBuilding`, run with tsx.
        let expected = [
            (0u32, 128u32), (1, 135), (2, 150), (7, 132), (42, 148), (317, 132), (905, 145), (65535, 135),
            (123456789, 130), (4294967295, 145),
        ];
        let c = Catalog::get();
        for (id, web) in expected {
            assert_eq!(code(c.surfaces_for_building(id)), web, "building {id}");
        }
    }

    #[test]
    fn texture_keys_match_the_web() {
        // From `layerCodeForTextureKey`, run with tsx.
        let expected = [
            ("", Some(128u32)), ("concrete-wall", Some(128)), ("brick", Some(132)), ("stone", Some(133)), ("metal", Some(102)),
            ("white-concrete", Some(135)), ("concrete-floor", Some(136)), ("white-limestone", Some(204)),
            ("roof-slate", Some(221)), ("aged-timber", Some(238)), ("nope", None),
        ];
        let c = Catalog::get();
        for (key, web) in expected {
            assert_eq!(c.surfaces_for_texture_key(key).map(code), web, "key {key:?}");
        }
    }

    #[test]
    fn catalog_layers_match_the_web_texture_sets() {
        // client/src/scene/cityTextureSets.generated.ts, in order, with tile sizes.
        let web = [
            ("concrete-wall", 1.0), ("plaster-mossy", 1.8), ("concrete-cracked-dark", 2.23), ("concrete-layers", 2.0),
            ("brick", 1.0), ("stone", 2.0), ("metal", 0.5), ("white-concrete", 2.0), ("concrete-floor", 2.0),
            ("concrete-floor-damaged", 5.0), ("grass", 2.0), ("mud-leaves", 1.3), ("white-limestone", 3.0),
            ("roof-slate", 3.0), ("aged-timber", 3.0),
        ];
        let c = Catalog::get();
        for (layer, (id, metres)) in web.iter().enumerate() {
            assert_eq!(c.ids[layer], *id);
            assert_eq!(c.materials[layer].layer, layer as i32);
            assert_eq!(c.materials[layer].metres_per_tile, *metres as f32);
        }
        assert_eq!((c.wall_layers, c.floor_layers), (8, 2));
        // Every texture layer has a higher-resolution source; where it is the web's own Poly Haven
        // set the tile size is the same, so a renderer's UV scale is exactly 1 there.
        for (layer, (id, metres)) in web.iter().enumerate() {
            let hd = c.materials[layer].hd_metres_per_tile;
            assert!(hd > 0.0, "{id} has no hd source");
            if layer < 12 {
                assert_eq!(hd, *metres as f32, "{id}");
            }
        }
        assert_eq!(c.materials[c.glass as usize].flags & VL_MATERIAL_GLASS, VL_MATERIAL_GLASS);
    }

    #[test]
    fn hex_colours() {
        assert_eq!(parse_hex_rgba("#9c5b45"), Some(0x9c5b45ff));
        assert_eq!(parse_hex_rgba("#fff"), Some(0xffffffff));
        assert_eq!(parse_hex_rgba("#11223344"), Some(0x11223344));
        assert_eq!(parse_hex_rgba("9c5b45"), None);
    }
}
