use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use shinema_server::{Library, byte_range, router};
use tower::ServiceExt;

async fn body(response: axum::response::Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

#[test]
fn ranges_cover_boundaries() {
    assert_eq!(byte_range("bytes=2-5", 10), Ok((2, 5)));
    assert_eq!(byte_range("bytes=8-", 10), Ok((8, 9)));
    assert_eq!(byte_range("bytes=-3", 10), Ok((7, 9)));
    assert_eq!(byte_range("bytes=-100", 10), Ok((0, 9)));
    for bad in [
        "bytes=10-",
        "bytes=3-2",
        "bytes=-0",
        "bytes=0-1,3-4",
        "bytes=+1-2",
        "other=0-1",
    ] {
        assert!(byte_range(bad, 10).is_err(), "{bad}");
    }
    assert!(byte_range("bytes=0-", 0).is_err());
}

#[tokio::test]
async fn catalog_stream_progress_and_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    let state = temporary.path().join("state");
    std::fs::create_dir(&media).unwrap();
    std::fs::write(media.join("Sample_movie.mp4"), b"0123456789").unwrap();
    std::fs::write(media.join("private.txt"), b"never served").unwrap();
    let app = router(Library::open(&media, &state).unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
    assert_eq!(catalog["apiVersion"], 1);
    assert_eq!(catalog["items"].as_array().unwrap().len(), 1);
    let item = &catalog["items"][0];
    assert_eq!(item["title"], "Sample movie");
    assert!(item.get("path").is_none());
    let id = item["id"].as_str().unwrap();
    let uri = format!("/api/media/{id}/stream");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&uri)
                .header("range", "bytes=2-5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
    assert_eq!(body(response).await, b"2345");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(&uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["content-length"], "10");
    assert!(body(response).await.is_empty());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&uri)
                .header("range", "bytes=20-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(response.headers()["content-range"], "bytes */10");
    for path in [
        "/api/media/..%2fprivate.txt/stream",
        "/api/media/not-an-id/stream",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::OK);
    }
    let uri = format!("/api/media/{id}/progress");
    let request = |payload: &str| {
        Request::builder()
            .method("PUT")
            .uri(&uri)
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request(r#"{"positionSeconds":12,"durationSeconds":60}"#))
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.clone()
            .oneshot(request(r#"{"positionSeconds":80,"durationSeconds":60}"#))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    drop(app);
    let reopened = router(Library::open(&media, &state).unwrap());
    let response = reopened
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
    assert_eq!(value["positionSeconds"], 12.0);
    assert_eq!(
        std::fs::read(media.join("Sample_movie.mp4")).unwrap(),
        b"0123456789"
    );
}

#[test]
fn writable_state_cannot_overlap_media() {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir(&media).unwrap();
    assert!(Library::open(&media, &media.join("state")).is_err());
    assert!(!media.join("state").exists());
    assert!(Library::open(&media, temporary.path()).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn links_outside_library_are_not_served() {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir(&media).unwrap();
    let outside = temporary.path().join("outside.mp4");
    std::fs::write(&outside, b"private").unwrap();
    std::os::unix::fs::symlink(&outside, media.join("escape.mp4")).unwrap();
    std::fs::write(media.join("ok.mp4"), b"public").unwrap();
    let app = router(Library::open(&media, &temporary.path().join("state")).unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
    assert_eq!(catalog["items"].as_array().unwrap().len(), 1);
    let id = catalog["items"][0]["id"].as_str().unwrap();
    std::fs::remove_file(media.join("ok.mp4")).unwrap();
    std::os::unix::fs::symlink(outside, media.join("ok.mp4")).unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/media/{id}/stream"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

fn protected_database(path: &std::path::Path) -> Vec<u8> {
    let database = rusqlite::Connection::open(path).unwrap();
    database
        .execute_batch(
            "CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('unchanged');",
        )
        .unwrap();
    drop(database);
    std::fs::read(path).unwrap()
}

#[cfg(unix)]
#[test]
fn sqlite_database_and_sidecar_symlinks_never_modify_media() {
    for name in [
        "progress.sqlite3",
        "progress.sqlite3-wal",
        "progress.sqlite3-shm",
        "progress.sqlite3-journal",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let media = temporary.path().join("media");
        let state = temporary.path().join("state");
        std::fs::create_dir(&media).unwrap();
        std::fs::create_dir(&state).unwrap();
        let target = media.join("protected.sqlite3");
        let before = protected_database(&target);
        std::os::unix::fs::symlink(&target, state.join(name)).unwrap();
        assert!(Library::open(&media, &state).is_err(), "{name}");
        assert_eq!(std::fs::read(&target).unwrap(), before, "{name}");
    }
}

#[test]
fn sqlite_database_and_sidecar_hardlinks_never_modify_media() {
    for name in [
        "progress.sqlite3",
        "progress.sqlite3-wal",
        "progress.sqlite3-shm",
        "progress.sqlite3-journal",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let media = temporary.path().join("media");
        let state = temporary.path().join("state");
        std::fs::create_dir(&media).unwrap();
        std::fs::create_dir(&state).unwrap();
        let target = media.join("protected.sqlite3");
        let before = protected_database(&target);
        std::fs::hard_link(&target, state.join(name)).unwrap();
        assert!(Library::open(&media, &state).is_err(), "{name}");
        assert_eq!(std::fs::read(&target).unwrap(), before, "{name}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn literal_backslash_and_directory_separator_have_distinct_ids() {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir_all(media.join("a")).unwrap();
    std::fs::write(media.join("a\\b.mp4"), b"literal backslash").unwrap();
    std::fs::write(media.join("a/b.mp4"), b"nested path").unwrap();
    let app = router(Library::open(&media, &temporary.path().join("state")).unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
    let items = catalog["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_ne!(items[0]["id"], items[1]["id"]);
    let mut payloads = Vec::new();
    for item in items {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(item["streamPath"].as_str().unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        payloads.push(body(response).await);
    }
    payloads.sort();
    assert_eq!(
        payloads,
        vec![b"literal backslash".to_vec(), b"nested path".to_vec()]
    );
    use sha2::{Digest, Sha256};
    assert!(
        items
            .iter()
            .any(|item| item["id"] == format!("{:x}", Sha256::digest(b"a/b.mp4")))
    );
}

#[tokio::test]
async fn unicode_catalog_uses_shared_scalar_length_contract() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../packages/contracts/fixtures/unicode-title.json"
    ))
    .unwrap();
    let title = fixture["title"].as_str().unwrap();
    assert_eq!(
        title.chars().count(),
        fixture["scalarLength"].as_u64().unwrap() as usize
    );
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir(&media).unwrap();
    std::fs::write(media.join(format!("{title}.mp4")), b"generated bytes").unwrap();
    let app = router(Library::open(&media, &temporary.path().join("state")).unwrap());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
    assert_eq!(catalog["items"][0]["title"], title);
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_utf8_names_do_not_collide_with_each_other_or_replacement_text() {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStringExt;
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir(&media).unwrap();
    std::fs::write(
        media.join(std::ffi::OsString::from_vec(b"a\xff.mp4".to_vec())),
        b"first",
    )
    .unwrap();
    std::fs::write(
        media.join(std::ffi::OsString::from_vec(b"a\xfe.mp4".to_vec())),
        b"second",
    )
    .unwrap();
    std::fs::write(media.join("a\u{fffd}.mp4"), b"third").unwrap();
    let app = router(Library::open(&media, &temporary.path().join("state")).unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
    let items = catalog["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    let ids = items
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(format!("{:x}", Sha256::digest("a\u{fffd}.mp4".as_bytes())).as_str()));
    let mut payloads = Vec::new();
    for item in items {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(item["streamPath"].as_str().unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        payloads.push(body(response).await);
    }
    payloads.sort();
    assert_eq!(
        payloads,
        vec![b"first".to_vec(), b"second".to_vec(), b"third".to_vec()]
    );
}
