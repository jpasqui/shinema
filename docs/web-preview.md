# React web preview

This bounded web client shares the Rust first-slice API and TypeScript contracts with the native client. It adds responsive library and detail pages, explicit keyboard focus, preserved library scroll, HTML5 direct playback, cached browsing and local progress that retries synchronization. It uses original SVG artwork and three generated H.264/AAC clips. The **Demo library** label identifies fixtures, not a private media library.

The visual redesign uses neutral surfaces, a simple wordmark, readable metadata, restrained title typography and original textured SVG artwork. It removes promotional slogans and repeated badges. The artwork is decorative demo illustration; it does not depict the generated test-pattern video itself. Native clients, server APIs and the progress model are unchanged. Browser QA covers desktop and 390px library/detail/player layouts, visible keyboard focus and actual silent playback; a normal pause/seek does not display a canceled-play warning over the video.

Featured titles wrap safely and are visually bounded to two lines. The heading retains its full accessible text and hover title, while the details page displays the complete title without clamping. Browser regression fixtures exercise the contract's 200-character limit with both unbroken filename-style and spaced titles at 1280px and 390px, checking banner geometry, controls, horizontal overflow and full detail title access.

## Run the generated demo

Use Node 24.14.0, Rust 1.94.0 and a recognized FFmpeg executable in PATH. From the repository root:

```powershell
npm ci --prefix clients/web --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
node scripts/generate-test-media.mjs
node scripts/web-dev.mjs
```

Open `http://127.0.0.1:5173`. Ctrl+C stops both temporary servers. Ports 5173 and 8787 must be free. Generated media and writable demo state are separate ignored directories under `.local`. Both servers bind only to host loopback; the dev server serves the permitted client/contracts/tokens files and proxies relative API requests to the loopback Rust server. No device, LAN, network configuration or production service is involved.

Use Tab to enter the library cards, arrow keys to navigate, Enter to open details and Escape to return. In playback, Space toggles play/pause, left/right arrows seek ten seconds and Escape returns to details. HTML5 media is muted and set to volume zero before assigning its source; this preview offers no unmute control. It is a silent development demo.

## Verification

```powershell
npm test --prefix clients/web
npm run build --prefix clients/web
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.local/web-browsers'
node clients/web/node_modules/playwright/cli.js install chromium
node scripts/web-smoke.mjs
```

The smoke workload launches official Chromium with a fresh browser context and temporary host-only servers. It renders desktop and 390px layouts, records loading, exercises actual decode/playback/pause/seek/resume against the Rust API, checks browser reload persistence, verifies local/server progress after an unpaused header exit, checks focus/scroll restoration and disconnects its own Rust test server to verify cached/error states. Test media must first be generated. Test screenshots and JSON evidence remain ignored in `.local`; temporary test state, browsers and servers are closed after the run. On Linux, Playwright may need its documented browser system dependencies (`install --with-deps chromium`).

Nine model tests include deferred GET/PUT regressions: acknowledging a pending PUT cannot make an older in-flight GET override that local position, and a `12 -> 22 -> 12` seek sequence retains the newest request until its own acknowledgement. Per-item local revisions protect resume reads; pending-object identity owns each queued write/acknowledgement, and superseded queued writes are skipped. Player cleanup saves from its captured media element even after React detaches the ref.

This is browser integration validation. It provides no Shield, TV remote, hardware audio, GPU/frame-time, physical phone, Safari or Apple TV validation. The deliberate 700ms test catalog delay exercises loading and must not be treated as a performance result. The three-item fixture is a first usable slice, not a large-library benchmark.

## Scope and limitations

- The API remains a single development profile. Progress uses a browser-local pending value ahead of the server until synchronized; this is not a multi-user or cross-device conflict policy.
- Cache storage is scoped to this browser origin. Storage failures are shown; session-only changes may be lost on reload. Offline browsing does not provide offline video downloads.
- Browser codecs determine direct-play support. There is no transcoding, server authentication, subtitle generation, request integration, custom channels, or remote deployment in this slice.
- Demo descriptions and artwork are generated presentation fixtures. Real catalogs use actual server titles and generic artwork.
- Vite development output is for host-only development. A future deployed client needs a separately reviewed HTTPS origin, authentication and reverse-proxy policy. The native HTTPS policy remains unchanged.

The recommended architecture remains a Rust API and shared contracts with platform-specific playback/focus adapters. Browser playback uses HTML5 video, while native TV retains its native player. Treat web validation as evidence for the browser slice, then schedule actual device checks only when the user is available.
