//! Rust side of mystralnative's native module C API
//! (`include/mystral/native_module.h` in the runtime, API version 1).
//!
//! `Api` mirrors `mystral_native_api` field for field; `Js` wraps it with the
//! handful of safe helpers this crate uses.

use std::ffi::{c_char, c_int, c_void, CString};

pub const API_VERSION: u32 = 1;

pub type Env = *mut c_void;

/// `mystral_value`: an opaque JS value handle, copied by value.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Value {
    ptr: *mut c_void,
    ctx: *mut c_void,
}

pub const TYPE_FUNCTION: c_int = 5;

pub type Callback = unsafe extern "C" fn(Env, *mut c_void, usize, *const Value) -> Value;
pub type Task = unsafe extern "C" fn(Env, *mut c_void);
pub type Finalizer = unsafe extern "C" fn(*mut c_void, *mut c_void);

#[repr(C)]
pub struct Api {
    pub version: u32,
    pub struct_size: u32,
    pub undefined: unsafe extern "C" fn(Env) -> Value,
    pub null: unsafe extern "C" fn(Env) -> Value,
    pub boolean: unsafe extern "C" fn(Env, c_int) -> Value,
    pub number: unsafe extern "C" fn(Env, f64) -> Value,
    pub string: unsafe extern "C" fn(Env, *const c_char, usize) -> Value,
    pub object: unsafe extern "C" fn(Env) -> Value,
    pub array: unsafe extern "C" fn(Env, usize) -> Value,
    pub function: unsafe extern "C" fn(Env, *const c_char, Callback, *mut c_void) -> Value,
    pub array_buffer_copy: unsafe extern "C" fn(Env, *const c_void, usize) -> Value,
    pub array_buffer_external:
        unsafe extern "C" fn(Env, *mut c_void, usize, Option<Finalizer>, *mut c_void) -> Value,
    pub type_of: unsafe extern "C" fn(Env, Value) -> c_int,
    pub to_bool: unsafe extern "C" fn(Env, Value) -> c_int,
    pub to_number: unsafe extern "C" fn(Env, Value) -> f64,
    pub to_string: unsafe extern "C" fn(Env, Value, *mut c_char, usize) -> usize,
    pub buffer_data: unsafe extern "C" fn(Env, Value, *mut usize) -> *mut c_void,
    pub set_property: unsafe extern "C" fn(Env, Value, *const c_char, Value) -> c_int,
    pub get_property: unsafe extern "C" fn(Env, Value, *const c_char) -> Value,
    pub set_index: unsafe extern "C" fn(Env, Value, u32, Value) -> c_int,
    pub get_index: unsafe extern "C" fn(Env, Value, u32) -> Value,
    pub call: unsafe extern "C" fn(Env, Value, Value, usize, *const Value) -> Value,
    pub throw_error: unsafe extern "C" fn(Env, *const c_char),
    pub retain: unsafe extern "C" fn(Env, Value),
    pub release: unsafe extern "C" fn(Env, Value),
    pub post_to_js_thread: unsafe extern "C" fn(Env, Task, *mut c_void),
}

/// The API table plus the env of one call. Only valid on the JS thread.
#[derive(Clone, Copy)]
pub struct Js {
    api: &'static Api,
    env: Env,
}

/// A native function body: receives the call's arguments, returns a value.
pub type Method = Box<dyn Fn(Js, &[Value]) -> Value>;

impl Js {
    /// # Safety
    /// `api` must be the runtime's table and `env` a live env from it.
    pub unsafe fn new(api: &'static Api, env: Env) -> Self {
        Self { api, env }
    }

    pub fn undefined(self) -> Value {
        unsafe { (self.api.undefined)(self.env) }
    }

    pub fn number(self, value: f64) -> Value {
        unsafe { (self.api.number)(self.env, value) }
    }

    pub fn boolean(self, value: bool) -> Value {
        unsafe { (self.api.boolean)(self.env, value as c_int) }
    }

    pub fn string(self, value: &str) -> Value {
        unsafe { (self.api.string)(self.env, value.as_ptr().cast(), value.len()) }
    }

    pub fn object(self) -> Value {
        unsafe { (self.api.object)(self.env) }
    }

    pub fn array(self, length: usize) -> Value {
        unsafe { (self.api.array)(self.env, length) }
    }

    pub fn set_index(self, array: Value, index: u32, value: Value) {
        unsafe { (self.api.set_index)(self.env, array, index, value) };
    }

    /// A copy of `bytes` as a fresh ArrayBuffer.
    pub fn array_buffer(self, bytes: &[u8]) -> Value {
        unsafe { (self.api.array_buffer_copy)(self.env, bytes.as_ptr().cast(), bytes.len()) }
    }

    /// The bytes of an ArrayBuffer or typed array argument (borrowed for the
    /// duration of the call).
    pub fn bytes<'a>(self, value: Value) -> Option<&'a [u8]> {
        let mut len = 0usize;
        let data = unsafe { (self.api.buffer_data)(self.env, value, &mut len) };
        if data.is_null() {
            return if len == 0 { Some(&[]) } else { None };
        }
        Some(unsafe { std::slice::from_raw_parts(data as *const u8, len) })
    }

    pub fn string_arg(self, args: &[Value], index: usize) -> Option<String> {
        let value = *args.get(index)?;
        let len = unsafe { (self.api.to_string)(self.env, value, std::ptr::null_mut(), 0) };
        let mut buffer = vec![0u8; len + 1];
        unsafe { (self.api.to_string)(self.env, value, buffer.as_mut_ptr().cast(), buffer.len()) };
        buffer.truncate(len);
        String::from_utf8(buffer).ok()
    }

    pub fn to_bool(self, value: Value) -> bool {
        unsafe { (self.api.to_bool)(self.env, value) != 0 }
    }

    pub fn to_number(self, value: Value) -> f64 {
        unsafe { (self.api.to_number)(self.env, value) }
    }

    pub fn arg_number(self, args: &[Value], index: usize, default: f64) -> f64 {
        match args.get(index) {
            Some(&value) => {
                let n = self.to_number(value);
                if n.is_finite() { n } else { default }
            }
            None => default,
        }
    }

    pub fn set(self, object: Value, name: &str, value: Value) {
        let name = CString::new(name).expect("property name without NUL");
        unsafe { (self.api.set_property)(self.env, object, name.as_ptr(), value) };
    }

    pub fn throw(self, message: &str) -> Value {
        let message = CString::new(message.replace('\0', " ")).unwrap_or_default();
        unsafe { (self.api.throw_error)(self.env, message.as_ptr()) };
        self.undefined()
    }

    /// A zero-copy ArrayBuffer over `len` bytes at `data`. The memory must
    /// stay valid for as long as JS can reach the buffer; this crate only
    /// passes memory it never frees while the module is loaded.
    pub fn external_buffer(self, data: *mut u8, len: usize) -> Value {
        unsafe { (self.api.array_buffer_external)(self.env, data.cast(), len, None, std::ptr::null_mut()) }
    }

    /// A JS function that runs `method`. The closure lives as long as the
    /// module (the runtime has no function finalizer in API version 1).
    pub fn function(self, name: &str, method: impl Fn(Js, &[Value]) -> Value + 'static) -> Value {
        let boxed: Box<Method> = Box::new(Box::new(method));
        let name = CString::new(name).expect("function name without NUL");
        unsafe {
            (self.api.function)(self.env, name.as_ptr(), trampoline, Box::into_raw(boxed).cast())
        }
    }
}

unsafe extern "C" fn trampoline(env: Env, data: *mut c_void, argc: usize, argv: *const Value) -> Value {
    let js = Js::new(API.get().expect("module initialised"), env);
    let method = &*(data as *const Method);
    let args = if argc == 0 || argv.is_null() { &[][..] } else { std::slice::from_raw_parts(argv, argc) };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| method(js, args))) {
        Ok(value) => value,
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .unwrap_or("native panic");
            js.throw(&format!("vibe_sim panicked: {message}"))
        }
    }
}

/// The runtime's API table, saved at `mystral_module_init`.
pub static API: std::sync::OnceLock<&'static Api> = std::sync::OnceLock::new();
