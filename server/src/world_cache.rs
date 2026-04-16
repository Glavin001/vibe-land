use std::{
    collections::HashMap,
    fmt,
    sync::Arc,
    time::Instant,
};

use tokio::sync::RwLock as AsyncRwLock;
use tracing::{info, warn};
use vibe_land_shared::world_document::{WorldDocument, WorldDocumentError};

// ---------------------------------------------------------------------------
// MatchKey – parsed compound key from the raw match_id string
// ---------------------------------------------------------------------------

/// Parsed form of the flat `match_id` string that flows through the protocol.
///
/// Format: `"<world_id>:<arena_id>"` for hosted worlds, or a plain string
/// (no colon) for the built-in default world.
#[derive(Debug, Clone)]
pub enum MatchKey {
    /// The built-in default world (e.g. `"default"`).
    Default { arena_id: String },
    /// A hosted/published world loaded by world_id.
    Hosted { world_id: String, arena_id: String },
}

impl MatchKey {
    /// Reconstruct the flat composite key used as a HashMap key in `AppState.matches`.
    pub fn composite_key(&self) -> String {
        match self {
            MatchKey::Default { arena_id } => arena_id.clone(),
            MatchKey::Hosted { world_id, arena_id } => format!("{world_id}:{arena_id}"),
        }
    }

    pub fn world_id(&self) -> Option<&str> {
        match self {
            MatchKey::Default { .. } => None,
            MatchKey::Hosted { world_id, .. } => Some(world_id),
        }
    }
}

/// Parse a raw match_id string into a `MatchKey`.
///
/// If the string contains a `:`, the portion before the first colon is the
/// world_id and the remainder is the arena_id.  Otherwise the entire string
/// is treated as a default-world arena_id.
pub fn parse_match_key(raw: &str) -> MatchKey {
    if let Some((world_id, arena_id)) = raw.split_once(':') {
        if world_id.is_empty() || arena_id.is_empty() {
            return MatchKey::Default {
                arena_id: raw.to_string(),
            };
        }
        MatchKey::Hosted {
            world_id: world_id.to_string(),
            arena_id: arena_id.to_string(),
        }
    } else {
        MatchKey::Default {
            arena_id: raw.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// WorldHostError
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum WorldHostError {
    /// World hosting is disabled (max_hosted_arenas == 0 or no API URL configured).
    Disabled,
    /// The server has reached its maximum number of hosted arenas.
    LimitReached,
    /// The world could not be found (HTTP 404).
    WorldNotFound,
    /// An HTTP or network error occurred while fetching the world.
    FetchFailed(String),
    /// The world JSON could not be parsed.
    InvalidJson(String),
    /// The world document failed to instantiate into a physics arena.
    InstantiationFailed(WorldDocumentError),
}

impl WorldHostError {
    /// Numeric error code sent in the PKT_ERROR packet.
    pub fn error_code(&self) -> u16 {
        match self {
            WorldHostError::Disabled => 1,
            WorldHostError::LimitReached => 2,
            WorldHostError::WorldNotFound => 3,
            WorldHostError::FetchFailed(_) => 4,
            WorldHostError::InstantiationFailed(_) => 5,
            WorldHostError::InvalidJson(_) => 4,
        }
    }
}

impl fmt::Display for WorldHostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WorldHostError::Disabled => write!(f, "World hosting is not enabled on this server"),
            WorldHostError::LimitReached => {
                write!(f, "Server is at capacity, try again later")
            }
            WorldHostError::WorldNotFound => write!(f, "World not found"),
            WorldHostError::FetchFailed(msg) => write!(f, "Could not load world: {msg}"),
            WorldHostError::InvalidJson(msg) => write!(f, "World data is corrupted: {msg}"),
            WorldHostError::InstantiationFailed(err) => {
                write!(f, "World instantiation failed: {err}")
            }
        }
    }
}

impl std::error::Error for WorldHostError {}

// ---------------------------------------------------------------------------
// WorldCache
// ---------------------------------------------------------------------------

pub struct CachedWorld {
    pub document: Arc<WorldDocument>,
    /// Number of active arenas currently using this world.
    pub arena_count: usize,
    /// When `arena_count` hit zero.  `None` while arenas are active.
    pub last_arena_dropped: Option<Instant>,
}

pub struct WorldCache {
    pub worlds: HashMap<String, CachedWorld>,
    http_client: reqwest::Client,
    worlds_api_url: String,
}

impl WorldCache {
    pub fn new(worlds_api_url: String) -> Self {
        Self {
            worlds: HashMap::new(),
            http_client: reqwest::Client::new(),
            worlds_api_url,
        }
    }

    /// Total number of arenas across all cached worlds.
    pub fn total_arena_count(&self) -> usize {
        self.worlds.values().map(|cw| cw.arena_count).sum()
    }
}

/// Fetch (or return cached) a `WorldDocument` by world_id.
///
/// Increments the cached entry's `arena_count` on success so the caller
/// must call `release_arena` when the arena shuts down.
pub async fn fetch_world_document(
    cache: &AsyncRwLock<WorldCache>,
    world_id: &str,
    max_hosted_arenas: usize,
) -> Result<(Arc<WorldDocument>, String), WorldHostError> {
    // Fast path: cache hit under read lock.
    {
        let mut cache_w = cache.write().await;
        if let Some(entry) = cache_w.worlds.get_mut(world_id) {
            entry.arena_count += 1;
            entry.last_arena_dropped = None;
            let doc = Arc::clone(&entry.document);
            let name = doc.meta.name.clone();
            return Ok((doc, name));
        }

        // Check capacity before fetching.
        if cache_w.total_arena_count() >= max_hosted_arenas {
            return Err(WorldHostError::LimitReached);
        }
    }

    // Cache miss — fetch from the worlds API.
    let cache_r = cache.read().await;
    // World IDs are UUIDs (URL-safe characters only) so no encoding needed.
    let url = format!(
        "{}/api/worlds/{}",
        cache_r.worlds_api_url.trim_end_matches('/'),
        world_id,
    );
    let client = cache_r.http_client.clone();
    drop(cache_r);

    info!(%world_id, %url, "fetching world document from API");

    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| WorldHostError::FetchFailed(e.to_string()))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(WorldHostError::WorldNotFound);
    }
    if !response.status().is_success() {
        return Err(WorldHostError::FetchFailed(format!(
            "HTTP {}",
            response.status()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|e| WorldHostError::FetchFailed(e.to_string()))?;

    let document: WorldDocument =
        serde_json::from_str(&body).map_err(|e| WorldHostError::InvalidJson(e.to_string()))?;

    let world_name = document.meta.name.clone();
    let doc = Arc::new(document);

    // Insert into cache under write lock (double-check for races).
    let mut cache_w = cache.write().await;
    if let Some(entry) = cache_w.worlds.get_mut(world_id) {
        // Another task inserted it while we were fetching.
        entry.arena_count += 1;
        entry.last_arena_dropped = None;
        return Ok((Arc::clone(&entry.document), entry.document.meta.name.clone()));
    }

    // Re-check capacity after the fetch (another arena may have been created).
    if cache_w.total_arena_count() >= max_hosted_arenas {
        return Err(WorldHostError::LimitReached);
    }

    cache_w.worlds.insert(
        world_id.to_string(),
        CachedWorld {
            document: Arc::clone(&doc),
            arena_count: 1,
            last_arena_dropped: None,
        },
    );

    info!(%world_id, %world_name, "cached world document");
    Ok((doc, world_name))
}

/// Decrement the arena count for a world after an arena shuts down.
///
/// If the count reaches zero, records the drop time so the background
/// janitor can evict the document after a grace period.
pub async fn release_arena(cache: &AsyncRwLock<WorldCache>, world_id: &str) {
    let mut cache_w = cache.write().await;
    if let Some(entry) = cache_w.worlds.get_mut(world_id) {
        entry.arena_count = entry.arena_count.saturating_sub(1);
        if entry.arena_count == 0 {
            entry.last_arena_dropped = Some(Instant::now());
            info!(%world_id, "world arena count reached 0, starting eviction timer");
        }
    }
}

/// Background task that periodically evicts cached worlds that have had
/// no active arenas for longer than the grace period.
pub async fn run_cache_janitor(cache: Arc<AsyncRwLock<WorldCache>>, grace_period_secs: u64) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
    let grace = std::time::Duration::from_secs(grace_period_secs);
    loop {
        interval.tick().await;
        let mut cache_w = cache.write().await;
        cache_w.worlds.retain(|world_id, entry| {
            if entry.arena_count == 0 {
                if let Some(dropped_at) = entry.last_arena_dropped {
                    if dropped_at.elapsed() > grace {
                        info!(%world_id, "evicting cached world document (no arenas for {}s)", grace_period_secs);
                        return false;
                    }
                }
            }
            true
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_default_match_key() {
        let key = parse_match_key("default");
        assert!(matches!(key, MatchKey::Default { arena_id } if arena_id == "default"));
        assert_eq!(key.composite_key(), "default");
        assert!(key.world_id().is_none());
    }

    #[test]
    fn parse_hosted_match_key() {
        let key = parse_match_key("abc-123:main");
        match &key {
            MatchKey::Hosted { world_id, arena_id } => {
                assert_eq!(world_id, "abc-123");
                assert_eq!(arena_id, "main");
            }
            _ => panic!("expected Hosted"),
        }
        assert_eq!(key.composite_key(), "abc-123:main");
        assert_eq!(key.world_id(), Some("abc-123"));
    }

    #[test]
    fn parse_hosted_with_multiple_colons() {
        let key = parse_match_key("world:arena:extra");
        match &key {
            MatchKey::Hosted { world_id, arena_id } => {
                assert_eq!(world_id, "world");
                assert_eq!(arena_id, "arena:extra");
            }
            _ => panic!("expected Hosted"),
        }
    }

    #[test]
    fn parse_empty_parts_treated_as_default() {
        // ":foo" has empty world_id
        let key = parse_match_key(":foo");
        assert!(matches!(key, MatchKey::Default { .. }));

        // "foo:" has empty arena_id
        let key = parse_match_key("foo:");
        assert!(matches!(key, MatchKey::Default { .. }));
    }

    #[test]
    fn parse_empty_string() {
        let key = parse_match_key("");
        assert!(matches!(key, MatchKey::Default { arena_id } if arena_id.is_empty()));
    }
}
