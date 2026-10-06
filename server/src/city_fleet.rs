//! Destructible cars for /city (opt-in: `VIBE_CITY_DESTRUCTIBLE_VEHICLES`).
//!
//! Garage builds, prepared by the same worker the garage uses, replace the
//! city's two stock cars. Each is a native destruction structure in the
//! city's own stage, so it has to exist before the city builds (the stage's
//! topology is fixed once configured): the match prepares the assets, spawns
//! and registers the cars, then opens the city. A city reset rebuilds the
//! stage, so it respawns the cars the same way (see `respawn`).
use crate::vehicle_assets::{self, DrivableVehicle, PrepareRequest};
use crate::movement::PhysicsArena;
use std::sync::{Arc, OnceLock};

/// Each chassis the garage has that drives and breaks cleanly (rest, drive
/// and shot suites; the rally hatchback sheds body bonds just driving, so it
/// waits for an authoring fix), in its most characterful tune.
pub const DEFAULT_FLEET: &[&str] = &["monster", "desert", "derby", "circuit", "buggy"];
/// The first fleet car's id; ids are consecutive. The stock cars' ids, so a
/// fleet city names its first car the way a stock city does.
pub const FIRST_ID: u32 = crate::demo_world::CITY_VEHICLE_ID_DELOREAN;
/// Parking slots, (x, z) in ring units and metres: beside each spawn area,
/// off its 6 m radius so nobody spawns inside a car.
const SLOTS: [(f32, f32, f32, f32); 8] = [
    (1.0, 0.0, 0.0, 8.0), (-1.0, 0.0, 0.0, -8.0), (0.0, 1.0, 8.0, 0.0), (0.0, -1.0, -8.0, 0.0),
    (1.0, 0.0, 0.0, -8.0), (-1.0, 0.0, 0.0, 8.0), (0.0, 1.0, -8.0, 0.0), (0.0, -1.0, 8.0, 0.0),
];

/// The builds to field, or None when the city keeps its stock cars.
/// `VIBE_CITY_DESTRUCTIBLE_VEHICLES=1` fields `DEFAULT_FLEET`; a comma list
/// of garage build ids (e.g. `monster,derby`) fields those.
pub fn requested() -> Option<Vec<String>> {
    let value = std::env::var("VIBE_CITY_DESTRUCTIBLE_VEHICLES").ok()?;
    let value = value.trim();
    if value.is_empty() || value == "0" { return None; }
    let builds: Vec<String> = if value == "1" { DEFAULT_FLEET.iter().map(|s| s.to_string()).collect() }
        else { value.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() };
    // A scene that names its parking spots may field one car per spot.
    let capacity = configured_slots().map_or(0, Vec::len).max(SLOTS.len());
    (!builds.is_empty()).then(|| builds.into_iter().take(capacity).collect())
}

pub struct Fleet {
    pub cars: Vec<(u32, String, Arc<DrivableVehicle>)>,
}

/// A garage build's full configuration, read from the client's build list
/// (client/src/vehicles/builds.mjs) so the city fields exactly what the garage
/// shows.
async fn build_configuration(build: &str) -> Result<serde_json::Value, String> {
    let builds = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../client/src/vehicles/builds.mjs");
    let output = tokio::process::Command::new(std::env::var_os("VIBE_NODE_BIN").unwrap_or_else(|| "node".into()))
        .args(["--input-type=module", "-e",
            "const {garageBuilds}=await import(process.argv[1]); const b=garageBuilds.find(b=>b.id===process.argv[2]); \
             if(!b){process.stderr.write('unknown garage build');process.exit(2);} process.stdout.write(JSON.stringify(b.configuration))"])
        .arg(&builds).arg(build)
        .output().await.map_err(|e| format!("node unavailable: {e}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

/// Prepare the fleet once per process (later matches and resets reuse it).
/// A build that cannot be prepared is left out and logged, not fatal.
pub async fn prepare(builds: &[String]) -> Arc<Fleet> {
    static FLEET: OnceLock<Arc<Fleet>> = OnceLock::new();
    if let Some(fleet) = FLEET.get() { return fleet.clone(); }
    let mut cars = Vec::new();
    for build in builds {
        let started = std::time::Instant::now();
        let prepared = async {
            let configuration = build_configuration(build).await?;
            // One worker at a time; a garage preparation may hold it briefly.
            for _ in 0..60 {
                match vehicle_assets::prepare_drivable(PrepareRequest::new(configuration.clone())).await {
                    Err((status, _)) if status == axum::http::StatusCode::TOO_MANY_REQUESTS =>
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await,
                    other => return other.map_err(|(_, message)| message),
                }
            }
            Err("the vehicle worker stayed busy".to_string())
        }.await;
        match prepared {
            Ok(asset) => {
                tracing::info!(build, parts = asset.geometry.parts.len(), ms = started.elapsed().as_millis() as u64, "city fleet car prepared");
                cars.push((FIRST_ID + cars.len() as u32, build.clone(), Arc::new(asset)));
            }
            Err(error) => tracing::error!(build, %error, "city fleet car could not be prepared; left out"),
        }
    }
    FLEET.get_or_init(|| Arc::new(Fleet { cars })).clone()
}

/// Where slot `index` parks its car, (x, z) in metres: the scene's own
/// spots when `VIBE_CITY_FLEET_SLOTS` names them, else the ring's.
pub fn slot_position(index: usize) -> (f32, f32) {
    if let Some(slots) = configured_slots() {
        if !slots.is_empty() {
            let (x, z, _) = slots[index % slots.len()];
            return (x, z);
        }
    }
    let ring = crate::city::spawn_ring_radius_m();
    let (rx, rz, dx, dz) = SLOTS[index % SLOTS.len()];
    (rx * ring + dx, rz * ring + dz)
}

/// Which way slot `index` parks its car, radians about y from +z (towards
/// +x): the scene's own heading for the spot, else facing downtown.
pub fn slot_heading(index: usize) -> f32 {
    let (x, z) = slot_position(index);
    configured_slots()
        .filter(|slots| !slots.is_empty())
        .and_then(|slots| slots[index % slots.len()].2)
        .map_or_else(|| (-x).atan2(-z), f32::to_radians)
}

/// `VIBE_CITY_FLEET_SLOTS="x,z;x,z,heading;..."`: parking spots (metres) for
/// a scene whose ring spots land on its props -- a town's roads, say -- and
/// optionally the heading in degrees (0 faces +z, 90 faces +x), to park a car
/// in a driveway. A car parked inside a structure breaks it the moment it
/// spawns.
fn configured_slots() -> Option<&'static Vec<(f32, f32, Option<f32>)>> {
    static SLOTS_FROM_ENV: OnceLock<Option<Vec<(f32, f32, Option<f32>)>>> = OnceLock::new();
    SLOTS_FROM_ENV
        .get_or_init(|| std::env::var("VIBE_CITY_FLEET_SLOTS").ok().map(|value| parse_slots(&value)))
        .as_ref()
}

fn parse_slots(value: &str) -> Vec<(f32, f32, Option<f32>)> {
    value
        .split(';')
        .filter_map(|slot| {
            let fields: Vec<f32> = slot.split(',').map(|f| f.trim().parse::<f32>()).collect::<Result<_, _>>().ok()?;
            match fields[..] {
                [x, z] if x.is_finite() && z.is_finite() => Some((x, z, None)),
                [x, z, heading] if x.is_finite() && z.is_finite() && heading.is_finite() => Some((x, z, Some(heading))),
                _ => None,
            }
        })
        .collect()
}

/// Park and register every fleet car. Must run before the city opens (or
/// reopens after a reset): the stage configures once, with every structure.
pub fn spawn(arena: &mut PhysicsArena, fleet: &Fleet) {
    for (index, (id, build, asset)) in fleet.cars.iter().enumerate() {
        let (x, z) = slot_position(index);
        // +z forward rotated about y: the slot's heading, else facing downtown.
        let yaw = slot_heading(index);
        let rotation = [0.0, (yaw * 0.5).sin(), 0.0, (yaw * 0.5).cos()];
        let position = nalgebra::Vector3::new(x, asset.geometry.origin_height as f32 + 0.15, z);
        if let Err(error) = arena.spawn_prepared_vehicle_at(*id, 0, position, rotation, &asset.geometry) {
            tracing::error!(id, build, %error, "city fleet car could not spawn");
            continue;
        }
        #[cfg(feature = "native-destruction")]
        match arena.enable_external_vehicle_destruction(*id, &asset.geometry) {
            Ok(()) => tracing::info!(id, build, x, z, "city fleet car is destructible"),
            Err(error) => tracing::warn!(id, build, %error, "city fleet car drives intact (destruction unavailable)"),
        }
    }
}

/// Before a city reset rebuilds the stage: take the fleet out (drivers step
/// out first). `spawn` puts fresh cars back once the stage is clear.
pub fn remove(arena: &mut PhysicsArena, fleet: &Fleet) {
    for (id, _, _) in &fleet.cars {
        if let Err(error) = arena.remove_prepared_vehicle(*id) {
            tracing::warn!(id, %error, "city fleet car could not be removed");
        }
    }
}

#[cfg(test)]
mod slot_tests {
    use super::parse_slots;

    #[test]
    fn parses_parking_spots_and_skips_bad_ones() {
        assert_eq!(parse_slots("-56,-2.5; 56,2.5;x,1;3"), vec![(-56.0, -2.5, None), (56.0, 2.5, None)]);
        assert_eq!(parse_slots("10,20,90;1,2,x;1,2,3,4"), vec![(10.0, 20.0, Some(90.0))]);
        assert!(parse_slots("").is_empty());
    }
}
