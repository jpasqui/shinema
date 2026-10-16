//! Full-duration VOD playlists. Compatibility segments are generated only when
//! requested, including out-of-order requests after a seek. Nothing is written
//! to the media source. The private local cache is bounded independently of the
//! total library size.
use crate::{Library, Media};
use axum::{
    body::{Body, Bytes},
    http::{StatusCode, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex as AsyncMutex, Semaphore},
    time::{Duration, timeout},
};

const SEGMENT_SECONDS: f64 = 6.0;
const MAX_SEGMENT: usize = 16 * 1024 * 1024;
const CACHE_BYTES: u64 = 512 * 1024 * 1024;
const CODEC_JOBS: usize = 2;
const CACHE_ENTRIES: usize = 4096;
const PROBE_CACHE_ENTRIES: u64 = 4096;
const PROBE_DATABASE_PAGES: u64 = 8192;
fn segment_count(duration: f64) -> u32 {
    let full = (duration / SEGMENT_SECONDS).floor() as u32;
    let remainder = duration - f64::from(full) * SEGMENT_SECONDS;
    if full > 0 && remainder <= 0.15 {
        full
    } else {
        full + 1
    }
}
pub(crate) fn segment_count_public(duration: f64) -> u32 {
    segment_count(duration)
}
fn segment_length(duration: f64, index: u32) -> f64 {
    if index + 1 == segment_count(duration) {
        duration - f64::from(index) * SEGMENT_SECONDS
    } else {
        SEGMENT_SECONDS
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    pub duration_seconds: f64,
    pub mode: String,
    pub stream_path: String,
}
#[derive(Deserialize)]
struct Probe {
    format: ProbeFormat,
    streams: Vec<ProbeStream>,
}
#[derive(Deserialize)]
struct ProbeFormat {
    duration: String,
}
#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    pix_fmt: Option<String>,
}
struct CacheFile {
    bytes: u64,
    used: u64,
}
pub struct Engine {
    directory: PathBuf,
    origin: Mutex<String>,
    metadata: AsyncMutex<BTreeMap<String, Playback>>,
    jobs: Semaphore,
    locks: Vec<AsyncMutex<()>>,
    cache: Mutex<BTreeMap<String, CacheFile>>,
    clock: AtomicU64,
    cache_limit: u64,
    probes: Mutex<rusqlite::Connection>,
    _lease: crate::cache_lease::Lease,
}
fn failure(message: &str) -> io::Error {
    io::Error::other(message)
}
fn valid_file(path: &std::path::Path) -> io::Result<u64> {
    crate::state_files::validate_file(path)
}

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let _ = command;
}
async fn output(mut command: Command, limit: usize, seconds: u64) -> io::Result<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hidden(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("Missing process output"))?;
    let job = async {
        let mut bytes = Vec::new();
        stdout
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > limit {
            return Err(failure("Compatibility output exceeds limit"));
        }
        if !child.wait().await?.success() {
            return Err(failure("Codec operation failed"));
        }
        Ok(bytes)
    };
    timeout(Duration::from_secs(seconds), job)
        .await
        .map_err(|_| failure("Codec operation timed out"))?
}
impl Engine {
    pub fn new(state: &std::path::Path) -> io::Result<Self> {
        let directory = state.join("playback-cache");
        crate::state_files::create_private_directory(&directory)?;
        if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
            return Err(failure("Cache must be a private ordinary directory"));
        }
        let lease = crate::cache_lease::Lease::acquire(&directory)?;
        for name in ["probes.sqlite3", "probes.sqlite3-journal"] {
            match crate::state_files::validate_file(&directory.join(name)) {
                Ok(_) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        let probes = rusqlite::Connection::open_with_flags(
            directory.join("probes.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(io::Error::other)?;
        probes.execute_batch(&format!("PRAGMA auto_vacuum=INCREMENTAL;PRAGMA max_page_count={PROBE_DATABASE_PAGES};CREATE TABLE IF NOT EXISTS probes(identity TEXT PRIMARY KEY,data TEXT,used INTEGER);")).map_err(io::Error::other)?;
        let mut cache = BTreeMap::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(pid) = temporary_owner(&name) {
                valid_file(&entry.path())?;
                if crate::cache_lease::alive(pid) {
                    return Err(failure(
                        "Legacy cache temporary file has a live owner; stop it or use separate state",
                    ));
                }
                fs::remove_file(entry.path())?;
            } else if cache_name(&name) {
                cache.insert(
                    name,
                    CacheFile {
                        bytes: valid_file(&entry.path())?,
                        used: 0,
                    },
                );
            }
        }
        let value = Self {
            directory,
            origin: Mutex::new("http://127.0.0.1:8787".into()),
            metadata: AsyncMutex::new(BTreeMap::new()),
            jobs: Semaphore::new(CODEC_JOBS),
            locks: (0..64).map(|_| AsyncMutex::new(())).collect(),
            cache: Mutex::new(cache),
            clock: AtomicU64::new(1),
            cache_limit: CACHE_BYTES - 256 - 64 * 1024 * 1024,
            probes: Mutex::new(probes),
            _lease: lease,
        };
        value.evict(0)?;
        Ok(value)
    }
    pub fn statistics(&self) -> serde_json::Value {
        let cache = self.cache.lock().expect("Cache lock");
        serde_json::json!({"activeCodecJobs":CODEC_JOBS-self.jobs.available_permits(),"cachedSegments":cache.len(),"cachedBytes":cache.values().map(|v|v.bytes).sum::<u64>(),"cacheLimitBytes":self.cache_limit})
    }
    pub fn set_origin(&self, bind: std::net::SocketAddr) {
        if bind.ip().is_loopback() {
            *self.origin.lock().expect("Origin lock") = format!("http://{bind}");
        }
    }
    fn source(&self, item: &Media) -> String {
        format!(
            "{}{}",
            self.origin.lock().expect("Origin lock"),
            item.stream_path
        )
    }
    pub async fn metadata(&self, item: &Media, fingerprint: &str) -> io::Result<Playback> {
        if let Some(value) = self.metadata.lock().await.get(fingerprint).cloned() {
            return Ok(value);
        }
        let _permit = self
            .jobs
            .acquire()
            .await
            .map_err(|_| failure("Playback is shutting down"))?;
        if let Some(value) = self.metadata.lock().await.get(fingerprint).cloned() {
            return Ok(value);
        }
        let cached = self
            .probes
            .lock()
            .map_err(|_| failure("Probe cache lock"))?
            .query_row(
                "SELECT data FROM probes WHERE identity=?",
                [fingerprint],
                |row| row.get::<_, String>(0),
            )
            .ok();
        if let Some(value) = cached
            .and_then(|data| serde_json::from_str::<Playback>(&data).ok())
            .filter(|value| {
                value.duration_seconds.is_finite()
                    && value.duration_seconds > 0.0
                    && value.duration_seconds <= 604800.0
                    && ["direct", "transcode"].contains(&value.mode.as_str())
                    && value.stream_path
                        == if value.mode == "direct" {
                            item.stream_path.clone()
                        } else {
                            format!("/api/media/{}/hls/index.m3u8", item.id)
                        }
            })
        {
            self.metadata
                .lock()
                .await
                .insert(fingerprint.into(), value.clone());
            return Ok(value);
        }
        let mut command = Command::new("ffprobe");
        command
            .args([
                "-v",
                "error",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "1048576",
                "-show_entries",
                "format=duration:stream=codec_type,codec_name,pix_fmt",
                "-of",
                "json",
            ])
            .arg(self.source(item));
        let bytes = output(command, 1048576, 45).await?;
        let probe: Probe = serde_json::from_slice(&bytes)?;
        let duration = probe
            .format
            .duration
            .parse::<f64>()
            .map_err(|_| failure("Invalid duration"))?;
        if !duration.is_finite() || duration <= 0.0 || duration > 604800.0 {
            return Err(failure("Unsupported media duration"));
        }
        let video_stream = probe
            .streams
            .iter()
            .find(|s| s.codec_type.as_deref() == Some("video"))
            .ok_or_else(|| failure("No video track"))?;
        let video = video_stream
            .codec_name
            .as_deref()
            .ok_or_else(|| failure("Unknown video codec"))?;
        let audio = probe
            .streams
            .iter()
            .filter(|s| s.codec_type.as_deref() == Some("audio"))
            .map(|s| s.codec_name.as_deref().unwrap_or("unknown"))
            .collect::<Vec<_>>();
        let direct = (["mp4", "m4v"].contains(&item.container.as_str())
            && video == "h264"
            && matches!(
                video_stream.pix_fmt.as_deref(),
                Some("yuv420p" | "yuvj420p")
            )
            && audio.iter().all(|s| ["aac", "mp3"].contains(s)))
            || (item.container == "webm"
                && ["vp8", "vp9", "av1"].contains(&video)
                && audio.iter().all(|s| ["opus", "vorbis"].contains(s)));
        let value = Playback {
            duration_seconds: duration,
            mode: if direct { "direct" } else { "transcode" }.into(),
            stream_path: if direct {
                item.stream_path.clone()
            } else {
                format!("/api/media/{}/hls/index.m3u8", item.id)
            },
        };
        self.metadata
            .lock()
            .await
            .insert(fingerprint.into(), value.clone());
        self.remember_probe(fingerprint, &value)?;
        Ok(value)
    }
    fn remember_probe(&self, fingerprint: &str, value: &Playback) -> io::Result<()> {
        let db = self
            .probes
            .lock()
            .map_err(|_| failure("Probe cache lock"))?;
        db.execute(
            "INSERT OR REPLACE INTO probes VALUES (?1,?2,?3)",
            rusqlite::params![
                fingerprint,
                serde_json::to_string(value)?,
                self.clock.fetch_add(1, Ordering::Relaxed)
            ],
        )
        .map_err(io::Error::other)?;
        db.execute("DELETE FROM probes WHERE identity IN (SELECT identity FROM probes ORDER BY used LIMIT max((SELECT count(*) FROM probes)-?1,0))",[PROBE_CACHE_ENTRIES]).map_err(io::Error::other)?;
        db.execute_batch("PRAGMA incremental_vacuum(64)")
            .map_err(io::Error::other)?;
        Ok(())
    }
    pub fn playlist(duration: f64, id: &str) -> String {
        let count = segment_count(duration);
        let mut value="#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n".to_string();
        for index in 0..count {
            let seconds = segment_length(duration, index);
            value.push_str(&format!(
                "#EXTINF:{seconds:.6},\n/api/media/{id}/hls/{index}.ts\n"
            ));
        }
        value.push_str("#EXT-X-ENDLIST\n");
        value
    }
    fn evict(&self, incoming: u64) -> io::Result<()> {
        let mut cache = self.cache.lock().map_err(|_| failure("Cache lock"))?;
        while cache
            .values()
            .map(|v| v.bytes)
            .sum::<u64>()
            .saturating_add(incoming)
            > self.cache_limit
            || cache.len() >= CACHE_ENTRIES
        {
            let Some(name) = cache
                .iter()
                .min_by_key(|(_, v)| v.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            let path = self.directory.join(&name);
            valid_file(&path)?;
            fs::remove_file(path)?;
            cache.remove(&name);
        }
        Ok(())
    }
    async fn segment(
        &self,
        item: &Media,
        fingerprint: &str,
        index: u32,
        duration: f64,
    ) -> io::Result<Bytes> {
        let start = f64::from(index) * SEGMENT_SECONDS;
        if index >= segment_count(duration) {
            return Err(failure("Segment outside source duration"));
        }
        let stripe = (u64::from_str_radix(&item.id[..8], 16).unwrap_or(0) + u64::from(index))
            as usize
            % self.locks.len();
        let _lock = self.locks[stripe].lock().await;
        let encoded = format!(
            "{:x}",
            <sha2::Sha256 as sha2::Digest>::digest(
                format!("hls-720p-yuv420p-cpu-v6\0{fingerprint}").as_bytes()
            )
        );
        let name = format!("{encoded}-{index}.ts");
        let path = self.directory.join(&name);
        let tick = self.clock.fetch_add(1, Ordering::Relaxed);
        {
            let mut cache = self.cache.lock().map_err(|_| failure("Cache lock"))?;
            if let Some(info) = cache.get_mut(&name) {
                let size = valid_file(&path)?;
                if size != info.bytes || size > MAX_SEGMENT as u64 {
                    return Err(failure("Cache changed"));
                }
                let bytes = fs::read(&path)?;
                info.used = tick;
                return Ok(Bytes::from(bytes));
            }
        }
        let _permit = self
            .jobs
            .acquire()
            .await
            .map_err(|_| failure("Playback is shutting down"))?;
        let mut command = Command::new("ffmpeg");
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "1048576",
                "-ss",
            ])
            .arg(format!("{start:.6}"))
            .arg("-i")
            .arg(self.source(item))
            .arg("-t")
            .arg(format!("{:.6}", segment_length(duration, index)))
            .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf"])
            .arg("scale=1280:-2,format=yuv420p");
        command.args([
            "-c:v",
            "libx264",
            "-threads",
            "4",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-crf",
            "23",
            "-keyint_min",
            "120",
            "-sc_threshold",
            "0",
        ]);
        command
            .args([
                "-maxrate",
                "6000k",
                "-bufsize",
                "12000k",
                "-g",
                "120",
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-b:a",
                "160k",
                "-output_ts_offset",
            ])
            .arg(format!("{start:.6}"))
            .args([
                "-muxdelay",
                "0",
                "-muxpreload",
                "0",
                "-f",
                "mpegts",
                "pipe:1",
            ]);
        let bytes = output(command, MAX_SEGMENT, 60).await?;
        if bytes.is_empty() {
            return Err(failure("Empty compatibility segment"));
        }
        // Keep eviction, temporary-file creation and atomic publication under
        // one writer lock. There are no await points while temporary bytes exist:
        // concurrent jobs cannot spend the same free disk-space allowance.
        let mut cache = self.cache.lock().map_err(|_| failure("Cache lock"))?;
        while cache
            .values()
            .map(|v| v.bytes)
            .sum::<u64>()
            .saturating_add(bytes.len() as u64)
            > self.cache_limit
            || cache.len() >= CACHE_ENTRIES
        {
            let victim = cache
                .iter()
                .min_by_key(|(_, v)| v.used)
                .map(|(k, _)| k.clone())
                .ok_or_else(|| failure("Cache bound"))?;
            let old = self.directory.join(&victim);
            valid_file(&old)?;
            fs::remove_file(old)?;
            cache.remove(&victim);
        }
        let temporary = self
            .directory
            .join(format!("{name}.{}.{}.tmp", std::process::id(), tick));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let cleanup = Temporary(temporary.clone());
        let written = std::io::Write::write_all(&mut file, &bytes).and_then(|_| file.sync_all());
        drop(file);
        written?;
        fs::rename(&temporary, &path)?;
        drop(cleanup);
        cache.insert(
            name,
            CacheFile {
                bytes: bytes.len() as u64,
                used: tick,
            },
        );
        Ok(Bytes::from(bytes))
    }
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn cache_name(value: &str) -> bool {
    let Some((id, index)) = value.strip_suffix(".ts").and_then(|v| v.split_once('-')) else {
        return false;
    };
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && !index.is_empty()
        && index.bytes().all(|b| b.is_ascii_digit())
}

fn temporary_owner(name: &str) -> Option<u32> {
    let stem = name.strip_suffix(".tmp")?;
    let (stem, tick) = stem.rsplit_once('.')?;
    let (base, pid) = stem.rsplit_once('.')?;
    if !cache_name(base) || tick.parse::<u64>().ok()? == 0 {
        return None;
    }
    pid.parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
}

struct SegmentBody {
    job: tokio::task::JoinHandle<io::Result<Bytes>>,
    done: bool,
}
impl futures_core::Stream for SegmentBody {
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
                    value.unwrap_or_else(|_| Err(failure("Compatibility job stopped"))),
                ))
            }
        }
    }
}
impl Drop for SegmentBody {
    fn drop(&mut self) {
        self.job.abort();
    }
}
pub fn segment_response(
    library: Arc<Library>,
    item: Media,
    fingerprint: String,
    index: u32,
    duration: f64,
) -> Response {
    let job = tokio::spawn(async move {
        library
            .playback
            .segment(&item, &fingerprint, index, duration)
            .await
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp2t")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(SegmentBody { job, done: false }))
        .expect("Valid segment response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn deterministic_codec_and_probe_cache_resource_budgets() {
        let limit = crate::performance_budgets::resource_limit;
        assert!(CODEC_JOBS as u64 <= limit("codecJobs"));
        assert!(MAX_SEGMENT as u64 <= limit("segmentBytes"));
        assert!(CACHE_BYTES <= limit("segmentCacheBytes"));
        assert!(CACHE_ENTRIES as u64 <= limit("segmentCacheEntries"));
        assert!(PROBE_CACHE_ENTRIES <= limit("probeCacheEntries"));
        assert!(PROBE_DATABASE_PAGES <= limit("probeDatabasePages"));
        let temp = tempfile::tempdir().unwrap();
        let engine = Engine::new(temp.path()).unwrap();
        assert!(engine.cache_limit <= limit("segmentCacheBytes"));
        let jobs = (0..CODEC_JOBS)
            .map(|_| engine.jobs.try_acquire().unwrap())
            .collect::<Vec<_>>();
        assert!(engine.jobs.try_acquire().is_err());
        assert_eq!(engine.statistics()["activeCodecJobs"], CODEC_JOBS);
        drop(jobs);
        assert_eq!(engine.jobs.available_permits(), CODEC_JOBS);

        // Fill the real persistent probe table in one transaction, then exercise
        // the same insertion/eviction path as successful ffprobe processing.
        // No media, codec process, provider, or remote source is involved.
        {
            let mut db = engine.probes.lock().unwrap();
            let pages: u64 = db
                .query_row("PRAGMA max_page_count", [], |row| row.get(0))
                .unwrap();
            assert!(pages <= limit("probeDatabasePages"));
            let transaction = db.transaction().unwrap();
            for index in 0..PROBE_CACHE_ENTRIES {
                transaction
                    .execute(
                        "INSERT INTO probes VALUES (?1,'{}',?2)",
                        rusqlite::params![format!("synthetic-{index:06}"), index],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
        }
        engine
            .clock
            .store(PROBE_CACHE_ENTRIES + 1, Ordering::Relaxed);
        let value = Playback {
            duration_seconds: 60.0,
            mode: "direct".into(),
            stream_path: "/api/media/synthetic/stream".into(),
        };
        engine.remember_probe("synthetic-new", &value).unwrap();
        let db = engine.probes.lock().unwrap();
        let rows: u64 = db
            .query_row("SELECT count(*) FROM probes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, PROBE_CACHE_ENTRIES);
        let oldest: u64 = db
            .query_row(
                "SELECT count(*) FROM probes WHERE identity='synthetic-000000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(oldest, 0);
        let data: String = db
            .query_row(
                "SELECT data FROM probes WHERE identity='synthetic-new'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&data).unwrap()["durationSeconds"],
            60.0
        );
    }

    #[test]
    fn startup_recovers_owned_dead_writer_temporary_files_only() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("playback-cache");
        fs::create_dir(&directory).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--help")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!crate::cache_lease::alive(pid));
        let owned = directory.join(format!("{}-3.ts.{pid}.7.tmp", "a".repeat(64)));
        fs::write(&owned, [1_u8; 100]).unwrap();
        let unrelated = directory.join("personal-notes.tmp");
        fs::write(&unrelated, b"keep").unwrap();
        fs::write(
            directory.join("writer.lock"),
            format!("shinema-cache-writer-v1\n{pid}\n12345\n"),
        )
        .unwrap();
        let engine = Engine::new(temp.path()).unwrap();
        assert!(!owned.exists());
        assert_eq!(fs::read(unrelated).unwrap(), b"keep");
        assert!(Engine::new(temp.path()).is_err());
        drop(engine);
        assert!(!directory.join("writer.lock").exists());
    }
    #[test]
    fn temporary_links_are_never_deleted_as_orphans() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("playback-cache");
        fs::create_dir(&directory).unwrap();
        let source = temp.path().join("original");
        fs::write(&source, b"unchanged").unwrap();
        let linked = directory.join(format!("{}-1.ts.12345.1.tmp", "b".repeat(64)));
        fs::hard_link(&source, &linked).unwrap();
        assert!(Engine::new(temp.path()).is_err());
        assert!(linked.exists());
        assert_eq!(fs::read(source).unwrap(), b"unchanged");
    }
    #[test]
    fn tiny_trailing_audio_duration_is_merged_into_the_last_video_segment() {
        assert_eq!(segment_count(90.024), 15);
        assert!((segment_length(90.024, 14) - 6.024).abs() < 0.00001);
        let value = Engine::playlist(90.024, &"a".repeat(64));
        assert_eq!(value.matches("#EXTINF:").count(), 15);
        assert!(value.contains("#EXTINF:6.024000,"));
    }
    #[test]
    fn cache_evicts_oldest_entries_and_refuses_hardlinks() {
        let temporary = tempfile::tempdir().unwrap();
        let mut engine = Engine::new(temporary.path()).unwrap();
        engine.cache_limit = 256;
        for index in 0..3 {
            let name = format!("{}-{index}.ts", "a".repeat(64));
            std::fs::write(engine.directory.join(&name), [0_u8; 100]).unwrap();
            engine.cache.lock().unwrap().insert(
                name,
                CacheFile {
                    bytes: 100,
                    used: index,
                },
            );
        }
        engine.evict(100).unwrap();
        assert_eq!(engine.cache.lock().unwrap().len(), 1);
        assert!(
            engine
                .directory
                .join(format!("{}-2.ts", "a".repeat(64)))
                .exists()
        );
        let original = temporary.path().join("original");
        std::fs::write(&original, b"unchanged").unwrap();
        let linked = engine.directory.join("linked");
        std::fs::hard_link(&original, &linked).unwrap();
        assert!(valid_file(&linked).is_err());
        assert_eq!(std::fs::read(original).unwrap(), b"unchanged");
    }
    #[test]
    fn playlist_covers_entire_source_and_last_partial_segment() {
        let id = "a".repeat(64);
        let value = Engine::playlist(1337.125, &id);
        assert_eq!(value.matches("#EXTINF:").count(), 223);
        assert!(value.contains("#EXTINF:5.125000,"));
        assert!(value.contains(&format!("/api/media/{id}/hls/222.ts")));
        assert!(value.ends_with("#EXT-X-ENDLIST\n"));
    }
}
