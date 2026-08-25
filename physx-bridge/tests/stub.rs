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
    assert_eq!(WorldConfig::default().gravity, Vec3::new(0.0, -9.81, 0.0));
    assert_eq!(WorldConfig::default().gpu_max_partitions, 8);
}
