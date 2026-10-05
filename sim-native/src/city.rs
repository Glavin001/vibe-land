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
/// drain(): [reliable, ArrayBuffer, ...], close() }`; throws if the match
/// cannot start (no PhysX, no city assets).
pub fn start_city(js: Js, args: &[Value]) -> Value {
    let match_id = js.string_arg(args, 0).unwrap_or_else(|| "city-default".to_owned());
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
    js.set(handle, "close", js.function("close", move |js, _| {
        session.borrow_mut().close();
        js.undefined()
    }));
    handle
}
