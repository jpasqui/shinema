use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use shinema_server::{Library, router};
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, axum::Router) {
    let temporary = tempfile::tempdir().unwrap();
    let media = temporary.path().join("media");
    std::fs::create_dir(&media).unwrap();
    std::fs::write(media.join("Synthetic.mp4"), b"generated fixture").unwrap();
    let app = router(Library::open(&media, &temporary.path().join("state")).unwrap());
    (temporary, app)
}

#[tokio::test]
async fn untrusted_websites_cannot_read_media_or_mutate_progress() {
    let (_temporary, app) = fixture();
    let catalog = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .header(header::HOST, "127.0.0.1:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(catalog.status(), StatusCode::OK);
    let bytes = catalog.into_body().collect().await.unwrap().to_bytes();
    let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let id = catalog["items"][0]["id"].as_str().unwrap();
    let progress = format!("/api/media/{id}/progress");
    for (host, origin, site) in [
        ("rebound.example:8787", None, None),
        ("127.0.0.1:8787", Some("https://untrusted.example"), None),
        ("127.0.0.1:8787", None, Some("cross-site")),
    ] {
        for path in [
            "/health".into(),
            "/".into(),
            "/api/catalog".into(),
            format!("/api/media/{id}/stream"),
            format!("/api/media/{id}/metadata"),
            format!("/api/media/{id}/hls/index.m3u8"),
            progress.clone(),
        ] {
            let mut request = Request::builder().uri(&path).header(header::HOST, host);
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            if let Some(site) = site {
                request = request.header("sec-fetch-site", site);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host} {path}");
            assert!(
                response
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .is_empty()
            );
        }
        let mut request = Request::builder()
            .method("PUT")
            .uri(&progress)
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(Body::from(r#"{"positionSeconds":12,"durationSeconds":60}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri(progress)
                .header(header::HOST, "127.0.0.1:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "null"
    );
}

#[tokio::test]
async fn loopback_clients_and_forwarded_development_requests_still_work() {
    let (_temporary, app) = fixture();
    for (host, origin, site) in [
        ("127.0.0.1:8787", None, None), // FFmpeg/native clients omit Origin.
        ("localhost", None, Some("none")),
        (
            "LOCALHOST:8787",
            Some("http://localhost:8787"),
            Some("same-origin"),
        ),
        ("[::1]:8787", Some("http://[::1]:8787"), Some("same-origin")),
        ("127.0.0.2:8787", None, None),
        // Vite forwards its incoming Host and Origin unchanged to Rust :8787.
        (
            "127.0.0.1:5173",
            Some("http://127.0.0.1:5173"),
            Some("same-origin"),
        ),
        (
            "localhost:5173",
            Some("http://localhost:5173"),
            Some("same-origin"),
        ),
    ] {
        let mut request = Request::builder()
            .uri("/api/catalog")
            .header(header::HOST, host);
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{host}");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = catalog["items"][0]["id"].as_str().unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/media/{id}/stream"))
                    .header(header::HOST, host)
                    .header(header::RANGE, "bytes=0-8")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "generated"
        );
        let mut request = Request::builder()
            .method("PUT")
            .uri(format!("/api/media/{id}/progress"))
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(Body::from(r#"{"positionSeconds":12,"durationSeconds":60}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{host}");
    }
    // HTTP/2 :authority and consistent absolute-form HTTP/1 URIs are supported.
    for host in [None, Some("localhost:8787")] {
        let mut request = Request::builder().uri("http://localhost:8787/health");
        if let Some(host) = host {
            request = request.header(header::HOST, host);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn missing_ambiguous_and_malformed_authorities_or_browser_headers_are_rejected() {
    let (_temporary, app) = fixture();
    let requests = [
        Request::builder().uri("/health"),
        Request::builder().uri("http://rebound.example/health"),
        Request::builder()
            .uri("http://rebound.example/health")
            .header("host", "localhost"),
        Request::builder()
            .uri("http://localhost:8787/health")
            .header("host", "localhost:5173"),
        Request::builder()
            .uri("/health")
            .header("host", "localhost")
            .header("host", "localhost"),
        Request::builder()
            .uri("/health")
            .header("host", "localhost")
            .header("origin", "http://localhost")
            .header("origin", "http://localhost"),
        Request::builder()
            .uri("/health")
            .header("host", "localhost")
            .header("sec-fetch-site", "none")
            .header("sec-fetch-site", "same-origin"),
    ];
    for request in requests {
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    for host in [
        "localhost.evil.example",
        "localhost.",
        "evil.localhost",
        "0.0.0.0:8787",
        "[::]:8787",
        "192.0.2.1",
        "user@localhost",
        "localhost:",
        "localhost:65536",
        "localhost:bad",
        "localhost,localhost",
        "127.1",
        "2130706433",
        "localhost/path",
        "localhost?query",
        "localhost#fragment",
        "localhost:80:90",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("host", host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host}");
    }
    for origin in [
        "null",
        "file://localhost",
        "http://untrusted.example",
        "http://localhost.evil.example",
        "http://user@localhost",
        "http://localhost:bad",
        "http://localhost:65536",
        "http://localhost/path",
        "http://localhost?query",
        "http://localhost#fragment",
        "http://localhost http://localhost",
        "http://localhost,http://localhost",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("host", "localhost")
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
    }
}
