import assert from 'node:assert/strict';
import test from 'node:test';
import { Request as NativeRequest } from 'whatwg-fetch';
import { RequestClient } from '../../../packages/contracts/requests.ts';

test('native fetch polyfill preserves the strict request-search query without a cachebuster', async () => {
  const urls: string[] = [];
  const client = new RequestClient(
    'https://example.test',
    async (url, init) => {
      const nativeRequest = new NativeRequest(String(url), init);
      urls.push(nativeRequest.url);
      return new Response(JSON.stringify({ apiVersion: 1, items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  await client.unlock('synthetic-native-request-access-for-tests-only');
  await client.search('movie', 'Generated Orbit');
  assert.equal(
    urls[1],
    'https://example.test/api/requests/search?kind=movie&query=Generated%20Orbit',
  );
  assert.deepEqual(
    [...new URL(urls[1]).searchParams.keys()],
    ['kind', 'query'],
  );
  client.lock();
});
