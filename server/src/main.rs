use std::{env, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = PathBuf::from(
        env::var("SHINEMA_STATE_DIR")
            .map_err(|_| "Set SHINEMA_STATE_DIR to a separate writable directory")?,
    );
    let bind: SocketAddr = env::var("SHINEMA_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    let rescan_minutes: u64 = env::var("SHINEMA_RESCAN_MINUTES")
        .map(|value| value.parse())
        .unwrap_or(Ok(15))
        .map_err(|_| "SHINEMA_RESCAN_MINUTES must be a whole number of minutes (0 disables)")?;
    let library = if let Ok(config) = env::var("SHINEMA_SSH_CONFIG") {
        shinema_server::Library::open_ssh(
            shinema_server::SshConfig::from_file(&PathBuf::from(config))?,
            &state,
        )
        .await?
    } else {
        let media = PathBuf::from(
            env::var("SHINEMA_MEDIA_ROOT")
                .map_err(|_| "Set SHINEMA_MEDIA_ROOT or existing SHINEMA_SSH_CONFIG")?,
        );
        shinema_server::Library::open(&media, &state)?
    };
    let requests = shinema_server::requests::Engine::from_env(&state)?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let bind = listener.local_addr()?;
    match shinema_server::devices::Exposure::for_bind(bind) {
        shinema_server::devices::Exposure::Loopback => {
            eprintln!("Shinema listening on {bind} (this computer only); API version 1");
        }
        shinema_server::devices::Exposure::Network => {
            eprintln!(
                "Shinema listening on {bind} (home network, plain HTTP; use a reverse proxy for HTTPS); API version 1"
            );
            if let Some(code) = library.startup_pairing_code() {
                eprintln!(
                    "No devices are paired yet. Enter pairing code {} on your TV, phone or browser within 10 minutes.",
                    code.code
                );
            }
        }
    }
    if rescan_minutes > 0 {
        spawn_rescans(library.clone(), Duration::from_secs(rescan_minutes * 60));
    }
    axum::serve(
        listener,
        shinema_server::router_at_with_requests(library, bind, requests)
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}

/// Picks up added, removed and renamed files without a restart.
fn spawn_rescans(library: Arc<shinema_server::Library>, every: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(error) = library.rescan().await {
                eprintln!("Shinema rescan failed: {error}");
            }
        }
    });
}
