# Shinema

A unified media product with a Rust server and React / React Native clients.

## First usable slice

The implementation branch contains a read-only Rust catalog/streaming server and a React Native TV client for browse, detail, direct playback and resume. It is early development work under draft review. Hardware validation and a real read-only test library are still required; this is not a production deployment.

- The server recursively scans configured media folders, exposes opaque media IDs, supports single byte-range streaming, and stores resume progress in a separate SQLite state directory.
- The client preserves library selection through detail/player/Back, browses an app-private cached catalog, and queues local progress for server sync.
- HTTPS is required by the client with normal platform trust. The server currently binds only to loopback; TLS termination and production authentication are not implemented.
- CI checks Rust formatting/lint/tests, shared contract/client tests and types, host HTTP integration and an unsigned Android release build.
- The stacked React web preview adds a responsive generated-media library, HTML5 direct playback, cached browsing and resume. Its isolated Chromium workload verifies browser rendering and playback; see [web setup and checks](docs/web-preview.md).

## Repository

```text
server/              Rust server
clients/native/      React Native TV client (Android first)
clients/web/         React web preview
packages/contracts/  Shared API schemas, types and runtime parsers
packages/design-tokens/ Shared web design tokens
docs/                Setup, API and dependency license review
scripts/             Generated fixtures and host integration checks
```

[Development and setup](docs/development.md) explains tools, environment variables and checks. [API definitions](docs/api.md) describe the first-slice contract. No private media, server paths, configuration, credentials, signing keys or built binaries belong in this repository.

## Product direction

NVIDIA Shield / Android TV is the first required television target. React web, React Native phone clients and an Apple TV route are planned; desktop delivery is undecided. Those platforms are not validated by this Android slice. Shared domain logic and API contracts should coexist with platform-specific input, cache and playback adapters.

CPU compatibility transcoding and full-duration web playback are under development; see [full-library setup](docs/full-library.md).

GPU transcoding, intro/credits skipping, downloads, generated missing subtitles, integrated Radarr/Sonarr requests and custom channels remain future work.

## Contribution workflow

All changes use branches and pull requests, including documentation and fixes. Incomplete work remains in draft; merging requires approval. See [AGENTS.md](AGENTS.md) and [contribution verification guidance](CONTRIBUTING.md).

## License

Original Shinema project code is licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses and notices; see [dependency review](docs/dependency-licenses.md).
