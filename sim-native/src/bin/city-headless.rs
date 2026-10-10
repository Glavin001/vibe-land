//! Physics only: the native app's single-player city -- the same in-process
//! match loop (`web_fps_server::local_session`), the same app defaults
//! (`vibe_sim::city::apply_app_defaults`) and the same PhysX/CuMetal build --
//! with no renderer and no window. The local player is connected and its
//! packets are drained at 60 Hz, as the app's frame loop does, so the server
//! does the same work; it sends no input.
//!
//!   city-headless [SECONDS]      (default 120; scripts/native-mac.sh headless)
//!
//! For telling a GPU hang caused by the physics alone from one that needs the
//! app's rendering too (scripts/ops/hang-forensics.sh --physics-only).
//! Prints the server tick once a second.

use std::time::{Duration, Instant};

use vibe_sim::hang_trace;
use web_fps_server::local_session::LocalSession;

fn main() {
    let seconds: f64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(120.0);
    vibe_sim::city::apply_app_defaults();
    let mut session = match LocalSession::start("city-default") {
        Ok(session) => session,
        Err(error) => {
            eprintln!("[headless] the city did not start: {error:#}");
            std::process::exit(1);
        }
    };
    println!("[headless] city started; running {seconds} s with no renderer");
    let start = Instant::now();
    let mut next_report = 1.0;
    let (mut packets, mut bytes) = (0u64, 0u64);
    while start.elapsed().as_secs_f64() < seconds {
        if let Err(error) = session.drain(|_, packet| {
            packets += 1;
            bytes += packet.len() as u64;
        }) {
            eprintln!("[headless] {error:#}");
            std::process::exit(1);
        }
        let t = start.elapsed().as_secs_f64();
        if t >= next_report {
            let tick = session.current_tick().unwrap_or(0);
            println!("[headless] t={t:.0}s tick={tick} packets={packets} bytes={bytes}");
            hang_trace::line("sim", &format!("headless t={t:.0} tick={tick}"));
            next_report += 1.0;
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    session.close();
    println!("[headless] done after {:.0} s", start.elapsed().as_secs_f64());
}
