import {
  parseCatalog,
  parseSeriesPage,
} from '../../../packages/contracts/index.ts';
import type {
  Media,
  Series,
  Catalog,
  SeriesPage,
} from '../../../packages/contracts/index.ts';

export const BROWSE_BATCH_SIZE = 60;
export const MAX_RETAINED_BATCHES = 12;
export const MAX_RENDERED_CARDS = 120;
export const MAX_ACTIVE_REQUESTS = 3;
export const MAX_QUEUED_REQUESTS = 6;
export type FeedItem = Media | Series;
type FeedPage = {
  items: FeedItem[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  metadataPending?: boolean;
};
type Segment = { offset: number; end: number; next: number | null };
export type FeedSnapshot = Readonly<{
  revision: number;
  loadedEnd: number;
  total: number | null;
  nextOffset: number | null;
  loading: boolean;
  error: string | null;
  errorOffset: number | null;
  retainedCount: number;
  retainedBatches: number;
  activeRequests: number;
  queuedRequests: number;
}>;
export type FeedView = {
  focusIndex: number;
  scroll: number;
  columns: number;
  stride: number;
  gridTop: number;
};
type Loader = (offset: number, signal: AbortSignal) => Promise<unknown>;
type Intent = 'explicit' | 'viewport' | 'metadata';
type Task = {
  offset: number;
  force: boolean;
  replacing: boolean;
  intent: Intent;
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
};
const priority = (intent: Intent) =>
  intent === 'explicit' ? 0 : intent === 'viewport' ? 1 : 2;

/**
 * A session retains at most 12 batches/720 item records, not the entire library.
 * Requests are bounded to three active and six queued. Latest viewport/focus
 * intent cancels obsolete background work; a held sentinel never creates work.
 * Compact
 * segment boundaries (two numbers per successful batch) preserve the loaded
 * scroll extent and let an evicted range be fetched directly. A 10k-title
 * library has 167 such boundaries; revisiting it never replays earlier batches.
 * Without a server revision token an evicted batch's old order cannot be
 * verified. Retained batches reject order/ID changes; evicted batches validate
 * their bounds and overlap without retaining the entire library's metadata.
 */
export class LazyFeed {
  private loader: Loader;
  private kind: 'catalog' | 'series';
  private onPage?: (offset: number, page: Catalog | SeriesPage) => void;
  private timeoutMs: number;
  private libraryId?: string;
  private pages = new Map<number, FeedPage>();
  private segments: Segment[] = [];
  private flights = new Map<
    number,
    { controller: AbortController; promise: Promise<void> }
  >();
  private listeners = new Set<() => void>();
  private errors = new Map<number, string>();
  private generation = 0;
  private tasks = new Map<number, Task>();
  private queue = new Map<number, Task>();
  private pins = new Set<number>([0]);
  private snapshot: FeedSnapshot = Object.freeze({
    revision: 0,
    loadedEnd: 0,
    total: null,
    nextOffset: 0,
    loading: false,
    error: null,
    errorOffset: null,
    retainedCount: 0,
    retainedBatches: 0,
    activeRequests: 0,
    queuedRequests: 0,
  });
  readonly view: FeedView = {
    focusIndex: 0,
    scroll: 0,
    columns: 4,
    stride: 290,
    gridTop: 0,
  };

  constructor(
    loader: Loader,
    kind: 'catalog' | 'series',
    onPage?: (offset: number, page: Catalog | SeriesPage) => void,
    timeoutMs = 10000,
    libraryId?: string,
  ) {
    this.loader = loader;
    this.kind = kind;
    this.onPage = onPage;
    this.timeoutMs = timeoutMs;
    this.libraryId = libraryId;
  }

  getSnapshot = (): FeedSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      // React's development remount immediately resubscribes. Keep that single
      // request; a real query change/detail departure aborts on this microtask.
      queueMicrotask(() => {
        if (!this.listeners.size) this.pause();
      });
    };
  };

  private publish(next: Partial<FeedSnapshot> = {}) {
    const error = this.errors.entries().next().value;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...next,
      revision: this.snapshot.revision + 1,
      loading: this.flights.size > 0 || this.queue.size > 0,
      activeRequests: this.flights.size,
      queuedRequests: this.queue.size,
      retainedBatches: this.pages.size,
      errorOffset: error?.[0] ?? null,
      error: error?.[1] ?? null,
      retainedCount: [...this.pages.values()].reduce(
        (sum, page) => sum + page.items.length,
        0,
      ),
    });
    for (const listener of this.listeners) listener();
  }

  itemAt(index: number): FeedItem | undefined {
    for (const page of this.pages.values()) {
      if (index >= page.offset && index < page.offset + page.items.length)
        return page.items[index - page.offset];
    }
    return undefined;
  }

  indexOf(id: string): number | undefined {
    for (const page of this.pages.values()) {
      const local = page.items.findIndex((item) => item.id === id);
      if (local !== -1) return page.offset + local;
    }
    return undefined;
  }

  private parse(value: unknown, offset: number, replacing = false): FeedPage {
    const page = (
      this.kind === 'series' ? parseSeriesPage(value) : parseCatalog(value)
    ) as Catalog & SeriesPage;
    // Legacy small catalogs without paging metadata are still a single batch.
    const result: FeedPage = {
      ...page,
      total: page.total ?? page.items.length,
      offset: page.offset ?? 0,
      limit: page.limit ?? BROWSE_BATCH_SIZE,
      nextOffset: page.nextOffset ?? null,
    };
    if (
      this.libraryId &&
      result.items.some((item) => item.libraryId !== this.libraryId)
    )
      throw new Error('Unexpected library membership');
    if (
      result.offset !== offset ||
      result.limit !== BROWSE_BATCH_SIZE ||
      result.items.length > BROWSE_BATCH_SIZE ||
      result.offset + result.items.length > result.total
    )
      throw new Error('Invalid browse batch');
    if (
      result.nextOffset !== null &&
      result.nextOffset !== offset + result.items.length
    )
      throw new Error('Invalid browse boundary');
    const prior = this.segments.find((segment) => segment.offset === offset);
    if (
      !replacing &&
      prior &&
      (prior.end !== offset + result.items.length ||
        prior.next !== result.nextOffset)
    )
      throw new Error('The library changed. Refresh to reload it.');
    const retained = this.pages.get(offset);
    if (
      !replacing &&
      retained &&
      retained.items.some((item, index) => item.id !== result.items[index]?.id)
    )
      throw new Error('The library changed. Refresh to reload it.');
    if (
      !replacing &&
      this.snapshot.total !== null &&
      result.total !== this.snapshot.total
    )
      throw new Error('The library changed. Refresh to reload it.');
    const ids = new Set<string>();
    if (!replacing)
      for (const [key, saved] of this.pages)
        if (key !== offset) for (const item of saved.items) ids.add(item.id);
    if (result.items.some((item) => ids.has(item.id)))
      throw new Error('Repeated titles in a browse batch');
    return result;
  }

  private prune(incoming?: number) {
    let count = [...this.pages.values()].reduce(
      (sum, page) => sum + page.items.length,
      0,
    );
    for (const offset of this.pages.keys()) {
      if (
        count <= MAX_RETAINED_BATCHES * BROWSE_BATCH_SIZE &&
        this.pages.size <= MAX_RETAINED_BATCHES
      )
        break;
      if (!this.pins.has(offset) && offset !== incoming) {
        count -= this.pages.get(offset)!.items.length;
        this.pages.delete(offset);
      }
    }
    // Incomplete batches can put more than twelve boundaries in one viewport.
    // Keep the featured/focused/incoming batches, then nearest visible records;
    // pinning must never make the memory bound optional.
    const focused = this.segments.find(
      (segment) =>
        segment.offset <= this.view.focusIndex &&
        segment.end > this.view.focusIndex,
    )?.offset;
    const candidates = [...this.pages.keys()]
      .filter(
        (offset) => offset !== 0 && offset !== focused && offset !== incoming,
      )
      .sort(
        (a, b) =>
          Math.abs(b - this.view.focusIndex) -
          Math.abs(a - this.view.focusIndex),
      );
    for (const offset of candidates) {
      if (
        this.pages.size <= MAX_RETAINED_BATCHES &&
        count <= MAX_RETAINED_BATCHES * BROWSE_BATCH_SIZE
      )
        break;
      count -= this.pages.get(offset)!.items.length;
      this.pages.delete(offset);
    }
  }

  /** Seed only a validated first batch, preserving offline availability. */
  seed(value: unknown) {
    if (this.snapshot.loadedEnd || this.snapshot.total !== null) return;
    const page = this.parse(value, 0);
    this.accept(page);
  }

  private accept(page: FeedPage) {
    this.errors.delete(page.offset);
    this.pages.delete(page.offset);
    this.pages.set(page.offset, page);
    const end = page.offset + page.items.length;
    if (!this.segments.some((segment) => segment.offset === page.offset))
      this.segments.push({ offset: page.offset, end, next: page.nextOffset });
    const advances = page.offset === this.snapshot.loadedEnd;
    this.prune(page.offset);
    this.publish({
      total: page.total,
      loadedEnd: Math.max(this.snapshot.loadedEnd, end),
      ...(advances ? { nextOffset: page.nextOffset } : {}),
    });
  }

  private eligible(offset: number, force: boolean): boolean {
    return !(
      (!force && (this.pages.has(offset) || this.errors.has(offset))) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (offset !== this.snapshot.nextOffset &&
        !this.segments.some((segment) => segment.offset === offset))
    );
  }

  private cancelTask(task: Task) {
    if (this.tasks.get(task.offset) !== task) return;
    const request = this.flights.get(task.offset);
    request?.controller.abort();
    this.flights.delete(task.offset);
    this.queue.delete(task.offset);
    this.tasks.delete(task.offset);
    task.resolve();
  }

  private drain() {
    while (this.flights.size < MAX_ACTIVE_REQUESTS && this.queue.size) {
      const task = [...this.queue.values()].sort(
        (a, b) => priority(a.intent) - priority(b.intent),
      )[0];
      this.queue.delete(task.offset);
      if (task.generation !== this.generation) {
        this.cancelTask(task);
        continue;
      }
      void this.startOffset(task.offset, task.force, task.replacing).finally(
        () => {
          if (this.tasks.get(task.offset) === task)
            this.tasks.delete(task.offset);
          task.resolve();
          this.drain();
          this.publish();
        },
      );
    }
  }

  private enqueue(
    offset: number,
    force: boolean,
    replacing: boolean,
    intent: Intent,
  ): Promise<void> {
    const current = this.tasks.get(offset);
    if (current) {
      if (priority(intent) < priority(current.intent)) current.intent = intent;
      return current.promise;
    }
    if (!this.eligible(offset, force)) return Promise.resolve();
    if (this.queue.size >= MAX_QUEUED_REQUESTS) {
      const discard = [...this.queue.values()].sort(
        (a, b) => priority(b.intent) - priority(a.intent),
      )[0];
      if (
        priority(discard.intent) < priority(intent) ||
        (intent !== 'explicit' && discard.intent === intent)
      )
        return Promise.resolve();
      this.cancelTask(discard);
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const task: Task = {
      offset,
      force,
      replacing,
      intent,
      generation: this.generation,
      promise,
      resolve,
    };
    this.tasks.set(offset, task);
    this.queue.set(offset, task);
    this.drain();
    this.publish();
    return promise;
  }

  loadOffset(offset: number, force = false, replacing = false): Promise<void> {
    return this.enqueue(offset, force, replacing, 'explicit');
  }

  private startOffset(
    offset: number,
    force = false,
    replacing = false,
  ): Promise<void> {
    const current = this.flights.get(offset);
    if (current) return current.promise;
    if (
      (!force && (this.pages.has(offset) || this.errors.has(offset))) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (offset !== this.snapshot.nextOffset &&
        !this.segments.some((segment) => segment.offset === offset))
    )
      return Promise.resolve();
    const generation = this.generation;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let abort: (() => void) | undefined;
    // Start on a microtask so the flight is registered even for sync throwers.
    const promise = Promise.resolve().then(async () => {
      if (generation !== this.generation || controller.signal.aborted) return;
      try {
        const value = await Promise.race([
          this.loader(offset, controller.signal),
          new Promise<never>((_, reject) => {
            if (controller.signal.aborted) {
              reject(new Error('Browse request aborted'));
              return;
            }
            abort = () => reject(new Error('Browse request aborted'));
            controller.signal.addEventListener('abort', abort, { once: true });
            deadline = setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, this.timeoutMs);
          }),
        ]);
        if (generation !== this.generation || controller.signal.aborted) return;
        const page = this.parse(value, offset, replacing);
        if (replacing) {
          this.errors.clear();
          this.pages.clear();
          this.segments = [];
          this.snapshot = {
            ...this.snapshot,
            loadedEnd: 0,
            total: null,
            nextOffset: 0,
          };
          this.view.focusIndex = 0;
          this.view.scroll = 0;
        }
        this.accept(page);
        this.onPage?.(offset, page as Catalog | SeriesPage);
      } catch {
        if (
          generation === this.generation &&
          (timedOut || !controller.signal.aborted)
        ) {
          this.errors.set(
            offset,
            timedOut
              ? 'Loading timed out. Your existing titles are still here.'
              : 'More titles could not be loaded. Your existing titles are still here.',
          );
          this.publish();
        }
      } finally {
        clearTimeout(deadline);
        if (abort) controller.signal.removeEventListener('abort', abort);
        if (this.flights.get(offset)?.controller === controller) {
          this.flights.delete(offset);
          this.publish();
        }
      }
    });
    this.flights.set(offset, { controller, promise });
    this.publish();
    return promise;
  }

  loadNext = (): Promise<void> =>
    this.snapshot.nextOffset === null
      ? Promise.resolve()
      : this.loadOffset(this.snapshot.nextOffset);
  retry = (): Promise<void> =>
    this.snapshot.errorOffset === null
      ? this.loadNext()
      : this.loadOffset(this.snapshot.errorOffset, true);

  /** Explicit refresh replaces the range only after a valid new first batch. */
  restart(): Promise<boolean> {
    this.pause();
    const generation = ++this.generation;
    return this.loadOffset(0, true, true).then(
      () => generation === this.generation && this.snapshot.error === null,
    );
  }

  /** Pins the viewport, current focus and featured record before LRU eviction. */
  ensureRange(start: number, end: number, focusIndex = start): Promise<void[]> {
    this.view.focusIndex = focusIndex;
    end = Math.min(end, start + MAX_RENDERED_CARDS);
    const viewport = this.segments
      .filter((segment) => segment.offset < end && segment.end > start)
      .sort(
        (a, b) =>
          Math.abs(a.offset - focusIndex) - Math.abs(b.offset - focusIndex),
      );
    const focused = this.segments.find(
      (segment) => segment.offset <= focusIndex && segment.end > focusIndex,
    );
    this.pins = new Set(
      [
        0,
        ...(focused ? [focused.offset] : []),
        ...viewport.map((segment) => segment.offset),
      ].slice(0, MAX_RETAINED_BATCHES),
    );
    const segments = [
      ...new Set([...(focused ? [focused] : []), ...viewport]),
    ].filter((segment) => this.pins.has(segment.offset));
    for (const task of [...this.tasks.values()])
      if (task.intent !== 'explicit' && !this.pins.has(task.offset))
        this.cancelTask(task);
    this.prune();
    return Promise.all(
      segments.map((segment) =>
        this.enqueue(segment.offset, false, false, 'viewport'),
      ),
    );
  }

  refreshRange(
    start: number,
    end: number,
    pendingOnly = false,
  ): Promise<void[]> {
    end = Math.min(end, start + MAX_RENDERED_CARDS);
    const segments = this.segments.filter(
      (segment) =>
        segment.offset === 0 || (segment.offset < end && segment.end > start),
    );
    return Promise.all(
      segments
        .filter(
          (segment) =>
            !pendingOnly || this.pages.get(segment.offset)?.metadataPending,
        )
        .slice(0, MAX_RETAINED_BATCHES)
        .map((segment) =>
          this.enqueue(segment.offset, true, false, 'metadata'),
        ),
    );
  }

  metadataPending(start: number, end: number): boolean {
    return [...this.pages.values()].some(
      (page) =>
        page.metadataPending &&
        (page.offset === 0 ||
          (page.offset < end && page.offset + page.items.length > start)),
    );
  }

  pause() {
    if (!this.flights.size && !this.tasks.size) return;
    this.generation++;
    for (const task of [...this.tasks.values()]) this.cancelTask(task);
    this.flights.clear();
    this.queue.clear();
    this.publish();
  }

  /** Explicit refresh/reset has its own generation; ignored aborts cannot win. */
  reset() {
    this.pause();
    this.generation++;
    this.pages.clear();
    this.errors.clear();
    this.segments = [];
    this.pins = new Set([0]);
    this.view.focusIndex = 0;
    this.view.scroll = 0;
    this.publish({
      loadedEnd: 0,
      total: null,
      nextOffset: 0,
      error: null,
      errorOffset: null,
    });
  }
}

/** Aligned virtual rows; the focused row stays mounted outside the viewport. */
export function feedWindow(
  loaded: number,
  columns: number,
  row: number,
  visibleRows: number,
  focus: number,
): Array<{ start: number; end: number }> {
  if (!loaded) return [];
  columns = Math.max(1, Math.floor(columns));
  if (loaded <= MAX_RENDERED_CARDS) return [{ start: 0, end: loaded }];
  const totalRows = Math.ceil(loaded / columns);
  const capRows = Math.max(1, Math.floor(MAX_RENDERED_CARDS / columns) - 1);
  const count = Math.min(capRows, Math.max(1, visibleRows) + 4);
  const first = Math.max(0, Math.min(totalRows - count, row - 2));
  const last = Math.min(totalRows, first + count);
  const focused = Math.floor(
    Math.max(0, Math.min(loaded - 1, focus)) / columns,
  );
  const ranges = [{ start: first, end: last }];
  if (focused < first || focused >= last)
    ranges.push({ start: focused, end: focused + 1 });
  ranges.sort((a, b) => a.start - b.start);
  return ranges.map((range) => ({
    start: range.start * columns,
    end: Math.min(loaded, range.end * columns),
  }));
}
