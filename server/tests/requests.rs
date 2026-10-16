//! Synthetic loopback HTTP fixtures only; no configured or live provider is used.
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use shinema_server::requests::{self, Config, Engine, ProviderConfig};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const TOKEN: &str = "synthetic-operator-token-for-tests-0000";
const KEY: &str = "synthetic-provider-key-00000000000000";
const HOST: &str = "127.0.0.1:8787";

#[derive(Clone, Copy, Default)]
enum Reply {
    #[default]
    Success,
    Ambiguous,
    Rejected,
    DuplicateRace,
    Timeout,
}
#[derive(Default)]
struct Fixture {
    movies: Vec<Value>,
    series: Vec<Value>,
    posts: Vec<Value>,
    calls: usize,
    reply: Reply,
    unavailable: bool,
    oversized: bool,
    redirect: Option<String>,
    lookup_barrier: Option<Arc<tokio::sync::Barrier>>,
}
struct Mock {
    state: Arc<Mutex<Fixture>>,
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Mock {
    async fn start() -> Self {
        let state = Arc::new(Mutex::new(Fixture::default()));
        let app = Router::new().fallback(provider).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/fixture/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { state, url, task }
    }
    fn engine(&self, state_dir: &std::path::Path) -> Arc<Engine> {
        Engine::new(
            state_dir,
            Config {
                token: TOKEN.into(),
                radarr: Some(
                    ProviderConfig::new(&self.url, KEY.into(), "/synthetic/movies".into(), 3)
                        .unwrap(),
                ),
                sonarr: Some(
                    ProviderConfig::new(&self.url, KEY.into(), "/synthetic/series".into(), 7)
                        .unwrap(),
                ),
            },
        )
        .unwrap()
    }
    fn app(&self, state_dir: &std::path::Path) -> Router {
        requests::router(self.engine(state_dir), HOST.parse().unwrap())
    }
}
fn lookup(kind: &str, id: u32) -> Value {
    if kind == "movie" {
        json!({"tmdbId":id,"title":format!("Synthetic Movie {id}"),"year":2025,"overview":"Generated fixture; no real media.","titleSlug":format!("synthetic-movie-{id}")})
    } else {
        json!({"tvdbId":id,"title":format!("Synthetic Series {id}"),"year":2024,"overview":"Generated fixture; no real media.","titleSlug":format!("synthetic-series-{id}"),"seasons":[{"seasonNumber":0},{"seasonNumber":1}]})
    }
}
async fn provider(State(state): State<Arc<Mutex<Fixture>>>, request: Request) -> Response {
    assert_eq!(request.headers().get("x-api-key").unwrap(), KEY);
    assert!(
        request.headers().get(header::AUTHORIZATION).is_none(),
        "Operator token must never be sent to provider"
    );
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let query = request.uri().query().unwrap_or("").to_string();
    let body = to_bytes(request.into_body(), 4096).await.unwrap();
    let barrier = if path.ends_with("/lookup") {
        state.lock().unwrap().lookup_barrier.clone()
    } else {
        None
    };
    if let Some(barrier) = barrier {
        barrier.wait().await;
    }
    let timed_out_payload = {
        let mut fixture = state.lock().unwrap();
        fixture.calls += 1;
        if fixture.unavailable {
            return (
                StatusCode::BAD_GATEWAY,
                "private provider error including secret material",
            )
                .into_response();
        }
        if let Some(location) = &fixture.redirect {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [(header::LOCATION, location.clone())],
            )
                .into_response();
        }
        if fixture.oversized {
            return (StatusCode::OK, " ".repeat(2 * 1024 * 1024 + 1)).into_response();
        }
        let kind = if path.starts_with("/fixture/api/v3/movie") {
            "movie"
        } else if path.starts_with("/fixture/api/v3/series") {
            "series"
        } else {
            panic!("Unexpected provider path {path}");
        };
        if path.ends_with("/lookup") {
            assert_eq!(method, Method::GET);
            let query = reqwest::Url::parse(&format!("http://fixture.invalid/?{query}")).unwrap();
            let term = query
                .query_pairs()
                .find(|(key, _)| key == "term")
                .unwrap()
                .1
                .into_owned();
            if term == "nothing" {
                return Json(json!([])).into_response();
            }
            let id = term
                .split_once(':')
                .and_then(|(_, value)| value.parse().ok())
                .unwrap_or(101);
            return Json(json!([lookup(kind, id)])).into_response();
        }
        assert!(path == format!("/fixture/api/v3/{kind}"));
        if method == Method::GET {
            return Json(if kind == "movie" {
                json!(fixture.movies)
            } else {
                json!(fixture.series)
            })
            .into_response();
        }
        assert_eq!(method, Method::POST);
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert!(payload.get("apiKey").is_none());
        assert_eq!(
            payload["qualityProfileId"],
            if kind == "movie" { 3 } else { 7 }
        );
        assert_eq!(
            payload["rootFolderPath"],
            format!(
                "/synthetic/{}",
                if kind == "movie" { "movies" } else { "series" }
            )
        );
        assert_eq!(payload["monitored"], true);
        if kind == "movie" {
            assert_eq!(payload["addOptions"]["searchForMovie"], false);
        } else {
            assert_eq!(payload["addOptions"]["searchForMissingEpisodes"], false);
            assert_eq!(payload["addOptions"]["searchForCutoffUnmetEpisodes"], false);
            assert_eq!(
                payload["seasons"],
                json!([{"seasonNumber":0,"monitored":false},{"seasonNumber":1,"monitored":true}])
            );
        }
        fixture.posts.push(payload.clone());
        let reply = fixture.reply;
        if !matches!(reply, Reply::Rejected) {
            if kind == "movie" {
                fixture.movies.push(payload.clone());
            } else {
                fixture.series.push(payload.clone());
            }
        }
        match reply {
            Reply::Success => return (StatusCode::CREATED, Json(payload)).into_response(),
            Reply::Rejected | Reply::DuplicateRace => {
                return (
                    StatusCode::BAD_REQUEST,
                    "private provider rejection including secret material",
                )
                    .into_response();
            }
            Reply::Ambiguous => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "private provider error including secret material",
                )
                    .into_response();
            }
            Reply::Timeout => payload,
        }
    };
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    (StatusCode::CREATED, Json(timed_out_payload)).into_response()
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    auth: bool,
) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HOST);
    if auth {
        request = request.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    }
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 3 * 1024 * 1024)
        .await
        .unwrap();
    let raw = String::from_utf8_lossy(&bytes);
    for secret in [KEY, TOKEN, "/synthetic/", "private provider"] {
        assert!(
            !raw.contains(secret),
            "API leaked sensitive provider/configuration content"
        );
    }
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn disabled_and_locked_never_contact_provider_and_capabilities_are_coarse() {
    let disabled = requests::router(Engine::disabled(), HOST.parse().unwrap());
    let (status, value) = call(&disabled, "GET", "/api/requests/capabilities", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["enabled"], false);
    let (status, value) = call(&disabled, "GET", "/api/requests", None, false).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["error"]["code"], "disabled");
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    let (status, value) = call(&app, "GET", "/api/requests/capabilities", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["enabled"], true);
    assert!(value.get("token").is_none());
    for path in [
        "/api/requests",
        "/api/requests/search?kind=movie&query=synthetic",
    ] {
        let (status, value) = call(&app, "GET", path, None, false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(value["error"]["code"], "unauthorized");
    }
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"movie","externalId":101})),
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(mock.state.lock().unwrap().calls, 0);
}

#[tokio::test]
async fn origin_host_and_duplicate_auth_headers_are_rejected_before_any_provider_read() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    for (host, origin) in [
        ("attacker.invalid:8787", None),
        (HOST, Some("https://attacker.invalid")),
        (HOST, Some("null")),
        (HOST, Some("http://127.0.0.1:9000")),
    ] {
        let mut request = axum::http::Request::builder()
            .uri("/api/requests")
            .header(header::HOST, host)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/requests")
                .header(header::HOST, HOST)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    // Native clients have no Origin; browser clients may use the exact origin.
    for origin in [None, Some(format!("http://{HOST}"))] {
        let mut request = axum::http::Request::builder()
            .uri("/api/requests")
            .header(header::HOST, HOST)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        assert_eq!(
            app.clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(mock.state.lock().unwrap().calls, 0);
}

#[tokio::test]
async fn invalid_input_is_bounded_and_never_forwarded() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    for path in [
        "/api/requests/search?kind=movie&query=x",
        "/api/requests/search?kind=unknown&query=synthetic",
        "/api/requests/search?kind=movie&query=two%0Awords",
        "/api/requests/search?kind=movie&query=synthetic&url=http://attacker.invalid",
    ] {
        assert_eq!(
            call(&app, "GET", path, None, true).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for body in [
        json!({"kind":"movie","externalId":0}),
        json!({"kind":"series","externalId":2147483648_u64}),
        json!({"kind":"movie","externalId":-1}),
        json!({"kind":"movie","externalId":101,"rootFolderPath":"arbitrary"}),
        json!({"kind":"movie","externalId":101,"title":"untrusted"}),
    ] {
        assert_eq!(
            call(&app, "POST", "/api/requests", Some(body), true)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(mock.state.lock().unwrap().calls, 0);
}

#[tokio::test]
async fn movie_search_create_duplicate_refresh_and_restart_are_cohesive() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    let (_, value) = call(
        &app,
        "GET",
        "/api/requests/search?kind=movie&query=synthetic",
        None,
        true,
    )
    .await;
    assert_eq!(value["items"][0]["status"], "not_requested");
    assert!(value["items"][0].get("requestId").is_none());
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(value["item"]["status"], "requested");
    assert_eq!(value["duplicate"], false);
    let created = value["item"]["createdAt"].clone();
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["duplicate"], true);
    assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
    mock.state.lock().unwrap().movies[0]["hasFile"] = true.into();
    let (_, value) = call(&app, "GET", "/api/requests", None, true).await;
    assert_eq!(value["items"][0]["status"], "available");
    assert_eq!(value["items"][0]["createdAt"], created);
    drop(app);
    let app = mock.app(temp.path());
    let (_, value) = call(&app, "GET", "/api/requests", None, true).await;
    assert_eq!(value["items"].as_array().unwrap().len(), 1);
    assert_eq!(value["items"][0]["status"], "available");
}

#[tokio::test]
async fn series_payload_monitoring_and_complete_status_use_server_policy() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"series","externalId":202})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(value["item"]["status"], "requested");
    mock.state.lock().unwrap().series[0]["statistics"] =
        json!({"episodeCount":4,"episodeFileCount":2});
    assert_eq!(
        call(&app, "GET", "/api/requests", None, true).await.1["items"][0]["status"],
        "requested"
    );
    mock.state.lock().unwrap().series[0]["statistics"] =
        json!({"episodeCount":4,"episodeFileCount":4});
    assert_eq!(
        call(&app, "GET", "/api/requests", None, true).await.1["items"][0]["status"],
        "available"
    );
}

#[tokio::test]
async fn provider_owned_titles_are_duplicates_without_outbound_post() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let mut existing = lookup("movie", 101);
    existing["hasFile"] = true.into();
    mock.state.lock().unwrap().movies.push(existing);
    let app = mock.app(temp.path());
    let (_, value) = call(
        &app,
        "GET",
        "/api/requests/search?kind=movie&query=synthetic",
        None,
        true,
    )
    .await;
    assert_eq!(value["items"][0]["status"], "available");
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["duplicate"], true);
    assert_eq!(value["item"]["status"], "available");
    assert!(mock.state.lock().unwrap().posts.is_empty());
}

#[tokio::test]
async fn concurrent_identical_submissions_send_one_provider_write() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    let body = json!({"kind":"movie","externalId":101});
    let (a, b) = tokio::join!(
        call(&app, "POST", "/api/requests", Some(body.clone()), true),
        call(&app, "POST", "/api/requests", Some(body), true)
    );
    assert_eq!(a.0, StatusCode::CREATED);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
}

#[tokio::test]
async fn separate_engines_atomically_reserve_the_same_identity_before_provider_write() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let first = mock.app(temp.path());
    let second = mock.app(temp.path());
    // Both engines must finish their absence checks and enter ID lookup before
    // either can reserve the request, reproducing the cross-process race.
    mock.state.lock().unwrap().lookup_barrier = Some(Arc::new(tokio::sync::Barrier::new(2)));
    let body = json!({"kind":"movie","externalId":101});
    let (a, b) = tokio::join!(
        call(&first, "POST", "/api/requests", Some(body.clone()), true),
        call(&second, "POST", "/api/requests", Some(body), true)
    );
    assert!([a.0, b.0].contains(&StatusCode::CREATED));
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
    let (_, history) = call(&second, "GET", "/api/requests", None, true).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["status"], "requested");
}

#[tokio::test]
async fn ambiguous_write_survives_restart_and_does_not_blindly_retry() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    mock.state.lock().unwrap().reply = Reply::Ambiguous;
    let app = mock.app(temp.path());
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(value["item"]["status"], "uncertain");
    mock.state.lock().unwrap().movies.clear();
    drop(app);
    let app = mock.app(temp.path());
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["duplicate"], true);
    assert_eq!(value["item"]["status"], "uncertain");
    assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
    mock.state.lock().unwrap().movies.push(lookup("movie", 101));
    assert_eq!(
        call(&app, "GET", "/api/requests", None, true).await.1["items"][0]["status"],
        "requested"
    );
}

#[tokio::test]
async fn timeout_is_persisted_and_reconciled_without_an_automatic_post_retry() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    mock.state.lock().unwrap().reply = Reply::Timeout;
    let app = mock.app(temp.path());
    let (status, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(value["item"]["status"], "uncertain");
    assert_eq!(
        call(&app, "GET", "/api/requests", None, true).await.1["items"][0]["status"],
        "requested"
    );
    assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
}

#[tokio::test]
async fn rejection_and_racing_provider_duplicate_have_safe_saved_outcomes() {
    for (reply, expected) in [
        (Reply::Rejected, "failed"),
        (Reply::DuplicateRace, "requested"),
    ] {
        let mock = Mock::start().await;
        let temp = tempfile::tempdir().unwrap();
        mock.state.lock().unwrap().reply = reply;
        let app = mock.app(temp.path());
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/requests",
                Some(json!({"kind":"movie","externalId":101})),
                true
            )
            .await
            .1["item"]["status"],
            expected
        );
        let (_, value) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"movie","externalId":101})),
            true,
        )
        .await;
        assert_eq!(value["duplicate"], true);
        assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
    }
}

#[tokio::test]
async fn upstream_failures_are_sanitized_bounded_and_preserve_history() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    mock.state.lock().unwrap().unavailable = true;
    let (_, value) = call(&app, "GET", "/api/requests", None, true).await;
    assert_eq!(value["refreshIncomplete"], true);
    assert_eq!(value["items"][0]["status"], "requested");
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/requests/search?kind=movie&query=synthetic",
            None,
            true
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    {
        let mut fixture = mock.state.lock().unwrap();
        fixture.unavailable = false;
        fixture.oversized = true;
    }
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/requests/search?kind=movie&query=synthetic",
            None,
            true
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
}

#[tokio::test]
async fn redirects_cannot_forward_provider_secrets() {
    let mock = Mock::start().await;
    let other = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    mock.state.lock().unwrap().redirect = Some(format!("{}api/v3/movie", other.url));
    let app = mock.app(temp.path());
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/requests/search?kind=movie&query=synthetic",
            None,
            true
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(other.state.lock().unwrap().calls, 0);
}

#[test]
fn provider_configuration_rejects_secret_urls_and_invalid_policy() {
    for url in [
        "ftp://localhost/",
        "http://user:password@localhost/",
        "http://localhost/?apiKey=secret",
        "http://localhost/#fragment",
    ] {
        assert!(ProviderConfig::new(url, KEY.into(), "/synthetic/movies".into(), 3).is_err());
    }
    assert!(ProviderConfig::new("http://localhost/", KEY.into(), "".into(), 3).is_err());
    assert!(
        ProviderConfig::new(
            "http://localhost/",
            KEY.into(),
            "/synthetic/movies".into(),
            0
        )
        .is_err()
    );
    let temp = tempfile::tempdir().unwrap();
    assert!(
        Engine::new(
            temp.path(),
            Config {
                token: "short".into(),
                radarr: None,
                sonarr: None
            }
        )
        .is_err()
    );
}

#[tokio::test]
async fn merged_router_preserves_global_cross_site_protection_for_requests() {
    let temp = tempfile::tempdir().unwrap();
    let media = temp.path().join("empty-media");
    std::fs::create_dir(&media).unwrap();
    let library = shinema_server::Library::open(&media, &temp.path().join("state")).unwrap();
    let app =
        shinema_server::router_at_with_requests(library, HOST.parse().unwrap(), Engine::disabled());
    for (fetch_site, expected) in [
        (None, StatusCode::OK),
        (Some("cross-site"), StatusCode::FORBIDDEN),
    ] {
        let mut request = axum::http::Request::builder()
            .uri("/api/requests/capabilities")
            .header(header::HOST, HOST);
        if let Some(fetch_site) = fetch_site {
            request = request.header("Sec-Fetch-Site", fetch_site);
        }
        // Omit Origin deliberately: this must be caught by the global guard,
        // applied after router merge, rather than the request-local Origin gate.
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}

#[tokio::test]
async fn request_state_migrates_without_losing_an_uncertain_identity() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    {
        let db = rusqlite::Connection::open(temp.path().join("requests.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, external_id INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message TEXT, UNIQUE(kind,external_id)); INSERT INTO requests VALUES('movie-101','movie',101,'Synthetic fixture',2025,'uncertain',100,100,NULL);").unwrap();
    }
    let app = mock.app(temp.path());
    let (_, value) = call(
        &app,
        "POST",
        "/api/requests",
        Some(json!({"kind":"movie","externalId":101})),
        true,
    )
    .await;
    assert_eq!(value["duplicate"], true);
    assert_eq!(value["item"]["status"], "uncertain");
    assert!(mock.state.lock().unwrap().posts.is_empty());
}
