# Catalog queries and SSH metadata process budget

The catalog remains an immutable startup index with bounded offset pages. This change reuses its transactionally stored collection totals instead of counting every matching row for ordinary browse requests. Fixed-series pages use the existing episode-order index without sorting. A series-to-representative-media map replaces a full library scan for every series card, preserving the previous first-media-ID choice.

Movie/episode and series search use the same stored Unicode lowercase text. Normalization is independent of word context and folds both Greek lowercase sigma forms together, so a one-character sigma query also matches a word ending in sigma. Fields remain separate and `instr` remains literal; percent signs, underscores, quotes and NUL input do not become wildcards or field-spanning matches. This is not full Unicode case folding, accent removal or canonical normalization. Ordering remains SQLite NOCASE plus the existing deterministic ID tie-breaker.

The disposable media catalog is rebuilt inside its existing transaction, which upgrades the old eight-column schema. Saved progress is untouched. A failed rebuild rolls back the catalog, its indexes, series rows and totals together. The cost is two extra normalized text columns and one in-memory map entry per series.

SSH scan/stat calls acquire a process-wide four-slot budget before starting a child. Streaming retains its existing separate four-transfer budget. The existing 120-second metadata deadline now includes queueing. A worker owns each metadata permit until the child is stopped and reaped after cancellation, timeout or error. Source size/mtime checks are fresh on every call; SSH identity/trust flags, read-only helper and 128 MiB response bound are unchanged.

## Synthetic benchmark method

The query benchmark generates 100,000 movies plus 1,000 series with 20 episodes each (120,000 items). It uses in-memory SQLite, 60-row pages, three warmups and 30 measured samples per query, with one request at a time. It measures catalog query/JSON construction and the actual series handler including metadata overlay with providers disabled. Deep movie offset is 90,000; movie search is literal `Film 090`; the series page starts at offset 900; the episode query selects one series and season. Setup, filesystem scanning, HTTP transport, network latency and decoding are outside the timed region.

Measurements were made on a Windows x64 host with Rust 1.94.0, optimized release builds and the locked bundled SQLite dependency. Other host activity was uncontrolled, so these are workload observations, not service latency guarantees or a statistical confidence interval. Comparisons use separately retained source-specific executables and serial runs. Filesystem/index construction cost is excluded.

Final serial comparison (milliseconds):

| Workload | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| First movies page | 11.7772 | 0.0775 | 14.5239 | 0.0927 |
| Movies at offset 90,000 | 27.9875 | 4.7971 | 44.0067 | 5.5417 |
| Movie substring search | 311.7036 | 232.0988 | 442.9438 | 292.1211 |
| Fixed-series season episodes | 27.8300 | 0.0862 | 30.8015 | 0.2213 |
| Series page at offset 900 | 33.0572 | 15.0937 | 37.6197 | 23.2329 |

SQLite page allocation increased from 110,514,176 to 114,036,736 bytes (+3,522,560 bytes, about 3.2%). The representative map has 1,000 entries in this workload; its allocator overhead is not included in SQLite bytes. Earlier runs varied substantially with host activity. The query-plan and process-count assertions provide stronger guarantees than the observed latency ratios.

## Reproduce catalog measurements

Run from the repository root with metadata provider environment variables absent:

```powershell
cargo test --workspace --locked --release --lib browse_benchmark -- --ignored --nocapture
```

For the pre-change comparison, `88afa52` is the baseline implementation plus the first benchmark harness. Apply the final harness to that isolated checkout, omitting only the new representative-map setup and its regression test:

```powershell
git worktree add --detach .local/perf-before 88afa52
$harness = Get-Content -Raw server/src/performance_tests.rs
$harness = $harness -replace '(?m)^    owned\.series_entries[^\r\n]*\r?\n', ''
$harness = $harness -replace '(?s)\r?\n#\[test\]\r?\nfn series_representatives.*\z', ''
Set-Content .local/perf-before/server/src/performance_tests.rs $harness -Encoding utf8
cargo test --manifest-path .local/perf-before/Cargo.toml --target-dir .local/perf-before-target --locked --release --lib browse_benchmark -- --ignored --nocapture
```

Use separate Cargo target directories for different source worktrees. Run measurements serially and retain the reported median, p95 and SQLite page bytes. The harness asserts that provider configuration is absent; it never contacts a provider, SSH host, NAS or device. It creates only a temporary empty media root and synthetic in-memory catalog rows. On restricted Windows hosts, point `TEMP` and `TMP` at an ignored writable directory in the checkout.

## SSH subprocess workload

```powershell
cargo test -p shinema-server --lib ssh::tests::benchmark_metadata_process_budget -- --ignored --nocapture --test-threads=1
```

The benchmark runs 32 simultaneous metadata checks on four Tokio worker threads. Each launches a local child, requests a 50 ms wait and returns synthetic JSON. It compares the original unbounded spawn/read/wait lifecycle with the new four-slot lifecycle, counts live child PIDs at each spawn and verifies all children have exited at completion. Windows uses PowerShell; Unix uses `sh`/`sleep`, so absolute latency is not comparable across systems.

One paired Windows debug run observed 25,636.700 ms and 32 live children before versus 19,149.510 ms and four children after: peak process count fell 87.5%. An earlier standalone baseline was 21,883.658 ms, illustrating the timing variance. PowerShell startup and host contention dominate the requested child delay. The reliable result is bounded subprocess fanout; no SSH or NAS latency improvement is claimed.

## Correctness and limits

Regression coverage checks query plans without temporary sorts, stable pages and ID ties, unknown episode numbers, collection/season filters, literal and Unicode search (Latin, Greek and Cyrillic), existing-schema upgrades, saved progress, rebuild rollback, representative selection, real child-process bounds, queued timeout without spawning, cancellation/timeout reaping, error recovery, fresh metadata and response size limits.

Substring search still scans matching collection rows, deep offsets still traverse preceding index rows, and synchronous SQLite work still runs under the existing database mutex. No cursor pagination, full-text index, scan scheduling, persistent service, live NAS, provider, TV/Shield or device-decoder validation is established by this workload. There is no UI change, so unrelated screenshots or recordings are not required.
