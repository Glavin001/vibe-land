#![cfg(feature = "native-destruction")]

//! Rubble that is at rest must be allowed to sleep.
//!
//! After a systematic city bench every run ended with 437-502 city bodies
//! awake for good. Measured from the bench's world truth (the city encoder
//! tape, every awake body's pose each tick): 95% of those bodies had not moved
//! at all -- pose identical tick to tick for 15 s -- yet they were awake,
//! because PhysX sleeps a whole contact island at once and each island held
//! one or two bodies that never stopped moving. Those bodies were not going
//! anywhere either. Each was a thin chunk (a 0.15 m wall panel, or a 0.22 m
//! floor slab lying on panels) in an exact limit cycle: the same poses
//! repeating every 3, 8 or 24 ticks, 2-27 mm amplitude, zero net drift.
//!
//! The fixtures here are such neighbourhoods cut out of a bench's world
//! truth: the rocking body, every body within 4 m of it as it lay, and
//! everything within 8 m beyond that as static boxes. Each body is authored as
//! its own native destruction structure, so it is a stage-owned body built by
//! the production code path, with production damping and solver settings.
//! The test restarts them at rest and asks whether the neighbourhood sleeps,
//! and where the bodies end up.
//!
//! `#[ignore]`: needs the GPU. Run with `--test-threads=1` on Metal.

mod support;
use support::rubble::{fixtures, load, report, run};

/// Each fixture, restarted at rest, must be asleep within twelve seconds.
///
/// panel-rocking-8tick is the one that tells: restarted from the bench's
/// truth, its panel takes up the same 8-tick rocking and, without the bridge's
/// rest sleep (`sleep_resting_islands` in native_observation.cc), never
/// sleeps -- measured under 4, 8 or 16 position iterations, 4 velocity
/// iterations, TGS and a 5 cm contact offset alike. With it, the neighbourhood
/// sleeps at tick 479, with no body more than 12 mm from where the bench left it.
/// The other two settle and sleep on their own once restarted (ticks 76 and
/// 712 either way) and are kept as regression cover.
/// The rest sleep is opt-in (`VIBE_CITY_NATIVE_REST_SLEEP=1`); this test turns
/// it on unless the caller set the variable (=0 makes this fail).
#[test]
#[ignore = "needs a GPU"]
fn rubble_neighbourhoods_sleep() {
    if std::env::var_os("VIBE_CITY_NATIVE_REST_SLEEP").is_none() {
        std::env::set_var("VIBE_CITY_NATIVE_REST_SLEEP", "1");
    }
    let mut failures = Vec::new();
    for name in fixtures() {
        let fixture = load(name);
        let outcome = run(&fixture, 900);
        report(name, &outcome);
        match outcome.all_asleep_tick {
            Some(tick) if tick <= 720 => {}
            other => failures.push(format!(
                "{name}: asleep at {other:?} (limit tick 720), {} awake at 15 s, rocking body path {:.3} m in the last second",
                outcome.awake_at_end, outcome.keeper_path_m
            )),
        }
    }
    assert!(failures.is_empty(), "neighbourhoods that did not sleep:\n{}", failures.join("\n"));
}
