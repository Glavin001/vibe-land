//! Fast tuning uses one scalar-only JS worker, preserving the garage's shared
//! validation/math. No geometry generation, disk asset reads or per-save spawn.
use crate::vehicle_assets::{PreparedDriving, PreparedVehicle};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::{process::Stdio, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

type ApiError = (StatusCode, String);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TuneRequest {
    pub expected_asset_hash: String,
    pub driving: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuneResponse {
    pub vehicle: PreparedVehicle,
    pub server_tick: u32,
}

struct Worker {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();

pub async fn resolve(
    current: &PreparedVehicle,
    driving: serde_json::Value,
    mass: f32,
) -> Result<PreparedVehicle, ApiError> {
    let mut slot = WORKER
        .get_or_init(|| Mutex::new(None))
        .try_lock()
        .map_err(|_| {
            (
                StatusCode::TOO_MANY_REQUESTS,
                "Another tuning update is being validated. Try again.".into(),
            )
        })?;
    let work = async {
        if slot.is_none() {
            let mut child =
                Command::new(std::env::var_os("VIBE_NODE_BIN").unwrap_or_else(|| "node".into()))
                    .arg(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/../client/src/vehicles/tuning-worker.mjs"
                    ))
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .kill_on_drop(true)
                    .spawn()?;
            let input = child.stdin.take().expect("piped input");
            let output = BufReader::new(child.stdout.take().expect("piped output"));
            *slot = Some(Worker {
                _child: child,
                input,
                output,
            });
        }
        let worker = slot.as_mut().unwrap();
        let mut request =
            serde_json::to_vec(&serde_json::json!({"configuration":current.configuration,
            "driving":driving,"mass":mass,"geometryHash":current.geometry_hash}))?;
        request.push(b'\n');
        worker.input.write_all(&request).await?;
        worker.input.flush().await?;
        let mut line = String::new();
        if worker.output.read_line(&mut line).await? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "tuning worker ended",
            ));
        }
        Ok::<_, std::io::Error>(line)
    };
    let line = match tokio::time::timeout(Duration::from_secs(3), work).await {
        Ok(Ok(line)) => line,
        result => {
            tracing::warn!(?result, "vehicle tuning worker unavailable");
            *slot = None;
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Live tuning is temporarily unavailable. Your previous setup is unchanged.".into(),
            ));
        }
    };
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid tuning response".into(),
        )
    })?;
    if let Some(error) = value["error"].as_str() {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, error.into()));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Resolved {
        configuration: serde_json::Value,
        driving: PreparedDriving,
        asset_hash: String,
    }
    let result: Resolved = serde_json::from_value(value).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid tuning response".into(),
        )
    })?;
    if !result.driving.is_valid() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid physical tuning".into(),
        ));
    }
    let mut next = current.clone();
    next.configuration = result.configuration;
    next.driving = result.driving;
    next.asset_hash = result.asset_hash;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn scalar_worker_reuses_geometry_and_rejects_invalid_tunes() {
        let configuration = serde_json::json!({"version":2,"generatorVersion":"dune-3","model":"buggy",
            "dimensions":{"wheelbase":2.62,"track":1.88,"tireRadius":0.395,"cageHeight":1.78},"finish":"#334444",
            "appearance":{"body":"#334444","accent":"#f36b29","wheels":"#b0afa4","seats":"#242729","paint":"satin"},
            "driving":{"acceleration":7.5,"topSpeed":30,"grip":1.4,"braking":1,"springRate":1,"dampingRatio":1,"steeringResponse":1,"steeringLimit":1,"drivetrain":"awd"}});
        let current = PreparedVehicle {
            configuration,
            asset_hash: "a".repeat(64),
            geometry_hash: "b".repeat(64),
            part_count: 194,
            shape_count: 384,
            bond_count: 638,
            driving: PreparedDriving {
                acceleration: 7.5,
                drive_torque: 1.0,
                brake_torque: 1.0,
                spring_stiffness: 1.0,
                damping: 1.0,
                tyre_friction: 1.4,
                top_speed: 30.0,
                max_steer_radians: 0.4,
                front_wheel_drive: false,
                rear_wheel_drive: false,
                steering_response: 1.0,
            },
        };
        let mut driving = current.configuration["driving"].clone();
        driving["topSpeed"] = 12.into();
        driving["drivetrain"] = "rwd".into();
        let first = resolve(&current, driving.clone(), 1000.0).await.unwrap();
        assert_eq!(first.geometry_hash, current.geometry_hash);
        assert_eq!(
            first.configuration["dimensions"],
            current.configuration["dimensions"]
        );
        assert_eq!(
            first.configuration["appearance"],
            current.configuration["appearance"]
        );
        assert_eq!(first.driving.top_speed, 12.0);
        assert!(first.driving.rear_wheel_drive);
        assert!(
            (first.driving.drive_torque - 1000.0 * first.driving.acceleration * 0.395 / 2.0).abs()
                < 0.01
        );
        let mut front_driving = driving.clone();
        front_driving["drivetrain"] = "fwd".into();
        let front = resolve(&first, front_driving, 1000.0).await.unwrap();
        assert!(front.driving.front_wheel_drive && !front.driving.rear_wheel_drive);
        assert!(front.driving.is_valid());
        assert_eq!(front.driving.drive_torque, first.driving.drive_torque);
        assert_eq!(front.geometry_hash, first.geometry_hash);
        assert_ne!(front.asset_hash, first.asset_hash);
        let mut invalid = front.driving.clone();
        invalid.rear_wheel_drive = true;
        assert!(!invalid.is_valid());
        let start = std::time::Instant::now();
        let repeated = resolve(&first, driving.clone(), 1000.0).await.unwrap();
        eprintln!("warm scalar tuning worker: {:?}", start.elapsed());
        assert_eq!(first.asset_hash, repeated.asset_hash);
        driving["grip"] = 50.into();
        assert_eq!(
            resolve(&first, driving, 1000.0).await.unwrap_err().0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let restored = resolve(&first, current.configuration["driving"].clone(), 1000.0)
            .await
            .unwrap();
        assert_eq!(restored.driving.top_speed, 30.0);
        assert!(!restored.driving.rear_wheel_drive);
        assert!(serde_json::from_value::<TuneRequest>(
            serde_json::json!({"expectedAssetHash":"x","driving":{},"mass":1})
        )
        .is_err());
    }
}
