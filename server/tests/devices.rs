//! Network exposure, device pairing, progress ordering and rescans.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use shinema_server::{Library, router_at_with_admin_token, router_with_admin_token};
use std::path::Path;
use tower::ServiceExt;

// A public synthetic fixture, never an installed operator credential.
const ADMIN: &str = "synthetic-devices-test-operator-token-0000000";
const LAN_HOST: &str = "192.168.1.20:8787";

fn lan_app(media: &Path, state: &Path) -> Router {
    router_at_with_admin_token(
        Library::open(media, state).unwrap(),
        LAN_HOST.parse().unwrap(),
        Some(ADMIN.into()),
    )
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    host: &str,
    bearer: Option<&str>,
    payload: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, host);
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = match payload {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    let state = temporary.path().join("state");
    std::fs::create_dir(&media).unwrap();
    std::fs::write(media.join("Generated_film.mp4"), b"0123456789").unwrap();
    (temporary, media, state)
}

async fn pair(app: &Router) -> (String, String) {
    let (status, code) = send(
        app,
        "POST",
        "/api/pairing/codes",
        LAN_HOST,
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, device) = send(
        app,
        "POST",
        "/api/pairing/claim",
        LAN_HOST,
        None,
        Some(json!({"code": code["code"], "deviceName": "Living room Shield"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    (
        device["deviceId"].as_str().unwrap().to_string(),
        device["token"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn network_exposure_requires_a_paired_device() {
    let (_temporary, media, state) = fixture();
    let app = lan_app(&media, &state);

    let (status, health) = send(&app, "GET", "/health", LAN_HOST, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["authRequired"], true);
    let (status, _) = send(&app, "GET", "/api/catalog", LAN_HOST, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Only the server machine or the operator token may create codes.
    let (status, _) = send(&app, "POST", "/api/pairing/codes", LAN_HOST, None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (device_id, token) = pair(&app).await;
    let (status, catalog) = send(&app, "GET", "/api/catalog", LAN_HOST, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    let id = catalog["items"][0]["id"].as_str().unwrap().to_string();
    let (status, session) = send(&app, "GET", "/api/session", LAN_HOST, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["deviceName"], "Living room Shield");

    // Media elements cannot send headers, so streams accept a query token;
    // other routes do not.
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/media/{id}/stream?access_token={token}"),
        LAN_HOST,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/media/{id}/progress?access_token={token}"),
        LAN_HOST,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, devices) = send(&app, "GET", "/api/devices", LAN_HOST, Some(ADMIN), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(devices["items"][0]["id"], device_id.as_str());
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/devices/{device_id}"),
        LAN_HOST,
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&app, "GET", "/api/catalog", LAN_HOST, Some(&token), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn network_exposure_rejects_foreign_browser_origins() {
    let (_temporary, media, state) = fixture();
    let app = lan_app(&media, &state);
    let (_, token) = pair(&app).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .header(header::HOST, LAN_HOST)
                .header(header::ORIGIN, "https://evil.example")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_codes_cannot_be_reused_or_guessed() {
    let (_temporary, media, state) = fixture();
    let app = lan_app(&media, &state);
    let (_, code) = send(
        &app,
        "POST",
        "/api/pairing/codes",
        LAN_HOST,
        Some(ADMIN),
        None,
    )
    .await;
    let claim = json!({"code": code["code"], "deviceName": "Phone"});
    let (status, _) = send(
        &app,
        "POST",
        "/api/pairing/claim",
        LAN_HOST,
        None,
        Some(claim.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = send(
        &app,
        "POST",
        "/api/pairing/claim",
        LAN_HOST,
        None,
        Some(claim),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        &app,
        "POST",
        "/api/pairing/claim",
        LAN_HOST,
        None,
        Some(json!({"code": "12", "deviceName": "Phone", "extra": true})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn loopback_servers_keep_working_without_tokens() {
    let (_temporary, media, state) = fixture();
    let app = router_with_admin_token(Library::open(&media, &state).unwrap(), None);
    let (status, health) = send(&app, "GET", "/health", "127.0.0.1:8787", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["authRequired"], false);
    let (status, _) = send(&app, "GET", "/api/catalog", "127.0.0.1:8787", None, None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn older_progress_never_replaces_newer_progress() {
    let (_temporary, media, state) = fixture();
    let app = router_with_admin_token(Library::open(&media, &state).unwrap(), None);
    let host = "127.0.0.1:8787";
    let (_, catalog) = send(&app, "GET", "/api/catalog", host, None, None).await;
    let uri = format!(
        "/api/media/{}/progress",
        catalog["items"][0]["id"].as_str().unwrap()
    );

    let newer = json!({"positionSeconds": 40.0, "durationSeconds": 60.0, "updatedAt": 2_000_000});
    let (status, _) = send(&app, "PUT", &uri, host, None, Some(newer)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // An offline device replays a position it observed earlier.
    let older = json!({"positionSeconds": 10.0, "durationSeconds": 60.0, "updatedAt": 1_000_000});
    let (status, current) = send(&app, "PUT", &uri, host, None, Some(older)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(current["positionSeconds"], 40.0);
    assert_eq!(current["updatedAt"], 2_000_000);

    // Writes without a timestamp count as "now", as before.
    let legacy = json!({"positionSeconds": 12.0, "durationSeconds": 60.0});
    let (status, _) = send(&app, "PUT", &uri, host, None, Some(legacy)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // A clock far in the future is clamped, so it cannot pin progress forever.
    let future = json!({"positionSeconds": 30.0, "durationSeconds": 60.0, "updatedAt": 9_000_000_000_000_u64});
    let (status, _) = send(&app, "PUT", &uri, host, None, Some(future)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, stored) = send(&app, "GET", &uri, host, None, None).await;
    assert!(stored["updatedAt"].as_u64().unwrap() < 9_000_000_000_000);
    let later = json!({"positionSeconds": 31.0, "durationSeconds": 60.0});
    let (status, _) = send(&app, "PUT", &uri, host, None, Some(later)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn rescans_pick_up_new_files_and_keep_progress() {
    let (_temporary, media, state) = fixture();
    let app = router_with_admin_token(Library::open(&media, &state).unwrap(), Some(ADMIN.into()));
    let host = "127.0.0.1:8787";
    let (_, catalog) = send(&app, "GET", "/api/catalog", host, None, None).await;
    let id = catalog["items"][0]["id"].as_str().unwrap().to_string();
    let progress = format!("/api/media/{id}/progress");
    send(
        &app,
        "PUT",
        &progress,
        host,
        None,
        Some(json!({"positionSeconds": 5.0, "durationSeconds": 60.0})),
    )
    .await;

    std::fs::write(media.join("Another_film.mkv"), b"abcdef").unwrap();
    let (status, _) = send(&app, "POST", "/api/admin/rescan", host, None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, report) = send(&app, "POST", "/api/admin/rescan", host, Some(ADMIN), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["media"], 2);

    let (_, catalog) = send(&app, "GET", "/api/catalog", host, None, None).await;
    assert_eq!(catalog["total"], 2);
    let (_, stored) = send(&app, "GET", &progress, host, None, None).await;
    assert_eq!(stored["positionSeconds"], 5.0);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/media/{id}/stream"),
        host,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn artwork_widths_are_validated() {
    let (_temporary, media, state) = fixture();
    let app = router_with_admin_token(Library::open(&media, &state).unwrap(), None);
    let host = "127.0.0.1:8787";
    let (_, catalog) = send(&app, "GET", "/api/catalog", host, None, None).await;
    let id = catalog["items"][0]["id"].as_str().unwrap();
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/media/{id}/poster?w=0"),
        host,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // No metadata provider is configured, so there is no artwork to size.
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/media/{id}/poster?w=320"),
        host,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_folders_are_skipped_instead_of_stopping_startup() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return; // root ignores directory permissions
    }
    let (_temporary, media, state) = fixture();
    let locked = media.join("lost+found");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("hidden.mkv"), b"x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let opened = Library::open(&media, &state);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
    let app = router_with_admin_token(opened.unwrap(), None);
    let (_, catalog) = send(&app, "GET", "/api/catalog", "127.0.0.1:8787", None, None).await;
    assert_eq!(catalog["total"], 1);
}
