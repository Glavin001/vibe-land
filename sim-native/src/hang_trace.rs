//! `VIBE_HANG_TRACE=<file>` (diagnostic, off by default): breadcrumbs that
//! place a hang. Each line is `<seconds> <source> <text>`, appended with one
//! write(2) so it is never torn and is in the file the moment it is written:
//! it survives the process being killed (a macOS logout after a GPU hang).
//! The bridge writes its PhysX step phases to the same file (physx_bridge.cc
//! `hang_trace`); JS writes each render frame's GPU submission through
//! `hangTrace(text)` (client/src/native/renderTrace.ts). The clock is
//! CLOCK_UPTIME_RAW seconds on macOS, the mach_absolute_time base of CuMetal's
//! CUMETAL_SUBMIT / CUMETAL_COMMIT lines, so all of them interleave
//! (scripts/ops/hang_analyze.py).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::OnceLock;

fn file() -> Option<&'static File> {
    static FILE: OnceLock<Option<File>> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = std::env::var_os("VIBE_HANG_TRACE").filter(|p| !p.is_empty())?;
        OpenOptions::new().append(true).create(true).open(path).ok()
    })
    .as_ref()
}

pub fn enabled() -> bool {
    file().is_some()
}

/// Seconds on the clock CuMetal stamps its submissions with.
pub fn now_s() -> f64 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn clock_gettime_nsec_np(clock: u32) -> u64;
        }
        const CLOCK_UPTIME_RAW: u32 = 8;
        // SAFETY: a libSystem call with no pointer arguments.
        unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) as f64 * 1e-9 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use std::sync::OnceLock;
        use std::time::Instant;
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_secs_f64()
    }
}

/// `source` is one word (`js`, `sim`); `text` one line.
pub fn line(source: &str, text: &str) {
    let Some(mut file) = file() else { return };
    let mut buffer = format!("{:.6} {source} ", now_s());
    buffer.extend(text.chars().map(|c| if c == '\n' { ' ' } else { c }).take(400));
    buffer.push('\n');
    let _ = file.write(buffer.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_is_monotonic_seconds() {
        let a = now_s();
        let b = now_s();
        assert!(a > 0.0 && b >= a);
    }
}
