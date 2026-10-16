import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_BATCH_SIZE,
  FEED_CACHE_BATCHES,
  NativeFeed,
  feedItemTop,
  feedPath,
  feedSlotCount,
  feedScrollAnchor,
  clampFeedAnchor,
  feedWindow,
  normalizeFeedScope,
  parseFeedCatalog,
  parseFeedBatch,
  restoreFeedAnchor,
} from '../src/feed.ts';
import type { FeedScope } from '../src/feed.ts';
import type { Catalog } from '../../../packages/contracts/index.ts';
import { fresh } from '../src/domain.ts';
import {
  SessionGuard,
  StorageQueue,
  connectValidated,
} from '../src/session.ts';
import {
  archiveTheme,
  defaultTheme,
  THEME_DESIGN_VALUES,
} from '../../../packages/design-tokens/theme.ts';
import {
  nativeGridFrame,
  nativeReservedGeometry,
  nativeSkinLayout,
} from '../src/skin-layout.ts';
const scope: FeedScope = {
  origin: 'https://media.example.test',
  libraryId: 'cinema',
  revision: 2,
  collection: 'movies',
};
const item = (index: number) => ({
  id: index.toString(16).padStart(64, '0'),
  title: `Synthetic film ${index}`,
  container: 'mp4',
  sizeBytes: 10,
  streamPath: `/api/media/${index.toString(16).padStart(64, '0')}/stream`,
  collection: 'movies' as const,
  libraryId: 'cinema',
});
const page = (offset = 0, total = 10000): Catalog => ({
  apiVersion: 1,
  items: Array.from(
    { length: Math.min(FEED_BATCH_SIZE, Math.max(0, total - offset)) },
    (_, i) => item(offset + i),
  ),
  offset,
  limit: FEED_BATCH_SIZE,
  total,
  nextOffset:
    offset + FEED_BATCH_SIZE < total ? offset + FEED_BATCH_SIZE : null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { resolve, reject, promise };
}
test('feed scope is canonical, bounded, ID based and query values are encoded', () => {
  const path = new URL(
    'https://media.example.test' +
      feedPath({ ...scope, search: 'A&B + C', season: 0 }, 75),
  );
  assert.equal(path.searchParams.get('library'), 'cinema');
  assert.equal(path.searchParams.get('revision'), '2');
  assert.equal(path.searchParams.get('offset'), '48');
  assert.equal(path.searchParams.get('limit'), '48');
  assert.equal(path.searchParams.get('search'), 'A&B + C');
  assert.equal(path.searchParams.get('season'), '0');
  assert.equal(
    new URL(
      'https://media.example.test' +
        feedPath({ ...scope, collection: 'all' }, 0),
    ).searchParams.has('collection'),
    false,
  );
  for (const value of [
    { ...scope, origin: 'http://bad.test' },
    { ...scope, libraryId: '../bad' },
    { ...scope, libraryId: 'bad_ID' },
    { ...scope, revision: -1 },
    { ...scope, revision: undefined },
    { ...scope, libraryId: null },
    { ...scope, search: 'x'.repeat(201) },
    { ...scope, series: 'bad' },
    { ...scope, season: -1 },
  ])
    assert.throws(() => normalizeFeedScope(value as FeedScope));
});
test('a 10k library loads only requested batches, coalesces duplicate work and preserves slot/ID focus', async () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  const first = feed.itemAt(35);
  const reply = deferred<Catalog>();
  let reads = 0;
  const read = () => {
    reads++;
    return reply.promise;
  };
  const a = feed.load(49, read, 35);
  const b = feed.load(60, read, 35);
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(feed.snapshot().pending.length, 1);
  reply.resolve(page(48));
  await Promise.all([a, b]);
  assert.equal(feed.itemAt(35), first);
  assert.equal(feed.itemAt(49)?.id, item(49).id);
  assert.equal(reads, 1);
  assert.equal(feed.snapshot().total, 10000);
  assert.deepEqual(feed.snapshot().cached, [0, 48]);
});
test('scope generation rejects delayed results across origin, library, collection, search, series and season changes including away/back', async () => {
  for (const replacement of [
    { ...scope, origin: 'https://other.example.test' },
    { ...scope, libraryId: 'second-movies' },
    { ...scope, revision: 3 },
    { ...scope, collection: 'tv' as const },
    { ...scope, search: 'new' },
    { ...scope, series: 'b'.repeat(64) },
    { ...scope, season: 2 },
  ]) {
    const feed = new NativeFeed(scope);
    const reply = deferred<Catalog>();
    const loading = feed.load(0, () => reply.promise, 0);
    feed.reset(replacement);
    feed.reset(scope);
    reply.resolve(page());
    assert.equal(await loading, false);
    assert.equal(feed.itemAt(0), undefined);
    assert.equal(feed.snapshot().known, false);
  }
});
test('bad offsets, total changes, wrong scopes and duplicate cross-batch IDs cannot move existing records or clear focus', async () => {
  for (const malformed of [
    { ...page(48), offset: 0 },
    { ...page(48), limit: 47 },
    page(48, 10001),
    { ...page(48), items: [item(0), ...page(48).items.slice(1)] },
    {
      ...page(48),
      items: page(48).items.map((value) => ({ ...value, collection: 'tv' })),
    },
    {
      ...page(48),
      items: page(48).items.map((value) => ({ ...value, libraryId: 'anime' })),
    },
  ]) {
    const feed = new NativeFeed(scope);
    feed.reset(scope, page());
    const first = feed.itemAt(35);
    assert.equal(await feed.load(48, async () => malformed, 35), false);
    assert.equal(feed.itemAt(35), first);
    assert.equal(feed.itemAt(48), undefined);
    assert.equal(feed.snapshot().total, 10000);
    assert.ok(feed.errorAt(48));
  }
});
test('failed or synchronously rejected loads retain reserved indices and retry only explicitly', async () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  let reads = 0;
  const fail = () => {
    reads++;
    throw new Error('Synthetic offline');
  };
  assert.equal(await feed.load(48, fail, 35), false);
  assert.equal(feed.isLoading(48), false);
  await feed.load(48, fail, 35);
  assert.equal(reads, 1);
  assert.equal(await feed.load(48, async () => page(48), 35, true), true);
  assert.equal(feed.errorAt(48), undefined);
  assert.equal(feed.itemAt(48)?.id, item(48).id);
});

test('scope reset aborts HTTP work and an ignored abort cannot apply a late result', async () => {
  const feed = new NativeFeed(scope);
  const reply = deferred<Catalog>();
  let signal: AbortSignal | undefined;
  const pending = feed.load(
    0,
    async (_origin, _path, abort) => {
      signal = abort;
      return reply.promise;
    },
    0,
  );
  await Promise.resolve();
  assert.equal(signal?.aborted, false);
  feed.reset({ ...scope, libraryId: 'other' });
  assert.equal(signal?.aborted, true);
  reply.resolve(page());
  assert.equal(await pending, false);
  assert.equal(feed.snapshot().known, false);
  assert.equal(feed.itemAt(0), undefined);
});

test('connection refresh pauses both feed requests before new HTTP without discarding focused cache', async () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  feed.focus(3);
  const focused = feed.itemAt(3);
  const first = deferred<Catalog>();
  const second = deferred<Catalog>();
  const signals: AbortSignal[] = [];
  const a = feed.load(
    48,
    (_origin, _path, signal) => {
      signals.push(signal);
      return first.promise;
    },
    3,
  );
  const b = feed.load(
    96,
    (_origin, _path, signal) => {
      signals.push(signal);
      return second.promise;
    },
    3,
  );
  await Promise.resolve();
  assert.equal(signals.length, 2);
  feed.cancelPending();
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
  assert.deepEqual(feed.snapshot().pending, []);
  assert.equal(feed.itemAt(3), focused);
  assert.equal(feed.snapshot().total, 10000);
  first.resolve(page(48));
  second.resolve(page(96));
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.equal(feed.itemAt(48), undefined);
  assert.equal(feed.errorAt(48), undefined);
  assert.equal(await feed.load(48, async () => page(48), 3), true);
  assert.equal(feed.itemAt(3), focused);
});

test('legacy eight-title cache remains playable offline and can fill its missing batch slots on retry', async () => {
  const feed = new NativeFeed(scope);
  const legacy = {
    ...page(),
    items: page().items.slice(0, 8),
    limit: 8,
    nextOffset: 8,
  };
  feed.reset(scope, legacy);
  assert.equal(feed.itemAt(3)?.id, item(3).id);
  assert.equal(feed.isCached(20), false);
  await feed.load(
    20,
    async () => {
      throw new Error('Synthetic offline');
    },
    3,
  );
  assert.equal(feed.itemAt(3)?.id, item(3).id);
  assert.equal(feed.itemAt(20), undefined);
  assert.equal(await feed.load(20, async () => page(), 3, true), true);
  assert.equal(feed.isCached(20), true);
  assert.equal(feed.itemAt(20)?.id, item(20).id);
  assert.equal(feed.itemAt(3)?.id, item(3).id);
});

test('seed, refresh and initial-response parsing reject mis-scoped data before replacing the working feed', () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  const first = feed.itemAt(3);
  const before = feed.snapshot();
  const wrongCollection = {
    ...page(),
    items: page().items.map((value) => ({
      ...value,
      collection: 'tv' as const,
    })),
  };
  assert.throws(() => parseFeedCatalog(wrongCollection, scope), /scope/);
  assert.throws(() => feed.reset(scope, wrongCollection), /scope/);
  assert.throws(() => feed.refresh(wrongCollection), /scope/);
  assert.equal(feed.itemAt(3), first);
  assert.deepEqual(feed.snapshot(), before);
  for (const scoped of [
    { ...scope, series: 'b'.repeat(64) },
    { ...scope, season: 2 },
  ]) {
    assert.throws(() => feed.reset(scoped, page()), /scope/);
    assert.equal(feed.itemAt(3), first);
    assert.deepEqual(feed.snapshot(), before);
  }
  const legacy = {
    ...page(),
    items: page()
      .items.slice(0, 8)
      .map(({ collection: _collection, ...value }) => value),
    limit: 8,
    nextOffset: 8,
  };
  assert.equal(
    parseFeedCatalog(legacy, { ...scope, libraryId: null, revision: undefined })
      .items.length,
    8,
  );
  feed.reset({ ...scope, libraryId: null, revision: undefined }, legacy);
  assert.equal(feed.itemAt(3)?.id, item(3).id);
  assert.equal(feed.isCached(20), false);
});

test('configured feeds require explicit library membership; legacy requests omit library identity and revision', () => {
  const legacyScope: FeedScope = {
    origin: scope.origin,
    libraryId: null,
    collection: 'all',
  };
  const legacy = {
    ...page(),
    items: page().items.map(({ libraryId: _libraryId, ...value }) => value),
  };
  assert.throws(() => parseFeedCatalog(legacy, scope), /scope/);
  assert.equal(parseFeedCatalog(legacy, legacyScope).items.length, 48);
  const path = new URL(scope.origin + feedPath(legacyScope, 48));
  assert.equal(path.searchParams.has('library'), false);
  assert.equal(path.searchParams.has('revision'), false);
  assert.equal(path.searchParams.has('collection'), false);
  assert.equal(path.searchParams.get('offset'), '48');
});

test('invalid first live batches reject before staging, confirming or changing memory and cache', async () => {
  for (const invalid of [
    page(48, 96),
    { ...page(), limit: 47 },
    { ...page(), nextOffset: 49 },
    { ...page(), items: page().items.slice(0, 8), nextOffset: 8 },
    { apiVersion: 1, items: page().items },
    {
      ...page(),
      items: page().items.map((value) => ({ ...value, libraryId: 'anime' })),
    },
  ]) {
    const guard = new SessionGuard();
    let current = { ...fresh(), origin: scope.origin, catalog: page() };
    const feed = new NativeFeed(scope);
    feed.reset(scope, current.catalog);
    const before = current;
    const focused = feed.itemAt(3);
    let stages = 0;
    let writes = 0;
    const stamp = guard.capture(current.origin);
    const destination = 'https://other.example.test';
    await assert.rejects(
      (async () => {
        const catalog = parseFeedBatch(
          invalid,
          { ...scope, origin: destination },
          0,
        );
        return connectValidated(
          guard,
          guard.beginConnection(),
          destination,
          async () => catalog,
          {
            read: () => current,
            write: (value) => {
              feed.reset(
                { ...scope, origin: value.origin },
                value.catalog ?? undefined,
              );
              current = value as typeof current;
            },
            persist: async () => {},
            queue: new StorageQueue(),
            stageDisk: async () => {
              stages++;
            },
            writeDisk: async () => {
              writes++;
            },
          },
        );
      })(),
    );
    assert.equal(stages, 0);
    assert.equal(writes, 0);
    assert.equal(current, before);
    assert.equal(guard.current(stamp, current.origin), true);
    assert.equal(feed.itemAt(3), focused);
  }
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  const before = feed.snapshot();
  assert.equal(feed.canRefresh(page(0, 10001)), false);
  assert.deepEqual(feed.snapshot(), before);
});

test('touch anchors use the reserved skeleton count through delayed first load, retries and smaller/empty totals', () => {
  const scroll = 200 + 6 * 300 + 20;
  assert.equal(feedSlotCount(false, 0), 48);
  const anchor = feedScrollAnchor(scroll, 200, 4, 300, false, 0);
  assert.equal(anchor, 24);
  assert.equal(restoreFeedAnchor(anchor, 20, 200, 4, 300), scroll);
  assert.equal(feedScrollAnchor(scroll, 200, 4, 300, true, 10000), anchor);
  assert.equal(clampFeedAnchor(anchor, true, 12), 11);
  assert.equal(clampFeedAnchor(anchor, true, 0), 0);
  assert.equal(feedSlotCount(true, 0), 0);
});

test('a pending append protects the latest focus even when the request began at an older focus', async () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, {
    ...page(),
    items: Array.from({ length: 240 }, (_, index) => item(index)),
    limit: 240,
    nextOffset: 240,
  });
  for (const index of [0, 48, 96, 144])
    await feed.load(index, async () => page(index), index);
  const focused = feed.itemAt(192);
  const reply = deferred<Catalog>();
  const pending = feed.load(240, () => reply.promise, 0);
  feed.focus(192);
  reply.resolve(page(240));
  await pending;
  assert.equal(feed.itemAt(192), focused);
  assert.ok(feed.snapshot().cached.length <= FEED_CACHE_BATCHES);
});

test('startup revalidation fills matching data without evicting focus or accepting a changed catalogue snapshot', () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, {
    ...page(),
    items: Array.from({ length: 240 }, (_, index) => item(index)),
    limit: 240,
    nextOffset: 240,
  });
  feed.focus(192);
  const selected = feed.itemAt(192);
  assert.equal(
    feed.refresh({
      ...page(),
      items: page().items.map((value) => ({
        ...value,
        summary: 'Synthetic updated synopsis',
      })),
    }),
    true,
  );
  assert.equal(feed.itemAt(192), selected);
  assert.ok(feed.snapshot().cached.length <= FEED_CACHE_BATCHES);
  assert.equal(feed.refresh(page(0, 10001)), false);
  assert.equal(feed.snapshot().total, 10000);
  assert.equal(feed.itemAt(192), selected);
  assert.equal(
    feed.refresh({
      ...page(),
      items: [item(1), item(0), ...page().items.slice(2)],
    }),
    false,
  );
  assert.equal(feed.itemAt(192), selected);
});

test('touch resize restores the same global anchor and clamps its within-row offset', () => {
  const anchor = 72;
  assert.equal(restoreFeedAnchor(anchor, 20, 200, 4, 300), 5620);
  assert.equal(restoreFeedAnchor(anchor, 20, 200, 2, 300), 11020);
  assert.equal(restoreFeedAnchor(anchor, 500, 200, 2, 100), 3899);
  assert.equal(restoreFeedAnchor(anchor, -2, 200, 2, 100), 3800);
});

test('the shared native card frame survives partial-cache fill, metadata changes and failed append across authored designs', async () => {
  for (const base of [defaultTheme, archiveTheme])
    for (const typography of THEME_DESIGN_VALUES.typography)
      for (const density of THEME_DESIGN_VALUES.density)
        for (const cards of THEME_DESIGN_VALUES.cards)
          for (const motion of THEME_DESIGN_VALUES.motion)
            for (const [width, height] of [
              [390, 844],
              [960, 540],
              [1280, 720],
              [1920, 1080],
            ]) {
              const theme = {
                ...base,
                design: { ...base.design, typography, density, cards, motion },
              };
              const geometry = nativeReservedGeometry(theme, width, height);
              const layout = nativeSkinLayout(theme, width, height);
              for (const value of Object.values(geometry))
                assert.ok(Number.isFinite(value) && value > 0);
              const feed = new NativeFeed(scope);
              feed.reset(scope, {
                ...page(),
                items: page().items.slice(0, 8),
                limit: 8,
                nextOffset: 8,
              });
              const before = nativeGridFrame(theme, width, height, 3);
              const id = feed.itemAt(3)?.id;
              const reply = deferred<Catalog>();
              const loading = feed.load(20, () => reply.promise, 3);
              assert.deepEqual(
                nativeGridFrame(theme, width, height, 3),
                before,
              );
              reply.resolve({
                ...page(),
                items: page().items.map((value) => ({
                  ...value,
                  title: 'Long fixture title '.repeat(10),
                  summary: 'Long fixture synopsis '.repeat(100),
                  posterPath: `/api/media/${value.id}/poster`,
                })),
              });
              await loading;
              assert.equal(feed.itemAt(3)?.id, id);
              assert.deepEqual(
                nativeGridFrame(theme, width, height, 3),
                before,
              );
              await feed.load(
                48,
                async () => {
                  throw new Error('Synthetic delayed append failure');
                },
                3,
              );
              assert.deepEqual(
                nativeGridFrame(theme, width, height, 3),
                before,
              );
              assert.equal(geometry.cardTitle, 20);
              assert.equal(geometry.cardMetadata, 16);
              assert.equal(geometry.detailSummary, 100);
              assert.equal(geometry.play, 54);
              const mounted = feedWindow(
                10000,
                73,
                layout.columns,
                layout.cardHeight + layout.gap,
                height,
              );
              assert.ok(mounted.end - mounted.start <= 48);
            }
});

test('cache stays bounded, protects focused content and can lazily reload an evicted range without reindexing', async () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  const first = feed.itemAt(3);
  for (let batch = 1; batch < 12; batch++) {
    await feed.load(
      batch * 48,
      async (_origin, path) =>
        page(
          Number(new URL('https://x.test' + path).searchParams.get('offset')),
        ),
      3,
    );
    assert.ok(feed.snapshot().cached.length <= FEED_CACHE_BATCHES);
    assert.equal(feed.itemAt(3), first);
  }
  assert.equal(feed.itemAt(48), undefined);
  assert.equal(await feed.load(48, async () => page(48), 3), true);
  assert.equal(feed.itemAt(49)?.id, item(49).id);
  assert.equal(feed.itemAt(3), first);
});
test('pending requests are bounded and an empty terminal library never loops loading', async () => {
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  const reply = deferred<Catalog>();
  const first = feed.load(48, () => reply.promise, 0);
  const second = feed.load(96, async () => page(96), 0);
  assert.equal(await feed.load(144, async () => page(144), 0), false);
  reply.resolve(page(48));
  await Promise.all([first, second]);
  assert.equal(feed.snapshot().pending.length, 0);
  feed.reset(scope, page(0, 0));
  let calls = 0;
  await feed.load(
    0,
    async () => {
      calls++;
      return page(0, 0);
    },
    0,
  );
  assert.equal(calls, 0);
});
test('virtual rows keep item coordinates through append/loading/failure/window eviction and resize recomputes exact geometry', () => {
  for (const columns of [2, 4])
    for (const row of [148, 298]) {
      const anchor = 73;
      const top = feedItemTop(anchor, columns, row);
      const small = feedWindow(96, anchor, columns, row, 600);
      const large = feedWindow(10000, anchor, columns, row, 600);
      assert.equal(feedItemTop(anchor, columns, row), top);
      assert.ok(small.start <= anchor && small.end > anchor);
      assert.ok(large.start <= anchor && large.end > anchor);
      assert.ok(large.end - large.start <= 48);
      assert.equal(
        large.top +
          (Math.floor(anchor / columns) - Math.floor(large.start / columns)) *
            row,
        top,
      );
      assert.equal(
        large.top +
          Math.ceil((large.end - large.start) / columns) * row +
          large.bottom,
        Math.ceil(10000 / columns) * row,
      );
    }
  assert.equal(feedItemTop(73, 4, 200), 3600);
  assert.equal(feedItemTop(73, 2, 200), 7200);
});
