# Full-library development

The Rust server recursively indexes all supported video files. It stores the full catalog and playback progress in local SQLite; HTTP queries return bounded pages. The web client browses configured libraries, including TV series, seasons and episodes, preserves navigation through detail/player/back, and caches the twelve most recently browsed pages. Folder and filename metadata drive grouping. See [library and navigation configuration](libraries.md) for editable labels, folder membership, ordering, visibility and safe migration. Optional direct TMDB/TVmaze adapters supply conservatively matched metadata and artwork through Shinema-owned caches. Live provider access is unconfigured in this development environment. Missing artwork is displayed plainly.

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

For the integrated web app, export it and set its directory before starting Rust:

```powershell
npm --prefix apps/shinema run export:web
$env:SHINEMA_WEB_ROOT = Join-Path (Get-Location).Path 'apps/shinema/dist'
```

The same Rust origin then serves the app and the API. For development with hot reload, run `npm run web` in `apps/shinema` instead and enter the server's address in the app.

Both processes bind to loopback. Stop them after use. For a local filesystem source instead, unset `SHINEMA_SSH_CONFIG` and set `SHINEMA_MEDIA_ROOT` to a directory containing `tv` and `movies` folders. Writable state must remain separate from media.

## Full-duration playback

The playback descriptor reports the complete source duration. Browser-compatible H.264/AAC MP4 and compatible WebM can play directly from the original range endpoint. Other containers/codecs use a full-duration VOD HLS playlist, with segments encoded only as the player requests them, including after seeks. This is not an excerpt catalog or a whole-library conversion job.

Compatibility output currently uses CPU libx264, 1280-pixel-wide 8-bit H.264 and stereo AAC. At most two codec jobs and four SSH byte transfers run concurrently. Each segment is capped at 16 MiB; the 512 MiB playback cache reserves 64 MiB for the bounded probe database/journal, leaving 448 MiB for at most 4,096 retained segments. Cache identities include source modification metadata and the encoding revision. Abandoned response bodies abort codec jobs and own their child processes for cleanup. Very short trailing audio tails are merged into the last video segment.

Progress uses the stable source ID and the full source timeline. A file that changes after indexing is rejected until the next rescan (every 15 minutes, or `POST /api/admin/rescan`).

## Checks and present limits

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm test
npm --prefix apps/shinema run typecheck
npm --prefix apps/shinema run test:e2e
```

The browser suite runs the app against a mock server with a generated clip; the Rust tests cover paging, grouping, ranges, HLS segmenting and resume against generated fixtures. CI runs POSIX helper path/link tests using local generated fixtures; no real NAS configuration or media enters CI.

This is an interactive development server, not a persistent deployment. There is one profile; devices on the home network pair with a code, and HTTPS needs a reverse proxy. The app shows configured library labels, order and visibility. Shield playback is not validated yet. New metadata matching beyond configured providers, subtitles, alternate audio selection, production GPU encoding and adaptive bitrate remain unfinished. Indexed formats may still contain an unsupported or corrupt codec; playback preparation fails visibly instead of inventing a playable result. Desktop timings do not establish TV input or frame performance.


## Independent metadata and artwork

Shinema reads media source files only. It does not open Plex databases, preferences, credentials or artwork directories. File-derived catalog rows and grouping are indexed immediately; external metadata is demand-driven and never blocks a browse response. The Movies bootstrap requests its visible collection, and TV-only libraries retain their navigation.

The Rust server directly supports TMDB Movies/TV and optional TVmaze TV metadata. There is no centralized metadata relay or required end-user provider-account onboarding. A finished project-wide default requires the provider's permission and an appropriate distribution/licensing decision. No credential is committed or bundled. Pending that decision, optional administrator overrides are `SHINEMA_TMDB_TOKEN_FILE` (a private regular file containing an approved project API Read Access Token) and `SHINEMA_TVMAZE=1`. Both are disabled in this development environment; synthetic provider fixtures verify implementation without claiming live metadata or artwork coverage.

Only cleaned title/year searches and provider IDs plus season/episode numbers leave the server. Paths, library databases and watch history are excluded. Matching requires a unique normalized title and a matching year when known; ambiguous remakes keep file-derived details. The queue holds at most 128 demand requests. A single pooled HTTPS client spaces requests by at least 600 ms and respects HTTP 429/Retry-After; failures retain file browsing and defer retries. No whole-library eager image download occurs. Posters are fetched for demanded pages, backdrops for demanded details; endpoints serve only already-cached image bytes.

The private cache retains at most 20,000 metadata records and 4,096 images/256 MiB of images. Metadata refreshes after seven days, negative matches after one day, and provider failures back off. Content has a conservative 30-day hard expiry, checked before reuse and purged at startup/hourly during demand. Client caches discard expired provider fields and retain grouping/file details. Artwork writes are atomic, bounded and recovered after interruption under exclusive ownership. Existing links fail closed. Provider source links and credits accompany metadata; TVmaze data remains subject to CC BY-SA, separately from the MIT licence of original code. TMDB usage, logo attribution and commercial/project distribution permission remain governed by its current terms. No terms or new agreements have been accepted by this implementation.

Codec information is independent of internet metadata. Shinema's own ffprobe results are cached against the complete source identity; every stream request still validates original size/mtime. Bounded input probing and manifest-ready HLS startup avoid repeated preparation and startup deadlocks. CPU H.264/AAC output remains selected. Segment cache reserves space for its bounded probe database/journal. These are desktop engineering checks; Shield input/frame/playback validation remains separate.

References: [TMDB application authentication](https://developer.themoviedb.org/docs/authentication-application), [TMDB FAQ/attribution](https://developer.themoviedb.org/docs/faq), [TMDB rate limiting](https://developer.themoviedb.org/docs/rate-limiting), [TVmaze API and licence](https://www.tvmaze.com/api).
