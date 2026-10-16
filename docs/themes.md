# Skins, themes and motion

Marquee is the default production presentation. Archive is an alternate, authored skin: an editorial catalogue with a programme feature, portrait-led details, different navigation treatment and card typography. Both render the same media, progress and playback contracts. No final adoption of another visual direction is implied by the alternate example.

## What an imported theme can change

A version 1 theme contains a name, validated palette, and five declarative design choices:

| Design field | Allowed values | Effect |
| --- | --- | --- |
| `skin` | `marquee`, `archive` | Selects trusted components with different feature/detail compositions and navigation presentation |
| `typography` | `cinema`, `editorial`, `system` | Selects fixed, local font families and title treatments |
| `density` | `comfortable`, `compact` | Changes page/card spacing and feature sizing, retaining minimum control targets |
| `cards` | `poster`, `landscape` | Changes the library card proportions and column treatment |
| `motion` | `subtle`, `still` | Enables the restrained skin motion, or suppresses it |

The palette has exactly `background`, `surface`, `elevated`, `text`, `muted`, `accent`, `onAccent`, `focus`, and `danger`. Colours are opaque six-digit hex values. Body, muted and error text require at least 4.5:1 contrast against every solid background/surface; focus requires 3:1; accent fills require `onAccent` text at 4.5:1. Copy and focus over artwork receive solid theme surfaces: token contrast alone does not guarantee readability over a photo.

This is more than palette recolouring, but it is deliberately not arbitrary downloaded UI code. An imported file cannot introduce a new component tree, arbitrary CSS, resource/font URL, script, template or plug-in. A new composition beyond the bounded settings needs a developer-authored skin adapter, reviewed and shipped with the app. The same constraint applies to web and native.

The exact machine-readable contract is [theme.schema.json](../packages/design-tokens/theme.schema.json); [theme.ts](../packages/design-tokens/theme.ts) owns runtime validation, contrast checks, preset values and canonical import/export. Themes are at most 8 KiB of UTF-8 JSON, names are bounded, root/design/colour keys are exact, and unsupported versions/choices are rejected. Earlier palette-only prototype JSON lacks the required design fields and is rejected visibly; this draft contract has not been released and performs no inferred migration.

## Using appearance preferences

Web: open **Appearance**, choose Marquee, Archive or Midnight, then adjust the five design settings or palette. Choices save locally. Import/export uses JSON files or the Theme JSON field. Invalid imports leave the active theme and saved preferences intact. Reset appearance restores the entire Marquee design, palette and system-motion preference. The modal contains keyboard focus, closes before the underlying screen handles Back, and returns focus to its trigger. Arrows move between controls; vertical arrows leave single-line fields, Up/Down move between selects while Left/Right change their choice, and textarea arrows leave at the first/last text boundary.

Native Android: the Appearance header is reachable with Up from the library/detail, or Menu from server setup. Existing Menu behavior from library/detail still opens server setup. Presets and design settings use the same shared contract. JSON can be pasted into a bounded field and exported as selectable text. Import/export is local text; no file-access, clipboard or sharing permission was added. Back returns to the original route/cursor. Native appearance changes are outside active playback, and playback state remains in its existing adapter.

Web preferences use `shinema.appearance.v1`; native preferences use a separate app-private atomic `appearance-v1.json`. They never replace media caches or progress queues. Invalid saved data falls back with a message. Failed persistence is disclosed as session-only. Native writes are serialized and revision guarded so a delayed load/save cannot overwrite a newer selection. This is device/browser-local preference storage, not account sync.

## Architecture and integration

- `packages/design-tokens/`: immutable shared data, schema, allowlisted fonts and contrast validation. No React, Node or network dependency in the parser.
- Web `skins.tsx`: trusted feature/header/detail adapters. `LibraryBrowser` and `App` retain search, selection, bounded lazy browsing, resume, requests to the server and player behavior. Skin changes do not key/remount the player; browser regressions check video identity and progress through a switch.
- Native `skins.tsx`: authored header/library/detail presentation receives typed data and callbacks. `App` retains connection, progress and playback behavior. `preferences.ts` handles appearance persistence and bounded artwork paths.
- CSS layers `marquee.css` and `skins.css` provide authored web treatment. Native uses corresponding shared palette/design choices with platform styles and `Animated`. Platform-specific focus, text entry and playback remain separate adapters.

No subtitle/request fields or feature logic are changed. The open subtitle/request work touches both App files and the native host module; appearance imports/header hooks and separate native preference methods are the expected merge intersections. Shared catalog/playback/progress APIs remain unchanged.

## Native TV Marquee

The TV adapter uses a single compact header, a full feature at entry, and six, seven or eight portrait columns according to viewport width. Compact density can add one column. Poster artwork keeps its 2:3 ratio; two title lines and metadata have separate reserved space. Cinema display titles use the platform serif face, while navigation and captions use a local UI face. Imported palettes and the existing typography, density, cards and motion choices remain authoritative.

A new library opens at its header and feature. Down deliberately enters the grid, revealing the library heading and a complete focused card without a clipped feature strip. Up from the first row restores the feature. Returning from details retains the selected global slot and scroll position. Delayed connection work cannot reset the browsing region after newer input. The card window reduces overscan as column count increases and retains the existing 48-card mounting limit.

TV details place title, metadata and Play together beside artwork. Loading, missing artwork, failed images and empty libraries retain their authored frames. Focus changes artwork transform and its outline without changing card layout; reduced motion remains immediate. Unsupported content still uses the canonical support gates, and every artwork URI still passes the existing transport validator.

Native geometry tests cover the Shield-sized 960×540 logical viewport, wider TV and phone layouts, caption fit, poster proportions, detail action bounds and bounded feed windows. Device screenshots and interaction results must identify the exact installed build and fixture separately; host geometry and APK assembly are not physical-rendering evidence.

## Motion and verification limits

Web focus scales only the artwork inside a fixed card hit rectangle; route/artwork arrivals use bounded transform/opacity transitions. Native uses cancellable native-driver transform/opacity animations and immediate focus borders. Scrolling to reveal remote focus is immediate. There are no perpetual artwork pans, animation packages or imported animation code. Loading geometry and bounded rendering are covered in [loading-and-browsing.md](loading-and-browsing.md); host checks do not establish TV frame-time performance.

System reduced motion is always respected. An explicit reduced-motion preference or a theme's `still` setting also disables animations, transitions and smooth scrolling. Native starts conservatively with reduced motion until accessibility status is known and guards late status reads.

Run `npm test` for shared/native tests; web unit/type/build checks remain under `clients/web`. The existing isolated Playwright suite includes appearance, unsafe import, reset/persistence, photo/fallback, focus/reduced-motion and playback continuity tests with generated fixtures. CI builds the unsigned Android client. Browser screenshots/walkthroughs show the actual web client at TV and phone viewport sizes. Physical device results are reported separately from those browser and build checks; they do not establish HDR, frame-time performance, IME behavior or a broad accessibility audit.
