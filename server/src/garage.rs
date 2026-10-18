//! Private test drives reuse the multiplayer match, terrain and transport.
use crate::vehicle_assets::{self, PrepareRequest, PreparedGeometry, PreparedVehicle};
use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use vibe_land_shared::world_document::WorldDocument;

pub const VEHICLE_ID: u32 = 1001;
/// Cars a destruction range can park (ids VEHICLE_ID..). A test drive has one.
pub const MAX_RANGE_CARS: u32 = 4;
/// Sideways spacing of range cars: room to drive one into another.
const RANGE_CAR_SPACING_M: f32 = 5.5;
const PREFIX: &str = "garage-";
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(Default::default)
}
/// `drive` is the proving-ground test drive. `range` parks the car on the
/// flat pad with the player on foot 12 m away and a cannon (click to fire)
/// whose ball mass and speed the page sets: a repeatable destruction bench.
#[derive(Deserialize, Serialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SessionMode { #[default] Drive, Range }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRequest {
    configuration: serde_json::Value,
    #[serde(default)]
    mode: SessionMode,
    /// Range only: how many copies of the car to park (1..=MAX_RANGE_CARS).
    #[serde(default)]
    cars: Option<u32>,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RangeSettings {
    pub ball_mass: f32,
    pub ball_speed: f32,
}
impl Default for RangeSettings {
    // Above ~24 m/s the 0.4 m ball can pass through a thin part between 60 Hz
    // ticks (the destruction stage forbids sweep CCD).
    fn default() -> Self { Self { ball_mass: 1000.0, ball_speed: 20.0 } }
}
impl RangeSettings {
    pub fn validate(self) -> Result<Self, String> {
        if !(1.0..=20_000.0).contains(&self.ball_mass) { return Err("Ball mass must be 1-20000 kg.".into()); }
        if !(5.0..=200.0).contains(&self.ball_speed) { return Err("Ball speed must be 5-200 m/s.".into()); }
        Ok(self)
    }
}

pub struct Session {
    pub mode: SessionMode,
    /// Copies of the car in this session, ids VEHICLE_ID..VEHICLE_ID+cars.
    pub cars: u32,
    pub range: Mutex<RangeSettings>,
    /// (car, part) to fire the range cannon at, along a clear line.
    pub aimed_shots: Mutex<Vec<(u32, u32)>>,
    /// Meteors to drop: (car, a part or the car's centre when None).
    pub meteors: Mutex<Vec<(u32, Option<u32>)>>,
    pub vehicle: PreparedVehicle,
    pub current_vehicle: Mutex<PreparedVehicle>,
    pub geometry: PreparedGeometry,
    pub world: WorldDocument,
    created: Instant,
    closing: AtomicBool,
}
impl Session {
    pub fn closing(&self) -> bool {
        self.closing.load(Ordering::Relaxed)
    }
    pub fn vehicle_ids(&self) -> impl Iterator<Item = u32> {
        (0..self.cars).map(|i| VEHICLE_ID + i)
    }
    /// Vehicle id of car `index` (0 when omitted), if the session has it.
    pub fn car_id(&self, index: Option<u32>) -> Result<u32, (StatusCode, String)> {
        let index = index.unwrap_or(0);
        if index < self.cars { Ok(VEHICLE_ID + index) }
        else { Err((StatusCode::BAD_REQUEST, format!("This session has {} car(s).", self.cars))) }
    }
    /// Where car `index` parks, x and z (the height comes from the asset). The
    /// first car keeps its place in front of the player; the others fill in
    /// +x, -x, +x again, which the range player (facing +z) sees as left,
    /// right, left.
    pub fn car_position(index: u32) -> [f32; 2] {
        let slot = (index + 1) / 2;
        let side = if index % 2 == 1 { 1.0 } else { -1.0 };
        [side * slot as f32 * RANGE_CAR_SPACING_M, 3.0]
    }
}
pub fn is_garage(id: &str) -> bool {
    id.starts_with(PREFIX)
}
pub fn lookup(id: &str) -> Option<Arc<Session>> {
    sessions().lock().unwrap().get(id).cloned()
}
pub fn close(id: &str) {
    if let Some(session) = sessions().lock().unwrap().remove(id) {
        session.closing.store(true, Ordering::Relaxed);
    }
}
pub async fn close_handler(axum::extract::Path(id): axum::extract::Path<String>) -> StatusCode {
    if !is_garage(&id) {
        return StatusCode::NOT_FOUND;
    }
    close(&id);
    StatusCode::NO_CONTENT
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    match_id: String,
    world_document: WorldDocument,
    vehicle: PreparedVehicle,
    mode: SessionMode,
    cars: u32,
}

/// Reuse a prepared course for an independent observer. Possession of the
/// unguessable session id grants the same join access as the multiplayer match.
pub async fn inspect_handler(axum::extract::Path(id): axum::extract::Path<String>)
    -> Result<Json<SessionResponse>, StatusCode> {
    let session = lookup(&id).filter(|s| !s.closing()).ok_or(StatusCode::NOT_FOUND)?;
    let vehicle = session.current_vehicle.lock().unwrap().clone();
    Ok(Json(SessionResponse { match_id: id, world_document: session.world.clone(), vehicle, mode: session.mode, cars: session.cars }))
}

pub async fn create(
    request: SessionRequest,
) -> Result<Json<SessionResponse>, (StatusCode, String)> {
    let mode = request.mode;
    let cars = match (mode, request.cars) {
        (SessionMode::Range, Some(n)) if (1..=MAX_RANGE_CARS).contains(&n) => n,
        (SessionMode::Range, Some(_)) => return Err((StatusCode::BAD_REQUEST, format!("A range holds 1-{MAX_RANGE_CARS} cars."))),
        (SessionMode::Drive, Some(n)) if n != 1 => return Err((StatusCode::BAD_REQUEST, "A test drive has one car.".into())),
        _ => 1,
    };
    let asset = vehicle_assets::prepare_drivable(PrepareRequest::new(request.configuration)).await?;
    let vehicle = asset.vehicle;
    let geometry = asset.geometry;
    let mut token = [0u8; 24];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut token))
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Session creation is unavailable".into(),
            )
        })?;
    let match_id = format!("{PREFIX}{}", hex::encode(token));
    let mut world = crate::demo_world::garage_test_world();
    if mode == SessionMode::Range {
        // On foot, 12 m in front of the parked car (spawned at z = 3).
        world.spawn_areas = vec![vibe_land_shared::world_document::SpawnArea { id: 1, position: [0.0, 1.5, -9.0], radius: 0.1 }];
    }
    let mut registry = sessions().lock().unwrap();
    registry
        .retain(|_, s| Arc::strong_count(s) > 1 || s.created.elapsed() < Duration::from_secs(900));
    if registry.len() >= 4 {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "All test drive slots are in use. Please try again later.".into(),
        ));
    }
    registry.insert(
        match_id.clone(),
        Arc::new(Session {
            mode,
            cars,
            range: Mutex::new(RangeSettings::default()),
            aimed_shots: Mutex::new(Vec::new()),
            meteors: Mutex::new(Vec::new()),
            vehicle: vehicle.clone(),
            current_vehicle: Mutex::new(vehicle.clone()),
            geometry,
            world: world.clone(),
            created: Instant::now(),
            closing: AtomicBool::new(false),
        }),
    );
    Ok(Json(SessionResponse {
        match_id,
        world_document: world,
        vehicle,
        mode,
        cars,
    }))
}

/// Range cannon settings; takes effect on the next shot.
pub async fn range_handler(axum::extract::Path(id): axum::extract::Path<String>, Json(request): Json<RangeSettings>)
    -> Result<Json<RangeSettings>, (StatusCode, String)> {
    let session = lookup(&id).filter(|s| !s.closing()).ok_or((StatusCode::NOT_FOUND, "This session has ended.".to_string()))?;
    let settings = request.validate().map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    *session.range.lock().unwrap() = settings;
    Ok(Json(settings))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AimedShot { part: u32, #[serde(default)] car: Option<u32> }

/// Fire the range cannon at a chosen part along a clear line (the shooter's
/// eye line when nothing else is in the way): a repeatable hit without aim.
pub async fn fire_handler(axum::extract::Path(id): axum::extract::Path<String>, Json(request): Json<AimedShot>)
    -> Result<StatusCode, (StatusCode, String)> {
    let session = lookup(&id).filter(|s| !s.closing() && s.mode == SessionMode::Range)
        .ok_or((StatusCode::NOT_FOUND, "No destruction range session.".to_string()))?;
    if request.part as usize >= session.geometry.parts.len() {
        return Err((StatusCode::BAD_REQUEST, "No such part.".into()));
    }
    let mut shots = session.aimed_shots.lock().unwrap();
    let car = session.car_id(request.car)?;
    if shots.len() >= 8 { return Err((StatusCode::TOO_MANY_REQUESTS, "Shots are still queued.".into())); }
    shots.push((car, request.part));
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct MeteorRequest { #[serde(default)] part: Option<u32>, #[serde(default)] car: Option<u32> }

/// Drop the city's meteor on the range car: the same rock, arc and physics.
pub async fn meteor_handler(axum::extract::Path(id): axum::extract::Path<String>, body: Option<Json<MeteorRequest>>)
    -> Result<StatusCode, (StatusCode, String)> {
    let session = lookup(&id).filter(|s| !s.closing() && s.mode == SessionMode::Range)
        .ok_or((StatusCode::NOT_FOUND, "No destruction range session.".to_string()))?;
    let (part, car) = body.map(|Json(b)| (b.part, b.car)).unwrap_or((None, None));
    let car = session.car_id(car)?;
    if part.is_some_and(|p| p as usize >= session.geometry.parts.len()) {
        return Err((StatusCode::BAD_REQUEST, "No such part.".into()));
    }
    let mut meteors = session.meteors.lock().unwrap();
    if meteors.len() >= 2 { return Err((StatusCode::TOO_MANY_REQUESTS, "A meteor is already queued.".into())); }
    meteors.push((car, part));
    Ok(StatusCode::ACCEPTED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rig_wire_layout_preserves_all_four_authoritative_wheels() {
        let wheels = std::array::from_fn(|i| [i as f32 * 0.01, -0.2, 2.5, (i % 2) as f32]);
        let packet = vehicle_assets::rig_packet(0x12345678, 7, wheels);
        assert_eq!(packet.len(), 58);
        assert_eq!(packet[0], vibe_land_shared::constants::PKT_VEHICLE_RIG);
        assert_eq!(&packet[1..5], &0x12345678u32.to_le_bytes());
        assert_eq!(packet[5], 7);
        for (i, wheel) in wheels.iter().enumerate() {
            for (j, value) in wheel[..3].iter().enumerate() {
                let offset = 6 + i * 13 + j * 4;
                assert_eq!(
                    f32::from_le_bytes(packet[offset..offset + 4].try_into().unwrap()),
                    *value
                );
            }
            assert_eq!(packet[6 + i * 13 + 12], wheel[3] as u8);
        }
    }

    #[test]
    fn detached_parts_stream_every_changed_group_each_tick() {
        let wheels = [[0.0; 4]; 4];
        // 40 parts on one body share a pose; 150 more each on their own body.
        let mut detached: Vec<(u16, [f32; 3], [f32; 4])> = (0..40).map(|i| (i, [1.0, 2.0, 3.0], [0.0, 0.0, 0.0, 1.0])).collect();
        detached.extend((40..190).map(|i| (i, [i as f32, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])));
        let decode = |packets: &[Vec<u8>]| {
            let mut seen = std::collections::BTreeSet::new();
            for packet in packets {
                assert!(packet.len() <= vehicle_assets::RIG_PACKET_BUDGET);
                let mut o = 61;
                for _ in 0..packet[60] {
                    let count = packet[o + 28] as usize; o += 29;
                    for _ in 0..count { seen.insert(u16::from_le_bytes([packet[o], packet[o + 1]])); o += 2; }
                }
                assert_eq!(o, packet.len());
            }
            seen
        };
        let mut stream = vehicle_assets::RigStream::default();
        // The tick they break off: every part, in several datagrams at once.
        let first = stream.packets(0, 1, wheels, &detached);
        assert!(first.len() > 1);
        assert_eq!(decode(&first).len(), 190);
        // Nothing moved: one refresh page only.
        assert_eq!(stream.packets(1, 1, wheels, &detached).len(), 1);
        // One body moved: it goes out this tick, plus one refresh page.
        detached[45].1[1] += 0.5;
        let moved = stream.packets(2, 1, wheels, &detached);
        assert_eq!(moved.len(), 2);
        assert!(decode(&moved[..1]).contains(&45));
        // The shared body is one group: 29 + 80 bytes, not 40 x 30.
        let one = vehicle_assets::rig_packets_with_parts(0, 1, wheels, &detached[..40]);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].len(), 58 + 3 + 29 + 80);
    }

    #[test]
    fn closing_unknown_session_does_not_remove_other_matches() {
        close("garage-nonexistent-test");
        assert!(lookup("garage-nonexistent-test").is_none());
        assert!(!is_garage("city"));
        assert!(!is_garage("default"));
    }
}
