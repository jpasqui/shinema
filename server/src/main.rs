use std::{env, net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let media = PathBuf::from(
        env::var("SHINEMA_MEDIA_ROOT")
            .map_err(|_| "Set SHINEMA_MEDIA_ROOT to a read-only media directory")?,
    );
    let state = PathBuf::from(
        env::var("SHINEMA_STATE_DIR")
            .map_err(|_| "Set SHINEMA_STATE_DIR to a separate writable directory")?,
    );
    let bind: SocketAddr = env::var("SHINEMA_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    if !bind.ip().is_loopback() {
        return Err("This first slice only supports loopback binding; use an explicitly approved temporary device tunnel for local tests".into());
    }
    let library = shinema_server::Library::open(&media, &state)?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!("Shinema listening on loopback; API version 1");
    axum::serve(listener, shinema_server::router(library))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
