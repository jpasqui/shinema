import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyState } from '../src/legacy.ts';
import { ProgressQueue } from '../src/progress-queue.ts';
import { MemoryStore } from '../src/storage.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const OLD_FILE = JSON.stringify({
  origin: 'https://media.example.com:8787',
  catalog: null,
  progress: { [A]: { positionSeconds: 10, durationSeconds: 100 } },
  pending: {
    [A]: { positionSeconds: 40, durationSeconds: 100 },
    [B]: { positionSeconds: 999, durationSeconds: 100 },
    'not-an-id': { positionSeconds: 1, durationSeconds: 2 },
  },
});

test('reads unsynced progress from the old TV app, skipping damaged entries', () => {
  const state = parseLegacyState(OLD_FILE, 5000);
  assert.equal(state.origin, 'https://media.example.com:8787');
  assert.deepEqual(state.pending, [
    [A, { positionSeconds: 40, durationSeconds: 100, updatedAt: 5000 }],
  ]);
});

test('prefers the plain-HTTP origin saved by the local-HTTP build', () => {
  const state = parseLegacyState(
    JSON.stringify({
      origin: 'https://localhost:8787',
      localHttpOrigin: 'http://192.168.1.20:8787',
      pending: {},
    }),
    1,
  );
  assert.equal(state.origin, 'http://192.168.1.20:8787');
});

test('unreadable files import nothing', () => {
  assert.deepEqual(parseLegacyState('{not json', 1), {
    origin: null,
    pending: [],
  });
  assert.deepEqual(parseLegacyState('null', 1), { origin: null, pending: [] });
});

test('adopted progress never replaces something newer on this device', async () => {
  const queue = new ProgressQueue(new MemoryStore(), 'http://h:1');
  await queue.load();
  queue.record(A, 70, 100, 9000);
  queue.adopt(A, {
    positionSeconds: 40,
    durationSeconds: 100,
    updatedAt: 5000,
  });
  assert.equal(queue.local(A)?.positionSeconds, 70);
  queue.adopt(B, {
    positionSeconds: 20,
    durationSeconds: 100,
    updatedAt: 5000,
  });
  assert.equal(queue.local(B)?.positionSeconds, 20);
  assert.equal(queue.pendingCount(), 2);
});
