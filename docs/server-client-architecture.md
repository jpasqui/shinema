# Server and client architecture

This document records product agreements and architectural recommendations. It does not implement accounts, theme inheritance or an extension runtime. [Design principles](design-principles.md) explain the lasting philosophy; [libraries and navigation](libraries.md) document the current configuration contract.

## Agreed principles

Shinema should deliver one cohesive product with sensible defaults, configurable libraries and navigation, replaceable presentation and modular features. Playback, stable media identity, progress, source boundaries and data integrity remain dependable across those choices.

The server owns shared library and domain state. Each client owns its rendering and interaction: television focus and remote input, touch, keyboard, accessibility and platform playback adapters. A server-enabled feature does not require every client to use the same layout or rendering technology.

Server library names, source membership and default ordering are shared configuration. Personal navigation, pins and appearance are separate preferences; hiding a shortcut is not a permission change. The future account model must keep owner administration and user permissions distinct.

Content types and formats must be extensible independently of library display configuration. Movies and TV are initial handlers. Music, audiobooks, games and documents, including Word documents, are future examples; none of those additional handlers is implemented by this change.

A server theme is a default. Users can select **Follow server** or choose a personal skin and settings, with an optional per-device override. Follow server tracks the server's current default; an explicit personal choice remains the user's choice when that default changes. Accessibility preferences, including reduced motion and text size, always take precedence.

An owner-enabled, promoted feature remains discoverable on an authorized user's client even when that client's feature module is absent. The client explains what is available and what prevents use, rather than silently removing the feature. This future capability discovery contract is separate from today's allowlisted navigation destinations and missing-library shortcut behavior.

## Recommended ownership and interfaces

| Responsibility | Recommended owner and boundary |
| --- | --- |
| Library, catalog and progress | Server domain services retain stable IDs and authoritative shared state; clients cache bounded views and synchronize progress. |
| Authentication and authorization | Server validates identity and permissions on every protected operation. Clients present sign-in and permission state without making authorization decisions. Accounts are not implemented yet. |
| Optional domain features | Server services or adapters implement requests, metadata and similar workflows behind typed APIs, with explicit health and failure behavior. Integration credentials remain server-side. |
| Rendering and input | Clients ship supported renderers and platform adapters. Shared contracts describe data and actions; native clients retain native rendering, focus and input behavior. |
| Appearance | Server advertises a compatible default skin/theme identity and configuration; clients resolve personal and per-device preferences, apply accessibility preferences, and render a safe supported fallback. |
| Feature discovery | Server describes available capabilities and permitted actions; clients combine that information with their own renderer support and explain unavailable actions. |

Prefer versioned, typed server APIs with validated data and preinstalled or bounded declarative client renderers. Clients should negotiate supported contract versions and fail visibly when a feature requires a newer client. Capability descriptions are data, not permission to execute code or open arbitrary destinations.

There are useful precedents, without adopting their protocols wholesale. Stremio's SDK describes HTTP services that expose manifests and JSON resources; its clients call those services rather than executing addon code. This supports the recommendation to separate feature services from their client presentation. [Stremio SDK README](https://github.com/Stremio/stremio-addon-sdk/blob/master/README.md?plain=1)

Nextcloud exposes server/app capabilities and theming values through its capabilities API so clients can adapt to a server instance. This is a precedent for discoverable capabilities and server appearance defaults, not a chosen Shinema manifest schema. [Nextcloud capabilities and theming API](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html#capabilities-api)

Jellyfin's 10.10 release separated server storage of media segments from client skip controls: that release supported them in the web interface while other client support was pending. This historical example shows why server capability and client support need separate states. [Jellyfin 10.10 media segments](https://jellyfin.org/posts/jellyfin-release-10.10.0/)

### Content types, formats and actions

The initial content registry is a versioned, data-only manifest at `packages/contracts/content-registry.json`, exposed through `GET /api/content-registry` and included as an additive `registry` snapshot in library responses/caches. It describes content types and formats separately: type descriptors have stable open IDs, names, availability, optional reasons and `metadata`/`play`/`view`/`launch` capabilities; format descriptors additionally identify extensions and MIME types. [The API guide](api.md#content-registry) records the wire contract.

A library's canonical `contentTypeId` is an open string or `null`; `null` means unrestricted policy over the currently registered video inventory. The legacy `mediaType` field is a derived compatibility alias. Neither a library label nor an unrestricted policy registers new file formats, changes approved roots or supplies a renderer.

Usable actions require the relevant server descriptor to be available, its action capability to be implemented, and a compatible client renderer/action handler. Capability flags describe implemented pipeline actions, not a guarantee that a particular file's codec decodes. Keep this intersection distinct from the broader future permission, health and promotion model below.

Current format identification retains the existing extension-based scan and uses the registered MIME declaration; it does not add content sniffing or infer a new handler from a MIME string. The existing video probe/decoder still decides whether a particular asset can play. The current catalog/stream envelope remains the video adapter's compatibility contract; future view or launch actions need their own reviewed resource/action contract rather than an invented video stream.

Unknown type IDs remain in configuration and retain membership and progress through restart, with explicit unsupported presentation rather than coercion to Movies or TV. Contracts can carry unknown format descriptors, but indexing and playback require a registered adapter. A future adapter must define recognition, safe MIME/extension handling and supported actions within existing source and execution boundaries. No new format handler, plugin runtime, arbitrary code loading, unsafe launch action or filesystem authority is introduced here; every current `launch` capability is false.

### Feature states and discoverability

Avoid one overloaded enabled/disabled flag. These are distinct questions for a future capability contract; the names below are conceptual, not a frozen wire format.

| State | Question |
| --- | --- |
| Installed | Is the server service or adapter present? |
| Configured | Has the owner supplied the required setup? |
| Healthy | Can it currently perform its advertised work? |
| Permitted | May this user discover or invoke the relevant operation? |
| Client-supported | Does this client have a compatible renderer and action handler? |
| Owner-promoted | Has the owner chosen to surface this capability to eligible users? |
| User-pinned | Has the user chosen a personal shortcut or prominent placement? |

Installation does not establish configuration or health. Promotion and pinning do not grant permission, and renderer support does not prove backend availability. The server still enforces authorization; discovery must not reveal protected data.

For a promoted capability without a specialized renderer, show a built-in explanatory view and basic supported actions when possible. Otherwise explain whether the user needs a client update, a supported module installation, a supported web view, owner configuration or restored service health. Offer only actions supported by that platform and permission context. An absent renderer must not silently erase an owner-promoted feature from an eligible user's discovery view; a pin must not turn an unsupported action into an executable one.

### Appearance across clients

Resolve appearance in this order: the server default, a personal override when selected, then an explicit per-device override when selected. Apply accessibility preferences after resolving those choices. A client missing the selected skin should explain the fallback and retain the preference for when a compatible renderer becomes available. Storage and synchronization of these overrides remain open decisions.

Shared design tokens and skin configuration can express intent across platforms, while each renderer implements compatible layouts and interaction. Full skins can replace composition and navigation presentation through supported interfaces. CSS alone cannot provide that contract for native clients: Jellyfin documents that its custom CSS affects only clients using Jellyfin Web, and external CSS assets also depend on client reachability and offline availability. [Jellyfin CSS customization limits](https://jellyfin.org/docs/general/clients/css-customization/)

### Requests and replaceable backends

Keep a future requests feature's catalog lookup, request submission, status and permission model behind a Shinema-owned service interface. A server adapter can connect to an owner-selected backend while clients use the same domain contract. Backend failures should produce clear request status without breaking browsing or playback.

Replacing a Radarr/Sonarr-backed integration with native Shinema services is a future aspiration. This separation should allow that evolution without replacing the client UI or invalidating media/progress identity. This document implements neither integration nor replacement, and does not define acquisition behavior or require users to run separate tools for the default product.

### Executable extensions and distribution

Executable extensions belong to a separate trust and distribution tier from data/configuration and preinstalled renderers. Before enabling them, resolve signing and provenance, isolation, privileges, update/revocation, compatibility and platform distribution constraints. Feature discovery and an install suggestion do not authorize downloading or executing a module.

Apple's current review guidelines restrict downloaded code that changes functionality in section 2.5.2 and describe conditional allowances with additional obligations in section 4.7. Any Apple-platform extension design needs review against the applicable rules at distribution time; these references are not legal advice or App Review approval. [Apple App Review Guidelines, 2.5.2 and 4.7](https://developer.apple.com/app-store/review/guidelines/)

## Current implementation

- The Rust server persists library descriptors and membership in SQLite separately from source-relative media IDs and progress. Protected library management uses a temporary development operator mechanism behind `ManagementAccess::can_manage_libraries`.
- The shared content registry advertises only the initial Movies/TV handlers and existing generic video inventory, using the same twelve video extensions. Unknown IDs are retained with explicit unsupported UI; clients block unsupported details/play, and the server rejects unsupported stream/HLS/playback requests before probing or reading source media.
- Web supports local library visibility/order preferences and declarative top-navigation entries with fixed Settings/reset access. Native consumes server library labels, order and visibility and retains local selection; it has the documented first-500-items limitation.
- The current navigation destination allowlist is browse, library, search and settings. It is not a feature-capability registry, plugin manifest or dynamic module loader.
- Accounts, owner/login permissions, server theme inheritance, synchronized appearance overrides, the broader feature-state model above and native Radarr/Sonarr replacement are not implemented by this change. See [the library guide](libraries.md) for exact current behavior and limits.

## Open decisions

- Account identity, ownership, permission scopes and capability visibility policy.
- A broader feature/extension manifest beyond the initial content registry, version negotiation and renderer compatibility rules.
- Where personal/per-device overrides live, how they synchronize and how offline conflicts resolve.
- Supported installation/update paths, web fallback policy and the executable extension trust/distribution model.
- Requests backend contracts, replacement scope and operational lifecycle.

These decisions need separate proposals and review before implementation. The present guidance establishes boundaries and expected user experience without introducing a runtime, new permissions or an installation mechanism.
