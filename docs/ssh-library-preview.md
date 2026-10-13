# Temporary read-only SSH library preview

This development adapter connects the React browser preview to a small existing media folder through an already-authorized SSH identity. The PC exposes the shared catalog/stream/progress contract on host loopback and reads each requested media byte range from the remote file. It does not copy source media files to local fixtures. Thumbnails are decoded frames cached locally, and progress is a separate local JSON file.

This is a temporary **Node development bridge**, not a deployed Rust server integration, filesystem mount or production backend. The Rust server is unchanged. The bridge is useful for verifying the UI against actual media while preserving existing services; production storage access, authentication, TLS, multi-user progress and large-library operation need a separately reviewed Rust integration.

## Prerequisites and private configuration

Use Node 24, an existing recognized OpenSSH client and FFmpeg, and an existing authorized SSH account with Python 3 and read access to the chosen folder. Host-key checks remain strict and password/credential prompts are disabled. Missing credentials or an untrusted host stop the operation; the adapter does not create keys, accept host warnings or edit trust files.

Keep configuration in an ignored local file, for example `.local/ssh-preview.json`. The following values are placeholders. Use absolute paths appropriate to the PC's operating system, and a trusted private **local** state directory and parents, outside all media folders and network mounts.

```json
{
  "destination": "existing_user@nas.example",
  "keyFile": "/absolute/path/to/existing-key",
  "knownHostsFile": "/absolute/path/to/existing-known-hosts",
  "remoteRoot": "/srv/media/sample",
  "stateDirectory": "/absolute/local/private/preview-state",
  "maxItems": 3,
  "maxBytes": 8388608,
  "label": "Connected library"
}
```

From the repository root:

```powershell
npm ci --prefix clients/web --ignore-scripts --no-audit --no-fund
$env:SHINEMA_SSH_CONFIG = (Resolve-Path '.local/ssh-preview.json').Path
node scripts/ssh-library-preview.mjs
```

Open `http://127.0.0.1:5173` on the PC. Ctrl+C closes the temporary preview, Vite server and owned SSH reader processes. Ports 5173 and 8787 must be free. No service, script file or listener is installed on the NAS; each SSH operation executes the original read-only reader code transiently. No port forwarding, SMB credential setup, firewall/security change or persistent NAS deployment is performed.

## Bounds and behavior

- The reader inspects at most 512 direct directory entries and returns at most 12 items, defaulting to three. Per-file size is capped at 64 MiB; the example uses 8 MiB. MP4/M4V items are preferred. It does not recursively mirror the library.
- Media IDs include an opaque source namespace so identical filenames from another configured host/folder do not inherit progress. Titles are filename-derived and bounded to 200 Unicode scalars. Unsupported non-UTF-8 or backslash-containing filenames are skipped.
- The reader opens regular source files read-only, refuses symlink media and checks size/modification time for each range. A changed source produces an error until restart. Ordinary filesystem read-atime behavior is outside the adapter's control.
- The HTTP adapter supports GET/HEAD single byte ranges, bounded progress PUTs and optional same-item thumbnail URLs. At most four media transfer processes run concurrently. The local progress queue uses exclusive temporary creation and sync/rename, refusing existing temporary files or links. State parents must remain trusted; this is not an adversarial same-account filesystem sandbox.
- Browser codec support determines direct playback. There is no media transcoding fallback, download system or GPU validation. FFmpeg thumbnail extraction reads the same live range endpoint; it does not create a source-media copy.
- The client remains a single development profile with origin-scoped browser caching. Use an isolated browser profile and dedicated local state for a private preview. This is not a multi-user conflict policy or an authentication boundary for other users of the PC.

## Verification and privacy

```powershell
node --test scripts/tests/*.test.mjs
py -3 -m unittest discover -s scripts/tests -p 'test_*.py'
npm test --prefix clients/web
npm run build --prefix clients/web
```

Linux CI uses `python3` instead of `py -3`. Reader tests use only generated temporary bytes. HTTP adapter tests use a fake reader; browser tests use the ordinary generated catalog and synthetic thumbnail responses. CI never receives a real SSH configuration, credentials, private filenames, source media, recording or private thumbnail.

Private recordings and evidence belong in ignored local directories and private delivery, not GitHub commits, PR screenshots or CI artifacts. Optional `posterPath` fields are validated against the matching relative media ID; older catalogs remain valid and missing/failed thumbnails retain the generic artwork fallback. Browser screen recordings prove browser behavior only, not Shield/TV or phone hardware validation.
