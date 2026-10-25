import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShinemaApi } from '../src/api.ts';
import { ProgressQueue } from '../src/progress-queue.ts';
import { resumePosition, watchState } from '../src/progress-types.ts';
import { MemoryStore, type KeyValueStore } from '../src/storage.ts';
import { fakeFetch, ID_A, ID_B } from './fake-server.ts';

const ORIGIN = 'http://192.168.1.20:8787';

async function queue(store: KeyValueStore = new MemoryStore()) {
  const value = new ProgressQueue(store, ORIGIN);
  await value.load();
  return value;
}

test('watch state: finished titles are watched, never "resume"', () => {
  assert.deepEqual(watchState(null), { kind: 'unwatched' });
  assert.deepEqual(watchState({ positionSeconds: 5, durationSeconds: 6000 }), {
    kind: 'unwatched',
  });
  assert.deepEqual(
    watchState({ positionSeconds: 3000, durationSeconds: 6000 }),
    {
      kind: 'inProgress',
      resumeAt: 3000,
      fraction: 0.5,
    },
  );
  // End credits: 20 seconds left of a feature counts as watched.
  assert.equal(
    watchState({ positionSeconds: 5980, durationSeconds: 6000 }).kind,
    'watched',
  );
  assert.equal(
    watchState({ positionSeconds: 6000, durationSeconds: 6000 }).kind,
    'watched',
  );
  assert.equal(
    resumePosition({ positionSeconds: 5980, durationSeconds: 6000 }),
    0,
  );
  // A 60-second clip near its end still resumes until the last 3 seconds.
  assert.equal(
    watchState({ positionSeconds: 50, durationSeconds: 60 }).kind,
    'inProgress',
  );
});

test('recorded progress survives a restart through storage', async () => {
  const store = new MemoryStore();
  const first = await queue(store);
  first.record(ID_A, 120, 3600, 1000);
  await first.persist();
  const second = await queue(store);
  assert.deepEqual(second.local(ID_A), {
    positionSeconds: 120,
    durationSeconds: 3600,
    updatedAt: 1000,
  });
  assert.equal(second.pendingCount(), 1);
});

test('a storage read failure is an error, never an empty queue', async () => {
  const broken: KeyValueStore = {
    read: () => Promise.reject(new Error('disk')),
    write: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  const value = new ProgressQueue(broken, ORIGIN);
  await assert.rejects(value.load(), /disk/);
  await assert.rejects(value.persist(), /never loaded/);
});

test('each server keeps its own queue', async () => {
  const store = new MemoryStore();
  const home = new ProgressQueue(store, ORIGIN);
  await home.load();
  home.record(ID_A, 100, 3600, 1000);
  await home.persist();
  const other = new ProgressQueue(store, 'http://10.0.0.9:8787');
  await other.load();
  assert.equal(other.pendingCount(), 0);
  const back = new ProgressQueue(store, ORIGIN);
  await back.load();
  assert.equal(back.pendingCount(), 1);
});

test('flush sends every pending title, adopts newer server progress and drops removed titles', async () => {
  const value = await queue();
  value.record(ID_A, 100, 3600, 1000);
  value.record(ID_B, 50, 1800, 1000);
  const third = 'c'.repeat(64);
  value.record(third, 10, 600, 1000);
  const { fetch } = fakeFetch(({ url }) =>
    url.includes(ID_A)
      ? { status: 204 }
      : url.includes(ID_B)
        ? {
            status: 409,
            body: {
              positionSeconds: 900,
              durationSeconds: 1800,
              updatedAt: 5000,
            },
          }
        : { status: 404 },
  );
  const result = await value.flush(new ShinemaApi({ origin: ORIGIN, fetch }));
  assert.deepEqual(result, { saved: 1, adopted: 1, dropped: 1, kept: 0 });
  assert.equal(value.pendingCount(), 0);
  assert.equal(value.local(ID_B)?.positionSeconds, 900);
});

test('offline flushes keep everything and stop early', async () => {
  const value = await queue();
  value.record(ID_A, 100, 3600, 1000);
  value.record(ID_B, 50, 1800, 1000);
  let calls = 0;
  const api = new ShinemaApi({
    origin: ORIGIN,
    fetch: async () => {
      calls += 1;
      throw new TypeError('offline');
    },
  });
  const result = await value.flush(api);
  assert.equal(result.kept, 1);
  assert.equal(calls, 1);
  assert.equal(value.pendingCount(), 2);
});

test('a position recorded during a flush is not lost when the older one is saved', async () => {
  const value = await queue();
  value.record(ID_A, 100, 3600, 1000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { fetch } = fakeFetch(async () => {
    await held;
    return { status: 204 };
  });
  const flushing = value.flush(new ShinemaApi({ origin: ORIGIN, fetch }));
  value.record(ID_A, 160, 3600, 2000);
  release();
  await flushing;
  assert.equal(value.pendingCount(), 1);
  assert.equal(value.local(ID_A)?.positionSeconds, 160);
});

test('server progress older than a local position does not replace it', async () => {
  const value = await queue();
  value.record(ID_A, 300, 3600, 5000);
  assert.equal(
    value.observe(ID_A, {
      positionSeconds: 100,
      durationSeconds: 3600,
      updatedAt: 1000,
    })?.positionSeconds,
    300,
  );
  assert.equal(
    value.observe(ID_A, {
      positionSeconds: 900,
      durationSeconds: 3600,
      updatedAt: 9000,
    })?.positionSeconds,
    900,
  );
});
