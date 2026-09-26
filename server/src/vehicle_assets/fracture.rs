//! Authored fracture data shared by garage and city vehicle preparation.
//! This validates and indexes the graph; only the native solver may break it.
use super::PreparedGeometry;
use nalgebra::{Matrix3, Vector3};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssetFunction {
    Chassis,
    Engine,
    Driveline,
}

#[cfg(feature = "native-destruction")]
pub struct NativeVehicleAssembly {
    pub parts: Vec<vibe_land_physx_bridge::VehicleFracturePart>,
    pub shapes: Vec<vibe_land_physx_bridge::VehiclePartShape>,
    pub bonds: Vec<vibe_land_physx_bridge::ChunkBondDesc>,
    pub materials: Vec<vibe_land_physx_bridge::StressMaterialDesc>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AssetMassProperties {
    pub mass: f64,
    /// Actor-local COM; inertia is about this COM in the actor axes, kg m².
    pub center: [f64; 3],
    pub inertia: [[f64; 3]; 3],
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBondStrength {
    pub compression_elastic: f64,
    pub compression_fatal: f64,
    pub tension_elastic: f64,
    pub tension_fatal: f64,
    pub shear_elastic: f64,
    pub shear_fatal: f64,
    pub elastic_modulus: f64,
    pub residual_area_fraction: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBond {
    pub a: String,
    pub b: String,
    pub area: f64,
    pub centroid: [f64; 3],
    pub normal: [f64; 3],
    pub validated_surface: bool,
    pub strength: AssetBondStrength,
}

#[derive(Clone, Debug)]
pub struct FractureLayout {
    pub chunk_count: usize,
    /// One index per collision group, even when that group has multiple hulls.
    pub visual_chunks: BTreeMap<String, u32>,
    /// Authored order, including parallel interfaces between the same chunks.
    pub bond_chunks: Vec<[u32; 2]>,
    /// Native Vehicle2 corner order, derived from actor-space wheel positions.
    /// All wheel-role groups (e.g. tire and hub) must remain connected to drive.
    pub wheel_chunks: [Vec<u32>; 4],
    pub chassis_chunk: Option<u32>,
    /// Loss of any of these functions disconnects power from the wheels.
    pub powertrain_chunks: Vec<u32>,
}

impl FractureLayout {
    /// Consume a complete, committed native ownership snapshot. This does not
    /// predict a break or walk a second copy of the bond graph on the CPU.
    pub fn wheel_mask(
        &self,
        chassis_owner: Option<u32>,
        owners: &[Option<u32>],
    ) -> Result<u8, String> {
        if owners.len() != self.chunk_count {
            return Err("incomplete vehicle chunk ownership snapshot".into());
        }
        let Some(chassis) = chassis_owner else {
            return Ok(0);
        };
        Ok(self
            .wheel_chunks
            .iter()
            .enumerate()
            .fold(0, |mask, (wheel, chunks)| {
                if chunks
                    .iter()
                    .all(|&chunk| owners[chunk as usize] == Some(chassis))
                {
                    mask | (1 << wheel)
                } else {
                    mask
                }
            }))
    }
}

fn matrix(values: &[[f64; 3]; 3]) -> Matrix3<f64> {
    Matrix3::from_fn(|r, c| values[r][c])
}

impl AssetMassProperties {
    fn validate(&self) -> Result<(), String> {
        if !self.mass.is_finite()
            || self.mass <= 0.0
            || self.center.iter().any(|v| !v.is_finite())
            || self.inertia.iter().flatten().any(|v| !v.is_finite())
        {
            return Err("non-finite or non-positive mass properties".into());
        }
        let inertia = matrix(&self.inertia);
        let scale = inertia.norm().max(f64::MIN_POSITIVE);
        if (inertia - inertia.transpose()).norm() > scale * 1e-8 {
            return Err("inertia tensor is not symmetric".into());
        }
        let moments = inertia.symmetric_eigen().eigenvalues;
        if moments.min() <= 0.0 || 2.0 * moments.max() > moments.sum() + scale * 1e-6 {
            return Err("inertia tensor is not physically realizable".into());
        }
        Ok(())
    }
}

impl PreparedGeometry {
    /// Convert the validated shared asset once. Hulls and nodes use the same
    /// indices, every measured interface survives, and mass comes from visual
    /// solids rather than the (deliberately larger) collision proxies.
    #[cfg(feature = "native-destruction")]
    pub fn native_fracture_assembly(&self) -> Result<NativeVehicleAssembly, String> {
        use vibe_land_physx_bridge as bridge;
        let layout = self.validate_vehicle2_fracture_layout()?;
        let vector = |v: [f64; 3]| bridge::Vec3::new(v[0] as f32, v[1] as f32, v[2] as f32);
        let mut materials = Vec::new();
        let parts = self
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let p = &part.mass_properties;
                bridge::VehicleFracturePart {
                    part_index: index as u32,
                    mass: part.mass as f32,
                    volume: part.volume as f32,
                    center: vector(p.center),
                    inertia_diagonal: vector([p.inertia[0][0], p.inertia[1][1], p.inertia[2][2]]),
                    inertia_products: vector([p.inertia[0][1], p.inertia[0][2], p.inertia[1][2]]),
                    wheel: layout
                        .wheel_chunks
                        .iter()
                        .position(|w| w[0] == index as u32)
                        .map_or(255, |w| w as u8),
                    engine: layout.powertrain_chunks.contains(&(index as u32)),
                }
            })
            .collect();
        let shapes = self
            .parts
            .iter()
            .enumerate()
            .flat_map(|(index, part)| {
                part.shapes
                    .iter()
                    .map(move |shape| bridge::VehiclePartShape {
                        part_index: index as u32,
                        position: bridge::Vec3::new(
                            part.position[0] + shape.position[0],
                            part.position[1] + shape.position[1],
                            part.position[2] + shape.position[2],
                        ),
                        points: shape
                            .vertices
                            .iter()
                            .map(|v| bridge::Vec3::new(v[0], v[1], v[2]))
                            .collect(),
                    })
            })
            .collect();
        let bonds = self
            .bonds
            .iter()
            .enumerate()
            .map(|(index, bond)| {
                let s = &bond.strength;
                let material = bridge::StressMaterialDesc {
                    compression_elastic: s.compression_elastic as f32,
                    compression_fatal: s.compression_fatal as f32,
                    tension_elastic: s.tension_elastic as f32,
                    tension_fatal: s.tension_fatal as f32,
                    shear_elastic: s.shear_elastic as f32,
                    shear_fatal: s.shear_fatal as f32,
                    elastic_modulus: s.elastic_modulus as f32,
                    residual_area_fraction: s.residual_area_fraction as f32,
                };
                let material_index = materials
                    .iter()
                    .position(|m| m == &material)
                    .unwrap_or_else(|| {
                        materials.push(material);
                        materials.len() - 1
                    });
                bridge::ChunkBondDesc {
                    bond_index: index as u32,
                    node0: layout.bond_chunks[index][0],
                    node1: layout.bond_chunks[index][1],
                    centroid: vector(bond.centroid),
                    normal: vector(bond.normal),
                    area: bond.area as f32,
                    material: material_index as u32,
                }
            })
            .collect();
        Ok(NativeVehicleAssembly {
            parts,
            shapes,
            bonds,
            materials,
        })
    }

    /// Stronger contract required by the native Vehicle2 fracture adapter.
    /// Legacy cached metadata may still drive intact, but cannot silently pick
    /// its first wheel (or heaviest engine) as the retained chassis actor.
    pub fn validate_vehicle2_fracture_layout(&self) -> Result<FractureLayout, String> {
        let layout = self.validate_fracture_layout()?;
        if layout.chassis_chunk != Some(0) {
            return Err(
                "Vehicle2 fracture requires the authored chassis anchor at chunk zero".into(),
            );
        }
        if !self
            .parts
            .iter()
            .any(|p| p.functionality == Some(AssetFunction::Engine))
        {
            return Err("Vehicle2 fracture requires an authored engine".into());
        }
        if layout.wheel_chunks.iter().any(|w| w.len() != 1) {
            return Err("Vehicle2 fracture requires one complete collider group per wheel".into());
        }
        Ok(layout)
    }

    pub fn validate_fracture_layout(&self) -> Result<FractureLayout, String> {
        self.mass_properties.validate()?;
        if self.parts.is_empty() || self.parts.len() > u32::MAX as usize {
            return Err("invalid chunk count".into());
        }
        let mut ids = HashMap::new();
        let mut visual_chunks = BTreeMap::new();
        let mut wheel_chunks: [Vec<u32>; 4] = std::array::from_fn(|_| Vec::new());
        let mut chassis_chunk = None;
        let mut powertrain_chunks = Vec::new();
        let mut total_mass = 0.0;
        let mut weighted_center = Vector3::zeros();
        for (index, part) in self.parts.iter().enumerate() {
            let fail = |reason: &str| format!("chunk {}: {reason}", part.id);
            if let Some(function) = part.functionality {
                if part.motion.is_some() {
                    return Err(fail(
                        "functional chassis/powertrain must be fixed in the rig",
                    ));
                }
                match function {
                    AssetFunction::Chassis => {
                        if chassis_chunk.replace(index as u32).is_some() {
                            return Err(fail("duplicate chassis anchor"));
                        }
                    }
                    AssetFunction::Engine | AssetFunction::Driveline => {
                        powertrain_chunks.push(index as u32);
                    }
                }
            }
            if part.id.is_empty() || ids.insert(part.id.as_str(), index).is_some() {
                return Err(fail("duplicate or empty ID"));
            }
            part.mass_properties.validate().map_err(|e| fail(&e))?;
            if !part.mass.is_finite()
                || part.mass <= 0.0
                || !part.volume.is_finite()
                || part.volume <= 0.0
                || (part.mass - part.mass_properties.mass).abs() > part.mass * 1e-6
            {
                return Err(fail("mass/volume does not match authored solids"));
            }
            if part.position.iter().any(|v| !v.is_finite())
                || part.shapes.is_empty()
                || part.shapes.iter().any(|s| {
                    s.vertices.len() < 4
                        || s.position.iter().any(|v| !v.is_finite())
                        || s.vertices.iter().flatten().any(|v| !v.is_finite())
                })
            {
                return Err(fail("invalid collision hull"));
            }
            if part.visual_ids.is_empty() {
                return Err(fail("no visual ownership"));
            }
            for visual in &part.visual_ids {
                if visual.is_empty() || visual_chunks.insert(visual.clone(), index as u32).is_some()
                {
                    return Err(fail("duplicate or empty visual identity"));
                }
            }
            if part.motion.as_ref().is_some_and(|m| m["role"] == "wheel") {
                // Source left/right names are reflected when converted to the
                // actor frame. Match geometry, not the misleading name order.
                let position = Vector3::from(part.position);
                let (corner, distance) = self
                    .wheel_centers
                    .iter()
                    .enumerate()
                    .map(|(i, p)| (i, (position - Vector3::from(*p)).norm()))
                    .min_by(|a, b| a.1.total_cmp(&b.1))
                    .unwrap();
                if !distance.is_finite() || distance > self.wheel_half_width * 2.0 {
                    return Err(fail("wheel group does not match a Vehicle2 corner"));
                }
                wheel_chunks[corner].push(index as u32);
            }
            total_mass += part.mass;
            weighted_center += Vector3::from(part.mass_properties.center) * part.mass;
        }
        if wheel_chunks.iter().any(Vec::is_empty) {
            return Err("missing authored wheel collision group".into());
        }
        let center = weighted_center / total_mass;
        let mut inertia = Matrix3::zeros();
        for part in &self.parts {
            let offset = Vector3::from(part.mass_properties.center) - center;
            inertia += matrix(&part.mass_properties.inertia)
                + (Matrix3::identity() * offset.norm_squared() - offset * offset.transpose())
                    * part.mass;
        }
        let authored = &self.mass_properties;
        if !self.mass.is_finite()
            || (total_mass - self.mass as f64).abs() > total_mass * 1e-6
            || (total_mass - authored.mass).abs() > total_mass * 1e-6
            || (center - Vector3::from(authored.center)).norm() > 1e-6
            || (inertia - matrix(&authored.inertia)).norm() > inertia.norm() * 1e-6
        {
            return Err("assembly mass/COM/inertia do not equal the sum of authored chunks".into());
        }
        let mut bond_chunks = Vec::with_capacity(self.bonds.len());
        let mut neighbors = vec![Vec::new(); self.parts.len()];
        for (index, bond) in self.bonds.iter().enumerate() {
            let fail = |reason: &str| format!("bond {index} ({} / {}): {reason}", bond.a, bond.b);
            let a = *ids
                .get(bond.a.as_str())
                .ok_or_else(|| fail("missing endpoint"))?;
            let b = *ids
                .get(bond.b.as_str())
                .ok_or_else(|| fail("missing endpoint"))?;
            let normal = Vector3::from(bond.normal);
            if a == b
                || !bond.validated_surface
                || !bond.area.is_finite()
                || bond.area <= 0.0
                || bond.centroid.iter().any(|v| !v.is_finite())
                || normal.iter().any(|v| !v.is_finite())
                || (normal.norm() - 1.0).abs() > 1e-4
            {
                return Err(fail("invalid measured interface"));
            }
            let s = &bond.strength;
            if [
                (s.compression_elastic, s.compression_fatal),
                (s.tension_elastic, s.tension_fatal),
                (s.shear_elastic, s.shear_fatal),
            ]
            .iter()
            .any(|&(elastic, fatal)| {
                !elastic.is_finite() || !fatal.is_finite() || elastic <= 0.0 || fatal < elastic
            }) || !s.elastic_modulus.is_finite()
                || s.elastic_modulus <= 0.0
                || !s.residual_area_fraction.is_finite()
                || !(0.0..=1.0).contains(&s.residual_area_fraction)
            {
                return Err(fail("invalid strength/material properties"));
            }
            bond_chunks.push([a as u32, b as u32]);
            neighbors[a].push(b);
            neighbors[b].push(a);
        }
        let mut reached = HashSet::new();
        let mut pending = vec![0];
        while let Some(chunk) = pending.pop() {
            if reached.insert(chunk) {
                pending.extend(&neighbors[chunk]);
            }
        }
        if reached.len() != self.parts.len() {
            return Err("authored parts are not one connected assembly".into());
        }
        Ok(FractureLayout {
            chunk_count: self.parts.len(),
            visual_chunks,
            bond_chunks,
            wheel_chunks,
            chassis_chunk,
            powertrain_chunks,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assembly() -> PreparedGeometry {
        let centers = [[-1., 0., 1.], [1., 0., 1.], [-1., 0., -1.], [1., 0., -1.]];
        let mut parts = vec![];
        for i in 0..5 {
            let center = if i == 0 { [0.; 3] } else { centers[i - 1] };
            let mass = if i == 0 { 2. } else { 1. };
            parts.push(json!({"id":format!("part-{i}"), "visualIds":[format!("visual-{i}"),format!("detail-{i}")],
                "mass":mass,"volume":1.,"massProperties":{"mass":mass,"center":center,"inertia":[[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]},
                "motion":if i==0 {json!(null)} else {json!({"role":"wheel"})},"position":center,
                "shapes":[{"position":[0.,0.,0.],"vertices":[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]}]}));
        }
        let bonds:Vec<_> = (1..5).map(|i|json!({"a":"part-0","b":format!("part-{i}"),"area":0.01,
            "centroid":[0.,0.,0.],"normal":[1.,0.,0.],"validatedSurface":true,
            "strength":{"compressionElastic":100.,"compressionFatal":200.,"tensionElastic":100.,"tensionFatal":200.,
                "shearElastic":50.,"shearFatal":100.,"elasticModulus":10000.,"residualAreaFraction":0.}})).collect();
        serde_json::from_value(json!({"mass":6.,"massProperties":{"mass":6.,"center":[0.,0.,0.],"inertia":[[9.,0.,0.],[0.,13.,0.],[0.,0.,9.]]},
            "originHeight":0.65,"wheelCenters":centers,"suspensionTravel":0.2,"neutralJounce":0.1,
            "suspensionAttachmentY":0.,"wheelHalfWidth":0.15,"maxSteerRadians":0.5,
            "bounds":{"min":[-1.,-1.,-1.],"max":[1.,1.,1.]},"parts":parts,"bonds":bonds})).unwrap()
    }

    #[test]
    fn retains_parallel_interfaces_and_grouped_visuals() {
        let mut asset = assembly();
        let mut parallel = asset.bonds[0].clone();
        parallel.centroid[1] = 0.1;
        asset.bonds.push(parallel);
        let extra_hull = asset.parts[1].shapes[0].clone();
        asset.parts[1].shapes.push(extra_hull);
        let layout = asset.validate_fracture_layout().unwrap();
        assert_eq!(layout.chunk_count, 5); // an extra hull adds no mass or node
        assert_eq!(layout.bond_chunks.len(), 5);
        assert_eq!(layout.bond_chunks[0], layout.bond_chunks[4]);
        assert_eq!(
            layout.visual_chunks["visual-1"],
            layout.visual_chunks["detail-1"]
        );
        assert_eq!(layout.wheel_chunks, [vec![1], vec![2], vec![3], vec![4]]);
    }

    fn functional_assembly() -> PreparedGeometry {
        let mut asset = assembly();
        asset.parts[0].functionality = Some(AssetFunction::Chassis);
        let mut engine = asset.parts[0].clone();
        engine.id = "engine".into();
        engine.visual_ids = vec!["engine-visual".into()];
        engine.functionality = Some(AssetFunction::Engine);
        asset.parts.push(engine);
        let mut bond = asset.bonds[0].clone();
        bond.b = "engine".into();
        asset.bonds.push(bond);
        asset.mass += 2.;
        asset.mass_properties.mass += 2.;
        for i in 0..3 {
            asset.mass_properties.inertia[i][i] += 1.;
        }
        asset
    }

    #[test]
    fn native_roles_are_authored_not_inferred_from_mass_or_order() {
        let mut asset = functional_assembly();
        let layout = asset.validate_vehicle2_fracture_layout().unwrap();
        assert_eq!(layout.chassis_chunk, Some(0));
        assert_eq!(layout.powertrain_chunks, [5]);
        asset.parts.swap(0, 5);
        assert!(asset
            .validate_vehicle2_fracture_layout()
            .unwrap_err()
            .contains("chunk zero"));
        asset.parts.swap(0, 5);
        asset.parts[5].functionality = None;
        assert!(asset
            .validate_vehicle2_fracture_layout()
            .unwrap_err()
            .contains("engine"));
        assert!(assembly()
            .validate_vehicle2_fracture_layout()
            .unwrap_err()
            .contains("anchor"));
    }

    #[test]
    fn rejects_moving_functional_parts_duplicate_chassis_and_split_wheel_groups() {
        let mut asset = functional_assembly();
        asset.parts[5].motion = Some(json!({"role":"wheel"}));
        assert!(asset
            .validate_fracture_layout()
            .unwrap_err()
            .contains("fixed"));
        asset.parts[5].motion = None;
        asset.parts[5].functionality = Some(AssetFunction::Chassis);
        assert!(asset
            .validate_fracture_layout()
            .unwrap_err()
            .contains("duplicate chassis"));
        // Split a wheel's original mass into two rigid groups without changing
        // the assembly's total mass, COM or inertia. Generic graph validation
        // allows it, but the Vehicle2 adapter must refuse the ambiguity.
        let mut asset = functional_assembly();
        asset.parts[1].mass *= 0.5;
        asset.parts[1].mass_properties.mass *= 0.5;
        for row in &mut asset.parts[1].mass_properties.inertia {
            for v in row {
                *v *= 0.5;
            }
        }
        let mut hub = asset.parts[1].clone();
        hub.id = "hub".into();
        hub.visual_ids = vec!["hub".into()];
        asset.parts.push(hub);
        let mut bond = asset.bonds[0].clone();
        bond.b = "hub".into();
        asset.bonds.push(bond);
        asset.validate_fracture_layout().unwrap();
        assert!(asset
            .validate_vehicle2_fracture_layout()
            .unwrap_err()
            .contains("one complete"));
    }

    #[cfg(feature = "native-destruction")]
    #[test]
    fn native_conversion_preserves_mass_hulls_parallel_interfaces_and_material_units() {
        let mut asset = functional_assembly();
        let mut extra = asset.parts[1].shapes[0].clone();
        extra.position = [0.1, 0.2, 0.3];
        asset.parts[1].shapes.push(extra);
        let mut parallel = asset.bonds[0].clone();
        parallel.centroid = [0.25, 0.5, 0.75];
        parallel.area *= 0.5;
        asset.bonds.push(parallel);
        let native = asset.native_fracture_assembly().unwrap();
        assert_eq!(native.parts.len(), 6);
        assert_eq!(native.shapes.len(), 7);
        assert_eq!(native.bonds.len(), 6);
        assert_eq!(native.materials.len(), 1);
        assert_eq!(native.parts.iter().map(|p| p.mass).sum::<f32>(), asset.mass);
        assert_eq!(
            native.parts.iter().map(|p| p.wheel).collect::<Vec<_>>(),
            [255, 0, 1, 2, 3, 255]
        );
        assert_eq!(
            native
                .parts
                .iter()
                .filter(|p| p.engine)
                .map(|p| p.part_index)
                .collect::<Vec<_>>(),
            [5]
        );
        assert_eq!(
            native.shapes.iter().filter(|s| s.part_index == 1).count(),
            2
        );
        let shape = &native.shapes[2];
        assert_eq!(shape.position.x, asset.parts[1].position[0] + 0.1);
        assert_eq!(shape.position.y, asset.parts[1].position[1] + 0.2);
        assert_eq!(native.bonds[0].node0, native.bonds[5].node0);
        assert_eq!(native.bonds[0].node1, native.bonds[5].node1);
        assert_eq!(native.bonds[5].area, 0.005);
        assert_eq!(native.bonds[5].centroid.z, 0.75);
        assert_eq!(native.materials[0].compression_elastic, 100.);
        assert_eq!(native.materials[0].elastic_modulus, 10000.);
        // Moving the drivetrain to another part must follow explicit metadata.
        asset.parts[5].functionality = Some(AssetFunction::Driveline);
        assert!(
            asset.native_fracture_assembly().is_err(),
            "an engine is still required"
        );
    }

    #[test]
    fn partial_ownership_removes_only_the_disconnected_corner() {
        let layout = assembly().validate_fracture_layout().unwrap();
        let mut owners = vec![Some(9); 5];
        assert_eq!(layout.wheel_mask(Some(9), &owners).unwrap(), 15);
        owners[2] = Some(20);
        assert_eq!(layout.wheel_mask(Some(9), &owners).unwrap(), 13);
        owners[4] = None;
        assert_eq!(layout.wheel_mask(Some(9), &owners).unwrap(), 5);
        assert_eq!(layout.wheel_mask(None, &owners).unwrap(), 0);
        assert!(layout.wheel_mask(Some(9), &owners[..4]).is_err());
    }

    #[test]
    fn rejects_corrupt_mass_graph_material_and_visual_ownership() {
        let mut bad = assembly();
        bad.mass_properties.inertia[0][0] *= 2.;
        assert!(bad.validate_fracture_layout().unwrap_err().contains("sum"));
        let mut bad = assembly();
        bad.parts[1].mass_properties.inertia[0][0] = -1.;
        assert!(bad
            .validate_fracture_layout()
            .unwrap_err()
            .contains("physically realizable"));
        let mut bad = assembly();
        bad.parts[1].visual_ids[0] = "visual-0".into();
        assert!(bad
            .validate_fracture_layout()
            .unwrap_err()
            .contains("visual identity"));
        let mut bad = assembly();
        bad.bonds.pop();
        assert!(bad
            .validate_fracture_layout()
            .unwrap_err()
            .contains("connected assembly"));
        let mut bad = assembly();
        bad.bonds[0].b = "missing".into();
        assert!(bad
            .validate_fracture_layout()
            .unwrap_err()
            .contains("missing endpoint"));
        let mut bad = assembly();
        bad.bonds[0].strength.shear_fatal = 1.;
        assert!(bad
            .validate_fracture_layout()
            .unwrap_err()
            .contains("strength"));
        let mut bad = assembly();
        bad.bonds[0].validated_surface = false;
        assert!(bad
            .validate_fracture_layout()
            .unwrap_err()
            .contains("measured interface"));
    }

    #[test]
    #[ignore = "requires prepared garage assets through VIBE_VEHICLE_BUILD_FIXTURES"]
    fn authored_garage_fracture_data() {
        let fixtures: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").expect("prepared fixture manifest"),
            )
            .unwrap(),
        )
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let geometry: PreparedGeometry = serde_json::from_slice(
                &std::fs::read(fixture["metadataPath"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            let layout = geometry
                .validate_vehicle2_fracture_layout()
                .unwrap_or_else(|e| panic!("{}: {e}", fixture["name"]));
            #[cfg(feature = "native-destruction")]
            {
                let native = geometry.native_fracture_assembly().unwrap();
                assert_eq!(
                    native.shapes.len(),
                    geometry.parts.iter().map(|p| p.shapes.len()).sum::<usize>()
                );
                assert_eq!(native.bonds.len(), geometry.bonds.len());
                assert_eq!(native.parts.len(), geometry.parts.len());
                for (source, node) in geometry.parts.iter().zip(&native.parts) {
                    let inertia = &source.mass_properties.inertia;
                    assert_eq!(node.mass, source.mass as f32);
                    assert_eq!(node.inertia_products.x, inertia[0][1] as f32);
                    assert_eq!(node.inertia_products.y, inertia[0][2] as f32);
                    assert_eq!(node.inertia_products.z, inertia[1][2] as f32);
                }
            }
            assert_eq!(
                layout
                    .wheel_mask(Some(42), &vec![Some(42); layout.chunk_count])
                    .unwrap(),
                15
            );
            println!(
                "{}: {} chunks, {} interfaces, {} visuals, wheel chunks {:?}",
                fixture["name"],
                layout.chunk_count,
                layout.bond_chunks.len(),
                layout.visual_chunks.len(),
                layout.wheel_chunks
            );
        }
    }
}
