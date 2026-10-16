# Loading, lazy browsing and focus

The library renders its connected shell from the first paint. Loading does not replace one navigation or layout with another. Marquee and Archive reserve artwork frames, bounded title/metadata/summary lines, status areas and control slots. Missing or failed artwork fills the same frame. Delayed metadata can change text and artwork without moving the protected controls.

## Lazy browsing

The UI has no Previous/Next page controls. Server offsets and limits remain internal transport details. A viewport boundary or deliberate remote navigation requests the next bounded batch. Repeated boundary notifications share one request. Completing a batch does not automatically walk the entire library.

Web uses 60-record requests, at most 120 mounted cards, and at most 12 retained metadata batches per query session. Feed requests have three active slots and six queued slots; a new viewport supersedes obsolete queued ranges. Four query sessions retain scroll/focus when returning from details; older sessions are evicted. A compact list of previously loaded boundaries preserves scroll extent and supports direct refetch of evicted ranges. The existing disk cache remains bounded separately. Native uses 48-record requests, five retained batches, two simultaneous feed requests, and a small row window with spacers around the viewport/focus. A connection refresh aborts outstanding feed work before requesting its descriptor/catalogue snapshot. These request bounds describe catalogue batches; artwork and the separate progress/metadata APIs retain their own transport behavior. Artwork decoding is lazy below the feature/detail views.

Rows have stable global slots. Appending cannot splice new titles before an existing focused row. Virtual spacers preserve the coordinates of unloaded or unmounted rows. The focused card remains mounted, and image arrival does not change its hit rectangle. Resizing deliberately recomputes columns while retaining the selected ID and logical anchor.

Search, library ID, library configuration revision, collection and season form a query identity. A reset gets a new generation and aborts obsolete work; a response from an older generation cannot append to the current list. Errors retain existing rows and provide a retry in a reserved slot. A repeated or overlapping batch is rejected. Refresh validates a replacement before discarding the current view.

The library configuration revision protects descriptor scope; it is not a snapshot token for catalogue ordering. Cached range revalidation rejects changed totals, boundaries and retained ID order. It cannot promise a transactionally consistent view across arbitrary server-side reordering of evicted ranges; a reported catalogue change requires explicit refresh. It does not retain every title's metadata to manufacture that guarantee.

## Regression checks

`clients/web/tests/e2e/loading-layout.spec.ts` holds catalogue, summary, metadata and image responses behind explicit gates. It measures header, feature, list, card, text and action rectangles before and after release, failed decoding and a late font with wider metrics. The protected rectangles allow at most one CSS pixel of rounding drift; load-induced Layout Shift entries without recent input must sum to zero. Both skins and phone/desktop viewport sizes are covered.

Append tests check stable node identity, focus, selected IDs, viewport-relative geometry, scroll position, one request per batch, bounded mounted cards, retries, query races and resize. Negative controls deliberately remove reserved geometry or insert duplicate/stale cards and require the independent detectors to fail. These checks are intended to catch regressions, rather than only assert current constants.

Pure web/native feed tests cover duplicate triggers, aborts, late responses, batch validation, cache eviction and focus/window arithmetic. The Rust/browser smoke workloads also exercise generated media and the real loopback API. Run the normal client suites and `npm --prefix clients/web run test:playback`; CI runs them with full Chromium and builds the unsigned Android client.

## Interpretation and limits

User scrolling, switching skins, changing a library/search/season, resizing and opening another screen intentionally change the presentation. The loading assertions isolate data/image/font arrival from those actions. Appending extends the document below the retained anchor; it does not claim every document rectangle remains immobile.

Measurements are synthetic host/browser checks. Native list geometry and request/focus behavior are tested without a physical renderer; Android compilation alone does not verify a TV, physical remote, phone, IME, accessibility service, HDR or frame time. No live NAS, private media or device configuration is part of this validation.

Library navigation consumes stable IDs and descriptor data independently of display labels and media type. The separate library-configuration work owns descriptor fetching, editable names/order/visibility, top-level destinations and Settings/reset. No theme or navigation file loads arbitrary application code.
