# First usable slice

This work is on an implementation branch and must be reviewed through a draft PR. All future changes use branches and PRs; merging requires user approval.

## Server

Use Rust 1.94.0. From the repository root:

```sh
cargo test --workspace --locked
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --workspace --locked
```

Configure `SHINEMA_MEDIA_ROOT` to an existing small read-only media directory and `SHINEMA_STATE_DIR` to a separate writable directory. Relative paths are resolved from the process working directory. Both must be disjoint; the server rejects overlapping paths before creating state. The server never writes to media. Use a read-only share/account when testing on a NAS; server behavior alone cannot replace filesystem access controls.

```sh
SHINEMA_MEDIA_ROOT=.local/media SHINEMA_STATE_DIR=.local/state cargo run -p shinema-server --locked
```

PowerShell:

```powershell
$env:SHINEMA_MEDIA_ROOT = '.local/media'
$env:SHINEMA_STATE_DIR = '.local/state'
cargo run -p shinema-server --locked
```

Default binding is `127.0.0.1:8787`. Non-loopback binds are rejected. Do not expose this unauthenticated first slice to a LAN or WAN, or deploy it as a persistent service. Scanning occurs at startup, includes MP4/M4V/MKV/WebM, skips symbolic links, and limits depth to eight and catalog size to 500. Restart the server to rescan. Device codec support determines direct playback; listing a container does not imply every codec inside it will play.

Writable state is a SQLite resume database outside media. It persists across server restarts. The client keeps an app-private metadata mirror and pending progress, syncs successful saves to the server, and restores the selected library page through detail/player/Back navigation.

The SQLite database and its WAL, SHM and rollback-journal files must be ordinary singly linked files. Startup rejects existing symbolic links, Windows reparse points, hardlinks and non-file entries before SQLite initialization, and uses SQLite `NOFOLLOW`. New Unix state directories use mode 0700; existing group/other-writable state directories are rejected. Keep this directory and its parents private to the server account; on Windows, use a local application-state directory with appropriate existing ACLs. These checks are not a sandbox against a privileged or same-account process racing parent-directory replacement or hardlink creation. Read-only media access controls remain required for a production boundary.

A candidate server is staged in a separate app-private file, which startup never loads as the confirmed cache. Failed stages and cancellation before the final commit leave the confirmed server and queued progress untouched; no rollback write or cleanup is required for recovery. The final atomic confirmation commit is an explicit non-cancelable phase: navigation may move elsewhere, but playback waits until that short phase settles. A failed confirmation leaves the old confirmed cache active; a successful confirmation becomes the new active server even if navigation changed meanwhile. Activation shares one queue with ordinary cache writes, and queued ordinary saves sample the latest committed state. Entering details or starting playback cancels unfinished catalog refreshes so late responses cannot replace the player. Pending writes capture their origin and confirmed connection generation before asynchronous storage, and stale completions cannot send data to or clear data on another server. Reconnecting to the same server replays retained pending progress in order. This first slice maintains one confirmed server cache; a successful switch replaces that cache rather than providing multiple server profiles.

## Generated test media

Use existing recognized FFmpeg, or point the `FFMPEG` environment variable to its executable:

```sh
node scripts/generate-test-media.mjs
```

This generates three original 60-second H.264/AAC test patterns under ignored `.local/media`. No downloaded or private film is bundled or uploaded. Files that already exist are left unchanged.

## Native TV client

Use Node 24.14.0 and JDK 21. Install only the locked dependency closure:

```sh
cd clients/native
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

The Android build uses Gradle 9.4.1, Android platform `android-37.0`, Build Tools 37.0.0, NDK 27.1.12297006 and CMake 3.30.5. With recognized Gradle and these SDK packages installed, set `ANDROID_HOME` to the SDK and build:

```sh
cd android
gradle --no-daemon :app:testReleaseUnitTest :app:assembleRelease
```

The result is an unsigned ARM64 release APK for `io.shinema.tv`. No keys, credentials or signing setup are committed. Use an existing approved local test identity for bounded installation; production signing is not configured. Windows native builds may require short directory junctions to avoid Ninja's path-length limit. Keep local SDK paths and helper scripts in ignored `.local`, not tracked files.

The native client defaults to HTTPS with normal platform certificate validation. Enter an origin such as `https://your-trusted-server.example`, without credentials or an API path. The Rust loopback server does not terminate TLS; HTTPS needs a separately configured trusted TLS endpoint.

For a trusted local network, setup also offers explicit HTTP consent for the exact server address. HTTP leaves media, library information and playback progress unencrypted. Consent is saved only with a confirmed connection and does not permit other origins, public addresses or HTTPS downgrades. See [local HTTP connections](local-http.md) for address, DNS and redirect rules. This changes neither the Rust loopback binding nor its authentication boundaries.

Device testing requires current operator authorization and availability; do not interrupt a device in use. Temporary device routing for an isolated test must remain bounded to the approved local server and be removed after the session.

Remote controls: arrows browse the eight-card page; Select opens detail/plays; player Select pauses, Left/Right seeks ten seconds, Back returns player to detail to the same library page, then exits at root. Held Back is gated until release. Menu opens server setup outside playback. Up in setup focuses the address field. Cached browsing is available offline; streaming still needs the server.

## Checks and limits

`node scripts/host-smoke.mjs` exercises the actual Rust HTTP server against the shared TypeScript parsers using generated byte fixtures on host loopback. Build the server first. It does not contact a device or validate video decoding.

CI runs Rust formatting, lint/tests, client tests/typechecks, the host smoke and an unsigned Android release build. It uses pinned official GitHub and Gradle actions, read-only workflow permissions, public standard runners, no secrets, and no device or NAS input. Development APK/web build downloads and browser failure diagnostics are retained as GitHub Actions artifacts; see [CI builds and checks](ci-builds.md). No store publishing, signing or deployment is configured.

Actual Shield rendered UI, remote behavior, decoding and reopen/resume validation must be reported separately. Phone, web, desktop and Apple TV builds are not included in this first Android TV slice. Production authentication, multi-user profiles, TLS termination, transcoding and the broader roadmap remain future work.
