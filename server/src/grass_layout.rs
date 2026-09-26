//! Authored vegetation only. No blades, contacts, or grass physics enter the simulation.
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Mutex;

const MAX_BYTES: usize = 24 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tile {
    x: i32,
    z: i32,
    data: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    version: u8,
    tiles: Vec<Tile>,
}
impl Layout {
    fn validate(&self) -> Result<(), ApiError> {
        let mut seen = HashSet::new();
        if ![2, 3].contains(&self.version) || self.tiles.len() > 4096 {
            return Err(bad("Expected grass layout version 2 or 3"));
        }
        for tile in &self.tiles {
            if !(-32..32).contains(&tile.x)
                || !(-32..32).contains(&tile.z)
                || tile.data.len() != if self.version == 3 { 3072 } else { 1280 }
                || (self.version == 3 && tile.data.chunks_exact(12).any(|cell| cell[5] > 4))
                || !seen.insert((tile.x, tile.z))
            {
                return Err(bad("Invalid or duplicate grass tile"));
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
struct Snapshot {
    revision: String,
    layout: Layout,
}
impl Snapshot {
    fn new(layout: Layout) -> Self {
        let revision = hex::encode(Sha256::digest(
            serde_json::to_vec(&layout).expect("grass serializes"),
        ));
        Self { revision, layout }
    }
}
type ApiError = (StatusCode, &'static str);
fn bad(message: &'static str) -> ApiError {
    (StatusCode::BAD_REQUEST, message)
}
fn io_error(_: impl std::fmt::Display) -> ApiError {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Grass storage unavailable",
    )
}
fn valid_match(id: &str) -> bool {
    id.starts_with("city")
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub struct GrassStore {
    directory: PathBuf,
    edit_token: Option<String>,
    // One process owns writes to a directory. Bounded cache; disk is the durable source.
    cache: Mutex<HashMap<String, Arc<Snapshot>>>,
}
impl GrassStore {
    pub fn from_env() -> Arc<Self> {
        Self::new(
            std::env::var_os("VIBE_GRASS_LAYOUT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.data/grass")
                }),
            std::env::var("VIBE_GRASS_EDIT_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        )
    }
    pub fn new(directory: PathBuf, edit_token: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            directory,
            edit_token,
            cache: Mutex::new(HashMap::new()),
        })
    }
    async fn read(
        &self,
        id: &str,
        cache: &mut HashMap<String, Arc<Snapshot>>,
    ) -> Result<Arc<Snapshot>, ApiError> {
        if !valid_match(id) {
            return Err(bad("Invalid city match"));
        }
        if let Some(value) = cache.get(id) {
            return Ok(value.clone());
        }
        let path = self.directory.join(format!("{id}.json"));
        let layout = match tokio::fs::metadata(&path).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Layout {
                version: 2,
                tiles: vec![],
            },
            Err(e) => return Err(io_error(e)),
            Ok(meta) => {
                if meta.len() > MAX_BYTES as u64 {
                    return Err(io_error("oversized layout"));
                }
                serde_json::from_slice::<Layout>(&tokio::fs::read(&path).await.map_err(io_error)?)
                    .map_err(io_error)?
            }
        };
        layout
            .validate()
            .map_err(|_| io_error("invalid saved layout"))?;
        let snapshot = Arc::new(Snapshot::new(layout));
        if cache.len() >= 8 {
            if let Some(key) = cache.keys().next().cloned() {
                cache.remove(&key);
            }
        }
        cache.insert(id.to_owned(), snapshot.clone());
        Ok(snapshot)
    }
}

pub fn router<S: Clone + Send + Sync + 'static>(store: Arc<GrassStore>) -> Router<S> {
    Router::new()
        .route(
            "/match-stats/:match_id/grass",
            get(read_handler).put(write_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_BYTES))
        .with_state(store)
}
fn response(snapshot: &Snapshot, not_modified: bool) -> Response {
    let mut result = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(snapshot).into_response()
    };
    result.headers_mut().insert(
        header::ETAG,
        format!("\"{}\"", snapshot.revision).parse().unwrap(),
    );
    result
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    result
}
async fn read_handler(
    State(store): State<Arc<GrassStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let mut cache = store.cache.lock().await;
    let snapshot = store.read(&id, &mut cache).await?;
    let etag = format!("\"{}\"", snapshot.revision);
    Ok(response(
        &snapshot,
        headers
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            == Some(etag.as_str()),
    ))
}
async fn write_handler(
    State(store): State<Arc<GrassStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut layout): Json<Layout>,
) -> Result<Response, ApiError> {
    let Some(token) = &store.edit_token else {
        return Err((
            StatusCode::FORBIDDEN,
            "Grass publishing is disabled on this server",
        ));
    };
    let expected = format!("Bearer {token}");
    // Constant-time comparison of fixed-size digests avoids disclosing token prefixes.
    let supplied = headers
        .get(header::AUTHORIZATION)
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    let a = Sha256::digest(expected.as_bytes());
    let b = Sha256::digest(supplied);
    if a.iter().zip(b.iter()).fold(0u8, |d, (a, b)| d | (a ^ b)) != 0 {
        return Err((StatusCode::UNAUTHORIZED, "Grass editor key required"));
    }
    if !valid_match(&id) {
        return Err(bad("Invalid city match"));
    }
    layout.validate()?;
    layout.tiles.sort_by_key(|t| (t.x, t.z));
    let mut cache = store.cache.lock().await;
    let current = store.read(&id, &mut cache).await?;
    let expected_revision = format!("\"{}\"", current.revision);
    let Some(revision) = headers.get(header::IF_MATCH).and_then(|h| h.to_str().ok()) else {
        return Err((
            StatusCode::PRECONDITION_REQUIRED,
            "Load the shared layout before publishing",
        ));
    };
    if revision != expected_revision {
        return Err((
            StatusCode::CONFLICT,
            "Shared grass changed; load it before publishing",
        ));
    }
    let next = Arc::new(Snapshot::new(layout));
    if next.revision == current.revision {
        return Ok(response(&current, false));
    }
    tokio::fs::create_dir_all(&store.directory)
        .await
        .map_err(io_error)?;
    let target = store.directory.join(format!("{id}.json"));
    let temporary = store
        .directory
        .join(format!(".{id}.{}.tmp", std::process::id()));
    // The lock serializes writes; rename makes readers/restarts see one complete layout.
    let write_result = async {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&temporary).await?;
        file.write_all(&serde_json::to_vec(&next.layout).expect("grass serializes"))
            .await?;
        file.sync_all().await?;
        tokio::fs::rename(&temporary, &target).await
    }
    .await;
    if let Err(e) = write_result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(io_error(e));
    }
    cache.insert(id, next.clone());
    Ok(response(&next, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    fn setup() -> (PathBuf, Arc<GrassStore>) {
        let dir = std::env::temp_dir().join(format!(
            "grass-layout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        (dir.clone(), GrassStore::new(dir, Some("editor-key".into())))
    }
    async fn request(
        app: Router,
        method: &str,
        id: &str,
        revision: Option<&str>,
        token: &str,
        layout: serde_json::Value,
    ) -> Response {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/match-stats/{id}/grass"))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"));
        if let Some(rev) = revision {
            req = req.header("if-match", rev);
        }
        app.oneshot(req.body(Body::from(layout.to_string())).unwrap())
            .await
            .unwrap()
    }
    #[test]
    fn accepts_legacy_and_foliage_tiles_but_rejects_unknown_species() {
        let mut layout = Layout { version: 3, tiles: vec![Tile { x: 0, z: 0, data: vec![0; 3072] }] };
        layout.tiles[0].data[5] = 4;
        assert!(layout.validate().is_ok());
        layout.tiles[0].data[5] = 5;
        assert!(layout.validate().is_err());
        layout.version = 2;
        layout.tiles[0].data = vec![255; 1280];
        assert!(layout.validate().is_ok());
        layout.version = 3;
        assert!(layout.validate().is_err());
    }

    #[tokio::test]
    async fn two_clients_conflicts_validation_and_restart() {
        let (dir, store) = setup();
        let app = router(store);
        let initial = request(
            app.clone(),
            "GET",
            "city-default",
            None,
            "",
            serde_json::Value::Null,
        )
        .await;
        let rev = initial.headers()[header::ETAG].to_str().unwrap().to_owned();
        let layout =
            serde_json::json!({"version":2,"tiles":[{"x":0,"z":6,"data":vec![255u8;1280]}]});
        assert_eq!(
            request(
                app.clone(),
                "PUT",
                "city-default",
                Some(&rev),
                "wrong",
                layout.clone()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                app.clone(),
                "PUT",
                "city-default",
                None,
                "editor-key",
                layout.clone()
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        let saved = request(
            app.clone(),
            "PUT",
            "city-default",
            Some(&rev),
            "editor-key",
            layout.clone(),
        )
        .await;
        assert_eq!(saved.status(), StatusCode::OK);
        let saved_rev = saved.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert_ne!(saved_rev, rev);
        assert_eq!(
            request(
                app.clone(),
                "PUT",
                "city-default",
                Some(&rev),
                "editor-key",
                layout.clone()
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        let cached = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/match-stats/city-default/grass")
                    .header("if-none-match", &saved_rev)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        let fresh = router(GrassStore::new(dir.clone(), None));
        let read = request(
            fresh.clone(),
            "GET",
            "city-default",
            None,
            "",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(read.headers()[header::ETAG], saved_rev);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(read.into_body(), MAX_BYTES).await.unwrap()).unwrap();
        assert_eq!(body["layout"], layout);
        let other = request(
            app.clone(),
            "GET",
            "city-other",
            None,
            "",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(other.headers()[header::ETAG], rev);
        let invalid =
            serde_json::json!({"version":2,"tiles":[{"x":32,"z":0,"data":vec![0u8;1280]}]});
        assert_eq!(
            request(
                app.clone(),
                "PUT",
                "city-default",
                Some(&saved_rev),
                "editor-key",
                invalid
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        let duplicate = serde_json::json!({"version":2,"tiles":[layout["tiles"][0].clone(),layout["tiles"][0].clone()]});
        assert_eq!(
            request(
                app,
                "PUT",
                "city-default",
                Some(&saved_rev),
                "editor-key",
                duplicate
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(fresh, "PUT", "city-default", Some(&saved_rev), "", layout)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
