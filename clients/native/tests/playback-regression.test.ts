import test from 'node:test';
import assert from 'node:assert/strict';
import type { Progress } from '../../../packages/contracts/index.ts';
import { fresh } from '../src/domain.ts';
import type { Stored } from '../src/domain.ts';
import {
  ProgressQueue,
  resolveResume,
  SessionGuard,
  syncProgress,
} from '../src/session.ts';

const origin = 'https://playback.example';
const id = 'a'.repeat(64);
const otherId = 'b'.repeat(64);
const saved: Progress = { positionSeconds: 125.5, durationSeconds: 600 };

function fixture(progress: Record<string, Progress> = { [id]: saved }) {
  let stored: Stored = { ...fresh(), origin, progress };
  const persisted: Stored[] = [];
  const io = {
    read: () => stored,
    write: (next: Stored) => {
      stored = next;
    },
    persist: async () => {
      persisted.push(structuredClone(stored));
    },
  };
  return { io, persisted };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('native queued resume, including a seek back to zero, bypasses the unavailable server', async () => {
  for (const positionSeconds of [0, 125.5]) {
    const progress = { positionSeconds, durationSeconds: 600 };
    const { io } = fixture({ [id]: progress });
    io.write({ ...io.read(), pending: { [id]: progress } });
    const before = structuredClone(io.read());
    const guard = new SessionGuard();
    let requests = 0;
    const result = await resolveResume(
      guard,
      guard.beginPlayback(origin),
      id,
      io.read,
      async () => {
        requests++;
        throw new Error('Synthetic disconnected server');
      },
    );
    assert.deepEqual(result, { progress, local: true });
    assert.equal(requests, 0, 'pending progress must avoid a resume GET');
    assert.deepEqual(
      io.read(),
      before,
      'opening playback must not consume pending progress',
    );
  }
});

test('native resume requests the captured origin and selected title without borrowing another title pending value', async () => {
  const other = { positionSeconds: 15, durationSeconds: 90 };
  const remote = { positionSeconds: 250.25, durationSeconds: 600 };
  const { io } = fixture({ [id]: saved, [otherId]: other });
  io.write({ ...io.read(), pending: { [otherId]: other } });
  const before = structuredClone(io.read());
  const guard = new SessionGuard();
  const requests: Array<[string, string]> = [];
  const result = await resolveResume(
    guard,
    guard.beginPlayback(origin),
    id,
    io.read,
    async (destination, key) => {
      requests.push([destination, key]);
      return remote;
    },
  );
  assert.deepEqual(requests, [[origin, id]]);
  assert.deepEqual(result, { progress: remote, local: false });
  assert.deepEqual(io.read(), before);
});

test('native disconnected resume falls back to the cached title or a clean start without changing cache', async () => {
  for (const progress of [{ [id]: saved }, {}]) {
    const { io } = fixture(progress);
    const before = structuredClone(io.read());
    const guard = new SessionGuard();
    const result = await resolveResume(
      guard,
      guard.beginPlayback(origin),
      id,
      io.read,
      async () => {
        throw new Error('Synthetic stream connection lost');
      },
    );
    assert.deepEqual(result, { progress: progress[id] ?? null, local: true });
    assert.deepEqual(io.read(), before);
  }
});

test('native malformed remote resume cannot replace validated cached progress', async (context) => {
  const invalid: Array<[string, unknown]> = [
    ['missing duration', { positionSeconds: 10 }],
    ['numeric string', { positionSeconds: '10', durationSeconds: 600 }],
    ['negative position', { positionSeconds: -1, durationSeconds: 600 }],
    ['past the end', { positionSeconds: 601, durationSeconds: 600 }],
    ['zero duration', { positionSeconds: 0, durationSeconds: 0 }],
    ['non-finite position', { positionSeconds: NaN, durationSeconds: 600 }],
    ['non-finite duration', { positionSeconds: 10, durationSeconds: Infinity }],
    [
      'over contract duration',
      { positionSeconds: 10, durationSeconds: 604801 },
    ],
  ];
  for (const [name, payload] of invalid) {
    await context.test(name, async () => {
      const { io } = fixture();
      const before = structuredClone(io.read());
      const guard = new SessionGuard();
      const result = await resolveResume(
        guard,
        guard.beginPlayback(origin),
        id,
        io.read,
        async () => payload,
      );
      assert.deepEqual(result, { progress: saved, local: true });
      assert.deepEqual(io.read(), before);
    });
  }
});

test('native title with no cached or remote progress starts without an offline warning', async () => {
  const { io } = fixture({});
  const guard = new SessionGuard();
  const result = await resolveResume(
    guard,
    guard.beginPlayback(origin),
    id,
    io.read,
    async () => null,
  );
  assert.deepEqual(result, { progress: null, local: false });
});

test('a disconnected resume request that completes after Back remains canceled', async () => {
  const { io } = fixture();
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  const opening = resolveResume(
    guard,
    guard.beginPlayback(origin),
    id,
    io.read,
    () => reply.promise,
  );
  guard.invalidatePlayback();
  reply.reject(new Error('Synthetic timeout after leaving details'));
  assert.equal(await opening, null);
  assert.deepEqual(io.read().progress[id], saved);
});

test('native progress queue retains a disconnected write and retries it without blocking subsequent titles', async () => {
  const other = { positionSeconds: 35, durationSeconds: 90 };
  const { io, persisted } = fixture({ [id]: saved, [otherId]: other });
  io.write({ ...io.read(), pending: { [id]: saved, [otherId]: other } });
  const guard = new SessionGuard();
  const destination = guard.capture(origin);
  const queue = new ProgressQueue();
  const sent: Array<{ origin: string; id: string; value: Progress }> = [];
  const send = async (target: string, key: string, value: Progress) => {
    sent.push({ origin: target, id: key, value });
    if (sent.length === 1) throw new Error('Synthetic disconnected stream');
  };
  await assert.rejects(
    queue.enqueue(() => syncProgress(guard, destination, id, saved, io, send)),
    /Synthetic disconnected stream/,
  );
  assert.deepEqual(io.read().pending, { [id]: saved, [otherId]: other });
  assert.equal(
    persisted.length,
    0,
    'failed upload must not acknowledge pending progress',
  );

  await queue.enqueue(() =>
    syncProgress(guard, destination, otherId, other, io, send),
  );
  assert.deepEqual(io.read().pending, { [id]: saved });
  await queue.enqueue(() =>
    syncProgress(guard, destination, id, saved, io, send),
  );
  assert.deepEqual(sent, [
    { origin, id, value: saved },
    { origin, id: otherId, value: other },
    { origin, id, value: saved },
  ]);
  assert.deepEqual(io.read().pending, {});
  assert.deepEqual(io.read().progress, { [id]: saved, [otherId]: other });
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted[0].pending, { [id]: saved });
  assert.deepEqual(persisted[1].pending, {});
});

test('native acknowledgement with an obsolete duration cannot discard the newer resume value', async () => {
  const { io, persisted } = fixture();
  io.write({ ...io.read(), pending: { [id]: saved } });
  const guard = new SessionGuard();
  const reply = deferred<void>();
  const started = deferred<void>();
  const syncing = syncProgress(
    guard,
    guard.capture(origin),
    id,
    saved,
    io,
    async () => {
      started.resolve();
      await reply.promise;
    },
  );
  await started.promise;
  const newer = { ...saved, durationSeconds: 720 };
  io.write({
    ...io.read(),
    progress: { [id]: newer },
    pending: { [id]: newer },
  });
  reply.resolve();
  await syncing;
  assert.deepEqual(io.read().pending[id], newer);
  assert.deepEqual(io.read().progress[id], newer);
  assert.deepEqual(persisted, []);
});
