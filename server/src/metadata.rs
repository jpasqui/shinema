//! Demand-driven provider metadata. Provider I/O never runs in a browse/image
//! response. Only cleaned title/year queries and provider IDs leave this server.
use crate::Media;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, mpsc};
const IMAGE_LIMIT: u64 = 256 * 1024 * 1024;
const HARD_EXPIRY: u64 = 30 * 86400;
const BODY_LIMIT: usize = 4 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Query {
    pub kind: String,
    pub title: String,
    pub year: Option<u32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}
impl Query {
    fn key(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("Query JSON"))
        )
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub fetched_at: u64,
    #[serde(default)]
    pub image_retry_after: u64,
    pub provider: String,
    pub provider_id: u64,
    pub title: String,
    pub summary: String,
    pub year: Option<u32>,
    pub genres: Vec<String>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
}
#[derive(Debug)]
pub enum Failure {
    Unavailable,
    RateLimited(u64),
}
type ResultFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<Record>, Failure>> + Send + 'a>>;
trait Provider: Send + Sync {
    fn fetch<'a>(&'a self, query: &'a Query) -> ResultFuture<'a>;
    fn available(&self, kind: &str) -> bool;
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn text(value: &Value, key: &str, limit: usize) -> String {
    value[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(limit)
        .collect()
}
fn plain(html: &str) -> String {
    let mut result = String::new();
    let mut tag = false;
    for ch in html.chars() {
        match ch {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => result.push(ch),
            _ => (),
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .chars()
        .take(4000)
        .collect()
}
fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
pub(crate) fn title_year(raw: &str) -> (String, Option<u32>) {
    let spaced = raw.replace(['.', '_'], " ");
    let mut title = Vec::new();
    let mut year = None;
    for part in spaced.split_whitespace() {
        let token = part.trim_matches(['(', ')', '[', ']']);
        if token.len() == 4 && token.bytes().all(|c| c.is_ascii_digit()) {
            let n = token.parse::<u32>().unwrap_or(0);
            if (1900..=2099).contains(&n)
                && (!title.is_empty() || part.starts_with('(') || part.starts_with('['))
            {
                year = Some(n);
                break;
            }
        }
        let lower = token.to_ascii_lowercase();
        if [
            "1080p", "720p", "2160p", "480p", "webdl", "webrip", "bluray", "bdrip", "dvdrip",
            "hdtv", "remux", "x264", "x265", "h264", "h265",
        ]
        .contains(&lower.split('-').next().unwrap_or_default())
        {
            break;
        }
        title.push(part);
    }
    (
        title
            .join(" ")
            .trim_matches([' ', '-', '(', ')', '[', ']'])
            .chars()
            .take(200)
            .collect(),
        year,
    )
}
pub(crate) fn prepare(item: &mut Media) {
    if item.classification.collection.as_deref() == Some("movies") {
        let (title, year) = title_year(&item.title);
        item.title = title;
        item.presentation.year = year;
    } else if item.classification.collection.as_deref() == Some("tv") {
        if let Some(series) = &item.classification.series_title {
            item.presentation.year = title_year(series).1;
        }
        if let (Some(season), Some(episode)) =
            (item.classification.season, item.classification.episode)
        {
            let marker = format!("S{season:02}E{episode:02}");
            if let Some(index) = item.title.to_ascii_uppercase().find(&marker) {
                let tail = item.title[index + marker.len()..].trim_matches([' ', '-', '.']);
                if !tail.is_empty() {
                    let title = title_year(tail).0;
                    if !title.is_empty() {
                        item.title = title;
                    }
                }
            }
        }
    }
}
pub(crate) fn query(item: &Media, series_only: bool) -> Option<Query> {
    let kind = item.classification.collection.as_deref()?;
    let raw = if kind == "tv" {
        item.classification.series_title.as_deref()?
    } else {
        &item.title
    };
    if raw.contains(['/', '\\']) || raw.chars().any(char::is_control) {
        return None;
    }
    let (title, year) = title_year(raw);
    if title.is_empty() {
        return None;
    }
    Some(Query {
        kind: kind.into(),
        title,
        year: year.or(item.presentation.year),
        season: if series_only {
            None
        } else {
            item.classification.season
        },
        episode: if series_only {
            None
        } else {
            item.classification.episode
        },
    })
}
fn unique<'a>(query: &Query, candidates: &'a [Value], name: &str, date: &str) -> Option<&'a Value> {
    let matches = candidates
        .iter()
        .filter(|v| {
            normalized(v[name].as_str().unwrap_or_default()) == normalized(&query.title)
                && query.year.is_none_or(|y| {
                    v[date]
                        .as_str()
                        .and_then(|s| s.get(..4))
                        .and_then(|s| s.parse().ok())
                        == Some(y)
                })
        })
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0])
}
fn image_url(provider: &str, path: &str, wide: bool) -> Option<String> {
    if provider == "tmdb" {
        if !path.starts_with('/')
            || path.len() > 160
            || path[1..].contains('/')
            || !path
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
            || !path.ends_with(".jpg")
        {
            return None;
        }
        return Some(
            format!(
                "https://image.tmdb.org/t/p/{}/{path}",
                if wide { "w780" } else { "w342" }
            )
            .replace("//", "/")
            .replacen("https:/", "https://", 1),
        );
    }
    let url = reqwest::Url::parse(path).ok()?;
    if provider == "tvmaze"
        && url.scheme() == "https"
        && url.host_str() == Some("static.tvmaze.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with("/uploads/images/")
    {
        Some(url.to_string())
    } else {
        None
    }
}
struct HttpProvider {
    client: reqwest::Client,
    token: Option<reqwest::header::HeaderValue>,
    tvmaze: bool,
    gate: AsyncMutex<tokio::time::Instant>,
}
impl HttpProvider {
    async fn bytes(&self, url: reqwest::Url, auth: bool) -> Result<Vec<u8>, Failure> {
        let mut next = self.gate.lock().await;
        tokio::time::sleep_until(*next).await;
        *next = tokio::time::Instant::now() + Duration::from_millis(600);
        let mut request = self.client.get(url);
        if auth {
            request = request.header(
                reqwest::header::AUTHORIZATION,
                self.token.as_ref().ok_or(Failure::Unavailable)?.clone(),
            );
        }
        let mut response = request.send().await.map_err(|_| Failure::Unavailable)?;
        if response.status() == 429 {
            let seconds = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(30)
                .clamp(1, 3600);
            *next = tokio::time::Instant::now() + Duration::from_secs(seconds);
            return Err(Failure::RateLimited(seconds));
        }
        drop(next);
        if response.status() == 404 {
            return Ok(b"null".to_vec());
        }
        if !response.status().is_success() {
            return Err(Failure::Unavailable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unavailable)? {
            if bytes.len() + chunk.len() > BODY_LIMIT {
                return Err(Failure::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    async fn json(
        &self,
        path: &str,
        parameters: &[(&str, String)],
        tmdb: bool,
    ) -> Result<Value, Failure> {
        let root = if tmdb {
            "https://api.themoviedb.org/3/"
        } else {
            "https://api.tvmaze.com/"
        };
        let mut url =
            reqwest::Url::parse(&format!("{root}{path}")).map_err(|_| Failure::Unavailable)?;
        url.query_pairs_mut()
            .extend_pairs(parameters.iter().map(|(k, v)| (*k, v)));
        serde_json::from_slice(&self.bytes(url, tmdb).await?).map_err(|_| Failure::Unavailable)
    }
    async fn tmdb(&self, q: &Query) -> Result<Option<Record>, Failure> {
        let kind = if q.kind == "tv" { "tv" } else { "movie" };
        let result = self
            .json(
                &format!("search/{kind}"),
                &[
                    ("query", q.title.clone()),
                    ("include_adult", "false".into()),
                ],
                true,
            )
            .await?;
        let candidates = result["results"].as_array().ok_or(Failure::Unavailable)?;
        let Some(found) = unique(
            q,
            candidates,
            if kind == "tv" { "name" } else { "title" },
            if kind == "tv" {
                "first_air_date"
            } else {
                "release_date"
            },
        ) else {
            return Ok(None);
        };
        let id = found["id"].as_u64().ok_or(Failure::Unavailable)?;
        let base = self.json(&format!("{kind}/{id}"), &[], true).await?;
        let mut r = Record {
            fetched_at: now(),
            image_retry_after: 0,
            provider: "tmdb".into(),
            provider_id: id,
            title: text(&base, if kind == "tv" { "name" } else { "title" }, 200),
            summary: text(&base, "overview", 4000),
            year: base[if kind == "tv" {
                "first_air_date"
            } else {
                "release_date"
            }]
            .as_str()
            .and_then(|v| v.get(..4))
            .and_then(|v| v.parse().ok()),
            genres: base["genres"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .take(12)
                        .map(|v| text(v, "name", 80))
                        .collect()
                })
                .unwrap_or_default(),
            poster: base["poster_path"]
                .as_str()
                .and_then(|p| image_url("tmdb", p, false)),
            backdrop: base["backdrop_path"]
                .as_str()
                .and_then(|p| image_url("tmdb", p, true)),
        };
        if let (Some(season), Some(episode)) = (q.season, q.episode) {
            let v = self
                .json(
                    &format!("tv/{id}/season/{season}/episode/{episode}"),
                    &[],
                    true,
                )
                .await?;
            if !v.is_null() {
                r.title = text(&v, "name", 200);
                r.summary = text(&v, "overview", 4000);
                r.backdrop = v["still_path"]
                    .as_str()
                    .and_then(|p| image_url("tmdb", p, true));
            }
        }
        Ok(Some(r))
    }
    async fn tvmaze(&self, q: &Query) -> Result<Option<Record>, Failure> {
        let result = self
            .json("search/shows", &[("q", q.title.clone())], false)
            .await?;
        let candidates = result
            .as_array()
            .ok_or(Failure::Unavailable)?
            .iter()
            .map(|v| v["show"].clone())
            .collect::<Vec<_>>();
        let Some(v) = unique(q, &candidates, "name", "premiered") else {
            return Ok(None);
        };
        let id = v["id"].as_u64().ok_or(Failure::Unavailable)?;
        let mut r = Record {
            fetched_at: now(),
            image_retry_after: 0,
            provider: "tvmaze".into(),
            provider_id: id,
            title: text(v, "name", 200),
            summary: plain(v["summary"].as_str().unwrap_or_default()),
            year: v["premiered"]
                .as_str()
                .and_then(|s| s.get(..4))
                .and_then(|s| s.parse().ok()),
            genres: v["genres"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .take(12)
                        .filter_map(Value::as_str)
                        .map(|s| s.chars().take(80).collect())
                        .collect()
                })
                .unwrap_or_default(),
            poster: v["image"]["medium"]
                .as_str()
                .and_then(|p| image_url("tvmaze", p, false)),
            backdrop: None,
        };
        if let (Some(season), Some(episode)) = (q.season, q.episode) {
            let v = self
                .json(
                    &format!("shows/{id}/episodebynumber"),
                    &[
                        ("season", season.to_string()),
                        ("number", episode.to_string()),
                    ],
                    false,
                )
                .await?;
            if !v.is_null() {
                r.title = text(&v, "name", 200);
                r.summary = plain(v["summary"].as_str().unwrap_or_default());
                r.backdrop = v["image"]["medium"]
                    .as_str()
                    .and_then(|p| image_url("tvmaze", p, true));
            }
        }
        Ok(Some(r))
    }
}
impl Provider for HttpProvider {
    fn fetch<'a>(&'a self, q: &'a Query) -> ResultFuture<'a> {
        Box::pin(async move {
            if q.kind == "tv" && self.tvmaze {
                self.tvmaze(q).await
            } else if self.token.is_some() {
                self.tmdb(q).await
            } else {
                Ok(None)
            }
        })
    }
    fn available(&self, kind: &str) -> bool {
        self.token.is_some() || (kind == "tv" && self.tvmaze)
    }
}
#[derive(Clone)]
struct Work {
    query: Query,
    wide: bool,
    cached: Option<Record>,
}
pub struct Engine {
    database: Mutex<Connection>,
    images: PathBuf,
    pending: Mutex<BTreeSet<String>>,
    sender: mpsc::Sender<Work>,
    provider: Arc<dyn Provider>,
    http: Arc<HttpProvider>,
    last_purge: std::sync::atomic::AtomicU64,
    _lease: crate::cache_lease::Lease,
}
impl Engine {
    pub fn new(state: &Path) -> io::Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(12))
            .pool_max_idle_per_host(1)
            .user_agent("Shinema/0.1 (local media metadata)")
            .build()
            .map_err(|_| io::Error::other("Metadata HTTP client"))?;
        let token = match std::env::var_os("SHINEMA_TMDB_TOKEN_FILE") {
            Some(path) => {
                let path = PathBuf::from(path);
                if crate::state_files::validate_file(&path)? > 4096 {
                    return Err(io::Error::other("Invalid metadata token file"));
                }
                let secret = fs::read_to_string(path)?;
                let mut header =
                    reqwest::header::HeaderValue::from_str(&format!("Bearer {}", secret.trim()))
                        .map_err(|_| io::Error::other("Invalid metadata token"))?;
                header.set_sensitive(true);
                Some(header)
            }
            None => None,
        };
        let http = Arc::new(HttpProvider {
            client,
            token,
            tvmaze: std::env::var("SHINEMA_TVMAZE").is_ok_and(|v| v == "1"),
            gate: AsyncMutex::new(tokio::time::Instant::now()),
        });
        Self::with_provider(state, http.clone(), http)
    }
    fn with_provider(
        state: &Path,
        http: Arc<HttpProvider>,
        provider: Arc<dyn Provider>,
    ) -> io::Result<Arc<Self>> {
        let dir = state.join("metadata-cache");
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io::Error::other(
                "Metadata cache directory cannot be a link",
            ));
        }
        crate::state_files::create_private_directory(&dir)?;
        let lease = crate::cache_lease::Lease::acquire(&dir)?;
        let images = dir.join("images");
        if fs::symlink_metadata(&images).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io::Error::other("Artwork cache directory cannot be a link"));
        }
        crate::state_files::create_private_directory(&images)?;
        for name in [
            "metadata.sqlite3",
            "metadata.sqlite3-wal",
            "metadata.sqlite3-shm",
            "metadata.sqlite3-journal",
        ] {
            match crate::state_files::validate_file(&dir.join(name)) {
                Ok(_) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        let db = Connection::open_with_flags(
            dir.join("metadata.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(io::Error::other)?;
        db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL;CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,data TEXT,retry INTEGER);CREATE TABLE IF NOT EXISTS images(key TEXT PRIMARY KEY,size INTEGER,used INTEGER);").map_err(io::Error::other)?;
        let (sender, mut receiver) = mpsc::channel::<Work>(128);
        let engine = Arc::new(Self {
            database: Mutex::new(db),
            images,
            pending: Mutex::new(BTreeSet::new()),
            sender,
            provider,
            http,
            last_purge: std::sync::atomic::AtomicU64::new(0),
            _lease: lease,
        });
        for entry in fs::read_dir(&engine.images)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(key) = name.strip_suffix(".tmp")
                && key.len() == 64
                && key.bytes().all(|c| c.is_ascii_hexdigit())
            {
                crate::state_files::validate_file(&entry.path())?;
                fs::remove_file(entry.path())?;
            }
        }
        engine.purge()?;
        let weak = Arc::downgrade(&engine);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                while let Some(work) = receiver.recv().await {
                    let Some(engine) = weak.upgrade() else {
                        break;
                    };
                    let _ = engine.purge();
                    engine.run(work).await;
                }
            });
        }
        Ok(engine)
    }
    fn cached(&self, key: &str) -> Option<(Option<Record>, u64)> {
        let db = self.database.lock().ok()?;
        let (data, retry) = db
            .query_row("SELECT data,retry FROM metadata WHERE key=?", [key], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
            })
            .ok()?;
        let record = serde_json::from_str::<Option<Record>>(&data).ok()?;
        if record.as_ref().is_some_and(|r| {
            r.fetched_at > now() + 300 || now().saturating_sub(r.fetched_at) > HARD_EXPIRY
        }) {
            let _ = db.execute("DELETE FROM metadata WHERE key=?", [key]);
            return None;
        }
        Some((record, retry))
    }
    fn purge(&self) -> io::Result<()> {
        let previous = self.last_purge.load(std::sync::atomic::Ordering::Relaxed);
        if now().saturating_sub(previous) < 3600 {
            return Ok(());
        }
        if self
            .last_purge
            .compare_exchange(
                previous,
                now(),
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_err()
        {
            return Ok(());
        }

        let db = self
            .database
            .lock()
            .map_err(|_| io::Error::other("Metadata cache lock"))?;
        let old = now().saturating_sub(HARD_EXPIRY);
        db.execute("DELETE FROM metadata WHERE CASE WHEN json_valid(data) AND data!='null' THEN coalesce(json_extract(data,'$.fetched_at'),0)<?1 ELSE retry<?1 END",[old]).map_err(io::Error::other)?;
        let keys = db
            .prepare("SELECT key FROM images")
            .map_err(io::Error::other)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        // A process can stop after the final rename but before the row insert.
        // Unregistered finals must not remain invisible and outside quota.
        let registered: BTreeSet<_> = keys.iter().cloned().collect();
        for entry in fs::read_dir(&self.images)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.len() == 64
                && name.bytes().all(|c| c.is_ascii_hexdigit())
                && !registered.contains(&name)
            {
                crate::state_files::validate_file(&entry.path())?;
                fs::remove_file(entry.path())?;
            }
        }
        for key in keys {
            if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(io::Error::other("Invalid artwork cache identity"));
            }
            let path = self.images.join(&key);
            if !path.exists() {
                db.execute("DELETE FROM images WHERE key=?", [key])
                    .map_err(io::Error::other)?;
                continue;
            }
            crate::state_files::validate_file(&path)?;
            if fs::metadata(&path)?
                .modified()?
                .elapsed()
                .unwrap_or_default()
                .as_secs()
                > HARD_EXPIRY
            {
                fs::remove_file(path)?;
                db.execute("DELETE FROM images WHERE key=?", [key])
                    .map_err(io::Error::other)?;
            }
        }
        Ok(())
    }
    fn queued(&self, q: &Query, wide: bool) {
        if !self.provider.available(&q.kind) {
            return;
        }
        let key = q.key();
        let mut pending = self.pending.lock().expect("Metadata pending");
        if pending.contains(&key) {
            return;
        }
        let cached = self.cached(&key);
        let mut reuse = None;
        if let Some((record, retry)) = cached
            && retry > now()
        {
            let Some(record) = record else {
                return;
            };
            let missing_poster = record
                .poster
                .as_deref()
                .is_some_and(|u| self.image_key(u).is_none());
            let missing_wide = wide
                && record
                    .backdrop
                    .as_deref()
                    .is_some_and(|u| self.image_key(u).is_none());
            if record.image_retry_after > now() || (!missing_poster && !missing_wide) {
                return;
            }
            reuse = Some(record);
        }
        pending.insert(key.clone());
        if self
            .sender
            .try_send(Work {
                query: q.clone(),
                wide,
                cached: reuse,
            })
            .is_err()
        {
            pending.remove(&key);
        }
    }
    async fn run(&self, work: Work) {
        let key = work.query.key();
        let fetched = if let Some(record) = work.cached {
            Ok(Some(record))
        } else {
            self.provider.fetch(&work.query).await
        };
        let (mut record, mut retry) = match fetched {
            Ok(value) => {
                let days = if value.is_some() { 7 } else { 1 };
                (value, now() + days * 86400)
            }
            Err(Failure::RateLimited(seconds)) => {
                (self.cached(&key).and_then(|v| v.0), now() + seconds)
            }
            Err(Failure::Unavailable) => (self.cached(&key).and_then(|v| v.0), now() + 60),
        };
        if let Some(record) = &mut record {
            if record.fetched_at == 0 {
                record.fetched_at = now();
            }
            record.image_retry_after = 0;
            if let Some(url) = &record.poster
                && self.download_image(url).await.is_err()
            {
                retry = now() + 60;
                record.image_retry_after = now() + 60;
            }
            if work.wide
                && let Some(url) = &record.backdrop
                && self.download_image(url).await.is_err()
            {
                retry = now() + 60;
                record.image_retry_after = now() + 60;
            }
        }
        if let Ok(db) = self.database.lock() {
            let _ = db.execute(
                "INSERT OR REPLACE INTO metadata VALUES (?1,?2,?3)",
                params![
                    key,
                    serde_json::to_string(&record).unwrap_or("null".into()),
                    retry
                ],
            );
        }
        if let Ok(db) = self.database.lock() {
            let _=db.execute("DELETE FROM metadata WHERE key IN (SELECT key FROM metadata ORDER BY retry LIMIT max((SELECT count(*) FROM metadata)-20000,0))",[]);
            let _ = db.execute_batch("PRAGMA incremental_vacuum(128)");
        }
        self.pending.lock().expect("Metadata pending").remove(&key);
    }
    async fn download_image(&self, url: &str) -> Result<(), Failure> {
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        let path = self.images.join(&key);
        if self.image_key(url).is_some() {
            return Ok(());
        }
        // Also recover a failed row insert without waiting for a restart/purge.
        // Only a validated, quota-accounted and unexpired image is a cache hit.
        {
            let db = self.database.lock().map_err(|_| Failure::Unavailable)?;
            match fs::symlink_metadata(&path) {
                Ok(_) => {
                    crate::state_files::validate_file(&path).map_err(|_| Failure::Unavailable)?;
                    fs::remove_file(&path).map_err(|_| Failure::Unavailable)?;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(_) => return Err(Failure::Unavailable),
            }
            db.execute("DELETE FROM images WHERE key=?", [&key])
                .map_err(|_| Failure::Unavailable)?;
        }
        let url = reqwest::Url::parse(url).map_err(|_| Failure::Unavailable)?;
        if ![Some("image.tmdb.org"), Some("static.tvmaze.com")].contains(&url.host_str())
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Failure::Unavailable);
        }
        let bytes = self.http.bytes(url, false).await?;
        if bytes.len() > 2 * 1024 * 1024
            || !(bytes.starts_with(b"\xff\xd8\xff") || bytes.starts_with(b"\x89PNG"))
        {
            return Err(Failure::Unavailable);
        }
        self.commit_image(&key, &bytes, IMAGE_LIMIT)
    }
    fn commit_image(&self, key: &str, bytes: &[u8], limit: u64) -> Result<(), Failure> {
        if key.len() != 64
            || !key.bytes().all(|c| c.is_ascii_hexdigit())
            || bytes.len() > 2 * 1024 * 1024
            || bytes.len() as u64 > limit
            || !(bytes.starts_with(b"\xff\xd8\xff") || bytes.starts_with(b"\x89PNG"))
        {
            return Err(Failure::Unavailable);
        }
        let path = self.images.join(key);
        let db = self.database.lock().map_err(|_| Failure::Unavailable)?;
        if path.exists() {
            crate::state_files::validate_file(&path).map_err(|_| Failure::Unavailable)?;
            if fs::read(&path).map_err(|_| Failure::Unavailable)? != bytes {
                return Err(Failure::Unavailable);
            }
        }
        let mut total = db
            .query_row("SELECT coalesce(sum(size),0) FROM images", [], |r| {
                r.get::<_, u64>(0)
            })
            .map_err(|_| Failure::Unavailable)?;
        let present = db
            .query_row("SELECT size FROM images WHERE key=?", [key], |r| {
                r.get::<_, u64>(0)
            })
            .ok();
        if present.is_none() {
            while total + bytes.len() as u64 > limit
                || db
                    .query_row("SELECT count(*) FROM images", [], |r| r.get::<_, u64>(0))
                    .map_err(|_| Failure::Unavailable)?
                    >= 4096
            {
                let (old, size): (String, u64) = db
                    .query_row(
                        "SELECT key,size FROM images ORDER BY used,key LIMIT 1",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(|_| Failure::Unavailable)?;
                crate::state_files::validate_file(&self.images.join(&old))
                    .map_err(|_| Failure::Unavailable)?;
                fs::remove_file(self.images.join(&old)).map_err(|_| Failure::Unavailable)?;
                db.execute("DELETE FROM images WHERE key=?", [old])
                    .map_err(|_| Failure::Unavailable)?;
                total = total.saturating_sub(size);
            }
        }
        if !path.exists() {
            use std::io::Write;
            let temporary = self.images.join(format!("{key}.tmp"));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| Failure::Unavailable)?;
            let cleanup = PendingImage(temporary.clone());
            let written = file.write_all(bytes).and_then(|_| file.sync_all());
            drop(file);
            written.map_err(|_| Failure::Unavailable)?;
            fs::rename(temporary, &path).map_err(|_| Failure::Unavailable)?;
            drop(cleanup);
        }
        db.execute(
            "INSERT OR REPLACE INTO images VALUES (?1,?2,?3)",
            params![key, bytes.len() as u64, now()],
        )
        .map_err(|_| Failure::Unavailable)?;
        Ok(())
    }
    fn image_key(&self, url: &str) -> Option<String> {
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        if fs::metadata(self.images.join(&key))
            .ok()?
            .modified()
            .ok()?
            .elapsed()
            .unwrap_or_default()
            .as_secs()
            > HARD_EXPIRY
        {
            return None;
        }
        let expected = self
            .database
            .lock()
            .ok()?
            .query_row("SELECT size FROM images WHERE key=?", [&key], |r| {
                r.get::<_, u64>(0)
            })
            .ok()?;
        crate::state_files::validate_file(&self.images.join(&key))
            .ok()
            .filter(|n| *n > 0 && *n <= 2 * 1024 * 1024 && *n == expected)
            .map(|_| key)
    }
    pub fn overlay(&self, item: &mut Media, series_only: bool, wide: bool) -> bool {
        let Some(q) = query(item, series_only) else {
            return false;
        };
        let cached = self.cached(&q.key());
        self.queued(&q, wide);
        if let Some(record) = cached.and_then(|v| v.0) {
            item.presentation.file_title = Some(item.title.clone());
            item.presentation.file_year = item.presentation.year;
            item.presentation.metadata_expires_at = Some(record.fetched_at + HARD_EXPIRY);
            if ["tmdb", "tvmaze"].contains(&record.provider.as_str()) {
                item.presentation.metadata_source = Some(record.provider.clone());
                item.presentation.metadata_url = Some(if record.provider == "tvmaze" {
                    format!("https://www.tvmaze.com/shows/{}", record.provider_id)
                } else {
                    format!(
                        "https://www.themoviedb.org/{}/{}",
                        if q.kind == "tv" { "tv" } else { "movie" },
                        record.provider_id
                    )
                });
            }

            if !record.title.is_empty() {
                item.title = record.title;
            }
            item.presentation.summary = (!record.summary.is_empty()).then_some(record.summary);
            item.presentation.year = record.year;
            item.presentation.genres = record.genres;
            if record
                .poster
                .as_deref()
                .and_then(|u| self.image_key(u))
                .is_some()
            {
                item.presentation.poster_path = Some(format!("/api/media/{}/poster", item.id));
            }
            if record
                .backdrop
                .as_deref()
                .and_then(|u| self.image_key(u))
                .is_some()
            {
                item.presentation.backdrop_path = Some(format!("/api/media/{}/backdrop", item.id));
            }
        }
        self.pending
            .lock()
            .expect("Metadata pending")
            .contains(&q.key())
    }
    pub fn image(&self, item: &Media, wide: bool) -> io::Result<Vec<u8>> {
        self.purge()?;
        let q = query(item, false).ok_or_else(|| io::Error::other("No metadata query"))?;
        let record = self
            .cached(&q.key())
            .and_then(|v| v.0)
            .or_else(|| {
                let q = query(item, true)?;
                self.cached(&q.key()).and_then(|v| v.0)
            })
            .ok_or_else(|| io::Error::other("No cached metadata"))?;
        let url = if wide { record.backdrop } else { record.poster }
            .ok_or_else(|| io::Error::other("No image"))?;
        let key = self
            .image_key(&url)
            .ok_or_else(|| io::Error::other("No cached image"))?;
        if let Ok(db) = self.database.lock() {
            let _ = db.execute(
                "UPDATE images SET used=?1 WHERE key=?2",
                params![now(), key],
            );
        }
        fs::read(self.images.join(key))
    }
    pub fn status(&self) -> Value {
        json!({"tmdbConfigured":self.http.token.is_some(),"tvmazeEnabled":self.http.tvmaze,"pending":self.pending.lock().expect("Metadata pending").len()})
    }
}
struct PendingImage(PathBuf);
impl Drop for PendingImage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_rejects_remakes_and_ambiguity() {
        let q = Query {
            kind: "movies".into(),
            title: "Generated Film".into(),
            year: Some(2026),
            season: None,
            episode: None,
        };
        let rows = vec![
            json!({"title":"Generated Film","release_date":"2000-01-01"}),
            json!({"title":"Generated Film","release_date":"2026-01-01"}),
        ];
        assert_eq!(
            unique(&q, &rows, "title", "release_date").unwrap()["release_date"],
            "2026-01-01"
        );
        let q = Query { year: None, ..q };
        assert!(unique(&q, &rows, "title", "release_date").is_none());
        assert!(
            unique(
                &q,
                &[json!({"title":"Different Film"})],
                "title",
                "release_date"
            )
            .is_none()
        );
    }
    #[test]
    fn queries_strip_release_noise_and_never_include_paths() {
        assert_eq!(
            title_year("Generated.Film.(2026).1080p.WEBRip"),
            ("Generated Film".into(), Some(2026))
        );
        assert!(image_url("tmdb", "/../../private", false).is_none());
        assert!(image_url("tvmaze", "https://unapproved.invalid/image.jpg", false).is_none());
        assert!(
            image_url(
                "tvmaze",
                "https://static.tvmaze.com/uploads/images/medium_portrait/1/2.jpg",
                false
            )
            .is_some()
        );
    }
    #[test]
    fn markup_is_never_rendered_as_provider_html() {
        assert_eq!(plain("<p>Generated &amp; text</p>"), "Generated & text");
    }
    struct Fixture {
        calls: Arc<std::sync::atomic::AtomicUsize>,
        limited: bool,
    }
    impl Provider for Fixture {
        fn available(&self, _: &str) -> bool {
            true
        }
        fn fetch<'a>(&'a self, q: &'a Query) -> ResultFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                if self.limited {
                    return Err(Failure::RateLimited(60));
                }
                Ok(Some(Record {
                    provider: "fixture".into(),
                    provider_id: 1,
                    title: q.title.clone(),
                    summary: "Original generated fixture synopsis".into(),
                    year: q.year,
                    ..Default::default()
                }))
            })
        }
    }
    fn fixture(
        state: &Path,
        calls: Arc<std::sync::atomic::AtomicUsize>,
        limited: bool,
    ) -> Arc<Engine> {
        let http = Arc::new(HttpProvider {
            client: reqwest::Client::new(),
            token: None,
            tvmaze: false,
            gate: AsyncMutex::new(tokio::time::Instant::now()),
        });
        Engine::with_provider(state, http, Arc::new(Fixture { calls, limited })).unwrap()
    }
    fn item() -> Media {
        Media {
            id: "a".repeat(64),
            title: "Generated Film".into(),
            container: "mkv".into(),
            size_bytes: 12,
            stream_path: format!("/api/media/{}/stream", "a".repeat(64)),
            classification: crate::Classification {
                collection: Some("movies".into()),
                ..Default::default()
            },
            presentation: crate::Presentation {
                year: Some(2026),
                ..Default::default()
            },
        }
    }
    async fn settled(engine: &Engine) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !engine.pending.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn browse_never_waits_for_provider_and_duplicate_queries_are_coalesced() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls.clone(), false);
        let start = std::time::Instant::now();
        for _ in 0..20 {
            let mut row = item();
            assert!(engine.overlay(&mut row, false, false));
            assert!(row.presentation.summary.is_none());
        }
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        settled(&engine).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let mut row = item();
        assert!(!engine.overlay(&mut row, false, false));
        assert_eq!(
            row.presentation.summary.as_deref(),
            Some("Original generated fixture synopsis")
        );
    }
    #[tokio::test]
    async fn own_cache_survives_restart_without_any_provider_request() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls.clone(), false);
        engine.overlay(&mut item(), false, false);
        settled(&engine).await;
        drop(engine);
        tokio::time::sleep(Duration::from_millis(10)).await;
        let engine = fixture(state.path(), calls.clone(), false);
        let mut row = item();
        assert!(!engine.overlay(&mut row, false, false));
        assert!(row.presentation.summary.is_some());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn rate_limit_preserves_browsing_and_defers_retry() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls.clone(), true);
        engine.overlay(&mut item(), false, false);
        settled(&engine).await;
        assert!(!engine.overlay(&mut item(), false, false));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(
            engine
                .cached(&query(&item(), false).unwrap().key())
                .unwrap()
                .1
                >= now() + 50
        );
    }
    #[tokio::test]
    async fn corrupt_cached_row_recovers_and_linked_database_is_rejected() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls.clone(), false);
        engine.overlay(&mut item(), false, false);
        settled(&engine).await;
        engine
            .database
            .lock()
            .unwrap()
            .execute("UPDATE metadata SET data='corrupt'", [])
            .unwrap();
        assert!(engine.overlay(&mut item(), false, false));
        settled(&engine).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(engine);
        tokio::time::sleep(Duration::from_millis(10)).await;
        let other = tempfile::tempdir().unwrap();
        fs::create_dir(other.path().join("metadata-cache")).unwrap();
        let original = other.path().join("original");
        fs::write(&original, b"preserve").unwrap();
        fs::hard_link(
            &original,
            other.path().join("metadata-cache/metadata.sqlite3"),
        )
        .unwrap();
        let http = Arc::new(HttpProvider {
            client: reqwest::Client::new(),
            token: None,
            tvmaze: false,
            gate: AsyncMutex::new(tokio::time::Instant::now()),
        });
        assert!(
            Engine::with_provider(
                other.path(),
                http,
                Arc::new(Fixture {
                    calls,
                    limited: false
                })
            )
            .is_err()
        );
        assert_eq!(fs::read(original).unwrap(), b"preserve");
    }
    #[tokio::test]
    async fn artwork_publication_is_atomic_bounded_and_recovers_interrupted_files() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls.clone(), false);
        let data = b"\x89PNGgenerated original fixture";
        let url = "https://static.tvmaze.com/uploads/images/medium_portrait/1/2.png";
        let key = format!("{:x}", Sha256::digest(url));
        engine
            .commit_image(&key, data, data.len() as u64 * 2)
            .unwrap();
        assert_eq!(engine.image_key(url), Some(key.clone()));
        assert!(engine.commit_image(&"x".repeat(64), data, 100).is_err());
        assert!(
            engine
                .commit_image(&"a".repeat(64), b"not an image", 100)
                .is_err()
        );
        engine
            .commit_image(&"a".repeat(64), data, data.len() as u64 * 2)
            .unwrap();
        engine
            .commit_image(&"b".repeat(64), data, data.len() as u64 * 2)
            .unwrap();
        let retained: u64 = engine
            .database
            .lock()
            .unwrap()
            .query_row("SELECT sum(size) FROM images", [], |r| r.get(0))
            .unwrap();
        assert!(retained <= data.len() as u64 * 2);
        let partial = engine.images.join(format!("{}.tmp", "c".repeat(64)));
        fs::write(&partial, b"partial").unwrap();
        assert!(
            engine
                .image_key("https://static.tvmaze.com/uploads/images/medium_portrait/3/4.png")
                .is_none()
        );
        drop(engine);
        let engine = fixture(state.path(), calls, false);
        assert!(!partial.exists());
        assert!(engine.images.join("b".repeat(64)).is_file());
    }
    #[tokio::test]
    async fn renamed_artwork_without_a_row_is_pruned_and_can_be_published_again() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls.clone(), false);
        let url = "https://static.tvmaze.com/uploads/images/medium_portrait/1/2.png";
        let key = format!("{:x}", Sha256::digest(url));
        let data = b"\x89PNGgenerated crash fixture";
        let orphan = engine.images.join(&key);
        // Reproduce the crash window exactly: bytes renamed, no SQLite row.
        fs::write(&orphan, data).unwrap();
        assert!(engine.image_key(url).is_none());
        drop(engine);
        let engine = fixture(state.path(), calls, false);
        assert!(!orphan.exists());
        engine.commit_image(&key, data, data.len() as u64).unwrap();
        assert_eq!(engine.image_key(url), Some(key.clone()));
        let accounted: u64 = engine
            .database
            .lock()
            .unwrap()
            .query_row("SELECT sum(size) FROM images", [], |r| r.get(0))
            .unwrap();
        assert_eq!(accounted, data.len() as u64);
        engine
            .database
            .lock()
            .unwrap()
            .execute("DELETE FROM images WHERE key=?", [&key])
            .unwrap();
        // No provider transport is used: a disallowed URL with existing bytes
        // must return failure, never the previous false-success cache hit.
        let invalid = "https://example.invalid/orphan.png";
        let invalid_key = format!("{:x}", Sha256::digest(invalid));
        let invalid_orphan = engine.images.join(invalid_key);
        fs::write(&invalid_orphan, data).unwrap();
        assert!(engine.download_image(invalid).await.is_err());
        assert!(!invalid_orphan.exists());
    }
    #[tokio::test]
    async fn stale_provider_content_is_removed_instead_of_refreshing_its_age() {
        let state = tempfile::tempdir().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let engine = fixture(state.path(), calls, false);
        let q = query(&item(), false).unwrap();
        let record = Record {
            provider: "tmdb".into(),
            title: "Expired provider title".into(),
            fetched_at: now() - HARD_EXPIRY - 1,
            ..Default::default()
        };
        engine
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO metadata VALUES (?1,?2,?3)",
                params![
                    q.key(),
                    serde_json::to_string(&Some(record)).unwrap(),
                    now() + 86400
                ],
            )
            .unwrap();
        assert!(engine.cached(&q.key()).is_none());
        let count: u64 = engine
            .database
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM metadata", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let mut private = item();
        private.title = "C:\\private\\library\\file".into();
        assert!(query(&private, false).is_none());
        assert_eq!(title_year("1917 (2019)"), ("1917".into(), Some(2019)));
    }
}
