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
