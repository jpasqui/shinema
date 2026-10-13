# API version 1

The Rust server and TypeScript client share the field definitions in `packages/contracts/api.schema.json` and the runtime parsers in `packages/contracts/index.ts`. Unknown API versions are rejected. Client stream paths must correspond exactly to the returned opaque media ID; catalog data cannot introduce arbitrary local or remote URLs.

| Method and path | Response |
| --- | --- |
| `GET /health` | `{status: "ok", apiVersion: 1}` |
| `GET /api/catalog` | `{apiVersion: 1, items: Media[]}` |
| `GET /api/media/{id}/stream` | Direct file bytes; a single valid byte range receives 206 |
| `HEAD /api/media/{id}/stream` | The same length/type/range headers, without a body |
| `GET /api/media/{id}/progress` | `Progress` or `null` |
| `PUT /api/media/{id}/progress` | Validated `Progress`; successful save returns 204 |

Media has `id`, `title`, `container`, `sizeBytes`, and `streamPath`. No server filesystem path is returned. IDs hash the media-relative path, remain stable through server restarts, and change when a file is renamed. This first slice lists filename-derived titles and format/size metadata; it does not scrape posters or private metadata.

`posterPath` is an optional matching relative endpoint `/api/media/{id}/poster`. The temporary SSH preview supplies decoded video-frame JPEGs there; the Rust catalog currently omits this field and does not implement that endpoint. Clients keep older catalogs valid and use generic artwork if a supplied thumbnail fails. Arbitrary external or different-item poster URLs are rejected. The SSH adapter's source-namespaced identifiers and limits are documented separately in [SSH preview setup](ssh-library-preview.md).

Ordinary Unicode path components are joined with `/` for portable stable IDs; actual filename characters are preserved. Non-Unicode names use a versioned, length-framed encoding of raw platform units, so lossy display replacements cannot merge distinct entries. Ordinary existing path IDs remain unchanged. Titles are limited to 200 Unicode scalar values in both Rust and TypeScript, rather than 200 JavaScript UTF-16 units.

Progress has finite `positionSeconds` and `durationSeconds`; position must be between zero and duration, and duration must be positive and no greater than one week. This is one shared development profile, not an authentication or multi-user system. A position within three seconds of the end starts playback from the beginning.

Supported range forms are `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`. Invalid, multiple and unsatisfiable ranges receive 416 and `Content-Range: bytes */size`. This slice does not implement multipart ranges, transcoding, or conditional `If-Range` validation. Files are opened for reading relative to a directory capability and streamed in chunks; they are not loaded entirely into memory.
