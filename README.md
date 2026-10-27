# Shinema

A self-hosted media server in Rust with one app for Android TV, the web and Android phones.

## Status

Early development under draft review; not a production deployment. The clients are being rebuilt as one app ([ADR 0001](docs/decisions/0001-client-rebuild.md)).

- **Server** (`server/`): Rust. Scans media folders (skipping unreadable ones), rescans every 15 minutes, streams with byte ranges or HLS transcoding, keeps watch progress in SQLite with newest-write-wins ordering, and serves sized artwork. Bound to loopback it needs no sign-in; bound to the home network it requires devices to pair with a six-digit code. It speaks plain HTTP; use a reverse proxy for HTTPS outside the home. See the [API](docs/api.md).
- **App** (`apps/shinema/`): one Expo + React Native TV app for Android TV and the web, with Android phones next. Same screens and look everywhere. See [the app guide](docs/app.md).
- **Old clients** (`clients/native/`, `clients/web/`): frozen to bug fixes and removed once the new app replaces them on the Shield.
- **CI** checks Rust formatting, lint and tests; shared and app types and tests; browser behaviour at TV and desktop sizes; and builds an installable Android TV APK.

Hardware validation on the Shield and performance budgets on a low-end Google TV stick are still to do.

## Repository

```text
server/                  Rust server
apps/shinema/            The app: Android TV, web, Android phone (Expo)
packages/core/           Shared client data layer: API client, progress sync, paging, captions
packages/contracts/      Response validators shared by the clients
packages/design-tokens/  Shared palette and theme contract
clients/native/          Previous Android TV client (being replaced)
clients/web/             Previous web preview (being replaced)
docs/                    Setup, API, decisions and dependency license review
scripts/                 Generated fixtures and host integration checks
```

[Development and setup](docs/development.md) explains tools, environment variables and checks. No private media, server paths, configuration, credentials, signing keys or built binaries belong in this repository.

## Product direction

Shinema pairs sensible defaults with configurable organization and presentation, while keeping playback, security and data integrity dependable. See the lasting [design principles](docs/design-principles.md), [server and client architecture](docs/server-client-architecture.md) and [library and navigation configuration](docs/libraries.md).

NVIDIA Shield / Android TV is the first television target, with the web alongside it and Android phones next. Apple TV is supported by the stack but not scheduled. Shared domain logic lives in `packages/core`; only input, storage and playback differ by platform.

CPU compatibility transcoding and full-duration web playback are under development; see [full-library setup](docs/full-library.md).

GPU transcoding, intro/credits skipping, downloads, generated missing subtitles and custom channels remain future work. Radarr/Sonarr requests, themes and SSH libraries exist on the server but are paused in the new app until after v1.

## Contribution workflow

All changes use branches and pull requests, including documentation and fixes. Incomplete work remains in draft; merging requires approval. See [AGENTS.md](AGENTS.md) and [contribution verification guidance](CONTRIBUTING.md).

## License

Original Shinema project code is licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses and notices; see [dependency review](docs/dependency-licenses.md).
