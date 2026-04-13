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
    fn default_world_bootstrap_matches_expected_multiplayer_counts() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert_eq!(arena.dynamic.dynamic_bodies.len(), 51);
        assert_eq!(arena.vehicles.len(), 1);
    }

    #[test]
    fn default_world_stays_within_multiplayer_dynamic_budget() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert!(
            arena.dynamic.dynamic_bodies.len() <= 51,
            "default multiplayer world spawned {} dynamic rigid bodies; keep it at or under 51 to match the authored default world",
            arena.dynamic.dynamic_bodies.len()
        );
        assert!(
            arena.vehicles.len() <= 1,
            "default multiplayer world spawned {} vehicles; keep it at or under 1",
            arena.vehicles.len()
        );
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
