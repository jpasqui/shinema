# Dependency license review

Original Shinema code uses MIT. This does not relicense dependencies. No third-party source tree or SDK is vendored; registry artifacts are pinned by lockfiles, and official CI actions are pinned by commit.

The initial lockfile inventory covers 103 Rust packages and 474 npm packages, including platform-only and development dependencies. Every inventory entry has identified license metadata. The sanitized [inventory](dependency-licenses.json) records package/version/license without local paths or account data.

The web preview has a separate [125-package lockfile inventory](web-dependency-licenses.json), including optional platform packages and development tooling. Its metadata includes MIT, Apache-2.0, ISC, BSD-3-Clause and CC-BY-4.0 terms. React, React DOM and Vite use MIT; the official Playwright test packages use Apache-2.0. Chromium and FFmpeg are isolated test tools, not vendored product assets. The same attribution and binary-notice review requirements apply to any eventual web distribution.

Root-only CI tooling is separately pinned in `package-lock.json`, which retains each dependency's license metadata. ESLint, typescript-eslint, Prettier and globals use MIT; TypeScript uses Apache-2.0. These tools are not bundled into either client build. Web CI downloads include the React and React DOM license files plus the existing inventory; Android snapshots retain the development-only notice limitations described below.

Direct Rust dependencies use MIT, Apache-2.0 or an available permissive alternative: axum, Tokio, tokio-util, serde/serde_json, sha2, rusqlite and cap-std. The Rust closure includes Unicode, Zlib, BSD, Boost and LLVM-exception terms; compound AND expressions retain both sets of obligations. A transitive `MIT OR Apache-2.0 OR LGPL-2.1-or-later` package has permissive alternatives; this project does not choose its LGPL alternative.

React, React Native TV and react-native-video carry MIT metadata. Hermes carries BSD-3-Clause terms. The npm closure also includes Apache-2.0, ISC, BSD-2-Clause, 0BSD, Python-2.0 and CC-BY-4.0 metadata. The latter includes build-tool data and attribution requirements; it must not be silently relabeled MIT.

Android runtime/build dependencies are a separate Gradle closure: Media3 and AndroidX use Apache-2.0, while Kotlin uses Apache-2.0. The SDK, JDK, Gradle and local FFmpeg are development tools, not vendored product code. The JSON inventory covers Cargo/npm, not a complete APK notice manifest.

MIT licensing of original code can coexist with these separately retained dependency terms. For any distributed binary, assemble the full runtime notice/license bundle, including native and Maven dependencies, preserve required attribution and NOTICE files, and review any dependency changes. The unsigned development APK is not a public release and no dependency notices have been removed or rewritten.

Primary references: [MIT text](https://opensource.org/license/mit), [Apache 2.0 terms](https://www.apache.org/licenses/LICENSE-2.0), [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/), [Unicode license](https://www.unicode.org/license.txt), [React Native TV](https://github.com/react-native-tvos/react-native-tvos), [react-native-video](https://github.com/TheWidlarzGroup/react-native-video), and [AndroidX Media](https://github.com/androidx/media).

Browser compatibility playback uses hls.js 1.7.3 (Apache-2.0), pinned by the npm lockfile. Its [license text](notices/hls.js-LICENSE.txt) is retained; include it in any runtime distribution notice bundle. Official source revision: `e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de`.

Metadata HTTPS uses reqwest 0.12.28 (MIT OR Apache-2.0), pinned with transitive dependencies by Cargo.lock. See rust-dependency-licenses.json for the complete Cargo metadata inventory. TMDB’s approved blue-short logo is copied unchanged from https://files.readme.io/29c6fee-blue_short.svg, as used in its official developer documentation. It is a TMDB brand asset used for required attribution, not original MIT-licensed artwork. Provider data/artwork licensing is separate from code licensing; no provider data is included in this repository.

Device pairing and sized artwork add three direct Rust dependencies: getrandom 0.4 (MIT OR Apache-2.0) for token and code randomness, and image 0.25 (MIT OR Apache-2.0) with only its JPEG and PNG codecs. The image closure adds zune-jpeg (MIT OR Apache-2.0 OR Zlib), png and miniz_oxide (MIT OR Apache-2.0 family), zlib-rs (Zlib), and moxcms and pxfm (BSD-3-Clause OR Apache-2.0). ts-rs 12 (MIT) is a development-only dependency that generates TypeScript client types during `cargo test`; it is not part of the server binary. rust-dependency-licenses.json lists the full updated closure.

## Shinema app (apps/shinema)

The rebuilt client has its own [533-package lockfile inventory](app-dependency-licenses.json), including build and test tooling. Runtime libraries carry permissive terms: Expo, its modules (expo-video, expo-image, expo-linear-gradient, expo-font, expo-file-system and the others listed in `apps/shinema/package.json`), React, React DOM, react-native-web, React Native TV (`react-native-tvos`) and AsyncStorage use MIT; hls.js 1.7.3 uses Apache-2.0 (its [license text](notices/hls.js-LICENSE.txt) is retained). The closure also includes ISC, BSD, BlueOak-1.0.0, 0BSD, Unlicense, Python-2.0 and CC-BY-4.0 metadata. lightningcss and its platform binaries carry MPL-2.0; they are build-time CSS tooling used by Metro, not shipped in the app, and are not modified. Playwright (Apache-2.0) is test-only.

The app bundles two typefaces under the SIL Open Font License 1.1: Figtree and Source Serif 4, through the `@expo-google-fonts` packages (package code MIT AND OFL-1.1). Their font licenses are retained in [notices/Figtree-OFL.txt](notices/Figtree-OFL.txt) and [notices/SourceSerif4-OFL.txt](notices/SourceSerif4-OFL.txt) and must accompany any distributed build. The Android TV banner, icon and splash are generated from Source Serif 4 and the Shinema palette; they contain no third-party artwork.

