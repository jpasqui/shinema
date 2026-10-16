import {
  parseCatalog,
  serverOrigin,
  validLibraryId,
} from '../../../packages/contracts/index.ts';
import type {
  Catalog,
  Media,
  PageInfo,
} from '../../../packages/contracts/index.ts';

export const FEED_BATCH_SIZE = 48;
export const FEED_CACHE_BATCHES = 5;
export type FeedScope = {
  origin: string;
  /** Null is an explicitly legacy, unconfigured server scope. */
  libraryId: string | null;
  revision?: number;
  collection: 'all' | 'movies' | 'tv';
  search?: string;
  series?: string;
  season?: number;
};
export type FeedSnapshot = {
  revision: number;
  total: number;
  known: boolean;
  pending: readonly number[];
  errors: ReadonlyMap<number, string>;
  cached: readonly number[];
};
const offsetFor = (index: number) =>
  Math.floor(Math.max(0, index) / FEED_BATCH_SIZE) * FEED_BATCH_SIZE;

export function normalizeFeedScope(value: FeedScope): FeedScope {
  const origin = serverOrigin(value.origin);
  if (
    (value.libraryId !== null && !validLibraryId(value.libraryId)) ||
    (value.libraryId === null
      ? value.revision !== undefined
      : !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) ||
    !['all', 'movies', 'tv'].includes(value.collection) ||
    (value.search !== undefined &&
      (typeof value.search !== 'string' ||
        Array.from(value.search).length > 200)) ||
    (value.series !== undefined && !/^[a-f0-9]{64}$/.test(value.series)) ||
    (value.season !== undefined &&
      (!Number.isSafeInteger(value.season) ||
        value.season < 0 ||
        value.season > 10000))
  )
    throw new Error('Invalid library scope');
  return {
    origin,
    libraryId: value.libraryId,
    ...(value.revision !== undefined ? { revision: value.revision } : {}),
    collection: value.collection,
    ...(value.search ? { search: value.search } : {}),
    ...(value.series ? { series: value.series } : {}),
    ...(value.season !== undefined ? { season: value.season } : {}),
  };
}
export function feedPath(scope: FeedScope, index: number): string {
  const safe = normalizeFeedScope(scope);
  const query = new URLSearchParams({
    offset: String(offsetFor(index)),
    limit: String(FEED_BATCH_SIZE),
  });
  if (safe.libraryId !== null) {
    query.set('library', safe.libraryId);
    query.set('revision', String(safe.revision));
  }
  if (safe.collection !== 'all') query.set('collection', safe.collection);
  if (safe.search) query.set('search', safe.search);
  if (safe.series) query.set('series', safe.series);
  if (safe.season !== undefined) query.set('season', String(safe.season));
  return '/api/catalog?' + query.toString();
}

/** Every ingestion path shares the same validated media scope, including disk seeds. */
export function parseFeedCatalog(value: unknown, scope: FeedScope): Catalog {
  const safe = normalizeFeedScope(scope);
  const catalog = parseCatalog(value);
  if (
    catalog.items.some(
      (item) =>
        (safe.libraryId !== null && item.libraryId !== safe.libraryId) ||
        (safe.collection !== 'all' &&
          item.collection !== undefined &&
          item.collection !== safe.collection) ||
        (safe.series !== undefined && item.seriesId !== safe.series) ||
        (safe.season !== undefined && item.season !== safe.season),
    )
  )
    throw new Error('Invalid library scope response');
  return catalog;
}

/** Live responses must match the requested transport page before any activation write. */
export function parseFeedBatch(
  value: unknown,
  scope: FeedScope,
  index: number,
): Catalog & PageInfo {
  const page = parseFeedCatalog(value, scope);
  const offset = offsetFor(index);
  if (
    page.offset !== offset ||
    page.limit !== FEED_BATCH_SIZE ||
    page.total === undefined ||
    page.nextOffset === undefined
  )
    throw new Error('Invalid library batch');
  if (
    page.items.length !==
    Math.min(FEED_BATCH_SIZE, Math.max(0, page.total - offset))
  )
    throw new Error('Incomplete library batch');
  return page as Catalog & PageInfo;
}

/** Bounded transient cache. Server offsets are stable slots, never array splice positions. */
export class NativeFeed {
  private generation = 0;
  private revision = 0;
  private total = 0;
  private known = false;
  private tick = 0;
  private focused = 0;
  private scope: FeedScope;
  private batches = new Map<
    number,
    { items: readonly Media[]; used: number; complete: boolean }
  >();
  private pending = new Map<number, Promise<boolean>>();
  private controllers = new Map<number, AbortController>();
  private errors = new Map<number, string>();
  constructor(scope: FeedScope) {
    this.scope = normalizeFeedScope(scope);
  }
  snapshot(): FeedSnapshot {
    return {
      revision: this.revision,
      total: this.total,
      known: this.known,
      pending: [...this.pending.keys()],
      errors: new Map(this.errors),
      cached: [...this.batches.keys()],
    };
  }
  /** A connection trial pauses feed HTTP without discarding confirmed cached slots. */
  cancelPending(): void {
    ++this.generation;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.pending.clear();
    ++this.revision;
  }
  reset(scope: FeedScope, catalog?: Catalog): void {
    const safe = normalizeFeedScope(scope);
    const parsed = catalog ? parseFeedCatalog(catalog, safe) : undefined;
    if (parsed && (parsed.offset ?? 0) !== 0)
      throw new Error('Initial library must start at zero');
    this.scope = safe;
    this.cancelPending();
    this.batches.clear();
    this.errors.clear();
    this.total = 0;
    this.known = false;
    if (parsed) {
      this.total = parsed.total ?? parsed.items.length;
      this.known = true;
      for (
        let offset = 0;
        offset <
        Math.min(parsed.items.length, FEED_BATCH_SIZE * FEED_CACHE_BATCHES);
        offset += FEED_BATCH_SIZE
      )
        this.batches.set(offset, {
          items: parsed.items.slice(offset, offset + FEED_BATCH_SIZE),
          used: ++this.tick,
          complete:
            Math.min(FEED_BATCH_SIZE, parsed.items.length - offset) ===
              FEED_BATCH_SIZE ||
            offset + Math.min(FEED_BATCH_SIZE, parsed.items.length - offset) >=
              this.total,
        });
    }
    ++this.revision;
  }
  itemAt(index: number): Media | undefined {
    return this.batches.get(offsetFor(index))?.items[index % FEED_BATCH_SIZE];
  }
  focus(index: number): void {
    this.focused = index;
  }
  /** Startup revalidation may enrich data, but cannot replace a user's focused range. */
  canRefresh(catalog: Catalog): boolean {
    const page = parseFeedBatch(catalog, this.scope, 0);
    return (
      !this.known ||
      (page.total === this.total &&
        ![...this.batches].some(([offset, batch]) =>
          batch.items.some(
            (item, index) =>
              offset + index < page.items.length &&
              page.items[offset + index].id !== item.id,
          ),
        ))
    );
  }
  refresh(catalog: Catalog): boolean {
    const page = parseFeedBatch(catalog, this.scope, 0);
    if (!this.known) {
      this.reset(this.scope, page);
      return true;
    }
    if (!this.canRefresh(page)) {
      this.errors.set(0, 'Library changed. Reconnect to refresh this view.');
      ++this.revision;
      return false;
    }
    this.batches.set(0, {
      items: page.items,
      used: ++this.tick,
      complete: true,
    });
    this.errors.delete(0);
    while (this.batches.size > FEED_CACHE_BATCHES) {
      const oldest = [...this.batches]
        .filter(
          ([offset]) =>
            offset !== 0 &&
            offset !== offsetFor(this.focused) &&
            !this.pending.has(offset),
        )
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) break;
      this.batches.delete(oldest[0]);
    }
    ++this.revision;
    return true;
  }
  errorAt(index: number): string | undefined {
    return this.errors.get(offsetFor(index));
  }
  isCached(index: number): boolean {
    return this.batches.get(offsetFor(index))?.complete === true;
  }
  isLoading(index: number): boolean {
    return this.pending.has(offsetFor(index));
  }
  async load(
    index: number,
    read: (
      origin: string,
      path: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    focus: number,
    retry = false,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > 10000000 ||
      (this.known && index >= this.total)
    )
      return false;
    const offset = offsetFor(index);
    const cached = this.batches.get(offset);
    if (cached?.complete) {
      cached.used = ++this.tick;
      return true;
    }
    const waiting = this.pending.get(offset);
    if (waiting) return waiting;
    if ((this.errors.has(offset) && !retry) || this.pending.size >= 2)
      return false;
    const generation = this.generation;
    const scope = this.scope;
    const controller = new AbortController();
    this.controllers.set(offset, controller);
    this.errors.delete(offset);
    const work = (async () => {
      try {
        const page = parseFeedBatch(
          await Promise.resolve().then(() => {
            if (controller.signal.aborted)
              throw new Error('Canceled library request');
            return read(
              scope.origin,
              feedPath(scope, offset),
              controller.signal,
            );
          }),
          scope,
          offset,
        );
        if (generation !== this.generation) return false;
        if (this.known && page.total !== this.total)
          throw new Error('Library changed. Reconnect to refresh this view.');
        if (
          cached &&
          cached.items.some((item, index) => page.items[index]?.id !== item.id)
        )
          throw new Error(
            'Library order changed. Reconnect to refresh this view.',
          );
        for (let i = 0; i < page.items.length; i++)
          for (const [start, batch] of this.batches)
            if (
              batch.items.some(
                (item, j) =>
                  item.id === page.items[i].id && start + j !== offset + i,
              )
            )
              throw new Error(
                'Library order changed. Reconnect to refresh this view.',
              );
        this.total = page.total;
        this.known = true;
        this.batches.set(offset, {
          items: page.items,
          used: ++this.tick,
          complete: true,
        });
        const protectedOffsets = new Set([
          offset,
          offsetFor(focus),
          offsetFor(this.focused),
          ...this.pending.keys(),
        ]);
        while (this.batches.size > FEED_CACHE_BATCHES) {
          const oldest = [...this.batches]
            .filter(([start]) => !protectedOffsets.has(start))
            .sort((a, b) => a[1].used - b[1].used)[0];
          if (!oldest) break;
          this.batches.delete(oldest[0]);
        }
        return true;
      } catch (error) {
        if (generation === this.generation)
          this.errors.set(
            offset,
            error instanceof Error && error.message.startsWith('Library ')
              ? error.message
              : 'Could not load more titles. Select the placeholder to retry.',
          );
        return false;
      } finally {
        if (generation === this.generation) {
          this.pending.delete(offset);
          this.controllers.delete(offset);
          ++this.revision;
        }
      }
    })();
    this.pending.set(offset, work);
    ++this.revision;
    return work;
  }
}

/** Only these rows mount; spacer geometry preserves every global item coordinate. */
export function feedWindow(
  total: number,
  anchor: number,
  columns: number,
  rowHeight: number,
  viewport: number,
) {
  const count = Math.max(0, Math.floor(total));
  const cols = Math.max(1, Math.floor(columns));
  const rows = Math.ceil(count / cols);
  const visible = Math.max(
    1,
    Math.min(8, Math.ceil(Math.max(0, viewport) / rowHeight)),
  );
  const startRow = Math.max(
    0,
    Math.min(
      Math.max(0, rows - visible - 4),
      Math.floor(Math.max(0, anchor) / cols) - 2,
    ),
  );
  const endRow = Math.min(rows, startRow + visible + 4);
  return {
    start: startRow * cols,
    end: Math.min(count, endRow * cols),
    top: startRow * rowHeight,
    bottom: Math.max(0, (rows - endRow) * rowHeight),
    height: rows * rowHeight,
  };
}

export const feedItemTop = (
  index: number,
  columns: number,
  rowHeight: number,
) => Math.floor(Math.max(0, index) / columns) * rowHeight;

export const restoreFeedAnchor = (
  index: number,
  withinRow: number,
  gridTop: number,
  columns: number,
  rowHeight: number,
) =>
  gridTop +
  feedItemTop(index, columns, rowHeight) +
  Math.max(0, Math.min(withinRow, rowHeight - 1));

/** App scroll anchors and skeletons must agree before the first count arrives. */
export const feedSlotCount = (known: boolean, total: number) =>
  known ? Math.max(0, total) : FEED_BATCH_SIZE;
export const clampFeedAnchor = (index: number, known: boolean, total: number) =>
  Math.min(Math.max(0, feedSlotCount(known, total) - 1), Math.max(0, index));
export const feedScrollAnchor = (
  scroll: number,
  gridTop: number,
  columns: number,
  rowHeight: number,
  known: boolean,
  total: number,
) =>
  clampFeedAnchor(
    Math.floor(Math.max(0, scroll - gridTop) / rowHeight) * columns,
    known,
    total,
  );
