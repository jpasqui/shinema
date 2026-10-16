import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestClient,
  RequestError,
  parseRequestCandidate,
  parseRequestRecord,
  parseSonarrCompatibility,
} from '../../../packages/contracts/requests.ts';

const token = 'synthetic-request-access-for-tests-only';
const candidate = {
  kind: 'movie' as const,
  externalId: 101,
  title: 'Generated Orbit',
  year: 2026,
  overview: 'Synthetic fixture.',
  status: 'not_requested' as const,
};
const request = {
  id: 'movie-101',
  kind: 'movie' as const,
  externalId: 101,
  title: 'Generated Orbit',
  status: 'requested' as const,
  createdAt: 10,
  updatedAt: 10,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('transport is called without a RequestClient receiver', async () => {
  const client = new RequestClient('', async function (this: unknown) {
    assert.equal(this, undefined);
    return json({ apiVersion: 1, items: [] });
  });
  await client.unlock(token);
});

test('request client keeps bearer in memory, sends identity only, and does not follow redirects or use cookies', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new RequestClient(
    'https://example.test',
    async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json(
        init?.method === 'POST'
          ? { apiVersion: 1, item: request, duplicate: false }
          : { apiVersion: 1, items: [] },
      );
    },
  );
  await assert.rejects(client.search('movie', 'Orbit'), {
    code: 'unauthorized',
  });
  assert.equal(calls.length, 0);
  await client.unlock(token);
  await client.search('movie', ' Generated & Orbit ');
  const result = await client.submit(candidate);
  assert.equal(result.item.title, candidate.title);
  assert.equal(
    calls[1].url,
    'https://example.test/api/requests/search?kind=movie&query=Generated%20%26%20Orbit',
  );
  assert.equal(
    calls[2].init.body,
    JSON.stringify({ kind: 'movie', externalId: 101 }),
  );
  for (const call of calls) {
    assert.deepEqual(call.init.headers, {
      Authorization: `Bearer ${token}`,
      ...(call.init.method === 'POST'
        ? { 'Content-Type': 'application/json' }
        : {}),
    });
    assert.equal(call.init.cache, undefined);
    assert.equal(call.init.redirect, undefined);
    assert.equal(call.init.credentials, 'omit');
  }
  client.lock();
  await assert.rejects(client.list(), { code: 'unauthorized' });
});

test('invalid identities, searches, and token/transport origins fail before HTTP', async () => {
  let calls = 0;
  const client = new RequestClient('', async () => {
    calls++;
    return json({ apiVersion: 1, items: [] });
  });
  for (const origin of [
    'http://example.test',
    'https://user:secret@example.test',
    'https://example.test/path',
  ])
    assert.throws(() => new RequestClient(origin));
  await assert.rejects(client.unlock('short'), { code: 'unauthorized' });
  assert.equal(calls, 0);
  await client.unlock(token);
  await assert.rejects(client.search('movie', 'a'), {
    code: 'invalid_request',
  });
  await assert.rejects(client.search('movie', 'bad\nquery'), {
    code: 'invalid_request',
  });
  await assert.rejects(client.submit({ kind: 'movie', externalId: NaN }), {
    code: 'invalid_request',
  });
  assert.equal(calls, 1);
});

test('parsers reject malformed provider data and discard unrecognized fields', () => {
  assert.deepEqual(
    parseRequestCandidate({ ...candidate, apiKey: 'must-not-propagate' }),
    candidate,
  );
  assert.deepEqual(
    parseRequestRecord({ ...request, rootFolderPath: 'must-not-propagate' }),
    request,
  );
  assert.throws(() => parseRequestCandidate({ ...candidate, externalId: 0 }));
  assert.throws(() =>
    parseRequestCandidate({ ...candidate, status: 'downloaded' }),
  );
  assert.throws(() => parseRequestRecord({ ...request, updatedAt: 9 }));
  assert.throws(() =>
    parseRequestRecord({ ...request, status: ['requested'] }),
  );
});

test('capabilities never sends auth; incomplete refresh and safe server errors are represented', async () => {
  let sequence = 0;
  const client = new RequestClient('', async (_url, init) => {
    sequence++;
    if (sequence === 1) {
      assert.deepEqual(init?.headers, {});
      assert.equal(init?.redirect, 'error');
      return json({
        apiVersion: 1,
        enabled: false,
        authentication: 'bearer',
        providers: [],
      });
    }
    if (sequence === 2)
      return json({ apiVersion: 1, items: [request], refreshIncomplete: true });
    return json(
      {
        error: {
          code: 'provider_unavailable',
          message: 'private upstream URL and key',
        },
      },
      502,
    );
  });
  assert.equal((await client.capabilities()).enabled, false);
  assert.equal((await client.unlock(token)).length, 1);
  assert.equal(client.refreshIncomplete, true);
  await assert.rejects(
    client.search('movie', 'Orbit'),
    (error) =>
      error instanceof RequestError &&
      error.code === 'provider_unavailable' &&
      !error.message.includes('private'),
  );
});

test('logout invalidates in-flight responses and a late unlock cannot unlock the client again', async () => {
  let release!: (response: Response) => void;
  const client = new RequestClient(
    '',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = client.unlock(token);
  client.lock();
  release(json({ apiVersion: 1, items: [request] }));
  await assert.rejects(pending, { code: 'canceled' });
  await assert.rejects(client.list(), { code: 'unauthorized' });
});

test('ambiguous submissions are never retried and their status can be reconciled explicitly', async () => {
  let posts = 0;
  const client = new RequestClient('', async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      throw new Error('upstream private detail');
    }
    return json({
      apiVersion: 1,
      items: [{ ...request, status: 'uncertain' }],
    });
  });
  await client.unlock(token);
  await assert.rejects(client.submit(candidate), { code: 'connection' });
  assert.equal(posts, 1);
  assert.equal((await client.list())[0].status, 'uncertain');
});

test('Sonarr compatibility is authenticated and strips provider settings', async () => {
  const compatibility = {
    apiVersion: 1,
    enabled: true,
    status: 'ready',
    version: '5.0.0.2635',
    apiVersionPath: 'v5',
    preview: true,
    metadataLanguage: 'English',
    episodeOrder: 'Official',
  };
  let calls = 0;
  const client = new RequestClient('', async (url, init) => {
    calls++;
    assert.equal(
      init?.headers && (init.headers as Record<string, string>).Authorization,
      `Bearer ${token}`,
    );
    return String(url).endsWith('/sonarr')
      ? json({
          ...compatibility,
          apiKey: 'synthetic-private-value',
          providerUrl: 'private',
          rootFolderPath: 'private',
        })
      : json({ apiVersion: 1, items: [] });
  });
  await assert.rejects(client.sonarr(), { code: 'unauthorized' });
  assert.equal(calls, 0);
  await client.unlock(token);
  assert.deepEqual(await client.sonarr(), compatibility);
  client.lock();
  await assert.rejects(client.sonarr(), { code: 'unauthorized' });
});

test('Sonarr compatibility accepts stable/beta policies and rejects inconsistent or unbounded details', () => {
  const stable = {
    apiVersion: 1,
    enabled: true,
    status: 'ready',
    version: '4.0.20.3014',
    apiVersionPath: 'v3',
    preview: false,
  };
  const beta = {
    ...stable,
    version: '5.0.0.2635',
    apiVersionPath: 'v5',
    preview: true,
    metadataLanguage: 'English',
    episodeOrder: 'Official',
  };
  assert.deepEqual(parseSonarrCompatibility(stable), stable);
  assert.deepEqual(parseSonarrCompatibility(beta), beta);
  for (const state of [
    { apiVersion: 1, enabled: false, status: 'disabled', preview: false },
    { apiVersion: 1, enabled: true, status: 'unavailable', preview: false },
    {
      apiVersion: 1,
      enabled: true,
      status: 'unsupported',
      preview: false,
      version: '6.0.0.1',
    },
  ])
    assert.deepEqual(parseSonarrCompatibility(state), state);
  for (const invalid of [
    { apiVersion: 1, enabled: true, status: ['ready'], preview: false },
    { ...stable, status: {} },
    { ...stable, version: 'Sonarr private diagnostic' },
    { ...stable, version: '04.0.20.3014' },
    { ...stable, version: '4.0.20' },
    { ...stable, version: '4.2147483648.0.0' },
    { ...stable, version: '4.'.repeat(30) },
    { ...stable, version: '6.0.0.1' },
    { ...stable, enabled: false },
    { ...stable, apiVersionPath: 'v5' },
    { ...stable, preview: true },
    { ...beta, metadataLanguage: undefined },
    { ...beta, metadataLanguage: 'Japanese' },
    { ...beta, episodeOrder: 'DVD' },
    { ...beta, status: 'unsupported' },
  ])
    assert.throws(() => parseSonarrCompatibility(invalid));
});
