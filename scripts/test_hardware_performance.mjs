import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import {
  analyzeHardwareSamples,
  createBrowserSampler,
} from './hardware-performance.mjs';

const script = fileURLToPath(
  new URL('./hardware-performance.mjs', import.meta.url),
);

function samples(events = [], overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'synthetic',
    clock: 'performance-relative-ms',
    capabilities: {
      videoFrameCallback: true,
      animationFrame: true,
      playbackQuality: true,
    },
    durationMs: 1000,
    truncated: false,
    qualityReadFailures: 0,
    events,
    ...overrides,
  };
}

test('summarizes explicit startup, seek, input and interval frame measurements', () => {
  const result = analyzeHardwareSamples(
    samples([
      { type: 'quality', atMs: 0, totalFrames: 100, droppedFrames: 10 },
      { type: 'startup', atMs: 0, id: 1 },
      { type: 'startup-frame', atMs: 100, id: 1 },
      { type: 'startup', atMs: 100, id: 2 },
      { type: 'startup-frame', atMs: 300, id: 2 },
      { type: 'seek', atMs: 400, id: 1 },
      { type: 'seeked', atMs: 500, id: 1 },
      { type: 'seek-frame', atMs: 540, id: 1 },
      { type: 'input', atMs: 600, id: 1, timestampSource: 'event' },
      { type: 'input-render', atMs: 616, id: 1 },
      { type: 'visibility', atMs: 700, hidden: true },
      { type: 'visibility', atMs: 800, hidden: false },
      { type: 'quality', atMs: 1000, totalFrames: 150, droppedFrames: 12 },
    ]),
  );
  assert.deepEqual(result.startupToVideoFrame, {
    completed: 2,
    incomplete: 0,
    medianMs: 150,
    p95Ms: 200,
    maxMs: 200,
  });
  assert.equal(result.seekToVideoFrame.medianMs, 140);
  assert.equal(result.seekToSeeked.medianMs, 100);
  assert.equal(result.seekedToVideoFrame.medianMs, 40);
  assert.equal(result.inputToAnimationCallback.medianMs, 16);
  assert.equal(result.hiddenDurationMs, 100);
  assert.deepEqual(result.frames, {
    qualitySamples: 2,
    total: 50,
    dropped: 2,
    droppedRatio: 0.04,
    qualityWindowMs: 1000,
    totalFramesPerSecond: 50,
  });
});

test('incomplete or unsupported measurements stay explicit instead of becoming zero latency', () => {
  const result = analyzeHardwareSamples(
    samples(
      [
        { type: 'startup', atMs: 0, id: 1 },
        { type: 'seek', atMs: 100, id: 1 },
        { type: 'seeked', atMs: 200, id: 1 },
        { type: 'seek', atMs: 300, id: 2 },
        {
          type: 'input',
          atMs: 400,
          id: 1,
          timestampSource: 'handler-fallback',
        },
        { type: 'visibility', atMs: 500, hidden: true },
      ],
      {
        capabilities: {
          videoFrameCallback: false,
          animationFrame: true,
          playbackQuality: false,
        },
        truncated: true,
      },
    ),
  );
  assert.equal(result.startupToVideoFrame.incomplete, 1);
  assert.equal(result.startupToVideoFrame.medianMs, null);
  assert.equal(result.seekToVideoFrame.incomplete, 2);
  assert.equal(result.seekToSeeked.incomplete, 1);
  assert.equal(result.seekedToVideoFrame.incomplete, 2);
  assert.equal(result.inputToAnimationCallback.incomplete, 1);
  assert.equal(result.handlerTimestampFallbacks, 1);
  assert.equal(result.hiddenDurationMs, 500);
  assert.equal(result.frames.total, null);
  assert.equal(result.truncated, true);
});

test('zero frames and zero duration never produce NaN, Infinity or a zero drop ratio', () => {
  const result = analyzeHardwareSamples(
    samples(
      [
        { type: 'quality', atMs: 0, totalFrames: 2, droppedFrames: 1 },
        { type: 'quality', atMs: 0, totalFrames: 2, droppedFrames: 1 },
      ],
      { durationMs: 0 },
    ),
  );
  assert.equal(result.frames.total, 0);
  assert.equal(result.frames.droppedRatio, null);
  assert.equal(result.frames.totalFramesPerSecond, null);
});

test('rejects bad, regressing and out-of-session timestamps', () => {
  for (const time of [-1, NaN, Infinity, '2', 1001]) {
    assert.throws(() =>
      analyzeHardwareSamples(samples([{ type: 'startup', id: 1, atMs: time }])),
    );
  }
  assert.throws(() =>
    analyzeHardwareSamples(
      samples([
        { type: 'startup', id: 1, atMs: 20 },
        { type: 'startup-frame', id: 1, atMs: 19 },
      ]),
    ),
  );
  assert.throws(() => analyzeHardwareSamples(samples([], { durationMs: -1 })));
});

test('rejects unmatched, duplicated and out-of-order correlated events', () => {
  const badSequences = [
    [{ type: 'startup-frame', id: 1, atMs: 0 }],
    [
      { type: 'startup', id: 1, atMs: 0 },
      { type: 'startup', id: 1, atMs: 1 },
    ],
    [
      { type: 'startup', id: 1, atMs: 0 },
      { type: 'startup-frame', id: 1, atMs: 1 },
      { type: 'startup-frame', id: 1, atMs: 2 },
    ],
    [
      { type: 'seek', id: 1, atMs: 0 },
      { type: 'seek-frame', id: 1, atMs: 1 },
    ],
    [
      { type: 'seek', id: 1, atMs: 0 },
      { type: 'seeked', id: 1, atMs: 1 },
      { type: 'seeked', id: 1, atMs: 2 },
    ],
    [{ type: 'startup', id: -1, atMs: 0 }],
    [{ type: 'input', id: 1, atMs: 0, timestampSource: 'unknown' }],
  ];
  for (const events of badSequences) {
    assert.throws(() => analyzeHardwareSamples(samples(events)));
  }
  assert.throws(() =>
    analyzeHardwareSamples(
      samples(
        [
          { type: 'startup', id: 1, atMs: 0 },
          { type: 'startup-frame', id: 1, atMs: 1 },
        ],
        {
          capabilities: {
            videoFrameCallback: false,
            animationFrame: true,
            playbackQuality: true,
          },
        },
      ),
    ),
  );
});

test('counter resets, impossible drop increments and malformed counters are rejected', () => {
  for (const [totalFrames, droppedFrames] of [
    [99, 10],
    [110, 9],
    [101, 12],
    [10, 20],
    [NaN, 0],
    [120, 10.5],
  ]) {
    assert.throws(() =>
      analyzeHardwareSamples(
        samples([
          { type: 'quality', atMs: 0, totalFrames: 100, droppedFrames: 10 },
          { type: 'quality', atMs: 1, totalFrames, droppedFrames },
        ]),
      ),
    );
  }
});

test('schema is bounded and rejects identifying fields without echoing their contents', () => {
  const privateValue = 'private-title-path-device-id';
  const badReports = [
    samples([], { deviceId: privateValue }),
    samples([{ type: 'startup', id: 1, atMs: 0, title: privateValue }]),
    samples([{ type: privateValue, atMs: 0 }]),
    samples([{ type: ['startup'], id: 1, atMs: 0 }]),
    samples([], { source: privateValue }),
    samples([], { schemaVersion: 2 }),
    samples(Array.from({ length: 10_001 }, () => ({ type: 'startup' }))),
    samples([], { capabilities: { videoFrameCallback: true } }),
    samples([], { qualityReadFailures: -1 }),
  ];
  for (const report of badReports) {
    assert.throws(
      () => analyzeHardwareSamples(report),
      (error) => {
        assert.equal(error.message.includes(privateValue), false);
        return true;
      },
    );
  }
  assert.equal(
    JSON.stringify(analyzeHardwareSamples(samples())).includes('events'),
    false,
  );
});

function fakeBrowser() {
  let now = 1000;
  let nextId = 0;
  const raf = new Map();
  const frames = new Map();
  const intervals = new Map();
  const target = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, callback) {
        const callbacks = listeners.get(type) ?? new Set();
        callbacks.add(callback);
        listeners.set(type, callbacks);
      },
      removeEventListener(type, callback) {
        listeners.get(type)?.delete(callback);
      },
      emit(type, event = {}) {
        for (const callback of listeners.get(type) ?? []) callback(event);
      },
    };
  };
  const document = { ...target(), hidden: false };
  const view = {
    performance: { now: () => now },
    requestAnimationFrame(callback) {
      raf.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame: (id) => raf.delete(id),
    setInterval(callback) {
      intervals.set(++nextId, callback);
      return nextId;
    },
    clearInterval: (id) => intervals.delete(id),
  };
  document.defaultView = view;
  const video = {
    ...target(),
    ownerDocument: document,
    paused: true,
    seeking: false,
    total: 100,
    dropped: 1,
    getVideoPlaybackQuality() {
      return { totalVideoFrames: this.total, droppedVideoFrames: this.dropped };
    },
    requestVideoFrameCallback(callback) {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelVideoFrameCallback: (id) => frames.delete(id),
  };
  const runCallbacks = (callbacks) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return {
    video,
    document,
    frames,
    raf,
    intervals,
    at: (value) => (now = 1000 + value),
    frame: () => runCallbacks(frames),
    render: () => runCallbacks(raf),
    quality: () => {
      for (const callback of intervals.values()) callback();
    },
  };
}

test('sampler refuses collection before opt-in and explicit element selection', () => {
  assert.throws(() => createBrowserSampler(), /opt-in/);
  assert.throws(() => createBrowserSampler({ authorized: false }), /opt-in/);
  assert.throws(() => createBrowserSampler({ authorized: true }), /element/);
});

test('manual sampler uses numeric events only and cancels all observation on stop', () => {
  const browser = fakeBrowser();
  const recorder = createBrowserSampler({
    authorized: true,
    video: browser.video,
  });
  recorder.markStartup();
  assert.throws(() => recorder.markStartup());
  browser.at(10);
  browser.frame(); // A paused frame cannot complete startup.
  browser.at(100);
  browser.video.paused = false;
  browser.frame();
  assert.throws(() => recorder.markStartup());
  browser.at(200);
  browser.video.seeking = true;
  browser.video.emit('seeking');
  browser.at(250);
  browser.frame(); // A pending seek cannot complete before seeked.
  browser.at(300);
  browser.video.seeking = false;
  browser.video.emit('seeked');
  browser.at(320);
  browser.frame();
  browser.at(400);
  browser.document.emit('keydown', {
    timeStamp: 1390,
    key: 'private-input-text',
    target: { textContent: 'private-title' },
  });
  browser.at(410);
  browser.render();
  browser.at(450);
  browser.document.emit('pointerdown', { timeStamp: 1_700_000_000_000 });
  browser.at(460);
  browser.render();
  browser.at(500);
  browser.video.total = 150;
  browser.video.dropped = 3;
  const report = recorder.stop();
  const result = analyzeHardwareSamples(report);
  assert.equal(result.startupToVideoFrame.medianMs, 100);
  assert.equal(result.seekToVideoFrame.medianMs, 120);
  assert.equal(result.seekedToVideoFrame.medianMs, 20);
  assert.equal(result.inputToAnimationCallback.medianMs, 15);
  assert.equal(result.handlerTimestampFallbacks, 1);
  assert.equal(result.frames.total, 50);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.equal(
    browser.frames.size + browser.raf.size + browser.intervals.size,
    0,
  );
  assert.equal(
    [...browser.document.listeners.values()].reduce(
      (sum, value) => sum + value.size,
      0,
    ),
    0,
  );
  assert.equal(
    [...browser.video.listeners.values()].reduce(
      (sum, value) => sum + value.size,
      0,
    ),
    0,
  );
  browser.at(700);
  assert.deepEqual(recorder.stop(), report);
  assert.throws(() => recorder.markStartup());
});

test('sampler flags unsupported APIs, failed counters and truncation', () => {
  const browser = fakeBrowser();
  delete browser.video.requestVideoFrameCallback;
  browser.video.getVideoPlaybackQuality = () => {
    throw new Error('private-browser-error');
  };
  const recorder = createBrowserSampler({
    authorized: true,
    video: browser.video,
  });
  recorder.markStartup();
  for (let index = 0; index < 10_010; index += 1) browser.quality();
  // Failed quality reads do not store exception messages or use the event budget.
  for (let index = 0; index < 5100; index += 1) {
    browser.document.emit('keydown', { timeStamp: 1000 });
    browser.render();
  }
  const report = recorder.stop();
  const result = analyzeHardwareSamples(report);
  assert.equal(result.capabilities.videoFrameCallback, false);
  assert.equal(result.qualityReadFailures, 10_012);
  assert.equal(result.truncated, true);
  assert.equal(report.events.length, 10_000);
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('CLI is offline by default, prints a dormant self-contained sampler and sanitizes errors', async () => {
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 0);
  assert.match(usage.stdout, /Offline analysis only/);
  const printed = spawnSync(process.execPath, [script, '--print-sampler'], {
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0);
  const context = vm.createContext({});
  vm.runInContext(printed.stdout, context);
  assert.equal(typeof context.createShinemaPerformanceSampler, 'function');
  assert.throws(() => context.createShinemaPerformanceSampler(), /opt-in/);

  const directory = await mkdtemp(join(tmpdir(), 'shinema-hardware-test-'));
  try {
    const input = join(directory, 'private-file-label.json');
    await writeFile(input, JSON.stringify(samples()));
    const analyzed = spawnSync(process.execPath, [script, '--analyze', input], {
      encoding: 'utf8',
    });
    assert.equal(analyzed.status, 0);
    assert.equal(JSON.parse(analyzed.stdout).source, 'synthetic');
    assert.equal(analyzed.stdout.includes(directory), false);
    await writeFile(input, '{private-invalid-json');
    const invalid = spawnSync(process.execPath, [script, '--analyze', input], {
      encoding: 'utf8',
    });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.includes('private'), false);
    assert.equal(invalid.stdout, '');
    await writeFile(input, ' '.repeat(1_048_577));
    const oversized = spawnSync(
      process.execPath,
      [script, '--analyze', input],
      { encoding: 'utf8' },
    );
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stderr.includes('private'), false);
    const missing = spawnSync(
      process.execPath,
      [script, '--analyze', join(directory, 'private-missing')],
      { encoding: 'utf8' },
    );
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.includes('private'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
