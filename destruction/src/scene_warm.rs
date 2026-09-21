//! VLSW v1 wraps an unchanged VLSP with physical bond-force initial guesses.
//! A cache never certifies convergence: native residual/material checks still run.
use crate::scene_pack::ScenePackError;
use serde::Deserialize;
use sha2::{Digest, Sha256};

type R<T> = Result<T, ScenePackError>;
fn bad(message: impl Into<String>) -> ScenePackError {
    ScenePackError::Invalid(format!("VLSW: {}", message.into()))
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmStructure {
    pub instance: usize,
    pub node_count: usize,
    pub bond_count: usize,
    pub value_offset: usize,
    pub baked: bool,
    pub evidence_sha256: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmDescriptor {
    pub version: u32,
    pub scene_sha256: String,
    pub runtime_sha256: String,
    pub sdk_provenance_sha256: String,
    pub gravity: [f64; 3],
    pub timestep: f64,
    pub tolerance: f64,
    pub complete: bool,
    pub structures: Vec<WarmStructure>,
}
pub struct WarmBundle<'a> {
    pub scene: &'a [u8],
    pub descriptor: WarmDescriptor,
    pub values: Vec<f32>,
}
impl WarmBundle<'_> {
    /// Exact producer binding. A mismatch is an explicit cold-start decision
    /// for the caller, never a claim that the saved forces remain converged.
    pub fn compatible(
        &self,
        runtime_sha256: &str,
        gravity: [f32; 3],
        dt: f32,
        tolerance: f32,
    ) -> bool {
        self.descriptor.runtime_sha256 == runtime_sha256
            && self.descriptor.gravity.map(|v| v as f32) == gravity
            && self.descriptor.timestep as f32 == dt
            && self.descriptor.tolerance as f32 == tolerance
    }
}
fn u32_at(bytes: &[u8], offset: usize) -> R<usize> {
    let b = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| bad("truncated prefix"))?;
    Ok(u32::from_le_bytes(b.try_into().unwrap()) as usize)
}
pub fn decode(bytes: &[u8]) -> R<WarmBundle<'_>> {
    if bytes.len() < 64 || !bytes.starts_with(b"VLSW") || u32_at(bytes, 4)? != 1 {
        return Err(bad("magic/version"));
    }
    let d = u32_at(bytes, 8)?;
    let s = u32_at(bytes, 12)?;
    let n = u32_at(bytes, 16)?;
    if d > 16 * 1024 * 1024 || s > 512 * 1024 * 1024 || n > 48_000_000 {
        return Err(bad("bounds"));
    }
    let start = 64 + (d + 7) / 8 * 8;
    if start + s + n * 4 != bytes.len() {
        return Err(bad("length"));
    }
    if bytes[20..32]
        .iter()
        .chain(bytes[64 + d..start].iter())
        .any(|&b| b != 0)
    {
        return Err(bad("reserved bytes"));
    }
    if Sha256::digest(&bytes[64..]).as_slice() != &bytes[32..64] {
        return Err(bad("checksum"));
    }
    let descriptor: WarmDescriptor =
        serde_json::from_slice(&bytes[64..64 + d]).map_err(|e| bad(e.to_string()))?;
    let scene = &bytes[start..start + s];
    if descriptor.version != 1
        || !digest(&descriptor.runtime_sha256)
        || !digest(&descriptor.sdk_provenance_sha256)
        || descriptor.scene_sha256 != sha256(scene)
    {
        return Err(bad("provenance"));
    }
    if descriptor.gravity != [0., -9.81, 0.]
        || descriptor.timestep != 1. / 60.
        || descriptor.tolerance != 1e-5
    {
        return Err(bad("unsupported physical settings"));
    }
    // Verify the cold container without expanding all geometry twice. The
    // ordinary VLSP decoder validates records when constructing the scene.
    if scene.len() < 64
        || !scene.starts_with(b"VLSP")
        || u32_at(scene, 4)? != 1
        || u32_at(scene, 12)? != 112
        || u32_at(scene, 16)? != 72
        || u32_at(scene, 24)? > 2_000_000
        || u32_at(scene, 28)? > 8_000_000
        || Sha256::digest(&scene[64..]).as_slice() != &scene[32..64]
    {
        return Err(bad("invalid nested VLSP"));
    }
    let hd = u32_at(scene, 8)?;
    if hd > 16 * 1024 * 1024 || 64 + (hd + 7) / 8 * 8 + u32_at(scene, 20)? != scene.len() {
        return Err(bad("nested VLSP length"));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Template {
        node_count: usize,
        bond_count: usize,
    }
    #[derive(Deserialize)]
    struct Instance {
        template: usize,
    }
    #[derive(Deserialize)]
    struct Header {
        templates: Vec<Template>,
        instances: Vec<Instance>,
    }
    let header: Header =
        serde_json::from_slice(&scene[64..64 + hd]).map_err(|e| bad(e.to_string()))?;
    if header.instances.len() != descriptor.structures.len() {
        return Err(bad("placement count"));
    }
    let values: Vec<f32> = bytes[start + s..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let (mut offset, mut covered) = (0usize, 0usize);
    for (i, r) in descriptor.structures.iter().enumerate() {
        let t = header
            .templates
            .get(header.instances[i].template)
            .ok_or_else(|| bad("template reference"))?;
        if t.node_count == 0 || t.node_count > 65_536 || t.bond_count > 1_048_576 {
            return Err(bad("structure bounds"));
        }
        if r.instance != i
            || r.node_count != t.node_count
            || r.bond_count != t.bond_count
            || r.value_offset != offset
        {
            return Err(bad("placement binding"));
        }
        if r.baked {
            if !r.evidence_sha256.as_deref().map_or(false, digest) {
                return Err(bad("missing evidence"));
            }
            covered += 1;
        } else if r.evidence_sha256.is_some() {
            return Err(bad("cold evidence"));
        }
        let end = offset
            .checked_add(t.bond_count * 6)
            .ok_or_else(|| bad("offset overflow"))?;
        let slice = values
            .get(offset..end)
            .ok_or_else(|| bad("truncated values"))?;
        if slice
            .iter()
            .any(|v| !v.is_finite() || (!r.baked && *v != 0.))
        {
            return Err(bad("invalid guess"));
        }
        offset = end;
    }
    if offset != n || descriptor.complete != (covered == header.instances.len()) {
        return Err(bad("coverage"));
    }
    Ok(WarmBundle {
        scene,
        descriptor,
        values,
    })
}
