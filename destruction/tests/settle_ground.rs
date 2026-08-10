//! The settle policy must never freeze a body that is still sunk in the floor.
//!
//! A sleeping PhysX body receives no depenetration, so calling `putToSleep()`
//! while a chunk is intersecting the ground strands it below the floor forever.
//! That is the "objects fall through the floor" report: the debris was not
//! tunnelling, it was being force-slept mid-penetration and left there.
//!
//! `CityDestruction::post_step` owns the real guard but needs a live PhysX
//! world, so these tests pin the policy that guard is built on.

use vibe_land_destruction::settle::{SettleConfig, SettleSample, SettleTracker};

const HZ: u32 = 60;

fn quiet(body: u32) -> SettleSample {
    SettleSample {
        body_entity: body,
        linear_speed: 0.01,
        angular_speed: 0.01,
    }
}

/// A body creeping upward out of penetration reads as "quiet" long before it
/// is actually seated: PhysX caps depenetration speed, so the velocity can sit
/// under the settle floor for the whole climb.
#[test]
fn depenetrating_body_looks_quiet_to_the_settle_floor() {
    let config = SettleConfig::validated(HZ);
    let depenetration_speed = 0.04_f32; // well under a typical max, and under the floor
    assert!(
        depenetration_speed < config.linear_floor,
        "a body being pushed out of the ground at {depenetration_speed} m/s reads as settled \
         (floor {}), which is exactly why position has to be checked too",
        config.linear_floor
    );
}

/// Without a position check the tracker settles a still-sunk body, and once
/// settled it is dropped from tracking entirely — nothing ever revisits it.
#[test]
fn tracker_settles_a_quiet_body_regardless_of_position() {
    let config = SettleConfig::validated(HZ);
    let mut tracker = SettleTracker::default();
    tracker.promote(7, 0);

    let mut settled = Vec::new();
    for tick in 1..=(config.quiet_ticks as u64 + 1) {
        settled = tracker.update(tick, [quiet(7)], config);
        if !settled.is_empty() {
            break;
        }
    }
    assert_eq!(settled, vec![7], "quiet body should reach the settle list");
    assert_eq!(
        tracker.tracked(),
        0,
        "settled bodies stop being tracked, so a sunk one is never reconsidered"
    );
}

/// The guard: re-arming a deferred body keeps it tracked so it settles later,
/// once it is actually above the floor.
#[test]
fn re_arming_a_deferred_body_keeps_it_eligible() {
    let config = SettleConfig::validated(HZ);
    let mut tracker = SettleTracker::default();
    tracker.promote(7, 0);

    // Run until it wants to settle, then defer it the way post_step does.
    let mut tick = 1_u64;
    loop {
        if !tracker.update(tick, [quiet(7)], config).is_empty() {
            break;
        }
        tick += 1;
        assert!(tick < 1_000, "body should want to settle");
    }
    tracker.wake(7, tick);
    assert_eq!(tracker.tracked(), 1, "deferred body must stay tracked");

    // Still penetrating: keeps deferring, never lost.
    for _ in 0..3 {
        if !tracker.update(tick, [quiet(7)], config).is_empty() {
            tracker.wake(7, tick);
        }
        tick += 1;
    }
    assert_eq!(tracker.tracked(), 1);

    // Once free of the ground the caller stops deferring and it settles.
    let mut settled = Vec::new();
    for _ in 0..=(config.quiet_ticks as u64 + 1) {
        settled = tracker.update(tick, [quiet(7)], config);
        if !settled.is_empty() {
            break;
        }
        tick += 1;
    }
    assert_eq!(settled, vec![7], "a re-armed body must still be able to settle");
}

/// The force-sleep deadline fires even on a body that never goes quiet, which
/// is the other way a still-falling chunk used to get frozen mid-air.
#[test]
fn force_sleep_deadline_still_applies_to_moving_bodies() {
    let config = SettleConfig::validated(HZ);
    let mut tracker = SettleTracker::default();
    tracker.promote(9, 0);
    let moving = SettleSample {
        body_entity: 9,
        linear_speed: 5.0,
        angular_speed: 5.0,
    };
    let mut settled = Vec::new();
    for tick in 1..=(config.force_sleep_ticks as u64) {
        settled = tracker.update(tick, [moving], config);
    }
    assert_eq!(
        settled,
        vec![9],
        "the {}-tick deadline must still fire, so the ground guard is what keeps \
         a fast-falling chunk from being frozen underground",
        config.force_sleep_ticks
    );
}
