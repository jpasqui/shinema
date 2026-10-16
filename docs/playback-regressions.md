# Client playback regressions

From the repository root, with Node 24.14.0 and FFmpeg (including `libx264`) available:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix clients/web ci --ignore-scripts --no-audit --no-fund
npm --prefix clients/native ci --ignore-scripts --no-audit --no-fund
node clients/web/node_modules/playwright/cli.js install chromium
npm --prefix clients/web test
npm --prefix clients/native test
npm --prefix clients/web run test:playback
```

On Linux, install Chromium's OS dependencies with Playwright's `install --with-deps chromium`. Set `FFMPEG` to an executable if it is not on `PATH`. The browser suite runs serially without retries, and starts its own Vite server at `127.0.0.1:4187`; that port must be free. It never reuses a running server. Its new CI step runs in `web-preview` after the existing Chromium and FFmpeg installation.

The worker generates an original, silent 90-second 160×90 H.264 test pattern, an MP4 with range responses, and a two-second-segment HLS rendition in a newly created temporary directory. It deletes that directory in fixture teardown. Nothing is downloaded as test media or read from a user's media library. Each test gets a fresh browser context and synthetic API state. Browser HTTP requests are restricted to the test origin; unmatched API routes fail locally before the development proxy. Failure diagnostics remain under ignored `clients/web/.local/playback-results`.

| Suite                          | Additional behavior covered                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web browser, direct and hls.js | Ten-second buttons and arrow keys clamp at zero and duration; a focused range input moves by its own step rather than also invoking the player's ten-second shortcut; seeks persist; completed progress restarts at the beginning and subsequent playback saves a fresh position.                                             |
| Web failure and recovery       | Unavailable or malformed descriptors and a disconnected MP4 display an error, stop the loading notice, preserve saved progress, and reopen successfully. A real HLS segment failure after decoded playback reaches the fatal-error handler and preserves a usable seek position for reopening.                                |
| Web large-library fixture      | A 10,001-title synthetic API returns at most 60 cards per page; title 61 retains its page and focus after playback; failed progress PUTs survive reload and resume; reconnect replays only that title and clears pending progress after acknowledgement.                                                                      |
| Native session helpers         | Pending zero/fractional positions avoid unnecessary resume GETs; selected title/origin isolation; offline and invalid-remote fallback; empty remote state; cancellation after rejected GET; queue recovery across titles after a network failure; an acknowledgement with a different duration cannot discard newer progress. |

The existing `web-smoke.mjs` and `full-library-smoke.mjs` still own actual Rust API, generated full-library indexing, and end-to-end server/transcoding checks. This fast suite isolates client event wiring and recovery behavior. Its large total is a paged API fixture, not a 10,001-file indexing or performance benchmark. Playback assertions require decoded frames; media failures use real aborted requests or HTTP errors, not dispatched media-error events.

Subtitles have no selection controls or client contract yet, so this suite adds no subtitle assertions. Native full-library browsing is also unfinished. These host checks establish neither Shield/TV remote handling nor Android decoder, Safari native-HLS, audio, NAS, real disconnect timing, or device resume behavior. No production client/server code or visible UI changes are part of this test expansion.

## Native races requiring separate fixes

The current native session helpers have two independently reproduced races. These are coordination follow-ups, not knowingly failing required CI tests in this PR. All sequences use one captured HTTPS origin, a synthetic 64-character media ID, in-memory storage, and explicitly held promises; no actual network or device is needed.

1. In `clients/native/src/session.ts`, `resolveResume` reads local progress before awaiting its GET. Start with cached progress 12/60 and no pending value; start a resume GET and hold its response; write cached **and pending** progress 35/60; resolve the GET with 4/60. The helper currently returns `{progress: 4/60, local: false}` although pending remains 35/60. The expected resume is 35/60 from the latest local pending value. The web helper already rechecks local state after its GET.
2. In the same file, `syncProgress` compares acknowledged position/duration fields rather than the identity of the pending write. Start a PUT of object A at 12/60 and hold its acknowledgement; write a new pending object at 22/60, then a distinct object B at 12/60; acknowledge A. The helper currently removes B from memory and persisted pending state. B must remain until its own successful acknowledgement, even though its fields equal A's. Native `App.tsx` creates fresh pending objects on every save, so equal fields can represent separate writes.

These reproduce helper behavior only. Production fixes and their failing-then-passing regression assertions should be coordinated separately.
