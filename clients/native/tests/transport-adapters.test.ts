import assert from 'node:assert/strict';
import test from 'node:test';
import { Request as NativeRequest } from 'whatwg-fetch';
import type { ServerTransport } from '../../../packages/contracts/index.ts';
import { RequestClient } from '../../../packages/contracts/requests.ts';
import { NativeFeed, normalizeFeedScope } from '../src/feed.ts';
import { nativeFeedScope } from '../src/libraries.ts';
import { artworkUri } from '../src/preferences.ts';
import { SubtitleController, xhrSubtitleText } from '../src/subtitles.ts';

const origin = 'http://192.168.50.20:3000';
const otherOrigin = 'http://192.168.50.21:3000';
const grant = (): ServerTransport => Object.freeze({ localHttpOrigin: origin });
const id = 'a'.repeat(64);
const item = {
  id,
  title: 'Generated transport fixture',
  container: 'mp4',
  sizeBytes: 10,
  streamPath: `/api/media/${id}/stream`,
  posterPath: `/api/media/${id}/poster`,
  backdropPath: `/api/media/${id}/backdrop`,
};
const scope = () => ({ origin, libraryId: null, collection: 'all' });
const page = {
  apiVersion: 1,
  items: [item],
  offset: 0,
  limit: 48,
  total: 1,
  nextOffset: null,
};
const manifest = {
  tracks: [
    {
      id: 'english',
      label: 'Generated English',
      source: 'external',
      default: true,
      language: 'en',
      contentPath: `/api/media/${id}/subtitles/english.vtt`,
    },
  ],
};
const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nGenerated cue\n';

test('native feed scopes require an exact HTTP grant and retain HTTPS defaults', () => {
  assert.throws(() => normalizeFeedScope(scope()));
  assert.throws(() =>
    normalizeFeedScope({ ...scope(), localHttpOrigin: otherOrigin }),
  );
  assert.throws(() =>
    normalizeFeedScope({ ...scope(), localHttpOrigin: origin + '/' }),
  );
  assert.deepEqual(normalizeFeedScope({ ...scope(), ...grant() }), {
    ...scope(),
    ...grant(),
  });
  const secure = { ...scope(), origin: 'https://media.example.test' };
  assert.deepEqual(
    normalizeFeedScope({ ...secure, localHttpOrigin: null }),
    secure,
  );
  const navigation = { ...scope(), libraries: null, selectedLibraryId: null };
  assert.throws(() => nativeFeedScope(navigation));
  assert.throws(() =>
    nativeFeedScope({ ...navigation, localHttpOrigin: otherOrigin }),
  );
  assert.equal(
    nativeFeedScope({ ...navigation, ...grant() })?.localHttpOrigin,
    origin,
  );
});

test('pending feed work captures the validated immutable grant from its own scope', async () => {
  const selected = { ...scope(), localHttpOrigin: origin };
  const feed = new NativeFeed(selected);
  selected.localHttpOrigin = otherOrigin;
  let captured: ServerTransport | undefined;
  assert.equal(
    await feed.load(
      0,
      async (server, path, signal, context) => {
        assert.equal(server, origin);
        assert.equal(path, '/api/catalog?offset=0&limit=48');
        assert.equal(signal.aborted, false);
        captured = context;
        return page;
      },
      0,
    ),
    true,
  );
  assert.deepEqual(captured, grant());
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(feed.itemAt(0)?.id, id);
  assert.throws(() => feed.reset({ ...scope(), localHttpOrigin: otherOrigin }));
});

test('native artwork requires the same explicit origin grant for both image paths', () => {
  for (const kind of ['poster', 'backdrop'] as const) {
    assert.equal(artworkUri(origin, item, kind), undefined);
    assert.equal(
      artworkUri(origin, item, kind, { localHttpOrigin: otherOrigin }),
      undefined,
    );
    assert.equal(
      artworkUri(origin, item, kind, grant()),
      `${origin}/api/media/${id}/${kind}`,
    );
    assert.equal(
      artworkUri('https://media.example.test', item, kind),
      `https://media.example.test/api/media/${id}/${kind}`,
    );
  }
  assert.equal(
    artworkUri(
      origin,
      { ...item, posterPath: otherOrigin + item.posterPath },
      'poster',
      grant(),
    ),
    undefined,
  );
});

test('subtitle discovery and content share one frozen grant, and revocation clears old cues', async () => {
  const mutable = { localHttpOrigin: origin };
  const received: (ServerTransport | undefined)[] = [];
  let reads = 0;
  const controller = new SubtitleController(() => {}, {
    manifest: async (server, path, signal, context) => {
      reads++;
      assert.equal(server, origin);
      assert.equal(path, `/api/media/${id}/subtitles`);
      assert.equal(signal.aborted, false);
      received.push(context);
      mutable.localHttpOrigin = otherOrigin;
      return manifest;
    },
    content: async (server, path, _signal, context) => {
      reads++;
      assert.equal(server, origin);
      assert.equal(path, manifest.tracks[0].contentPath);
      received.push(context);
      return vtt;
    },
  });
  await assert.rejects(controller.start(origin, id, ['en']));
  await assert.rejects(
    controller.start(origin, id, ['en'], { localHttpOrigin: otherOrigin }),
  );
  assert.equal(reads, 0);
  await controller.start(origin, id, ['en'], mutable);
  assert.equal(controller.snapshot().content, 'ready');
  assert.equal(controller.snapshot().cues[0].text, 'Generated cue');
  assert.equal(received[0], received[1]);
  assert.deepEqual(received[0], grant());
  assert.equal(Object.isFrozen(received[0]), true);
  await assert.rejects(controller.start(origin, id, ['en'], mutable));
  assert.deepEqual(controller.snapshot().cues, []);
  await controller.retry();
  assert.equal(reads, 2);
  controller.cancel();
});

test('default subtitle fetch forwards matching HTTP grant and rejects redirected or foreign responses', async (context) => {
  let responseOrigin = origin;
  let redirected = false;
  const requests: string[] = [];
  context.mock.method(
    globalThis,
    'fetch',
    async (url: string, init: RequestInit) => {
      assert.equal(init.redirect, 'error');
      requests.push(String(url));
      const listing = String(url).endsWith('/subtitles');
      const response = new Response(listing ? JSON.stringify(manifest) : vtt, {
        headers: { 'content-type': listing ? 'application/json' : 'text/vtt' },
      });
      Object.defineProperties(response, {
        url: { value: responseOrigin + new URL(String(url)).pathname },
        redirected: { value: redirected },
      });
      return response;
    },
  );
  const controller = new SubtitleController(() => {});
  await controller.start(origin, id, ['en'], grant());
  assert.equal(controller.snapshot().content, 'ready');
  assert.equal(requests.length, 2);
  responseOrigin = otherOrigin;
  await controller.start(origin, id, ['en'], grant());
  assert.equal(controller.snapshot().status, 'error');
  assert.equal(requests.length, 3);
  responseOrigin = origin;
  redirected = true;
  await controller.start(origin, id, ['en'], grant());
  assert.equal(controller.snapshot().status, 'error');
  assert.equal(requests.length, 4);
  controller.cancel();
});

class FixtureXhr {
  status = 200;
  responseURL = origin + manifest.tracks[0].contentPath;
  responseText = vtt;
  readyState = 1;
  withCredentials = true;
  responseType = '';
  url = '';
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((event: unknown) => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  getResponseHeader(name: string) {
    return name === 'content-type' ? 'text/vtt' : null;
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  send() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  request() {
    return this as unknown as XMLHttpRequest;
  }
}

test('subtitle XHR rejects missing/stale grants before opening and validates response origin', async () => {
  const signal = new AbortController().signal;
  let creates = 0;
  const create = () => {
    creates++;
    return new FixtureXhr().request();
  };
  await assert.rejects(
    xhrSubtitleText(
      origin,
      manifest.tracks[0].contentPath,
      signal,
      true,
      create,
    ),
  );
  await assert.rejects(
    xhrSubtitleText(
      origin,
      manifest.tracks[0].contentPath,
      signal,
      true,
      create,
      { localHttpOrigin: otherOrigin },
    ),
  );
  assert.equal(creates, 0);
  const xhr = new FixtureXhr();
  const mutable = { localHttpOrigin: origin };
  const accepted = xhrSubtitleText(
    origin,
    manifest.tracks[0].contentPath,
    signal,
    true,
    () => xhr.request(),
    mutable,
  );
  mutable.localHttpOrigin = otherOrigin;
  assert.equal(xhr.url, origin + manifest.tracks[0].contentPath);
  assert.equal(xhr.withCredentials, false);
  xhr.onload?.();
  assert.equal(await accepted, vtt);
  const foreign = new FixtureXhr();
  const denied = xhrSubtitleText(
    origin,
    manifest.tracks[0].contentPath,
    signal,
    true,
    () => foreign.request(),
    grant(),
  );
  foreign.responseURL = otherOrigin + manifest.tracks[0].contentPath;
  foreign.onload?.();
  await assert.rejects(denied);
  assert.equal(foreign.aborted, true);
});

test('native Requests sends only with a matching captured grant and retains strict search query', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    urls.push(new NativeRequest(String(url), init).url);
    return new Response(JSON.stringify({ apiVersion: 1, items: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  assert.throws(() => new RequestClient(origin, fetcher));
  assert.throws(
    () => new RequestClient(origin, fetcher, { localHttpOrigin: otherOrigin }),
  );
  assert.equal(urls.length, 0);
  const mutable = { localHttpOrigin: origin };
  const client = new RequestClient(origin, fetcher, mutable);
  mutable.localHttpOrigin = otherOrigin;
  await client.unlock('synthetic-native-request-access-for-tests-only');
  await client.search('movie', 'Generated Orbit');
  assert.deepEqual(urls, [
    origin + '/api/requests',
    origin + '/api/requests/search?kind=movie&query=Generated%20Orbit',
  ]);
  client.lock();
  await assert.rejects(client.search('movie', 'Generated Orbit'));
  assert.equal(urls.length, 2);
});
