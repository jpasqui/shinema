import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, recover } from '../src/domain.ts';
import type { Stored } from '../src/domain.ts';
import { NativeActivity, StartupHydration } from '../src/lifecycle.ts';
import {
  connectValidated,
  SessionGuard,
  StorageQueue,
} from '../src/session.ts';

const origin = 'https://saved.example.test';
const id = 'a'.repeat(64);
const progress = { positionSeconds: 21, durationSeconds: 120 };
const catalog = {
  apiVersion: 1 as const,
  items: [
    {
      id,
      title: 'Synthetic title',
      container: 'mp4',
      sizeBytes: 100,
      streamPath: `/api/media/${id}/stream`,
    },
  ],
};
const saved: Stored = {
  ...fresh(),
  origin,
  catalog,
  progress: { [id]: progress },
  pending: { [id]: progress },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let current = fresh();
  let reads = 0;
  const disk = deferred<string>();
  const writes: Stored[] = [];
  const startup = new StartupHydration(
    () => {
      reads++;
      return disk.promise.then(recover);
    },
    (value) => {
      current = value;
    },
  );
  const queue = new StorageQueue();
  const io = {
    read: () => current,
    write: (value: Stored) => {
      current = value;
    },
    persist: () => startup.run(() => queue.run(() => io.writeDisk(current))),
    queue,
    stageDisk: async (_value: Stored) => {},
    writeDisk: async (value: Stored) => {
      writes.push(structuredClone(value));
    },
  };
  return { startup, disk, io, writes, reads: () => reads };
}

test('early address input then same-origin Connect retains recovered progress and pending without late UI takeover', async () => {
  for (const action of ['address', 'appearance', 'remote'])
    for (const cache of [catalog, null, { apiVersion: 99, items: [] }]) {
      const value = fixture();
      const activity = new NativeActivity();
      const epoch = activity.capture();
      let input = fresh().origin;
      let route = 'setup';
      let automaticConnections = 0;
      const presentation = value.startup.ready().then((restored) => {
        if (!activity.current(epoch)) return;
        input = restored.origin;
        route = 'library';
        automaticConnections++;
      });
      activity.interact();
      input = origin;
      route = action;
      const guard = new SessionGuard();
      const attempt = guard.beginConnection();
      let loads = 0;
      const connecting = value.startup.run(() =>
        connectValidated(
          guard,
          attempt,
          origin,
          async () => {
            loads++;
            return catalog;
          },
          value.io,
        ),
      );
      await Promise.resolve();
      assert.equal(loads, 0);
      assert.equal(value.writes.length, 0);
      value.disk.resolve(JSON.stringify({ ...saved, catalog: cache }));
      const result = await connecting;
      await presentation;
      assert.equal(result?.switched, false);
      assert.deepEqual(value.io.read().progress[id], progress);
      assert.deepEqual(value.io.read().pending[id], progress);
      assert.deepEqual(value.writes.at(-1)?.pending[id], progress);
      assert.equal(input, origin);
      assert.equal(route, action);
      assert.equal(automaticConnections, 0);
      assert.equal(value.reads(), 1);
    }
});

test('early Back/exit waits for the durable base and cannot persist a fresh empty cache over saved progress', async () => {
  const value = fixture();
  const activity = new NativeActivity();
  const epoch = activity.capture();
  let input = 'https://typed.example.test';
  let route = 'exit';
  let finished = false;
  const presentation = value.startup.ready().then((restored) => {
    if (activity.current(epoch)) {
      input = restored.origin;
      route = 'library';
    }
  });
  activity.cancelConnection();
  const exiting = value.io.persist().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(value.writes.length, 0);
  value.disk.resolve(JSON.stringify(saved));
  await Promise.all([exiting, presentation]);
  assert.equal(finished, true);
  assert.equal(route, 'exit');
  assert.equal(input, 'https://typed.example.test');
  assert.equal(value.writes.length, 1);
  assert.equal(value.writes[0].origin, origin);
  assert.deepEqual(value.writes[0].progress[id], progress);
  assert.deepEqual(value.writes[0].pending[id], progress);
});

test('an early explicit different-origin connection waits for recovery and never borrows the saved origin progress', async () => {
  const value = fixture();
  const guard = new SessionGuard();
  const destination = 'https://other.example.test';
  let baseAtLoad: Stored | undefined;
  const connecting = value.startup.run(() =>
    connectValidated(
      guard,
      guard.beginConnection(),
      destination,
      async () => {
        baseAtLoad = value.io.read();
        return catalog;
      },
      value.io,
    ),
  );
  value.disk.resolve(JSON.stringify(saved));
  const result = await connecting;
  assert.equal(baseAtLoad?.origin, origin);
  assert.deepEqual(baseAtLoad?.pending[id], progress);
  assert.equal(result?.switched, true);
  assert.equal(value.io.read().origin, destination);
  assert.deepEqual(value.io.read().progress, {});
  assert.deepEqual(value.io.read().pending, {});
  assert.deepEqual(value.writes.at(-1)?.pending, {});
});

test('hydration runs once and a delayed same-origin activation cannot erase progress saved after recovery', async () => {
  const value = fixture();
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  value.disk.resolve(JSON.stringify(saved));
  await value.startup.ready();
  const connecting = value.startup.run(() =>
    connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      () => reply.promise,
      value.io,
    ),
  );
  await Promise.resolve();
  const newer = { positionSeconds: 12, durationSeconds: 120 };
  value.io.write({
    ...value.io.read(),
    progress: { [id]: newer },
    pending: { [id]: newer },
  });
  await value.startup.ready();
  reply.resolve(catalog);
  await connecting;
  assert.equal(value.reads(), 1);
  assert.equal(value.io.read().pending[id], newer);
  assert.equal(value.io.read().progress[id], newer);
  assert.deepEqual(value.writes.at(-1)?.pending[id], newer);
});

test('a failed startup read prevents writes and activation until an explicit retry recovers the base', async () => {
  let attempts = 0;
  let writes = 0;
  let current = fresh();
  const startup = new StartupHydration(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error('Synthetic read failure');
      return saved;
    },
    (value) => {
      current = value;
    },
  );
  await assert.rejects(
    startup.run(async () => {
      writes++;
    }),
    /read failure/,
  );
  assert.equal(writes, 0);
  assert.equal(current.catalog, null);
  await startup.run(async () => {
    writes++;
    assert.deepEqual(current.pending[id], progress);
  });
  assert.equal(attempts, 2);
  assert.equal(writes, 1);
  assert.equal(current.origin, origin);
});
