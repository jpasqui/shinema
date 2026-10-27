/**
 * A long list (a library grid) loaded one page at a time as the user scrolls,
 * keeping only a bounded number of pages in memory. If the server reports a
 * different total (files were added or removed), the list resets itself and
 * reloads what is on screen instead of getting stuck on an error.
 */
export type Page<T> = { items: T[]; total: number };
export type PageLoader<T> = (
  offset: number,
  limit: number,
  signal: AbortSignal,
) => Promise<Page<T>>;

export type ListSnapshot<T> = {
  /** Null until the first page arrives. */
  total: number | null;
  /** Increments on every change; use it to re-render. */
  version: number;
  /** Increments when the list was reset because the library changed. */
  generation: number;
  loading: boolean;
  /** A message when a page failed; `retry()` tries again. */
  error: string | null;
  itemAt(index: number): T | undefined;
};

type Options<T> = {
  load: PageLoader<T>;
  pageSize?: number;
  maxPages?: number;
  describeError?: (error: unknown) => string;
};

export class PagedList<T> {
  private readonly load: PageLoader<T>;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly describeError: (error: unknown) => string;
  private pages = new Map<number, T[]>();
  private inFlight = new Map<number, AbortController>();
  private failed = new Set<number>();
  private total: number | null = null;
  private version = 0;
  private generation = 0;
  private error: string | null = null;
  private wanted: [number, number] = [0, 0];
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(options: Options<T>) {
    this.load = options.load;
    this.pageSize = options.pageSize ?? 60;
    this.maxPages = Math.max(2, options.maxPages ?? 12);
    this.describeError =
      options.describeError ??
      ((error) =>
        error instanceof Error ? error.message : 'Titles could not be loaded.');
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ListSnapshot<T> {
    const pages = this.pages;
    const size = this.pageSize;
    return {
      total: this.total,
      version: this.version,
      generation: this.generation,
      loading: this.inFlight.size > 0,
      error: this.error,
      itemAt: (index) => pages.get(Math.floor(index / size))?.[index % size],
    };
  }

  /** Asks for items `start..end` (exclusive) to be loaded. */
  show(start: number, end: number): void {
    if (this.disposed) return;
    const first = Math.max(0, Math.floor(start));
    this.wanted = [first, Math.max(first + 1, Math.floor(end))];
    this.loadVisible();
  }

  retry(): void {
    this.failed.clear();
    this.error = null;
    this.changed();
    this.loadVisible();
  }

  /** Drops everything and reloads what is on screen. */
  refresh(): void {
    this.reset();
    this.loadVisible();
  }

  /**
   * Loads the pages covering the wanted range. Until the total is known only
   * the first wanted page is requested; its response reveals the rest.
   */
  private loadVisible(): void {
    if (this.disposed) return;
    const [start, requestedEnd] = this.wanted;
    const end =
      this.total === null ? start + 1 : Math.min(requestedEnd, this.total);
    if (start < end) {
      const first = Math.floor(start / this.pageSize);
      const final = Math.floor((end - 1) / this.pageSize);
      for (let page = first; page <= final; page += 1)
        if (
          !this.pages.has(page) &&
          !this.inFlight.has(page) &&
          !this.failed.has(page)
        )
          void this.fetch(page);
    }
    this.evict();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.listeners.clear();
  }

  private reset(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.pages.clear();
    this.failed.clear();
    this.total = null;
    this.error = null;
    this.generation += 1;
    this.changed();
  }

  private async fetch(page: number): Promise<void> {
    const controller = new AbortController();
    const generation = this.generation;
    this.inFlight.set(page, controller);
    this.changed();
    try {
      const result = await this.load(
        page * this.pageSize,
        this.pageSize,
        controller.signal,
      );
      if (controller.signal.aborted || generation !== this.generation) return;
      this.inFlight.delete(page);
      if (this.total !== null && result.total !== this.total) {
        // The library changed under us; start over from what is visible.
        this.reset();
        this.loadVisible();
        return;
      }
      this.total = result.total;
      this.pages.set(page, result.items);
      this.failed.delete(page);
      if (this.failed.size === 0) this.error = null;
      this.evict();
      this.changed();
      // The first page may reveal that more of the wanted range exists.
      this.loadVisible();
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.inFlight.delete(page);
      this.failed.add(page);
      this.error = this.describeError(error);
      this.changed();
    }
  }

  /** Keeps the pages nearest the visible range. */
  private evict(): void {
    if (this.pages.size <= this.maxPages) return;
    const centre = (this.wanted[0] + this.wanted[1]) / 2 / this.pageSize;
    const byDistance = [...this.pages.keys()].sort(
      (a, b) => Math.abs(b - centre) - Math.abs(a - centre),
    );
    for (const page of byDistance.slice(0, this.pages.size - this.maxPages))
      this.pages.delete(page);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
