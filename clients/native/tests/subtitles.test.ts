import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubtitleCues,
  subtitleAt,
  SubtitleClock,
  SubtitleController,
  xhrSubtitleText,
} from '../src/subtitles.ts';
import type { SubtitleState, SubtitleTransport } from '../src/subtitles.ts';
import type { SubtitleTrack } from '../../../packages/contracts/index.ts';

const id = 'a'.repeat(64);
const nextId = 'b'.repeat(64);
const origin = 'https://library.example';
const vtt =
  'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nFirst synthetic cue\n\n00:00:10.000 --> 00:00:12.000\nResume cue\n';
function track(
  key: string,
  language = 'en',
  isDefault = false,
  media = id,
): SubtitleTrack {
  return {
    id: key,
    label: `Generated ${key}`,
    source: 'external',
    default: isDefault,
    language,
    contentPath: `/api/media/${media}/subtitles/${key}.vtt`,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(io: SubtitleTransport) {
  const states: SubtitleState[] = [];
  const controller = new SubtitleController((state) => states.push(state), io);
  return { controller, states };
}

test('captions use media time for starts, ends, resume, backward/forward seeks and overlaps', () => {
  const cues = parseSubtitleCues(
    vtt + '\n00:00:03.000 --> 00:00:05.000\nOverlap\n',
  );
  assert.equal(subtitleAt(cues, 1.999), '');
  assert.equal(subtitleAt(cues, 2), 'First synthetic cue');
  assert.equal(subtitleAt(cues, 3), 'First synthetic cue\nOverlap');
  assert.equal(subtitleAt(cues, 4), 'Overlap');
  assert.equal(subtitleAt(cues, 5), '');
  assert.equal(subtitleAt(cues, 10.5), 'Resume cue');
  assert.equal(subtitleAt(cues, 2.5), 'First synthetic cue');
  assert.equal(subtitleAt(cues, 12), '');
  assert.equal(subtitleAt(cues, NaN), '');
  assert.equal(subtitleAt(cues, -1), '');
});

test('playing and paused caption seeks accept target progress without an acknowledgement, hiding queued old times', () => {
  let now = 0;
  const clock = new SubtitleClock(() => now);
  const cues = parseSubtitleCues(vtt);
  assert.equal(subtitleAt(cues, clock.update(2.5)), 'First synthetic cue');
  clock.seek(10.5);
  assert.equal(subtitleAt(cues, clock.current()), '');
  assert.equal(subtitleAt(cues, clock.update(2.7)), '');
  now = 100;
  assert.equal(subtitleAt(cues, clock.update(10.5)), 'Resume cue');
  assert.equal(subtitleAt(cues, clock.update(10.6)), 'Resume cue');
  // A paused seek can report its new fixed position through progress alone.
  clock.seek(2.5);
  assert.equal(subtitleAt(cues, clock.update(10.7)), '');
  now = 200;
  assert.equal(subtitleAt(cues, clock.update(2.5)), 'First synthetic cue');
  now = 1200;
  assert.equal(subtitleAt(cues, clock.current()), 'First synthetic cue');
});

test('resume captions accept fresh target progress independently of the progress-saving seek guard', () => {
  const clock = new SubtitleClock(() => 0);
  const cues = parseSubtitleCues(vtt);
  clock.reset();
  clock.seek(10.5);
  assert.equal(subtitleAt(cues, clock.update(0)), '');
  assert.equal(subtitleAt(cues, clock.update(10.5)), 'Resume cue');
  clock.seek(0);
  assert.equal(subtitleAt(cues, clock.update(2.7)), '');
  assert.equal(clock.update(0), 0);
});

test('imprecise or failed caption seeks recover after two seconds even while paused without another event', () => {
  let now = 0;
  const clock = new SubtitleClock(() => now);
  const cues = parseSubtitleCues(vtt);
  clock.update(2.5);
  const request = clock.seek(10.5);
  assert.equal(subtitleAt(cues, clock.update(2.7)), '');
  now = 1999;
  assert.equal(subtitleAt(cues, clock.recover(request)), '');
  now = 2000;
  assert.equal(subtitleAt(cues, clock.recover(request)), 'First synthetic cue');
  assert.equal(clock.update(3), 3);
  clock.seek(100);
  now = 4000;
  // A different keyframe/failed seek position also exits the guard on progress.
  assert.equal(clock.update(10.5), 10.5);
});

test('an earlier seek acknowledgement cannot settle a newer target or overwrite its accepted caption time', () => {
  const clock = new SubtitleClock(() => 0);
  clock.update(2.5);
  clock.seek(10);
  clock.seek(30);
  assert.equal(clock.acceptsSeek(10), false);
  assert.equal(Number.isNaN(clock.update(10.2, 10)), true);
  assert.equal(Number.isNaN(clock.update(2.7)), true);
  assert.equal(clock.update(30.1), 30.1);
  assert.equal(clock.update(10.3, 10), 30.1);
  assert.equal(clock.acceptsSeek(30), true);
  assert.equal(clock.update(30.2, 30), 30.2);
});

test('old recovery timers cannot release a newer caption seek, and stop/reset fence pending recovery', () => {
  let now = 0;
  const clock = new SubtitleClock(() => now);
  clock.update(2.5);
  const first = clock.seek(10);
  now = 1500;
  const second = clock.seek(30);
  now = 2100;
  assert.equal(Number.isNaN(clock.recover(first)), true);
  assert.equal(Number.isNaN(clock.update(10.2, 10)), true);
  assert.equal(Number.isNaN(clock.current()), true);
  now = 3500;
  assert.equal(clock.recover(second), 2.5);
  const stopped = clock.seek(10);
  clock.stop();
  now = 6000;
  assert.equal(Number.isNaN(clock.recover(stopped)), true);
  assert.equal(Number.isNaN(clock.update(10.5)), true);
  clock.reset();
  assert.equal(clock.update(2.5), 2.5);
  assert.throws(() => clock.seek(NaN));
  assert.throws(() => clock.seek(-1));
});

class FakeXhr {
  status = 200;
  responseURL = origin + `/api/media/${id}/subtitles/english.vtt`;
  text = vtt;
  reads = 0;
  readyState = 1;
  withCredentials = true;
  responseType = '';
  aborted = false;
  method = '';
  url = '';
  headers: Record<string, string> = {
    'content-type': 'text/vtt; charset=utf-8',
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress:
    | ((event: {
        loaded: number;
        lengthComputable: boolean;
        total: number;
      }) => void)
    | null = null;
  onreadystatechange: (() => void) | null = null;
  get responseText() {
    this.reads++;
    return this.text;
  }
  getResponseHeader(name: string) {
    return this.headers[name] ?? null;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  receiveHeaders() {
    this.readyState = 2;
    this.onreadystatechange?.();
  }
  complete() {
    this.receiveHeaders();
    this.readyState = 4;
    this.onload?.();
  }
  asRequest() {
    return this as unknown as XMLHttpRequest;
  }
}

test('native XHR accepts bounded chunked VTT without Content-Length and opts out of credentials', async () => {
  const xhr = new FakeXhr();
  const result = xhrSubtitleText(
    origin,
    `/api/media/${id}/subtitles/english.vtt`,
    new AbortController().signal,
    true,
    () => xhr.asRequest(),
  );
  xhr.onprogress?.({ loaded: 150, lengthComputable: false, total: 0 });
  xhr.complete();
  assert.equal(await result, vtt);
  assert.equal(xhr.withCredentials, false);
  assert.equal(xhr.method, 'GET');
  assert.equal(xhr.url, origin + `/api/media/${id}/subtitles/english.vtt`);
  assert.equal(xhr.aborted, false);
});

test('native XHR aborts over-limit chunked input before decoding, and aborts on leave', async () => {
  const xhr = new FakeXhr();
  const result = xhrSubtitleText(
    origin,
    '/synthetic.vtt',
    new AbortController().signal,
    true,
    () => xhr.asRequest(),
  );
  xhr.onprogress?.({
    loaded: 4 * 1024 * 1024 + 1,
    lengthComputable: false,
    total: 0,
  });
  await assert.rejects(result, /too large/);
  assert.equal(xhr.aborted, true);
  assert.equal(xhr.reads, 0);
  xhr.complete();
  assert.equal(xhr.reads, 0);
  const pending = new FakeXhr();
  const controller = new AbortController();
  const canceled = xhrSubtitleText(
    origin,
    '/synthetic.vtt',
    controller.signal,
    true,
    () => pending.asRequest(),
  );
  controller.abort();
  await assert.rejects(canceled, /canceled/);
  assert.equal(pending.aborted, true);
  assert.equal(pending.reads, 0);
});

test('native XHR rejects declared oversize, wrong type, cross-origin final URLs and oversized UTF8', async () => {
  for (const change of [
    (xhr: FakeXhr) => {
      xhr.headers['content-length'] = '4194305';
    },
    (xhr: FakeXhr) => {
      xhr.headers['content-length'] = '-1';
    },
    (xhr: FakeXhr) => {
      xhr.headers['content-type'] = 'text/html';
    },
    (xhr: FakeXhr) => {
      xhr.responseURL = 'https://elsewhere.example/captions.vtt';
    },
    (xhr: FakeXhr) => {
      xhr.text = '😀'.repeat(1048577);
    },
  ]) {
    const xhr = new FakeXhr();
    change(xhr);
    const result = xhrSubtitleText(
      origin,
      '/synthetic.vtt',
      new AbortController().signal,
      true,
      () => xhr.asRequest(),
    );
    xhr.complete();
    await assert.rejects(result);
    assert.equal(xhr.aborted, true);
  }
});

test('streaming fetch fallback cancels oversized responses and rejects invalid UTF8', async (context) => {
  let canceled = false;
  let invalidUtf8 = false;
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/subtitles'))
      return new Response(
        JSON.stringify({ tracks: [track('english', 'en', true)] }),
      );
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            invalidUtf8
              ? new Uint8Array([255])
              : new Uint8Array(4 * 1024 * 1024 + 1),
          );
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/vtt' } },
    );
  });
  const controller = new SubtitleController(() => {});
  await controller.start(origin, id, ['en']);
  assert.equal(controller.snapshot().content, 'error');
  assert.equal(canceled, true);
  canceled = false;
  invalidUtf8 = true;
  await controller.retry();
  assert.equal(controller.snapshot().content, 'error');
  assert.equal(canceled, true);
  controller.cancel();
});

test('normalized VTT supports identifiers, CRLF and plain Unicode text, never HTML', () => {
  const cues = parseSubtitleCues(
    '\uFEFFWEBVTT\r\n\r\nsynthetic-id\r\n00:01.000 --> 00:02.000 align:center\r\n<v Voice><i>é 😀</i></v> &lt;b&gt; &amp;\r\n\r\nNOTE synthetic comment\r\nignored\r\n',
  );
  assert.equal(subtitleAt(cues, 1), 'é 😀 <b> &');
  assert.equal(subtitleAt(cues, 2), '');
});

test('malformed, styled, control-bearing and oversized subtitle inputs fail closed', () => {
  for (const value of [
    'not WebVTT',
    'WEBVTT\n\n00:00:60.000 --> 00:00:61.000\nInvalid\n',
    'WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nReversed\n',
    'WEBVTT\n\n00:00:01.000 --> 00:00:01.000\nEmpty time\n',
    'WEBVTT\n\n999999:00:00.000 --> 999999:00:01.000\nToo late\n',
    'WEBVTT\n\nSTYLE\n::cue { color: red }\n',
    'WEBVTT\n\nREGION\nid:sample\n',
    vtt.replace('First', '\u0000First'),
    'WEBVTT\n\n' + '😀'.repeat(1048576),
    'WEBVTT\n\n' + '00:00:01.000 --> 00:00:02.000\nCue\n\n'.repeat(20001),
  ])
    assert.throws(() => parseSubtitleCues(value));
});

test('Auto chooses supported defaults/languages; explicit Off and manual language persist for this app session', async () => {
  let media = id;
  const io: SubtitleTransport = {
    manifest: async () => ({
      tracks: [
        track('english', 'eng', false, media),
        track('french', 'fr', false, media),
        {
          id: 'image',
          label: 'Image',
          source: 'embedded',
          default: true,
          language: 'fr',
          unsupportedReason: 'Image subtitles are unsupported',
        },
      ],
    }),
    content: async () => vtt,
  };
  const { controller } = setup(io);
  await controller.start(origin, id, ['fr-FR']);
  assert.equal(controller.snapshot().selected, 'french');
  await controller.select('english');
  assert.equal(controller.snapshot().selected, 'english');
  await controller.select('image');
  assert.equal(controller.snapshot().selected, 'english');
  media = nextId;
  await controller.start(origin, nextId, ['fr-FR']);
  assert.equal(controller.snapshot().selected, 'english');
  await controller.select('');
  assert.equal(controller.snapshot().content, 'idle');
  assert.deepEqual(controller.snapshot().cues, []);
  media = id;
  await controller.start(origin, id, ['fr-FR']);
  assert.equal(controller.snapshot().selected, '');
  assert.equal(controller.snapshot().automatic, false);
  await controller.automatic();
  assert.equal(controller.snapshot().selected, 'french');
  assert.equal(controller.snapshot().automatic, true);
  controller.cancel();
});

test('Off chosen while discovery is loading prevents late default auto-selection', async () => {
  const manifest = deferred<unknown>();
  let downloads = 0;
  const { controller } = setup({
    manifest: () => manifest.promise,
    content: async () => {
      downloads++;
      return vtt;
    },
  });
  const started = controller.start(origin, id, ['en']);
  await controller.select('');
  manifest.resolve({ tracks: [track('english', 'en', true)] });
  await started;
  assert.equal(controller.snapshot().selected, '');
  assert.equal(downloads, 0);
  controller.cancel();
});

test('switching tracks or Off cancels requests and ignores old content even if transport ignores abort', async () => {
  const english = deferred<string>();
  const french = deferred<string>();
  const signals: AbortSignal[] = [];
  const { controller } = setup({
    manifest: async () => ({
      tracks: [track('english', 'en'), track('french', 'fr')],
    }),
    content: async (_origin, path, signal) => {
      signals.push(signal);
      return path.includes('english') ? english.promise : french.promise;
    },
  });
  await controller.start(origin, id, []);
  const first = controller.select('english');
  const second = controller.select('french');
  assert.equal(signals[0].aborted, true);
  await controller.select('');
  assert.equal(signals[1].aborted, true);
  english.resolve(vtt);
  french.resolve(vtt);
  await Promise.all([first, second]);
  assert.equal(controller.snapshot().selected, '');
  assert.equal(controller.snapshot().content, 'idle');
  assert.deepEqual(controller.snapshot().cues, []);
  controller.cancel();
});

test('leave, title changes and origin changes cancel discovery and cannot publish late responses', async () => {
  const old = deferred<unknown>();
  const requests: { origin: string; path: string; signal: AbortSignal }[] = [];
  const { controller, states } = setup({
    manifest: async (requestOrigin, path, signal) => {
      requests.push({ origin: requestOrigin, path, signal });
      return requests.length === 1
        ? old.promise
        : { tracks: [track('current', 'fr', true, nextId)] };
    },
    content: async () => vtt,
  });
  const first = controller.start(origin, id, []);
  await controller.start('https://second.example', nextId, []);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].origin, 'https://second.example');
  assert.equal(requests[1].path, `/api/media/${nextId}/subtitles`);
  old.resolve({ tracks: [track('old', 'en', true)] });
  await first;
  assert.equal(controller.snapshot().selected, 'current');
  const before = states.length;
  controller.cancel();
  await tick();
  assert.equal(states.length, before);
});

test('leaving while content is pending aborts promptly without a state update or an unhandled rejection', async () => {
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const { controller, states } = setup({
    manifest: async () => ({ tracks: [track('english', 'en', true)] }),
    content: (_origin, _path, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  const started = controller.start(origin, id, []);
  await tick();
  const before = states.length;
  controller.cancel();
  await started;
  assert.equal(signal.aborted, true);
  pending.reject(new Error('Synthetic late failure'));
  await tick();
  assert.equal(states.length, before);
});

test('discovery/content failures can retry independently; unsafe manifests never request a subtitle URL', async () => {
  let attempts = 0;
  let downloads = 0;
  const { controller } = setup({
    manifest: async () => {
      if (++attempts === 1) throw new Error('Offline');
      return { tracks: [track('english', 'en', true)] };
    },
    content: async () => {
      if (++downloads === 1) throw new Error('Unavailable');
      return vtt;
    },
  });
  await controller.start(origin, id, ['en']);
  assert.equal(controller.snapshot().status, 'error');
  await controller.retry();
  assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.snapshot().content, 'error');
  await controller.retry();
  assert.equal(controller.snapshot().content, 'ready');
  assert.equal(subtitleAt(controller.snapshot().cues, 10.1), 'Resume cue');
  assert.equal(attempts, 2);
  assert.equal(downloads, 2);
  controller.cancel();
  let unsafeDownloads = 0;
  const unsafe = setup({
    manifest: async () => ({
      tracks: [
        {
          ...track('english'),
          contentPath: 'https://elsewhere.example/private.vtt',
        },
      ],
    }),
    content: async () => {
      unsafeDownloads++;
      return vtt;
    },
  }).controller;
  await unsafe.start(origin, id, ['en']);
  assert.equal(unsafe.snapshot().status, 'error');
  assert.equal(unsafeDownloads, 0);
  unsafe.cancel();
});

test('timed-out discovery and content become retryable even when a transport ignores cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let manifestAttempts = 0;
  let contentAttempts = 0;
  const never = new Promise<never>(() => {});
  const { controller } = setup({
    manifest: async () =>
      ++manifestAttempts === 1
        ? never
        : { tracks: [track('english', 'en', true)] },
    content: async () => (++contentAttempts === 1 ? never : vtt),
  });
  const started = controller.start(origin, id, ['en']);
  context.mock.timers.tick(15000);
  await started;
  assert.equal(controller.snapshot().status, 'error');
  const retry = controller.retry();
  await tick();
  assert.equal(controller.snapshot().content, 'loading');
  context.mock.timers.tick(20000);
  await retry;
  assert.equal(controller.snapshot().content, 'error');
  await controller.retry();
  assert.equal(controller.snapshot().content, 'ready');
  controller.cancel();
});
