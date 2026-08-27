//! Env/build fingerprint for measurement outputs.
//!
//! Exists because a suite env gap (`BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY`
//! unset) survived three full gate runs and produced a false physics
//! regression: nothing recorded what environment a run actually executed
//! under, so "this run's env differs from production's" was invisible. Every
//! measurement artifact — match-stats, trace meta.json, suite logs — embeds
//! this so comparisons can refuse mismatched configurations instead of
//! trusting them.

use std::collections::BTreeMap;

#[derive(Clone, Debug, serde::Serialize)]
pub struct Fingerprint {
    /// `git rev-parse --short HEAD` (+ "-dirty"), or "unknown" outside a
    /// checkout. Resolved once at capture.
    pub git: String,
    /// Absolute path of the running binary.
    pub binary: String,
    /// The binary's mtime (unix seconds) — tells a stale build from a fresh
    /// one even when git says clean.
    pub binary_mtime_unix: u64,
    /// Every VIBE_* / BLAST_* variable present in the environment. Absent
    /// keys are genuinely unset (defaults applied), which is itself signal.
    pub env: BTreeMap<String, String>,
}

pub fn capture() -> Fingerprint {
    let env: BTreeMap<String, String> = std::env::vars()
        .filter(|(key, _)| key.starts_with("VIBE_") || key.starts_with("BLAST_"))
        .collect();
    let git = std::process::Command::new("git")
        .args(["describe", "--always", "--dirty"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let binary = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let binary_mtime_unix = std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    Fingerprint {
        git,
        binary,
        binary_mtime_unix,
        env,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn capture_collects_prefixed_env() {
        // Set via std::env for the test process only.
        std::env::set_var("VIBE_FINGERPRINT_TEST_KEY", "1");
        let fingerprint = super::capture();
        assert_eq!(
            fingerprint.env.get("VIBE_FINGERPRINT_TEST_KEY").map(String::as_str),
            Some("1")
        );
        assert!(!fingerprint.git.is_empty());
        std::env::remove_var("VIBE_FINGERPRINT_TEST_KEY");
    }
}
