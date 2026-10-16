# Text subtitles

Open **Subtitles** in the web player or press **Menu** during native playback.
**Auto** uses the first supported track marked default, then the browser/device
language (including common ISO 639-2 tags such as `eng`). If neither matches,
subtitles stay Off. **Off** is an explicit choice, including while discovery is
still running. Web choices survive Back → Resume for the same title in the page
session; native retains Off or the chosen language for the app session. Auto can
be selected again at any time. Preferences are not written to the server.

Supported input:

| Source | Formats | Behavior |
| --- | --- | --- |
| Embedded in media | SubRip (`subrip`), WebVTT (`webvtt`), MP4 timed text (`mov_text`) | FFmpeg extracts the selected stream to normalized WebVTT. |
| Local sidecar beside media | UTF-8 `.srt` and `.vtt`, with optional UTF-8 BOM | Same exact media stem, optionally followed by dot-separated language/flags. |

For `Movie.mkv`, examples are `Movie.srt`, `Movie.en.srt`,
`Movie.en.default.srt`, and `Movie.es.vtt`. A `default` suffix marks a default
sidecar. Files must be ordinary, singly linked files in the same capability
directory as the cataloged media. No subtitle upload or arbitrary-path endpoint
is provided. Existing files are read without modifying the media library.

ASS/SSA styled subtitles, PGS/DVD/DVB/XSub image subtitles and legacy sidecars
(`.sub`, `.idx`, `.sup`) are listed as unsupported and cannot be selected.
Image subtitles need an OCR or burn-in workflow that this milestone does not
provide. UTF-16 and legacy text encodings are rejected. Remote SSH sidecars are
unavailable; embedded remote tracks use the existing internal media stream.
No live remote service is needed for the generated tests.

Rendering is plain text: SRT/VTT markup, voice tags, styling, regions and cue
position settings are flattened or discarded. VTT header metadata, including
timestamp maps, is rejected. The browser renders a separate WebVTT text track;
the native client renders text over the video using media-time events at
approximately 100 ms intervals while captions are active. Native caption timing
and remote-control layout still require device validation. The native source
stays stable when selecting or retrying subtitles, so captions do not reload the
video or reset resume. Native built-in subtitle selection is explicitly disabled
to avoid duplicate captions and to honor Off.

Cue times always refer to the original media timeline, including compatibility
HLS, backward/forward seeks and resumed playback. No segment or resume offset is
added. Fetch failure is reported separately from video failure; use **Retry
subtitles**, choose a different track, or choose Off. Leaving playback cancels
subtitle work. Late responses cannot re-enable subtitles after Off or affect a
different title/server.

## API and bounds

- `GET /api/media/{mediaId}/subtitles` returns `{ tracks, warnings? }`. Each track
  has `id`, `label`, optional `language`, `default`, `source` (`embedded` or
  `external`), and exactly one of `contentPath` or `unsupportedReason`.
- `GET /api/media/{mediaId}/subtitles/{trackId}.vtt` returns
  `text/vtt; charset=utf-8`, `no-store`, `nosniff` content. IDs are opaque;
  client paths must belong to the same media and API origin.
- Rust accepts at most 2 MiB input/output, 64 combined tracks, 4,096 directory
  entries, 20,000 cues, 16 KiB / 32 lines per cue, and timestamps within seven
  days. Oversized/unsafe input fails closed. Local links, reparse points,
  path traversal and invalid UTF-8/control characters are rejected. External
  content is re-opened safely for every request; no subtitle content is cached
  on disk.
- Embedded work has two concurrent process slots, bounded probe/output sizes,
  input timeouts and 30 s probe / 60 s extraction deadlines. Dropping an
  extraction response aborts its task and kills the child process. The clients
  independently cap subtitle content at 4 MiB and discard stale work.

## Host validation

Run the normal Rust/client checks, then these codec/browser checks with FFmpeg
and Playwright Chromium installed:

```text
cargo test --workspace --locked generated_embedded_formats -- --ignored --nocapture
node scripts/subtitle-smoke.mjs
```

The codec test generates SubRip, mov_text and WebVTT tracks and verifies exact
absolute timestamps. The browser script generates its own color/sine clips and
authored multilingual text, exercises direct and compatibility playback, default
and external selection, Off, seek/resume, failures/retry and interrupted flows.
Screenshots and check results are saved under `.local/subtitle-evidence/` and
remain outside public commits. The dedicated subtitle workflow also runs these
checks. This is host evidence; it does not claim TV/Shield or live NAS validation.

If its browser smoke fails, the workflow retains `shinema-subtitle-failure-<head>`
for seven days after a dedicated allowlist/privacy audit succeeds. It contains a
structured phase/source-line/count log and summary (64 KiB each), plus one fixed
1280x1080 screenshot (2 MiB maximum) when the generated-fixture page is available.
Startup failures may have no screenshot. Raw errors, stacks, console/server text,
request URLs, traces, media and application state are excluded. Vite's error
overlay is disabled so a build error cannot put host paths into the screenshot.
Neither `.local/subtitle-evidence` nor any Library demonstration is uploaded by
this failure-artifact step.

The diagnostics helper and privacy guard have focused regression tests. To
exercise a real failure after the synthetic player and first cue are visible,
use the command below; exit status 1 is expected. The evidence switch preserves
existing successful screenshots/check results. Audit before inspecting or
sharing the dedicated failure directory, then run the smoke without the failure
switch to restore green:

```text
node --test scripts/subtitle-diagnostics.test.mjs
node --input-type=module -e "process.env.SHINEMA_SUBTITLE_TEST_FAILURE='1'; process.env.SHINEMA_SUBTITLE_WRITE_EVIDENCE='0'; await import('./scripts/subtitle-smoke.mjs')"
python3 scripts/audit_ci_artifacts.py subtitle-diagnostics ci-artifacts/subtitle-failure
node --input-type=module -e "process.env.SHINEMA_SUBTITLE_WRITE_EVIDENCE='0'; await import('./scripts/subtitle-smoke.mjs')"
```

Every smoke run clears only its dedicated allowlisted failure files, preventing
an older failure from being retained after a later successful run.
