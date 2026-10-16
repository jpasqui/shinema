# API version 1

The Rust server and TypeScript client share the field definitions in `packages/contracts/api.schema.json` and the runtime parsers in `packages/contracts/index.ts`. Unknown API versions are rejected. Client stream paths must correspond exactly to the returned opaque media ID; catalog data cannot introduce arbitrary local or remote URLs.

The unauthenticated development server accepts only `localhost` or literal loopback IP request authorities, with an optional valid port. Requests must supply one `Host` or a URI authority; conflicting or duplicate authorities are rejected. Browser `Origin`, when present, must be an HTTP(S) loopback origin, and cross-site Fetch Metadata requests are rejected. These checks run before API and static-file handlers and return 403. Loopback development proxies may forward their own host/port; clients such as FFmpeg may omit `Origin`. This boundary does not provide authentication against other local applications.

| Method and path | Response |
| --- | --- |
| `GET /health` | Status, API version, active codec jobs and bounded-cache statistics |
| `GET /api/catalog` | A bounded page: API version, items, total, offset, limit and nextOffset |
| `GET /api/library` | Total media, TV, Movies and series counts |
| `GET /api/libraries` | Versioned library descriptors: stable ID, display name, content type policy, order, visibility and registry snapshot |
| `GET /api/content-registry` | Public versioned content-type and format descriptors with availability and action capabilities |
| `GET /api/admin/libraries` | Operator-authorized library configuration and approved relative source choices |
| `PUT /api/admin/libraries` | Operator-authorized configuration update with revision conflict checking |
| `GET /api/series` | Paged series titles, episode counts and season counts |
| `GET /api/series/{id}/seasons` | Season numbers and episode counts |
| `GET /api/media/{id}/playback` | Full source duration, direct/transcode mode and its exact playback path |
| `GET /api/media/{id}/hls/index.m3u8` | Complete VOD playlist for compatibility playback |
| `GET /api/media/{id}/hls/{index}.ts` | Requested on-demand compatibility segment |
| `GET /api/media/{id}/stream` | Direct file bytes; a single valid byte range receives 206 |
| `HEAD /api/media/{id}/stream` | The same length/type/range headers, without a body |
| `GET /api/media/{id}/progress` | `Progress` or `null` |
| `PUT /api/media/{id}/progress` | Validated `Progress`; successful save returns 204 |

Media has `id`, `title`, `container`, `sizeBytes`, and `streamPath`. No server filesystem path is returned. IDs hash the media-relative path, remain stable through server restarts, and change when a file is renamed. This first slice lists filename-derived titles and format/size metadata; it does not scrape posters or private metadata.

Ordinary Unicode path components are joined with `/` for portable stable IDs; actual filename characters are preserved. Non-Unicode names use a versioned, length-framed encoding of raw platform units, so lossy display replacements cannot merge distinct entries. Ordinary existing path IDs remain unchanged. Titles are limited to 200 Unicode scalar values in both Rust and TypeScript, rather than 200 JavaScript UTF-16 units.

Progress has finite `positionSeconds` and `durationSeconds`; position must be between zero and duration, and duration must be positive and no greater than one week. This is one shared development profile, not an authentication or multi-user system. A position within three seconds of the end starts playback from the beginning.

Supported range forms are `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`. Invalid, multiple and unsatisfiable ranges receive 416 and `Content-Range: bytes */size`. The original range endpoint does not implement multipart ranges or conditional `If-Range` validation. Compatibility playback is a separate full-duration HLS path. Files are opened for reading relative to a directory capability and streamed in chunks; they are not loaded entirely into memory.


Catalog filters are a stable `library` ID, `collection=all|tv|movies`, an opaque `series` ID, integer `season`, literal `search`, `offset` and `limit`. Limit is 1-500; the web browser uses 60. The legacy default is a first page of 500, with `total` and `nextOffset` explicitly reporting the rest. The index itself has no 500-item or eight-directory-depth truncation. `/api/series` supports library-scoped paged literal search. SQL values are bound parameters. The older `collection` filter describes media type independently of library labels. See [libraries and navigation](libraries.md) for descriptor contracts, operator authorization, approved folder matching, migration and client preferences.

Media optionally includes `contentTypeId`, `collection`, `seriesId`, `seriesTitle`, `season` and `episode`. `collection` is a deprecated compatibility classification field. When an explicit canonical `contentTypeId` is also present, shared contracts require agreement, including explicit `null`, and reject conflicting payloads to preserve unknown identity. TV grouping uses the top-level series folder and S01E02-style filenames, with a Season N folder fallback. Unknown episode numbers stay unknown; they are not fabricated. MP4, M4V, MKV, WebM, AVI, TS, M2TS, MOV, MPG, MPEG, WMV and VOB are indexed. Non-video sidecars are not presented as videos. SSH source IDs include an opaque source/root namespace; source paths, hostnames and credentials are not returned.

## Content registry

`GET /api/content-registry` returns a data-only registry with the following shape. Library responses also carry it in the additive `registry` field, allowing clients to retain the capability snapshot with cached descriptors. The shared initial manifest is `packages/contracts/content-registry.json`.

```ts
type Capabilities = {
  metadata: boolean;
  play: boolean;
  view: boolean;
  launch: boolean;
};
type ContentDescriptor = {
  id: string;
  name: string;
  availability: 'available' | 'unavailable';
  capabilities: Capabilities;
  reason?: string;
};
type ContentRegistry = {
  version: 1;
  contentTypes: ContentDescriptor[];
  formats: (ContentDescriptor & {
    extensions: string[];
    mimeTypes: string[];
  })[];
};
```

Type and format IDs are validated, bounded open identifiers. Extension and MIME descriptors use strict safe syntax. Unknown well-formed IDs are preserved; a client without their renderer shows an explicit unsupported state. Format descriptors can be carried by the contract without enabling their indexing or playback. An implemented registered adapter is required before an additional format can be scanned or used.

Library descriptors use canonical `contentTypeId: string | null`; `null` is unrestricted policy over the currently registered video inventory. The legacy `mediaType` alias is derived as the content type ID or `mixed` for `null`; `mixed` is reserved and rejected as a canonical type ID. Conflicting explicitly supplied canonical/legacy values receive 400. Legacy-only stored configuration migrates in place, and a legacy-only PUT preserves a saved unknown content ID. This does not change library/media IDs, source authority or progress. See [library migration](libraries.md#migration-and-data-preservation).

Registry capabilities describe implemented metadata/play/view/launch actions, not codec guarantees or permissions. A usable client action requires both an available server capability and client renderer support. Unknown/unavailable content types retain catalog membership and progress; clients block unsupported details/play actions, and the server rejects stream, HLS and playback preparation before probing or source reads. The initial registry retains only Movies/TV handlers and the twelve video extensions listed above, plus generic video inventory behavior. No music, audiobook, game or document handler, arbitrary code loader or new filesystem authority is added; every current `launch` flag is false.

## Playback and metadata

`Playback` has finite positive `durationSeconds`, `mode` (`direct` or `transcode`) and `streamPath`. The client validates that this path belongs to the selected media ID. HLS covers the complete original source timeline, so progress and seeks use source seconds. Compatibility output and cache limits are documented in [full-library development](full-library.md). A source that changed since indexing receives 409; unsupported playback preparation receives 422. Refreshing a browser page does not rescan storage; restart the development server to rescan.

Optional presentation fields are `posterPath`, `backdropPath`, `summary`, `year` and `genres`. Artwork paths remain opaque same-origin media routes; no source filesystem path is returned. Series pages may reference the associated media poster. Direct provider fetching, provenance, expiry and configuration are described in [full-library setup](full-library.md#independent-metadata-and-artwork).

Provider metadata is optional and asynchronous. `GET /api/media/{id}/metadata` returns a one-item catalog; `metadataPending` permits bounded refresh while file browsing remains available. `GET /api/metadata/status` reports enabled providers and queued work without credentials. Catalogs include `fullLibrary`; matched entries carry `fileTitle`, optional `fileYear`, `metadataSource`, `metadataUrl`, and `metadataExpiresAt` (Unix seconds). Expired client fields fall back to file details. Image endpoints never initiate provider or NAS reads.
## Built-in requests

The opt-in Radarr/Sonarr request API, authentication boundary, and setup prerequisites are documented in [requests.md](requests.md). Its TypeScript contract is `packages/contracts/requests.ts`. Requests are disabled in an unconfigured server; existing library and playback endpoints keep their current behavior.
