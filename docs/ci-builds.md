# CI builds and checks

Every pull request and push to `main` runs **Checks** (`.github/workflows/ci.yml`). Artifacts are named with the commit and kept for 14 days. They are development builds: no store publishing, production signing or deployment is configured, and no secrets or private library data are used.

## Jobs

| Job | What it checks | Artifacts |
| --- | --- | --- |
| `javascript-quality` | ESLint and Prettier for the repository, design-token and core tests, and the core type-check (including the server/client contract check). | none |
| `server-and-contracts` | `cargo fmt`, `clippy -D warnings` and `cargo test`; the remote reader's Python tests; that `packages/core/src/generated` matches the Rust API types; and `scripts/host-smoke.mjs` against the real server. | `shinema-generated-types-<commit>` |
| `app` | The app's type-check and unit tests, a web export, and the Playwright suite at TV (960x540), desktop and phone sizes against the mock server with a generated 30-second clip. | `shinema-app-web-<commit>`, `shinema-app-screens-<commit>` |
| `app-android-tv` | Generates the Android TV project (`EXPO_TV=1 expo prebuild`) and builds a release APK. | `shinema-app-android-tv-<commit>` |
| `app-android-phone` | The same app built for phones and tablets. | `shinema-app-android-phone-<commit>` |
| `app-android-tv-screens` | Installs the TV APK in an Android TV emulator, drives it with D-pad key events over plain HTTP against the mock server, and screenshots connect, library, detail, player, seek and Back. | `shinema-app-android-tv-screens-<commit>` |

Compare the `shinema-app-screens` (web) and `shinema-app-android-tv-screens` (emulator) images to see that the TV and web builds look the same. An emulator is not a Shield: decoding, frame rate and remote feel still need the real device.

## Installing a development APK

The Android APKs are release builds signed with the default development key that `expo prebuild` generates, so they install directly:

```bash
adb install shinema-app-android-tv.apk
```

They use the package name `io.shinema.tv`, the same as the previous TV client. Android only installs over an existing app signed with the same key; if the old app was signed differently, uninstall it first.

## Caches and permissions

Rust caches hold only Cargo registry/git dependencies and build output, keyed by runner OS, toolchain, lockfile and source hash. Workflows use read-only repository permissions and SHA-pinned actions, and run without path filters so required checks are never stranded.
