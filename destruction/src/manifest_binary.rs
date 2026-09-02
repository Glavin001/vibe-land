//! The city manifest as bytes a client can read without parsing.
//!
//! The manifest is almost entirely numbers: centroids, extents, bond endpoints,
//! hull points. Shipped as JSON, a 47,000-chunk city is 62 MB of text, and a
//! browser has to hold the compressed bytes, a 62 MB UTF-16 string, AND the
//! resulting object graph at the same time to get at them. That peak is enough
//! for Safari to kill the tab on a phone before anything is drawn — which is
//! exactly what it did.
//!
//! So the numbers travel as numbers. The layout is structure-of-arrays rather
//! than array-of-structures, because that is what lets the client take a
//! `Float32Array` view straight onto the received buffer with no copy and no
//! per-chunk object: one view for every centroid, one for every extent.
//!
//! ## Layout
//!
//! Everything is little-endian and every section starts 4-byte aligned, which
//! is what `Float32Array`/`Uint32Array` views require. Strings and the handful
//! of genuinely non-numeric fields (material appearance) ride in one small
//! trailing JSON blob rather than getting a bespoke encoding for two kilobytes.
//!
//! ```text
//! magic            "VLCM"                       4 bytes
//! format version   u32                          this file's schema
//! manifest version u32                          DestructionManifest::version
//! structure count  u32
//! material count   u32
//! shape count      u32
//! appearance len   u32                          bytes of trailing JSON, may be 0
//! materials        material_count * 6 f32
//! shape library    per shape: u32 len, then len f32
//! structures       see write_structure
//! appearance JSON  appearance_len bytes, 4-byte padded
//! ```
//!
//! The hash the whole system is content-addressed by is taken over these bytes,
//! so switching format changes every manifest hash exactly once and clients
//! re-fetch. There is no way to avoid that and no reason to: the alternative is
//! two encodings whose hashes disagree about the same city.

use crate::manifest::{
    BondDef, ChunkDef, ChunkGeometry, DestructionManifest, MaterialAppearanceDef,
    StressMaterialDef, StructureManifest,
};

pub const MAGIC: &[u8; 4] = b"VLCM";
pub const FORMAT_VERSION: u32 = 1;

/// Geometry discriminants, parallel to `ChunkGeometry`.
const GEOMETRY_CUBOID: u32 = 0;
const GEOMETRY_HULL: u32 = 1;

#[derive(Debug)]
pub enum DecodeError {
    NotBinary,
    Truncated(&'static str),
    Unsupported(u32),
    Malformed(String),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotBinary => write!(f, "not a binary city manifest"),
            Self::Truncated(what) => write!(f, "truncated city manifest: {what}"),
            Self::Unsupported(v) => write!(f, "unsupported binary manifest format {v}"),
            Self::Malformed(why) => write!(f, "malformed city manifest: {why}"),
        }
    }
}

impl std::error::Error for DecodeError {}

struct Writer {
    out: Vec<u8>,
}

impl Writer {
    fn u32(&mut self, value: u32) {
        self.out.extend_from_slice(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.out.extend_from_slice(&value.to_le_bytes());
    }

    fn f32s(&mut self, values: &[f32]) {
        for value in values {
            self.f32(*value);
        }
    }

    /// Pad to the next 4-byte boundary so the following section can be viewed
    /// as a typed array.
    fn align(&mut self) {
        while self.out.len() % 4 != 0 {
            self.out.push(0);
        }
    }
}

pub fn encode(manifest: &DestructionManifest) -> Vec<u8> {
    let mut w = Writer {
        out: Vec::with_capacity(estimated_size(manifest)),
    };
    // Appearance is the one part that is not numbers. It is at most a few
    // dozen entries of names and colour strings, so it rides as JSON rather
    // than earning a bespoke string encoding.
    let appearance = if manifest.material_appearance.is_empty() {
        Vec::new()
    } else {
        serde_json::to_vec(&manifest.material_appearance).unwrap_or_default()
    };

    w.out.extend_from_slice(MAGIC);
    w.u32(FORMAT_VERSION);
    w.u32(manifest.version);
    w.u32(manifest.structures.len() as u32);
    w.u32(manifest.materials.len() as u32);
    w.u32(manifest.shape_library.len() as u32);
    w.u32(appearance.len() as u32);

    for material in &manifest.materials {
        w.f32s(&[
            material.compression_elastic,
            material.compression_fatal,
            material.tension_elastic,
            material.tension_fatal,
            material.shear_elastic,
            material.shear_fatal,
        ]);
    }

    for shape in &manifest.shape_library {
        w.u32(shape.len() as u32);
        w.f32s(shape);
    }

    for structure in &manifest.structures {
        write_structure(&mut w, structure);
    }

    w.out.extend_from_slice(&appearance);
    w.align();
    w.out
}

/// One structure: a fixed header, then every chunk field as its own array, then
/// every bond field as its own array.
fn write_structure(w: &mut Writer, structure: &StructureManifest) {
    let chunks = &structure.chunks;
    let bonds = &structure.bonds;
    w.u32(structure.structure_id);
    w.f32s(&structure.world_position);
    w.f32s(&structure.world_rotation);
    w.u32(chunks.len() as u32);
    w.u32(bonds.len() as u32);

    // Inline hull points are the one variable-length part of a chunk. They are
    // gathered into one blob with per-chunk (offset, length) so the fixed-size
    // arrays stay fixed-size and viewable.
    let mut inline_points: Vec<f32> = Vec::new();
    let mut point_offsets: Vec<u32> = Vec::with_capacity(chunks.len());
    let mut point_lengths: Vec<u32> = Vec::with_capacity(chunks.len());

    for chunk in chunks {
        match &chunk.geometry {
            ChunkGeometry::ConvexHull { points, .. } if !points.is_empty() => {
                point_offsets.push(inline_points.len() as u32);
                point_lengths.push(points.len() as u32);
                inline_points.extend_from_slice(points);
            }
            _ => {
                point_offsets.push(0);
                point_lengths.push(0);
            }
        }
    }

    for chunk in chunks {
        w.u32(chunk.node_index);
    }
    for chunk in chunks {
        w.f32s(&chunk.centroid);
    }
    for chunk in chunks {
        w.f32(chunk.mass);
    }
    for chunk in chunks {
        w.f32(chunk.volume);
    }
    for chunk in chunks {
        w.f32s(&chunk.size);
    }
    for chunk in chunks {
        w.f32(chunk.radius);
    }
    for chunk in chunks {
        w.u32(chunk.material);
    }
    // Support is a flag, but written as u32 to keep every array 4-aligned. The
    // saving from packing it would be 3 bytes a chunk against having to pad the
    // section anyway.
    for chunk in chunks {
        w.u32(u32::from(chunk.support));
    }
    for chunk in chunks {
        w.u32(match chunk.geometry {
            ChunkGeometry::Cuboid { .. } => GEOMETRY_CUBOID,
            ChunkGeometry::ConvexHull { .. } => GEOMETRY_HULL,
        });
    }
    // Cuboid half-extents. Zero for a hull chunk; three floats of nothing is
    // cheaper than a second variable-length section.
    for chunk in chunks {
        match chunk.geometry {
            ChunkGeometry::Cuboid { half_extents } => w.f32s(&half_extents),
            ChunkGeometry::ConvexHull { .. } => w.f32s(&[0.0, 0.0, 0.0]),
        }
    }
    // Shape-library id, u32::MAX for "none", which is not a valid index.
    for chunk in chunks {
        w.u32(match &chunk.geometry {
            ChunkGeometry::ConvexHull { shape_id, .. } => shape_id.unwrap_or(u32::MAX),
            ChunkGeometry::Cuboid { .. } => u32::MAX,
        });
    }
    for offset in &point_offsets {
        w.u32(*offset);
    }
    for length in &point_lengths {
        w.u32(*length);
    }
    w.u32(inline_points.len() as u32);
    w.f32s(&inline_points);

    for bond in bonds {
        w.u32(bond.bond_index);
    }
    for bond in bonds {
        w.u32(bond.node0);
    }
    for bond in bonds {
        w.u32(bond.node1);
    }
    for bond in bonds {
        w.f32s(&bond.centroid);
    }
    for bond in bonds {
        w.f32s(&bond.normal);
    }
    for bond in bonds {
        w.f32(bond.area);
    }
    for bond in bonds {
        w.u32(bond.material);
    }
}

fn estimated_size(manifest: &DestructionManifest) -> usize {
    let chunks: usize = manifest.structures.iter().map(|s| s.chunks.len()).sum();
    let bonds: usize = manifest.structures.iter().map(|s| s.bonds.len()).sum();
    let shape_points: usize = manifest.shape_library.iter().map(Vec::len).sum();
    64 + chunks * 22 * 4 + bonds * 12 * 4 + shape_points * 4
}

pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == MAGIC
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u32(&mut self, what: &'static str) -> Result<u32, DecodeError> {
        let end = self.at + 4;
        if end > self.bytes.len() {
            return Err(DecodeError::Truncated(what));
        }
        let value = u32::from_le_bytes(self.bytes[self.at..end].try_into().unwrap());
        self.at = end;
        Ok(value)
    }

    fn f32(&mut self, what: &'static str) -> Result<f32, DecodeError> {
        Ok(f32::from_bits(self.u32(what)?))
    }

    fn f32_array<const N: usize>(&mut self, what: &'static str) -> Result<[f32; N], DecodeError> {
        let mut out = [0.0; N];
        for slot in out.iter_mut() {
            *slot = self.f32(what)?;
        }
        Ok(out)
    }

    fn f32_vec(&mut self, count: usize, what: &'static str) -> Result<Vec<f32>, DecodeError> {
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(self.f32(what)?);
        }
        Ok(out)
    }
}

/// Decode back into the owned manifest.
///
/// The client reads the buffer directly; this exists so the encoder can be
/// tested against a real round trip rather than against itself, which is the
/// only way a byte-layout bug shows up before a browser finds it.
pub fn decode(bytes: &[u8]) -> Result<DestructionManifest, DecodeError> {
    if !looks_binary(bytes) {
        return Err(DecodeError::NotBinary);
    }
    let mut r = Reader { bytes, at: 4 };
    let format = r.u32("format version")?;
    if format != FORMAT_VERSION {
        return Err(DecodeError::Unsupported(format));
    }
    let version = r.u32("manifest version")?;
    let structure_count = r.u32("structure count")? as usize;
    let material_count = r.u32("material count")? as usize;
    let shape_count = r.u32("shape count")? as usize;
    let appearance_len = r.u32("appearance length")? as usize;

    let mut materials = Vec::with_capacity(material_count);
    for _ in 0..material_count {
        let v = r.f32_array::<6>("material")?;
        materials.push(StressMaterialDef {
            compression_elastic: v[0],
            compression_fatal: v[1],
            tension_elastic: v[2],
            tension_fatal: v[3],
            shear_elastic: v[4],
            shear_fatal: v[5],
        });
    }

    let mut shape_library = Vec::with_capacity(shape_count);
    for _ in 0..shape_count {
        let len = r.u32("shape length")? as usize;
        shape_library.push(r.f32_vec(len, "shape points")?);
    }

    let mut structures = Vec::with_capacity(structure_count);
    for _ in 0..structure_count {
        structures.push(read_structure(&mut r)?);
    }

    let material_appearance: Vec<MaterialAppearanceDef> = if appearance_len == 0 {
        Vec::new()
    } else {
        let end = r.at + appearance_len;
        if end > bytes.len() {
            return Err(DecodeError::Truncated("appearance"));
        }
        serde_json::from_slice(&bytes[r.at..end])
            .map_err(|e| DecodeError::Malformed(format!("appearance: {e}")))?
    };

    Ok(DestructionManifest {
        version,
        structures,
        materials,
        material_appearance,
        shape_library,
    })
}

fn read_structure(r: &mut Reader<'_>) -> Result<StructureManifest, DecodeError> {
    let structure_id = r.u32("structure id")?;
    let world_position = r.f32_array::<3>("world position")?;
    let world_rotation = r.f32_array::<4>("world rotation")?;
    let chunk_count = r.u32("chunk count")? as usize;
    let bond_count = r.u32("bond count")? as usize;

    let mut node_index = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        node_index.push(r.u32("node index")?);
    }
    let mut centroid = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        centroid.push(r.f32_array::<3>("chunk centroid")?);
    }
    let mass = r.f32_vec(chunk_count, "mass")?;
    let volume = r.f32_vec(chunk_count, "volume")?;
    let mut size = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        size.push(r.f32_array::<3>("size")?);
    }
    let radius = r.f32_vec(chunk_count, "radius")?;
    let mut material = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        material.push(r.u32("chunk material")?);
    }
    let mut support = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        support.push(r.u32("support")? != 0);
    }
    let mut kind = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        kind.push(r.u32("geometry kind")?);
    }
    let mut half_extents = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        half_extents.push(r.f32_array::<3>("half extents")?);
    }
    let mut shape_id = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        shape_id.push(r.u32("shape id")?);
    }
    let mut point_offset = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        point_offset.push(r.u32("point offset")? as usize);
    }
    let mut point_length = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        point_length.push(r.u32("point length")? as usize);
    }
    let inline_len = r.u32("inline point count")? as usize;
    let inline_points = r.f32_vec(inline_len, "inline points")?;

    let mut chunks = Vec::with_capacity(chunk_count);
    for i in 0..chunk_count {
        let geometry = if kind[i] == GEOMETRY_CUBOID {
            ChunkGeometry::Cuboid {
                half_extents: half_extents[i],
            }
        } else {
            let start = point_offset[i];
            let end = start + point_length[i];
            if end > inline_points.len() {
                return Err(DecodeError::Malformed("hull points out of range".into()));
            }
            ChunkGeometry::ConvexHull {
                points: inline_points[start..end].to_vec(),
                shape_id: (shape_id[i] != u32::MAX).then_some(shape_id[i]),
            }
        };
        chunks.push(ChunkDef {
            node_index: node_index[i],
            centroid: centroid[i],
            mass: mass[i],
            volume: volume[i],
            size: size[i],
            geometry,
            radius: radius[i],
            support: support[i],
            material: material[i],
        });
    }

    let mut bond_index = Vec::with_capacity(bond_count);
    for _ in 0..bond_count {
        bond_index.push(r.u32("bond index")?);
    }
    let mut node0 = Vec::with_capacity(bond_count);
    for _ in 0..bond_count {
        node0.push(r.u32("bond node0")?);
    }
    let mut node1 = Vec::with_capacity(bond_count);
    for _ in 0..bond_count {
        node1.push(r.u32("bond node1")?);
    }
    let mut bond_centroid = Vec::with_capacity(bond_count);
    for _ in 0..bond_count {
        bond_centroid.push(r.f32_array::<3>("bond centroid")?);
    }
    let mut normal = Vec::with_capacity(bond_count);
    for _ in 0..bond_count {
        normal.push(r.f32_array::<3>("bond normal")?);
    }
    let area = r.f32_vec(bond_count, "bond area")?;
    let mut bond_material = Vec::with_capacity(bond_count);
    for _ in 0..bond_count {
        bond_material.push(r.u32("bond material")?);
    }

    let mut bonds = Vec::with_capacity(bond_count);
    for i in 0..bond_count {
        bonds.push(BondDef {
            bond_index: bond_index[i],
            node0: node0[i],
            node1: node1[i],
            centroid: bond_centroid[i],
            normal: normal[i],
            area: area[i],
            material: bond_material[i],
        });
    }

    Ok(StructureManifest {
        structure_id,
        world_position,
        world_rotation,
        chunks,
        bonds,
    })
}
