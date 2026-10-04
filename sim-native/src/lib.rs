//! vibe-land's simulation as a mystralnative native module.
//!
//! The native macOS app loads this library into the same process as the
//! renderer (`__mystralLoadNativeModule('libvibe_sim.dylib')`), so
//! single-player runs with no netcode: the sim thread publishes frames into
//! shared memory and JS reads them in place.
//!
//! Exports (API version 1 of the runtime's native module interface):
//!   backend                 'physx' or 'cpu'
//!   createProbe(boxes)      starts the probe scene (see probe.rs) and returns
//!                           { buffer, slotWords, headerWords, wordsPerBody,
//!                             acquire(): slot index, stop(): error string | undefined }

pub mod frame;
pub mod mystral;
pub mod probe;

use std::cell::RefCell;
use std::rc::Rc;

use mystral::{Api, Env, Js, Value, API, API_VERSION};

const BACKEND: &str = if cfg!(feature = "physx") { "physx" } else { "cpu" };

/// # Safety
/// Called by the mystralnative runtime with its API table, a live env and a
/// fresh exports object.
#[no_mangle]
pub unsafe extern "C" fn mystral_module_init(api: *const Api, env: Env, exports: Value) -> i32 {
    let Some(api) = api.as_ref() else { return 1 };
    if api.version < API_VERSION || (api.struct_size as usize) < std::mem::size_of::<Api>() {
        return 2;
    }
    let api: &'static Api = &*(api as *const Api);
    let _ = API.set(api);
    let js = Js::new(api, env);

    js.set(exports, "backend", js.string(BACKEND));
    js.set(exports, "createProbe", js.function("createProbe", create_probe));
    0
}

fn create_probe(js: Js, args: &[Value]) -> Value {
    let boxes = js.arg_number(args, 0, 64.0).clamp(1.0, 100_000.0) as usize;
    let slot_words = probe::HEADER_WORDS + boxes * probe::WORDS_PER_BODY;
    let (shared, writer, reader) = frame::triple_buffer(slot_words);
    let probe = Rc::new(RefCell::new(probe::Probe::spawn(boxes, writer)));
    let reader = Rc::new(RefCell::new(reader));

    // The storage is never freed while JS can reach the buffer: `shared` is
    // kept alive by the acquire closure, which the module never releases.
    let (data, len) = shared.bytes();
    let handle = js.object();
    js.set(handle, "buffer", js.external_buffer(data, len));
    js.set(handle, "slotWords", js.number(shared.slot_words() as f64));
    js.set(handle, "headerWords", js.number(probe::HEADER_WORDS as f64));
    js.set(handle, "wordsPerBody", js.number(probe::WORDS_PER_BODY as f64));
    js.set(handle, "boxes", js.number(boxes as f64));
    {
        let reader = reader.clone();
        let _keep_alive = shared.clone();
        js.set(handle, "acquire", js.function("acquire", move |js, _| {
            let _ = &_keep_alive;
            js.number(reader.borrow_mut().acquire() as f64)
        }));
    }
    js.set(handle, "stop", js.function("stop", move |js, _| match probe.borrow_mut().stop() {
        Ok(()) => js.undefined(),
        Err(error) => js.string(&error),
    }));
    handle
}
