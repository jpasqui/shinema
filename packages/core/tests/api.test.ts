import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ShinemaApi } from '../src/api.ts';
import { fakeFetch, ID_A } from './fake-server.ts';

const TOKEN = 'f'.repeat(64);

test('requests carry the device token and parse the session', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      authRequired: true,
      deviceId: 'abc',
      deviceName: 'Shield',
      extra: 1,
    },
  }));
  const api = new ShinemaApi({
    origin: 'http://192.168.1.20:8787/',
    token: TOKEN,
    fetch,
  });
  const session = await api.session();
  assert.deepEqual(session, {
    authRequired: true,
    deviceId: 'abc',
    deviceName: 'Shield',
  });
  assert.equal(calls[0]?.url, 'http://192.168.1.20:8787/api/session');
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
});

test('media URLs carry the token as a query parameter and a width', () => {
  const api = new ShinemaApi({ origin: 'http://nas.local:8787', token: TOKEN });
  assert.equal(
    api.mediaUrl(`/api/media/${ID_A}/poster`, { width: 318.6 }),
    `http://nas.local:8787/api/media/${ID_A}/poster?w=319&access_token=${TOKEN}`,
  );
  assert.throws(() => api.mediaUrl('https://evil.example/x'), ApiError);
  const open = new ShinemaApi({ origin: 'http://127.0.0.1:8787' });
  assert.equal(
    open.mediaUrl(`/api/media/${ID_A}/stream`),
    `http://127.0.0.1:8787/api/media/${ID_A}/stream`,
  );
});

test('pairing returns the token or a message people can act on', async () => {
  const replies = [
    { status: 201, body: { deviceId: 'd1', name: 'Shield', token: TOKEN } },
    { status: 403 },
    { status: 429 },
  ];
  const { fetch, calls } = fakeFetch(() => replies.shift()!);
  const api = new ShinemaApi({ origin: 'http://192.168.1.20:8787', fetch });
  assert.deepEqual(await api.claimPairing('482-913', 'Shield'), {
    deviceId: 'd1',
    name: 'Shield',
    token: TOKEN,
  });
  assert.deepEqual(calls[0]?.body, { code: '482-913', deviceName: 'Shield' });
  await assert.rejects(api.claimPairing('000-000', 'Shield'), /did not work/);
  await assert.rejects(
    api.claimPairing('000-000', 'Shield'),
    /Too many attempts/,
  );
});

test('status codes map to error kinds the app can branch on', async () => {
  for (const [status, kind] of [
    [401, 'unauthorized'],
    [404, 'notFound'],
    [500, 'server'],
  ] as const) {
    const { fetch } = fakeFetch(() => ({ status }));
    const api = new ShinemaApi({ origin: 'http://h:1', fetch });
    await assert.rejects(api.summary(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, kind);
      return true;
    });
  }
  const offline = new ShinemaApi({
    origin: 'http://h:1',
    fetch: async () => {
      throw new TypeError('Network request failed');
    },
  });
  await assert.rejects(offline.health(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'network');
    return true;
  });
});

test('malformed server data is rejected rather than trusted', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 200,
    body: { apiVersion: 1, items: [{ id: 'not-an-id' }] },
  }));
  const api = new ShinemaApi({ origin: 'http://h:1', fetch });
  await assert.rejects(api.catalog({ limit: 60 }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'invalid');
    return true;
  });
});

test('a newer server position is reported instead of overwritten', async () => {
  const replies = [
    { status: 204 },
    {
      status: 409,
      body: { positionSeconds: 40, durationSeconds: 60, updatedAt: 2000 },
    },
  ];
  const { fetch, calls } = fakeFetch(() => replies.shift()!);
  const api = new ShinemaApi({ origin: 'http://h:1', fetch });
  const progress = {
    positionSeconds: 10,
    durationSeconds: 60,
    updatedAt: 1000,
  };
  assert.deepEqual(await api.saveProgress(ID_A, progress), { status: 'saved' });
  assert.deepEqual(calls[0]?.body, progress);
  assert.deepEqual(await api.saveProgress(ID_A, progress), {
    status: 'newerOnServer',
    current: { positionSeconds: 40, durationSeconds: 60, updatedAt: 2000 },
  });
});

test('catalog queries are encoded and empty values left out', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      apiVersion: 1,
      items: [],
      total: 0,
      offset: 0,
      limit: 60,
      nextOffset: null,
    },
  }));
  const api = new ShinemaApi({ origin: 'http://h:1', fetch });
  await api.catalog({
    library: 'movies',
    search: 'é & b',
    offset: 0,
    limit: 60,
  });
  assert.equal(
    calls[0]?.url,
    'http://h:1/api/catalog?library=movies&search=%C3%A9+%26+b&offset=0&limit=60',
  );
});

test('the default fetch is called unbound, as browsers require', async () => {
  const original = globalThis.fetch;
  let receiver: unknown = 'not called';
  globalThis.fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve(
      new Response(JSON.stringify({ apiVersion: 1, authRequired: false })),
    );
  } as typeof fetch;
  try {
    await new ShinemaApi({ origin: 'http://h:1' }).health();
    assert.ok(receiver === undefined || receiver === globalThis);
  } finally {
    globalThis.fetch = original;
  }
});
