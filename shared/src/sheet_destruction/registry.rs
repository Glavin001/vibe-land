//! Registry of destructible sheets derived from authored static props.

use std::cell::RefCell;
use std::collections::HashMap;

use nalgebra::{UnitQuaternion, Vector3};

use crate::world_document::StaticProp;

use super::carve::{apply_carve, CarveApplyResult, CarveEvent};
use super::coarse_collision::{
    take_collision_rebuild, CoarseCollisionSnapshot, OrientedWorldCuboid,
};
use super::islands::{cull_dual_skin_islands, DroppedIsland};
use super::materials::{lookup_sheet_material, SheetMaterial, SheetMaterialId};
use super::mask::SheetMask;
use super::remesh::{remesh_sheet_skins, transform_mesh_to_world, SheetMesh};

#[derive(Clone, Debug)]
struct MeshCache {
    outer_rev: u32,
    inner_rev: u32,
    mesh: SheetMesh,
}

/// Local UV frame for a sheet. Positions in UV meters map onto the prop face.
#[derive(Clone, Debug)]
pub struct SheetUvFrame {
    /// World-space origin of UV (0,0) — min corner of the sheet face.
    /// Lies on the mid-plane; skins sit at ±thickness/2 along `axis_thickness`.
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
    /// Entry skin (facing +thickness).
    pub mask: SheetMask,
    /// Exit skin (facing -thickness). Through-holes require both open.
    pub inner_mask: SheetMask,
    pub event_log: Vec<CarveEvent>,
    mesh_cache: RefCell<Option<MeshCache>>,
    /// Last coarse-collision snapshot used for a physics rebuild.
    pub collision_snapshot: Option<CoarseCollisionSnapshot>,
}

impl SheetInstance {
    pub fn material(&self) -> &'static SheetMaterial {
        lookup_sheet_material(self.material_id)
    }

    pub fn invalidate_mesh_cache(&self) {
        *self.mesh_cache.borrow_mut() = None;
    }

    /// If usefulness changed enough, return greedy world cuboids for Rapier.
    pub fn take_collision_cuboids_if_dirty(&mut self) -> Option<Vec<OrientedWorldCuboid>> {
        take_collision_rebuild(
            &self.mask,
            &self.inner_mask,
            &self.frame,
            &mut self.collision_snapshot,
        )
    }

    /// Always rebuild greedy cuboids (used when a falling cutout needs the
    /// parent hole opened before the debris body is spawned).
    pub fn take_collision_cuboids_forced(&mut self) -> Vec<OrientedWorldCuboid> {
        use super::coarse_collision::{
            build_greedy_collision_cuboids, compute_collision_snapshot,
        };
        let boxes =
            build_greedy_collision_cuboids(&self.mask, &self.inner_mask, &self.frame);
        self.collision_snapshot =
            Some(compute_collision_snapshot(&self.mask, &self.inner_mask, &self.frame));
        boxes
    }

    pub fn build_mesh(&self) -> SheetMesh {
        let outer_rev = self.mask.rev;
        let inner_rev = self.inner_mask.rev;
        if let Some(cache) = self.mesh_cache.borrow().as_ref() {
            if cache.outer_rev == outer_rev && cache.inner_rev == inner_rev {
                return cache.mesh.clone();
            }
        }
        let mesh = remesh_sheet_skins(&self.mask, &self.inner_mask, self.frame.thickness);
        *self.mesh_cache.borrow_mut() = Some(MeshCache {
            outer_rev,
            inner_rev,
            mesh: mesh.clone(),
        });
        mesh
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
        let thickness = sheet.frame.thickness;
        let result = apply_carve_skins(
            &mut sheet.mask,
            &mut sheet.inner_mask,
            mat,
            event,
            thickness,
        );
        if result.applied {
            sheet.invalidate_mesh_cache();
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
            if sheet.mask.rev > 0 || sheet.inner_mask.rev > 0 {
                events.extend(sheet.event_log.iter().cloned());
            }
        }
        events
    }
}

/// Carve outer skin, then spend penetration energy to carve a (usually smaller /
/// UV-offset) exit hole on the inner skin. Island drops are coupled so a fallen
/// front patch never leaves a floating back cap.
pub fn apply_carve_skins(
    outer: &mut SheetMask,
    inner: &mut SheetMask,
    mat: &SheetMaterial,
    event: &CarveEvent,
    thickness: f32,
) -> CarveApplyResult {
    let outer_result = apply_carve(outer, mat, event);
    if !outer_result.applied {
        return outer_result;
    }

    let momentum = (event.mass_or_energy * event.normal_speed).max(0.0);
    let cost = mat.penetration_cost_per_meter * thickness.max(mat.thickness);
    let remaining = (momentum - cost).max(0.0);
    let factor = if momentum > 1e-6 {
        (remaining / momentum).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let mut carved = outer_result.carved_cells;
    let mut damaged = outer_result.damaged_cells;

    if factor >= 0.05 && outer_result.carved_cells > 0 {
        // Skew exit UV along in-plane travel through the slab.
        let dir_len =
            (event.dir_uv[0] * event.dir_uv[0] + event.dir_uv[1] * event.dir_uv[1]).sqrt();
        let path = thickness / 0.65;
        let mut exit = event.clone();
        if dir_len > 1e-4 {
            exit.uv[0] += event.dir_uv[0] / dir_len * path * dir_len.clamp(0.05, 1.0);
            exit.uv[1] += event.dir_uv[1] / dir_len * path * dir_len.clamp(0.05, 1.0);
        }
        exit.footprint_radius = (event.footprint_radius * (0.35 + 0.65 * factor))
            .max(event.footprint_radius * 0.35);
        exit.mass_or_energy = event.mass_or_energy * factor;
        exit.seed = event.seed.wrapping_add(0xA5A5_A5A5);

        let inner_result = apply_carve(inner, mat, &exit);
        carved += inner_result.carved_cells;
        damaged += inner_result.damaged_cells;
    } else if inner.seq < event.seq {
        // Keep dual masks ordered for replay when there is no exit carve.
        inner.seq = event.seq;
        inner.mix_event_hash(&event.to_hash_bytes());
    }

    // Coupled island cull — must run even if only the outer skin carved, so a
    // ring-cut front cannot leave an intact back "cap" suspended in the hole.
    let mut dropped_islands: Vec<DroppedIsland> = Vec::new();
    if carved > 0 || outer_result.carved_cells > 0 {
        let (cleared, dropped) = cull_dual_skin_islands(outer, inner, mat);
        carved += cleared;
        dropped_islands = dropped;
        // Collapse either skin if almost gone.
        for mask in [&mut *outer, &mut *inner] {
            if mask.occupancy_ratio() < 0.05 {
                for y in 0..mask.height {
                    for x in 0..mask.width {
                        if mask.occupied(x, y) {
                            mask.set_occupied(x, y, false);
                            carved += 1;
                        }
                    }
                }
            }
        }
        outer.rev = outer.rev.wrapping_add(1);
        inner.rev = inner.rev.wrapping_add(1);
    }

    CarveApplyResult {
        carved_cells: carved,
        damaged_cells: damaged,
        applied: true,
        dropped_islands,
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

    let mask = SheetMask::new(width, height, cell);
    let inner_mask = SheetMask::new(width, height, cell);
    Some(SheetInstance {
        id: prop.id,
        material_id: mat_id,
        frame,
        mask,
        inner_mask,
        event_log: Vec::new(),
        mesh_cache: RefCell::new(None),
        collision_snapshot: None,
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
    fn rifle_round_punches_through_drywall_both_skins() {
        let mut reg = SheetRegistry::from_static_props(&[wall_prop(1, "drywall")]);
        let sheet = reg.get_mut(1).unwrap();
        let uv = [2.0, 1.5];
        let event = bullet_event(1, 1, uv, 11);
        let before_inner = sheet.inner_mask.occupancy_count();
        let result = reg.apply_event(&event).unwrap();
        assert!(result.carved_cells > 0);
        let sheet = reg.get(1).unwrap();
        assert!(sheet.mask.occupancy_count() < sheet.mask.cell_count());
        assert!(
            sheet.inner_mask.occupancy_count() < before_inner,
            "exit skin should also carve for a rifle round on drywall"
        );
    }

    #[test]
    fn weak_hit_leaves_blind_pocket() {
        let mut reg = SheetRegistry::from_static_props(&[wall_prop(1, "wood")]);
        let event = CarveEvent {
            sheet_id: 1,
            seq: 1,
            uv: [2.0, 1.5],
            dir_uv: [0.0, 0.0],
            // Low momentum — should break outer wood cells only barely / not exit.
            normal_speed: 80.0,
            mass_or_energy: 0.01,
            footprint_radius: 0.006,
            seed: 3,
        };
        let before_inner = reg.get(1).unwrap().inner_mask.occupancy_count();
        let _ = reg.apply_event(&event).unwrap();
        let sheet = reg.get(1).unwrap();
        // Either no outer carve, or outer carved with inner intact (blind).
        assert_eq!(sheet.inner_mask.occupancy_count(), before_inner);
    }

    #[test]
    fn carve_ring_drops_disconnected_middle_on_both_skins() {
        let mut reg = SheetRegistry::from_static_props(&[wall_prop(1, "drywall")]);
        let sheet = reg.get_mut(1).unwrap();
        let cell = sheet.mask.cell_size;
        // Ring-cut only the outer skin — inner stays solid until coupled cull.
        let cx = (sheet.mask.width / 2) as i32;
        let cy = (sheet.mask.height / 2) as i32;
        let ring_outer = 18i32;
        let ring_inner = 10i32;
        for dy in -ring_outer..=ring_outer {
            for dx in -ring_outer..=ring_outer {
                let adx = dx.abs();
                let ady = dy.abs();
                let in_outer = adx <= ring_outer && ady <= ring_outer;
                let in_inner = adx < ring_inner && ady < ring_inner;
                if in_outer && !in_inner {
                    let x = (cx + dx) as u16;
                    let y = (cy + dy) as u16;
                    if sheet.mask.in_bounds(x as i32, y as i32) {
                        sheet.mask.set_occupied(x, y, false);
                    }
                }
            }
        }
        assert!(sheet.mask.occupied(cx as u16, cy as u16));
        assert!(sheet.inner_mask.occupied(cx as u16, cy as u16));
        let event = bullet_event(
            1,
            1,
            [
                (cx as f32 + ring_outer as f32 + 4.0) * cell,
                (cy as f32) * cell,
            ],
            7,
        );
        let result = reg.apply_event(&event).unwrap();
        let sheet = reg.get(1).unwrap();
        assert!(
            !sheet.mask.occupied(cx as u16, cy as u16),
            "outer island should drop"
        );
        assert!(
            !sheet.inner_mask.occupied(cx as u16, cy as u16),
            "inner cap under fallen outer island must drop too"
        );
        assert!(
            !result.dropped_islands.is_empty(),
            "cull should report dropped island AABBs"
        );
    }

    #[test]
    fn doorway_sized_island_is_debris_worthy() {
        use super::super::falling_debris::{debris_spawns_from_islands, is_debris_worthy};
        let mut reg = SheetRegistry::from_static_props(&[wall_prop(1, "drywall")]);
        let sheet = reg.get_mut(1).unwrap();
        // Cut a free rectangular door panel (~1.2 x 2.0 m).
        let u0 = ((1.4 / sheet.mask.cell_size) as u16).max(1);
        let u1 = ((2.6 / sheet.mask.cell_size) as u16).min(sheet.mask.width - 2);
        let v0 = 1u16;
        let v1 = ((2.0 / sheet.mask.cell_size) as u16).min(sheet.mask.height - 2);
        // Ring: clear a one-cell frame around the panel on both skins.
        for y in v0.saturating_sub(1)..=(v1 + 1).min(sheet.mask.height - 1) {
            for x in u0.saturating_sub(1)..=(u1 + 1).min(sheet.mask.width - 1) {
                let on_ring = x == u0 - 1 || x == u1 + 1 || y == v0.saturating_sub(1) || y == v1 + 1;
                if on_ring {
                    sheet.mask.set_occupied(x, y, false);
                    sheet.inner_mask.set_occupied(x, y, false);
                }
            }
        }
        let event = bullet_event(1, 1, [2.0, 1.0], 11);
        let result = reg.apply_event(&event).unwrap();
        assert!(result.dropped_islands.iter().any(is_debris_worthy));
        let sheet = reg.get(1).unwrap();
        let spawns = debris_spawns_from_islands(&result.dropped_islands, &sheet.frame);
        assert!(!spawns.is_empty(), "doorway cutout should spawn debris cuboids");
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
