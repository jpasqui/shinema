//! Opt-in, operator-scoped Radarr/Sonarr requests. No provider configuration is
//! accepted over HTTP, and no provider credential or raw error crosses the API.
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use reqwest::{Client, Url};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fmt,
    net::SocketAddr,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_PROVIDER_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUESTS: usize = 500;
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Movie,
    Series,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
    fn id_key(self) -> &'static str {
        match self {
            Self::Movie => "tmdbId",
            Self::Series => "tvdbId",
        }
    }
    fn lookup_prefix(self) -> &'static str {
        match self {
            Self::Movie => "tmdb",
            Self::Series => "tvdb",
        }
    }
}

/// Deliberately has no Debug implementation: fields contain secrets.
pub struct ProviderConfig {
    base_url: Url,
    api_key: String,
    root_folder: String,
    quality_profile_id: u32,
}

#[derive(Debug)]
pub struct ConfigError(&'static str);
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ConfigError {}

impl ProviderConfig {
    pub fn new(
        base_url: &str,
        api_key: String,
        root_folder: String,
        quality_profile_id: u32,
    ) -> Result<Self, ConfigError> {
        let mut base_url =
            Url::parse(base_url).map_err(|_| ConfigError("Invalid request provider URL"))?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(ConfigError(
                "Request provider URL must be HTTP(S), without user info, query, or fragment",
            ));
        }
        if api_key.len() < 16
            || api_key.len() > 512
            || !api_key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(ConfigError("Invalid request provider API key"));
        }
        if root_folder.trim().is_empty()
            || root_folder.len() > 1024
            || root_folder.chars().any(char::is_control)
            || quality_profile_id == 0
            || quality_profile_id > i32::MAX as u32
        {
            return Err(ConfigError(
                "Request provider requires a root folder and positive quality profile ID",
            ));
        }
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }
        Ok(Self {
            base_url,
            api_key,
            root_folder,
            quality_profile_id,
        })
    }
}

/// One shared operator token, not an account, user, approval, or quota system.
pub struct Config {
    pub token: String,
    pub radarr: Option<ProviderConfig>,
    pub sonarr: Option<ProviderConfig>,
}

pub struct Engine {
    config: Option<Config>,
    database: Option<Mutex<Connection>>,
    client: Client,
    writes: tokio::sync::Mutex<()>,
    operations: tokio::sync::Semaphore,
}

impl Engine {
    pub fn disabled() -> Arc<Self> {
        Arc::new(Self {
            config: None,
            database: None,
            client: Client::new(),
            writes: tokio::sync::Mutex::new(()),
            operations: tokio::sync::Semaphore::new(4),
        })
    }

    pub fn from_env(state_dir: &Path) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let token = optional_env("SHINEMA_REQUEST_TOKEN")?;
        let radarr = provider_env("SHINEMA_RADARR")?;
        let sonarr = provider_env("SHINEMA_SONARR")?;
        match (token, radarr, sonarr) {
            (None, None, None) => Ok(Self::disabled()),
            (Some(token), radarr, sonarr) if radarr.is_some() || sonarr.is_some() => Self::new(state_dir, Config { token, radarr, sonarr }),
            _ => Err(ConfigError("Requests require an operator token and at least one complete provider configuration").into()),
        }
    }

    pub fn new(state_dir: &Path, config: Config) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        if !(32..=512).contains(&config.token.len())
            || !config.token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(ConfigError("Request operator token must contain 32 to 512 printable non-space ASCII characters").into());
        }
        if config.radarr.is_none() && config.sonarr.is_none() {
            return Err(ConfigError("Requests require a configured provider").into());
        }
        crate::state_files::create_private_directory(state_dir)?;
        validate_state(state_dir)?;
        let db = Connection::open_with_flags(
            state_dir.join("requests.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        validate_state(state_dir)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, external_id INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message TEXT, revision INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,external_id));")?;
        let has_revision: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('requests') WHERE name='revision')",
            [],
            |row| row.get(0),
        )?;
        if !has_revision {
            db.execute(
                "ALTER TABLE requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let client = Client::builder()
            .timeout(PROVIDER_TIMEOUT)
            .connect_timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .map_err(|_| ConfigError("Could not create request provider client"))?;
        Ok(Arc::new(Self {
            config: Some(config),
            database: Some(Mutex::new(db)),
            client,
            writes: tokio::sync::Mutex::new(()),
            operations: tokio::sync::Semaphore::new(4),
        }))
    }

    fn provider(&self, kind: Kind) -> Result<&ProviderConfig, ApiError> {
        let config = self.config.as_ref().ok_or_else(ApiError::disabled)?;
        match kind {
            Kind::Movie => &config.radarr,
            Kind::Series => &config.sonarr,
        }
        .as_ref()
        .ok_or(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_disabled",
            "This request provider is not enabled.",
        ))
    }
    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>, ApiError> {
        self.database
            .as_ref()
            .ok_or_else(ApiError::disabled)?
            .lock()
            .map_err(|_| ApiError::internal())
    }
    fn saved(&self, kind: Kind, external_id: u32) -> Result<Option<RequestRecord>, ApiError> {
        self.db()?.query_row("SELECT id,kind,external_id,title,year,status,created_at,updated_at,message,revision FROM requests WHERE kind=?1 AND external_id=?2", params![kind.key(), external_id], row_record).optional().map_err(|_| ApiError::internal())
    }
    fn records(&self) -> Result<Vec<RequestRecord>, ApiError> {
        let db = self.db()?;
        let mut query = db.prepare("SELECT id,kind,external_id,title,year,status,created_at,updated_at,message,revision FROM requests ORDER BY created_at DESC,id LIMIT 500").map_err(|_| ApiError::internal())?;
        query
            .query_map([], row_record)
            .map_err(|_| ApiError::internal())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ApiError::internal())
    }
    // SQLite, rather than a process-local mutex, chooses the only writer allowed
    // to submit this identity. A second Engine/process cannot overwrite its claim.
    fn insert(&self, record: &RequestRecord) -> Result<bool, ApiError> {
        self.db()?.execute("INSERT INTO requests(id,kind,external_id,title,year,status,created_at,updated_at,message) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE (SELECT COUNT(*) FROM requests)<500 ON CONFLICT(kind,external_id) DO NOTHING", params![record.id, record.kind.key(), record.external_id, record.title, record.year, record.status, record.created_at, record.updated_at, record.message]).map(|count| count == 1).map_err(|_| ApiError::internal())
    }
    // A status read before an HTTP call may be stale when that call completes.
    // Compare-and-swap prevents it from replacing a newer observed transition.
    fn update(&self, record: &RequestRecord, expected_status: &str) -> Result<(), ApiError> {
        self.db()?.execute("UPDATE requests SET status=?1,updated_at=?2,message=?3,revision=revision+1 WHERE kind=?4 AND external_id=?5 AND status=?6 AND revision=?7", params![record.status, record.updated_at, record.message, record.kind.key(), record.external_id, expected_status, record.revision]).map_err(|_| ApiError::internal())?;
        Ok(())
    }
    fn latest(&self, record: &RequestRecord) -> Result<RequestRecord, ApiError> {
        self.saved(record.kind, record.external_id)?
            .ok_or_else(ApiError::busy)
    }
    fn url(&self, kind: Kind, suffix: &str) -> Result<Url, ApiError> {
        self.provider(kind)?
            .base_url
            .join(&format!("api/v3/{}{suffix}", kind.key()))
            .map_err(|_| ApiError::internal())
    }
    async fn get(&self, kind: Kind, suffix: &str, term: Option<&str>) -> Result<Value, ApiError> {
        let mut url = self.url(kind, suffix)?;
        if let Some(term) = term {
            url.query_pairs_mut().append_pair("term", term);
        }
        let response = self
            .client
            .get(url)
            .header("X-Api-Key", &self.provider(kind)?.api_key)
            .send()
            .await
            .map_err(|_| ApiError::provider())?;
        if !response.status().is_success() {
            return Err(ApiError::provider());
        }
        read_json(response).await
    }
    async fn catalog(&self, kind: Kind) -> Result<Vec<Value>, ApiError> {
        let value = self.get(kind, "", None).await?;
        value
            .as_array()
            .filter(|items| items.len() <= 10000)
            .cloned()
            .ok_or_else(ApiError::provider)
    }
}

fn optional_env(name: &str) -> Result<Option<String>, ConfigError> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) => Err(ConfigError(
            "Request configuration values must not be empty",
        )),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(ConfigError("Request configuration values must be Unicode")),
    }
}
fn provider_env(prefix: &str) -> Result<Option<ProviderConfig>, ConfigError> {
    let url = optional_env(&format!("{prefix}_URL"))?;
    let key = optional_env(&format!("{prefix}_API_KEY"))?;
    let root = optional_env(&format!("{prefix}_ROOT_FOLDER"))?;
    let profile = optional_env(&format!("{prefix}_QUALITY_PROFILE_ID"))?;
    match (url, key, root, profile) {
        (None, None, None, None) => Ok(None),
        (Some(url), Some(key), Some(root), Some(profile)) => ProviderConfig::new(
            &url,
            key,
            root,
            profile
                .parse()
                .map_err(|_| ConfigError("Request quality profile must be a positive integer"))?,
        )
        .map(Some),
        _ => Err(ConfigError("Request provider configuration is incomplete")),
    }
}
fn validate_state(directory: &Path) -> std::io::Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        match crate::state_files::validate_file(
            &directory.join(format!("requests.sqlite3{suffix}")),
        ) {
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub id: String,
    pub kind: Kind,
    pub external_id: u32,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    pub status: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip)]
    revision: u64,
}
fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<RequestRecord> {
    let kind: String = row.get(1)?;
    Ok(RequestRecord {
        id: row.get(0)?,
        kind: if kind == "movie" {
            Kind::Movie
        } else {
            Kind::Series
        },
        external_id: row.get(2)?,
        title: row.get(3)?,
        year: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        message: row.get(8)?,
        revision: row.get(9)?,
    })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str, &'static str);
impl ApiError {
    fn disabled() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "disabled",
            "Requests are not enabled. Ask the server operator about setup.",
        )
    }
    fn internal() -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The request could not be saved. Try again later.",
        )
    }
    fn invalid() -> Self {
        Self(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Choose a movie or series and provide a valid search or external ID.",
        )
    }
    fn provider() -> Self {
        Self(
            StatusCode::BAD_GATEWAY,
            "provider_unavailable",
            "The request provider could not be reached or returned an invalid response. Try again later.",
        )
    }
    fn busy() -> Self {
        Self(
            StatusCode::TOO_MANY_REQUESTS,
            "request_limit",
            "Too many request operations. Try again shortly.",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":self.2}})),
        )
            .into_response()
    }
}

#[derive(Clone)]
struct RouteState {
    engine: Arc<Engine>,
    authority: String,
    origin: String,
}

/// Merge this fully resolved router after the library router's `.with_state`.
pub fn router(engine: Arc<Engine>, bind: SocketAddr) -> Router {
    let authority = bind.to_string();
    let state = RouteState {
        engine,
        origin: format!("http://{authority}"),
        authority,
    };
    Router::new()
        .route("/api/requests/capabilities", get(capabilities))
        .route("/api/requests", get(list).post(create))
        .route("/api/requests/search", get(search))
        .layer(DefaultBodyLimit::max(1024))
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state)
}

async fn boundary(
    State(state): State<RouteState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let checked = check_boundary(&state, request.headers(), request.uri().path());
    let mut response = match checked {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        "X-Content-Type-Options",
        header::HeaderValue::from_static("nosniff"),
    );
    response
}
fn check_boundary(state: &RouteState, headers: &HeaderMap, path: &str) -> Result<(), ApiError> {
    // Restrict this feature to the loopback authority selected by the server.
    // Native clients may omit Origin; all data operations still need a token.
    let hosts = headers.get_all(header::HOST).iter().collect::<Vec<_>>();
    if hosts.len() != 1 || hosts[0].to_str().ok() != Some(state.authority.as_str()) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "This request must use the configured server address.",
        ));
    }
    let origins = headers.get_all(header::ORIGIN).iter().collect::<Vec<_>>();
    if origins.len() > 1
        || origins
            .first()
            .is_some_and(|origin| origin.to_str().ok() != Some(state.origin.as_str()))
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "Cross-origin requests are not allowed.",
        ));
    }
    if path != "/api/requests/capabilities" {
        authorize(&state.engine, headers)?;
    }
    Ok(())
}
fn authorize(engine: &Engine, headers: &HeaderMap) -> Result<(), ApiError> {
    let config = engine.config.as_ref().ok_or_else(ApiError::disabled)?;
    let values = headers
        .get_all(header::AUTHORIZATION)
        .iter()
        .collect::<Vec<_>>();
    let given = if values.len() == 1 {
        values[0]
            .to_str()
            .ok()
            .and_then(|s| s.strip_prefix("Bearer "))
    } else {
        None
    };
    let matches = given.is_some_and(|given| {
        let mut difference = given.len() ^ config.token.len();
        for (a, b) in given.bytes().zip(config.token.bytes()) {
            difference |= (a ^ b) as usize;
        }
        difference == 0
    });
    if matches {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Enter the server operator request token to continue.",
        ))
    }
}
async fn capabilities(State(state): State<RouteState>) -> Json<Value> {
    Json(
        json!({"apiVersion":1,"enabled":state.engine.config.is_some(),"authentication":"bearer","providers":[{"kind":"movie","enabled":state.engine.provider(Kind::Movie).is_ok()},{"kind":"series","enabled":state.engine.provider(Kind::Series).is_ok()}]}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    kind: Kind,
    query: String,
}

async fn search(
    State(state): State<RouteState>,
    query: Result<Query<Search>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let Query(query) = query.map_err(|_| ApiError::invalid())?;
    let text = query.query.trim();
    if !(2..=100).contains(&text.chars().count()) || text.chars().any(char::is_control) {
        return Err(ApiError::invalid());
    }
    let engine = &state.engine;
    engine.provider(query.kind)?;
    let _permit = engine
        .operations
        .try_acquire()
        .map_err(|_| ApiError::busy())?;
    // Upstream catalog is authoritative, including entries added outside Shinema.
    let catalog = engine.catalog(query.kind).await?;
    let lookup = engine.get(query.kind, "/lookup", Some(text)).await?;
    let items = lookup
        .as_array()
        .filter(|items| items.len() <= 1000)
        .ok_or_else(ApiError::provider)?;
    let mut output = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for value in items.iter().take(50) {
        let Some(external_id) = external_id(value, query.kind) else {
            continue;
        };
        if !seen.insert(external_id) {
            continue;
        }
        let Some(title) = title(value) else { continue };
        let saved = engine.saved(query.kind, external_id)?;
        let existing = catalog
            .iter()
            .find(|item| external_id_of(item, query.kind) == Some(external_id));
        let status = existing
            .map(|item| provider_status(item, query.kind))
            .unwrap_or_else(|| {
                saved
                    .as_ref()
                    .map(|item| item.status.as_str())
                    .unwrap_or("not_requested")
            });
        let mut item = json!({"kind":query.kind,"externalId":external_id,"title":title,"overview":safe_text(value.get("overview").and_then(Value::as_str).unwrap_or(""), 1200),"status":status});
        if let Some(year) = year(value) {
            item["year"] = year.into();
        }
        if let Some(saved) = saved {
            item["requestId"] = saved.id.into();
        }
        output.push(item);
    }
    Ok(Json(json!({"apiVersion":1,"items":output})))
}

async fn list(State(state): State<RouteState>) -> Result<Json<Value>, ApiError> {
    let engine = &state.engine;
    let _permit = engine
        .operations
        .try_acquire()
        .map_err(|_| ApiError::busy())?;
    // Serialize refresh with POST so a late refresh cannot overwrite confirmation.
    let _write = engine.writes.lock().await;
    let mut records = engine.records()?;
    let mut incomplete = false;
    for kind in [Kind::Movie, Kind::Series] {
        if !records.iter().any(|item| item.kind == kind) {
            continue;
        }
        match engine.catalog(kind).await {
            Ok(catalog) => {
                for record in records.iter_mut().filter(|item| item.kind == kind) {
                    let previous_status = record.status.clone();
                    if let Some(value) = catalog
                        .iter()
                        .find(|item| external_id_of(item, kind) == Some(record.external_id))
                    {
                        let status = provider_status(value, kind);
                        if record.status != status || record.message.is_some() {
                            record.status = status.into();
                            record.message = None;
                            record.updated_at = now();
                            engine.update(record, &previous_status)?;
                        }
                    } else if record.status == "available" || record.status == "requested" {
                        record.status = "uncertain".into();
                        record.updated_at = now();
                        record.message = Some("The provider no longer confirms this request. Ask the operator to check it before trying again.".into());
                        engine.update(record, &previous_status)?;
                    }
                }
            }
            Err(_) => incomplete = true,
        }
    }
    let records = engine.records()?;
    Ok(Json(
        json!({"apiVersion":1,"items":records,"refreshIncomplete":incomplete}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewRequest {
    kind: Kind,
    external_id: u32,
}

async fn create(
    State(state): State<RouteState>,
    input: Result<Json<NewRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(input) = input.map_err(|_| ApiError::invalid())?;
    if input.external_id == 0 || input.external_id > i32::MAX as u32 {
        return Err(ApiError::invalid());
    }
    let engine = &state.engine;
    let provider = engine.provider(input.kind)?;
    let _permit = engine
        .operations
        .try_acquire()
        .map_err(|_| ApiError::busy())?;
    let _write = engine.writes.lock().await;
    // A durable existing identity is never resent, including failures/timeouts.
    if let Some(mut record) = engine.saved(input.kind, input.external_id)? {
        let previous_status = record.status.clone();
        if let Ok(catalog) = engine.catalog(input.kind).await
            && let Some(value) = catalog
                .iter()
                .find(|item| external_id_of(item, input.kind) == Some(input.external_id))
        {
            record.status = provider_status(value, input.kind).into();
            record.message = None;
            record.updated_at = now();
            engine.update(&record, &previous_status)?;
        }
        let record = engine.latest(&record)?;
        return Ok((
            StatusCode::OK,
            Json(json!({"apiVersion":1,"item":record,"duplicate":true})),
        )
            .into_response());
    }
    if engine.records()?.len() >= MAX_REQUESTS {
        return Err(ApiError::busy());
    }
    let catalog = engine.catalog(input.kind).await?;
    if let Some(value) = catalog
        .iter()
        .find(|item| external_id_of(item, input.kind) == Some(input.external_id))
    {
        let record = new_record(
            input.kind,
            input.external_id,
            value,
            provider_status(value, input.kind),
        )?;
        engine.insert(&record)?;
        let record = engine.latest(&record)?;
        return Ok((
            StatusCode::OK,
            Json(json!({"apiVersion":1,"item":record,"duplicate":true})),
        )
            .into_response());
    }
    let lookup = engine
        .get(
            input.kind,
            "/lookup",
            Some(&format!(
                "{}:{}",
                input.kind.lookup_prefix(),
                input.external_id
            )),
        )
        .await?;
    let value = lookup
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| external_id_of(item, input.kind) == Some(input.external_id))
        })
        .ok_or(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not_found",
            "This title could not be verified by the request provider.",
        ))?;
    // Sonarr uses this classification when parsing episode names. Preserve only
    // its verified supported values, and reject incomplete lookup data before
    // reserving an identity or sending a provider write.
    let series_type = match input.kind {
        Kind::Movie => None,
        Kind::Series => Some(verified_series_type(value)?),
    };
    let mut record = new_record(input.kind, input.external_id, value, "uncertain")?;
    record.message =
        Some("Provider confirmation is pending. Refresh status before any further attempt.".into());
    // FULL synchronous SQLite write precedes the only outbound POST. Cancellation,
    // crash, ambiguous replies, and restart therefore cannot silently retry it.
    if !engine.insert(&record)? {
        let record = engine.latest(&record)?;
        return Ok((
            StatusCode::OK,
            Json(json!({"apiVersion":1,"item":record,"duplicate":true})),
        )
            .into_response());
    }
    let mut payload = json!({"title":record.title,"qualityProfileId":provider.quality_profile_id,"rootFolderPath":provider.root_folder,"monitored":true});
    if let Some(year) = record.year {
        payload["year"] = year.into();
    }
    if let Some(series_type) = series_type {
        payload["seriesType"] = series_type.into();
    }
    payload[input.kind.id_key()] = input.external_id.into();
    if let Some(slug) = value
        .get("titleSlug")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 250 && !s.chars().any(char::is_control))
    {
        payload["titleSlug"] = slug.into();
    }
    match input.kind {
        Kind::Movie => {
            payload["minimumAvailability"] = "released".into();
            payload["addOptions"] = json!({"searchForMovie":false});
        }
        Kind::Series => {
            payload["seasonFolder"] = true.into();
            // Monitoring is explicit and no historical episode search is triggered.
            let seasons = value
                .get("seasons")
                .and_then(Value::as_array)
                .map(|seasons| {
                    seasons
                        .iter()
                        .filter_map(|season| {
                            season
                                .get("seasonNumber")
                                .and_then(Value::as_u64)
                                .filter(|n| *n <= 1000)
                                .map(|n| json!({"seasonNumber":n,"monitored":n>0}))
                        })
                        .take(1000)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            payload["seasons"] = seasons.into();
            payload["addOptions"] =
                json!({"searchForMissingEpisodes":false,"searchForCutoffUnmetEpisodes":false});
        }
    }
    let response = engine
        .client
        .post(engine.url(input.kind, "")?)
        .header("X-Api-Key", &provider.api_key)
        .json(&payload)
        .send()
        .await;
    let mut response_status = StatusCode::ACCEPTED;
    match response {
        Ok(response) if response.status().is_success() => {
            // Validate even successful replies; a broken/empty reply is ambiguous.
            if let Ok(value) = read_json(response).await
                && external_id_of(&value, input.kind) == Some(input.external_id)
            {
                record.status = provider_status(&value, input.kind).into();
                record.message = None;
                response_status = StatusCode::CREATED;
            }
        }
        Ok(response) if response.status().is_client_error() => {
            // Another caller may have added the same title between GET and POST.
            if let Ok(catalog) = engine.catalog(input.kind).await {
                if let Some(value) = catalog
                    .iter()
                    .find(|item| external_id_of(item, input.kind) == Some(input.external_id))
                {
                    record.status = provider_status(value, input.kind).into();
                    record.message = None;
                } else {
                    record.status = "failed".into();
                    record.message = Some("The provider rejected this request. Ask the operator to check provider setup.".into());
                }
                response_status = StatusCode::CREATED;
            }
        }
        _ => (),
    }
    record.updated_at = now();
    engine.update(&record, "uncertain")?;
    let record = engine.latest(&record)?;
    Ok((
        response_status,
        Json(json!({"apiVersion":1,"item":record,"duplicate":false})),
    )
        .into_response())
}

fn verified_series_type(value: &Value) -> Result<&str, ApiError> {
    match value.get("seriesType").and_then(Value::as_str) {
        Some(series_type @ ("standard" | "daily" | "anime")) => Ok(series_type),
        _ => Err(ApiError::provider()),
    }
}

fn new_record(
    kind: Kind,
    external_id: u32,
    value: &Value,
    status: &str,
) -> Result<RequestRecord, ApiError> {
    let stamp = now();
    Ok(RequestRecord {
        id: format!("{}-{external_id}", kind.key()),
        kind,
        external_id,
        title: title(value).ok_or_else(ApiError::provider)?,
        year: year(value),
        status: status.into(),
        created_at: stamp,
        updated_at: stamp,
        message: None,
        revision: 0,
    })
}
fn external_id(value: &Value, kind: Kind) -> Option<u32> {
    external_id_of(value, kind)
}
fn external_id_of(value: &Value, kind: Kind) -> Option<u32> {
    value
        .get(kind.id_key())
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0 && *n <= i32::MAX as u32)
}
fn safe_text(value: &str, maximum: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(maximum)
        .collect()
}
fn title(value: &Value) -> Option<String> {
    value
        .get("title")
        .and_then(Value::as_str)
        .map(|s| {
            s.trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
}
fn year(value: &Value) -> Option<u32> {
    value
        .get("year")
        .and_then(Value::as_u64)
        .filter(|n| (1800..=3000).contains(n))
        .map(|n| n as u32)
}
fn provider_status(value: &Value, kind: Kind) -> &'static str {
    let available = match kind {
        Kind::Movie => value.get("hasFile").and_then(Value::as_bool) == Some(true),
        Kind::Series => {
            let count = value
                .pointer("/statistics/episodeCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let files = value
                .pointer("/statistics/episodeFileCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            count > 0 && files >= count
        }
    };
    if available { "available" } else { "requested" }
}
async fn read_json(mut response: reqwest::Response) -> Result<Value, ApiError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_BYTES as u64)
    {
        return Err(ApiError::provider());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::provider())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_PROVIDER_BYTES {
            return Err(ApiError::provider());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::provider())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    fn late_confirmation_cannot_overwrite_a_newer_observed_status() {
        let temp = tempfile::tempdir().unwrap();
        let engine = Engine::new(
            temp.path(),
            Config {
                token: "synthetic-operator-token-for-tests-0000".into(),
                radarr: Some(
                    ProviderConfig::new(
                        "http://127.0.0.1:1/",
                        "synthetic-provider-key-00000000".into(),
                        "/synthetic/movies".into(),
                        1,
                    )
                    .unwrap(),
                ),
                sonarr: None,
            },
        )
        .unwrap();
        let value = json!({"tmdbId":101,"title":"Synthetic fixture"});
        let mut pending = new_record(Kind::Movie, 101, &value, "uncertain").unwrap();
        assert!(engine.insert(&pending).unwrap());
        let mut refreshed = engine.latest(&pending).unwrap();
        refreshed.status = "available".into();
        engine.update(&refreshed, "uncertain").unwrap();
        pending.status = "requested".into();
        engine.update(&pending, "uncertain").unwrap();
        assert_eq!(engine.latest(&pending).unwrap().status, "available");
        assert!(!engine.insert(&pending).unwrap());
        assert_eq!(engine.latest(&pending).unwrap().status, "available");
        // Even if a later observation cycles the status back to uncertain, the
        // older confirmation still has the wrong revision and must not win.
        let mut removed = engine.latest(&pending).unwrap();
        removed.status = "uncertain".into();
        engine.update(&removed, "available").unwrap();
        engine.update(&pending, "uncertain").unwrap();
        assert_eq!(engine.latest(&pending).unwrap().status, "uncertain");
    }
}
