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
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RangeSettings {
    pub ball_mass: f32,
    pub ball_speed: f32,
}
impl Default for RangeSettings {
    fn default() -> Self { Self { ball_mass: 300.0, ball_speed: 60.0 } }
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
    pub range: Mutex<RangeSettings>,
    /// World points to fire the range cannon at (from the shooter's eye).
    pub aimed_shots: Mutex<Vec<[f32; 3]>>,
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
}

/// Reuse a prepared course for an independent observer. Possession of the
/// unguessable session id grants the same join access as the multiplayer match.
pub async fn inspect_handler(axum::extract::Path(id): axum::extract::Path<String>)
    -> Result<Json<SessionResponse>, StatusCode> {
    let session = lookup(&id).filter(|s| !s.closing()).ok_or(StatusCode::NOT_FOUND)?;
    let vehicle = session.current_vehicle.lock().unwrap().clone();
    Ok(Json(SessionResponse { match_id: id, world_document: session.world.clone(), vehicle, mode: session.mode }))
}

pub async fn create(
    request: SessionRequest,
) -> Result<Json<SessionResponse>, (StatusCode, String)> {
    let mode = request.mode;
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
            range: Mutex::new(RangeSettings::default()),
            aimed_shots: Mutex::new(Vec::new()),
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
pub struct AimedShot { target: [f32; 3] }

/// Fire the range cannon from the player's eye at a world point, e.g. a
/// chosen part's centre: a repeatable hit without mouse aim.
pub async fn fire_handler(axum::extract::Path(id): axum::extract::Path<String>, Json(request): Json<AimedShot>)
    -> Result<StatusCode, (StatusCode, String)> {
    let session = lookup(&id).filter(|s| !s.closing() && s.mode == SessionMode::Range)
        .ok_or((StatusCode::NOT_FOUND, "No destruction range session.".to_string()))?;
    if !request.target.iter().all(|v| v.is_finite() && v.abs() < 1000.0) {
        return Err((StatusCode::BAD_REQUEST, "Target must be a finite world point.".into()));
    }
    let mut shots = session.aimed_shots.lock().unwrap();
    if shots.len() >= 8 { return Err((StatusCode::TOO_MANY_REQUESTS, "Shots are still queued.".into())); }
    shots.push(request.target);
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
    fn detached_parts_group_by_body_and_page_within_a_datagram() {
        let wheels = [[0.0; 4]; 4];
        // 40 parts on one body share a pose; 150 more each on their own body.
        let mut detached: Vec<(u16, [f32; 3], [f32; 4])> = (0..40).map(|i| (i, [1.0, 2.0, 3.0], [0.0, 0.0, 0.0, 1.0])).collect();
        detached.extend((40..190).map(|i| (i, [i as f32, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])));
        let mut seen = std::collections::BTreeSet::new();
        let pages = vehicle_assets::rig_packet_with_parts(0, 1, wheels, &detached)[59] as u32;
        assert!(pages > 1);
        for tick in 0..pages {
            let packet = vehicle_assets::rig_packet_with_parts(tick, 1, wheels, &detached);
            assert!(packet.len() <= vehicle_assets::RIG_PACKET_BUDGET);
            assert_eq!(packet[58] as u32, tick);
            let mut o = 61;
            for _ in 0..packet[60] {
                let count = packet[o + 28] as usize; o += 29;
                for _ in 0..count { seen.insert(u16::from_le_bytes([packet[o], packet[o + 1]])); o += 2; }
            }
            assert_eq!(o, packet.len());
        }
        assert_eq!(seen.len(), 190);
        // The shared body is one group: 29 + 80 bytes, not 40 x 30.
        let first = vehicle_assets::rig_packet_with_parts(0, 1, wheels, &detached[..40]);
        assert_eq!(first.len(), 58 + 3 + 29 + 80);
    }

    #[test]
    fn closing_unknown_session_does_not_remove_other_matches() {
        close("garage-nonexistent-test");
        assert!(lookup("garage-nonexistent-test").is_none());
        assert!(!is_garage("city"));
        assert!(!is_garage("default"));
    }
}
