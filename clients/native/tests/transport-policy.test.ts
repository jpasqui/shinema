import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCatalog,
  serverOrigin,
  type ServerTransport,
} from '../../../packages/contracts/index.ts';
import { fresh, recover, type Stored } from '../src/domain.ts';
import {
  connectValidated,
  persistThenSync,
  resolveResume,
  SessionGuard,
  StorageQueue,
} from '../src/session.ts';
import {
  encryptedTransport,
  NativeTransportPolicy,
  selectionTransport,
} from '../src/transport.ts';

const first = 'http://192.168.50.10:8787';
const second = 'http://192.168.50.11:8787';
const id = 'b'.repeat(64);
const progress = { positionSeconds: 17, durationSeconds: 120 };
const catalog = {
  apiVersion: 1 as const,
  items: [
    {
      id,
      title: 'Generated transport-policy title',
      container: 'mp4',
      sizeBytes: 10,
      streamPath: `/api/media/${id}/stream`,
    },
  ],
};
const grant = (origin = first): ServerTransport => ({
  localHttpOrigin: origin,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stored(): Stored {
  return {
    ...fresh(),
    origin: first,
    localHttpOrigin: first,
    catalog,
    progress: { [id]: progress },
    pending: { [id]: progress },
  };
}

function fixture(initial = stored()) {
  let current = structuredClone(initial);
  let durable = JSON.stringify(initial);
  const stages: Stored[] = [];
  const writes: Stored[] = [];
  const queue = new StorageQueue();
  const io = {
    read: () => current,
    write: (value: Stored) => {
      current = value;
    },
    queue,
    stageDisk: async (value: Stored) => {
      stages.push(structuredClone(value));
    },
    writeDisk: async (value: Stored) => {
      writes.push(structuredClone(value));
      durable = JSON.stringify(value);
    },
    persist: (): Promise<void> => queue.run(() => io.writeDisk(current)),
  };
  return { io, stages, writes, disk: () => durable };
}

test('newer native revoke is invoked immediately while an older DNS promise remains pending', async () => {
  const dns = deferred<void>();
  const revocation = deferred<void>();
  const calls: (string | null)[] = [];
  const policy = new NativeTransportPolicy((origin) => {
    calls.push(origin);
    return origin === null ? revocation.promise : dns.promise;
  });
  const old = policy.activate(first, grant());
  const oldTicket = policy.version();
  const revoked = policy.revoke();
  assert.deepEqual(calls, [first, null]);
  assert.equal(policy.permits(first, grant()), false);
  revocation.resolve();
  assert.equal(await revoked, true);
  dns.resolve();
  assert.equal(await old, false);
  assert.equal(policy.current(oldTicket, first, grant()), false);
  assert.equal(policy.permits(first, grant()), false);
});

test('stale native grant fulfillment or rejection cannot clear or ready a newer selection', async () => {
  for (const settlement of ['resolve', 'reject']) {
    const oldDns = deferred<void>();
    const newDns = deferred<void>();
    let changes = 0;
    const policy = new NativeTransportPolicy(
      (origin) => (origin === first ? oldDns.promise : newDns.promise),
      () => changes++,
    );
    const old = policy.activate(first, grant());
    const oldTicket = policy.version();
    const newer = policy.activate(second, grant(second));
    newDns.resolve();
    assert.equal(await newer, true);
    const changesBeforeOld = changes;
    if (settlement === 'resolve') oldDns.resolve();
    else oldDns.reject(new Error('Synthetic obsolete DNS failure'));
    assert.equal(await old, false);
    assert.equal(changes, changesBeforeOld);
    assert.equal(policy.permits(second, grant(second)), true);
    assert.equal(policy.permits(first, grant()), false);
    assert.equal(policy.current(oldTicket, first, grant()), false);
  }
});

test('current DNS rejection leaves no ready grant and a later explicit retry can recover', async () => {
  let fail = true;
  const policy = new NativeTransportPolicy(async () => {
    if (fail) throw new Error('Synthetic public DNS answer');
  });
  await assert.rejects(policy.activate(first, grant()), /public DNS answer/);
  assert.equal(policy.permits(first, grant()), false);
  fail = false;
  assert.equal(await policy.activate(first, grant()), true);
  assert.equal(policy.permits(first, grant()), true);
});

test('A to revoked to A invalidates old native tickets even though the origin and consent match again', async () => {
  const calls: (string | null)[] = [];
  const policy = new NativeTransportPolicy(async (origin) => {
    calls.push(origin);
  });
  await policy.activate(first, grant());
  const oldTicket = policy.version();
  assert.equal(policy.current(oldTicket, first, grant()), true);
  await policy.revoke();
  await policy.activate(first, grant());
  assert.deepEqual(calls, [first, null, first]);
  assert.equal(policy.current(oldTicket, first, grant()), false);
  assert.equal(policy.current(policy.version(), first, grant()), true);
  assert.equal(policy.permits(first, encryptedTransport), false);
  assert.equal(policy.permits(first, grant(second)), false);
});

test('native policy snapshots caller consent and matching restore preserves its current generation', async () => {
  const dns = deferred<void>();
  const mutable = { localHttpOrigin: first };
  const calls: (string | null)[] = [];
  const policy = new NativeTransportPolicy((origin) => {
    calls.push(origin);
    return dns.promise;
  });
  const pending = policy.activate(first, mutable);
  mutable.localHttpOrigin = second;
  dns.resolve();
  assert.equal(await pending, true);
  assert.equal(policy.permits(first, grant()), true);
  assert.equal(policy.permits(first, mutable), false);
  const ticket = policy.version();
  assert.equal(await policy.restore(first, grant()), true);
  assert.equal(policy.version(), ticket);
  assert.deepEqual(calls, [first]);
  const selection = selectionTransport({
    origin: first,
    localHttpOrigin: first,
  });
  assert.equal(Object.isFrozen(selection), true);
  assert.deepEqual(
    selectionTransport({
      origin: 'https://example.test',
      localHttpOrigin: first,
    }),
    encryptedTransport,
  );
});

test('recovery restores only a matching canonical HTTP grant while retaining other HTTP caches offline', () => {
  const value = stored();
  const matching = recover(JSON.stringify(value));
  assert.equal(matching.localHttpOrigin, first);
  assert.equal(
    serverOrigin(matching.origin, selectionTransport(matching)),
    first,
  );
  for (const localHttpOrigin of [
    undefined,
    null,
    second,
    `${first}/`,
    'http://192.168.50.10:80',
    'HTTP://192.168.50.10:8787',
  ]) {
    const offline = recover(JSON.stringify({ ...value, localHttpOrigin }));
    assert.equal(offline.origin, first);
    assert.equal(offline.localHttpOrigin, null);
    assert.deepEqual(offline.catalog, parseCatalog(catalog));
    assert.deepEqual(offline.progress, value.progress);
    assert.deepEqual(offline.pending, value.pending);
    assert.throws(() => selectionTransport(offline));
    assert.throws(() =>
      serverOrigin(offline.origin, {
        localHttpOrigin: offline.localHttpOrigin ?? null,
      }),
    );
  }
  const secure = recover(
    JSON.stringify({
      ...value,
      origin: 'https://example.test',
      localHttpOrigin: first,
    }),
  );
  assert.equal(secure.localHttpOrigin, null);
  assert.equal(serverOrigin(secure.origin), 'https://example.test');
});

test('session stamps copy HTTP consent and transport invalidation fences pending saves and resumes', async () => {
  const guard = new SessionGuard();
  const mutable = { localHttpOrigin: first };
  const destination = guard.confirm(first, mutable);
  const ticket = guard.beginPlayback(first, mutable);
  mutable.localHttpOrigin = second;
  assert.equal(destination.localHttpOrigin, first);
  assert.equal(ticket.localHttpOrigin, first);
  assert.equal(Object.isFrozen(destination), true);
  assert.equal(Object.isFrozen(ticket), true);
  const disk = deferred<void>();
  const resume = deferred<unknown>();
  const saved = { ...stored(), pending: {} };
  const sent: string[] = [];
  const saving = persistThenSync(
    guard,
    destination,
    () => disk.promise,
    () => first,
    async (stamp) => {
      sent.push(stamp.origin);
    },
  );
  const opening = resolveResume(
    guard,
    ticket,
    id,
    () => saved,
    () => resume.promise,
  );
  const attempt = guard.beginConnection();
  guard.invalidateTransport();
  assert.equal(guard.currentAttempt(attempt), false);
  assert.equal(guard.current(destination, first), false);
  assert.equal(guard.currentPlayback(ticket, first), false);
  disk.resolve();
  resume.resolve(progress);
  assert.equal(await saving, false);
  assert.equal(await opening, null);
  assert.deepEqual(sent, []);
  guard.confirm(first, grant());
  assert.equal(guard.current(destination, first), false);
  assert.equal(guard.currentPlayback(ticket, first), false);
});

test('same-origin consent activation increments session generation without erasing cached progress', async () => {
  const value = fixture({ ...stored(), localHttpOrigin: null });
  const guard = new SessionGuard();
  const before = guard.capture(first, grant());
  const accepted = await connectValidated(
    guard,
    guard.beginConnection(),
    first,
    async () => catalog,
    value.io,
    undefined,
    grant(),
  );
  assert.equal(accepted?.switched, false);
  assert.ok(accepted);
  assert.ok(accepted.stamp.generation > before.generation);
  assert.equal(accepted.stamp.localHttpOrigin, first);
  assert.equal(guard.current(before, first), false);
  assert.equal(value.io.read().localHttpOrigin, first);
  assert.deepEqual(value.io.read().pending[id], progress);
  assert.deepEqual(recover(value.disk()).pending[id], progress);
  const same = await connectValidated(
    guard,
    guard.beginConnection(),
    first,
    async () => catalog,
    value.io,
    undefined,
    grant(),
  );
  assert.equal(same?.stamp.generation, accepted.stamp.generation);
  guard.invalidateTransport();
  assert.equal(guard.current(accepted.stamp, first), false);
  assert.equal(value.io.read().origin, first);
});

test('connectValidated snapshots mutable consent before asynchronous catalogue and disk work', async () => {
  const value = fixture();
  const guard = new SessionGuard();
  const mutable = { localHttpOrigin: second };
  const response = deferred<unknown>();
  const connecting = connectValidated(
    guard,
    guard.beginConnection(),
    second,
    () => response.promise,
    value.io,
    undefined,
    mutable,
  );
  mutable.localHttpOrigin = first;
  response.resolve(catalog);
  const result = await connecting;
  assert.equal(result?.stamp.origin, second);
  assert.equal(result?.stamp.localHttpOrigin, second);
  assert.equal(value.io.read().origin, second);
  assert.equal(value.io.read().localHttpOrigin, second);
  assert.equal(recover(value.disk()).localHttpOrigin, second);
});

// This caller deliberately restores the latest confirmed store in finally.
// It models the coordinator boundary; it does not assert App wiring by proxy.
async function candidate(
  policy: NativeTransportPolicy,
  guard: SessionGuard,
  value: ReturnType<typeof fixture>,
  load: () => Promise<unknown>,
) {
  try {
    if (!(await policy.activate(second, grant(second)))) return null;
    return await connectValidated(
      guard,
      guard.beginConnection(),
      second,
      load,
      value.io,
      undefined,
      grant(second),
    );
  } finally {
    const confirmed = value.io.read();
    await policy.restore(confirmed.origin, selectionTransport(confirmed));
  }
}

test('failed or malformed B restores persisted A consent without publishing or discarding its queue', async () => {
  for (const failure of ['dns', 'load', 'catalog', 'commit']) {
    const value = fixture();
    const before = value.disk();
    const calls: (string | null)[] = [];
    const policy = new NativeTransportPolicy(async (origin) => {
      calls.push(origin);
      if (failure === 'dns' && origin === second)
        throw new Error('Synthetic candidate DNS rejection');
    });
    await policy.activate(first, grant());
    if (failure === 'commit')
      value.io.writeDisk = async () => {
        throw new Error('Synthetic atomic write rejection');
      };
    await assert.rejects(
      candidate(policy, new SessionGuard(), value, async () => {
        if (failure === 'load') throw new Error('Synthetic offline candidate');
        return failure === 'catalog' ? { apiVersion: 99, items: [] } : catalog;
      }),
    );
    assert.equal(value.disk(), before);
    assert.deepEqual(value.io.read(), stored());
    assert.equal(policy.permits(first, grant()), true);
    assert.equal(policy.permits(second, grant(second)), false);
    assert.deepEqual(calls, [first, second, first]);
  }
});

test('canceling B during native DNS cannot validate B or resurrect it after restoring A', async () => {
  const value = fixture();
  const before = value.disk();
  const dns = deferred<void>();
  const calls: (string | null)[] = [];
  const policy = new NativeTransportPolicy((origin) => {
    calls.push(origin);
    return origin === second ? dns.promise : Promise.resolve();
  });
  await policy.activate(first, grant());
  const guard = new SessionGuard();
  let loads = 0;
  const connecting = candidate(policy, guard, value, async () => {
    loads++;
    return catalog;
  });
  assert.deepEqual(calls, [first, second]);
  guard.invalidateTransport();
  await policy.revoke();
  assert.deepEqual(calls, [first, second, null]);
  dns.resolve();
  assert.equal(await connecting, null);
  assert.equal(loads, 0);
  assert.equal(value.disk(), before);
  assert.deepEqual(value.io.read(), stored());
  assert.equal(policy.permits(first, grant()), true);
  assert.equal(policy.permits(second, grant(second)), false);
  assert.deepEqual(calls, [first, second, null, first]);
});

test('canceling staged B preserves durable A and restores only A after native revocation', async () => {
  const value = fixture();
  const before = value.disk();
  const staged = deferred<void>();
  const release = deferred<void>();
  const normalStage = value.io.stageDisk;
  value.io.stageDisk = async (next) => {
    await normalStage(next);
    staged.resolve();
    await release.promise;
  };
  const calls: (string | null)[] = [];
  const policy = new NativeTransportPolicy(async (origin) => {
    calls.push(origin);
  });
  await policy.activate(first, grant());
  const guard = new SessionGuard();
  const connecting = candidate(policy, guard, value, async () => catalog);
  await staged.promise;
  guard.invalidateTransport();
  await policy.revoke();
  release.resolve();
  assert.equal(await connecting, null);
  assert.equal(value.writes.length, 0);
  assert.equal(value.disk(), before);
  assert.deepEqual(value.io.read(), stored());
  assert.equal(value.stages[0].localHttpOrigin, second);
  assert.equal(policy.permits(first, grant()), true);
  assert.deepEqual(calls, [first, second, null, first]);
});

test('canceling irreversible B commit confirms B and the caller restores latest B rather than captured A', async () => {
  const value = fixture();
  const committing = deferred<void>();
  const release = deferred<void>();
  const normalWrite = value.io.writeDisk;
  value.io.writeDisk = async (next) => {
    committing.resolve();
    await release.promise;
    await normalWrite(next);
  };
  const calls: (string | null)[] = [];
  const policy = new NativeTransportPolicy(async (origin) => {
    calls.push(origin);
  });
  await policy.activate(first, grant());
  const guard = new SessionGuard();
  const old = guard.confirm(first, grant());
  const connecting = candidate(policy, guard, value, async () => catalog);
  await committing.promise;
  assert.equal(guard.isSwitchCommitting(), true);
  assert.throws(() => guard.beginPlayback(first, grant()), /commit/);
  guard.invalidateTransport();
  await policy.revoke();
  assert.equal(value.io.read().origin, first);
  assert.equal(recover(value.disk()).origin, first);
  release.resolve();
  assert.equal(await connecting, null);
  assert.equal(guard.isSwitchCommitting(), false);
  assert.equal(value.io.read().origin, second);
  assert.equal(value.io.read().localHttpOrigin, second);
  assert.equal(recover(value.disk()).origin, second);
  assert.equal(recover(value.disk()).localHttpOrigin, second);
  assert.deepEqual(value.io.read().pending, {});
  assert.equal(guard.current(old, first), false);
  assert.equal(policy.permits(second, grant(second)), true);
  assert.equal(policy.permits(first, grant()), false);
  assert.deepEqual(calls, [first, second, null, second]);
});
