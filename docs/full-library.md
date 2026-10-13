# Full-library development

The Rust server recursively indexes all supported video files. It stores the full catalog and playback progress in local SQLite; HTTP queries return bounded pages. The web client separates Movies from TV series, seasons and episodes, preserves navigation through detail/player/back, and caches the twelve most recently browsed pages. Folder and filename metadata drive grouping. Artwork is explicitly placeholder artwork; no external metadata provider is configured.

## Existing read-only SSH source

The server can use an existing SSH identity and existing trusted host key. It sends an original transient Python helper through SSH; it does not install a NAS server, write media, mount shares, forward ports or change services. Python 3 with POSIX directory-descriptor support is required on the source host. Local FFmpeg and ffprobe are required for playback preparation.

Keep configuration outside Git, for example `.local/library-config.json`:

```json
{
  "destination": "media_reader@media-host",
  "keyFile": "C:\\existing\\identity",
  "knownHostsFile": "C:\\existing\\known_hosts",
  "roots": {
    "tv": "/srv/media/tv",
    "movies": "/srv/media/movies"
  }
}
```

Use existing credentials and host trust; this feature does not create them. `BatchMode`, `IdentitiesOnly`, `StrictHostKeyChecking` and `UpdateHostKeys=no` are enforced. Each remote path component is opened read-only with `NOFOLLOW`. The index accepts only a complete successful scan. A timeout or metadata-size guard fails explicitly instead of accepting a truncated library. Source file size and nanosecond modification time are checked again when reading.

From the repository root in PowerShell:

```powershell
cargo build --workspace --locked
$env:SHINEMA_SSH_CONFIG = (Resolve-Path .local/library-config.json).Path
$env:SHINEMA_STATE_DIR = Join-Path (Get-Location).Path '.local/library-state'
$env:SHINEMA_BIND = '127.0.0.1:8787'
.\target\debug\shinema-server.exe
```

In a second terminal:

```powershell
$env:VITE_DEMO_MODE = 'false'
npm --prefix clients/web run dev
```

Open `http://127.0.0.1:5173`. Both processes bind to loopback. Stop them after use. For a local filesystem source instead, unset `SHINEMA_SSH_CONFIG` and set `SHINEMA_MEDIA_ROOT` to a directory containing `tv` and `movies` folders. Writable state must remain separate from media.

## Full-duration playback

The playback descriptor reports the complete source duration. Browser-compatible H.264/AAC MP4 and compatible WebM can play directly from the original range endpoint. Other containers/codecs use a full-duration VOD HLS playlist, with segments encoded only as the player requests them, including after seeks. This is not an excerpt catalog or a whole-library conversion job.

Compatibility output currently uses CPU libx264, 1280-pixel-wide 8-bit H.264 and stereo AAC. At most two codec jobs and four SSH byte transfers run concurrently. Each segment is capped at 16 MiB; local cache eviction caps retained segments at 512 MiB and 4,096 entries. Cache identities include source modification metadata and the encoding revision. Abandoned response bodies abort codec jobs and own their child processes for cleanup. Very short trailing audio tails are merged into the last video segment.

Playback starts muted; the user can enable audio. Progress uses the stable source ID and the full source timeline. A file that changes after indexing is rejected until the server is restarted and rescans it.

## Checks and present limits

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm test
npm --prefix clients/native run typecheck
npm --prefix clients/web test
npm --prefix clients/web run build
node scripts/full-library-smoke.mjs
```

The final command uses generated full-duration media, 601 recursive media entries, an isolated full Chromium browser and separate loopback ports. It verifies complete paging, TV grouping, decoding, beginning/middle/end seeks, resume and cached browsing. CI runs POSIX helper path/link tests using local generated fixtures; no real NAS configuration or media enters CI.

This is an interactive development server, not a persistent deployment. There is one development profile and no production authentication/TLS termination. The native TV client still has its original flat first-page UI; this change does not validate Shield playback or deliver its full-library navigation. Automatic rescans, external posters/metadata, subtitles, alternate audio selection, GPU transcoding and adaptive bitrate remain unfinished. Indexed formats may still contain an unsupported or corrupt codec; playback preparation fails visibly instead of inventing a playable result. Desktop timings do not establish TV input or frame performance.
