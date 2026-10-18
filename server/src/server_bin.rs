//! The game server binary. The server is a library (src/lib.rs) so the native
//! app can run a match in-process too; this just starts it.
fn main() -> anyhow::Result<()> {
    web_fps_server::main()
}
