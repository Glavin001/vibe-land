//! Suspension-to-destruction mapping: Vehicle2 wheel state -> the posed
//! actor-frame geometry of every fracture chunk. This is CPU reference data
//! for the native geometry revision (stress nodes/bonds, chunk mass frames
//! and collider poses); it predicts no damage and moves no bodies itself.
use super::fracture::AssetMassProperties;
use super::rig::{source_to_actor, Binding, PoseDeltas};
use super::PreparedGeometry;
use nalgebra::{Matrix3, Matrix4, Vector3};

type V = Vector3<f64>;

#[derive(Clone, Debug)]
pub struct PosedChunk {
    pub binding: Binding,
    /// Actor-frame map from the rest hulls to the posed hulls.
    pub hull_transform: Matrix4<f64>,
    /// Sum of individually moved solids (a coil-over carries a rigid damper).
    pub mass: AssetMassProperties,
    /// Scalar stress-node inertia, as the bridge derives it (trace / 3).
    pub node_inertia: f64,
}
#[derive(Clone, Debug)]
pub struct PosedBond {
    pub centroid: V,
    pub normal: V,
    /// Distance between the centroid carried by each endpoint's motion.
    /// Nonzero means the interface is not a joint of the kinematic rig.
    pub endpoint_gap: f64,
}
#[derive(Clone, Debug)]
pub struct PosedGeometry {
    pub chunks: Vec<PosedChunk>,
    pub bonds: Vec<PosedBond>,
}

fn apply(m: &Matrix4<f64>, p: &V) -> V {
    m.transform_point(&(*p).into()).coords
}
fn normal_map(m: &Matrix4<f64>) -> Result<Matrix3<f64>, String> {
    m.fixed_view::<3, 3>(0, 0).into_owned().try_inverse().map(|i| i.transpose()).ok_or_else(|| "singular chunk pose".into())
}

impl PreparedGeometry {
    pub fn chunk_bindings(&self) -> Result<Vec<Binding>, String> {
        self.parts.iter().map(|p| Binding::from_motion(p.motion.as_ref())).collect()
    }
    /// Posed geometry for the given rig deltas. Requires a posed-5 asset:
    /// individually bound solids and the authored bond chunk indices.
    pub fn posed_geometry(&self, deltas: &PoseDeltas, bond_chunks: &[[u32; 2]]) -> Result<PosedGeometry, String> {
        let origin = self.origin_height;
        let actor = |b: Binding| source_to_actor(&deltas.get(b), origin);
        let bindings = self.chunk_bindings()?;
        let mut chunks = Vec::with_capacity(self.parts.len());
        for (part, &binding) in self.parts.iter().zip(&bindings) {
            if part.visuals.is_empty() {
                return Err(format!("{}: asset predates per-solid bindings", part.id));
            }
            let mut moved = Vec::with_capacity(part.visuals.len());
            for visual in &part.visuals {
                let m = actor(Binding::from_motion(visual.motion.as_ref())?);
                moved.push(visual.mass_properties.transformed_by(&m)?);
            }
            let mass = combine(&moved)?;
            let node_inertia = (mass.inertia[0][0] + mass.inertia[1][1] + mass.inertia[2][2]) / 3.0;
            chunks.push(PosedChunk { binding, hull_transform: actor(binding), mass, node_inertia });
        }
        if bond_chunks.len() != self.bonds.len() {
            return Err("bond chunk indices do not match the authored bonds".into());
        }
        let mut bonds = Vec::with_capacity(self.bonds.len());
        for (bond, &[a, b]) in self.bonds.iter().zip(bond_chunks) {
            let (ta, tb) = (&chunks[a as usize].hull_transform, &chunks[b as usize].hull_transform);
            let c = V::from(bond.centroid);
            let (ca, cb) = (apply(ta, &c), apply(tb, &c));
            let n = V::from(bond.normal);
            let normal = (normal_map(ta)? * n).normalize() + (normal_map(tb)? * n).normalize();
            let normal = normal.try_normalize(1e-12).ok_or("bond normal reversed by its endpoint motions")?;
            bonds.push(PosedBond { centroid: (ca + cb) * 0.5, normal, endpoint_gap: (ca - cb).norm() });
        }
        Ok(PosedGeometry { chunks, bonds })
    }
}

/// Parallel-axis sum, as `combineMassProperties` and the layout check do.
pub fn combine(parts: &[AssetMassProperties]) -> Result<AssetMassProperties, String> {
    let mass: f64 = parts.iter().map(|p| p.mass).sum();
    if !(mass.is_finite() && mass > 0.0) {
        return Err("chunk has no mass".into());
    }
    let center = parts.iter().fold(V::zeros(), |s, p| s + V::from(p.center) * p.mass) / mass;
    let mut inertia = Matrix3::zeros();
    for p in parts {
        let d = V::from(p.center) - center;
        inertia += Matrix3::from_fn(|r, c| p.inertia[r][c]) + (Matrix3::identity() * d.norm_squared() - d * d.transpose()) * p.mass;
    }
    Ok(AssetMassProperties {
        mass,
        center: center.into(),
        inertia: std::array::from_fn(|r| std::array::from_fn(|c| inertia[(r, c)])),
    })
}

/// Rebase a rigid body's velocity onto a new mass frame without injecting
/// momentum: linear momentum and angular momentum about a fixed point are
/// conserved, so internal suspension motion cannot spin or push the car.
/// Frames and velocities share one (world or actor) frame; `v` is at the COM.
pub fn rebase_momentum(
    old: &AssetMassProperties,
    new: &AssetMassProperties,
    v: &V,
    omega: &V,
) -> Result<(V, V), String> {
    if (old.mass - new.mass).abs() > old.mass * 1e-12 {
        return Err("a mass frame update must not change mass".into());
    }
    let (c0, c1) = (V::from(old.center), V::from(new.center));
    let i0 = Matrix3::from_fn(|r, c| old.inertia[r][c]);
    let i1 = Matrix3::from_fn(|r, c| new.inertia[r][c]);
    let about_origin = i0 * omega + c0.cross(&(v * old.mass));
    let spin = about_origin - c1.cross(&(v * new.mass));
    let omega1 = i1.try_inverse().ok_or("singular posed inertia")? * spin;
    Ok((*v, omega1))
}
