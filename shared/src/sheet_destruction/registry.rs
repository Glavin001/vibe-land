//! Registry of destructible sheets derived from authored static props.

use std::collections::HashMap;

use nalgebra::{UnitQuaternion, Vector3};

use crate::world_document::StaticProp;

use super::carve::{apply_carve, CarveApplyResult, CarveEvent};
use super::materials::{lookup_sheet_material, SheetMaterial, SheetMaterialId};
use super::mask::SheetMask;
use super::remesh::{remesh_sheet, transform_mesh_to_world, SheetMesh};

/// Local UV frame for a sheet. Positions in UV meters map onto the prop face.
#[derive(Clone, Debug)]
pub struct SheetUvFrame {
    /// World-space origin of UV (0,0) — min corner of the sheet face.
    pub origin: [f32; 3],
    pub axis_u: [f32; 3],
    pub axis_v: [f32; 3],
    /// Outward thickness axis (unit).
    pub axis_thickness: [f32; 3],
    pub size_u: f32,
    pub size_v: f32,
    pub thickness: f32,
}

impl SheetUvFrame {
    pub fn world_to_uv(&self, world: [f32; 3]) -> [f32; 2] {
        let dx = world[0] - self.origin[0];
        let dy = world[1] - self.origin[1];
        let dz = world[2] - self.origin[2];
        let u = dx * self.axis_u[0] + dy * self.axis_u[1] + dz * self.axis_u[2];
        let v = dx * self.axis_v[0] + dy * self.axis_v[1] + dz * self.axis_v[2];
        [u, v]
    }

    pub fn uv_to_world(&self, uv: [f32; 2]) -> [f32; 3] {
        [
            self.origin[0] + self.axis_u[0] * uv[0] + self.axis_v[0] * uv[1],
            self.origin[1] + self.axis_u[1] * uv[0] + self.axis_v[1] * uv[1],
            self.origin[2] + self.axis_u[2] * uv[0] + self.axis_v[2] * uv[1],
        ]
    }
}

#[derive(Clone, Debug)]
pub struct SheetInstance {
    pub id: u32,
    pub material_id: SheetMaterialId,
    pub frame: SheetUvFrame,
    pub mask: SheetMask,
    pub event_log: Vec<CarveEvent>,
}

impl SheetInstance {
    pub fn material(&self) -> &'static SheetMaterial {
        lookup_sheet_material(self.material_id)
    }

    pub fn build_mesh(&self) -> SheetMesh {
        remesh_sheet(&self.mask, self.frame.thickness)
    }

    pub fn build_world_trimesh(&self) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
        let mesh = self.build_mesh();
        transform_mesh_to_world(
            &mesh,
            self.frame.origin,
            self.frame.axis_u,
            self.frame.axis_thickness,
            self.frame.axis_v,
        )
    }
}

#[derive(Clone, Debug, Default)]
pub struct SheetRegistry {
    sheets: HashMap<u32, SheetInstance>,
}

impl SheetRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: u32) -> Option<&SheetInstance> {
        self.sheets.get(&id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut SheetInstance> {
        self.sheets.get_mut(&id)
    }

    pub fn contains(&self, id: u32) -> bool {
        self.sheets.contains_key(&id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&u32, &SheetInstance)> {
        self.sheets.iter()
    }

    pub fn len(&self) -> usize {
        self.sheets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sheets.is_empty()
    }

    /// Build sheets from authored static props whose material is a sheet id.
    pub fn from_static_props(props: &[StaticProp]) -> Self {
        let mut reg = Self::new();
        for prop in props {
            let Some(mat_name) = prop.material.as_deref() else {
                continue;
            };
            let Some(mat_id) = SheetMaterialId::parse(mat_name) else {
                continue;
            };
            if let Some(instance) = sheet_from_prop(prop, mat_id) {
                reg.sheets.insert(instance.id, instance);
            }
        }
        reg
    }

    pub fn apply_event(&mut self, event: &CarveEvent) -> Option<CarveApplyResult> {
        let sheet = self.sheets.get_mut(&event.sheet_id)?;
        let mat = lookup_sheet_material(sheet.material_id);
        let result = apply_carve(&mut sheet.mask, mat, event);
        if result.applied {
            sheet.event_log.push(event.clone());
        }
        Some(result)
    }

    /// All events for sheets that have been carved (for late-join replay).
    pub fn dirty_event_log(&self) -> Vec<CarveEvent> {
        let mut events = Vec::new();
        let mut ids: Vec<u32> = self.sheets.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let sheet = &self.sheets[&id];
            if sheet.mask.rev > 0 {
                events.extend(sheet.event_log.iter().cloned());
            }
        }
        events
    }
}

fn sheet_from_prop(prop: &StaticProp, mat_id: SheetMaterialId) -> Option<SheetInstance> {
    let mat = lookup_sheet_material(mat_id);
    let he = prop.half_extents;
    // Thickness axis = smallest half-extent.
    let (t_axis, size_u, size_v, half_t) = if he[0] <= he[1] && he[0] <= he[2] {
        (0usize, he[1] * 2.0, he[2] * 2.0, he[0])
    } else if he[1] <= he[0] && he[1] <= he[2] {
        (1usize, he[0] * 2.0, he[2] * 2.0, he[1])
    } else {
        (2usize, he[0] * 2.0, he[1] * 2.0, he[2])
    };

    // Reject non-thin props (> 15 cm half → 30 cm thick).
    if half_t > 0.15 {
        return None;
    }

    let rot = UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
        prop.rotation[3],
        prop.rotation[0],
        prop.rotation[1],
        prop.rotation[2],
    ));

    let local_axes = [
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 1.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
    ];
    let (u_local, v_local) = match t_axis {
        0 => (local_axes[1], local_axes[2]),
        1 => (local_axes[0], local_axes[2]),
        _ => (local_axes[0], local_axes[1]),
    };
    let t_local = local_axes[t_axis];

    let axis_u = (rot * u_local).normalize();
    let axis_v = (rot * v_local).normalize();
    let axis_t = (rot * t_local).normalize();

    let center = Vector3::new(prop.position[0], prop.position[1], prop.position[2]);
    // Origin at min corner of the face (center - u*size_u/2 - v*size_v/2).
    let origin = center - axis_u * (size_u * 0.5) - axis_v * (size_v * 0.5);

    let cell = mat.cell_size;
    let width = ((size_u / cell).round() as u16).max(1);
    let height = ((size_v / cell).round() as u16).max(1);
    // Cap extremely large sheets to keep remesh sane (e.g. 8 m × 4 m @ 2 cm = 80k cells).
    if width as u32 * height as u32 > 200_000 {
        return None;
    }

    let frame = SheetUvFrame {
        origin: [origin.x, origin.y, origin.z],
        axis_u: [axis_u.x, axis_u.y, axis_u.z],
        axis_v: [axis_v.x, axis_v.y, axis_v.z],
        axis_thickness: [axis_t.x, axis_t.y, axis_t.z],
        size_u,
        size_v,
        thickness: (half_t * 2.0).max(mat.thickness),
    };

    Some(SheetInstance {
        id: prop.id,
        material_id: mat_id,
        frame,
        mask: SheetMask::new(width, height, cell),
        event_log: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheet_destruction::materials::RIFLE_BULLET_MASS_KG;
    use crate::sheet_destruction::{apply_carve, generate_stamp_mask};
    use crate::world_document::StaticPropKind;

    fn wall_prop(id: u32, material: &str) -> StaticProp {
        StaticProp {
            id,
            kind: StaticPropKind::Cuboid,
            position: [0.0, 1.5, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: [2.0, 1.5, 0.06],
            material: Some(material.to_string()),
        }
    }

    fn bullet_event(sheet_id: u32, seq: u32, uv: [f32; 2], seed: u32) -> CarveEvent {
        CarveEvent {
            sheet_id,
            seq,
            uv,
            dir_uv: [0.0, 0.0],
            normal_speed: 720.0,
            mass_or_energy: RIFLE_BULLET_MASS_KG,
            footprint_radius: 0.006,
            seed,
        }
    }

    #[test]
    fn registry_picks_up_sheet_materials_only() {
        let props = vec![
            wall_prop(1, "drywall"),
            wall_prop(2, "pit-wall"),
            wall_prop(3, "wood"),
        ];
        let reg = SheetRegistry::from_static_props(&props);
        assert!(reg.contains(1));
        assert!(!reg.contains(2));
        assert!(reg.contains(3));
        assert_eq!(reg.len(), 2);
    }

    #[test]
    fn bullet_carves_drywall_hole() {
        let reg_props = vec![wall_prop(1, "drywall")];
        let mut reg = SheetRegistry::from_static_props(&reg_props);
        let sheet = reg.get_mut(1).unwrap();
        let before = sheet.mask.occupancy_count();
        let event = bullet_event(1, 1, [2.0, 1.5], 42);
        let mat = sheet.material();
        let result = apply_carve(&mut sheet.mask, mat, &event);
        assert!(result.applied);
        assert!(result.carved_cells > 0);
        assert!(sheet.mask.occupancy_count() < before);
    }


    #[test]
    fn wood_and_drywall_stamps_differ() {
        let dry = SheetRegistry::from_static_props(&[wall_prop(1, "drywall")]);
        let wood = SheetRegistry::from_static_props(&[wall_prop(2, "wood")]);
        let d = dry.get(1).unwrap();
        let w = wood.get(2).unwrap();
        let event = bullet_event(1, 1, [2.0, 1.5], 99);
        let ds = generate_stamp_mask(&event, d.material(), &d.mask);
        let mut event_w = event.clone();
        event_w.sheet_id = 2;
        let ws = generate_stamp_mask(&event_w, w.material(), &w.mask);
        let mut d_count = 0u32;
        let mut w_count = 0u32;
        let mut same = 0u32;
        for y in 0..d.mask.height {
            for x in 0..d.mask.width {
                let a = ds.get(x, y);
                let b = ws.get(x, y);
                if a {
                    d_count += 1;
                }
                if b {
                    w_count += 1;
                }
                if a == b {
                    same += 1;
                }
            }
        }
        assert!(d_count > 0 && w_count > 0);
        // Dilated drywall stamp should cover more cells than wood.
        assert!(d_count > w_count);
        let total = d.mask.cell_count() as u32;
        assert!(same < total); // not identical bitmasks
    }

    #[test]
    fn determinism_replay_matching_hash() {
        let props = vec![wall_prop(7, "plaster")];
        let mut a = SheetRegistry::from_static_props(&props);
        let mut b = SheetRegistry::from_static_props(&props);
        let events: Vec<_> = (1..=30)
            .map(|i| {
                let fx = (i as f32 * 0.37) % 3.8 + 0.1;
                let fy = (i as f32 * 0.61) % 2.8 + 0.1;
                bullet_event(7, i, [fx, fy], 1000 + i)
            })
            .collect();
        for e in &events {
            a.apply_event(e);
            b.apply_event(e);
        }
        let sa = a.get(7).unwrap();
        let sb = b.get(7).unwrap();
        assert_eq!(sa.mask.event_hash, sb.mask.event_hash);
        assert_eq!(sa.mask.occupancy_bytes(), sb.mask.occupancy_bytes());
        assert_eq!(sa.mask.rev, sb.mask.rev);
    }

    #[test]
    fn adjacent_holes_merge_occupancy() {
        let props = vec![wall_prop(1, "drywall")];
        let mut reg = SheetRegistry::from_static_props(&props);
        // Two close impacts should carve overlapping region.
        reg.apply_event(&bullet_event(1, 1, [2.0, 1.5], 1));
        reg.apply_event(&bullet_event(1, 2, [2.05, 1.5], 2));
        let sheet = reg.get(1).unwrap();
        assert!(sheet.mask.rev >= 2);
        let mesh = sheet.build_mesh();
        assert!(!mesh.positions.is_empty());
        assert!(!mesh.indices.is_empty());
    }

    #[test]
    fn demo_world_has_destructible_huts() {
        use crate::world_document::WorldDocument;
        let world = WorldDocument::demo();
        let reg = SheetRegistry::from_static_props(&world.static_props);
        assert!(reg.len() >= 12, "expected 3 huts × 4 walls, got {}", reg.len());
        let mats: std::collections::HashSet<_> = reg
            .iter()
            .map(|(_, s)| s.material_id)
            .collect();
        assert!(mats.contains(&SheetMaterialId::Drywall));
        assert!(mats.contains(&SheetMaterialId::Wood));
        assert!(mats.contains(&SheetMaterialId::Plaster));
    }

}
