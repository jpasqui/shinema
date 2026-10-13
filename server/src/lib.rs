use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as ApiPath, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::{Connection, params};
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

const MAX_ITEMS: usize = 500;
const MAX_DEPTH: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub title: String,
    pub container: String,
    pub size_bytes: u64,
    pub stream_path: String,
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
}

pub struct Library {
    root: PathBuf,
    directory: cap_std::fs::Dir,
    entries: BTreeMap<String, Entry>,
    database: Mutex<Connection>,
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
        fs::create_dir_all(&resolved)?;
        let state = resolved.canonicalize()?;
        if state.starts_with(&root) || root.starts_with(&state) {
            return Err("State overlaps media root".into());
        }
        let mut entries = BTreeMap::new();
        Self::scan(&root, &root, 0, &mut entries)?;
        let db = Connection::open(state.join("progress.sqlite3"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS progress(id TEXT PRIMARY KEY, position REAL NOT NULL, duration REAL NOT NULL);")?;
        let directory = cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority())?;
        Ok(Arc::new(Self {
            root,
            directory,
            entries,
            database: Mutex::new(db),
        }))
    }

    fn scan(
        root: &Path,
        directory: &Path,
        depth: usize,
        entries: &mut BTreeMap<String, Entry>,
    ) -> std::io::Result<()> {
        let mut children = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if depth < MAX_DEPTH {
                    Self::scan(root, &path, depth + 1, entries)?;
                }
                continue;
            }
            if !metadata.is_file() || entries.len() >= MAX_ITEMS {
                continue;
            }
            let extension = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "mp4" | "m4v" | "mkv" | "webm") {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| std::io::ErrorKind::PermissionDenied)?
                .to_path_buf();
            checked_file(root, &relative)?;
            let stable = relative.to_string_lossy().replace('\\', "/");
            let id = format!("{:x}", Sha256::digest(stable.as_bytes()));
            let title = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .chars()
                .take(200)
                .collect::<String>()
                .replace('_', " ");
            entries.insert(
                id.clone(),
                Entry {
                    media: Media {
                        stream_path: format!("/api/media/{id}/stream"),
                        id,
                        title,
                        container: extension,
                        size_bytes: metadata.len(),
                    },
                    relative,
                },
            );
        }
        Ok(())
    }
}

pub fn router(library: Arc<Library>) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok","apiVersion":1})) }),
        )
        .route("/api/catalog", get(catalog))
        .route("/api/media/{id}/stream", get(stream))
        .route("/api/media/{id}/progress", get(progress).put(save_progress))
        .layer(DefaultBodyLimit::max(4096))
        .with_state(library)
}

async fn catalog(State(library): State<Arc<Library>>) -> Json<serde_json::Value> {
    let mut items = library
        .entries
        .values()
        .map(|entry| entry.media.clone())
        .collect::<Vec<_>>();
    items.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
    Json(serde_json::json!({"apiVersion":1,"items":items}))
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
    checked_file(&library.root, &entry.relative).map_err(|_| StatusCode::NOT_FOUND)?;
    // Open relative to a directory capability, so a rename/link race cannot
    // turn a catalog entry into an ambient filesystem open outside the root.
    let opened = library
        .directory
        .open(&entry.relative)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !opened
        .metadata()
        .map_err(|_| StatusCode::NOT_FOUND)?
        .is_file()
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let mut file = tokio::fs::File::from_std(opened.into_std());
    let size = file
        .metadata()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .len();
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
        _ => "video/mp4",
    };
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
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
