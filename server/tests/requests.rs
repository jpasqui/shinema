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
// Official release contracts pinned for this adapter, not installed providers:
// v4.0.20.3014 cab419ade8ac7fcab5bf80394ee492abd35d5f5a
// v5.0.0.2635 a2b6054a8f3746d149a811bddea2a8d063efc35e
const SONARR_STABLE: &str = "4.0.20.3014";
const SONARR_BETA: &str = "5.0.0.2635";

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
    series_lookup_override: Option<Value>,
    sonarr_status_override: Option<Value>,
    sonarr_status_http_error: Option<StatusCode>,
    sonarr_status_non_json: bool,
    paths: Vec<String>,
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
        json!({"tvdbId":id,"title":format!("Synthetic Series {id}"),"year":2024,"overview":"Generated fixture; no real media.","titleSlug":format!("synthetic-series-{id}"),"seriesType":"standard","seasons":[{"seasonNumber":0},{"seasonNumber":1}]})
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
        fixture.paths.push(if query.is_empty() {
            path.clone()
        } else {
            format!("{path}?{query}")
        });
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
        if path == "/fixture/api/v3/system/status" {
            assert_eq!(method, Method::GET);
            if let Some(status) = fixture.sonarr_status_http_error {
                return (status, "private provider status error").into_response();
            }
            if fixture.sonarr_status_non_json {
                return (StatusCode::OK, "private provider malformed status").into_response();
            }
            return Json(
                fixture
                    .sonarr_status_override
                    .clone()
                    .unwrap_or_else(|| sonarr_status(SONARR_STABLE)),
            )
            .into_response();
        }
        let kind = if path.starts_with("/fixture/api/v3/movie") {
            "movie"
        } else if path.starts_with("/fixture/api/v3/series")
            || path.starts_with("/fixture/api/v5/series")
        {
            "series"
        } else {
            panic!("Unexpected provider path {path}");
        };
        let api = if kind == "series"
            && fixture
                .sonarr_status_override
                .as_ref()
                .and_then(|value| value.get("version"))
                .and_then(Value::as_str)
                .is_some_and(|version| version.starts_with("5."))
        {
            "v5"
        } else {
            "v3"
        };
        assert!(
            path.starts_with(&format!("/fixture/api/{api}/{kind}")),
            "Adapter used the wrong negotiated API: {path}"
        );
        if path.ends_with("/lookup") {
            assert_eq!(method, Method::GET);
            let query = reqwest::Url::parse(&format!("http://fixture.invalid/?{query}")).unwrap();
            let term = query
                .query_pairs()
                .find(|(key, _)| key == "term")
                .unwrap()
                .1
                .into_owned();
            let language = query
                .query_pairs()
                .find(|(key, _)| key == "language")
                .map(|(_, value)| value.into_owned());
            if kind == "series" && api == "v5" {
                assert_eq!(language.as_deref(), Some("1"));
            } else {
                assert!(
                    language.is_none(),
                    "Stable/Radarr lookup policy must remain unchanged"
                );
            }
            if term == "nothing" {
                return Json(json!([])).into_response();
            }
            let id = term
                .split_once(':')
                .and_then(|(_, value)| value.parse().ok())
                .unwrap_or(101);
            let result = if kind == "series" {
                fixture
                    .series_lookup_override
                    .clone()
                    .unwrap_or_else(|| lookup(kind, id))
            } else {
                lookup(kind, id)
            };
            return Json(json!([result])).into_response();
        }
        assert!(path == format!("/fixture/api/{api}/{kind}"));
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
            if api == "v5" {
                assert_eq!(payload["language"], json!({"id":1,"name":"English"}));
                assert_eq!(payload["seasonType"], "official");
            } else {
                assert!(payload.get("language").is_none());
                assert!(payload.get("seasonType").is_none());
            }
            let expected_type = fixture
                .series_lookup_override
                .as_ref()
                .and_then(|value| value.get("seriesType"))
                .cloned()
                .unwrap_or_else(|| json!("standard"));
            assert_eq!(payload["seriesType"], expected_type);
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
fn sonarr_status(version: &str) -> Value {
    json!({"appName":"Sonarr","version":version,"instanceName":"private provider instance","startupPath":"/synthetic/private/startup","appData":"/synthetic/private/state","urlBase":"/fixture","branch":"private provider branch"})
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
        "/api/requests/sonarr",
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
async fn verified_sonarr_series_type_is_preserved_for_every_supported_type() {
    for version in [SONARR_STABLE, SONARR_BETA] {
        for series_type in ["standard", "daily", "anime"] {
            let mock = Mock::start().await;
            let temp = tempfile::tempdir().unwrap();
            let mut verified = lookup("series", 202);
            verified["seriesType"] = series_type.into();
            mock.state.lock().unwrap().series_lookup_override = Some(verified);
            mock.state.lock().unwrap().sonarr_status_override = Some(sonarr_status(version));
            let app = mock.app(temp.path());
            let (status, value) = call(
                &app,
                "POST",
                "/api/requests",
                Some(json!({"kind":"series","externalId":202})),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "series type {series_type}");
            assert_eq!(value["item"]["status"], "requested");
            let fixture = mock.state.lock().unwrap();
            assert_eq!(fixture.posts.len(), 1);
            assert_eq!(fixture.posts[0]["seriesType"], series_type);
        }
    }
}

#[tokio::test]
async fn sonarr_status_and_requests_negotiate_pinned_stable_and_beta_contracts() {
    for (version, api, preview) in [(SONARR_STABLE, "v3", false), (SONARR_BETA, "v5", true)] {
        let mock = Mock::start().await;
        let temp = tempfile::tempdir().unwrap();
        mock.state.lock().unwrap().sonarr_status_override = Some(sonarr_status(version));
        let app = mock.app(temp.path());
        let (status, compatibility) = call(&app, "GET", "/api/requests/sonarr", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(compatibility["apiVersion"], 1);
        assert_eq!(compatibility["enabled"], true);
        assert_eq!(compatibility["status"], "ready");
        assert_eq!(compatibility["version"], version);
        assert_eq!(compatibility["apiVersionPath"], api);
        assert_eq!(compatibility["preview"], preview);
        if preview {
            assert_eq!(compatibility["metadataLanguage"], "English");
            assert_eq!(compatibility["episodeOrder"], "Official");
        } else {
            assert!(compatibility.get("metadataLanguage").is_none());
            assert!(compatibility.get("episodeOrder").is_none());
        }
        mock.state.lock().unwrap().paths.clear();
        let (status, search) = call(
            &app,
            "GET",
            "/api/requests/search?kind=series&query=synthetic",
            None,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(search["items"][0]["status"], "not_requested");
        {
            let fixture = mock.state.lock().unwrap();
            assert_eq!(
                fixture
                    .paths
                    .iter()
                    .filter(|path| path.ends_with("/api/v3/system/status"))
                    .count(),
                1
            );
            assert!(
                fixture
                    .paths
                    .contains(&format!("/fixture/api/{api}/series"))
            );
            let expected_lookup = format!(
                "/fixture/api/{api}/series/lookup?term=synthetic{}",
                if preview { "&language=1" } else { "" }
            );
            assert!(fixture.paths.contains(&expected_lookup));
            assert_eq!(fixture.paths.len(), 3);
        }
        mock.state.lock().unwrap().paths.clear();
        let (status, result) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(result["item"]["status"], "requested");
        {
            let fixture = mock.state.lock().unwrap();
            assert_eq!(fixture.posts.len(), 1);
            assert_eq!(
                fixture
                    .paths
                    .iter()
                    .filter(|path| path.ends_with("/api/v3/system/status"))
                    .count(),
                1
            );
            assert_eq!(fixture.paths.len(), 4);
        }
        mock.state.lock().unwrap().paths.clear();
        let (_, history) = call(&app, "GET", "/api/requests", None, true).await;
        assert_eq!(history["items"][0]["status"], "requested");
        assert_eq!(
            mock.state.lock().unwrap().paths,
            vec![
                "/fixture/api/v3/system/status".to_string(),
                format!("/fixture/api/{api}/series")
            ]
        );
    }
}

#[tokio::test]
async fn unsupported_or_malformed_sonarr_versions_never_reserve_or_post() {
    let mut cases = Vec::new();
    for version in [
        "3.0.0.0",
        "6.0.0.0",
        "5.0.0",
        "5.0.0.2635-beta",
        "5..0.2635",
        "05.0.0.2635",
        "5.0.0.2147483648",
        "5.0.0.0\n",
        KEY,
    ] {
        cases.push(sonarr_status(version));
    }
    cases.extend([
        json!({"appName":"Sonarr"}),
        json!({"appName":"Sonarr","version":null}),
        json!({"appName":"Sonarr","version":5}),
        json!({"appName":"Radarr","version":SONARR_BETA}),
        json!({"version":SONARR_BETA}),
        json!([]),
    ]);
    for provider_status in cases {
        let mock = Mock::start().await;
        let temp = tempfile::tempdir().unwrap();
        mock.state.lock().unwrap().sonarr_status_override = Some(provider_status);
        let app = mock.app(temp.path());
        let (status, compatibility) = call(&app, "GET", "/api/requests/sonarr", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(compatibility["enabled"], true);
        assert_eq!(compatibility["status"], "unsupported");
        assert_eq!(compatibility["preview"], false);
        for field in ["apiVersionPath", "metadataLanguage", "episodeOrder"] {
            assert!(compatibility.get(field).is_none());
        }
        let (status, error) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(error["error"]["code"], "provider_unavailable");
        assert_eq!(
            call(
                &app,
                "GET",
                "/api/requests/search?kind=series&query=synthetic",
                None,
                true
            )
            .await
            .0,
            StatusCode::BAD_GATEWAY
        );
        let (_, history) = call(&app, "GET", "/api/requests", None, true).await;
        assert!(history["items"].as_array().unwrap().is_empty());
        {
            let fixture = mock.state.lock().unwrap();
            assert!(fixture.posts.is_empty());
            assert!(
                fixture
                    .paths
                    .iter()
                    .all(|path| path == "/fixture/api/v3/system/status")
            );
        }
        mock.state.lock().unwrap().sonarr_status_override = Some(sonarr_status(SONARR_STABLE));
        let (status, value) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(value["duplicate"], false);
    }
}

#[tokio::test]
async fn sonarr_handshake_http_or_json_failures_are_sanitized_and_never_write() {
    for http_error in [
        Some(StatusCode::UNAUTHORIZED),
        Some(StatusCode::SERVICE_UNAVAILABLE),
        None,
    ] {
        let mock = Mock::start().await;
        let temp = tempfile::tempdir().unwrap();
        {
            let mut fixture = mock.state.lock().unwrap();
            fixture.sonarr_status_http_error = http_error;
            fixture.sonarr_status_non_json = http_error.is_none();
        }
        let app = mock.app(temp.path());
        let (status, compatibility) = call(&app, "GET", "/api/requests/sonarr", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            compatibility,
            json!({"apiVersion":1,"enabled":true,"status":"unavailable","preview":false})
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/requests",
                Some(json!({"kind":"series","externalId":202})),
                true
            )
            .await
            .0,
            StatusCode::BAD_GATEWAY
        );
        assert!(mock.state.lock().unwrap().posts.is_empty());
        assert!(
            call(&app, "GET", "/api/requests", None, true).await.1["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test]
async fn sonarr_api_selection_rechecks_version_on_the_next_operation() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let app = mock.app(temp.path());
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/requests/search?kind=series&query=synthetic",
            None,
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    {
        let mut fixture = mock.state.lock().unwrap();
        assert!(
            fixture
                .paths
                .iter()
                .any(|path| path.starts_with("/fixture/api/v3/series/lookup"))
        );
        fixture.sonarr_status_override = Some(sonarr_status(SONARR_BETA));
        fixture.paths.clear();
    }
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/requests/search?kind=series&query=synthetic",
            None,
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        mock.state
            .lock()
            .unwrap()
            .paths
            .iter()
            .any(|path| path.starts_with("/fixture/api/v5/series/lookup"))
    );
}

#[tokio::test]
async fn sonarr_beta_uses_explicit_defaults_instead_of_inferred_lookup_metadata() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let mut lookup = lookup("series", 202);
    lookup["language"] = json!({"id":2,"name":"French"});
    lookup["seasonType"] = "dvd".into();
    {
        let mut fixture = mock.state.lock().unwrap();
        fixture.sonarr_status_override = Some(sonarr_status(SONARR_BETA));
        fixture.series_lookup_override = Some(lookup);
    }
    let app = mock.app(temp.path());
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let fixture = mock.state.lock().unwrap();
    assert_eq!(
        fixture.posts[0]["language"],
        json!({"id":1,"name":"English"})
    );
    assert_eq!(fixture.posts[0]["seasonType"], "official");
}

#[tokio::test]
async fn preexisting_sonarr_titles_are_duplicates_on_stable_and_beta_without_updates() {
    for version in [SONARR_STABLE, SONARR_BETA] {
        let mock = Mock::start().await;
        let temp = tempfile::tempdir().unwrap();
        let mut existing = lookup("series", 202);
        existing["statistics"] = json!({"episodeCount":4,"episodeFileCount":4});
        {
            let mut fixture = mock.state.lock().unwrap();
            fixture.sonarr_status_override = Some(sonarr_status(version));
            fixture.series.push(existing);
        }
        let app = mock.app(temp.path());
        let (status, value) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["duplicate"], true);
        assert_eq!(value["item"]["status"], "available");
        assert!(mock.state.lock().unwrap().posts.is_empty());
    }
}

#[tokio::test]
async fn sonarr_beta_ambiguous_write_reconciles_with_v5_without_reposting() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    {
        let mut fixture = mock.state.lock().unwrap();
        fixture.sonarr_status_override = Some(sonarr_status(SONARR_BETA));
        fixture.reply = Reply::Ambiguous;
    }
    let app = mock.app(temp.path());
    let body = json!({"kind":"series","externalId":202});
    let (status, value) = call(&app, "POST", "/api/requests", Some(body.clone()), true).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(value["item"]["status"], "uncertain");
    let (status, value) = call(&app, "POST", "/api/requests", Some(body), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["duplicate"], true);
    assert_eq!(value["item"]["status"], "requested");
    let fixture = mock.state.lock().unwrap();
    assert_eq!(fixture.posts.len(), 1);
    assert!(
        !fixture
            .paths
            .iter()
            .any(|path| path.starts_with("/fixture/api/v3/series"))
    );
}

#[tokio::test]
async fn radarr_does_not_probe_or_depend_on_sonarr_compatibility() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    mock.state.lock().unwrap().sonarr_status_override = Some(sonarr_status("6.0.0.0"));
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
        .0,
        StatusCode::CREATED
    );
    assert!(
        mock.state
            .lock()
            .unwrap()
            .paths
            .iter()
            .all(|path| path.starts_with("/fixture/api/v3/movie"))
    );
}

#[tokio::test]
async fn disabled_sonarr_status_is_authenticated_and_never_calls_a_provider() {
    let mock = Mock::start().await;
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(
        temp.path(),
        Config {
            token: TOKEN.into(),
            radarr: Some(
                ProviderConfig::new(&mock.url, KEY.into(), "/synthetic/movies".into(), 3).unwrap(),
            ),
            sonarr: None,
        },
    )
    .unwrap();
    let app = requests::router(engine, HOST.parse().unwrap());
    assert_eq!(
        call(&app, "GET", "/api/requests/sonarr", None, false)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, value) = call(&app, "GET", "/api/requests/sonarr", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        value,
        json!({"apiVersion":1,"enabled":false,"status":"disabled","preview":false})
    );
    assert_eq!(mock.state.lock().unwrap().calls, 0);
}

#[tokio::test]
async fn invalid_sonarr_series_type_fails_before_reservation_or_provider_write() {
    for (case, series_type) in [
        ("missing", None),
        ("null", Some(Value::Null)),
        ("boolean", Some(json!(true))),
        ("number", Some(json!(123))),
        ("array", Some(json!(["standard"]))),
        ("object", Some(json!({"type":"standard"}))),
        ("unknown", Some(json!("unknown-series-type"))),
        ("wrong case", Some(json!("Standard"))),
        ("empty", Some(json!(""))),
        ("whitespace", Some(json!("anime "))),
    ] {
        let mock = Mock::start().await;
        let temp = tempfile::tempdir().unwrap();
        let mut verified = lookup("series", 202);
        if let Some(series_type) = series_type {
            verified["seriesType"] = series_type;
        } else {
            verified.as_object_mut().unwrap().remove("seriesType");
        }
        mock.state.lock().unwrap().series_lookup_override = Some(verified);
        let app = mock.app(temp.path());
        let (status, value) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "series type {case}");
        assert_eq!(value["error"]["code"], "provider_unavailable");
        assert_eq!(
            value["error"]["message"],
            "The request provider could not be reached or returned an invalid response. Try again later."
        );
        assert!(
            mock.state.lock().unwrap().posts.is_empty(),
            "series type {case}"
        );
        let (status, history) = call(&app, "GET", "/api/requests", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            history["items"].as_array().unwrap().is_empty(),
            "series type {case}"
        );
        // A corrected provider lookup must remain submit-able for the same ID;
        // invalid metadata must not leave a hidden duplicate reservation.
        mock.state.lock().unwrap().series_lookup_override = Some(lookup("series", 202));
        let (status, value) = call(
            &app,
            "POST",
            "/api/requests",
            Some(json!({"kind":"series","externalId":202})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "corrected series type {case}");
        assert_eq!(value["duplicate"], false);
        assert_eq!(mock.state.lock().unwrap().posts.len(), 1);
    }
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
