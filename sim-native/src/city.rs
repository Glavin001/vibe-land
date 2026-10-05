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
