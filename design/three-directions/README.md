# Three directions for Shinema

An isolated design study for choosing a visual and navigation direction. The production web/native clients, design tokens, Rust server and shared contracts are unchanged. No direction is selected by this PR.

| Direction   | Structure                                                              | Strength                      | Tradeoff                     |
| ----------- | ---------------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| **Marquee** | Cinematic feature, landscape continue-watching rail, immersive details | Artwork and discovery         | Fewer titles visible at once |
| **Archive** | Warm editorial catalogue, portrait artwork, programme-style details    | Scanning an owned collection  | Brighter and less theatrical |
| **Signal**  | Persistent vertical title list and a selected-title pane               | Predictable remote navigation | Less familiar split layout   |

All three include home, movie library, film details, show details with episodes, and player controls at **1600 × 900 TV** and **390 × 844 phone** sizes. Ready/focused, empty and loading states are available from the comparison toolbar. The same fictional collection and original generated artwork are used throughout; see [artwork provenance and exact prompt](assets/ARTWORK.md).

## Run locally

From the repository root, using Node 24.14.0:

```sh
node design/three-directions/serve.mjs
```

Open **http://127.0.0.1:4179**. The comparison provides direction, screen, size and state controls, plus a full-size preview link. The standalone server binds only to host loopback and serves this directory. It uses no account, API, external font, artwork service or media server. Stop it with Ctrl+C.

Select a title, search the six-title collection, filter films/shows, toggle My list, switch seasons, and try the simulated player. Player time, audio/subtitle choices and list membership are local in-memory concept state; reloading resets them. Film footage is represented by original still artwork. This is an interaction prototype, not a video decoder, streaming implementation or performance benchmark.

### Remote and keyboard

- Arrows move spatial focus; Enter activates. Tab remains available. Escape/Backspace returns to the originating library selection, or from player to details.
- Signal: Up/Down previews titles in the left list; Enter opens details. Right moves into actions on TV. Phone uses a single list and a full detail screen.
- Player: Space toggles play/pause. Left/Right on Play seeks ten seconds. **Down from Play focuses Subtitles**, then Enter opens the sheet. Left/Right moves across the audio/subtitle/settings controls. Up/Down leaves the seek slider. Escape closes a sheet before leaving the player.
- Settings sheets contain focus; Escape closes them. Focus has a visible outline or filled selection independently of hover. Reduced-motion preference disables skeleton animation.

## Verify and render evidence

Install the existing locked web development dependencies, then Chromium if it is not already present:

```sh
npm ci --prefix clients/web --ignore-scripts --no-audit --no-fund
node clients/web/node_modules/playwright/cli.js install chromium
node design/three-directions/check.mjs
```

The script launches fresh Chromium contexts and its own temporary loopback server, closes both after the run, and saves **52 PNGs** and `verification.json` under ignored `.local/design-evidence/`. Output includes three comparison boards, 30 screen renders, 12 empty/loading renders, six subtitle sheets and the interactive comparison page. Screenshots are review evidence, not committed application assets.

Assertions cover viewport geometry, horizontal overflow, TV viewport height, selection/focus restoration, search, My list, player seek/toggle, remote subtitle access, subtitle preference selection, Back, empty-state action, loading semantics and comparison switching. Root lint/format and existing client/backend checks remain applicable. Browser checks do not establish physical remote, TV, phone, HDR, playback decoding or accessibility conformance.

## Ownership and future integration

This study owns only `design/three-directions/`. It does not alter other workers’ subtitles, requests, performance, native progress, playback testing or Host/Origin changes. There are no new package dependencies or lockfile changes.

After Jeremy chooses a direction, implement it incrementally in React web/native with platform focus and playback adapters. Reuse existing catalog, media, series, progress and artwork contracts. Search, list membership and season controls here demonstrate interaction only; they do not introduce API fields or imply backend features. Production subtitle/audio availability must come from the subtitle worker’s track contract, and production quality/direct-play labels must use actual playback capabilities. A real implementation needs longer titles, missing artwork, large libraries, localization and physical-device validation before adoption.
