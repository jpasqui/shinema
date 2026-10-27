use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Extension, Path as ApiPath, Query, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

mod artwork;
mod cache_lease;
mod catalog;
mod content_registry;
pub mod devices;
mod libraries;
mod metadata;
mod playback;
mod request_boundary;
pub mod requests;
mod ssh;
mod web;
pub use catalog::Classification;
pub use ssh::SshConfig;
mod state_files;
mod subtitles;

#[cfg(test)]
mod performance_budgets;

#[cfg(not(test))]
type EntryIndex = BTreeMap<String, Entry>;
#[cfg(test)]
use performance_budgets::EntryIndex;
#[cfg(test)]
mod performance_tests;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub title: String,
    pub container: String,
    #[cfg_attr(test, ts(as = "f64"))]
    pub size_bytes: u64,
    pub stream_path: String,
    #[serde(flatten)]
    pub classification: Classification,
    #[serde(flatten)]
    pub presentation: Presentation,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", default)]
pub struct Presentation {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub poster_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub backdrop_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub year: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(optional, as = "Option<Vec<String>>"))]
    pub genres: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub file_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub file_year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub metadata_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub metadata_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, as = "Option<f64>"))]
    pub metadata_expires_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub position_seconds: f64,
    pub duration_seconds: f64,
    /// Milliseconds since the Unix epoch when the client observed this
    /// position. The server keeps the newest write; an omitted value means
    /// "now", which preserves the original last-write-wins behaviour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, as = "Option<f64>"))]
    pub updated_at: Option<u64>,
}

/// Result of a library scan, reported at startup and by rescans.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub media: u32,
    /// Folders and files that could not be read and were skipped.
    pub unreadable: u32,
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

    /// Started but not finished, by the same rule as the clients'
    /// `watchState` (packages/core/src/progress-types.ts), so the
    /// continue-watching list and the Resume button always agree.
    pub fn in_progress(&self) -> bool {
        let (position, duration) = (self.position_seconds, self.duration_seconds);
        let remaining = duration - position;
        let watched = position / duration >= 0.95
            || (remaining <= 30.0 && duration > 120.0)
            || remaining <= 3.0;
        !watched && position >= 10.0
    }
}

/// One title on the continue-watching list.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ContinueItem {
    pub media: Media,
    pub progress: Progress,
}

#[derive(Clone)]
struct Entry {
    media: Media,
    relative: PathBuf,
    remote: Option<ssh::RemoteEntry>,
    modified: Option<std::time::SystemTime>,
}

/// The scanned media and folders. Rescans build a new one and swap it in.
struct Index {
    entries: EntryIndex,
    source_folders: BTreeSet<String>,
}

pub struct Library {
    root: Option<PathBuf>,
    directory: Option<cap_std::fs::Dir>,
    remote: Option<SshConfig>,
    remote_transfers: Arc<tokio::sync::Semaphore>,
    index: RwLock<Arc<Index>>,
    rescanning: tokio::sync::Mutex<()>,
    database: Mutex<Connection>,
    playback: playback::Engine,
    subtitles: subtitles::Engine,
    metadata: Arc<metadata::Engine>,
    artwork: artwork::Variants,
    devices: devices::Registry,
    web_root: Option<PathBuf>,
}

const REMOTE_PERMIT_WAIT: Duration = Duration::from_secs(30);

fn open_state_database(state: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open_with_flags(
        state.join("progress.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS progress(id TEXT PRIMARY KEY, position REAL NOT NULL, duration REAL NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);")?;
    // Databases created before progress ordering lack the timestamp column.
    let ordered = db
        .prepare("SELECT 1 FROM pragma_table_info('progress') WHERE name='updated_at'")?
        .exists([])?;
    if !ordered {
        db.execute_batch("ALTER TABLE progress ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;")?;
    }
    devices::initialize(&db)?;
    Ok(db)
}

fn prepare_entries(entries: &mut BTreeMap<String, Entry>) {
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
}

fn rebuild_catalog(
    db: &mut Connection,
    entries: &BTreeMap<String, Entry>,
    source_folders: &BTreeSet<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let configuration = libraries::initialize(db, entries, source_folders)?;
    catalog::replace_index(db, libraries::assign(entries, &configuration).into_iter())?;
    Ok(())
}

fn report_scan(report: &ScanReport) {
    if report.unreadable > 0 {
        eprintln!(
            "Shinema indexed {} media files; skipped {} unreadable folders or files",
            report.media, report.unreadable
        );
    } else {
        eprintln!("Shinema indexed {} media files", report.media);
    }
}

type ScannedEntries = (BTreeMap<String, Entry>, BTreeSet<String>);

fn remote_entries(
    config: &SshConfig,
    scan: ssh::Scan,
) -> Result<ScannedEntries, Box<dyn std::error::Error>> {
    let mut entries = BTreeMap::new();
    let mut source_folders = config.roots.keys().cloned().collect::<BTreeSet<_>>();
    for record in scan.items {
        let relative = PathBuf::from(&record.relative);
        let mut parent = relative.parent();
        while let Some(folder) = parent.filter(|folder| !folder.as_os_str().is_empty()) {
            source_folders.insert(
                folder
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/"),
            );
            parent = folder.parent();
        }
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
                Sha256::digest(format!("{}\0{}\0{}", config.destination, root, series).as_bytes())
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
        if !content_registry::supports_play(None, &container) {
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
    Ok((entries, source_folders))
}

fn record_remote_scan(db: &Connection, scan: &ssh::ScanCounts) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS scan_summary(files_seen INTEGER,ignored_files INTEGER,links_skipped INTEGER);")?;
    db.execute("DELETE FROM scan_summary", [])?;
    db.execute(
        "INSERT INTO scan_summary VALUES (?1,?2,?3)",
        params![scan.files_seen, scan.ignored_files, scan.links_skipped],
    )?;
    Ok(())
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
        let mut source_folders = BTreeSet::from([".".to_string()]);
        let unreadable = Self::scan(&root, &mut entries, &mut source_folders)?;
        report_scan(&ScanReport {
            media: entries.len() as u32,
            unreadable,
        });
        state_files::validate(&state)?;
        let playback = playback::Engine::new(&state)?;
        let mut db = open_state_database(&state)?;
        state_files::validate(&state)?;
        prepare_entries(&mut entries);
        rebuild_catalog(&mut db, &entries, &source_folders)?;
        let directory = cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority())?;
        #[cfg(test)]
        let entries = EntryIndex::from(entries);
        Ok(Arc::new(Self {
            root: Some(root),
            directory: Some(directory),
            remote: None,
            remote_transfers: Arc::new(tokio::sync::Semaphore::new(4)),
            index: RwLock::new(Arc::new(Index {
                entries,
                source_folders,
            })),
            rescanning: tokio::sync::Mutex::new(()),
            database: Mutex::new(db),
            playback,
            subtitles: subtitles::Engine::new(),
            metadata: metadata::Engine::new(&state)?,
            artwork: artwork::Variants::new(&state)?,
            devices: devices::Registry::new(),
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
        let counts = scan.counts();
        let (mut entries, source_folders) = remote_entries(&config, scan)?;
        report_scan(&ScanReport {
            media: entries.len() as u32,
            unreadable: counts.unreadable as u32,
        });
        state_files::create_private_directory(state_dir)?;
        let state = state_dir.canonicalize()?;
        state_files::validate(&state)?;
        let playback = playback::Engine::new(&state)?;
        let mut db = open_state_database(&state)?;
        state_files::validate(&state)?;
        prepare_entries(&mut entries);
        rebuild_catalog(&mut db, &entries, &source_folders)?;
        record_remote_scan(&db, &counts)?;
        #[cfg(test)]
        let entries = EntryIndex::from(entries);
        Ok(Arc::new(Self {
            root: None,
            directory: None,
            remote: Some(config),
            remote_transfers: Arc::new(tokio::sync::Semaphore::new(4)),
            index: RwLock::new(Arc::new(Index {
                entries,
                source_folders,
            })),
            rescanning: tokio::sync::Mutex::new(()),
            database: Mutex::new(db),
            playback,
            subtitles: subtitles::Engine::new(),
            metadata: metadata::Engine::new(&state)?,
            artwork: artwork::Variants::new(&state)?,
            devices: devices::Registry::new(),
            web_root: web::configured()?,
        }))
    }

    /// The current scan. Callers hold the snapshot for the whole request so
    /// a concurrent rescan cannot change entries underneath them.
    fn index(&self) -> Arc<Index> {
        match self.index.read() {
            Ok(index) => index.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn entry(&self, id: &str) -> Option<Entry> {
        self.index().entries.get(id).cloned()
    }

    /// A pairing code to print at startup, only while no device is paired.
    pub fn startup_pairing_code(&self) -> Option<devices::PairingCode> {
        let db = self.database.lock().ok()?;
        if devices::Registry::has_devices(&db) {
            return None;
        }
        drop(db);
        self.devices.create_code().ok()
    }

    /// Scans the media again and swaps in the result. Media IDs are derived
    /// from paths, so saved progress and library assignments carry over.
    pub async fn rescan(self: &Arc<Self>) -> Result<ScanReport, String> {
        let _running = self.rescanning.lock().await;
        let (mut entries, source_folders, unreadable, counts) = if let Some(config) = &self.remote {
            let scan = config.scan().await.map_err(|error| error.to_string())?;
            let counts = scan.counts();
            let (entries, folders) =
                remote_entries(config, scan).map_err(|error| error.to_string())?;
            (entries, folders, counts.unreadable as u32, Some(counts))
        } else {
            let root = self.root.clone().ok_or("No media root")?;
            tokio::task::spawn_blocking(move || {
                let mut entries = BTreeMap::new();
                let mut folders = BTreeSet::from([".".to_string()]);
                let unreadable = Self::scan(&root, &mut entries, &mut folders)
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>((entries, folders, unreadable, None))
            })
            .await
            .map_err(|error| error.to_string())??
        };
        prepare_entries(&mut entries);
        let library = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut db = library
                .database
                .lock()
                .map_err(|_| "Database unavailable".to_string())?;
            rebuild_catalog(&mut db, &entries, &source_folders)
                .map_err(|error| error.to_string())?;
            if let Some(counts) = &counts {
                record_remote_scan(&db, counts).map_err(|error| error.to_string())?;
            }
            let report = ScanReport {
                media: entries.len() as u32,
                unreadable,
            };
            #[cfg(test)]
            let entries = EntryIndex::from(entries);
            // Swap while holding the database lock so the catalog and the
            // in-memory index always describe the same scan.
            *library
                .index
                .write()
                .map_err(|_| "Index unavailable".to_string())? = Arc::new(Index {
                entries,
                source_folders,
            });
            Ok(report)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// Walks the media root. The root itself must be readable; any folder or
    /// file below it that cannot be read is skipped and counted, so one locked
    /// folder or a file removed mid-scan never stops the server.
    fn scan(
        root: &Path,
        entries: &mut BTreeMap<String, Entry>,
        source_folders: &mut BTreeSet<String>,
    ) -> std::io::Result<u32> {
        let mut unreadable = 0_u32;
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let listing = match fs::read_dir(&directory) {
                Ok(listing) => listing,
                Err(error) if directory == root => return Err(error),
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            let mut children = Vec::new();
            for child in listing {
                match child {
                    Ok(child) => children.push(child),
                    Err(_) => unreadable += 1,
                }
            }
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                let path = child.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    unreadable += 1;
                    continue;
                };
                if metadata.file_type().is_symlink() {
                    continue;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                    {
                        continue;
                    }
                }
                if metadata.is_dir() {
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|_| std::io::ErrorKind::PermissionDenied)?;
                    if relative.to_str().is_some() {
                        source_folders.insert(
                            relative
                                .components()
                                .map(|part| part.as_os_str().to_string_lossy())
                                .collect::<Vec<_>>()
                                .join("/"),
                        );
                    }
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
                if !content_registry::supports_play(None, &extension) {
                    continue;
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| std::io::ErrorKind::PermissionDenied)?
                    .to_path_buf();
                if checked_file(root, &relative).is_err() {
                    unreadable += 1;
                    continue;
                }
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
        Ok(unreadable)
    }
}

pub fn router(library: Arc<Library>) -> Router {
    router_at(library, "127.0.0.1:8787".parse().expect("Loopback literal"))
}
pub fn router_at(library: Arc<Library>, bind: std::net::SocketAddr) -> Router {
    configured_router(
        library,
        bind,
        std::env::var("SHINEMA_ADMIN_TOKEN").ok(),
        requests::Engine::disabled(),
    )
}

/// Explicit operator configuration for embedders and isolated synthetic tests.
/// Short or invalid tokens disable management just as an absent token does.
pub fn router_with_admin_token(library: Arc<Library>, token: Option<String>) -> Router {
    configured_router(
        library,
        "127.0.0.1:8787".parse().expect("Loopback literal"),
        token,
        requests::Engine::disabled(),
    )
}

/// As `router_with_admin_token`, for an explicit bind address. A
/// non-loopback address requires paired device tokens.
pub fn router_at_with_admin_token(
    library: Arc<Library>,
    bind: std::net::SocketAddr,
    token: Option<String>,
) -> Router {
    configured_router(library, bind, token, requests::Engine::disabled())
}

pub fn router_at_with_requests(
    library: Arc<Library>,
    bind: std::net::SocketAddr,
    requests: Arc<requests::Engine>,
) -> Router {
    configured_router(
        library,
        bind,
        std::env::var("SHINEMA_ADMIN_TOKEN").ok(),
        requests,
    )
}

fn configured_router(
    library: Arc<Library>,
    bind: std::net::SocketAddr,
    token: Option<String>,
    requests: Arc<requests::Engine>,
) -> Router {
    library.playback.set_origin(bind);
    library.subtitles.set_origin(bind);
    let exposure = devices::Exposure::for_bind(bind);
    library.devices.set_exposure(exposure);
    Router::new()
        .route(
            "/health",
            get(|State(library):State<Arc<Library>>| async move { Json(serde_json::json!({"status":"ok","apiVersion":1,"authRequired":library.devices.auth_required(),"playback":library.playback.statistics()})) }),
        )
        .route("/api/session", get(devices::session))
        .route("/api/pairing/codes", post(devices::create_code))
        .route("/api/pairing/claim", post(devices::claim))
        .route("/api/devices", get(devices::list))
        .route("/api/devices/{id}", delete(devices::revoke))
        .route("/api/admin/rescan", post(rescan))
        .route("/api/catalog", get(catalog))
        .route("/api/library", get(library_summary))
        .route("/api/libraries", get(libraries_public))
        .route("/api/content-registry", get(registry_public))
        .route("/api/admin/libraries", get(libraries_admin).put(libraries_save).layer(DefaultBodyLimit::max(65_536)).layer(axum::middleware::from_fn(libraries::management_guard)))
        .route("/api/series", get(series))
        .route("/api/series/{id}/seasons", get(seasons))
        .route("/api/media/{id}/stream", get(stream))
        .route("/api/media/{id}/metadata",get(media_metadata))
        .route("/api/metadata/status",get(metadata_status))
        .route("/api/media/{id}/poster",get(poster))
        .route("/api/media/{id}/backdrop",get(backdrop))
        .route("/api/media/{id}/playback", get(playback_info))
        .route("/api/media/{id}/subtitles", get(subtitles::list))
        .route("/api/media/{id}/subtitles/{track}", get(subtitles::content))
        .route("/api/media/{id}/hls/{segment}", get(hls))
        .route("/api/media/{id}/progress", get(progress).put(save_progress))
        .route("/api/continue", get(continue_watching))
        .layer(DefaultBodyLimit::max(4096))
        .fallback(static_web)
        .layer(axum::middleware::from_fn_with_state(
            library.clone(),
            devices::guard,
        ))
        .layer(Extension(libraries::ManagementAccess::new(token)))
        .with_state(library)
        .merge(requests::router(requests, bind))
        .layer(axum::middleware::from_fn_with_state(
            exposure,
            request_boundary::guard,
        ))
}

/// Runs synchronous SQLite and filesystem work off the async worker threads.
/// Tests run it inline so per-thread work counters still observe it.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, StatusCode> + Send + 'static,
) -> Result<T, StatusCode> {
    if cfg!(test) {
        return work();
    }
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn rescan(State(library): State<Arc<Library>>) -> Result<Json<ScanReport>, StatusCode> {
    library
        .rescan()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn libraries_public(
    State(library): State<Arc<Library>>,
) -> Result<impl IntoResponse, StatusCode> {
    let index = library.index();
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let value = libraries::read(&db, false, &index.source_folders)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)))
}

async fn registry_public(
    State(library): State<Arc<Library>>,
) -> Result<impl IntoResponse, StatusCode> {
    let index = library.index();
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let value = libraries::read(&db, false, &index.source_folders)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(value["registry"].clone()),
    ))
}

async fn libraries_admin(
    State(library): State<Arc<Library>>,
) -> Result<impl IntoResponse, StatusCode> {
    let index = library.index();
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let value = libraries::read(&db, true, &index.source_folders)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)))
}

async fn libraries_save(
    State(library): State<Arc<Library>>,
    Json(value): Json<libraries::Update>,
) -> Result<impl IntoResponse, StatusCode> {
    let mut db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Read the index under the database lock: a rescan swaps both together.
    let index = library.index();
    libraries::update(&mut db, value, &index.entries, &index.source_folders)?;
    let value = libraries::read(&db, true, &index.source_folders)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)))
}

fn check_revision(db: &Connection, query: &catalog::CatalogQuery) -> Result<(), StatusCode> {
    if let Some(requested) = query.revision {
        let revision: u64 = db
            .query_row(
                "SELECT revision FROM library_configuration WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if requested != revision {
            return Err(StatusCode::CONFLICT);
        }
    }
    Ok(())
}

fn current_media(library: &Library, id: &str) -> Result<Media, StatusCode> {
    if !library.index().entries.contains_key(id) {
        return Err(StatusCode::NOT_FOUND);
    }
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let json: String = db
        .query_row(
            "SELECT media_json FROM media_catalog WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    serde_json::from_str(&json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn require_playable(library: &Library, id: &str) -> Result<(), StatusCode> {
    let item = current_media(library, id)?;
    if !content_registry::supports_play(
        item.classification.content_type_id.as_deref(),
        &item.container,
    ) {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    Ok(())
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
    blocking(move || catalog_page(&library, query))
        .await
        .map(Json)
}

fn catalog_page(
    library: &Library,
    query: catalog::CatalogQuery,
) -> Result<serde_json::Value, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    check_revision(&db, &query)?;
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
    Ok(value)
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
    blocking(move || series_page(&library, query))
        .await
        .map(Json)
}

fn series_page(
    library: &Library,
    query: catalog::CatalogQuery,
) -> Result<serde_json::Value, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    check_revision(&db, &query)?;
    let (mut value, representatives) = catalog::series_with_representatives(&db, query)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Metadata overlays read files and their own cache; holding the catalog
    // lock through them would stall streaming and progress saves.
    drop(db);
    let mut pending = false;
    for row in value["items"]
        .as_array_mut()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let sid = row["id"].as_str().unwrap_or_default();
        // The page query selects representatives from the same canonical
        // snapshot as membership and classification, including live edits.
        #[cfg(test)]
        crate::performance_budgets::record_representative_lookup();
        {
            let mut item = representatives
                .get(sid)
                .cloned()
                .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
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
    Ok(value)
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
    require_playable(&library, &id)?;
    let entry = library.entry(&id).ok_or(StatusCode::NOT_FOUND)?;
    let entry = &entry;
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
    require_playable(&library, &id)?;
    let entry = library.entry(&id).ok_or(StatusCode::NOT_FOUND)?;
    let entry = &entry;
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
    let mut item = current_media(&library, &id)?;
    let pending = library.metadata.overlay(&mut item, false, true);
    Ok(Json(
        serde_json::json!({"apiVersion":1,"items":[item],"metadataPending":pending}),
    ))
}

/// `w` asks for artwork no wider than that many pixels. Widths snap to a
/// small fixed set so the variant cache stays bounded.
#[derive(Deserialize, Default)]
struct ArtworkQuery {
    w: Option<u32>,
}

async fn poster(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
    Query(query): Query<ArtworkQuery>,
) -> Result<Response, StatusCode> {
    image_response(library, id, false, query.w).await
}
async fn backdrop(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
    Query(query): Query<ArtworkQuery>,
) -> Result<Response, StatusCode> {
    image_response(library, id, true, query.w).await
}
async fn image_response(
    library: Arc<Library>,
    id: String,
    wide: bool,
    width: Option<u32>,
) -> Result<Response, StatusCode> {
    let width = width
        .map(|value| artwork::snap_width(value).ok_or(StatusCode::BAD_REQUEST))
        .transpose()?;
    let bytes = blocking(move || {
        let item = current_media(&library, &id)?;
        let (key, original) = library
            .metadata
            .image_source(&item, wide)
            .map_err(|_| StatusCode::NOT_FOUND)?;
        match width {
            Some(width) => library
                .artwork
                .variant(&key, &original, width)
                .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY),
            None => Ok(original),
        }
    })
    .await?;
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else {
        "image/jpeg"
    };
    // Sized variants are derived from cached artwork and safe for clients to
    // keep briefly; the original keeps its uncached behaviour.
    let cache = if width.is_some() {
        "private, max-age=3600"
    } else {
        "no-store"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn stored_progress(db: &Connection, id: &str) -> rusqlite::Result<Option<Progress>> {
    db.query_row(
        "SELECT position, duration, updated_at FROM progress WHERE id=?1",
        params![id],
        |row| {
            let updated_at: u64 = row.get(2)?;
            Ok(Progress {
                position_seconds: row.get(0)?,
                duration_seconds: row.get(1)?,
                updated_at: (updated_at > 0).then_some(updated_at),
            })
        },
    )
    .optional()
}

async fn progress(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Option<Progress>>, StatusCode> {
    if !library.index().entries.contains_key(&id) {
        return Err(StatusCode::NOT_FOUND);
    }
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    stored_progress(&db, &id)
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ContinueQuery {
    limit: Option<usize>,
}

/// Titles started but not finished, most recently watched first, with their
/// artwork and saved position. Progress for media no longer in the library
/// is left out.
async fn continue_watching(
    State(library): State<Arc<Library>>,
    Query(query): Query<ContinueQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    blocking(move || continue_items(&library, limit))
        .await
        .map(|items| Json(serde_json::json!({ "items": items })))
}

fn continue_items(library: &Library, limit: usize) -> Result<Vec<ContinueItem>, StatusCode> {
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut statement = db
        .prepare(
            "SELECT m.media_json, p.position, p.duration, p.updated_at
             FROM progress p JOIN media_catalog m ON m.id = p.id
             ORDER BY p.updated_at DESC, p.id",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = statement
        .query_map([], |row| {
            let updated_at: u64 = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                Progress {
                    position_seconds: row.get(1)?,
                    duration_seconds: row.get(2)?,
                    updated_at: (updated_at > 0).then_some(updated_at),
                },
            ))
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut items = Vec::new();
    for row in rows {
        let (json, progress) = row.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !progress.in_progress() {
            continue;
        }
        let media: Media =
            serde_json::from_str(&json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        items.push(ContinueItem { media, progress });
        if items.len() == limit {
            break;
        }
    }
    drop(statement);
    // Metadata overlays read files and their own cache; holding the catalog
    // lock through them would stall streaming and progress saves.
    drop(db);
    for item in &mut items {
        library.metadata.overlay(&mut item.media, false, false);
    }
    Ok(items)
}

/// Keeps the newest position. A write observed before the stored one (an
/// offline device catching up, or a delayed periodic save) is refused with
/// 409 and the stored progress, so the client can adopt it.
async fn save_progress(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
    Json(value): Json<Progress>,
) -> Result<Response, StatusCode> {
    if !library.index().entries.contains_key(&id) {
        return Err(StatusCode::NOT_FOUND);
    }
    if !value.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Future client clocks are clamped so one device cannot pin progress.
    let now = devices::now_millis();
    let observed = value.updated_at.map_or(now, |stamp| stamp.min(now));
    let db = library
        .database
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let changed = db
        .execute(
            "INSERT INTO progress(id,position,duration,updated_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at
             WHERE excluded.updated_at>=progress.updated_at",
            params![id, value.position_seconds, value.duration_seconds, observed],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if changed > 0 {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let current = stored_progress(&db, &id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CONFLICT, Json(current)).into_response())
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
    require_playable(&library, &id)?;
    let entry = library.entry(&id).ok_or(StatusCode::NOT_FOUND)?;
    let entry = &entry;
    let size = entry.media.size_bytes;
    // Paused players can hold all remote transfers; fail fast instead of
    // queueing forever behind them.
    let remote_permit = if library.remote.is_some() {
        Some(
            tokio::time::timeout(
                REMOTE_PERMIT_WAIT,
                library.remote_transfers.clone().acquire_owned(),
            )
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
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
    let mime = content_registry::format(&entry.media.container)
        .and_then(|format| format.mime_types.first())
        .ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
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
        let index = a.index();
        let entry = index.entries.values().next().unwrap();
        let id = entry.media.id.clone();
        let stamp = entry.modified;
        let fingerprint = entry.fingerprint(a.root.as_deref());
        drop(a);
        let b = Library::open(&second, &state).unwrap();
        let index = b.index();
        let entry = index.entries.values().next().unwrap();
        assert_eq!(entry.media.id, id);
        assert_eq!(entry.media.size_bytes, 8);
        assert_eq!(entry.modified, stamp);
        assert_ne!(entry.fingerprint(b.root.as_deref()), fingerprint);
    }
}
