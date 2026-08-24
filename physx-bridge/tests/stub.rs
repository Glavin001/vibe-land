use vibe_land_physx_bridge::{Quat, Vec3, WorldConfig, FIXED_TIMESTEP};

#[cfg(not(feature = "gpu"))]
use vibe_land_physx_bridge::{gpu_support_compiled, BridgeError, World};

#[test]
#[cfg(not(feature = "gpu"))]
fn default_build_is_an_explicit_stub() {
    assert!(!gpu_support_compiled());
    let error = match World::new(WorldConfig::default()) {
        Ok(_) => panic!("stub build unexpectedly constructed a world"),
        Err(error) => error,
    };
    assert!(matches!(error, BridgeError::Unavailable(_)));
    assert!(error.to_string().contains("without feature `gpu`"));
}

#[test]
fn pod_defaults_match_the_fixed_step_contract() {
    assert_eq!(FIXED_TIMESTEP, 1.0 / 60.0);
    assert_eq!(Quat::default(), Quat::IDENTITY);
    // 20 m/s^2, not Earth's 9.81, and deliberately so: the player already
    // falls at 20 (netcode's MoveConfig), which is near-exactly the Source
    // engine's `sv_gravity 800` = 20.32 m/s^2. Raising gravity for jump feel is
    // standard; applying it to only part of the world is not, and Source
    // applies sv_gravity to props and ragdolls too. Running rigid bodies at
    // 9.81 under a 20 m/s^2 player made every falling object read as slow
    // motion -- an 84 m drop took 4.1 s against the player's 2.9 s.
    assert_eq!(
        WorldConfig::default().gravity,
        Vec3::new(0.0, -20.0, 0.0),
        "world gravity must match the gravity the player falls by"
    );
    assert_eq!(WorldConfig::default().gpu_max_partitions, 8);
}
