//! The product's native destruction stage environment, for GPU tests.
//!
//! The game always runs the stage with PX_DESTRUCTION_ALLOW_UNCONVERGED=1
//! (sim-native/src/city.rs, vehicle_testbed.rs, city_fleet_tests.rs): a stress
//! solve that has not converged at the iteration cap is published and carried
//! into the next tick instead of rejected. The stage reads the variable when
//! its runtime is created (PhysX PxgDestructionRuntime.cu mAllowUnconverged),
//! so call one of these before `World::new`. A GPU test that skips it runs a
//! mode the product never runs, and fails on its first unconverged step with
//! "PhysX fetchResults failed".
//!
//! scripts/verify/lint-gpu-test-env.sh fails any test file that attaches the
//! native stage without one of these (or an explicit setting of the variable).
//!
//! Include with `#[path = "common/stage_env.rs"] mod stage_env;`.
#![allow(dead_code)]

/// The product's stage environment: unconverged solves are published.
pub fn product() {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
}

/// The stage's strict mode, for a test that checks it deliberately: a step
/// whose stress solve did not converge is rejected.
pub fn strict_converged() {
    std::env::remove_var("PX_DESTRUCTION_ALLOW_UNCONVERGED");
}
