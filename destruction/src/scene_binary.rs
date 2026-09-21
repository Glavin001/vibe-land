//! VLSP v1 asset loader. Numeric definitions are shared on disk; instances expand
//! to the existing ScenePack with independent node, bond and piece identities.
//! Contract: structures/town-kit/BINARY-SCENES.md. This is not the VLCM wire format.
use crate::scene_pack::{
    parse_scene_pack, SceneBond, SceneCollider, SceneNode, ScenePack, ScenePackError,
};
use glam::Vec3;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
const NODE: usize = 112;
const BOND: usize = 72;
const MAX_NODES: usize = 2_000_000;
const MAX_BONDS: usize = 8_000_000;
type R<T> = Result<T, ScenePackError>;
fn bad(s: impl Into<String>) -> ScenePackError {
    ScenePackError::Invalid(format!("VLSP: {}", s.into()))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Template {
    node_start: usize,
    node_count: usize,
    bond_start: usize,
    bond_count: usize,
    piece_span: u32,
    material_slots: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Instance {
    template: usize,
    position: [f64; 3],
    yaw: u32,
    mirror: bool,
    materials: Vec<u32>,
    group_suffix: String,
    group: Option<String>,
}
#[derive(Deserialize)]
struct Section {
    offset: usize,
    bytes: usize,
}
#[derive(Deserialize)]
struct Sections {
    nodes: Section,
    bonds: Section,
    shapes: Section,
}
#[derive(Deserialize)]
struct Shape {
    offset: usize,
    count: usize,
}
#[derive(Deserialize)]
struct Header {
    title: String,
    materials: serde_json::Value,
    strings: Vec<String>,
    templates: Vec<Template>,
    instances: Vec<Instance>,
    shapes: Vec<Shape>,
    sections: Sections,
}
fn u32_at(b: &[u8], o: usize) -> R<u32> {
    let v = b
        .get(o..o.checked_add(4).ok_or_else(|| bad("offset overflow"))?)
        .ok_or_else(|| bad("truncated u32"))?;
    Ok(u32::from_le_bytes(v.try_into().unwrap()))
}
fn f64_at(b: &[u8], o: usize) -> R<f64> {
    let v = b
        .get(o..o.checked_add(8).ok_or_else(|| bad("offset overflow"))?)
        .ok_or_else(|| bad("truncated f64"))?;
    let x = f64::from_le_bytes(v.try_into().unwrap());
    if !x.is_finite() {
        return Err(bad("non-finite number"));
    }
    Ok(x)
}
fn triple(b: &[u8], o: usize) -> R<[f64; 3]> {
    Ok([f64_at(b, o)?, f64_at(b, o + 8)?, f64_at(b, o + 16)?])
}
fn f32_value(x: f64) -> R<f32> {
    let y = x as f32;
    if !y.is_finite() {
        return Err(bad("f32 overflow"));
    }
    Ok(if y == 0. { 0. } else { y })
}
fn vector(a: [f64; 3]) -> R<Vec3> {
    Ok(Vec3::new(
        f32_value(a[0])?,
        f32_value(a[1])?,
        f32_value(a[2])?,
    ))
}
// Match the authoring composer's Math.round, including negative half values.
fn round(x: f64) -> f64 {
    let scaled = x * 1e6;
    let lo = scaled.floor();
    let y = (if scaled - lo >= 0.5 { lo + 1. } else { lo }) / 1e6;
    if y == 0. {
        0.
    } else {
        y
    }
}
fn rotate(mut p: [f64; 3], i: &Instance) -> [f64; 3] {
    if i.mirror {
        p[0] = -p[0];
    }
    let r = match i.yaw {
        0 => p,
        90 => [p[2], p[1], -p[0]],
        180 => [-p[0], p[1], -p[2]],
        270 => [-p[2], p[1], p[0]],
        _ => unreachable!(),
    };
    r
}
fn point(p: [f64; 3], i: &Instance) -> R<Vec3> {
    let p = rotate(p, i);
    vector(std::array::from_fn(|k| round(p[k] + i.position[k])))
}
fn count_range(start: usize, count: usize, stride: usize, bytes: usize) -> R<()> {
    if start
        .checked_add(count)
        .and_then(|n| n.checked_mul(stride))
        .filter(|n| *n <= bytes)
        .is_none()
    {
        return Err(bad("template range exceeds section"));
    }
    Ok(())
}
fn mapped(slot: u32, i: &Instance) -> R<u32> {
    i.materials
        .get(slot as usize)
        .copied()
        .ok_or_else(|| bad("invalid material slot"))
}
pub fn decode(bytes: &[u8]) -> R<ScenePack> {
    if bytes.len() < 64 || bytes.get(..4) != Some(b"VLSP") {
        return Err(bad("missing header"));
    }
    if u32_at(bytes, 4)? != 1
        || u32_at(bytes, 12)? as usize != NODE
        || u32_at(bytes, 16)? as usize != BOND
    {
        return Err(bad("unsupported version/strides"));
    }
    let len = u32_at(bytes, 8)? as usize;
    if len > 16 * 1024 * 1024 {
        return Err(bad("header limit"));
    }
    let start = 64 + (len + 7) / 8 * 8;
    let payload_len = u32_at(bytes, 20)? as usize;
    if start.checked_add(payload_len) != Some(bytes.len()) {
        return Err(bad("file length mismatch"));
    }
    let node_count = u32_at(bytes, 24)? as usize;
    let bond_count = u32_at(bytes, 28)? as usize;
    if node_count > MAX_NODES || bond_count > MAX_BONDS {
        return Err(bad("expanded scene exceeds limits"));
    }
    if Sha256::digest(&bytes[64..]).as_slice() != &bytes[32..64] {
        return Err(bad("checksum mismatch"));
    }
    let h: Header =
        serde_json::from_slice(&bytes[64..64 + len]).map_err(|e| bad(format!("header: {e}")))?;
    let p = &bytes[start..];
    let mut end = 0usize;
    for s in [&h.sections.nodes, &h.sections.bonds, &h.sections.shapes] {
        if s.offset != end {
            return Err(bad("noncontiguous sections"));
        }
        end = end
            .checked_add(s.bytes)
            .ok_or_else(|| bad("section overflow"))?;
    }
    if end != p.len()
        || h.sections.nodes.bytes % NODE != 0
        || h.sections.bonds.bytes % BOND != 0
        || h.sections.shapes.bytes % 8 != 0
    {
        return Err(bad("invalid sections"));
    }
    // Reuse the existing material inheritance/appearance validation on a tiny
    // header-only JSON object. The geometry never passes through JSON or Value.
    let mut pack=parse_scene_pack(&serde_json::json!({"version":2,"title":h.title,"defaults":{"solver":{"materials":h.materials}},"scenario":{"nodes":[],"bonds":[],"nodeSizes":[],"nodeColliders":[]}}).to_string())?;
    let mut n = 0usize;
    let mut b = 0usize;
    for t in &h.templates {
        if t.node_start != n || t.bond_start != b {
            return Err(bad("noncontiguous template definitions"));
        }
        count_range(t.node_start, t.node_count, NODE, h.sections.nodes.bytes)?;
        count_range(t.bond_start, t.bond_count, BOND, h.sections.bonds.bytes)?;
        n += t.node_count;
        b += t.bond_count;
    }
    if n * NODE != h.sections.nodes.bytes || b * BOND != h.sections.bonds.bytes {
        return Err(bad("unowned definition data"));
    }
    let mut expanded_n = 0usize;
    let mut expanded_b = 0usize;
    for i in &h.instances {
        let t = h
            .templates
            .get(i.template)
            .ok_or_else(|| bad("invalid template reference"))?;
        if ![0, 90, 180, 270].contains(&i.yaw)
            || i.position.iter().any(|x| !x.is_finite())
            || i.materials.len() != t.material_slots
            || i.materials
                .iter()
                .any(|m| *m as usize >= pack.materials.len())
        {
            return Err(bad("invalid instance transform/material remap"));
        }
        expanded_n = expanded_n
            .checked_add(t.node_count)
            .ok_or_else(|| bad("count overflow"))?;
        expanded_b = expanded_b
            .checked_add(t.bond_count)
            .ok_or_else(|| bad("count overflow"))?;
    }
    if expanded_n != node_count || expanded_b != bond_count {
        return Err(bad("expanded count mismatch"));
    }
    let mut shape_points = Vec::new();
    let mut shape_end = 0usize;
    for s in &h.shapes {
        if s.offset != shape_end || s.count < 12 || s.count > 192 || s.count % 3 != 0 {
            return Err(bad("invalid shape definition"));
        }
        shape_end = shape_end
            .checked_add(s.count * 8)
            .ok_or_else(|| bad("shape overflow"))?;
        if shape_end > h.sections.shapes.bytes {
            return Err(bad("shape range"));
        }
        shape_points.push(
            (0..s.count)
                .map(|k| f64_at(p, h.sections.shapes.offset + s.offset + k * 8))
                .collect::<R<Vec<_>>>()?,
        );
    }
    if shape_end != h.sections.shapes.bytes {
        return Err(bad("unowned shape data"));
    }
    pack.nodes.reserve(node_count);
    pack.node_sizes.reserve(node_count);
    pack.node_colliders.reserve(node_count);
    pack.node_types.reserve(node_count);
    pack.node_pieces.reserve(node_count);
    pack.bonds.reserve(bond_count);
    let mut piece_base = 0u32;
    let mut shape_ids: HashMap<Vec<u64>, u32> = HashMap::new();
    for i in &h.instances {
        let t = &h.templates[i.template];
        let node_base = pack.nodes.len() as u32;
        for k in 0..t.node_count {
            let o = h.sections.nodes.offset + (t.node_start + k) * NODE;
            let material = mapped(u32_at(p, o + 88)?, i)?;
            let piece = u32_at(p, o + 92)?;
            let role = u32_at(p, o + 96)? as usize;
            let group = u32_at(p, o + 100)? as usize;
            let shape = u32_at(p, o + 104)? as usize;
            let kind = u32_at(p, o + 108)?;
            if piece >= t.piece_span || role >= h.strings.len() || group >= h.strings.len() {
                return Err(bad("invalid node identity"));
            }
            // Group labels are authoring metadata, preserved in the bundle for JS. Rust's
            // current ScenePack intentionally has no group-label field.
            let _ = (&i.group, &i.group_suffix);
            let mass = f64_at(p, o + 24)?;
            let volume = f64_at(p, o + 32)?;
            if mass < 0. || volume <= 0. {
                return Err(bad("invalid mass/volume"));
            }
            let size = rotate(triple(p, o + 40)?, i).map(f64::abs).map(round);
            if size.iter().any(|x| *x <= 0.) {
                return Err(bad("invalid node size"));
            }
            let collider = match kind {
                0 => {
                    let half = rotate(triple(p, o + 64)?, i).map(f64::abs).map(round);
                    if half.iter().any(|x| *x <= 0.) {
                        return Err(bad("invalid cuboid"));
                    }
                    SceneCollider::Cuboid {
                        half_extents: vector(half)?,
                    }
                }
                1 => {
                    let src = shape_points
                        .get(shape)
                        .ok_or_else(|| bad("invalid hull reference"))?;
                    let mut values = Vec::with_capacity(src.len());
                    for v in src.chunks_exact(3) {
                        values.extend(rotate([v[0], v[1], v[2]], i).map(round));
                    }
                    let key = values.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                    let next = shape_ids.len() as u32;
                    let id = *shape_ids.entry(key).or_insert(next);
                    SceneCollider::ConvexHull {
                        points: values.into_iter().map(f32_value).collect::<R<Vec<_>>>()?,
                        shape_id: Some(id),
                    }
                }
                _ => return Err(bad("invalid collider kind")),
            };
            pack.nodes.push(SceneNode {
                centroid: point(triple(p, o)?, i)?,
                mass: f32_value(mass)?,
                volume: f32_value(volume)?,
                material,
            });
            pack.node_sizes.push(vector(size)?);
            pack.node_colliders.push(collider);
            pack.node_types.push(h.strings[role].clone());
            pack.node_pieces.push(
                piece_base
                    .checked_add(piece)
                    .ok_or_else(|| bad("piece overflow"))?,
            );
        }
        for k in 0..t.bond_count {
            let o = h.sections.bonds.offset + (t.bond_start + k) * BOND;
            let a = u32_at(p, o + 56)?;
            let b = u32_at(p, o + 60)?;
            let area = f64_at(p, o + 48)?;
            let normal = vector(rotate(triple(p, o + 24)?, i).map(round))?;
            if a as usize >= t.node_count
                || b as usize >= t.node_count
                || area <= 0.
                || (normal.length() - 1.).abs() > 1e-4
                || u32_at(p, o + 68)? != 0
            {
                return Err(bad("invalid bond"));
            }
            pack.bonds.push(SceneBond {
                node0: node_base + a,
                node1: node_base + b,
                centroid: point(triple(p, o)?, i)?,
                normal,
                area: f32_value(area)?,
                material: mapped(u32_at(p, o + 64)?, i)?,
            });
        }
        piece_base = piece_base
            .checked_add(t.piece_span)
            .ok_or_else(|| bad("piece span overflow"))?;
    }
    Ok(pack)
}

/// Preserve authored placement boundaries when loading a complete town. The
/// network has a bounded structure namespace, so adjacent placements are packed
/// into batches without ever splitting a building or adding inter-instance bonds.
pub fn decode_city(bytes: &[u8]) -> R<crate::city::CityScene> {
    use crate::city::{pack_height_m, BuildingInstance, CityScene, CitySceneDesc};
    use crate::ids::{MAX_BONDS_PER_STRUCTURE, MAX_NODES_PER_STRUCTURE, MAX_STRUCTURES};
    use crate::variants::BuildingVariant;
    let pack = decode(bytes)?;
    // decode validated the descriptor, references, checksums and expanded ranges.
    let len = u32_at(bytes, 8)? as usize;
    let header: Header =
        serde_json::from_slice(&bytes[64..64 + len]).map_err(|e| bad(format!("header: {e}")))?;
    let mut ranges = Vec::new();
    let (mut ns, mut bs, mut ne, mut be) = (0usize, 0usize, 0usize, 0usize);
    for instance in &header.instances {
        let template = &header.templates[instance.template];
        if template.node_count == 0
            || template.node_count > MAX_NODES_PER_STRUCTURE as usize
            || template.bond_count > MAX_BONDS_PER_STRUCTURE as usize
        {
            return Err(bad("one placement exceeds runtime structure limits"));
        }
        if ne - ns + template.node_count > MAX_NODES_PER_STRUCTURE as usize
            || be - bs + template.bond_count > MAX_BONDS_PER_STRUCTURE as usize
        {
            ranges.push((ns, ne, bs, be));
            ns = ne;
            bs = be;
        }
        ne += template.node_count;
        be += template.bond_count;
    }
    if ne > ns {
        ranges.push((ns, ne, bs, be));
    }
    if ranges.is_empty() || ranges.len() > MAX_STRUCTURES as usize {
        return Err(bad("scene exceeds runtime structure namespace"));
    }
    let mut variants = Vec::with_capacity(ranges.len());
    let mut instances = Vec::with_capacity(ranges.len());
    for (index, (ns, ne, bs, be)) in ranges.into_iter().enumerate() {
        let mut bonds = pack.bonds[bs..be].to_vec();
        for bond in &mut bonds {
            // A format instance cannot bond to another instance. Check this
            // invariant here too, before converting global endpoints to local IDs.
            if bond.node0 < ns as u32
                || bond.node0 >= ne as u32
                || bond.node1 < ns as u32
                || bond.node1 >= ne as u32
            {
                return Err(bad("bond crosses runtime structure boundary"));
            }
            bond.node0 -= ns as u32;
            bond.node1 -= ns as u32;
        }
        let part = ScenePack {
            title: pack.title.clone(),
            version: pack.version,
            stress_limits: pack.stress_limits,
            materials: pack.materials.clone(),
            appearances: pack.appearances.clone(),
            nodes: pack.nodes[ns..ne].to_vec(),
            bonds,
            node_sizes: pack.node_sizes[ns..ne].to_vec(),
            node_colliders: pack.node_colliders[ns..ne].to_vec(),
            node_types: pack.node_types[ns..ne].to_vec(),
            node_pieces: pack.node_pieces[ns..ne].to_vec(),
        };
        variants.push(BuildingVariant {
            height: pack_height_m(&part),
            floors: 1,
            pack: part,
        });
        instances.push(BuildingInstance {
            structure_id: index as u32,
            variant_index: index,
            offset: Vec3::ZERO,
        });
    }
    Ok(CityScene {
        desc: CitySceneDesc {
            grid: 1,
            pitch_m: 0.0,
            varied_heights: false,
        },
        variants,
        instances,
    })
}
