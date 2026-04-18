//! Per-contact terrain material friction/restitution via
//! [`PhysicsHooks::modify_solver_contacts`].
//!
//! The heightfield collider is authored with a single tile-averaged friction
//! and restitution, which keeps unauthored worlds and the fallback path
//! consistent with Rapier defaults. When a world document provides a
//! [`TerrainMaterialField`], this hook replaces those defaults per contact by
//! sampling the same bilinear field the KCC multiplier and vehicle wheel
//! `friction_slip` already read. All three consumers share
//! [`TerrainMaterialField::sample`] as the single source of truth, so a given
//! world-space (x, z) yields byte-identical friction everywhere.
//!
//! Combine rules used here:
//! - Friction: geometric mean (`sqrt(terrain * other)`) — matches Rapier's
//!   [`CoefficientCombineRule::Multiply`] effective output and gives a
//!   satisfying rubber-on-ice vs steel-on-ice spread without clamping.
//! - Restitution: arithmetic mean — matches Rapier's default
//!   [`CoefficientCombineRule::Average`] so authored `restitution` matches the
//!   baked collider value whenever both sides share a material.

use rapier3d::prelude::{ContactModificationContext, PhysicsHooks};

use crate::world_document::TerrainMaterialField;

pub use vibe_netcode::sim_world::TERRAIN_MATERIAL_USER_DATA_FLAG;

#[inline]
pub fn is_terrain_material_collider(user_data: u128) -> bool {
    user_data & TERRAIN_MATERIAL_USER_DATA_FLAG != 0
}

/// Compose `user_data` with the terrain-material flag bit.
#[inline]
pub fn tag_terrain_user_data(user_data: u128) -> u128 {
    user_data | TERRAIN_MATERIAL_USER_DATA_FLAG
}

/// [`PhysicsHooks`] impl that rewrites each [`SolverContact`]'s friction and
/// restitution based on a bilinear sample of [`TerrainMaterialField`].
///
/// Only contact pairs that include a terrain collider (flagged via
/// [`TERRAIN_MATERIAL_USER_DATA_FLAG`]) are modified; all other pairs fall
/// through to the default rapier coefficient-combine behavior.
pub struct TerrainMaterialHook<'a> {
    field: &'a TerrainMaterialField,
}

impl<'a> TerrainMaterialHook<'a> {
    pub fn new(field: &'a TerrainMaterialField) -> Self {
        Self { field }
    }
}

impl PhysicsHooks for TerrainMaterialHook<'_> {
    fn modify_solver_contacts(&self, context: &mut ContactModificationContext) {
        let Some(c1) = context.colliders.get(context.collider1) else {
            return;
        };
        let Some(c2) = context.colliders.get(context.collider2) else {
            return;
        };
        let c1_is_terrain = is_terrain_material_collider(c1.user_data);
        let c2_is_terrain = is_terrain_material_collider(c2.user_data);
        let other = match (c1_is_terrain, c2_is_terrain) {
            (true, false) => c2,
            (false, true) => c1,
            // Both-terrain or neither-terrain: leave the baked coefficients
            // alone (this should never fire; the flag is only set on static
            // heightfields which cannot collide with each other).
            _ => return,
        };
        let other_friction = other.friction().max(0.0);
        let other_restitution = other.restitution();

        for contact in context.solver_contacts.iter_mut() {
            let material = self.field.sample(contact.point.x, contact.point.z);
            let terrain_friction = material.friction.max(0.0);
            contact.friction = (terrain_friction * other_friction).sqrt();
            contact.restitution = 0.5 * (material.restitution + other_restitution);
        }
    }
}

