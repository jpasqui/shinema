import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_EVENTS = 10_000;
const MAX_FILE_BYTES = 1_048_576;
const EVENT_FIELDS = {
  startup: ['id'],
  'startup-frame': ['id'],
  seek: ['id'],
  seeked: ['id'],
  'seek-frame': ['id'],
  input: ['id', 'timestampSource'],
  'input-render': ['id'],
  quality: ['totalFrames', 'droppedFrames'],
  visibility: ['hidden'],
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactFields(value, fields) {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected a sample object.',
  );
  requireValue(
    Object.keys(value).length === fields.length &&
      fields.every((field) => Object.hasOwn(value, field)),
    'Unexpected or missing sample fields.',
  );
}

function nonnegative(value) {
  return (
    Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
  );
}

function summarize(values, incomplete) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    completed: sorted.length,
    incomplete,
    medianMs: sorted.length
      ? sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
    maxMs: sorted.length ? sorted.at(-1) : null,
  };
}

// This analyzer has no network or device APIs. Unknown fields are rejected,
// rather than copying arbitrary input metadata into public artifacts.
export function analyzeHardwareSamples(samples) {
  exactFields(samples, [
    'schemaVersion',
    'source',
    'clock',
    'capabilities',
    'durationMs',
    'truncated',
    'qualityReadFailures',
    'events',
  ]);
  requireValue(samples.schemaVersion === 1, 'Unsupported sample schema.');
  requireValue(
    ['synthetic', 'manual-browser'].includes(samples.source),
    'Unsupported sample source.',
  );
  requireValue(
    samples.clock === 'performance-relative-ms',
    'Unsupported sample clock.',
  );
  exactFields(samples.capabilities, [
    'videoFrameCallback',
    'animationFrame',
    'playbackQuality',
  ]);
  requireValue(
    Object.values(samples.capabilities).every(
      (value) => typeof value === 'boolean',
    ),
    'Invalid capability flags.',
  );
  requireValue(nonnegative(samples.durationMs), 'Invalid sample duration.');
  requireValue(
    typeof samples.truncated === 'boolean',
    'Invalid truncation flag.',
  );
  requireValue(
    Number.isSafeInteger(samples.qualityReadFailures) &&
      samples.qualityReadFailures >= 0,
    'Invalid quality failure count.',
  );
  requireValue(
    Array.isArray(samples.events) && samples.events.length <= MAX_EVENTS,
    'Invalid sample event count.',
  );

  const starts = { startup: new Map(), seek: new Map(), input: new Map() };
  const durations = {
    startup: [],
    seek: [],
    seekCompletion: [],
    seekFrame: [],
    input: [],
  };
  let previousTime = 0;
  let firstQuality;
  let lastQuality;
  let qualitySamples = 0;
  let handlerTimestampFallbacks = 0;
  let hiddenSince = null;
  let hiddenDurationMs = 0;

  for (const event of samples.events) {
    requireValue(
      typeof event?.type === 'string' &&
        Object.hasOwn(EVENT_FIELDS, event.type),
      'Unsupported sample event type.',
    );
    exactFields(event, ['type', 'atMs', ...EVENT_FIELDS[event.type]]);
    requireValue(
      nonnegative(event.atMs) &&
        event.atMs >= previousTime &&
        event.atMs <= samples.durationMs,
      'Invalid or regressing event timestamp.',
    );
    previousTime = event.atMs;

    if (Object.hasOwn(event, 'id')) {
      requireValue(
        Number.isSafeInteger(event.id) &&
          event.id > 0 &&
          event.id <= MAX_EVENTS,
        'Invalid event correlation ID.',
      );
    }
    if (Object.hasOwn(starts, event.type)) {
      requireValue(
        !starts[event.type].has(event.id),
        'Duplicate event correlation ID.',
      );
      starts[event.type].set(event.id, { atMs: event.atMs });
      if (event.type === 'input') {
        requireValue(
          ['event', 'handler-fallback'].includes(event.timestampSource),
          'Invalid input timestamp source.',
        );
        if (event.timestampSource === 'handler-fallback') {
          handlerTimestampFallbacks += 1;
        }
      }
      continue;
    }
    if (event.type === 'quality') {
      requireValue(
        samples.capabilities.playbackQuality &&
          Number.isSafeInteger(event.totalFrames) &&
          Number.isSafeInteger(event.droppedFrames) &&
          event.droppedFrames >= 0 &&
          event.totalFrames >= event.droppedFrames,
        'Invalid playback quality counters.',
      );
      if (lastQuality) {
        requireValue(
          event.totalFrames >= lastQuality.totalFrames &&
            event.droppedFrames >= lastQuality.droppedFrames &&
            event.totalFrames - lastQuality.totalFrames >=
              event.droppedFrames - lastQuality.droppedFrames,
          'Playback quality counters reset or regressed.',
        );
      }
      firstQuality ??= event;
      lastQuality = event;
      qualitySamples += 1;
      continue;
    }
    if (event.type === 'visibility') {
      requireValue(
        typeof event.hidden === 'boolean',
        'Invalid visibility flag.',
      );
      if (event.hidden && hiddenSince === null) hiddenSince = event.atMs;
      if (!event.hidden && hiddenSince !== null) {
        hiddenDurationMs += event.atMs - hiddenSince;
        hiddenSince = null;
      }
      continue;
    }

    const category = event.type.startsWith('startup')
      ? 'startup'
      : event.type.startsWith('seek')
        ? 'seek'
        : 'input';
    const start = starts[category].get(event.id);
    requireValue(start, 'Completion has no matching start event.');
    if (event.type === 'seeked') {
      requireValue(
        start.seekedAtMs === undefined && start.completed !== true,
        'Duplicate or out-of-order seek completion.',
      );
      start.seekedAtMs = event.atMs;
      durations.seekCompletion.push(event.atMs - start.atMs);
      continue;
    }
    requireValue(
      start.completed !== true,
      'Duplicate frame or render completion.',
    );
    requireValue(
      category === 'input'
        ? samples.capabilities.animationFrame
        : samples.capabilities.videoFrameCallback,
      'Completion contradicts capability flags.',
    );
    if (category === 'seek') {
      requireValue(
        start.seekedAtMs !== undefined,
        'Seek frame precedes seek completion.',
      );
      durations.seekFrame.push(event.atMs - start.seekedAtMs);
    }
    start.completed = true;
    durations[category].push(event.atMs - start.atMs);
  }
  if (hiddenSince !== null) {
    hiddenDurationMs += samples.durationMs - hiddenSince;
  }
  const incomplete = (category, field = 'completed') =>
    [...starts[category].values()].filter((start) => start[field] === undefined)
      .length;
  const totalFrames =
    qualitySamples >= 2
      ? lastQuality.totalFrames - firstQuality.totalFrames
      : null;
  const droppedFrames =
    qualitySamples >= 2
      ? lastQuality.droppedFrames - firstQuality.droppedFrames
      : null;
  const qualityWindowMs =
    qualitySamples >= 2 ? lastQuality.atMs - firstQuality.atMs : null;

  return {
    schemaVersion: 1,
    measurementVersion: 'browser-callback-v1',
    source: samples.source,
    durationMs: samples.durationMs,
    truncated: samples.truncated,
    capabilities: { ...samples.capabilities },
    hiddenDurationMs,
    qualityReadFailures: samples.qualityReadFailures,
    handlerTimestampFallbacks,
    startupToVideoFrame: summarize(durations.startup, incomplete('startup')),
    seekToVideoFrame: summarize(durations.seek, incomplete('seek')),
    seekToSeeked: summarize(
      durations.seekCompletion,
      incomplete('seek', 'seekedAtMs'),
    ),
    seekedToVideoFrame: summarize(durations.seekFrame, incomplete('seek')),
    inputToAnimationCallback: summarize(durations.input, incomplete('input')),
    frames: {
      qualitySamples,
      total: totalFrames,
      dropped: droppedFrames,
      droppedRatio: totalFrames > 0 ? droppedFrames / totalFrames : null,
      qualityWindowMs,
      totalFramesPerSecond:
        qualityWindowMs > 0 ? (totalFrames * 1000) / qualityWindowMs : null,
    },
  };
}

// Intentionally self-contained: --print-sampler prints this function for manual
// console use. Defining it does not start collection, play media, or open a page.
export function createBrowserSampler({ authorized, video, inputTarget } = {}) {
  if (authorized !== true)
    throw new Error('Explicit collection opt-in required.');
  if (!video?.addEventListener || !video?.removeEventListener) {
    throw new Error('Supply the authorized video element explicitly.');
  }
  const view = video.ownerDocument?.defaultView ?? globalThis;
  const document = video.ownerDocument;
  const target = inputTarget ?? document;
  if (
    !view.performance?.now ||
    !document?.addEventListener ||
    !document?.removeEventListener ||
    !target?.addEventListener ||
    !target?.removeEventListener
  ) {
    throw new Error('Required browser APIs unavailable.');
  }
  const capabilities = {
    videoFrameCallback:
      typeof video.requestVideoFrameCallback === 'function' &&
      typeof video.cancelVideoFrameCallback === 'function',
    animationFrame:
      typeof view.requestAnimationFrame === 'function' &&
      typeof view.cancelAnimationFrame === 'function',
    playbackQuality: typeof video.getVideoPlaybackQuality === 'function',
  };
  const origin = view.performance.now();
  const elapsed = () => view.performance.now() - origin;
  const events = [];
  const inputCallbacks = new Set();
  const ids = { startup: 0, seek: 0, input: 0 };
  let active = true;
  let truncated = false;
  let qualityReadFailures = 0;
  let startup = null;
  let seek = null;
  let videoCallback;
  let report;
  const record = (event) => {
    if (!active) return false;
    if (events.length === 10_000) {
      truncated = true;
      return false;
    }
    events.push(event);
    return true;
  };
  const quality = () => {
    if (!capabilities.playbackQuality) return;
    try {
      const value = video.getVideoPlaybackQuality();
      if (
        !Number.isSafeInteger(value.totalVideoFrames) ||
        !Number.isSafeInteger(value.droppedVideoFrames) ||
        value.droppedVideoFrames < 0 ||
        value.totalVideoFrames < value.droppedVideoFrames
      ) {
        throw new Error('Quality unavailable.');
      }
      record({
        type: 'quality',
        atMs: elapsed(),
        totalFrames: value.totalVideoFrames,
        droppedFrames: value.droppedVideoFrames,
      });
    } catch {
      qualityReadFailures += 1;
    }
  };
  const visibility = () =>
    record({
      type: 'visibility',
      atMs: elapsed(),
      hidden: document.hidden === true,
    });
  const onSeeking = () => {
    seek = { id: ++ids.seek, completed: false };
    record({ type: 'seek', id: seek.id, atMs: elapsed() });
  };
  const onSeeked = () => {
    if (!seek || seek.completed) return;
    seek.completed = true;
    record({ type: 'seeked', id: seek.id, atMs: elapsed() });
  };
  const frame = () => {
    if (!active) return;
    const atMs = elapsed();
    if (startup !== null && !video.paused && !video.seeking) {
      record({ type: 'startup-frame', id: startup, atMs });
      startup = null;
    }
    if (seek?.completed && !video.seeking) {
      record({ type: 'seek-frame', id: seek.id, atMs });
      seek = null;
    }
    videoCallback = video.requestVideoFrameCallback(frame);
  };
  const onInput = (event) => {
    if (!capabilities.animationFrame) return;
    const now = view.performance.now();
    const useEventTime =
      Number.isFinite(event.timeStamp) &&
      event.timeStamp >= origin &&
      event.timeStamp <= now;
    const id = ++ids.input;
    if (
      !record({
        type: 'input',
        id,
        atMs: (useEventTime ? event.timeStamp : now) - origin,
        timestampSource: useEventTime ? 'event' : 'handler-fallback',
      })
    ) {
      return;
    }
    const callback = view.requestAnimationFrame(() => {
      inputCallbacks.delete(callback);
      record({ type: 'input-render', id, atMs: elapsed() });
    });
    inputCallbacks.add(callback);
  };

  video.addEventListener('seeking', onSeeking);
  video.addEventListener('seeked', onSeeked);
  target.addEventListener('keydown', onInput, { capture: true, passive: true });
  target.addEventListener('pointerdown', onInput, {
    capture: true,
    passive: true,
  });
  document?.addEventListener('visibilitychange', visibility);
  visibility();
  quality();
  const interval = view.setInterval(quality, 1000);
  if (capabilities.videoFrameCallback) {
    videoCallback = video.requestVideoFrameCallback(frame);
  }

  return {
    markStartup() {
      if (!active || startup !== null || !video.paused) {
        throw new Error('Mark startup once before starting paused playback.');
      }
      startup = ++ids.startup;
      record({ type: 'startup', id: startup, atMs: elapsed() });
    },
    stop() {
      if (report) return structuredClone(report);
      quality();
      const durationMs = elapsed();
      active = false;
      view.clearInterval(interval);
      if (videoCallback !== undefined) {
        video.cancelVideoFrameCallback(videoCallback);
      }
      for (const callback of inputCallbacks)
        view.cancelAnimationFrame(callback);
      inputCallbacks.clear();
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('seeked', onSeeked);
      target.removeEventListener('keydown', onInput, true);
      target.removeEventListener('pointerdown', onInput, true);
      document?.removeEventListener('visibilitychange', visibility);
      report = {
        schemaVersion: 1,
        source: 'manual-browser',
        clock: 'performance-relative-ms',
        capabilities,
        durationMs,
        truncated,
        qualityReadFailures,
        events: events.sort((left, right) => left.atMs - right.atMs),
      };
      return structuredClone(report);
    },
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--print-sampler') {
    process.stdout.write(
      `globalThis.createShinemaPerformanceSampler = ${createBrowserSampler.toString()};\n`,
    );
    return;
  }
  if (args.length === 2 && args[0] === '--analyze') {
    let data;
    try {
      requireValue(
        (await stat(args[1])).size <= MAX_FILE_BYTES,
        'Sample file exceeds size limit.',
      );
      data = await readFile(args[1]);
    } catch {
      throw new Error('Unable to read sample file within size limit.');
    }
    requireValue(
      data.length <= MAX_FILE_BYTES,
      'Sample file exceeds size limit.',
    );
    let samples;
    try {
      samples = JSON.parse(data.toString('utf8'));
    } catch {
      throw new Error('Invalid sample JSON.');
    }
    process.stdout.write(
      `${JSON.stringify(analyzeHardwareSamples(samples), null, 2)}\n`,
    );
    return;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(
      'Offline analysis only: --analyze <local-samples.json>\n' +
        'Print a manual opt-in browser sampler: --print-sampler\n' +
        'No device connection or collection is performed by this CLI.\n',
    );
    return;
  }
  throw new Error('Unsupported arguments; use --help.');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Hardware sample analysis failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
