# Shinema app

`apps/shinema` is the single client for Android TV (Shield first), the web and, next, Android phones. It is an Expo SDK 57 app on `react-native-tvos` 0.86 and renders the same screens everywhere from one component kit. See [ADR 0001](decisions/0001-client-rebuild.md) for why.

## Layout

| Folder | What lives there |
| --- | --- |
| `src/kit/` | The only place colours, fonts, spacing and focus styles are defined, following the Marquee design chosen in [PR 11](https://github.com/jpasqui/shinema/pull/11): `theme.ts`, `Text`, `Focusable` (the focus ring), `Button`, `TopBar`, `SectionHeading`, `PosterCard`, `PosterGrid`, `Artwork` (backdrops, and designed stand-ins for missing posters), `WideCard`, `Rail`, `Panel`, `Screen`, `TextField`. |
| `src/screens/` | Connect, Pair, Home (featured title, continue watching and a row per library, the first tab), Library, Series, Detail, Player, Settings. Screens use only kit components. |
| `src/platform/` | The adapters that differ by platform: storage, remote/keyboard input, focus memory, and the old-app importer. Files ending `.web.ts` replace their native twin in the browser. |
| `src/player/` | The video adapter (`engine.tsx` uses expo-video; `engine.web.tsx` uses a video element with hls.js) and remote seeking. |
| `../../packages/core/` | Shared data layer: API client, progress queue, paging, captions, watched rules. Also used by tests. |

## Running it

Start the Rust server (see [development](development.md)). To reach it from a TV or phone, bind it to your network, for example `SHINEMA_BIND=0.0.0.0:8787`; the server then prints a pairing code.

```bash
cd apps/shinema
npm ci
npm run export:web
```

Then start the server with `SHINEMA_WEB_ROOT=apps/shinema/dist` and open the server's address in a browser; the server hosts the app and its API on one origin. Arrow keys, Enter and Escape behave like a TV remote.

For quick UI work without the Rust server, `node tests/mock-server.mjs` serves the exported build with generated titles at `http://127.0.0.1:8790`. Expo's hot-reload dev server (`npm run web`) runs on a different origin, and neither server accepts API calls from another origin, so rebuild with `export:web` to try a change against real data.

### Android TV (Shield)

Every pull request's CI builds an installable development APK (`shinema-app-android-tv-<commit>` artifact). Install it with `adb install`. To build locally you need JDK 17 and the Android SDK:

```bash
cd apps/shinema
npm run prebuild:tv
npm run android:tv
```

The app uses the old TV client's package name, `io.shinema.tv`, so it installs over it. On first start it carries over any progress the old app had not synced and offers the old server's address. An in-place upgrade needs the same signing key as the installed app; otherwise uninstall the old app first (unsynced progress on it is then lost).

## Checks

| Command | What it covers |
| --- | --- |
| `npm run typecheck` | TypeScript for the app, core and tests |
| `npm test` | Spatial focus and remote seeking logic |
| `npm run export:web` | A production web build in `dist/` |
| `npm run test:e2e` | Browser behaviour at TV (960x540) and desktop sizes against `tests/mock-server.mjs`: arrow-key browsing, Back restoring focus, library tabs, playback with captions, seeking, saved progress, Resume, pairing. Set `SHINEMA_MOCK_VIDEO` to a short clip for the playback test, and `PLAYWRIGHT_CHANNEL=msedge` or `chrome` to use an installed browser. |

`node tests/mock-server.mjs` serves the exported web build with generated titles on port 8790, so the app can be looked at without building the Rust server. With `SHINEMA_MOCK_ARTWORK=1` (needs ffmpeg) some titles get posters and backdrops cut from the synthetic [test artwork](../apps/shinema/tests/fixtures/ARTWORK.md) and the rest keep none, so both looks can be checked. `SHINEMA_MOCK_DURATION` sets the test clip's length in seconds (default 30).

## Performance budgets on a TV

With the app installed and paired on the device, and the device connected over `adb`:

```bash
bash apps/shinema/tests/tv-budgets.sh budgets.json
```

It measures cold start (budget under 3 s), janky frames while scrolling the grid with the D-pad (under 5%), 95th-percentile frame time (under 33 ms) and memory before and after repeated browsing (flat within 15%), writes a JSON report and exits non-zero if a budget is missed. CI runs it in the emulator for information only; the reference Google TV stick is the real check.

## Not yet covered

- The budgets above have not been measured on real hardware yet.
- Screenshot comparison between web and the Android TV emulator is not automated; CI keeps browser screenshots and builds the APK.
- Phone portrait layouts work through the same responsive grid but have not been tuned on a device.
- Themes, Radarr/Sonarr requests and SSH libraries are paused until after v1; the server still supports them.
