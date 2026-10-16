//! Single-player /city: the city server's match loop running in this process
//! (`web_fps_server::local_session`), one local player, packets in memory.
//!
//! JS gets the same bytes a WebTransport session carries, so the client above
//! the transport is the multiplayer client unchanged (client/src/net/
//! inProcessClient.ts).

use std::cell::RefCell;
use std::rc::Rc;

use web_fps_server::local_session::LocalSession;

use crate::mystral::{Js, Value};

/// `startCity(matchId = 'city-default')` -> `{ sessionConfigJson, send(bytes),
/// drain(): [reliable, ArrayBuffer, ...], request(path), close() }`; throws if
/// the match cannot start (no PhysX, no city assets). `request(path)` answers
/// a GET for the server's stateless routes (vehicle assets, city manifest and
/// visuals) as `{ status, contentType, contentEncoding, body: ArrayBuffer }`.
/// `meteor(x, y, z)`, `reset()` and `vehicleDebug(car)` (a JSON string) are the
/// server's /city-meteor, /city-reset and /city-vehicle-debug, for QA.
/// `poses(sinceTick)` is the city's every-tick body poses as an ArrayBuffer of
/// u32 words (server/src/pose_feed.rs; empty with VIBE_LOCAL_POSE_FEED=0).
/// Film mode: `setLockstep(on)` stops (or resumes) the match's real-time
/// ticking and returns the server tick; `step(n)` then advances exactly n
/// ticks, blocking until they are done, and returns the tick reached;
/// `currentTick()` reads it; `stepStats()` is the last step's ticks' costs
/// ({ ticks, tickMs, maxTickMs, dynamicsMs, cityMs, awakeBodies, frozenBodies }); `appliedInputs(sinceTick)` is the JSON record
/// of the input frames applied on lockstepped ticks (film determinism checks).
/// With `VIBE_FILM_LOCKSTEP=1` the match is in lockstep from tick 0.
pub fn start_city(js: Js, args: &[Value]) -> Value {
    let match_id = js.string_arg(args, 0).unwrap_or_else(|| "city-default".to_owned());
    apply_app_defaults();
    let session = match LocalSession::start(&match_id) {
        Ok(session) => Rc::new(RefCell::new(session)),
        Err(error) => return js.throw(&format!("startCity({match_id}): {error:#}")),
    };

    let handle = js.object();
    js.set(handle, "sessionConfigJson", js.string(session.borrow().session_config_json()));
    {
        let session = session.clone();
        js.set(handle, "send", js.function("send", move |js, args| {
            let Some(bytes) = args.first().and_then(|&value| js.bytes(value)) else {
                return js.throw("send(bytes) needs an ArrayBuffer or typed array");
            };
            match session.borrow().send(bytes) {
                Ok(()) => js.undefined(),
                Err(error) => js.throw(&format!("send: {error:#}")),
            }
        }));
    }
    {
        let session = session.clone();
        js.set(handle, "drain", js.function("drain", move |js, _| {
            let mut packets: Vec<(bool, Vec<u8>)> = Vec::new();
            let drained = session.borrow_mut().drain(|reliable, bytes| packets.push((reliable, bytes)));
            let out = js.array(packets.len() * 2);
            for (i, (reliable, bytes)) in packets.iter().enumerate() {
                js.set_index(out, (i * 2) as u32, js.boolean(*reliable));
                js.set_index(out, (i * 2 + 1) as u32, js.array_buffer(bytes));
            }
            match drained {
                Ok(()) => out,
                Err(error) => js.throw(&format!("drain: {error:#}")),
            }
        }));
    }
    {
        let session = session.clone();
        js.set(handle, "request", js.function("request", move |js, args| {
            let Some(path) = js.string_arg(args, 0) else {
                return js.throw("request(path) needs a path");
            };
            match session.borrow().request(&path) {
                Ok(response) => {
                    let out = js.object();
                    js.set(out, "status", js.number(response.status as f64));
                    js.set(out, "contentType", js.string(&response.content_type));
                    if let Some(encoding) = &response.content_encoding {
                        js.set(out, "contentEncoding", js.string(encoding));
                    }
                    js.set(out, "body", js.array_buffer(&response.body));
                    out
                }
                Err(error) => js.throw(&format!("request({path}): {error:#}")),
            }
        }));
    }
    {
        let session = session.clone();
        js.set(handle, "poses", js.function("poses", move |js, args| {
            let since = js.arg_number(args, 0, 0.0).max(0.0) as u32;
            let words = session.borrow().poses_since(since);
            let bytes: Vec<u8> = words.iter().flat_map(|word| word.to_le_bytes()).collect();
            js.array_buffer(&bytes)
        }));
    }
    // The HTTP server's debug routes, in-process: /city-meteor, /city-reset,
    // /city-vehicle-debug (QA scripts drive these; see client/native/city-qa.js).
    {
        let session = session.clone();
        js.set(handle, "meteor", js.function("meteor", move |js, args| {
            let target = [0, 1, 2].map(|i| js.arg_number(args, i, f64::NAN) as f32);
            if target.iter().any(|v| !v.is_finite()) {
                return js.throw("meteor(x, y, z) needs a world point");
            }
            session.borrow().meteor(&[target]);
            js.undefined()
        }));
    }
    {
        let session = session.clone();
        js.set(handle, "reset", js.function("reset", move |js, _| {
            session.borrow().reset();
            js.undefined()
        }));
    }
    {
        let session = session.clone();
        js.set(handle, "vehicleDebug", js.function("vehicleDebug", move |js, args| {
            let car = js.arg_number(args, 0, 0.0).max(0.0) as u32;
            match session.borrow().vehicle_debug(car) {
                Ok(value) => js.string(&value.to_string()),
                Err(error) => js.throw(&format!("vehicleDebug({car}): {error:#}")),
            }
        }));
    }
    // Film mode (client/src/native/film.ts): the match ticks only when the
    // renderer steps it, a fixed number of ticks per rendered frame.
    {
        let session = session.clone();
        js.set(handle, "currentTick", js.function("currentTick", move |js, _| {
            match session.borrow().current_tick() {
                Ok(tick) => js.number(tick as f64),
                Err(error) => js.throw(&format!("currentTick: {error:#}")),
            }
        }));
    }
    {
        let session = session.clone();
        js.set(handle, "setLockstep", js.function("setLockstep", move |js, args| {
            let enabled = args.first().is_some_and(|&value| js.to_bool(value));
            match session.borrow().set_lockstep(enabled) {
                Ok(tick) => js.number(tick as f64),
                Err(error) => js.throw(&format!("setLockstep: {error:#}")),
            }
        }));
    }
    {
        // replayEvent(json): one city event on the match (a meteor on a given
        // arc, a shot, a demolition), as the replay-event route takes it.
        let session = session.clone();
        js.set(handle, "replayEvent", js.function("replayEvent", move |js, args| {
            let Some(text) = js.string_arg(args, 0) else {
                return js.throw("replayEvent(json) needs the event as JSON");
            };
            match session.borrow().replay_event(&text) {
                Ok(result) => js.string(&result),
                Err(error) => js.throw(&format!("replayEvent: {error:#}")),
            }
        }));
    }
    // The last step's ticks' costs, for stepStats().
    let last_step: Rc<RefCell<Vec<web_fps_server::local_session::LocalTickStats>>> = Rc::default();
    {
        let session = session.clone();
        let last_step = last_step.clone();
        js.set(handle, "step", js.function("step", move |js, args| {
            let ticks = js.arg_number(args, 0, 1.0).clamp(0.0, 600.0) as u32;
            match session.borrow().step_with_stats(ticks) {
                Ok((tick, stats)) => {
                    *last_step.borrow_mut() = stats;
                    js.number(tick as f64)
                }
                Err(error) => js.throw(&format!("step: {error:#}")),
            }
        }));
    }
    js.set(handle, "stepStats", js.function("stepStats", move |js, _| {
        let stats = last_step.borrow();
        let sum = |f: fn(&web_fps_server::local_session::LocalTickStats) -> f32| stats.iter().map(f).sum::<f32>();
        let out = js.object();
        js.set(out, "ticks", js.number(stats.len() as f64));
        js.set(out, "tickMs", js.number(sum(|s| s.total_ms) as f64));
        js.set(out, "maxTickMs", js.number(stats.iter().map(|s| s.total_ms).fold(0.0, f32::max) as f64));
        js.set(out, "dynamicsMs", js.number(sum(|s| s.dynamics_ms) as f64));
        js.set(out, "cityMs", js.number(sum(|s| s.city_ms) as f64));
        let last = stats.last().cloned().unwrap_or_default();
        js.set(out, "awakeBodies", js.number(last.awake_bodies as f64));
        js.set(out, "frozenBodies", js.number(last.frozen_bodies as f64));
        out
    }));
    {
        let session = session.clone();
        js.set(handle, "appliedInputs", js.function("appliedInputs", move |js, args| {
            let since = js.arg_number(args, 0, 0.0).max(0.0) as u32;
            match session.borrow().applied_inputs_json(since) {
                Ok(json) => js.string(&json),
                Err(error) => js.throw(&format!("appliedInputs: {error:#}")),
            }
        }));
    }
    js.set(handle, "close", js.function("close", move |js, _| {
        session.borrow_mut().close();
        js.undefined()
    }));
    handle
}

/// The settings the play server gets from its launch environment
/// (scripts/perf/play-server.sh), for when the app is launched from Finder
/// with none. Anything already set wins, so a terminal launch can override.
fn apply_app_defaults() {
    if std::env::var_os("VIBE_PHYSICS_BACKEND").is_none() {
        std::env::set_var("VIBE_PHYSICS_BACKEND", "physx_gpu");
    }
    // The destructible garage cars, which replace the city's two stock cars:
    // opt-in on the server, the native app's default, with the settings the
    // server that fields them runs with (scripts/perf/garage-vehicle-server.sh;
    // see its header for what each does).
    for (name, value) in [
        ("VIBE_CITY_DESTRUCTIBLE_VEHICLES", "1"),
        ("VIBE_GARAGE_VEHICLE_DESTRUCTION", "1"),
        ("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1"),
        ("VIBE_NATIVE_STRESS_FORCE_TOLERANCE", "0.001"),
        ("BLAST_STRESS_INCREMENTAL_MOTION", "1"),
        ("PX_DESTRUCTION_INCREMENTAL_TOPOLOGY", "1"),
        ("BLAST_STRESS_BALANCED_OPERATOR", "1"),
        // No GPU keep-alive of any kind in the app. The bridge's server
        // defaults (physx_bridge.cc) hold the GPU awake between 60 Hz ticks: a
        // 250 us heartbeat and a busy threadgroup. A desktop app shares the GPU
        // with WindowServer and must let it idle between frames like any game.
        // On 2026-10-08 the app on Vibe Town (high profile, at rest) hung
        // WindowServer 52-66 s after launch in 4 of 4 runs with the heartbeat
        // on (busy on or off); macOS's watchdog then logged the owner out. With
        // both off it ran 120 s with WindowServer answering in ~55 ms
        // throughout (docs/perf/NATIVE_APP_FINDINGS.md).
        ("CUMETAL_GPU_KEEPALIVE_US", "0"),
        ("CUMETAL_GPU_KEEPALIVE_BUSY", "0"),
        // No GPU code that waits on another threadgroup. Metal promises no
        // forward progress between threadgroups; CuMetal's resident cooperative
        // grids (Blast's persistent stress solve on a structure over 1,024
        // nodes, the hierarchy construction) spin at a device-atomic barrier
        // for peers that are only assumed resident. With the window server and
        // this app's own rendering holding GPU cores, a peer never starts, the
        // barrier never opens and the GPU hangs: WindowServer's watchdog then
        // logs the user out, and killing the app cannot stop work already on
        // the GPU (cuda-metal docs/known-gaps/runtime.md, "Residency is shared
        // with other processes"). Vibe Town (57,087 chunks) hung 52-68 s after
        // launch every time (2026-10-08). Off, each cooperative launch is one
        // threadgroup, whose barrier waits only on itself.
        ("CUMETAL_COOPERATIVE_RESIDENT_GRID", "0"),
    ] {
        if std::env::var_os(name).is_none() {
            std::env::set_var(name, value);
        }
    }
    // A packaged app ships the city's scene and CuMetal's prebuilt Metal
    // pipelines in Contents/Resources (Contents/MacOS/mystral -> ../Resources).
    // The pipeline archive cannot sit beside libcumetal in Frameworks, where
    // CuMetal would look by default: code signing allows only code there.
    let resources = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("Resources")));
    let bundled = |name: &str| resources.as_ref().map(|dir| dir.join(name)).filter(|dir| dir.is_dir());
    if std::env::var_os("VIBE_DESTRUCTION_ASSET_DIR").is_none() {
        if let Some(scenes) = bundled("scenes") {
            std::env::set_var("VIBE_DESTRUCTION_ASSET_DIR", scenes);
        }
    }
    if std::env::var_os("CUMETAL_PIPELINE_ARCHIVE_PATH").is_none() {
        if let Some(archive) = bundled("cumetal-pipeline-archive") {
            std::env::set_var("CUMETAL_PIPELINE_ARCHIVE_PATH", archive);
        }
    }
}
