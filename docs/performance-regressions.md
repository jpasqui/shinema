# Performance regression protection

The normal Rust and browser CI jobs enforce deterministic work/resource limits. A separate read-only performance job builds the exact PR base and head, runs an identical synthetic release benchmark on the same runner, and retains an audited advisory comparison. Timing changes do not fail CI. No device, NAS, credentials, secrets, deployment or security-setting change is involved.

This change is stacked on performance PR #12. Its implementation is a dependency, not copied into a competing branch. PR #14 owns authored skins and their no-extra-request/video-preservation checks. The new client budget spec uses stable browsing roles and does not modify those files. Retarget this PR to main after #12 merges; the benchmark runner also supports a pre-#12 base using a narrowly defined fixture compatibility shim.

## Blocking structural budgets

The versioned source of truth is `server/src/performance-budgets.json`. The Rust tests use 100,000 generated movies plus 1,000 series with 20 episodes each, with provider access disabled. Requests go through the actual HTTP router. The `maxWireBytes` budget measures serialized JSON response body bytes, excluding HTTP headers and transport framing; query work uses SQLite statement counters, not elapsed time.

| Workload | Rows | Response bytes | SQL statements | Full-scan steps | Sorts | VM steps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First movies page | 60 | 24,000 | 3 | 0 | 0 | 1,000 |
| Movies offset 90,000 | 60 | 24,000 | 3 | 0 | 0 | 500,000 |
| Movie substring search | 60 | 24,000 | 3 | 0 | 0 | 2,000,000 |
| Fixed series/season episodes | 20 | 14,000 | 3 | 0 | 0 | 1,000 |
| Series page offset 900 | 60 | 14,000 | 2 | 1,000 | 0 | 10,000 |

These are maximums for the defined neutral fixture, not general payload limits for every possible enriched media record. Deep offsets and literal substring search still do linear work; their VM budgets reflect that. A page must visit zero complete in-memory library entries, and a series page may make at most 60 indexed representative lookups. Test-only instrumentation observes the production query/handler path. An index-removal probe and the original full-library iteration pattern are rejected by the gates despite returning correct results. Over-budget probes check each declared field.

Resource tests preserve four SSH metadata processes and two codec jobs, and exercise the existing segment/probe cache ceilings. The tests bound resource work and cleanup; they do not promise a wall-clock SSH, codec or cache latency. Existing source freshness/trust and cache safety rules remain in force.

The client performance spec mounts at most 60 cards against a 10,001-title synthetic API total, requires explicit request limits at most 60, and checks a precise first/next/previous flow with a simulated idle interval. The Vite development fixture uses React StrictMode: its calibrated ceilings include four initial catalog requests, two summary requests and four library-discovery requests, because App and LibraryBrowser each discover libraries twice. One catalog request per page action gives total API ceilings of 10 initially, 11 after Next and 12 after Previous; browsing makes no media requests. Selected-title playback descriptor work has a two-request development ceiling. These are deterministic development-fixture limits, not production request-count guarantees. PR #14 separately checks that skin changes add no catalog/playback requests and do not remount the video.

Run structural checks with:

```sh
cargo test --workspace --locked
npm --prefix clients/web run test:playback
```

## Advisory base/head measurements

The ignored release test measures five catalog/series workloads, with three warmups and 30 samples each, concurrency one, in-memory SQLite and no providers. It outputs median/p95 milliseconds and SQLite allocation bytes. The runner applies the same head-owned harness to isolated exact-source worktrees, builds both sources before measuring either, uses separate Cargo targets, and runs them serially. On a pre-#12 source it removes only the representative-map fixture assignment if that field does not exist, and adds the test module declaration if absent. It never changes the source implementations being compared.

```sh
python scripts/run_performance.py --head <exact-head-sha> --base <exact-base-sha>
```

The invoking checkout must be the exact head commit. Git objects must already be available; the script does not fetch arbitrary repositories. It retains build worktrees/logs under ignored `.local/performance-runs` and writes only `head.json`, optional `base.json`, and canonical `summary.md` under `ci-artifacts/performance`. Run with sufficient disposable disk space for two separate release builds. On restricted Windows hosts, set `TEMP` and `TMP` to an ignored writable directory.

Reports contain exact source SHAs, workload/schema identity, Rust/SQLite versions, OS/architecture enums, budget version and canonical policy SHA-256. No host names, usernames, paths, media titles, configured origins or device IDs are accepted. The summary shows absolute and relative median/p95 changes and SQLite allocation changes. It does not turn an arbitrary percentage into a noisy failure threshold.

Missing baseline source or a baseline incompatible with the shared harness produces a clearly unavailable comparison with head observations only. Baseline preparation/build/measurement failures emit a constant warning and retain local diagnostics; a head failure remains blocking. Different fixture IDs, workloads, environments or existing policy versions/digests suppress all deltas. A baseline predating the budget manifest receives an explicit caveat; matched workloads/environments can still show timing deltas. Threshold edits are detected by hashing policy contents even if the version is not bumped. An unavailable baseline never produces timing deltas or an improvement claim.

The workflow runs on PRs and main pushes, with optional manual invocation. PRs compare the exact event base/head; main pushes compare the previous commit. The job summary and 30-day JSON artifacts provide per-change history, not a permanent trend dashboard. Collect stable runner observations before considering any blocking relative-time policy. Filesystem scanning/index construction, HTTP transport, UI render/animation, network, decoding and hardware are outside this catalog timing benchmark. Existing browser playback/continuity checks remain separate.

## Artifact and workflow boundary

The workflow uses `contents: read`, pinned actions and checkout without persisted credentials. It does not use `pull_request_target`, a privileged `workflow_run`, secrets, PR comments or security-setting changes. PR code and its measurements remain untrusted; there is no privileged consumer of their artifacts.

The auditor allows only the three fixed filenames, ordinary singly linked files/directories, bounded UTF-8 JSON with exact fields, finite constrained numbers, and safe enumerated/version/hex strings. It rejects duplicate keys, nonfinite or boolean numeric values, unknown fields/files, links/reparse points, oversized files, fabricated roles/revisions and arbitrary Markdown. Summaries are regenerated only from validated values and must match the canonical text. Artifacts are uploaded only after the runner and independent final audit succeed; logs, binaries, raw fixtures and media are excluded.

```sh
python scripts/test_performance_report.py
python scripts/test_run_performance.py
node --test scripts/test_hardware_performance.mjs
```

Tests cover comparator sign/math changes, arbitrarily large advisory slowdowns, policy edits without version changes, changed fixtures/environments, missing/pre-budget baselines, private string injection, file/link/schema attacks and invalid source preparation. Structural and client tests contain explicit over-budget proofs. No baseline-relative timing guarantee is claimed.

## Hardware coverage

The offline analyzer and dormant manual sampler are documented in [Hardware performance measurements](hardware-performance.md). The operator must separately authorize and perform any real collection. There is no automated ADB, SSH, device/browser discovery, TV connection or NAS access. Synthetic tests validate calculations and teardown only. Startup/seek compositor callbacks, input-to-rAF proxies and frame counters are distinct from physical display latency and native Shield performance, which remain unmeasured.

The workflow design follows GitHub's [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and [artifact guidance](https://docs.github.com/en/actions/tutorials/store-and-share-data): keep untrusted PR execution unprivileged and treat retained measurements as data, never executable instructions.
