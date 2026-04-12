use vibe_land_shared::world_document::{WorldDocument, WorldDocumentError};

use crate::movement::PhysicsArena;

pub fn seed_default_world(arena: &mut PhysicsArena) -> Result<(), WorldDocumentError> {
    WorldDocument::demo().instantiate(arena)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::MoveConfig;

    #[test]
    fn default_world_bootstrap_matches_demo_document_counts() {
        let world = WorldDocument::demo();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        let expected_dynamic_bodies = world
            .dynamic_entities
            .iter()
            .filter(|entity| {
                !matches!(
                    entity.kind,
                    vibe_land_shared::world_document::DynamicEntityKind::Vehicle
                )
            })
            .count();
        let expected_vehicles = world
            .dynamic_entities
            .iter()
            .filter(|entity| {
                matches!(
                    entity.kind,
                    vibe_land_shared::world_document::DynamicEntityKind::Vehicle
                )
            })
            .count();

        assert_eq!(arena.dynamic.dynamic_bodies.len(), expected_dynamic_bodies);
        assert_eq!(arena.vehicles.len(), expected_vehicles);
    }

    #[test]
    fn default_world_keeps_entities_supported_after_settling() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        for _ in 0..300 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        assert!(
            dynamic_snapshot
                .iter()
                .all(|(_, pos, _, _, _, _, _)| pos[1] > -0.25),
            "dynamic bodies fell below expected terrain support: {:?}",
            dynamic_snapshot
                .iter()
                .map(|(id, pos, _, _, _, _, _)| (*id, pos[1]))
                .collect::<Vec<_>>()
        );

        let vehicles = arena.snapshot_vehicles();
        assert!(
            vehicles.iter().all(|vehicle| vehicle.py_mm > -250),
            "vehicles fell below expected terrain support: {:?}",
            vehicles
                .iter()
                .map(|vehicle| (vehicle.id, vehicle.py_mm))
                .collect::<Vec<_>>()
        );
    }
}
