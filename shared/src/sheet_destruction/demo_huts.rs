//! Demo hut buildings with destructible sheet walls for the default world.

use crate::world_document::{StaticProp, StaticPropKind, WorldDocument};

/// Append three small huts (drywall / wood / plaster) near the primary spawn.
pub fn append_destructible_demo_huts(world: &mut WorldDocument) {
    let mut next_id = world
        .static_props
        .iter()
        .map(|p| p.id)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        .max(2000);

    let mut alloc = || {
        let id = next_id;
        next_id = next_id.saturating_add(1);
        id
    };

    // Near spawn area 1 (~[7.7, 0, -3]).
    push_hut(world, &mut alloc, [4.0, 0.0, -12.0], "drywall");
    push_hut(world, &mut alloc, [14.0, 0.0, -12.0], "wood");
    push_hut(world, &mut alloc, [9.0, 0.0, -20.0], "plaster");
}

fn push_hut(
    world: &mut WorldDocument,
    alloc: &mut dyn FnMut() -> u32,
    origin: [f32; 3],
    wall_material: &str,
) {
    let wall_h = 1.4_f32;
    let wall_half_h = wall_h;
    let thick = 0.06_f32;
    let half_w = 2.0_f32;
    let half_d = 1.6_f32;
    let floor_y = origin[1] + wall_half_h;
    let cx = origin[0];
    let cz = origin[2];

    // Four walls (thin sheets).
    world.static_props.push(StaticProp {
        id: alloc(),
        kind: StaticPropKind::Cuboid,
        position: [cx, floor_y, cz - half_d],
        rotation: [0.0, 0.0, 0.0, 1.0],
        half_extents: [half_w, wall_half_h, thick],
        material: Some(wall_material.to_string()),
    });
    world.static_props.push(StaticProp {
        id: alloc(),
        kind: StaticPropKind::Cuboid,
        position: [cx, floor_y, cz + half_d],
        rotation: [0.0, 0.0, 0.0, 1.0],
        half_extents: [half_w, wall_half_h, thick],
        material: Some(wall_material.to_string()),
    });
    world.static_props.push(StaticProp {
        id: alloc(),
        kind: StaticPropKind::Cuboid,
        position: [cx - half_w, floor_y, cz],
        rotation: [0.0, 0.0, 0.0, 1.0],
        half_extents: [thick, wall_half_h, half_d],
        material: Some(wall_material.to_string()),
    });
    world.static_props.push(StaticProp {
        id: alloc(),
        kind: StaticPropKind::Cuboid,
        position: [cx + half_w, floor_y, cz],
        rotation: [0.0, 0.0, 0.0, 1.0],
        half_extents: [thick, wall_half_h, half_d],
        material: Some(wall_material.to_string()),
    });

    // Solid roof (non-sheet).
    world.static_props.push(StaticProp {
        id: alloc(),
        kind: StaticPropKind::Cuboid,
        position: [cx, origin[1] + wall_h * 2.0 + 0.1, cz],
        rotation: [0.0, 0.0, 0.0, 1.0],
        half_extents: [half_w + 0.15, 0.1, half_d + 0.15],
        material: Some("hut-roof".to_string()),
    });
}
