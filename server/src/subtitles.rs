//! Read-only subtitle discovery and plain WebVTT delivery. Sidecars are opened
//! through the media directory capability; client-supplied IDs never become paths.
use crate::{Entry, Library};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path as ApiPath, State},
    http::{StatusCode, header},
    response::Response,
};
use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, ChildStdout, Command},
    sync::Semaphore,
    time::{Duration, timeout},
};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRACKS: usize = 64;
const MAX_DIRECTORY_ENTRIES: usize = 4096;
const MAX_CUES: usize = 20_000;
const MAX_CUE_BYTES: usize = 16 * 1024;
const MAX_TIME_MS: u64 = 604_800_000;
const FORMATS: &str = "mov,matroska,webm,avi,mpegts,mpeg,asf";

fn unsupported_codec(codec: &str) -> Option<&'static str> {
    match codec {
        "subrip" | "webvtt" | "mov_text" => None,
        "ass" | "ssa" => Some("Styled ASS/SSA subtitles are not supported in this milestone."),
        "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub" => {
            Some("Image subtitles require OCR or burn-in and are not supported.")
        }
        _ => Some("This subtitle codec is not supported in this milestone."),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    default: bool,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unsupported_reason: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracks {
    tracks: Vec<Track>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<&'static str>,
}

#[derive(Clone)]
struct Embedded {
    track: Track,
    index: u32,
}
struct External {
    track: Track,
    relative: PathBuf,
    vtt: bool,
}
pub struct Engine {
    origin: Mutex<String>,
    jobs: Semaphore,
    embedded: Mutex<BTreeMap<String, Vec<Embedded>>>,
}

fn failure(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
impl Engine {
    pub fn new() -> Self {
        Self {
            origin: Mutex::new("http://127.0.0.1:8787".into()),
            jobs: Semaphore::new(2),
            embedded: Mutex::new(BTreeMap::new()),
        }
    }
    pub fn set_origin(&self, bind: std::net::SocketAddr) {
        if bind.ip().is_loopback() {
            *self.origin.lock().expect("Subtitle origin lock") = format!("http://{bind}");
        }
    }
    fn source(&self, entry: &Entry) -> String {
        format!(
            "{}{}",
            self.origin.lock().expect("Subtitle origin lock"),
            entry.media.stream_path
        )
    }
    async fn embedded(&self, library: &Library, entry: &Entry) -> io::Result<Vec<Embedded>> {
        let fingerprint = entry.fingerprint(library.root.as_deref());
        if let Some(value) = self.embedded.lock().unwrap().get(&fingerprint) {
            return Ok(value.clone());
        }
        let _permit = self
            .jobs
            .acquire()
            .await
            .map_err(|_| failure("Subtitle shutdown"))?;
        if let Some(value) = self.embedded.lock().unwrap().get(&fingerprint) {
            return Ok(value.clone());
        }
        let mut command = Command::new("ffprobe");
        command
            .args([
                "-v",
                "error",
                "-max_alloc",
                "16777216",
                "-rw_timeout",
                "10000000",
                "-protocol_whitelist",
                "http,tcp",
                "-format_whitelist",
                FORMATS,
                "-analyzeduration",
                "1000000",
                "-probesize",
                "1048576",
                "-select_streams",
                "s",
                "-show_entries",
                "stream=index,codec_name:stream_tags=language,title:stream_disposition=default",
                "-of",
                "json",
            ])
            .arg(self.source(entry));
        let bytes = process_output(command, 256 * 1024, 30).await?;
        let probe: Probe =
            serde_json::from_slice(&bytes).map_err(|_| failure("Invalid subtitle probe"))?;
        if probe.streams.len() > MAX_TRACKS {
            return Err(failure("Too many embedded subtitle tracks"));
        }
        let tracks = probe
            .streams
            .into_iter()
            .map(|stream| {
                let codec = stream.codec_name.unwrap_or_else(|| "unknown".into());
                let reason = unsupported_codec(&codec);
                let id = format!("embedded-{}", stream.index);
                let language = stream.tags.language.filter(|value| valid_language(value));
                let label = clean_label(
                    &stream
                        .tags
                        .title
                        .map(|title| clean_label(&title))
                        .filter(|title| !title.is_empty())
                        .unwrap_or_else(|| {
                            format!(
                                "{} ({})",
                                language.as_deref().unwrap_or("Embedded"),
                                clean_label(&codec)
                            )
                        }),
                );
                Embedded {
                    track: Track {
                        content_path: reason
                            .is_none()
                            .then(|| format!("/api/media/{}/subtitles/{id}.vtt", entry.media.id)),
                        id,
                        label,
                        language,
                        default: stream.disposition.default == 1,
                        source: "embedded",
                        unsupported_reason: reason,
                    },
                    index: stream.index,
                }
            })
            .collect::<Vec<_>>();
        let mut cache = self.embedded.lock().unwrap();
        if cache.len() >= 128
            && let Some(oldest) = cache.keys().next().cloned()
        {
            cache.remove(&oldest);
        }
        cache.insert(fingerprint, tracks.clone());
        Ok(tracks)
    }
    async fn extract(&self, entry: &Entry, index: u32) -> io::Result<Bytes> {
        let _permit = self
            .jobs
            .acquire()
            .await
            .map_err(|_| failure("Subtitle shutdown"))?;
        let mut command = Command::new("ffmpeg");
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-max_alloc",
                "16777216",
                "-rw_timeout",
                "10000000",
                "-protocol_whitelist",
                "http,tcp",
                "-format_whitelist",
                FORMATS,
                "-analyzeduration",
                "1000000",
                "-probesize",
                "1048576",
                "-i",
            ])
            .arg(self.source(entry))
            .args([
                "-map",
                &format!("0:{index}"),
                "-t",
                "604800",
                "-vn",
                "-an",
                "-dn",
                "-c:s",
                "webvtt",
                "-f",
                "webvtt",
                "pipe:1",
            ]);
        let bytes = process_output(command, MAX_BYTES, 60).await?;
        normalize(&bytes, true).map(Bytes::from)
    }
}

#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    streams: Vec<ProbeStream>,
}
#[derive(Deserialize)]
struct ProbeStream {
    index: u32,
    codec_name: Option<String>,
    #[serde(default)]
    tags: ProbeTags,
    #[serde(default)]
    disposition: Disposition,
}
#[derive(Deserialize, Default)]
struct ProbeTags {
    language: Option<String>,
    title: Option<String>,
}
#[derive(Deserialize, Default)]
struct Disposition {
    #[serde(default)]
    default: u8,
}

fn valid_language(value: &str) -> bool {
    let mut parts = value.split('-');
    let first = parts.next().unwrap_or_default();
    (2..=3).contains(&first.len())
        && first.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.clone().count() <= 3
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}
fn clean_label(value: &str) -> String {
    value
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '<' | '>')
        })
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}
fn valid_track_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// Open one component at a time. Every directory handle remains confined to the
// original capability, even if an ancestor is renamed during a request.
fn parent_directory(root: &Dir, relative: &Path) -> io::Result<Dir> {
    let mut directory = root.try_clone()?;
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        let Component::Normal(name) = component else {
            return Err(failure("Invalid media path"));
        };
        let metadata = directory.symlink_metadata(name)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(failure("Linked media directory"));
        }
        #[cfg(windows)]
        {
            use cap_std::fs::MetadataExt;
            if metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0
            {
                return Err(failure("Reparse media directory"));
            }
        }
        let handle = directory.into_std_file();
        directory = Dir::from_std_file(cap_primitives::fs::open_dir_nofollow(
            &handle,
            Path::new(name),
        )?);
    }
    Ok(directory)
}
fn ordinary_file(directory: &Dir, name: &Path) -> io::Result<std::fs::File> {
    if name.components().count() != 1
        || !matches!(name.components().next(), Some(Component::Normal(_)))
    {
        return Err(failure("Invalid subtitle name"));
    }
    let metadata = directory.symlink_metadata(name)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failure("Linked subtitle file"));
    }
    let mut options = OpenOptions::new();
    // cap-primitives exposes this extension hook for cap-fs-ext; setting it is
    // essential because OS flags alone do not disable the capability resolver's
    // deliberate handling of a final symlink.
    options
        .read(true)
        ._cap_fs_ext_follow(cap_primitives::fs::FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let file = directory.open_with(name, &options)?.into_std();
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err(failure("Subtitle size or type is unsupported"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(failure("Hardlinked subtitle file"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: a live read-only file handle and correctly sized output buffer.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.nNumberOfLinks != 1
        {
            return Err(failure("Linked subtitle file"));
        }
    }
    Ok(file)
}
fn external(library: &Library, entry: &Entry) -> io::Result<(Vec<External>, bool)> {
    let Some(root) = &library.directory else {
        return Ok((Vec::new(), false));
    };
    let Some(stem) = entry.relative.file_stem().and_then(|stem| stem.to_str()) else {
        return Ok((Vec::new(), false));
    };
    let directory = parent_directory(root, &entry.relative)?;
    let mut candidates = Vec::new();
    let mut limited = false;
    for (count, child) in directory.entries()?.enumerate() {
        if count >= MAX_DIRECTORY_ENTRIES {
            limited = true;
            break;
        }
        let name = child?.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let path = Path::new(name);
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["srt", "vtt", "ass", "ssa", "sub", "idx", "sup"].contains(&extension.as_str()) {
            continue;
        }
        let candidate_stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let suffix = if candidate_stem == stem {
            ""
        } else if let Some(suffix) = candidate_stem
            .strip_prefix(stem)
            .and_then(|value| value.strip_prefix('.'))
        {
            suffix
        } else {
            continue;
        };
        // Ignore links, special files, oversized files, and names which changed
        // while enumerating. Never reveal their existence in the API.
        if ordinary_file(&directory, path).is_err() {
            continue;
        }
        if candidates.len() >= MAX_TRACKS {
            limited = true;
            break;
        }
        let id = format!(
            "external-{:x}",
            Sha256::digest(format!("{}\0{name}", entry.media.id).as_bytes())
        );
        let language = suffix
            .split('.')
            .find(|part| valid_language(part) && !["sdh", "off", "ass", "sub"].contains(part))
            .map(str::to_string);
        let default = suffix
            .split('.')
            .any(|part| part.eq_ignore_ascii_case("default"));
        let reason = match extension.as_str() {
            "srt" | "vtt" => None,
            "ass" | "ssa" => Some("Styled ASS/SSA subtitles are not supported in this milestone."),
            _ => Some("Image or legacy subtitle sidecars are not supported in this milestone."),
        };
        let suffix_label = clean_label(suffix);
        let label = format!(
            "{}External {}",
            if suffix_label.is_empty() {
                String::new()
            } else {
                format!("{suffix_label} · ")
            },
            extension.to_ascii_uppercase()
        );
        candidates.push(External {
            relative: PathBuf::from(name),
            vtt: extension == "vtt",
            track: Track {
                content_path: reason
                    .is_none()
                    .then(|| format!("/api/media/{}/subtitles/{id}.vtt", entry.media.id)),
                id,
                label: clean_label(&label),
                language,
                default,
                source: "external",
                unsupported_reason: reason,
            },
        });
    }
    candidates.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok((candidates, limited))
}
fn external_content(library: &Library, entry: &Entry, selected: &External) -> io::Result<String> {
    let directory = parent_directory(
        library
            .directory
            .as_ref()
            .ok_or_else(|| failure("No local sidecars"))?,
        &entry.relative,
    )?;
    let mut file = ordinary_file(&directory, &selected.relative)?.take(MAX_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    normalize(&bytes, selected.vtt)
}

pub async fn list(
    State(library): State<Arc<Library>>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Tracks>, StatusCode> {
    let entry = library.entries.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    crate::verify_source(&library, entry).await?;
    let mut warnings = Vec::new();
    let mut tracks = match library.subtitles.embedded(&library, entry).await {
        Ok(tracks) => tracks
            .into_iter()
            .map(|value| value.track)
            .collect::<Vec<_>>(),
        Err(_) => {
            warnings.push("Embedded subtitle discovery is unavailable for this media.");
            Vec::new()
        }
    };
    match external(&library, entry) {
        Ok((external, limited)) => {
            tracks.extend(external.into_iter().map(|value| value.track));
            if limited {
                warnings.push("The subtitle directory or track limit was reached.");
            }
        }
        Err(_) => warnings.push("Local subtitle discovery is unavailable for this media."),
    }
    if library.remote.is_some() {
        warnings
            .push("Remote sidecar subtitles are not supported; embedded tracks remain available.");
    }
    if tracks.len() > MAX_TRACKS {
        warnings.push("The combined subtitle track limit was reached.");
        tracks.truncate(MAX_TRACKS);
    }
    Ok(Json(Tracks { tracks, warnings }))
}
pub async fn content(
    State(library): State<Arc<Library>>,
    ApiPath((id, file)): ApiPath<(String, String)>,
) -> Result<Response, StatusCode> {
    let track_id = file
        .strip_suffix(".vtt")
        .filter(|id| valid_track_id(id))
        .ok_or(StatusCode::NOT_FOUND)?;
    let entry = library.entries.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    crate::verify_source(&library, entry).await?;
    let body = if track_id.starts_with("external-") {
        let tracks = external(&library, entry)
            .map_err(|_| StatusCode::NOT_FOUND)?
            .0;
        let selected = tracks
            .iter()
            .find(|track| track.track.id == track_id)
            .ok_or(StatusCode::NOT_FOUND)?;
        if selected.track.content_path.is_none() {
            return Err(StatusCode::UNPROCESSABLE_ENTITY);
        }
        Body::from(
            external_content(&library, entry, selected)
                .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?,
        )
    } else {
        let tracks = library
            .subtitles
            .embedded(&library, entry)
            .await
            .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
        let selected = tracks
            .iter()
            .find(|track| track.track.id == track_id)
            .ok_or(StatusCode::NOT_FOUND)?;
        if selected.track.content_path.is_none() {
            return Err(StatusCode::UNPROCESSABLE_ENTITY);
        }
        let index = selected.index;
        let entry = entry.clone();
        let job = tokio::spawn(async move { library.subtitles.extract(&entry, index).await });
        Body::from_stream(SubtitleBody { job, done: false })
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/vtt; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

struct BoundedProcess {
    child: Child,
    stdout: ChildStdout,
}
impl BoundedProcess {
    fn spawn(mut command: Command) -> io::Result<Self> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failure("Missing subtitle process output"))?;
        Ok(Self { child, stdout })
    }
    async fn read(mut self, limit: usize) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        (&mut self.stdout)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > limit {
            return Err(failure("Subtitle output exceeds limit"));
        }
        if !self.child.wait().await?.success() {
            return Err(failure("Subtitle codec operation failed"));
        }
        Ok(bytes)
    }
}
async fn process_output(command: Command, limit: usize, seconds: u64) -> io::Result<Vec<u8>> {
    timeout(
        Duration::from_secs(seconds),
        BoundedProcess::spawn(command)?.read(limit),
    )
    .await
    .map_err(|_| failure("Subtitle codec operation timed out"))?
}
struct SubtitleBody {
    job: tokio::task::JoinHandle<io::Result<Bytes>>,
    done: bool,
}
impl futures_core::Stream for SubtitleBody {
    type Item = io::Result<Bytes>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }
        match std::future::Future::poll(Pin::new(&mut self.job), cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(value) => {
                self.done = true;
                Poll::Ready(Some(
                    value.unwrap_or_else(|_| Err(failure("Subtitle operation stopped"))),
                ))
            }
        }
    }
}
impl Drop for SubtitleBody {
    fn drop(&mut self) {
        self.job.abort();
    }
}

fn timestamp(value: &str) -> io::Result<u64> {
    let (seconds, millis) = value
        .rsplit_once(['.', ','])
        .ok_or_else(|| failure("Invalid subtitle timestamp"))?;
    let parts = seconds.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len())
        || millis.len() != 3
        || !millis.bytes().all(|b| b.is_ascii_digit())
        || parts.iter().any(|part| {
            part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err(failure("Invalid subtitle timestamp"));
    }
    let numbers = parts
        .iter()
        .map(|part| {
            part.parse::<u64>()
                .map_err(|_| failure("Invalid subtitle timestamp"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let (hours, minutes, seconds) = if numbers.len() == 3 {
        (numbers[0], numbers[1], numbers[2])
    } else {
        (0, numbers[0], numbers[1])
    };
    if minutes >= 60 || seconds >= 60 {
        return Err(failure("Invalid subtitle timestamp"));
    }
    let value = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis.parse::<u64>().unwrap();
    if value > MAX_TIME_MS {
        return Err(failure("Subtitle timestamp outside media limit"));
    }
    Ok(value)
}
fn format_time(value: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        value / 3_600_000,
        value / 60_000 % 60,
        value / 1000 % 60,
        value % 1000
    )
}
fn plain_text(text: &str) -> String {
    let mut stripped = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<'
            && chars
                .peek()
                .is_some_and(|next| next.is_ascii_alphanumeric() || matches!(next, '/' | '!'))
        {
            let mut pending = String::from("<");
            let mut closed = false;
            for part in chars.by_ref() {
                pending.push(part);
                if part == '>' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                stripped.push_str(&pending);
            }
        } else {
            stripped.push(c);
        }
    }
    let mut value = String::new();
    let mut remaining = stripped.as_str();
    while let Some(c) = remaining.chars().next() {
        let entities = [
            ("&amp;", '&'),
            ("&lt;", '<'),
            ("&gt;", '>'),
            ("&nbsp;", '\u{a0}'),
            ("&quot;", '"'),
            ("&apos;", '\''),
        ];
        let (c, consumed) = entities
            .iter()
            .find(|(entity, _)| remaining.starts_with(entity))
            .map_or((c, c.len_utf8()), |(entity, c)| (*c, entity.len()));
        match c {
            '&' => value.push_str("&amp;"),
            '<' => value.push_str("&lt;"),
            '>' => value.push_str("&gt;"),
            _ => value.push(c),
        }
        remaining = &remaining[consumed..];
    }
    value
}
fn normalize(bytes: &[u8], vtt: bool) -> io::Result<String> {
    if bytes.len() > MAX_BYTES {
        return Err(failure("Subtitle exceeds input limit"));
    }
    let raw = std::str::from_utf8(bytes).map_err(|_| failure("Subtitles must be UTF-8"))?;
    if raw.chars().any(|c| {
        (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    }) {
        return Err(failure("Subtitle contains unsafe controls"));
    }
    let text = raw
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let text = text
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let mut blocks = text.split("\n\n");
    let mut cues = Vec::new();
    if vtt {
        let header = blocks.next().unwrap_or_default();
        let first = header.lines().next().unwrap_or_default();
        if first != "WEBVTT" && !first.starts_with("WEBVTT ") && !first.starts_with("WEBVTT\t") {
            return Err(failure("Missing WebVTT header"));
        }
        if header.lines().skip(1).any(|line| !line.trim().is_empty()) {
            return Err(failure("WebVTT header metadata is unsupported"));
        }
    }
    for block in blocks {
        let block = block.trim_matches('\n');
        if block.is_empty() {
            continue;
        }
        if vtt
            && (block == "NOTE"
                || block.starts_with("NOTE ")
                || block.starts_with("NOTE\n")
                || block.starts_with("STYLE\n")
                || block.starts_with("REGION\n"))
        {
            continue;
        }
        if block.len() > MAX_CUE_BYTES || cues.len() >= MAX_CUES {
            return Err(failure("Subtitle cue limit exceeded"));
        }
        let mut lines = block.lines();
        let first = lines.next().unwrap_or_default();
        let timing = if first.contains("-->") {
            first
        } else {
            lines
                .next()
                .ok_or_else(|| failure("Missing subtitle cue timing"))?
        };
        let (start, end) = timing
            .split_once("-->")
            .ok_or_else(|| failure("Invalid subtitle cue timing"))?;
        let start = timestamp(start.trim())?;
        let end = timestamp(
            end.split_whitespace()
                .next()
                .ok_or_else(|| failure("Missing subtitle cue end"))?,
        )?;
        if end <= start {
            return Err(failure("Subtitle cue ends before it starts"));
        }
        let lines = lines.collect::<Vec<_>>();
        if lines.is_empty() || lines.len() > 32 {
            return Err(failure("Invalid subtitle cue text"));
        }
        let text = plain_text(&lines.join("\n"));
        if !text.trim().is_empty() {
            cues.push((start, end, text));
        }
    }
    cues.sort_by_key(|cue| cue.0);
    let mut output = String::from("WEBVTT\n\n");
    for (start, end, text) in cues {
        output.push_str(&format!(
            "{} --> {}\n{text}\n\n",
            format_time(start),
            format_time(end)
        ));
        if output.len() > MAX_BYTES {
            return Err(failure("Subtitle exceeds output limit"));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests;
