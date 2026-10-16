# Configurable libraries and navigation

Libraries give catalog items a stable place in navigation without coupling their display names to content classification. For example, Anime can use the TV handler, and an unrestricted library can contain both movies and episodes from the registered inventory. Renaming a library does not rename files or change media IDs.

## Server configuration and client preferences

The server stores library configuration in its existing private SQLite state. Each library has a stable `id`, editable `name`, canonical `contentTypeId` (an open string or `null`), source folders, `order` and `visible`. Use the library ID for selection, cache keys and requests; use the name only for display. The content type controls handler selection independently of the label. `null` means unrestricted library policy over the currently registered video inventory, without adding other formats or source access.

`mediaType` remains a compatibility alias derived from `contentTypeId`: a non-null ID is returned unchanged, and `null` is returned as `mixed`. `mixed` is reserved for that legacy alias and is rejected as a canonical content type ID; other content type IDs use the same 48-character ASCII identifier grammar as library IDs. If an update explicitly supplies both fields with conflicting values, the server rejects it with 400.

Names must be nonempty, trimmed, at most 80 Unicode scalar values and unique without regard to case; Unicode control (`Cc`) and formatting (`Cf`) characters are rejected. Library IDs use a lowercase letter followed by lowercase letters, digits or hyphens, up to 48 characters. The configuration supports 1-64 libraries, up to 64 source folders per library and order values from 0 to 10,000.

Server names, folder membership, default order and visibility apply to all clients. A client's navigation preferences can adjust order and hide libraries for that client without rewriting the server configuration. These local preferences are not user accounts, access controls or server-wide changes. Hiding a library changes navigation; it does not protect its media from API access.

The web settings screen separates server library management from local navigation preferences. Management requires operator authorization. Native consumes descriptor labels, server order and visibility, and preserves its locally selected library. It does not yet offer the web client's per-client top-navigation editing UI.

## Per-client top navigation

Top-navigation entries are declarative data in `packages/contracts/navigation.ts`. Each entry has a stable `id`, editable `label`, `destination`, `order` and `visible`. Supported destinations are browse, one library by `libraryId`, search and settings:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "anime-shortcut",
      "label": "Anime",
      "destination": { "kind": "library", "libraryId": "anime" },
      "order": 0,
      "visible": true
    }
  ]
}
```

The web client stores these preferences locally. Its `TopNavigation.tsx` component renders the shared contract, allowing skins to share the same behavior. The default entry opens Library browsing. A fixed Settings control and reset remain reachable even when all configurable entries are hidden. Entries pointing to missing or globally hidden libraries stay saved but do not appear until their destination becomes available again. Invalid saved preferences recover to defaults.

Up to 16 entries are supported. Labels use the same length and character limits as library names and must be distinct after Unicode compatibility normalization and lowercasing. Destinations are an allowlist, with no arbitrary URL, script or callback. Editing a shortcut label does not rename its destination library or grant access to it.

## Public contract

`GET /api/libraries` returns a versioned envelope with `revision`, ordered `libraries`, and an additive `registry` snapshot suitable for the existing library cache. The public response contains no server paths or source details. For example, a library descriptor is:

```json
{
  "id": "tv",
  "name": "Anime",
  "contentTypeId": "tv",
  "mediaType": "tv",
  "visible": true,
  "order": 0
}
```

Use `library=<id>` on catalog and series requests to scope both browsing and search. The library ID belongs in the request/cache identity alongside search, series, season and pagination. A delayed response for a previous library must not replace the current library's results. Empty libraries remain valid navigation destinations with an empty state.

The older `collection=all|movies|tv` filter remains a media-type compatibility filter. A custom library label does not introduce a new `collection` value. Existing media, playback and progress endpoints continue to use the unchanged opaque media ID.

`GET /api/content-registry` exposes the same versioned content/format descriptors independently of library display configuration. Availability and `metadata`, `play`, `view` and `launch` capabilities describe implemented server actions; clients also require a compatible renderer. Unknown content IDs remain visible with an explicit unsupported state, retaining membership and progress. They are not coerced to Movies or TV. [The registry contract](api.md#content-registry) and [architecture boundaries](server-client-architecture.md#content-types-formats-and-actions) explain the distinction.

## Operator API and source boundary

Library management is guarded by `ManagementAccess::can_manage_libraries`. That interface leaves room for future owner/login permissions without coupling accounts to catalog organization. No account subsystem is implemented by this change.

The current loopback development server has temporary operator controls, collapsed separately in the web settings UI. Developers can enable them with a private `SHINEMA_ADMIN_TOKEN` of 32-256 non-space printable ASCII characters, supplied to `GET /api/admin/libraries` and `PUT /api/admin/libraries` as `Authorization: Bearer <token>`. Absent, invalid or unmatched authorization receives 403. This is a development mechanism, not the intended consumer setup experience or production authentication. Keep it outside Git and out of URLs. The existing loopback request boundary remains in effect.

The operator response includes source folder selections and `availableFolders`. Folder choices are relative to the already approved source roots and limited to the source's reported inventory. For local storage, `.` selects the approved root's inventory, and existing subfolders can be selected even when empty. SSH choices consist of approved root labels and ancestor folders of indexed media; SSH does not offer a virtual `.` selector or empty subfolders without indexed descendants. Use the returned choices rather than assuming every source supports the same selectors.

Exact duplicate folder selections are rejected across libraries. Nested selections are supported: the longest matching folder wins, so an Anime library selecting `tv/Anime` can sit alongside TV shows selecting `tv`. Previously selected folders can remain configured while temporarily absent; only indexed entries are assigned. Approving or changing server roots remains an out-of-band server configuration task under the existing source access rules.

A save submits `{ "revision": ..., "libraries": [...] }` with the complete proposed configuration, subject to a 64 KiB request-body limit. The server validates it and uses revision comparison to reject concurrent stale edits with 409; reload and reconcile after a conflict. A successful save advances the revision and commits configuration, membership and classification together. An invalid request leaves the previous configuration in place. These routes cannot accept arbitrary filesystem paths, change remote connection settings, create credentials or browse outside approved roots.

## Migration and data preservation

On first use, existing media receives default Movies and TV shows libraries with stable IDs `movies` and `tv`. Other videos (`other`, with `contentTypeId: null`) retains unmatched items and is visible by default when the initial scan contains uncovered media. It cannot be removed or have its unrestricted content policy or automatic source membership edited; its name, order and visibility remain configurable. Existing source-relative media IDs, catalog records and progress remain intact. Configuration then survives restarts in the same state directory.

Saved legacy-only configuration migrates in place: `movies` and `tv` become their corresponding content type IDs, while `mixed` becomes `null`. Library/media IDs and progress are preserved. A legacy-only PUT also preserves a saved unknown content type instead of accidentally clearing it through the compatibility alias. Unknown IDs survive save/restart even while their handler is unavailable.

Library edits update membership and classification from the current index. They do not trigger a destructive reindex, delete progress or write to media. Changing a display name, order or visibility does not alter media identity. Moving or renaming an actual source file still follows the existing media ID behavior described in [the API guide](api.md).

Old clients can continue using media-type collection filters. New clients should select by library ID and handle an empty descriptor list, hidden libraries and a selected ID that is no longer available. Client-specific navigation preferences should fall back to current server defaults when their saved IDs are unavailable.

## Present limits

- Folder selection uses the successful startup scan. Restart the development server to discover newly added media and local folders; saving library configuration is not a rescan. An empty SSH subfolder becomes selectable only after the scan indexes media beneath it; approved SSH root labels remain selectable when empty.
- Operator folder choices are bounded to 10,000 entries, with `availableFoldersTruncated` indicating a larger inventory.
- Configuration changes organize the indexed catalog. They do not move source files, configure a NAS, create credentials or expand the server's approved roots.
- Only the initial Movies/TV handlers and existing generic video inventory are implemented. Music, audiobook, game and document handlers remain future work. Open IDs and format descriptors do not enable new indexing/playback adapters; all current launch capabilities are false.
- Navigation visibility is a convenience, not authorization. There is still one development progress profile and no per-user library permissions or synchronized navigation profiles.
- The native client appends 48-record batches with a bounded row window and five retained metadata batches. It does not yet expose per-client top-navigation editing. See [loading and browsing](loading-and-browsing.md) for request, cache and focus limits.
- Host checks and generated fixtures establish configuration and catalog behavior. They do not establish native device playback or remote-control performance.

The lasting product direction is recorded in [design principles](design-principles.md).
