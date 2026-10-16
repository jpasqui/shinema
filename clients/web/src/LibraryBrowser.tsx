import { MetadataCredits } from './MetadataCredits.tsx';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { KeyboardEvent } from 'react';
import type {
  LibrarySummary,
  Media,
  SeriesPage,
  Seasons,
  Progress,
} from '../../../packages/contracts/index.ts';
import type { useLibraries } from './libraries.ts';
import { LibrarySettings } from './LibrarySettings.tsx';
import { MediaPoster } from './MediaPoster.tsx';
import { LibraryFeature } from './skins.tsx';
import {
  browseIdentity,
  browsePath,
  pageParser,
  recoverPages,
  rememberPage,
  resolveBrowse,
} from './browse.ts';
import type { BrowseNavigation, PageCache, PageValue } from './browse.ts';
import { LazyFeed, feedWindow } from './lazyFeed.ts';
import type { FeedItem } from './lazyFeed.ts';
import { clock } from './model.ts';

const cacheKey = 'shinema.web.browse.v1';
const cache = { current: {} as PageCache };
let cacheRecovered = false;
let storageUnavailable = false;
function savePage(path: string, value: PageValue) {
  cache.current = rememberPage(cache.current, path, value);
  try {
    localStorage.setItem(cacheKey, JSON.stringify(cache.current));
    storageUnavailable = false;
  } catch {
    storageUnavailable = true;
  }
}
function recoverCache() {
  if (cacheRecovered) return;
  try {
    cache.current = recoverPages(localStorage.getItem(cacheKey));
  } catch {
    storageUnavailable = true;
  }
  cacheRecovered = true;
}

// Detail/player navigation unmounts the browser. Four LRU query sessions retain
// its loaded extent and focused range; item records remain bounded per session.
const sessions = new Map<string, { feed: LazyFeed }>();
function sessionFor(navigation: BrowseNavigation) {
  const identity = browseIdentity(navigation);
  const existing = sessions.get(identity);
  if (existing) {
    sessions.delete(identity);
    sessions.set(identity, existing);
    return existing;
  }
  const route = (offset: number) => browsePath({ ...navigation, offset });
  const feed = new LazyFeed(
    async (offset, signal) => {
      const response = await fetch(route(offset), { signal, priority: 'high' });
      if (response.status === 409)
        window.dispatchEvent(new Event('shinema:libraries-refresh'));
      if (!response.ok) throw new Error('Browse request failed');
      return pageParser(route(offset))(await response.json());
    },
    navigation.collection === 'tv' && !navigation.series ? 'series' : 'catalog',
    (offset, value) => savePage(route(offset), value),
    10000,
    navigation.libraryId,
  );
  if (cache.current[route(0)]) {
    try {
      feed.seed(cache.current[route(0)]);
    } catch {
      /* One invalid cached batch cannot poison a session. */
    }
  }
  const session = { feed };
  sessions.set(identity, session);
  while (sessions.size > 4) {
    const oldest = sessions.keys().next().value!;
    sessions.get(oldest)?.feed.pause();
    sessions.delete(oldest);
  }
  return session;
}

// The configuration request uses its canonical authority in App. The browser
// keeps the same reserved DOM while that request is unresolved, with no browse
// request, cache seed or stale scoped title displayed from this inert session.
const idleSession = {
  feed: new LazyFeed(async () => {
    throw new Error('Browse scope is not ready');
  }, 'catalog'),
};

function useResource<T extends PageValue>(
  path: string | null,
  refresh: number,
) {
  const [state, setState] = useState({
    path,
    value: (path ? cache.current[path] : undefined) as T | undefined,
    loading: !!path,
    offline: false,
  });
  useEffect(() => {
    if (!path) {
      setState({ path, value: undefined, loading: false, offline: false });
      return;
    }
    let alive = true;
    let generation = 0;
    let controller: AbortController | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const ticket = ++generation;
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      const deadline = setTimeout(() => request.abort(), 10000);
      try {
        const response = await fetch(path, { signal: request.signal });
        if (!response.ok) throw new Error('Browse request failed');
        const value = pageParser(path)(await response.json()) as T;
        if (!alive || ticket !== generation) return;
        savePage(path, value);
        setState({ path, value, loading: false, offline: false });
        if ('metadataPending' in value && value.metadataPending)
          poll = setTimeout(() => {
            void load();
          }, 2000);
      } catch {
        if (alive && ticket === generation)
          setState({
            path,
            value: cache.current[path] as T | undefined,
            loading: false,
            offline: true,
          });
      } finally {
        clearTimeout(deadline);
      }
    };
    setState({
      path,
      value: cache.current[path] as T | undefined,
      loading: true,
      offline: false,
    });
    void load();
    return () => {
      alive = false;
      generation++;
      controller?.abort();
      clearTimeout(poll);
    };
  }, [path, refresh]);
  return state.path === path
    ? state
    : {
        path,
        value: (path ? cache.current[path] : undefined) as T | undefined,
        loading: !!path,
        offline: false,
      };
}

const INITIAL_SLOTS = 12;
export function LibraryBrowser({
  navigation: requestedNavigation,
  setNavigation,
  onSelect,
  onRefresh,
  progress,
  libraryNavigation,
}: {
  navigation: BrowseNavigation;
  setNavigation: (value: BrowseNavigation) => void;
  onSelect: (item: Media, index: number) => void;
  onRefresh?: () => void;
  progress: Record<string, Progress>;
  libraryNavigation: ReturnType<typeof useLibraries>;
}) {
  recoverCache();
  const ready =
    libraryNavigation.legacy ||
    libraryNavigation.document.revision > 0 ||
    libraryNavigation.status === '';
  const { navigation, library, visible, changed, enabled } = resolveBrowse(
    requestedNavigation,
    libraryNavigation.document,
    libraryNavigation.preferences,
    libraryNavigation.legacy,
    ready,
  );
  const identity = browseIdentity(navigation);
  const session = useMemo(
    () => (enabled ? sessionFor(navigation) : idleSession),
    [identity, enabled],
  );
  const feed = session.feed;
  const activeFeed = useRef<LazyFeed | null>(feed);
  activeFeed.current = feed;
  const state = useSyncExternalStore(
    feed.subscribe,
    feed.getSnapshot,
    feed.getSnapshot,
  );
  const [search, setSearch] = useState(navigation.search);
  const [refresh, setRefresh] = useState(0);
  const [settings, setSettings] = useState(false);
  const summary = useResource<LibrarySummary>('/api/library', refresh);
  const seasons = useResource<Seasons>(
    enabled && navigation.series
      ? `/api/series/${navigation.series.id}/seasons`
      : null,
    refresh,
  );
  const grid = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const [focus, setFocus] = useState(() =>
    navigation.focusId
      ? (feed.indexOf(navigation.focusId) ?? feed.view.focusIndex)
      : 0,
  );
  const [viewport, setViewport] = useState(() => ({
    scroll: navigation.focusId ? navigation.scroll : 0,
    height: window.innerHeight,
  }));
  const [geometry, setGeometry] = useState(() => ({
    columns: feed.view.columns,
    stride: feed.view.stride,
    gap: 25,
    top: feed.view.gridTop,
  }));
  const pendingFocus = useRef<{ index: number; scroll?: number } | null>(
    navigation.focusId ? { index: focus, scroll: navigation.scroll } : null,
  );
  const scrollEpoch = useRef(0);
  const consumedScroll = useRef(-1);
  const shows = navigation.collection === 'tv' && !navigation.series;
  const first = enabled ? feed.itemAt(0) : undefined;
  const slots =
    state.loadedEnd ||
    (state.total === 0 || (ready && !library) ? 0 : INITIAL_SLOTS);
  const loading = enabled
    ? state.loading || (state.total === null && !state.error)
    : !ready;
  const firstVisibleRow = Math.max(
    0,
    Math.floor((viewport.scroll - geometry.top) / geometry.stride),
  );
  const visibleRows = Math.ceil(viewport.height / geometry.stride);
  const ranges = feedWindow(
    slots,
    geometry.columns,
    firstVisibleRow,
    visibleRows,
    focus,
  );
  const visibleStart = Math.min(
    state.loadedEnd,
    Math.max(0, (firstVisibleRow - 2) * geometry.columns),
  );
  const visibleEnd = Math.min(
    state.loadedEnd,
    (firstVisibleRow + visibleRows + 2) * geometry.columns,
  );

  useEffect(() => {
    setSearch(navigation.search);
  }, [navigation.search]);
  useEffect(() => {
    if (enabled && changed) setNavigation(navigation);
  }, [enabled, changed, identity, requestedNavigation, setNavigation]);
  useEffect(() => {
    const open = () => {
      pendingFocus.current = null;
      setSettings(true);
    };
    const search = () => {
      pendingFocus.current = null;
      document.getElementById('library-search')?.focus();
    };
    window.addEventListener('shinema:library-settings', open);
    window.addEventListener('shinema:library-search', search);
    return () => {
      window.removeEventListener('shinema:library-settings', open);
      window.removeEventListener('shinema:library-search', search);
    };
  }, []);
  useEffect(() => {
    activeFeed.current = feed;
    // Returning from details keeps the loaded extent, but revalidates one
    // bounded batch for freshness. StrictMode remounts share its in-flight task.
    if (enabled) void feed.loadOffset(0, true);
    const online = () => {
      if (enabled) void feed.retry();
      setRefresh((value) => value + 1);
    };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      if (activeFeed.current === feed) activeFeed.current = null;
    };
  }, [feed, enabled]);
  useEffect(() => {
    if (enabled) void feed.ensureRange(visibleStart, visibleEnd, focus);
  }, [feed, enabled, visibleStart, visibleEnd, focus, state.loadedEnd]);
  useEffect(() => {
    if (
      !enabled ||
      state.loading ||
      state.error ||
      !feed.metadataPending(visibleStart, visibleEnd)
    )
      return;
    const poll = setTimeout(() => {
      void feed.refreshRange(visibleStart, visibleEnd, true);
    }, 2000);
    return () => clearTimeout(poll);
  }, [
    feed,
    state.revision,
    state.loading,
    state.error,
    visibleStart,
    visibleEnd,
    enabled,
  ]);

  useLayoutEffect(() => {
    const index = navigation.focusId
      ? (feed.indexOf(navigation.focusId) ?? feed.view.focusIndex)
      : 0;
    setFocus(index);
    setViewport({
      scroll: navigation.focusId ? navigation.scroll : 0,
      height: window.innerHeight,
    });
    pendingFocus.current = navigation.focusId
      ? { index, scroll: navigation.scroll }
      : null;
    consumedScroll.current = -1;
  }, [feed]);
  // A replacement may shrink the loaded range. Keep one reachable tab stop
  // without taking DOM focus back from an explicitly selected control.
  useLayoutEffect(() => {
    if (state.total === null || !state.loadedEnd) return;
    setFocus((current) => (current < state.loadedEnd ? current : 0));
    if (feed.view.focusIndex >= state.loadedEnd) feed.view.focusIndex = 0;
    if (pendingFocus.current && pendingFocus.current.index >= state.loadedEnd)
      pendingFocus.current = null;
  }, [feed, state.loadedEnd, state.total]);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(element);
      const tracks = style.gridTemplateColumns.split(' ').filter(Boolean);
      const columns =
        tracks.length && !tracks.includes('none')
          ? tracks.length
          : feed.view.columns;
      const gap = Number.parseFloat(style.rowGap) || 0;
      const card = element.querySelector<HTMLElement>('[data-browse-slot]');
      const stride = Math.max(
        1,
        (card?.getBoundingClientRect().height ?? feed.view.stride - gap) + gap,
      );
      const top = element.getBoundingClientRect().top + window.scrollY;
      Object.assign(feed.view, {
        columns,
        stride,
        gridTop: top,
        scroll: window.scrollY,
      });
      setGeometry((old) =>
        old.columns === columns &&
        Math.abs(old.stride - stride) < 0.5 &&
        Math.abs(old.top - top) < 0.5 &&
        old.gap === gap
          ? old
          : { columns, stride, top, gap },
      );
      setViewport((old) =>
        old.scroll === window.scrollY && old.height === window.innerHeight
          ? old
          : { scroll: window.scrollY, height: window.innerHeight },
      );
    };
    const scroll = () => {
      scrollEpoch.current++;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(frame);
    };
  }, [feed]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const button = buttons.current.get(pending.index);
    if (!button) return;
    pendingFocus.current = null;
    button.focus({ preventScroll: pending.scroll !== undefined });
    if (pending.scroll !== undefined) {
      window.scrollTo(0, pending.scroll);
      feed.view.scroll = pending.scroll;
      setViewport({ scroll: pending.scroll, height: window.innerHeight });
    }
  }, [state.revision, geometry.columns, focus]);
  useEffect(() => {
    const element = sentinel.current;
    if (
      !enabled ||
      !element ||
      state.total === null ||
      state.error ||
      !('IntersectionObserver' in window)
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const current = feed.getSnapshot();
        if (
          !entry.isIntersecting ||
          current.loading ||
          current.error ||
          current.nextOffset === null ||
          consumedScroll.current === scrollEpoch.current
        )
          return;
        consumedScroll.current = scrollEpoch.current;
        void feed.loadNext();
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [feed, enabled, state.loadedEnd, state.loading, state.error, state.total]);

  const replace = (value: Partial<BrowseNavigation>) => {
    setNavigation({
      ...navigation,
      ...value,
      offset: 0,
      focusId: null,
      scroll: 0,
    });
    pendingFocus.current = null;
    setFocus(0);
    window.scrollTo(0, 0);
  };
  const open = (item: FeedItem, index: number) => {
    if (shows)
      replace({
        series: item as SeriesPage['items'][number],
        season: null,
        search: '',
      });
    else {
      Object.assign(feed.view, { focusIndex: index, scroll: window.scrollY });
      void feed.ensureRange(index, index + 1, index);
      setNavigation({
        ...navigation,
        offset: 0,
        focusId: item.id,
        scroll: window.scrollY,
      });
      onSelect(item as Media, index);
    }
  };
  const move = (index: number, preserveScroll = false) => {
    setFocus(index);
    feed.view.focusIndex = index;
    pendingFocus.current = {
      index,
      ...(preserveScroll ? { scroll: window.scrollY } : {}),
    };
    void feed.ensureRange(index, index + 1, index);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'ArrowDown') next = index + geometry.columns;
    else if (event.key === 'ArrowUp')
      next = Math.max(0, index - geometry.columns);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = state.loadedEnd - 1;
    else return;
    event.preventDefault();
    if (next >= state.loadedEnd) {
      if (state.nextOffset !== null) {
        // A held remote key must not retry an outage repeatedly. A new press
        // explicitly retries the failed boundary without moving current focus.
        if (state.error && event.repeat) return;
        const target = next;
        const priorEnd = state.loadedEnd;
        const request = state.error ? feed.retry() : feed.loadNext();
        void request.then(() => {
          if (activeFeed.current !== feed) return;
          const end = feed.getSnapshot().loadedEnd;
          if (end > priorEnd) move(Math.min(target, end - 1));
        });
      }
      return;
    }
    move(Math.max(0, next));
  };
  const rendered: Array<
    | { index: number; item: FeedItem | undefined }
    | { spacer: number; key: number }
  > = [];
  let rowCursor = 0;
  for (const range of ranges) {
    const startRow = Math.floor(range.start / geometry.columns);
    if (startRow > rowCursor)
      rendered.push({
        spacer: Math.max(
          0,
          (startRow - rowCursor) * geometry.stride - geometry.gap,
        ),
        key: rowCursor,
      });
    for (let index = range.start; index < range.end; index++)
      rendered.push({ index, item: feed.itemAt(index) });
    rowCursor = Math.ceil(range.end / geometry.columns);
  }
  const remainingRows = Math.ceil(slots / geometry.columns) - rowCursor;
  if (remainingRows > 0)
    rendered.push({
      spacer: Math.max(0, remainingRows * geometry.stride - geometry.gap),
      key: rowCursor,
    });
  const notice =
    state.error ??
    (libraryNavigation.status ||
      (storageUnavailable
        ? 'Browser storage is unavailable. Browsing remains available for this session.'
        : ''));

  return (
    <div className="library-shell">
      <aside className="library-sidebar">
        <p>YOUR LIBRARY</p>
        <nav aria-label="Collections">
          {visible.map((descriptor) => (
            <button
              key={descriptor.id}
              className={
                descriptor.id === library?.id
                  ? 'collection-link active'
                  : 'collection-link'
              }
              onClick={() =>
                replace({
                  libraryId: libraryNavigation.legacy
                    ? undefined
                    : descriptor.id,
                  revision: libraryNavigation.legacy
                    ? undefined
                    : libraryNavigation.document.revision,
                  collection:
                    descriptor.mediaType === 'mixed'
                      ? 'all'
                      : descriptor.mediaType,
                  series: null,
                  season: null,
                  search: '',
                })
              }
            >
              {descriptor.name}
            </button>
          ))}
        </nav>
        <button
          className="text-button"
          onClick={() => {
            pendingFocus.current = null;
            setSettings((value) => !value);
          }}
        >
          Library settings
        </button>
      </aside>
      <main className="full-library">
        {settings && (
          <LibrarySettings
            document={libraryNavigation.document}
            preferences={libraryNavigation.preferences}
            onPreferences={libraryNavigation.savePreferences}
            onSaved={() => {
              cache.current = {};
              for (const session of sessions.values()) session.feed.pause();
              sessions.clear();
              window.dispatchEvent(new Event('shinema:libraries-refresh'));
            }}
            onClose={() => setSettings(false)}
          />
        )}
        {!navigation.search && (
          <LibraryFeature
            item={first}
            loading={!first && loading}
            progress={first ? progress[first.id] : undefined}
            onOpen={() => {
              if (first) open(first, 0);
            }}
          />
        )}
        <div className="page-title">
          <h1>{navigation.series?.title ?? library?.name ?? 'Library'}</h1>
          <p>
            {summary.value
              ? `${summary.value.movies.toLocaleString()} movies · ${summary.value.tv.toLocaleString()} episodes in ${summary.value.series.toLocaleString()} series`
              : 'Your connected library'}
          </p>
        </div>
        <div className="browse-toolbar">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              replace({ search });
            }}
          >
            <label className="sr-only" htmlFor="library-search">
              Search {shows ? 'series' : 'titles'}
            </label>
            <input
              id="library-search"
              onFocus={() => {
                pendingFocus.current = null;
              }}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={200}
              placeholder={shows ? 'Search series' : 'Search titles'}
            />
            <button className="text-button" type="submit">
              Search
            </button>
          </form>
          <button
            className="text-button"
            onClick={() => {
              pendingFocus.current = null;
              onRefresh?.();
              libraryNavigation.reload();
              setRefresh((value) => value + 1);
              if (enabled)
                void feed.restart().then((success) => {
                  if (success && activeFeed.current === feed) {
                    setFocus(0);
                    pendingFocus.current = null;
                    window.scrollTo(0, 0);
                  }
                });
            }}
          >
            Refresh
          </button>
        </div>
        {navigation.series && (
          <div className="season-toolbar">
            <button
              className="back-button"
              onClick={() =>
                replace({ series: null, season: null, search: '' })
              }
            >
              ← All {library?.name ?? 'TV shows'}
            </button>
            <label>
              Season{' '}
              <select
                aria-label="Season"
                value={navigation.season ?? 'all'}
                onChange={(event) =>
                  replace({
                    season:
                      event.target.value === 'all'
                        ? null
                        : Number(event.target.value),
                  })
                }
              >
                <option value="all">All episodes</option>
                {seasons.value?.items
                  .filter((item) => item.season !== null)
                  .map((item) => (
                    <option key={item.season} value={item.season!}>
                      {item.season === 0 ? 'Specials' : `Season ${item.season}`}{' '}
                      ({item.episodes})
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        <section className="library-section">
          <div className="section-heading">
            <h2>
              {shows ? 'Series' : navigation.series ? 'Episodes' : 'Titles'}{' '}
              <span className="title-count">{state.total ?? '—'}</span>
            </h2>
            <span className="quiet" role="status">
              {loading
                ? 'Loading.'
                : state.error
                  ? 'Browsing interrupted'
                  : !library
                    ? 'No visible libraries'
                    : 'Connected'}
            </span>
          </div>
          <div className="browse-notice-slot" aria-live="polite">
            {notice && <p className="notice">{notice}</p>}
          </div>
          <div
            ref={grid}
            className="poster-grid"
            data-testid="library-feed"
            data-loaded-count={state.loadedEnd}
            data-retained-count={state.retainedCount}
            aria-label="Library titles"
            aria-busy={loading}
            style={{
              minHeight:
                Math.ceil(INITIAL_SLOTS / geometry.columns) * geometry.stride -
                geometry.gap,
            }}
          >
            {rendered.map((slot) => {
              if ('spacer' in slot)
                return (
                  <div
                    key={`space-${slot.key}`}
                    aria-hidden="true"
                    className="browse-spacer"
                    style={{ gridColumn: '1 / -1', height: slot.spacer }}
                  />
                );
              const { index, item: row } = slot;
              if (!row)
                return (
                  <div
                    key={`pending-${index}`}
                    className="media-card media-card--loading"
                    data-browse-slot={index}
                    aria-hidden="true"
                  >
                    <div className="poster skeleton" />
                    <div className="card-copy">
                      <h3>{'\u00a0'}</h3>
                      <span>{'\u00a0'}</span>
                    </div>
                  </div>
                );
              const item = row as Media;
              const series = row as SeriesPage['items'][number];
              const saved = progress[row.id];
              return (
                <button
                  key={row.id}
                  data-browse-id={row.id}
                  data-browse-index={index}
                  data-browse-slot={index}
                  ref={(node) => {
                    if (node) buttons.current.set(index, node);
                    else buttons.current.delete(index);
                  }}
                  className="media-card"
                  tabIndex={index === focus ? 0 : -1}
                  onFocus={() => {
                    setFocus(index);
                    feed.view.focusIndex = index;
                  }}
                  onKeyDown={(event) => key(event, index)}
                  aria-label={`Open ${row.title}`}
                  onClick={() => open(row, index)}
                >
                  <MediaPoster source={row.posterPath} title={row.title} />
                  <div className="card-copy">
                    <h3>{row.title}</h3>
                    <span>
                      {shows
                        ? `${series.episodes} episodes · ${series.seasons} seasons`
                        : saved
                          ? `Resume at ${clock(saved.positionSeconds)}`
                          : item.collection === 'tv'
                            ? `${item.season === undefined ? 'Season unknown' : `S${String(item.season).padStart(2, '0')}`} ${item.episode === undefined ? '' : `E${String(item.episode).padStart(2, '0')}`} · ${item.container.toUpperCase()}`
                            : item.year
                              ? String(item.year)
                              : item.container.toUpperCase()}
                    </span>
                  </div>
                </button>
              );
            })}
            {ready && !library && (
              <p className="empty-state" style={{ gridColumn: '1 / -1' }}>
                No libraries are visible. Open Library settings to change this
                browser’s navigation.
              </p>
            )}
            {enabled && state.total === 0 && (
              <p className="empty-state" style={{ gridColumn: '1 / -1' }}>
                No titles match this search.
              </p>
            )}
          </div>
          <div
            ref={sentinel}
            data-testid="library-sentinel"
            aria-hidden="true"
            style={{ height: 1 }}
          />
          <div className="browse-tail">
            <span role="status">
              {!enabled
                ? ready
                  ? 'Choose a visible library.'
                  : 'Loading libraries.'
                : state.loading
                  ? 'Loading more titles.'
                  : state.error
                    ? 'Loading interrupted.'
                    : state.nextOffset === null
                      ? `All ${(state.total ?? 0).toLocaleString()} titles loaded.`
                      : 'Scroll for more titles.'}
            </span>
            <button
              className="control-button"
              style={{ visibility: state.error ? 'visible' : 'hidden' }}
              disabled={!state.error || state.loading}
              onClick={() => {
                void feed.retry();
              }}
            >
              Retry loading
            </button>
          </div>
        </section>
        <footer>
          <span>Shinema</span>
          <span>Library</span>
        </footer>
        <MetadataCredits />
      </main>
    </div>
  );
}
