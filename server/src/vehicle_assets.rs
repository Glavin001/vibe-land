//! Server-owned preparation of the same parametric recipe used by the garage.
//! The worker accepts configuration values only; clients cannot author physics.
use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, process::Stdio, sync::OnceLock};
use tokio::{io::AsyncWriteExt, process::Command, sync::Semaphore};

mod fracture;
pub use fracture::{AssetBond, AssetFunction, AssetMassProperties, FractureLayout};

type ApiError = (StatusCode, String);
static WORKERS: Semaphore = Semaphore::const_new(1);
static ASSET_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn asset_root() -> &'static PathBuf {
    ASSET_ROOT.get_or_init(|| {
        std::env::var_os("VIBE_VEHICLE_ASSET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache/vehicle-assets")
            })
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedVehicle {
    pub configuration: Value,
    pub asset_hash: String,
    pub geometry_hash: String,
    pub part_count: usize,
    pub shape_count: usize,
    pub bond_count: usize,
    pub driving: PreparedDriving,
}

/// Derived by the shared server worker from validated settings and measured mass.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedDriving {
    pub acceleration: f32,
    pub drive_torque: f32,
    pub brake_torque: f32,
    pub spring_stiffness: f32,
    pub damping: f32,
    pub tyre_friction: f32,
    pub top_speed: f32,
    pub max_steer_radians: f32,
    #[serde(default)]
    pub front_wheel_drive: bool,
    pub rear_wheel_drive: bool,
    pub steering_response: f32,
}
impl PreparedDriving {
    pub fn is_valid(&self) -> bool {
        [self.acceleration, self.drive_torque, self.brake_torque, self.spring_stiffness,
         self.damping, self.tyre_friction, self.top_speed, self.max_steer_radians, self.steering_response]
            .iter().all(|v| v.is_finite() && *v > 0.0)
            && self.acceleration <= 9.0 && (12.0..=36.0).contains(&self.top_speed)
            && (0.8..=1.6).contains(&self.tyre_friction)
            && (0.6..=1.4).contains(&self.steering_response)
            && self.max_steer_radians <= 0.65
            && !(self.front_wheel_drive && self.rear_wheel_drive)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    configuration: Value,
}

pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub async fn prepare(
    Json(request): Json<PrepareRequest>,
) -> Result<Json<PreparedVehicle>, ApiError> {
    let _permit = WORKERS.try_acquire().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Another vehicle is being prepared. Please try again shortly.".into(),
        )
    })?;
    let script = std::env::var_os("VIBE_VEHICLE_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../client/src/vehicles/prepare-asset.mjs")
        });
    let mut command =
        Command::new(std::env::var_os("VIBE_NODE_BIN").unwrap_or_else(|| "node".into()));
    command
        .arg(script)
        .arg(asset_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        tracing::error!(%error, "vehicle worker unavailable");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Vehicle preparation is unavailable on this server.".into(),
        )
    })?;
    let payload = serde_json::to_vec(&serde_json::json!({"configuration":request.configuration}))
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid configuration".into()))?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Vehicle worker input unavailable".into(),
        )
    })?;
    stdin.write_all(&payload).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Vehicle worker input failed".into(),
        )
    })?;
    drop(stdin);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            "Vehicle preparation timed out; your configuration is unchanged.".into(),
        )
    })?
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Vehicle preparation failed".into(),
        )
    })?;
    if !output.status.success() {
        tracing::warn!(configuration=%request.configuration, stderr=%String::from_utf8_lossy(&output.stderr), "vehicle preparation rejected");
        return Err(preparation_failure(&output.stdout));
    }
    let result: PreparedVehicle = serde_json::from_slice(&output.stdout).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid vehicle preparation result".into(),
        )
    })?;
    if !valid_hash(&result.asset_hash)
        || !valid_hash(&result.geometry_hash)
        || result.part_count == 0
        || !result.driving.is_valid()
    {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid prepared vehicle identity".into(),
        ));
    }
    Ok(Json(result))
}

fn preparation_failure(stdout: &[u8]) -> ApiError {
    // The worker emits a safe diagnostic separately from its private stack/logs.
    // Process crashes and invalid worker output are service failures, not bad dimensions.
    if let Ok(value) = serde_json::from_slice::<Value>(stdout) {
        if let (Some(message), Some(recovery)) = (
            value["error"]["message"].as_str(), value["error"]["recovery"].as_str(),
        ) {
            if !message.is_empty() && message.len() + recovery.len() <= 2048 {
                return (StatusCode::UNPROCESSABLE_ENTITY, format!("{message} {recovery}"));
            }
        }
    }
    (StatusCode::INTERNAL_SERVER_ERROR,
        "Vehicle preparation could not finish on the server. Your dimensions may be valid; try again shortly.".into())
}

pub async fn asset(
    Path((hash, file)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    if !valid_hash(&hash)
        || !["model.bin", "physics.json", "metadata.json"].contains(&file.as_str())
    {
        return Err((StatusCode::NOT_FOUND, "Unknown vehicle asset".into()));
    }
    let bytes = tokio::fs::read(asset_root().join(hash).join(&file))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Vehicle asset not found".into()))?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                if file.ends_with("json") {
                    "application/json"
                } else {
                    "application/octet-stream"
                },
            ),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_errors_keep_actionable_diagnostics_and_distinguish_worker_crashes() {
        let diagnostic = br#"{"error":{"message":"Parts are disconnected.","recovery":"Restore wheelbase to 2.62 m."}}"#;
        let (status, message) = preparation_failure(diagnostic);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(message, "Parts are disconnected. Restore wheelbase to 2.62 m.");
        for output in [b"".as_slice(), b"worker crashed".as_slice(), br#"{"error":{}}"#.as_slice()] {
            assert_eq!(preparation_failure(output).0, StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    #[test]
    fn asset_paths_require_canonical_hashes() {
        assert!(valid_hash(&"a1".repeat(32)));
        for invalid in [
            "../metadata.json".to_string(),
            "A".repeat(64),
            "a".repeat(63),
            "g".repeat(64),
        ] {
            assert!(!valid_hash(&invalid));
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedGeometry {
    #[serde(skip)]
    pub driving: Option<PreparedDriving>,
    pub origin_height: f32,
    pub wheel_centers: [[f32; 3]; 4],
    pub suspension_travel: f32,
    pub neutral_jounce: f32,
    pub suspension_attachment_y: f32,
    pub wheel_half_width: f32,
    pub max_steer_radians: f32,
    pub mass: f32,
    pub mass_properties: AssetMassProperties,
    pub bounds: AssetBounds,
    pub parts: Vec<AssetPart>,
    pub bonds: Vec<AssetBond>,
    /// Derived from validated authored identities, never supplied by the client.
    #[serde(skip)]
    pub fracture_layout: Option<FractureLayout>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct AssetBounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPart {
    pub id: String,
    pub visual_ids: Vec<String>,
    pub mass: f64,
    pub volume: f64,
    pub mass_properties: AssetMassProperties,
    pub motion: Option<Value>,
    /// Recipe-authored function, independent of part order, paint and mass.
    pub functionality: Option<AssetFunction>,
    pub position: [f32; 3],
    pub shapes: Vec<AssetShape>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct AssetShape {
    pub position: [f32; 3],
    pub vertices: Vec<[f32; 3]>,
}

/// Shared by private garage drives and vehicles published into the city.
#[derive(Clone)]
pub struct DrivableVehicle {
    pub vehicle: PreparedVehicle,
    pub geometry: PreparedGeometry,
}
pub async fn prepare_drivable(request: PrepareRequest) -> Result<DrivableVehicle, ApiError> {
    let Json(vehicle) = prepare(Json(request)).await?;
    if vehicle.configuration["model"] == "semi" {
        return Err((StatusCode::UNPROCESSABLE_ENTITY,
            "The semi preview is available; its articulated trailer is not ready for driving yet.".into()));
    }
    let bytes = tokio::fs::read(asset_root().join(&vehicle.geometry_hash).join("metadata.json"))
        .await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Prepared assembly is unavailable".into()))?;
    let mut geometry: PreparedGeometry = serde_json::from_slice(&bytes)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Prepared assembly is invalid".into()))?;
    geometry.fracture_layout = Some(geometry.validate_vehicle2_fracture_layout().map_err(|reason| {
        tracing::error!(%reason, geometry_hash=%vehicle.geometry_hash, "invalid authored vehicle fracture data");
        (StatusCode::INTERNAL_SERVER_ERROR, "Vehicle preparation produced inconsistent physical parts. Please report this configuration.".into())
    })?);
    geometry.driving = Some(vehicle.driving.clone());
    Ok(DrivableVehicle { vehicle, geometry })
}

pub fn asset_packet(handle: u8, vehicle: &PreparedVehicle) -> Vec<u8> {
    let mut bytes = vec![vibe_land_shared::constants::PKT_VEHICLE_ASSET];
    bytes.extend(
        serde_json::to_vec(&serde_json::json!({"handle":handle,"vehicle":vehicle}))
            .expect("finite configuration"),
    );
    bytes
}

/// One wheel state is twelve bytes of floats plus an on-road byte.
pub fn rig_packet(tick: u32, handle: u8, wheels: [[f32; 4]; 4]) -> Vec<u8> {
    let mut bytes = vec![vibe_land_shared::constants::PKT_VEHICLE_RIG];
    bytes.extend(tick.to_le_bytes());
    bytes.push(handle);
    for wheel in wheels {
        for value in &wheel[..3] {
            bytes.extend(value.to_le_bytes());
        }
        bytes.push(wheel[3] as u8);
    }
    bytes
}
