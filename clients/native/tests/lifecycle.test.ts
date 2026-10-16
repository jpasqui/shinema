import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeActivity } from '../src/lifecycle.ts';
import { loadLibrarySnapshot } from '../src/libraries.ts';
import { SessionGuard } from '../src/session.ts';
import { NativeFeed } from '../src/feed.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('late startup disk data cannot replace user-selected route, address, library or appearance', async () => {
  for (const action of [
    'address',
    'library',
    'appearance',
    'remote',
    'connect',
  ]) {
    const activity = new NativeActivity();
    const startup = activity.capture();
    const disk = deferred<string>();
    let displayed = 'fresh';
    const loading = disk.promise.then((value) => {
      if (activity.current(startup)) displayed = value;
    });
    if (action === 'connect') activity.beginConnection();
    else activity.interact();
    displayed = action;
    disk.resolve('old disk cache');
    await loading;
    assert.equal(displayed, action);
  }
  const activity = new NativeActivity();
  assert.equal(activity.current(activity.capture()), true);
});

test('connection replacement and cancellation abort HTTP while logical session tickets reject late results', async () => {
  const activity = new NativeActivity();
  const guard = new SessionGuard();
  const first = activity.beginConnection();
  const attempt = guard.beginConnection();
  const reply = deferred<string>();
  const pending = activity.read(first, () => reply.promise);
  const rejected = assert.rejects(pending, /Canceled/);
  const second = activity.beginConnection();
  guard.cancelConnection();
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  assert.equal(guard.currentAttempt(attempt), false);
  // A stale finally block cannot release a newer connection's controller.
  activity.finishConnection(first);
  activity.cancelConnection();
  assert.equal(second.aborted, true);
  reply.resolve('ignored-abort transport response');
  await rejected;
});

test('a canceled descriptor request cannot chain into a catalogue request even if transport ignores abort', async () => {
  const activity = new NativeActivity();
  const signal = activity.beginConnection();
  const reply = deferred<unknown>();
  const paths: string[] = [];
  const loading = loadLibrarySnapshot(
    'https://synthetic.example',
    null,
    null,
    (_origin, path) =>
      activity.read(signal, () => {
        paths.push(path);
        return reply.promise;
      }),
    48,
  );
  const rejected = assert.rejects(loading, /Canceled/);
  activity.cancelConnection();
  reply.resolve({
    version: 1,
    revision: 1,
    libraries: [
      {
        id: 'cinema',
        name: 'Cinema',
        mediaType: 'movies',
        visible: true,
        order: 0,
      },
    ],
  });
  await rejected;
  assert.deepEqual(paths, ['/api/libraries']);
  let started = false;
  await assert.rejects(
    activity.read(signal, async () => {
      started = true;
      return null;
    }),
    /Canceled/,
  );
  assert.equal(started, false);
});

test('manual placeholder retry cannot restart paused feed HTTP while the connection owns requests', async () => {
  const activity = new NativeActivity();
  const feed = new NativeFeed({
    origin: 'https://synthetic.example',
    libraryId: null,
    collection: 'all',
  });
  let requests = 0;
  // The same owner guard is used by App for automatic, touch and remote retries.
  const retry = async (index: number) => {
    if (activity.connecting()) return;
    return feed.load(
      index,
      async () => {
        requests++;
        throw new Error('synthetic offline');
      },
      0,
      true,
    );
  };
  const connection = activity.beginConnection();
  await Promise.all([retry(0), retry(48), retry(0)]);
  assert.equal(requests, 0);
  assert.deepEqual(feed.snapshot().pending, []);
  activity.finishConnection(connection);
  await retry(0);
  assert.equal(requests, 1);
  const next = activity.beginConnection();
  activity.finishConnection(connection);
  assert.equal(activity.connecting(), true);
  activity.finishConnection(next);
  assert.equal(activity.connecting(), false);
});
