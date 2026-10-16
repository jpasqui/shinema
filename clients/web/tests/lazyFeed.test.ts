import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSE_BATCH_SIZE,
  LazyFeed,
  MAX_RENDERED_CARDS,
  MAX_RETAINED_BATCHES,
  MAX_ACTIVE_REQUESTS,
  MAX_QUEUED_REQUESTS,
  feedWindow,
} from '../src/lazyFeed.ts';
import {
  browseIdentity,
  browsePath,
  initialBrowse,
  pageParser,
  recoverPages,
  resolveBrowse,
} from '../src/browse.ts';
import {
  defaultLibraries,
  emptyNavigationPreferences,
} from '../../../packages/contracts/index.ts';

const id = (index: number) => index.toString(16).padStart(64, '0');
const item = (index: number) => ({
  id: id(index),
  title: `Generated title ${index}`,
  container: 'mp4',
  sizeBytes: 1,
  streamPath: `/api/media/${id(index)}/stream`,
  collection: 'movies',
});
function page(offset = 0, total = 180) {
  const end = Math.min(offset + BROWSE_BATCH_SIZE, total);
  return {
    apiVersion: 1,
    fullLibrary: true,
    items: Array.from({ length: Math.max(0, end - offset) }, (_, index) =>
      item(index + offset),
    ),
    total,
    offset,
    limit: BROWSE_BATCH_SIZE,
    nextOffset: end < total ? end : null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('one request owns a boundary; repeated triggers coalesce without auto-filling', async () => {
  const pending = deferred<unknown>();
  const calls: number[] = [];
  const feed = new LazyFeed(async (offset) => {
    calls.push(offset);
    return offset ? page(offset) : pending.promise;
  }, 'catalog');
  const first = feed.loadNext();
  assert.equal(feed.loadNext(), first);
  assert.equal(feed.loadOffset(0, true), first);
  assert.equal(feed.getSnapshot().loading, true);
  await tick();
  assert.deepEqual(calls, [0]);
  pending.resolve(page());
  await first;
  await tick();
  assert.deepEqual(calls, [0]);
  assert.equal(feed.getSnapshot().loadedEnd, 60);
  await feed.loadNext();
  assert.deepEqual(calls, [0, 60]);
  assert.equal(feed.getSnapshot().loadedEnd, 120);
});

test('pause before the loader microtask settles without invoking an ignored-abort loader', async () => {
  let calls = 0;
  const feed = new LazyFeed(
    () => {
      calls++;
      return new Promise(() => {});
    },
    'catalog',
    undefined,
    20,
  );
  const pending = feed.loadNext();
  feed.pause();
  await pending;
  assert.equal(calls, 0);
  assert.equal(feed.getSnapshot().loading, false);
  assert.equal(feed.getSnapshot().error, null);
});

test('a reset aborts the old generation; an ignored late completion cannot win', async () => {
  const old = deferred<unknown>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const feed = new LazyFeed(async (_, request) => {
    calls++;
    if (calls === 1) {
      signal = request;
      return old.promise;
    }
    return {
      ...page(),
      items: page().items.map((row) => ({
        ...row,
        title: 'New search result',
      })),
    };
  }, 'catalog');
  const previous = feed.loadNext();
  await tick();
  feed.reset();
  assert.equal(signal?.aborted, true);
  await feed.loadNext();
  old.resolve(page());
  await previous;
  assert.equal(feed.itemAt(0)?.title, 'New search result');
  assert.equal(feed.getSnapshot().loadedEnd, 60);
  assert.equal(feed.getSnapshot().error, null);
});

test('a true timeout produces retry state; a paused active request does not', async () => {
  let signal: AbortSignal | undefined;
  const timed = new LazyFeed(
    async (_, request) => {
      signal = request;
      return new Promise(() => {});
    },
    'catalog',
    undefined,
    5,
  );
  await timed.loadNext();
  assert.equal(signal?.aborted, true);
  assert.match(timed.getSnapshot().error!, /timed out/);
  assert.equal(timed.getSnapshot().errorOffset, 0);
  const paused = new LazyFeed(async () => new Promise(() => {}), 'catalog');
  const pending = paused.loadNext();
  await tick();
  paused.pause();
  await pending;
  assert.equal(paused.getSnapshot().error, null);
});

test('a failed append preserves records, loaded extent, view and retry boundary', async () => {
  let fail = true;
  const calls: number[] = [];
  const feed = new LazyFeed(async (offset) => {
    calls.push(offset);
    if (offset && fail) throw new Error('Synthetic outage');
    return page(offset);
  }, 'catalog');
  await feed.loadNext();
  const first = feed.itemAt(0);
  Object.assign(feed.view, { focusIndex: 59, scroll: 2500 });
  await feed.loadNext();
  assert.equal(feed.getSnapshot().loadedEnd, 60);
  assert.equal(feed.itemAt(0), first);
  assert.equal(feed.view.focusIndex, 59);
  assert.equal(feed.view.scroll, 2500);
  assert.equal(feed.getSnapshot().errorOffset, 60);
  await feed.loadNext();
  assert.deepEqual(calls, [0, 60]);
  fail = false;
  await feed.retry();
  assert.deepEqual(calls, [0, 60, 60]);
  assert.equal(feed.getSnapshot().loadedEnd, 120);
  assert.equal(feed.itemAt(0), first);
  assert.equal(feed.getSnapshot().error, null);
});

test('malformed offset, stalled/missing boundaries and oversized legacy batches reject', async () => {
  const malformed = [
    { ...page(60), offset: 0 },
    { ...page(60), nextOffset: 60 },
    { ...page(60), nextOffset: null },
    { ...page(60), items: [], nextOffset: 120 },
    { ...page(60), limit: 500 },
    {
      apiVersion: 1,
      items: Array.from({ length: 61 }, (_, index) => item(index)),
    },
  ];
  for (const invalid of malformed) {
    const feed = new LazyFeed(
      async (offset) => (offset ? invalid : page()),
      'catalog',
    );
    await feed.loadNext();
    const first = feed.itemAt(0);
    await feed.loadNext();
    assert.equal(feed.getSnapshot().loadedEnd, 60);
    assert.equal(feed.itemAt(0), first);
    assert.equal(feed.getSnapshot().errorOffset, 60);
  }
});

test('duplicates within a batch or across retained batches reject the whole append', async () => {
  for (const duplicate of ['within', 'across']) {
    const next = page(60);
    next.items[0] = duplicate === 'within' ? next.items[1] : item(59);
    const feed = new LazyFeed(
      async (offset) => (offset ? next : page()),
      'catalog',
    );
    await feed.loadNext();
    await feed.loadNext();
    assert.equal(feed.getSnapshot().loadedEnd, 60);
    assert.equal(feed.itemAt(60), undefined);
    assert.ok(feed.getSnapshot().error);
  }
});

test('metadata updates preserve retained IDs/order and reject shape or order changes', async () => {
  let response = page();
  const feed = new LazyFeed(async () => response, 'catalog');
  await feed.loadNext();
  response = {
    ...page(),
    items: page().items.map((row) => ({ ...row, title: 'Updated metadata' })),
  };
  await feed.refreshRange(0, 60);
  assert.equal(feed.itemAt(0)?.title, 'Updated metadata');
  const stable = feed.itemAt(0);
  response = page();
  [response.items[0], response.items[1]] = [
    response.items[1],
    response.items[0],
  ];
  await feed.refreshRange(0, 60);
  assert.equal(feed.itemAt(0), stable);
  assert.ok(feed.getSnapshot().error);
  response = page(0, 181);
  await feed.refreshRange(0, 60);
  assert.equal(feed.getSnapshot().total, 180);
  assert.equal(feed.itemAt(0), stable);
});

test('explicit refresh is atomic: an outage keeps rows; valid changed topology starts a new range', async () => {
  let response: unknown = page();
  const feed = new LazyFeed(async () => {
    if (response instanceof Error) throw response;
    return response;
  }, 'catalog');
  await feed.loadNext();
  const old = feed.itemAt(0);
  response = new Error('Synthetic outage');
  assert.equal(await feed.restart(), false);
  assert.equal(feed.itemAt(0), old);
  assert.equal(feed.getSnapshot().loadedEnd, 60);
  response = page(0, 13);
  assert.equal(await feed.restart(), true);
  assert.equal(feed.getSnapshot().loadedEnd, 13);
  assert.equal(feed.getSnapshot().total, 13);
  assert.equal(feed.getSnapshot().nextOffset, null);
});

test('10k browsing keeps a bounded record window and reloads evicted ranges directly', async () => {
  const calls: number[] = [];
  const feed = new LazyFeed(async (offset) => {
    calls.push(offset);
    return page(offset, 10000);
  }, 'catalog');
  await feed.loadNext();
  while (feed.getSnapshot().nextOffset !== null) {
    const end = feed.getSnapshot().loadedEnd;
    await feed.ensureRange(Math.max(0, end - 120), end, end - 1);
    await feed.loadNext();
    assert.ok(
      feed.getSnapshot().retainedCount <=
        MAX_RETAINED_BATCHES * BROWSE_BATCH_SIZE,
    );
  }
  assert.equal(feed.getSnapshot().loadedEnd, 10000);
  assert.equal(feed.itemAt(0)?.id, id(0));
  assert.equal(feed.itemAt(9999)?.id, id(9999));
  assert.equal(feed.itemAt(120), undefined);
  const before = calls.length;
  await feed.ensureRange(120, 180, 120);
  assert.deepEqual(calls.slice(before), [120]);
  assert.equal(feed.itemAt(120)?.id, id(120));
  assert.equal(feed.getSnapshot().loadedEnd, 10000);
  assert.ok(feed.getSnapshot().retainedCount <= 720);
});

test('aborted refresh does not claim success or replace its saved range', async () => {
  const pending = deferred<unknown>();
  const feed = new LazyFeed(async () => pending.promise, 'catalog');
  feed.seed(page());
  const saved = feed.itemAt(0);
  const refreshing = feed.restart();
  await tick();
  feed.pause();
  assert.equal(await refreshing, false);
  pending.resolve(page(0, 13));
  await tick();
  assert.equal(feed.getSnapshot().total, 180);
  assert.equal(feed.itemAt(0), saved);
});

test('viewport and current focus are pinned while other old metadata is evicted', async () => {
  const feed = new LazyFeed(async (offset) => page(offset, 3000), 'catalog');
  for (let batch = 0; batch < 20; batch++) {
    await feed.loadNext();
    await feed.ensureRange(
      Math.max(0, feed.getSnapshot().loadedEnd - 60),
      feed.getSnapshot().loadedEnd,
      65,
    );
  }
  assert.equal(feed.itemAt(65)?.id, id(65));
  assert.equal(feed.itemAt(1199)?.id, id(1199));
  assert.ok(feed.getSnapshot().retainedCount <= 720);
});

test('detail restoration keeps its range and view while one freshness batch revalidates', async () => {
  const calls: number[] = [];
  let revalidation: ReturnType<typeof deferred<unknown>> | undefined;
  const feed = new LazyFeed(async (offset) => {
    calls.push(offset);
    return revalidation?.promise ?? page(offset, 10000);
  }, 'catalog');
  for (let index = 0; index < 4; index++) await feed.loadNext();
  Object.assign(feed.view, {
    focusIndex: 181,
    scroll: 4100,
    columns: 6,
    stride: 310,
    gridTop: 780,
  });
  await feed.ensureRange(180, 240, 181);
  const snapshot = feed.getSnapshot();
  feed.pause();
  await feed.ensureRange(180, 240, 181);
  assert.deepEqual(calls, [0, 60, 120, 180]);
  assert.equal(feed.getSnapshot(), snapshot);
  assert.equal(feed.view.focusIndex, 181);
  assert.equal(feed.view.scroll, 4100);
  const selected = feed.itemAt(181);
  revalidation = deferred<unknown>();
  const fresh = feed.loadOffset(0, true);
  assert.equal(feed.loadOffset(0, true), fresh);
  await tick();
  assert.deepEqual(calls, [0, 60, 120, 180, 0]);
  assert.equal(feed.getSnapshot().loadedEnd, 240);
  assert.equal(feed.itemAt(181), selected);
  assert.equal(feed.view.focusIndex, 181);
  assert.equal(feed.view.scroll, 4100);
  revalidation.resolve(page(0, 10000));
  await fresh;
  assert.equal(feed.getSnapshot().loadedEnd, 240);
  assert.equal(feed.itemAt(181), selected);
  assert.equal(feed.view.focusIndex, 181);
  assert.equal(feed.view.scroll, 4100);
});

test('virtual rows stay bounded and retain focused items through viewport/column changes', () => {
  assert.deepEqual(feedWindow(60, 6, 100, 4, 59), [{ start: 0, end: 60 }]);
  assert.deepEqual(feedWindow(120, 6, 100, 4, 119), [{ start: 0, end: 120 }]);
  for (const columns of [1, 2, 4, 6, 10, 12, 50])
    for (const focus of [0, 179, 9999])
      for (const row of [0, 90, 5000]) {
        const ranges = feedWindow(10000, columns, row, 12, focus);
        assert.ok(
          ranges.reduce((sum, range) => sum + range.end - range.start, 0) <=
            MAX_RENDERED_CARDS,
        );
        assert.ok(
          ranges.some((range) => range.start <= focus && range.end > focus),
        );
        for (const range of ranges) {
          assert.equal(range.start % columns, 0);
          assert.ok(range.end <= 10000);
        }
        if (ranges.length === 2) assert.ok(ranges[0].end <= ranges[1].start);
      }
});

test('metadata polling only revisits pending visible/featured batches', async () => {
  const calls: number[] = [];
  const feed = new LazyFeed(async (offset) => {
    calls.push(offset);
    return { ...page(offset), metadataPending: offset === 60 };
  }, 'catalog');
  await feed.loadNext();
  await feed.loadNext();
  assert.equal(feed.metadataPending(0, 60), false);
  assert.equal(feed.metadataPending(60, 120), true);
  await feed.refreshRange(60, 120, true);
  assert.deepEqual(calls, [0, 60, 60]);
});

test('development unsubscribe/resubscribe coalesces while real departure aborts', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const feed = new LazyFeed(async (_, request) => {
    calls++;
    signal = request;
    return new Promise(() => {});
  }, 'catalog');
  const leave = feed.subscribe(() => {});
  const pending = feed.loadNext();
  leave();
  const again = feed.subscribe(() => {});
  await tick();
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, false);
  again();
  await tick();
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(feed.getSnapshot().error, null);
});

test('unknown offsets cannot bypass the next boundary or fetch an entire library', async () => {
  let calls = 0;
  const feed = new LazyFeed(async (offset) => {
    calls++;
    return page(offset);
  }, 'catalog');
  await feed.loadOffset(120);
  assert.equal(calls, 0);
  await feed.loadNext();
  await feed.loadOffset(120);
  assert.equal(calls, 1);
});

test('one successful evicted-range reload cannot hide a simultaneous failed range', async () => {
  let fail = false;
  const feed = new LazyFeed(async (offset) => {
    if (fail && offset === 60) throw new Error('Synthetic range outage');
    return page(offset, 1200);
  }, 'catalog');
  for (let batch = 0; batch < 16; batch++) await feed.loadNext();
  assert.equal(feed.itemAt(60), undefined);
  assert.equal(feed.itemAt(120), undefined);
  fail = true;
  await feed.ensureRange(60, 180, 60);
  assert.equal(feed.itemAt(60), undefined);
  assert.equal(feed.itemAt(120)?.id, id(120));
  assert.equal(feed.getSnapshot().errorOffset, 60);
  fail = false;
  await feed.retry();
  assert.equal(feed.itemAt(60)?.id, id(60));
  assert.equal(feed.getSnapshot().error, null);
});

test('library identity stays separate from names, media scope and loaded offsets', () => {
  const nav = initialBrowse();
  assert.notEqual(
    browseIdentity(nav),
    browseIdentity({ ...nav, libraryId: 'different-movies' }),
  );
  assert.equal(
    browseIdentity(nav),
    browseIdentity({ ...nav, offset: 120, scroll: 900, focusId: id(3) }),
  );
  assert.notEqual(
    browseIdentity(nav),
    browseIdentity({ ...nav, search: 'new search' }),
  );
  assert.notEqual(browseIdentity(nav), browseIdentity({ ...nav, season: 2 }));
  const mixed = new URL(
    browsePath({ ...nav, libraryId: 'all-stories', collection: 'all' }),
    'http://127.0.0.1',
  );
  assert.equal(mixed.searchParams.get('library'), 'all-stories');
  assert.equal(mixed.searchParams.get('collection'), 'all');
  assert.equal(mixed.searchParams.get('limit'), '60');
});

test('same-ID revisions isolate feed identity/cache while labels never define scope', () => {
  const document = { ...defaultLibraries(), revision: 2 };
  const requested = { ...initialBrowse(), libraryId: 'movies', revision: 2 };
  const preferences = emptyNavigationPreferences();
  const first = resolveBrowse(requested, document, preferences, false, true);
  const renamed = resolveBrowse(
    requested,
    {
      ...document,
      libraries: document.libraries.map((entry) => ({
        ...entry,
        name: `Renamed ${entry.name}`,
        order: entry.order + 3,
      })),
    },
    preferences,
    false,
    true,
  );
  assert.equal(
    browseIdentity(first.navigation),
    browseIdentity(renamed.navigation),
  );
  const revision = resolveBrowse(
    { ...requested, focusId: id(4), scroll: 300, search: 'old' },
    { ...document, revision: 3 },
    preferences,
    false,
    true,
  );
  assert.notEqual(
    browseIdentity(first.navigation),
    browseIdentity(revision.navigation),
  );
  assert.equal(revision.navigation.focusId, null);
  assert.equal(revision.navigation.scroll, 0);
  assert.equal(revision.navigation.search, '');
  assert.equal(
    new URL(
      browsePath(revision.navigation),
      'http://localhost',
    ).searchParams.get('revision'),
    '3',
  );
  assert.equal(
    resolveBrowse(
      initialBrowse(),
      defaultLibraries(),
      preferences,
      false,
      false,
    ).enabled,
    false,
  );
  const legacy = resolveBrowse(
    initialBrowse(),
    defaultLibraries(),
    preferences,
    true,
    true,
  );
  assert.equal(legacy.enabled, true);
  const route = new URL(browsePath(legacy.navigation), 'http://localhost');
  assert.equal(route.searchParams.has('library'), false);
  assert.equal(route.searchParams.has('revision'), false);
  assert.equal(
    resolveBrowse(
      requested,
      { ...document, libraries: [] },
      preferences,
      false,
      true,
    ).enabled,
    false,
  );
});

test('scoped seed, append, metadata and cache recovery reject missing or foreign membership', async () => {
  const scoped = (offset = 0) => ({
    ...page(offset),
    items: page(offset).items.map((row) => ({ ...row, libraryId: 'movies' })),
  });
  for (const membership of [undefined, 'other']) {
    let response: unknown = scoped();
    const feed = new LazyFeed(
      async () => response,
      'catalog',
      undefined,
      10000,
      'movies',
    );
    const invalid = {
      ...page(),
      items: page().items.map((row) => ({
        ...row,
        ...(membership ? { libraryId: membership } : {}),
      })),
    };
    assert.throws(() => feed.seed(invalid), /library membership/);
    await feed.loadNext();
    const saved = feed.itemAt(0);
    response = {
      ...page(60),
      items: page(60).items.map((row) => ({
        ...row,
        ...(membership ? { libraryId: membership } : {}),
      })),
    };
    await feed.loadNext();
    assert.equal(feed.getSnapshot().loadedEnd, 60);
    assert.equal(feed.itemAt(60), undefined);
    response = invalid;
    await feed.refreshRange(0, 60);
    assert.equal(feed.itemAt(0), saved);
    const path = '/api/catalog?library=movies&revision=2&offset=0&limit=60';
    assert.throws(() => pageParser(path)(invalid), /library membership/);
    assert.equal(
      recoverPages(JSON.stringify({ [path]: invalid }))[path],
      undefined,
    );
  }
  const legacy = new LazyFeed(async () => page(), 'catalog');
  await legacy.loadNext();
  assert.equal(legacy.getSnapshot().loadedEnd, 60);
});

test('incomplete batches cannot exceed twelve retained boundaries even with many viewport pins', async () => {
  const feed = new LazyFeed(
    async (offset) => ({
      ...page(offset, 80),
      items: [item(offset)],
      nextOffset: offset + 1 < 80 ? offset + 1 : null,
    }),
    'catalog',
  );
  for (let index = 0; index < 40; index++) {
    await feed.loadNext();
    await feed.ensureRange(0, index + 1, index);
    assert.ok(feed.getSnapshot().retainedBatches <= MAX_RETAINED_BATCHES);
    assert.ok(feed.getSnapshot().retainedCount <= MAX_RETAINED_BATCHES);
    assert.equal(feed.itemAt(0)?.id, id(0));
    assert.equal(feed.itemAt(index)?.id, id(index));
  }
});

test('short batches drain every latest pinned range beyond the bounded task queue', async () => {
  let delayed = false;
  const requests: Array<{
    offset: number;
    gate: ReturnType<typeof deferred<unknown>>;
    released: boolean;
  }> = [];
  const single = (offset: number) => ({
    ...page(offset, 80),
    items: [item(offset)],
    nextOffset: offset + 1 < 80 ? offset + 1 : null,
  });
  const feed = new LazyFeed(async (offset) => {
    if (!delayed) return single(offset);
    const gate = deferred<unknown>();
    requests.push({ offset, gate, released: false });
    return gate.promise;
  }, 'catalog');
  for (let index = 0; index < 40; index++) await feed.loadNext();
  delayed = true;
  const leave = feed.subscribe(() => {
    assert.ok(feed.getSnapshot().activeRequests <= MAX_ACTIVE_REQUESTS);
    assert.ok(feed.getSnapshot().queuedRequests <= MAX_QUEUED_REQUESTS);
    assert.ok(feed.getSnapshot().retainedBatches <= MAX_RETAINED_BATCHES);
  });
  let settled = false;
  const pending = feed.ensureRange(1, 13, 6).then(() => {
    settled = true;
  });
  // Release bounded waves without changing viewport, focus or calling
  // ensureRange again. Previously offset1 was silently dropped forever.
  for (let wave = 0; wave < MAX_RETAINED_BATCHES && !settled; wave++) {
    for (let microtask = 0; microtask < 12; microtask++) await tick();
    for (const request of requests)
      if (!request.released) {
        request.released = true;
        request.gate.resolve(single(request.offset));
      }
  }
  for (let microtask = 0; microtask < 12; microtask++) await tick();
  assert.equal(settled, true);
  await pending;
  assert.equal(feed.getSnapshot().loading, false);
  assert.equal(feed.getSnapshot().error, null);
  assert.equal(feed.getSnapshot().retainedBatches, MAX_RETAINED_BATCHES);
  for (let offset = 0; offset < MAX_RETAINED_BATCHES; offset++)
    assert.equal(feed.itemAt(offset)?.id, id(offset));
  assert.equal(requests.length, MAX_RETAINED_BATCHES - 1);
  assert.equal(
    new Set(requests.map(({ offset }) => offset)).size,
    requests.length,
  );
  leave();
});

test('active HTTP and queue stay bounded; pause settles queued work without starting it', async () => {
  let delayed = false;
  let active = 0;
  let peak = 0;
  const calls: number[] = [];
  const feed = new LazyFeed(async (offset, signal) => {
    if (!delayed) return page(offset, 3600);
    calls.push(offset);
    active++;
    peak = Math.max(peak, active);
    signal.addEventListener(
      'abort',
      () => {
        active--;
      },
      { once: true },
    );
    return new Promise(() => {});
  }, 'catalog');
  for (let batch = 0; batch < 60; batch++) await feed.loadNext();
  delayed = true;
  const pending: Promise<void>[] = [];
  for (let offset = 60; offset < 1800; offset += 60) {
    pending.push(feed.loadOffset(offset, true));
    assert.ok(feed.getSnapshot().activeRequests <= MAX_ACTIVE_REQUESTS);
    assert.ok(feed.getSnapshot().queuedRequests <= MAX_QUEUED_REQUESTS);
  }
  await tick();
  assert.equal(calls.length, MAX_ACTIVE_REQUESTS);
  assert.equal(peak, MAX_ACTIVE_REQUESTS);
  const before = calls.length;
  feed.pause();
  await Promise.all(pending);
  await tick();
  assert.equal(calls.length, before);
  assert.equal(active, 0);
  assert.equal(feed.getSnapshot().activeRequests, 0);
  assert.equal(feed.getSnapshot().queuedRequests, 0);
  assert.equal(feed.getSnapshot().error, null);
});

test('latest viewport intent aborts obsolete historical requests and keeps its focused range', async () => {
  let delayed = false;
  const requests: Array<{
    offset: number;
    signal: AbortSignal;
    gate: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const feed = new LazyFeed(async (offset, signal) => {
    if (!delayed) return page(offset, 3600);
    const gate = deferred<unknown>();
    requests.push({ offset, signal, gate });
    return gate.promise;
  }, 'catalog');
  for (let batch = 0; batch < 60; batch++) await feed.loadNext();
  delayed = true;
  const old = feed.ensureRange(60, 240, 65);
  await tick();
  const latest = feed.ensureRange(1200, 1380, 1265);
  await tick();
  assert.ok(
    requests.filter((request) => !request.signal.aborted).length <=
      MAX_ACTIVE_REQUESTS,
  );
  assert.ok(
    requests
      .filter((request) => request.offset < 240)
      .every((request) => request.signal.aborted),
  );
  for (const request of requests)
    request.gate.resolve(page(request.offset, 3600));
  await Promise.all([old, latest]);
  assert.equal(feed.itemAt(1265)?.id, id(1265));
  assert.equal(feed.getSnapshot().error, null);
});
