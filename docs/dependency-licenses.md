# Dependency license review

Original Shinema code uses MIT. This does not relicense dependencies. No third-party source tree or SDK is vendored; registry artifacts are pinned by lockfiles, and official CI actions are pinned by commit.

The initial lockfile inventory covers 103 Rust packages and 474 npm packages, including platform-only and development dependencies. Every inventory entry has identified license metadata. The sanitized [inventory](dependency-licenses.json) records package/version/license without local paths or account data.

Direct Rust dependencies use MIT, Apache-2.0 or an available permissive alternative: axum, Tokio, tokio-util, serde/serde_json, sha2, rusqlite and cap-std. The Rust closure includes Unicode, Zlib, BSD, Boost and LLVM-exception terms; compound AND expressions retain both sets of obligations. A transitive `MIT OR Apache-2.0 OR LGPL-2.1-or-later` package has permissive alternatives; this project does not choose its LGPL alternative.

React, React Native TV and react-native-video carry MIT metadata. Hermes carries BSD-3-Clause terms. The npm closure also includes Apache-2.0, ISC, BSD-2-Clause, 0BSD, Python-2.0 and CC-BY-4.0 metadata. The latter includes build-tool data and attribution requirements; it must not be silently relabeled MIT.

Android runtime/build dependencies are a separate Gradle closure: Media3 and AndroidX use Apache-2.0, while Kotlin uses Apache-2.0. The SDK, JDK, Gradle and local FFmpeg are development tools, not vendored product code. The JSON inventory covers Cargo/npm, not a complete APK notice manifest.

MIT licensing of original code can coexist with these separately retained dependency terms. For any distributed binary, assemble the full runtime notice/license bundle, including native and Maven dependencies, preserve required attribution and NOTICE files, and review any dependency changes. The unsigned development APK is not a public release and no dependency notices have been removed or rewritten.

Primary references: [MIT text](https://opensource.org/license/mit), [Apache 2.0 terms](https://www.apache.org/licenses/LICENSE-2.0), [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/), [Unicode license](https://www.unicode.org/license.txt), [React Native TV](https://github.com/react-native-tvos/react-native-tvos), [react-native-video](https://github.com/TheWidlarzGroup/react-native-video), and [AndroidX Media](https://github.com/androidx/media).
