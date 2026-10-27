# Built-in requests: opt-in operator preview

This slice searches movies through Radarr and series through Sonarr, registers a
title with the operator's selected root folder and quality profile, and keeps a
durable request history. It is disabled by default. No production integration,
account, credentials, download client, or service is configured by this PR.

Shinema currently serves a single library on loopback and has no accounts,
individual request ownership, approval queue, or administrator role. Requests
therefore use a separate shared **operator request token**. Anyone who holds it
can search the enabled providers and register titles with the configured policy.
This is an operator preview, not a public or multi-user request portal.

## Setup prerequisites

Actual provider/security setup needs the owner's explicit approval. Before
enabling it, the operator must have an existing approved Radarr v3 API or Sonarr
v4/v5 instance, an existing root folder, and an existing quality profile.
Provider URL base paths are supported. Selecting or creating those resources,
changing provider settings, and configuring indexers/download clients are outside
this slice. Use synthetic mock endpoints for development and CI.

The following **server environment variables** opt in. Do not put them in a web
or native build, a URL, command history, screenshots, logs, or the repository.
This documentation deliberately provides no usable secret values or live URLs.

| Variable | Meaning |
| --- | --- |
| `SHINEMA_REQUEST_TOKEN` | Separate randomly generated operator token, at least 32 printable ASCII characters without spaces. Generate and distribute it only through an approved secure process. |
| `SHINEMA_RADARR_URL` | Approved Radarr base URL, including any base path. HTTP(S) only; no user info, query, or fragment. |
| `SHINEMA_RADARR_API_KEY` | Radarr API key, server only. Treat it as a broad administrative credential. |
| `SHINEMA_RADARR_ROOT_FOLDER` | Existing root folder as seen by Radarr, never chosen by the client. |
| `SHINEMA_RADARR_QUALITY_PROFILE_ID` | Existing positive quality profile ID, never chosen by the client. |
| `SHINEMA_SONARR_URL` | Approved Sonarr base URL with the same URL restrictions. |
| `SHINEMA_SONARR_API_KEY` | Sonarr API key, server only. Treat it as a broad administrative credential. |
| `SHINEMA_SONARR_ROOT_FOLDER` | Existing root folder as seen by Sonarr. |
| `SHINEMA_SONARR_QUALITY_PROFILE_ID` | Existing positive quality profile ID. |

Set the token and one or both complete provider groups, then restart the server.
Incomplete, empty, or invalid configuration fails startup with a static message
that does not include the supplied value. With no request variables set, the
library still runs and Requests explains that setup is required. Provider
credentials stay in the Rust process and are sent only as `X-Api-Key` to the
configured provider. Redirects and environment proxies are disabled for these
calls; responses and errors never expose provider URLs, keys, folders, profiles,
raw responses, or internal filesystem paths.

Sonarr compatibility is checked through its authenticated system-status API on
each operation. Sonarr v4 uses API v3; Sonarr v5 uses API v5 and is marked as a
preview in both clients. Other major versions, malformed version responses, or
an unavailable status API stop new series searches and registrations before a
provider write or request-history reservation. Saved duplicates remain readable.
This does not install, upgrade, or reconfigure Sonarr.

The existing server requires loopback binding. Use its exact displayed IP and
port; `localhost` is not an alias for a configured `127.0.0.1` address here. Request
routes reject a different Host or browser Origin. The served web build works on
that same origin: build the web client and serve it through `SHINEMA_WEB_ROOT`.
The Vite development origin is unsupported for Requests in this slice (library
development can still use Vite). Native clients may omit Origin but must
authenticate. The current native transport requires HTTPS; device deployment
therefore still needs an explicitly approved, trusted TLS/reverse-proxy setup
whose upstream Host matches the Rust bind. No proxy or device is configured or
validated here. HTTPS browser origins through a proxy are not supported by this
strict loopback origin gate. Requests also retain the shared global Host/Origin
boundary and add their stricter configured-authority and bearer checks.

Web and native clients accept the operator token into memory for the current
session. Reopening/reloading the app requires it again. There is no URL token,
cookie, local-storage token, or client-accessible provider configuration API.
Clear the session after use on a shared device. Restarting the server with a new
token revokes the previous token.

## Request behavior and status

The client submits only a kind (`movie` or `series`) and positive signed-32-bit
external ID (TMDB for movies, TVDB for series). The server re-verifies the title
through the configured provider lookup. It chooses the destination and quality
profile from its own configuration. Arbitrary client titles, URLs, provider
settings, paths, or download options are rejected.

Registration sets monitoring on. Movies use `minimumAvailability: released`;
series preserve the verified Sonarr lookup type (`standard`, `daily`, or `anime`).
Missing or unsupported types stop registration before any provider write or
request-history reservation. New Sonarr v5 series explicitly use **English
metadata** and **Official episode order**. Lookup uses the same English policy;
this preview does not infer Sonarr's preferred-language setting. The clients show
this policy before confirmation. Other metadata languages, DVD/Netflix/alternate
orders, season-title naming, and changing an existing series are not supported
here. Sonarr v4 retains its existing API v3 defaults. Series use season folders
and monitor regular seasons, excluding specials in the lookup result.
**Immediate historical searches are disabled**:
`searchForMovie`, `searchForMissingEpisodes`, and
`searchForCutoffUnmetEpisodes` are false. Existing provider automation may still
act on monitored titles later. This preview does not manage provider commands,
download queues, progress percentages, subtitles, deletion, or a manual retry.

| Status | Meaning |
| --- | --- |
| `not_requested` | Search result has no provider entry or saved request. |
| `requested` | Provider confirms a registered title. It does not promise a download. |
| `available` | Radarr reports a file; or Sonarr reports at least one episode and file count covering its reported episode count. This does not establish Shinema indexing, playback readiness, or future-series completeness. |
| `uncertain` | A write outcome could not be confirmed, or a previously confirmed title disappeared from the provider. Refresh and let the operator investigate before any further attempt. |
| `failed` | Provider rejected the write and a subsequent catalog read confirmed the title was absent. The operator must check setup; repeated clicks do not resend it. |

Search and submit consult the provider's catalog, including titles added outside
Shinema, to prevent duplicate registration. Concurrent local submits are
serialized. Identity is `(kind, externalId)`. SQLite atomically reserves a new
identity across separate engine instances; only its insertion winner may send
the provider POST, and stale status changes cannot overwrite a newer transition.
The server writes the `uncertain`
record to `requests.sqlite3` with full SQLite durability **before** issuing the
only provider POST. Timeout, cancellation, process restart, broken replies,
provider errors, and repeated clicks do not cause an automatic POST retry.
Refresh reconciles saved records against the provider catalog. An existing
provider title is returned as a duplicate without another write, including a
provider-side race between lookup and submission.

History is stored in the existing private state directory, separate from media.
It contains title, external identity, status, and timestamps; it contains no
provider configuration or tokens. Do not publish it. This preview retains up to
500 identities and has no deletion API; further new identities return a limit
error, while existing identities can still be inspected. Run one Shinema process
per writable state directory. Provider response size, search length, request
body, outgoing concurrency, connection time, and call duration are bounded.

## HTTP contract

All responses use `Cache-Control: no-store`. The coarse capability response is
the only unauthenticated endpoint. Other endpoints require
`Authorization: Bearer <operator token>`; they do not accept the provider key.

| Endpoint | Result |
| --- | --- |
| `GET /api/requests/capabilities` | `apiVersion`, `enabled`, `authentication: bearer`, provider kinds/enabled flags. No configuration details. |
| `GET /api/requests/sonarr` | Authenticated compatibility status: `ready`, `disabled`, `unavailable`, or `unsupported`; verified numeric version and selected API path when ready; v5 preview flag and fixed English/Official policy. No raw provider status or configuration. |
| `GET /api/requests/search?kind=movie&query=...` | Up to 50 verified search results with status, optional year and saved request ID. Query length 2–100 characters. |
| `GET /api/requests` | Saved records with bounded provider refresh. `refreshIncomplete` warns when a provider could not be refreshed; previous statuses remain. |
| `POST /api/requests` | `{kind, externalId}` returns `{apiVersion, item, duplicate}`. HTTP 201 for a new confirmed/rejected record, 202 for uncertain, 200 for a duplicate. Inspect `item.status`. |

Errors are `{error:{code,message}}` with safe messages. Codes are `disabled`,
`unauthorized`, `forbidden_origin`, `invalid_request`, `provider_disabled`,
`provider_unavailable`, `not_found`, `request_limit`, and `internal_error`.
There is no administrative integration endpoint. The authenticated compatibility
read checks the configured Sonarr status; it does not alter configuration.

## Validation and API references

`cargo test -p shinema-server --test requests` uses synthetic Axum providers bound
to ephemeral loopback ports. It covers authentication and same-origin checks,
validation, movie/series policies, duplicate handling, concurrent submits,
status refresh, durable ambiguity across restart, a real HTTP timeout, safe
failure handling, response-size limits, and refusal to follow redirects.
Requests are paused in the new app until after v1 ([ADR 0001](decisions/0001-client-rebuild.md));
the server feature and its Rust tests remain. No real title, media, or live
service is required by those tests.

On **2026-10-16**, the official release API identified stable
[Sonarr v4.0.20.3014](https://github.com/Sonarr/Sonarr/releases/tag/v4.0.20.3014)
(published 2026-09-16, commit `cab419ade8ac7fcab5bf80394ee492abd35d5f5a`)
and beta
[v5.0.0.2635](https://github.com/Sonarr/Sonarr/releases/tag/v5.0.0.2635)
(published 2026-10-16, commit `a2b6054a8f3746d149a811bddea2a8d063efc35e`).
Mock contracts are pinned to those versions. The beta adds
[metadata languages and episode orders](https://github.com/Sonarr/Sonarr/pull/8990),
which require explicit language and order fields in API v5. This slice supports
the fixed policy above; it does not expose Sonarr's new settings UI, OIDC,
alternate-order selection, download progress, or anime list integrations.
Those upstream features do not add user accounts to Shinema.

API fields were checked against the official upstream
[Radarr v3 OpenAPI specification](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/openapi.json),
[Sonarr stable v3 OpenAPI specification](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/Sonarr.Api.V3/openapi.json),
[Radarr movie controller](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/Movies/MovieController.cs),
and the pinned beta
[Sonarr v5 series controller](https://github.com/Sonarr/Sonarr/blob/a2b6054a8f3746d149a811bddea2a8d063efc35e/src/Sonarr.Api.V5/Series/SeriesController.cs),
[lookup controller](https://github.com/Sonarr/Sonarr/blob/a2b6054a8f3746d149a811bddea2a8d063efc35e/src/Sonarr.Api.V5/Series/SeriesLookupController.cs),
and [series resource](https://github.com/Sonarr/Sonarr/blob/a2b6054a8f3746d149a811bddea2a8d063efc35e/src/Sonarr.Api.V5/Series/SeriesResource.cs).
The mocked tests verify this adapter's contract; deployment against an approved
instance still needs operator validation of its version and policy.
