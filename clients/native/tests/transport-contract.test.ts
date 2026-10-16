import assert from 'node:assert/strict';
import test from 'node:test';
import { Request as NativeRequest } from 'whatwg-fetch';
import {
  localHttpOrigin,
  serverOrigin,
} from '../../../packages/contracts/index.ts';
import { RequestClient } from '../../../packages/contracts/requests.ts';

const token = 'synthetic-local-transport-test-access-only';
const empty = { apiVersion: 1, items: [] };
const reply = (url = '', value: unknown = empty) => {
  const response = new Response(JSON.stringify(value));
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

test('local HTTP candidates canonicalize eligible IPv4 and effective ports', () => {
  for (const origin of [
    'http://10.0.0.1',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.0.1',
    'http://127.0.0.1',
    'http://127.255.255.254',
    'http://169.254.1.1',
  ])
    assert.equal(localHttpOrigin(origin), origin);
  assert.equal(
    localHttpOrigin(' HTTP://192.168.0.1:80/ '),
    'http://192.168.0.1',
  );
  assert.equal(
    localHttpOrigin('http://192.168.0.1:8787/'),
    'http://192.168.0.1:8787',
  );
});

test('public, unspecified, multicast and alternate numeric IPv4 candidates are rejected', () => {
  for (const host of [
    '8.8.8.8',
    '100.64.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '169.253.255.255',
    '169.255.0.1',
    '192.169.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '134744072',
    '0x08080808',
    '010.010.010.010',
    '8.8.2056',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '127.0.0.1.',
    '%31%32%37.0.0.1',
  ])
    assert.throws(() => localHttpOrigin(`http://${host}`), host);
});

test('local IPv6 and mapped local IPv4 candidates canonicalize without opening public ranges', () => {
  for (const [input, canonical] of [
    ['http://[0:0:0:0:0:0:0:1]/', 'http://[::1]'],
    ['http://[FC00::1]:80', 'http://[fc00::1]'],
    ['http://[fdff:ffff::1]:8787', 'http://[fdff:ffff::1]:8787'],
    ['http://[fe80::1]', 'http://[fe80::1]'],
    ['http://[febf:ffff::1]', 'http://[febf:ffff::1]'],
    ['http://[::ffff:192.168.1.2]', 'http://[::ffff:c0a8:102]'],
    ['http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]'],
    ['http://[::ffff:169.254.1.1]', 'http://[::ffff:a9fe:101]'],
  ])
    assert.equal(localHttpOrigin(input), canonical);
  for (const host of [
    '[::]',
    '[2001:4860:4860::8888]',
    '[ff02::1]',
    '[fec0::1]',
    '[::ffff:8.8.8.8]',
    '[::ffff:0.0.0.0]',
    '[::192.168.1.2]',
    '[fe80::1%25eth0]',
  ])
    assert.throws(() => localHttpOrigin(`http://${host}`), host);
});

test('DNS names are only syntactic candidates pending native all-address validation', () => {
  assert.equal(
    localHttpOrigin('http://Generated-Server.local:8787/'),
    'http://generated-server.local:8787',
  );
  assert.equal(localHttpOrigin('http://example.test'), 'http://example.test');
  assert.equal(localHttpOrigin('http://localhost'), 'http://localhost');
  for (const host of [
    '-server.local',
    'server-.local',
    'server..local',
    'server_name.local',
  ])
    assert.throws(() => localHttpOrigin(`http://${host}`));
});

test('HTTP candidate syntax rejects credentials, normalization tricks and unrelated URL parts', () => {
  for (const input of [
    'https://192.168.0.1',
    'file:///private',
    'http://user:secret@192.168.0.1',
    'http://@192.168.0.1',
    'http://192.168.0.1/api',
    'http://192.168.0.1/.',
    'http://192.168.0.1/%2e',
    'http://192.168.0.1//',
    'http://192.168.0.1?',
    'http://192.168.0.1?token=synthetic',
    'http://192.168.0.1#',
    'http://192.168.0.1#synthetic',
    'http://192.168.0.1\\api',
    'http://192.168.0.1\n',
    'http://192.168.\t0.1',
    'http://192.168.0.1\u007f',
    'http://192.168.0.1:',
  ])
    assert.throws(() => localHttpOrigin(input), JSON.stringify(input));
});

test('server origins keep HTTPS default and scope HTTP to the exact canonical grant', () => {
  const origin = 'http://192.168.0.1:8787';
  assert.equal(serverOrigin('https://example.test/'), 'https://example.test');
  assert.equal(
    serverOrigin('https://example.test', { localHttpOrigin: origin }),
    'https://example.test',
  );
  assert.equal(
    serverOrigin('https://example.test', { localHttpOrigin: 'invalid' }),
    'https://example.test',
  );
  assert.equal(serverOrigin(`${origin}/`, { localHttpOrigin: origin }), origin);
  assert.equal(
    serverOrigin('http://192.168.0.1:80', {
      localHttpOrigin: 'http://192.168.0.1',
    }),
    'http://192.168.0.1',
  );
  for (const grant of [
    null,
    'http://192.168.0.2:8787',
    'http://192.168.0.1',
    `${origin}/`,
    'HTTP://192.168.0.1:8787',
  ])
    assert.throws(() => serverOrigin(origin, { localHttpOrigin: grant }));
  assert.throws(() => serverOrigin(origin));
  assert.throws(() =>
    serverOrigin('http://8.8.8.8', { localHttpOrigin: 'http://8.8.8.8' }),
  );
  assert.throws(() =>
    serverOrigin('http://[::1]', {
      localHttpOrigin: 'http://[0:0:0:0:0:0:0:1]',
    }),
  );
});

test('RequestClient snapshots the canonical grant and preserves auth, redirect and cookie guards', async () => {
  const origin = 'http://192.168.0.1:8787';
  const grant = { localHttpOrigin: origin };
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new RequestClient(
    origin,
    async (input, init) => {
      const nativeRequest = new NativeRequest(String(input), init);
      assert.equal(nativeRequest.url, String(input));
      calls.push({ url: String(input), init: init! });
      return reply(String(input));
    },
    grant,
  );
  grant.localHttpOrigin = 'http://192.168.0.2:8787';
  await client.unlock(token);
  await client.search('movie', 'Generated Orbit');
  for (const call of calls) {
    assert.ok(call.url.startsWith(`${origin}/api/requests`));
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.cache, undefined);
    assert.deepEqual(call.init.headers, { Authorization: `Bearer ${token}` });
  }
  assert.equal(
    calls[1].url,
    `${origin}/api/requests/search?kind=movie&query=Generated%20Orbit`,
  );
  assert.throws(() => new RequestClient(origin, undefined, grant));
  client.lock();
  await assert.rejects(client.list(), { code: 'unauthorized' });
  assert.equal(calls.length, 2);
});

test('RequestClient rejects missing, mismatched and noncanonical HTTP grants before transport', () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return reply();
  };
  const origin = 'http://192.168.0.1';
  assert.throws(() => new RequestClient(origin, transport));
  for (const grant of [
    null,
    'http://192.168.0.2',
    `${origin}/`,
    `${origin}:80`,
    'invalid',
    'http://8.8.8.8',
  ])
    assert.throws(
      () => new RequestClient(origin, transport, { localHttpOrigin: grant }),
    );
  assert.equal(calls, 0);
});

test('request final URLs reject different origins and HTTPS downgrades before consuming data', async () => {
  for (const [origin, finalUrl, grant] of [
    ['https://example.test', 'http://example.test/api/requests', null],
    ['https://example.test', 'https://other.test/api/requests', null],
    ['https://example.test', 'https://example.test:444/api/requests', null],
    [
      'https://example.test',
      'https://user:secret@example.test/api/requests',
      null,
    ],
    [
      'http://192.168.0.1',
      'http://192.168.0.2/api/requests',
      'http://192.168.0.1',
    ],
    [
      'http://192.168.0.1',
      'http://192.168.0.1:8787/api/requests',
      'http://192.168.0.1',
    ],
  ]) {
    let parsed = false;
    const client = new RequestClient(
      origin!,
      async (_input, init) => {
        assert.equal(init?.redirect, 'error');
        const response = reply(finalUrl!);
        response.json = async () => {
          parsed = true;
          return empty;
        };
        return response;
      },
      { localHttpOrigin: grant },
    );
    await assert.rejects(client.unlock(token), { code: 'connection' });
    assert.equal(parsed, false);
    await assert.rejects(client.list(), { code: 'unauthorized' });
  }
});

test('same-origin final responses are accepted for HTTPS and explicitly granted HTTP', async () => {
  for (const origin of ['https://example.test', 'http://[::1]:8787']) {
    const client = new RequestClient(
      origin,
      async (input) => reply(String(input)),
      {
        localHttpOrigin: origin.startsWith('http:') ? origin : null,
      },
    );
    assert.deepEqual(await client.unlock(token), []);
    client.lock();
  }
});

test('relative browser requests validate final responses against their construction-time origin', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    for (const origin of ['https://example.test', 'http://localhost:5173']) {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin },
      });
      const good = new RequestClient('', async () =>
        reply(`${origin}/api/requests`),
      );
      const wrong = new RequestClient('', async () =>
        reply('https://other.test/api/requests'),
      );
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://other.test' },
      });
      assert.deepEqual(await good.unlock(token), []);
      await assert.rejects(wrong.unlock(token), { code: 'connection' });
      good.lock();
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
