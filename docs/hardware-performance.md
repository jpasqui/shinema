# Manual hardware measurement protocol

`scripts/hardware-performance.mjs` analyzes an explicitly supplied local JSON file. It never connects to a browser, device or media service. With no arguments it prints help. `--print-sampler` prints a dormant function for an operator to paste manually into an already authorized browser session; collection requires a separate explicit `authorized: true` call. There is no discovery, ADB, SSH, endpoint, credential, automatic playback, device cleanup, CI hardware job or schedule.

**No hardware collection has been executed for this change.** Synthetic Node tests validate the recorder and analyzer. An Android release build and host Chromium playback checks do not establish Shield, Android decoder, remote control, display, audio/video synchronization or NAS performance. This browser sampler does not instrument the React Native player.

## What the numbers mean

All event times are milliseconds relative to sampler creation using the browser performance clock. Summary durations use the arithmetic median and nearest-rank p95; incomplete operations have a separate count and no invented zero latency. The measurement version is `browser-callback-v1`. Do not compare different measurement definitions or workload versions as if they were the same benchmark.

| Output | Definition and limitation |
| --- | --- |
| `startupToVideoFrame` | Operator `markStartup()` immediately before Play on a paused, explicitly selected video, to the first video-frame callback while playing and not seeking. Includes work after the marker; excludes any app navigation, source setup or network activity before it. It is not app launch time or decoder-only time. |
| `seekToSeeked` | Observed `seeking` event to corresponding `seeked` event. It excludes time between input/request and delivery of `seeking`. Superseded seeks remain incomplete. |
| `seekedToVideoFrame` | `seeked` event to the first subsequent video-frame callback while not seeking. This measures the post-seek callback wait. |
| `seekToVideoFrame` | Observed `seeking` event to that callback, including both preceding phases. It does not prove the displayed image matches the desired target. |
| `inputToAnimationCallback` | `keydown`/`pointerdown` creation timestamp to the next animation callback invocation, with an explicit handler-time fallback when the event clock is incompatible. This correlates input with the next browser render opportunity; it does not prove Shinema updated the UI or measure input-to-photon latency. Keys, text, DOM targets and pointer coordinates are never stored. |
| `frames` | Difference between first/last `getVideoPlaybackQuality()` cumulative total and dropped counters, requiring at least two counter samples. `droppedRatio = dropped / total` over that interval. The API's total includes dropped frames, so `totalFramesPerSecond` is a counter rate, not displayed FPS. Insufficient samples, no frames or no positive interval gives null values rather than invented zeros or a divide-by-zero value. |
| `hiddenDurationMs` | Time the document reports hidden. Backgrounded, truncated or incomplete runs should be repeated in the foreground; callbacks can be throttled. Unsupported APIs remain visible as capability flags, and quality read failures are counted. |

A video-frame callback runs when a frame is sent for composition and may itself be late; it is not the timestamp of physical display scanout. An animation callback runs before a repaint and is an even weaker visual proxy. Use an external high-speed camera or separately approved device tracing for actual display/input-to-photon, dropped display frames and remote transport measurements. See [video-frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [playback quality](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality), [event timestamps](https://developer.mozilla.org/en-US/docs/Web/API/Event/timeStamp) and [animation callbacks](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).

## Operator procedure, only after hardware authorization

1. Obtain current approval and user availability for the specific device and session. Stop all device interaction immediately if the user pauses TV work. This document is not authorization to connect, enable debugging, change security/network settings or use credentials.
2. Use generated fixtures in a disposable approved environment. Select the workload in advance: fixture hash/version, codec/resolution/frame rate, library size, direct-play/transcode mode, client commit, build mode, browser/runtime version, and a generic device class. Keep personal paths, hostnames, IPs, account information and device identifiers out of any shared notes. Do not use private media or live NAS services under the current scope.
3. Prepare equal baseline/head builds and identical conditions. Record cold/warm meaning explicitly, clear only disposable state within the approved scope, fix the playback/seek/input sequence, keep the document visible, and alternate serial runs to expose warmup and thermal/order effects. Keep raw runs and aggregate median/p95 per condition. Do not combine different browser builds, fixture versions or cache conditions into a single number.
4. On the development host, print the function with `node scripts/hardware-performance.mjs --print-sampler`. Review it, then manually paste the printed definition into the already authorized browser console. This only defines a function. It does not fetch code or start sampling. Select the video element explicitly; no page or element discovery runs automatically.

   ```js
   const measurement = createShinemaPerformanceSampler({
     authorized: true,
     video: document.querySelector('video'),
   });
   // When the selected video is paused and its source is ready for this trial:
   measurement.markStartup();
   // Now perform the approved Play/seek/input sequence manually.
   // Stop also removes listeners and cancels pending callbacks/timers:
   const samples = measurement.stop();
   JSON.stringify(samples);
   ```

5. Manually save the numeric JSON to an ignored local file and analyze it offline:

   ```powershell
   node scripts/hardware-performance.mjs --analyze .local/hardware-samples.json > .local/hardware-summary.json
   ```

   The analyzer accepts at most 1 MiB and 10,000 events. It rejects unknown/missing fields, clock/schema mismatches, negative/regressing/out-of-session timestamps, duplicate or unmatched correlation IDs, and resetting/impossible frame counters. A source change that resets counters requires a new session. It never echoes supplied file paths or invalid field contents in errors. Output contains only allowlisted numeric aggregates, fixed metric labels, source and capability flags; raw events, input text, titles, URLs and identifiers are not copied.

6. Review aggregate reports and separately sanitized workload notes before sharing. Preserve incomplete/truncation/capability/fallback/visibility warnings. A failure to collect a callback is an incomplete measurement, not a fast result. No timing values in this harness are pass/fail budgets; hardware variance has not been calibrated.

The recorder does not call `play()`, change a source or seek position, click, capture pixels/audio, inspect text/URLs, persist a file, or upload anything. It observes the selected element, input events and visibility only. `markStartup()` must precede the relevant Play action; creating a sampler after playback has started cannot measure startup. Frame callbacks stop at `stop()`; stop before changing source, navigating or ending the approved session.

## Offline tests

```powershell
node --test scripts/test_hardware_performance.mjs
```

Tests use synthetic samples and fake callback APIs. They cover phase correlation, median/p95, malformed or incomplete events, timestamp/counter regression, zero denominators, unsupported APIs, handler-clock fallback, counter failures, bounded capture, privacy, explicit opt-in, callback/listener teardown and CLI errors. No browser/device is launched or contacted by these tests.
