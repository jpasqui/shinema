# Shinema

Shinema is a planned unified media server and client product, with a Rust server and React / React Native clients.

## Status

Early prototype stage. This repository currently contains project documentation and repository configuration only. It does not yet contain a runnable server or client, and no production-ready features or platform support are claimed.

## Direction

- **Server:** Rust, with one integrated service for library, playback and user workflows.
- **Web client:** React.
- **Mobile and TV clients:** React Native, using the maintained React Native TV fork for television platforms.
- **TV priority:** NVIDIA Shield / Android TV, with fast D-pad navigation, preserved focus and smooth poster-heavy browsing.
- **Other platforms:** Phones and web are planned from the start. Apple TV is a planned route that requires its own input, cache and player adapters and hardware validation. Desktop delivery is still to be decided.
- **Local-first browsing:** Clients should browse cached library metadata and artwork while server access is unavailable.

Future work includes GPU transcoding, intro and credits skipping, downloads, generated missing subtitles, integrated Radarr/Sonarr requests and custom channels. These are intended capabilities, not implemented features.

## Intended monorepo structure

```text
server/           Rust server and internal crates
clients/web/      React web client
clients/native/   React Native mobile and TV clients
packages/contracts/ Shared API schemas and generated client types
docs/             Architecture and product decisions
```

These directories describe the intended layout; they have not been scaffolded yet. Platform-specific adapters should share domain logic and API contracts where practical, without assuming identical playback or remote behavior across devices.

## Development

Build and run instructions will be added alongside the first implementation. No dependency installation or device setup is needed for this initial repository.

## License

Original Shinema project code is licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses and notices.
