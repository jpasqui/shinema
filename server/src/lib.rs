use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as ApiPath, Query, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

mod cache_lease;
mod catalog;
mod metadata;
mod playback;
mod ssh;
mod web;
pub use catalog::Classification;
pub use ssh::SshConfig;
mod state_files;

#[cfg(test)]
mod performance_tests;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub title: String,
    pub container: String,
    pub size_bytes: u64,
    pub stream_path: String,
    #[serde(flatten)]
    pub classification: Classification,
    #[serde(flatten)]
    pub presentation: Presentation,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Presentation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backdrop_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub genres: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_expires_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub position_seconds: f64,
    pub duration_seconds: f64,
}

impl Progress {
    pub fn valid(&self) -> bool {
        self.position_seconds.is_finite()
            && self.duration_seconds.is_finite()
            && self.position_seconds >= 0.0
            && self.duration_seconds > 0.0
            && self.duration_seconds <= 604800.0
            && self.position_seconds <= self.duration_seconds
    }
}

#[derive(Clone)]
struct Entry {
    media: Media,
    relative: PathBuf,
    remote: Option<ssh::RemoteEntry>,
    modified: Option<std::time::SystemTime>,
}

pub struct Library {
    root: Option<PathBuf>,
    directory: Option<cap_std::fs::Dir>,
    remote: Option<SshConfig>,
    remote_transfers: Arc<tokio::sync::Semaphore>,
    entries: BTreeMap<String, Entry>,
    series_entries: BTreeMap<String, String>,
    database: Mutex<Connection>,
    playback: playback::Engine,
    metadata: Arc<metadata::Engine>,
    web_root: Option<PathBuf>,
}

fn checked_file(root: &Path, relative: &Path) -> std::io::Result<PathBuf> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
    }
    let canonical = current.canonicalize()?;
    if !canonical.starts_with(root) || !fs::metadata(&canonical)?.is_file() {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(canonical)
}

fn media_id(relative: &Path) -> String {
    let parts = relative
        .components()
        .map(|part| part.as_os_str().to_os_string())
        .collect::<Vec<_>>();
    if let Some(unicode) = parts
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()
    {
        // Preserve existing ordinary-path IDs while normalizing only real
        // separators. A POSIX literal backslash remains part of its component.
        return format!("{:x}", Sha256::digest(unicode.join("/").as_bytes()));
    }
    // NUL cannot appear in a real filename, so this versioned domain is
    // disjoint from the ordinary UTF-8 path encoding. Length framing preserves
    // components and raw platform units without lossy Unicode replacement.
    let mut hash = Sha256::new();
    hash.update(b"\0shinema-nonunicode-path-v1\0");
    #[cfg(unix)]
    hash.update(b"unix\0");
    #[cfg(windows)]
    hash.update(b"windows\0");
    for part in parts {
        #[cfg(unix)]
        let bytes = {
            use std::os::unix::ffi::OsStrExt;
            part.as_bytes().to_vec()
        };
        #[cfg(windows)]
        let bytes = {
            use std::os::windows::ffi::OsStrExt;
            part.encode_wide()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>()
        };
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}

fn index_series(entries: &BTreeMap<String, Entry>) -> BTreeMap<String, String> {
    let mut series = BTreeMap::new();
    for (id, entry) in entries {
        if let Some(sid) = &entry.media.classification.series_id {
            // Preserve the former values().find() representative: the first
            // media ID in the library's deterministic BTreeMap order.
            series.entry(sid.clone()).or_insert_with(|| id.clone());
        }
    }
    series
}

impl Library {
    pub fn open(
        media_root: &Path,
        state_dir: &Path,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let root = media_root.canonicalize()?;
        if !root.is_dir() {
            return Err("Media root must be a directory".into());
        }
        // Resolve the nearest existing ancestor BEFORE creating any writable directory.
        let absolute = if state_dir.is_absolute() {
            state_dir.to_path_buf()
        } else {
            std::env::current_dir()?.join(state_dir)
        };
        let mut ancestor = absolute.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("Invalid state directory")?;
        }
        let resolved = ancestor
            .canonicalize()?
            .join(absolute.strip_prefix(ancestor)?);
        if resolved
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("State directory must not contain parent traversal".into());
        }
        if resolved.starts_with(&root) || root.starts_with(&resolved) {
            return Err("Media and writable state directories must be disjoint".into());
        }
        state_files::create_private_directory(&resolved)?;
        let state = resolved.canonicalize()?;
        if state.starts_with(&root) || root.starts_with(&state) {
            return Err("State overlaps media root".into());
        }
        let mut entries = BTreeMap::new();
        Self::scan(&root, &mut entries)?;
        state_files::validate(&state)?;
        let playback = playback::Engine::new(&state)?;
        let mut db = Connection::open_with_flags(
            state.join("progress.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        state_files::validate(&state)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS progress(id TEXT PRIMARY KEY, position REAL NOT NULL, duration REAL NOT NULL);")?;
        for entry in entries.values_mut() {
            metadata::prepare(&mut entry.media);
            if entry.media.classification.collection.as_deref() == Some("movies")
                && entry.media.presentation.year.is_none()
            {
                entry.media.presentation.year = entry
                    .relative
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|p| p.to_str())
                    .and_then(|p| metadata::title_year(p).1);
            }
        }
        catalog::replace_index(&mut db, entries.values().map(|entry| entry.media.clone()))?;
        let directory = cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority())?;
        Ok(Arc::new(Self {
            root: Some(root),
            directory: Some(directory),
            remote: None,
            remote_transfers: Arc::new(tokio::sync::Semaphore::new(4)),
            series_entries: index_series(&entries),
            entries,
            database: Mutex::new(db),
            playback,
            metadata: metadata::Engine::new(&state)?,
            web_root: web::configured()?,
        }))
    }

    pub async fn open_ssh(
        config: SshConfig,
        state_dir: &Path,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        config.validate()?;
        if !state_dir.is_absolute()
            || state_dir.to_string_lossy().starts_with("\\\\")
            || state_dir.to_string_lossy().starts_with("//")
            || state_dir
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("SSH state must be an absolute local directory without traversal".into());
        }
        let scan = config.scan().await?;
        let mut entries = BTreeMap::new();
        for record in scan.items {
            let relative = PathBuf::from(&record.relative);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
                || record.size_bytes > 9007199254740991
            {
                return Err("Invalid remote media identity".into());
            }
            let kind = record
                .relative
                .split('/')
                .next()
                .ok_or("Missing remote collection")?;
            let root = config.roots.get(kind).ok_or("Unknown remote collection")?;
            let id = format!(
                "{:x}",
                Sha256::digest(
                    format!(
                        "shinema-ssh-library-v1\0{}\0{}\0{}",
                        config.destination, root, record.relative
                    )
                    .as_bytes()
                )
            );
            let mut classification = catalog::classify(&relative);
            if let Some(series) = &classification.series_id {
                classification.series_id = Some(format!(
                    "{:x}",
                    Sha256::digest(
                        format!("{}\0{}\0{}", config.destination, root, series).as_bytes()
                    )
                ));
            }
            let title = relative
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .chars()
                .take(200)
                .collect::<String>()
                .replace('_', " ");
            let container = relative
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !catalog::CONTAINERS.contains(&container.as_str()) {
                return Err("Remote helper returned an unsupported container".into());
            }
            entries.insert(
                id.clone(),
                Entry {
                    media: Media {
                        stream_path: format!("/api/media/{id}/stream"),
                        id,
                        title,
                        container,
                        size_bytes: record.size_bytes,
                        classification,
                        presentation: Presentation::default(),
                    },
                    relative,
                    remote: Some(record),
                    modified: None,
                },
            );
        }
        state_files::create_private_directory(state_dir)?;
        let state = state_dir.canonicalize()?;
        state_files::validate(&state)?;
        let playback = playback::Engine::new(&state)?;
        let mut db = Connection::open_with_flags(
            state.join("progress.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        state_files::validate(&state)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS progress(id TEXT PRIMARY KEY, position REAL NOT NULL, duration REAL NOT NULL);")?;
        for entry in entries.values_mut() {
            metadata::prepare(&mut entry.media);
            if entry.media.classification.collection.as_deref() == Some("movies")
                && entry.media.presentation.year.is_none()
            {
                entry.media.presentation.year = entry
                    .relative
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|p| p.to_str())
                    .and_then(|p| metadata::title_year(p).1);
            }
        }
        catalog::replace_index(&mut db, entries.values().map(|entry| entry.media.clone()))?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS scan_summary(files_seen INTEGER,ignored_files INTEGER,links_skipped INTEGER);")?;
        db.execute("DELETE FROM scan_summary", [])?;
        db.execute(
            "INSERT INTO scan_summary VALUES (?1,?2,?3)",
            params![scan.files_seen, scan.ignored_files, scan.links_skipped],
        )?;
        Ok(Arc::new(Self {
            root: None,
            directory: None,
            remote: Some(config),
            remote_transfers: Arc::new(tokio::sync::Semaphore::new(4)),
            series_entries: index_series(&entries),
            entries,
            database: Mutex::new(db),
            playback,
            metadata: metadata::Engine::new(&state)?,
            web_root: web::configured()?,
        }))
    }

    fn scan(root: &Path, entries: &mut BTreeMap<String, Entry>) -> std::io::Result<()> {
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut children = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                let path = child.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                let extension = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !catalog::CONTAINERS.contains(&extension.as_str()) {
                    continue;
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| std::io::ErrorKind::PermissionDenied)?
                    .to_path_buf();
                checked_file(root, &relative)?;
                let id = media_id(&relative);
                let title = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .chars()
                    .take(200)
                    .collect::<String>()
                    .replace('_', " ");
                let classification = catalog::classify(&relative);
                entries.insert(
                    id.clone(),
                    Entry {
                        media: Media {
                            stream_path: format!("/api/media/{id}/stream"),
                            id,
                            title,
                            container: extension,
                            size_bytes: metadata.len(),
                            classification,
                            presentation: Presentation::default(),
                        },
                        relative,
                        remote: None,
                        modified: metadata.modified().ok(),
                    },
                );
            }
        }
        Ok(())
    }
}

pub fn router(library: Arc<Library>) -> Router {
    router_at(library, "127.0.0.1:8787".parse().expect("Loopback literal"))
}
pub fn router_at(library: Arc<Library>, bind: std::net::SocketAddr) -> Router {
    library.playback.set_origin(bind);
    Router::new()
        .route(
            "/health",
            get(|State(library):State<Arc<Library>>| async move { Json(serde_json::json!({"status":"ok","apiVersion":1,"playback":library.playback.statistics()})) }),
        )
        .route("/api/catalog", get(catalog))
        .route("/api/library", get(library_summary))
        .route("/api/series", get(series))
        .route("/api/series/{id}/seasons", get(seasons))
        .route("/api/media/{id}/stream", get(stream))
        .route("/api/media/{id}/metadata",get(media_metadata))
        .route("/api/metadata/status",get(metadata_status))
        .route("/api/media/{id}/poster",get(poster))
        .route("/api/media/{id}/backdrop",get(backdrop))
        .route("/api/media/{id}/playback", get(playback_info))
        .route("/api/media/{id}/hls/{segment}", get(hls))
        .route("/api/media/{id}/progress", get(progress).put(save_progress))
        .layer(DefaultBodyLimit::max(4096))
        .fallback(static_web)
        .with_state(library)
}

async fn static_web(
    State(library): State<Arc<Library>>,
    uri: axum::http::Uri,
) -> Result<Response, StatusCode> {
    web::response(library.web_root.as_deref(), uri).await
}

async fn catalog(
    State(library): State<Arc<Library>>,
    Query(query): Query<catalog::CatalogQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    query.validate().map_err(|_| StatusCode::BAD_REQUEST)?;
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut value = catalog::page(&db, query).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    drop(db);
    let mut pending = false;
    for row in value["items"]
        .as_array_mut()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let mut item: Media =
            serde_json::from_value(row.clone()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        pending |= library.metadata.overlay(&mut item, false, false);
        *row = serde_json::to_value(item).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    value["metadataPending"] = pending.into();
    Ok(Json(value))
}
async fn library_summary(
    State(library): State<Arc<Library>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    catalog::summary(&db)
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
async fn series(
    State(library): State<Arc<Library>>,
    Query(query): Query<catalog::CatalogQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    query.validate().map_err(|_| StatusCode::BAD_REQUEST)?;
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut value = catalog::series(&db, query).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    drop(db);
    let mut pending = false;
    for row in value["items"]
        .as_array_mut()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let sid = row["id"].as_str().unwrap_or_default();
        if let Some(entry) = library
            .series_entries
            .get(sid)
            .and_then(|id| library.entries.get(id))
        {
            let mut item = entry.media.clone();
            item.title = row["title"].as_str().unwrap_or_default().to_string();
            pending |= library.metadata.overlay(&mut item, true, false);
            row["title"] = item.title.into();
            let extra = serde_json::to_value(&item.presentation)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            for key in [
                "fileTitle",
                "metadataSource",
                "metadataUrl",
                "metadataExpiresAt",
            ] {
                if let Some(value) = extra.get(key) {
                    row[key] = value.clone();
                }
            }
            if let Some(path) = item.presentation.poster_path {
                row["posterPath"] = path.into();
            }
        }
    }
    value["metadataPending"] = pending.into();
    Ok(Json(value))
}
async fn seasons(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let query = catalog::CatalogQuery {
        series: Some(id.clone()),
        ..Default::default()
    };
    query.validate().map_err(|_| StatusCode::BAD_REQUEST)?;
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let value = catalog::seasons(&db, &id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if value["items"].as_array().is_none_or(Vec::is_empty) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(value))
}

impl Entry {
    fn fingerprint(&self, local_root: Option<&Path>) -> String {
        let stamp = self
            .remote
            .as_ref()
            .map(|r| r.modified_ns.clone())
            .unwrap_or_else(|| format!("{:?}", self.modified));
        let base = format!("{}\0{}\0{}", self.media.id, self.media.size_bytes, stamp);
        let namespaced = local_root
            .map(|root| format!("shinema-local-cache-v1\0{}\0{base}", media_id(root)))
            .unwrap_or(base);
        format!("{:x}", Sha256::digest(namespaced.as_bytes()))
    }
}
async fn verify_source(library: &Library, entry: &Entry) -> Result<(), StatusCode> {
    if let Some(remote) = &library.remote {
        remote
            .stat(entry.remote.as_ref().ok_or(StatusCode::NOT_FOUND)?)
            .await
            .map_err(|_| StatusCode::CONFLICT)
    } else {
        let path = checked_file(
            library.root.as_ref().ok_or(StatusCode::NOT_FOUND)?,
            &entry.relative,
        )
        .map_err(|_| StatusCode::NOT_FOUND)?;
        let metadata = fs::metadata(path).map_err(|_| StatusCode::NOT_FOUND)?;
        if metadata.len() != entry.media.size_bytes
            || entry
                .modified
                .is_some_and(|stamp| metadata.modified().ok() != Some(stamp))
        {
            return Err(StatusCode::CONFLICT);
        }
        Ok(())
    }
}
async fn playback_info(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<playback::Playback>, StatusCode> {
    let entry = library.entries.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    verify_source(&library, entry).await?;
    library
        .playback
        .metadata(&entry.media, &entry.fingerprint(library.root.as_deref()))
        .await
        .map(Json)
        .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)
}
async fn hls(
    State(library): State<Arc<Library>>,
    ApiPath((id, segment)): ApiPath<(String, String)>,
) -> Result<Response, StatusCode> {
    let entry = library.entries.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    verify_source(&library, entry).await?;
    let metadata = library
        .playback
        .metadata(&entry.media, &entry.fingerprint(library.root.as_deref()))
        .await
        .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    if metadata.mode != "transcode" {
        return Err(StatusCode::NOT_FOUND);
    }
    if segment == "index.m3u8" {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(playback::Engine::playlist(
                metadata.duration_seconds,
                &id,
            )))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }
    let index = segment
        .strip_suffix(".ts")
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or(StatusCode::NOT_FOUND)?;
    if index >= playback::segment_count_public(metadata.duration_seconds) {
        return Err(StatusCode::NOT_FOUND);
    }
    let media = entry.media.clone();
    let fingerprint = entry.fingerprint(library.root.as_deref());
    Ok(playback::segment_response(
        library,
        media,
        fingerprint,
        index,
        metadata.duration_seconds,
    ))
}

async fn metadata_status(State(library): State<Arc<Library>>) -> Json<serde_json::Value> {
    Json(library.metadata.status())
}
async fn media_metadata(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mut item = library
        .entries
        .get(&id)
        .ok_or(StatusCode::NOT_FOUND)?
        .media
        .clone();
    let pending = library.metadata.overlay(&mut item, false, true);
    Ok(Json(
        serde_json::json!({"apiVersion":1,"items":[item],"metadataPending":pending}),
    ))
}

async fn poster(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Response, StatusCode> {
    image_response(library, id, "poster").await
}
async fn backdrop(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Response, StatusCode> {
    image_response(library, id, "backdrop").await
}
async fn image_response(
    library: Arc<Library>,
    id: String,
    kind: &str,
) -> Result<Response, StatusCode> {
    let entry = library.entries.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let bytes = library
        .metadata
        .image(&entry.media, kind == "backdrop")
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else {
        "image/jpeg"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn progress(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Option<Progress>>, StatusCode> {
    if !library.entries.contains_key(&id) {
        return Err(StatusCode::NOT_FOUND);
    }
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut query = db
        .prepare("SELECT position, duration FROM progress WHERE id=?1")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut rows = query
        .query(params![id])
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let value = rows
        .next()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(|row| {
            Ok::<_, rusqlite::Error>(Progress {
                position_seconds: row.get(0)?,
                duration_seconds: row.get(1)?,
            })
        })
        .transpose()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(value))
}

async fn save_progress(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
    Json(value): Json<Progress>,
) -> Result<StatusCode, StatusCode> {
    if !library.entries.contains_key(&id) {
        return Err(StatusCode::NOT_FOUND);
    }
    if !value.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute("INSERT INTO progress(id,position,duration) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET position=excluded.position,duration=excluded.duration", params![id, value.position_seconds, value.duration_seconds]).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// One byte range only. Invalid/multiple/unsatisfiable ranges receive 416.
pub fn byte_range(value: &str, size: u64) -> Result<(u64, u64), &'static str> {
    if size == 0 {
        return Err("Empty file");
    }
    let raw = value.strip_prefix("bytes=").ok_or("Invalid unit")?;
    let (start, end) = raw.split_once('-').ok_or("Invalid range")?;
    if !start.bytes().all(|c| c.is_ascii_digit()) || !end.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Only decimal byte offsets are accepted");
    }
    if start.is_empty() {
        let count = end.parse::<u64>().map_err(|_| "Invalid suffix")?;
        if count == 0 {
            return Err("Zero suffix");
        }
        return Ok((size.saturating_sub(count), size - 1));
    }
    let start = start.parse::<u64>().map_err(|_| "Invalid start")?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().map_err(|_| "Invalid end")?.min(size - 1)
    };
    if start >= size || end < start {
        return Err("Unsatisfiable range");
    }
    Ok((start, end))
}

async fn stream(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let entry = library.entries.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let size = entry.media.size_bytes;
    let remote_permit = if library.remote.is_some() {
        Some(
            library
                .remote_transfers
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?,
        )
    } else {
        None
    };
    let mut local_file = None;
    if let Some(remote) = &library.remote {
        remote
            .stat(entry.remote.as_ref().ok_or(StatusCode::NOT_FOUND)?)
            .await
            .map_err(|_| StatusCode::CONFLICT)?;
    } else {
        let root = library.root.as_ref().ok_or(StatusCode::NOT_FOUND)?;
        checked_file(root, &entry.relative).map_err(|_| StatusCode::NOT_FOUND)?;
        let opened = library
            .directory
            .as_ref()
            .ok_or(StatusCode::NOT_FOUND)?
            .open(&entry.relative)
            .map_err(|_| StatusCode::NOT_FOUND)?;
        let metadata = opened.metadata().map_err(|_| StatusCode::NOT_FOUND)?;
        if !metadata.is_file()
            || metadata.len() != size
            || entry.modified.is_some_and(|stamp| {
                metadata.modified().ok().map(|value| value.into_std()) != Some(stamp)
            })
        {
            return Err(StatusCode::CONFLICT);
        }
        local_file = Some(tokio::fs::File::from_std(opened.into_std()));
    }
    let range = headers.get(header::RANGE);
    let (start, end, status) = match range {
        Some(value) => match value.to_str().ok().and_then(|s| byte_range(s, size).ok()) {
            Some((a, b)) => (a, b, StatusCode::PARTIAL_CONTENT),
            None => {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [(header::CONTENT_RANGE, format!("bytes */{size}"))],
                )
                    .into_response());
            }
        },
        None => (0, size.saturating_sub(1), StatusCode::OK),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let mime = match entry.media.container.as_str() {
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "mov" => "video/quicktime",
        "mpg" | "mpeg" | "vob" => "video/mpeg",
        "wmv" => "video/x-ms-wmv",
        _ => "video/mp4",
    };
    let body = if method == Method::HEAD {
        Body::empty()
    } else if let Some(remote) = &library.remote {
        let reader = remote
            .stream(
                entry.remote.as_ref().ok_or(StatusCode::NOT_FOUND)?,
                start,
                length,
                remote_permit,
            )
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        Body::from_stream(ReaderStream::new(reader))
    } else {
        let mut file = local_file.ok_or(StatusCode::NOT_FOUND)?;
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Body::from_stream(ReaderStream::new(file.take(length)))
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod cache_identity_tests {
    use super::*;
    #[test]
    fn switching_local_roots_with_same_path_size_and_time_cannot_reuse_cached_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        for (root, bytes) in [(&first, b"first---"), (&second, b"second--")] {
            fs::create_dir(root).unwrap();
            let path = root.join("same.mkv");
            fs::write(&path, bytes).unwrap();
            let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(123456);
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(stamp))
                .unwrap();
        }
        let a = Library::open(&first, &state).unwrap();
        let entry = a.entries.values().next().unwrap();
        let id = entry.media.id.clone();
        let stamp = entry.modified;
        let fingerprint = entry.fingerprint(a.root.as_deref());
        drop(a);
        let b = Library::open(&second, &state).unwrap();
        let entry = b.entries.values().next().unwrap();
        assert_eq!(entry.media.id, id);
        assert_eq!(entry.media.size_bytes, 8);
        assert_eq!(entry.modified, stamp);
        assert_ne!(entry.fingerprint(b.root.as_deref()), fingerprint);
    }
}
