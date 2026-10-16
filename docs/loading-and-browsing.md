# Loading, lazy browsing and focus

The library renders its connected shell from its first application frame. Marquee and Archive reserve artwork frames, bounded title/metadata/summary lines, status areas and control slots. Missing or failed artwork fills the same frame. Delayed metadata can change text and artwork without moving the protected controls.

The collections row keeps its 44-pixel reservation even when no libraries are visible. Collection controls use fixed-width cells in a bounded horizontal strip, so discovering more libraries does not shrink existing controls. Saved client order reserves unresolved IDs as inert cells. Top navigation also retains the physical positions of saved visible entries when a target is missing or hidden, while canonical visibility still determines which entries may be activated. Hide, remove or reset a saved entry to reclaim its reserved position.

Initial descriptor discovery is distinct from using a validated cached feed. The header, feature and feed remain visible while the collections row shows inert loading cells; library labels and actions become authoritative after the initial descriptor attempt settles. This avoids briefly presenting a guessed or stale interactive order when an unseen server library belongs first. A failed initial attempt can use a previously validated descriptor cache. Initial library discovery has a ten-second request bound; no unresolved or hidden destination can issue a scoped browse request.

If an outage exposes cached collection controls, their mounted positions survive reconnecting. Current descriptors still decide labels and actions, so removed or hidden destinations become inert reserved cells. An explicit local order/visibility edit releases that fallback reservation. A failed fresh discovery stops reporting a busy request and offers Refresh in the existing shell. Warning boxes reserve their full bounded height so wrapping or delayed fonts cannot move them; overflow remains readable by scrolling.

## Lazy browsing

The UI has no Previous/Next page controls. Server offsets and limits remain internal transport details. A viewport boundary or deliberate remote navigation requests the next bounded batch. Repeated boundary notifications share one request. Completing a batch does not automatically walk the entire library.

Web uses 60-record requests, at most 120 mounted cards, and at most 12 retained metadata batches per query session. Feed requests have three active slots and six queued slots; a new viewport supersedes obsolete queued ranges. Four query sessions retain scroll/focus when returning from details; older sessions are evicted. A compact list of previously loaded boundaries preserves scroll extent and supports direct refetch of evicted ranges. The existing disk cache remains bounded separately. Native uses 48-record requests, five retained batches, two simultaneous feed requests, and a small row window with spacers around the viewport/focus. A connection refresh aborts outstanding feed work before requesting its descriptor/catalogue snapshot. These request bounds describe catalogue batches; artwork and the separate progress/metadata APIs retain their own transport behavior. Artwork decoding is lazy below the feature/detail views.

Rows have stable global slots. Appending cannot splice new titles before an existing focused row. Virtual spacers preserve the coordinates of unloaded or unmounted rows. The focused card remains mounted, and image arrival does not change its hit rectangle. Resizing deliberately recomputes columns while retaining the selected ID and logical anchor.

Search, library ID, library configuration revision, collection and season form a query identity. A reset gets a new generation and aborts obsolete work; a response from an older generation cannot append to the current list. Errors retain existing rows and provide a retry in a reserved slot. A repeated or overlapping batch is rejected. Refresh validates a replacement before discarding the current view.

The library configuration revision protects descriptor scope; it is not a snapshot token for catalogue ordering. Cached range revalidation rejects changed totals, boundaries and retained ID order. It cannot promise a transactionally consistent view across arbitrary server-side reordering of evicted ranges; a reported catalogue change requires explicit refresh. It does not retain every title's metadata to manufacture that guarantee.

## Regression checks

`clients/web/tests/e2e/cold-start.spec.ts` installs its observer before navigation or React mounting. It retains every animation-frame and DOM-mutation sample across entry loading, descriptor/registry hydration, catalogue, summary, artwork and delayed font resolution. It compares viewport rectangles, scroll, overflow, permanent shell identity, reserved physical cells and every visible logical title slot; it does not reset startup history or rely solely on CLS. Normal-motion TV-sized and phone viewports, reduced motion, saved appearance, stale caches and unavailable storage are covered. Reproductions include all-hidden libraries, saved custom links, phone collection growth and insertion before cached or client-ordered collections.

The shipped typography choices use local font stacks; themes cannot import a font or URL. The warm browse-cache positive case retains those shipped fonts. A separate negative control replaces an already painted cached title's family with an injected wider face and requires the raw CLS detector to catch its text-fragment movement even when the title's enclosing rectangle stays fixed. This synthetic typography override is not represented as a production font-loading path or a stable result.

`clients/web/tests/e2e/loading-layout.spec.ts` holds catalogue, summary, metadata and image responses behind explicit gates. It measures header, feature, list, card, text and action rectangles before and after release, failed decoding and a late font with wider metrics. The protected rectangles allow at most one CSS pixel of rounding drift; load-induced Layout Shift entries without recent input must sum to zero. Both skins and phone/desktop viewport sizes are covered.

Append tests check stable node identity, focus, selected IDs, viewport-relative geometry, scroll position, one request per batch, bounded mounted cards, retries, query races and resize. Negative controls deliberately remove reserved geometry or insert duplicate/stale cards and require the independent detectors to fail. These checks are intended to catch regressions, rather than only assert current constants.

Pure web/native feed tests cover duplicate triggers, aborts, late responses, batch validation, cache eviction and focus/window arithmetic. The Rust/browser smoke workloads also exercise generated media and the real loopback API. Run the normal client suites and `npm --prefix clients/web run test:playback`; CI runs them with full Chromium and builds the unsigned Android client.

## Interpretation and limits

User scrolling, switching skins, changing a library/search/season, resizing and opening another screen intentionally change the presentation. The loading assertions isolate data/image/font arrival from those actions. Appending extends the document below the retained anchor; it does not claim every document rectangle remains immobile.

Measurements are synthetic host/browser checks. Native list geometry and request/focus behavior are tested without a physical renderer; Android compilation alone does not verify a TV, physical remote, phone, IME, accessibility service, HDR or frame time. No live NAS, private media or device configuration is part of this validation.

Cold-start evidence must begin before navigation and retain the entire startup take, including pre-application frames. Each take identifies its exact source/build, viewport, motion setting and real or mocked transport. A historical comparison must be identified separately. A montage cannot establish startup continuity. Capture completion requires the geometry, identity and scroll checks to pass, not just successful recording or a zero CLS value.

Library navigation consumes stable IDs and descriptor data independently of display labels and media type. The separate library-configuration work owns descriptor fetching, editable names/order/visibility, top-level destinations and Settings/reset. No theme or navigation file loads arbitrary application code.

A short server batch cannot strand the current viewport: one replaceable demand set drains missing pinned offsets as bounded request slots become available. A newer viewport replaces that demand; explicit failures wait for user retry.

A delayed tail request may move keyboard focus only while its original card and navigation intent remain current. New arrow input, Search, Settings or another control cancels that pending focus move.

Native startup recovers saved catalogue, progress and pending updates independently of startup navigation. Explicit connections and cache writes await that recovery, so early input or exit cannot replace unread durable state with a fresh cache. A failed read blocks writes until a successful retry; a different server never borrows another server's pending progress.

Content support comes from the canonical registry and installed client adapters. Unknown library/type/format IDs retain their identity and cached records; an unavailable library shows an explanation before any scoped browse request, and an unavailable item cannot start resume or playback work. Display labels remain independent of those IDs. See [the server/client architecture](server-client-architecture.md) for the registry contract and intentionally deferred handlers.
