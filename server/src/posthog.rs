use reqwest::Client;
use serde_json::{json, Value};
use tracing::warn;

pub struct PosthogClient {
    api_key: Option<String>,
    host: String,
    http: Client,
}

impl PosthogClient {
    pub fn from_env(http: Client) -> Self {
        let api_key = std::env::var("POSTHOG_API_KEY")
            .ok()
            .filter(|k| !k.is_empty());
        let host = std::env::var("POSTHOG_HOST")
            .unwrap_or_else(|_| "https://us.i.posthog.com".to_string());
        if api_key.is_some() {
            tracing::info!(%host, "PostHog analytics enabled");
        }
        Self { api_key, host, http }
    }

    /// Fire-and-forget event capture. Does nothing when no API key is configured.
    pub fn capture(&self, distinct_id: impl Into<String>, event: impl Into<String>, properties: Value) {
        let Some(api_key) = self.api_key.clone() else { return };
        let url = format!("{}/capture/", self.host);
        let body = json!({
            "api_key": api_key,
            "event": event.into(),
            "distinct_id": distinct_id.into(),
            "properties": properties,
        });
        let http = self.http.clone();
        tokio::spawn(async move {
            if let Err(err) = http.post(&url).json(&body).send().await {
                warn!(error = %err, "PostHog capture failed");
            }
        });
    }
}
