import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Progress } from '../../../packages/contracts/index.ts';
import { fresh, recover } from '../src/domain.ts';
import type { Stored } from '../src/domain.ts';
import {
  ProgressQueue,
  SessionGuard,
  StorageQueue,
  persistThenSync,
  resolveResume,
  syncProgress,
} from '../src/session.ts';

const first = 'https://first.example';
const second = 'https://second.example';
const id = 'a'.repeat(64);
const progressAt = (positionSeconds: number): Progress => ({
  positionSeconds,
  durationSeconds: 60,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(restored?: Stored) {
  let current: Stored = restored ?? {
    ...fresh(),
    origin: first,
    progress: { [id]: progressAt(12) },
  };
  let disk = JSON.stringify(current);
  let diskError: Error | null = null;
  let beforeWrite: (() => Promise<void>) | null = null;
  const storage = new StorageQueue();
  const io = {
    read: () => current,
    write: (next: Stored) => {
      current = next;
    },
    // Match App.persist: sample state when its serialized write executes.
    persist: () =>
      storage.run(async () => {
        const before = beforeWrite;
        beforeWrite = null;
        if (before) await before();
        if (diskError) throw diskError;
        disk = JSON.stringify(current);
      }),
  };
  function stage(value: Progress) {
    io.write({
      ...current,
      progress: { ...current.progress, [id]: value },
      pending: { ...current.pending, [id]: value },
    });
  }
  async function save(value: Progress) {
    // App.save creates one new immutable object for each save, even after a
    // seek returns to the exact position of an older in-flight request.
    stage(value);
    await io.persist();
    return value;
  }
  return {
    io,
    stage,
    save,
    reopen: () => recover(disk),
    beforeNextWrite: (hook: () => Promise<void>) => {
      beforeWrite = hook;
    },
    rejectWrites: (error: Error | null) => {
      diskError = error;
    },
  };
}

for (const outcome of ['success', 'rejection', 'malformed'] as const) {
  test(`resume rechecks newer pending progress after a delayed GET ${outcome}`, async () => {
    const { io, save, reopen } = fixture();
    const guard = new SessionGuard();
    const reply = deferred<unknown>();
    const requests: string[] = [];
    const opening = resolveResume(
      guard,
      guard.beginPlayback(first),
      id,
      io.read,
      (origin) => {
        requests.push(origin);
        return reply.promise;
      },
    );
    const newest = await save(progressAt(35));
    if (outcome === 'success') reply.resolve(progressAt(4));
    else if (outcome === 'malformed')
      reply.resolve({ positionSeconds: 70, durationSeconds: 60 });
    else reply.reject(new Error('connection lost'));

    assert.deepEqual(await opening, { progress: newest, local: true });
    assert.deepEqual(requests, [first]);
    assert.strictEqual(io.read().pending[id], newest);
    assert.deepEqual(reopen().pending[id], newest);
  });
}

for (const position of [35, 12]) {
  test(`resume keeps a local ${position}s save acknowledged before an older GET completes`, async () => {
    const { io, save, reopen } = fixture();
    const initial = io.read().progress[id];
    const guard = new SessionGuard();
    const reply = deferred<unknown>();
    const opening = resolveResume(
      guard,
      guard.beginPlayback(first),
      id,
      io.read,
      () => reply.promise,
    );
    const newest = await save(progressAt(position));
    assert.notStrictEqual(newest, initial);
    await syncProgress(
      guard,
      guard.capture(first),
      id,
      newest,
      io,
      async () => {},
    );
    assert.equal(io.read().pending[id], undefined);
    assert.equal(reopen().pending[id], undefined);
    reply.resolve(progressAt(4));

    assert.deepEqual(await opening, { progress: newest, local: true });
    assert.deepEqual(reopen().progress[id], newest);
  });
}

test('an unrelated title save leaves the selected title eligible for its remote resume value', async () => {
  const { io, reopen } = fixture();
  const initial = io.read().progress[id];
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  const opening = resolveResume(
    guard,
    guard.beginPlayback(first),
    id,
    io.read,
    () => reply.promise,
  );
  const otherId = 'b'.repeat(64);
  const otherProgress = progressAt(22);
  io.write({
    ...io.read(),
    progress: { ...io.read().progress, [otherId]: otherProgress },
    pending: { ...io.read().pending, [otherId]: otherProgress },
  });
  await io.persist();
  assert.strictEqual(io.read().progress[id], initial);
  const remote = progressAt(35);
  reply.resolve(remote);
  assert.deepEqual(await opening, { progress: remote, local: false });
  assert.deepEqual(reopen().pending[otherId], otherProgress);
  assert.deepEqual(reopen().progress[id], initial);
});

test('a held 12s acknowledgement preserves a newer 12s save after seeking to 22s and back', async () => {
  const { io, save, reopen } = fixture();
  const guard = new SessionGuard();
  const queue = new ProgressQueue();
  const firstAck = deferred<void>();
  const firstSent = deferred<void>();
  const newestAck = deferred<void>();
  const newestSent = deferred<void>();
  const sent: Progress[] = [];
  const original = await save(progressAt(12));
  const old = queue.enqueue(() =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      original,
      io,
      async (_origin, _id, value) => {
        sent.push(value);
        firstSent.resolve();
        await firstAck.promise;
      },
    ),
  );
  await firstSent.promise;
  const middle = await save(progressAt(22));
  const superseded = queue.enqueue(() =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      middle,
      io,
      async (_origin, _id, value) => {
        sent.push(value);
      },
    ),
  );
  const newest = await save(progressAt(12));
  assert.notStrictEqual(newest, original);
  const next = queue.enqueue(() =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      newest,
      io,
      async (_origin, _id, value) => {
        sent.push(value);
        newestSent.resolve();
        await newestAck.promise;
      },
    ),
  );
  firstAck.resolve();
  await old;
  try {
    // Assert before waiting for the latest send: a bad stale ACK followed by
    // the correct pre-send guard would otherwise skip it and leave that wait
    // unresolved instead of identifying the destructive acknowledgement.
    assert.strictEqual(io.read().pending[id], newest);
    assert.deepEqual(reopen().pending[id], newest);
    await superseded;
    await newestSent.promise;
    assert.strictEqual(io.read().pending[id], newest);
    assert.deepEqual(reopen().pending[id], newest);
    assert.deepEqual(sent, [original, newest]);
  } finally {
    newestAck.resolve();
    await Promise.all([superseded, next]);
  }
  assert.equal(io.read().pending[id], undefined);
  assert.equal(reopen().pending[id], undefined);
  assert.deepEqual(reopen().progress[id], newest);
});

test('a queued save superseded before its send cannot overwrite the latest server progress', async () => {
  const { io, save, reopen } = fixture();
  const guard = new SessionGuard();
  const queue = new ProgressQueue();
  const release = deferred<void>();
  const blocker = queue.enqueue(() => release.promise);
  const sent: Progress[] = [];
  const original = await save(progressAt(12));
  const old = queue.enqueue(() =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      original,
      io,
      async (_origin, _id, value) => {
        sent.push(value);
      },
    ),
  );
  const newest = await save(progressAt(35));
  const next = queue.enqueue(() =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      newest,
      io,
      async (_origin, _id, value) => {
        sent.push(value);
      },
    ),
  );
  release.resolve();
  await Promise.all([blocker, old, next]);
  assert.deepEqual(sent, [newest]);
  assert.equal(io.read().pending[id], undefined);
  assert.equal(reopen().pending[id], undefined);
});

test('a rejected old PUT retains the newest equal-position save and the queue retries it', async () => {
  const { io, save, reopen } = fixture();
  const guard = new SessionGuard();
  const queue = new ProgressQueue();
  const oldReply = deferred<void>();
  const oldSent = deferred<void>();
  const newestReply = deferred<void>();
  const newestSent = deferred<void>();
  const original = await save(progressAt(12));
  const old = queue.enqueue(() =>
    syncProgress(guard, guard.capture(first), id, original, io, async () => {
      oldSent.resolve();
      await oldReply.promise;
    }),
  );
  const rejected = assert.rejects(old, /offline/);
  await oldSent.promise;
  const newest = await save(progressAt(12));
  const next = queue.enqueue(() =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      newest,
      io,
      async (_origin, _id, value) => {
        assert.strictEqual(value, newest);
        newestSent.resolve();
        await newestReply.promise;
      },
    ),
  );
  oldReply.reject(new Error('offline'));
  await rejected;
  await newestSent.promise;
  try {
    assert.strictEqual(io.read().pending[id], newest);
    assert.deepEqual(reopen().pending[id], newest);
  } finally {
    newestReply.resolve();
    await next;
  }
  assert.equal(io.read().pending[id], undefined);
  assert.equal(reopen().pending[id], undefined);
});

test('pending values recovered from JSON can be resumed and acknowledged without shared progress identity', async () => {
  const value = progressAt(35);
  const restored = recover(
    JSON.stringify({
      ...fresh(),
      origin: first,
      progress: { [id]: value },
      pending: { [id]: value },
    }),
  );
  assert.notStrictEqual(restored.progress[id], restored.pending[id]);
  const { io, reopen } = fixture(restored);
  const guard = new SessionGuard();
  let loads = 0;
  assert.deepEqual(
    await resolveResume(
      guard,
      guard.beginPlayback(first),
      id,
      io.read,
      async () => {
        ++loads;
        throw new Error('offline');
      },
    ),
    { progress: value, local: true },
  );
  assert.equal(loads, 0);
  const pending = io.read().pending[id];
  const sent: Progress[] = [];
  await syncProgress(
    guard,
    guard.capture(first),
    id,
    pending,
    io,
    async (_origin, _id, progress) => {
      sent.push(progress);
    },
  );
  assert.deepEqual(sent, [value]);
  assert.equal(io.read().pending[id], undefined);
  assert.equal(reopen().pending[id], undefined);
  assert.deepEqual(reopen().progress[id], value);
});

test('new local progress cannot revive a canceled resume request', async () => {
  const { io, save } = fixture();
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  const opening = resolveResume(
    guard,
    guard.beginPlayback(first),
    id,
    io.read,
    () => reply.promise,
  );
  const newest = await save(progressAt(35));
  guard.invalidatePlayback();
  reply.resolve(progressAt(4));
  assert.equal(await opening, null);
  assert.deepEqual(
    await resolveResume(
      guard,
      guard.beginPlayback(first),
      id,
      io.read,
      async () => {
        assert.fail('a fresh play should use the pending local save');
      },
    ),
    { progress: newest, local: true },
  );
});

test('an ACK from before switching away and back cannot clear a new same-origin save', async () => {
  const { io, save, reopen } = fixture();
  const guard = new SessionGuard();
  const original = await save(progressAt(12));
  const reply = deferred<void>();
  const sent = deferred<void>();
  const saving = syncProgress(
    guard,
    guard.capture(first),
    id,
    original,
    io,
    async () => {
      sent.resolve();
      await reply.promise;
    },
  );
  await sent.promise;
  guard.confirm(second);
  io.write({ ...fresh(), origin: second });
  guard.confirm(first);
  io.write({ ...fresh(), origin: first });
  const newest = await save(progressAt(12));
  reply.resolve();
  await saving;
  assert.strictEqual(io.read().pending[id], newest);
  assert.deepEqual(reopen().pending[id], newest);
  await syncProgress(
    guard,
    guard.capture(first),
    id,
    newest,
    io,
    async () => {},
  );
  assert.equal(reopen().pending[id], undefined);
});

test('a failed device save sends nothing and its latest value survives a later persistence retry', async () => {
  const { io, stage, save, reopen, rejectWrites } = fixture();
  const guard = new SessionGuard();
  const previous = await save(progressAt(12));
  const newest = progressAt(35);
  stage(newest);
  rejectWrites(new Error('device storage unavailable'));
  const sent: Progress[] = [];
  const sync = () =>
    syncProgress(
      guard,
      guard.capture(first),
      id,
      newest,
      io,
      async (_origin, _id, value) => {
        sent.push(value);
      },
    );
  await assert.rejects(
    persistThenSync(
      guard,
      guard.capture(first),
      io.persist,
      () => io.read().origin,
      sync,
    ),
    /device storage unavailable/,
  );
  assert.deepEqual(sent, []);
  assert.strictEqual(io.read().pending[id], newest);
  assert.deepEqual(reopen().pending[id], previous);
  rejectWrites(null);
  assert.equal(
    await persistThenSync(
      guard,
      guard.capture(first),
      io.persist,
      () => io.read().origin,
      sync,
    ),
    true,
  );
  assert.deepEqual(sent, [newest]);
  assert.equal(reopen().pending[id], undefined);
  assert.deepEqual(reopen().progress[id], newest);
});

test('failed ACK cleanup cannot roll back an equal-position save staged during its disk write', async () => {
  const { io, save, stage, reopen, beforeNextWrite } = fixture();
  const guard = new SessionGuard();
  const original = await save(progressAt(12));
  const cleanupBegan = deferred<void>();
  const cleanupReply = deferred<void>();
  beforeNextWrite(async () => {
    cleanupBegan.resolve();
    await cleanupReply.promise;
  });
  const cleaning = syncProgress(
    guard,
    guard.capture(first),
    id,
    original,
    io,
    async () => {},
  );
  const rejected = assert.rejects(cleaning, /cleanup write failed/);
  await cleanupBegan.promise;
  assert.equal(io.read().pending[id], undefined);
  const newest = progressAt(12);
  stage(newest);
  const persisted = io.persist();
  cleanupReply.reject(new Error('cleanup write failed'));
  await rejected;
  await persisted;
  assert.strictEqual(io.read().pending[id], newest);
  assert.strictEqual(io.read().progress[id], newest);
  assert.deepEqual(reopen().pending[id], newest);
  assert.deepEqual(reopen().progress[id], newest);
  await syncProgress(
    guard,
    guard.capture(first),
    id,
    newest,
    io,
    async () => {},
  );
  assert.equal(reopen().pending[id], undefined);
  assert.deepEqual(reopen().progress[id], newest);
});
