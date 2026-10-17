//! The core's player interpolation (src/interp.rs) replays the web's (net/interpolation.ts
//! PlayerInterpolator) on the fixture client/scripts/player-interp-fixture.mts wrote: 1500 seeded
//! pushes (in order, after gaps, late and duplicate), samples between, before and past the samples,
//! latest and remove. Every sample must equal the web's: hold flags, hp and flags exactly, numbers
//! to 1e-9 (JSON's decimal round trip may move a double by an ulp).

use serde_json::Value;
use vibe_client_core::interp::{PlayerInterpolator, PlayerSample};

fn v3(v: &Value) -> [f64; 3] {
    [v[0].as_f64().unwrap(), v[1].as_f64().unwrap(), v[2].as_f64().unwrap()]
}

fn sample(v: &Value) -> PlayerSample {
    PlayerSample {
        server_time_us: v["serverTimeUs"].as_f64().unwrap(),
        position: v3(&v["position"]),
        velocity: v3(&v["velocity"]),
        yaw: v["yaw"].as_f64().unwrap(),
        pitch: v["pitch"].as_f64().unwrap(),
        hp: v["hp"].as_f64().unwrap(),
        flags: v["flags"].as_f64().unwrap(),
        held: v["held"].as_bool().unwrap_or(false),
    }
}

fn same(got: Option<PlayerSample>, want: &Value, at: usize) {
    if want.is_null() {
        assert!(got.is_none(), "op {at}: web gave none, core {got:?}");
        return;
    }
    let (g, w) = (got.unwrap_or_else(|| panic!("op {at}: core gave none, web {want}")), sample(want));
    assert_eq!((g.held, g.hp, g.flags), (w.held, w.hp, w.flags), "op {at}");
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * (1.0 + b.abs());
    let numbers = |s: &PlayerSample| [s.server_time_us, s.position[0], s.position[1], s.position[2], s.velocity[0], s.velocity[1], s.velocity[2], s.yaw, s.pitch];
    for (a, b) in numbers(&g).into_iter().zip(numbers(&w)) {
        assert!(close(a, b), "op {at}: core {g:?}, web {w:?}");
    }
}

#[test]
fn the_core_interpolates_players_as_the_web_does() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/player_interp_web.json");
    let ops: Vec<Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut interp = PlayerInterpolator::default();
    let (mut samples, mut holds) = (0, 0);
    for (at, op) in ops.iter().enumerate() {
        if let Some(p) = op.get("push") {
            interp.push(p["id"].as_u64().unwrap() as u32, sample(&p["sample"]), p["intervalUs"].as_f64().unwrap());
            holds = holds.max(interp.holds());
        } else if let Some(s) = op.get("sample") {
            let got = interp.sample(s["id"].as_u64().unwrap() as u32, s["targetUs"].as_f64().unwrap());
            samples += 1;
            same(got, &s["out"], at);
        } else if let Some(l) = op.get("latest") {
            same(interp.latest(l["id"].as_u64().unwrap() as u32), &l["out"], at);
        } else if let Some(id) = op.get("remove") {
            interp.remove(id.as_u64().unwrap() as u32);
        }
    }
    eprintln!("{} operations, {samples} samples (up to {holds} rest holds in the histories at once) equal to the web's", ops.len());
    assert!(samples > 300 && holds > 0, "the fixture exercises sampling and rest holds");
}
