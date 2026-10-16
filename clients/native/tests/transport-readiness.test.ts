import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NativeTransportPolicy,
  readyTransport,
  restoreSelection,
} from '../src/transport.ts';
import { NativeFeed } from '../src/feed.ts';
import { fresh } from '../src/domain.ts';

test('revoked or unconsented saved HTTP cannot enter background feed work and retains its multi-page inventory offline', async () => {
  const origin = 'http://127.0.0.1:8787';
  const selected = { ...fresh(), origin, localHttpOrigin: origin };
  const policy = new NativeTransportPolicy(async () => {});
  await policy.activate(origin, { localHttpOrigin: origin });
  const scope = {
    origin,
    localHttpOrigin: origin,
    libraryId: null,
    collection: 'all' as const,
  };
  const feed = new NativeFeed(scope);
  const items = Array.from({ length: 60 }, (_, index) => {
    const id = index.toString(16).padStart(64, '0');
    return {
      id,
      title: `Generated ${index}`,
      container: 'mp4',
      sizeBytes: 1000,
      streamPath: `/api/media/${id}/stream`,
    };
  });
  feed.reset(scope, {
    apiVersion: 1,
    fullLibrary: true,
    total: 180,
    offset: 0,
    limit: 60,
    items,
    nextOffset: 60,
  });
  assert.ok(readyTransport(policy, selected));
  await policy.revoke();
  const offline = { ...selected, localHttpOrigin: null };
  let calls = 0;
  const context = readyTransport(policy, offline);
  // This is the same exported gate called before App starts any feed request.
  if (context)
    await feed.load(120, async () => {
      calls++;
      throw new Error('Must stay offline');
    });
  assert.equal(context, null);
  assert.equal(calls, 0);
  assert.equal(feed.itemAt(0)?.id, items[0].id);
  assert.equal(feed.snapshot().total, 180);
  await policy.activate(origin, { localHttpOrigin: origin });
  assert.equal(readyTransport(policy, offline), null);
  assert.ok(readyTransport(policy, selected));
  assert.equal(
    readyTransport(policy, { ...selected, origin: 'http://127.0.0.1:9999' }),
    null,
  );
});

test('a failed restoration catch cannot revoke B activated in the adjacent microtask', async () => {
  const a = 'http://127.0.0.1:8787';
  const b = 'http://127.0.0.1:9999';
  const calls: Array<string | null> = [];
  let rejectA!: (reason: Error) => void;
  const policy = new NativeTransportPolicy((origin) => {
    calls.push(origin);
    return origin === a
      ? new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        })
      : Promise.resolve();
  });
  const restoring = restoreSelection(policy, { origin: a, localHttpOrigin: a });
  rejectA(new Error('Synthetic DNS rejection'));
  await Promise.resolve();
  const replacement = policy.activate(b, { localHttpOrigin: b });
  assert.equal(await restoring, false);
  assert.equal(await replacement, true);
  assert.deepEqual(calls, [a, b]);
  assert.equal(policy.permits(b, { localHttpOrigin: b }), true);
});
