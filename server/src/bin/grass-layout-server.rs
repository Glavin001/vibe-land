//! Optional content-only process for updating grass without restarting live physics.
#[path = "../grass_layout.rs"]
mod grass_layout;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let store = grass_layout::GrassStore::from_env();
    let app = grass_layout::router::<()>(store).layer(tower_http::cors::CorsLayer::permissive());
    let address = std::env::var("GRASS_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:4183".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("Grass layouts listening at {address}");
    axum::serve(listener, app).await?;
    Ok(())
}
