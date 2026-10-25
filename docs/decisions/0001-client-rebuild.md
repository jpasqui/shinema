# 0001: Rebuild the clients as one Expo app

Status: accepted (2026-10-25)

## Context

Shinema has two hand-written clients: a React web preview (`clients/web`) and a React Native Android TV client (`clients/native`). They share only the palette and five appearance settings from `packages/design-tokens`; layout, spacing, typography and composition are authored twice. On the Shield the app looks different from the web, the parity work in PR #18 never merged, and the progress, paging and cache logic is duplicated with different constants and different bugs.

Apple TV is on the roadmap and has no web view, which rules out running the web UI in a TV shell. Flutter and Compose Multiplatform have no official tvOS support, and no Rust UI framework covers TV input, tvOS and native video playback today.

## Decision

1. Keep the Rust server. Extend API v1 additively for multi-device use.
2. Replace both clients with one Expo app using `react-native-tvos` as its React Native dependency, rendered on the web with react-native-web. Video uses each platform's native player behind an adapter.
3. Screens use only a small component kit. Fonts are bundled so every platform renders the same faces. CI compares screenshots across platforms.
4. Client types for server responses are generated from the Rust structs with `ts-rs`, and a compile-time check fails if the client's validated types drift from them. Type checking stays on TypeScript 6 for now: typescript-eslint relies on TypeScript's programmatic API, which TypeScript 7 does not yet offer as stable. Move to 7.x once it does.

## Scope for v1

- In: browse, library switching, series and seasons, detail, playback with resume, text subtitles, device pairing, settings.
- Platforms: Android TV (Shield) and web.
- Paused until after v1: themes and skins, Radarr/Sonarr requests, SSH libraries. Their server code stays; the new client does not expose them yet.
- After v1: Android phone, then Apple TV.

## Network and sign-in

- Devices pair with a short code. The server prints a code at startup when no device is paired, and the server machine (or the admin token) can create more. A device enters the code once and receives its own revocable token.
- On the home network the server speaks plain HTTP, as Jellyfin does by default. HTTPS for access from outside the home is handled by a reverse proxy (for example Caddy or Tailscale), not by the server.
- Binding to loopback keeps today's behaviour: no token required, loopback host checks only. Binding to any other address turns on token checks for every API route except health and pairing.

## Consequences

- `clients/web`, `clients/native` and their evidence tooling are frozen to bug fixes and deleted at cutover.
- The server gains a devices table, progress timestamps, resilient and repeatable scans, sized artwork variants and generated TypeScript bindings.
- Android TV builds run on EAS or on a machine with the Android SDK; tvOS builds run on EAS.
