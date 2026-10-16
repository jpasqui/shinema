import { MetadataCredits } from './MetadataCredits.tsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type {
  Catalog,
  LibrarySummary,
  Media,
  SeriesPage,
  Seasons,
  Progress,
} from '../../../packages/contracts/index.ts';
import { MediaPoster } from './MediaPoster.tsx';
import {
  browsePath,
  pageParser,
  recoverPages,
  rememberPage,
} from './browse.ts';
import type { BrowseNavigation, PageCache, PageValue } from './browse.ts';
import { clock } from './model.ts';
import {
  libraryContentSupport,
  mediaContentSupport,
  visibleLibraries,
} from '../../../packages/contracts/index.ts';
import { libraryBrowseCollection, useLibraries } from './libraries.ts';
import { LibrarySettings } from './LibrarySettings.tsx';

const cacheKey = 'shinema.web.browse.v1';
function usePage<T extends PageValue>(
  path: string | null,
  cache: RefObject<PageCache>,
): {
  value: T | undefined;
  loading: boolean;
  offline: boolean;
  storageError: boolean;
} {
  const [state, setState] = useState({
    path,
    value: (path ? cache.current[path] : undefined) as T | undefined,
    loading: true,
    offline: false,
    storageError: false,
  });
  useEffect(() => {
    if (!path) {
      setState({
        path,
        value: undefined,
        loading: false,
        offline: false,
        storageError: false,
      });
      return;
    }
    let current = true;
    let generation = 0;
    let controller: AbortController | null = null;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const ticket = ++generation;
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      setState({
        path,
        value: cache.current[path] as T | undefined,
        loading: true,
        offline: false,
        storageError: false,
      });
      const deadline = setTimeout(() => {
        if (current && ticket === generation) {
          generation++;
          request.abort();
          setState({
            path,
            value: cache.current[path] as T | undefined,
            loading: false,
            offline: true,
            storageError: false,
          });
        }
      }, 10000);
      try {
        const response = await fetch(path, {
          signal: request.signal,
          priority: 'high',
        });
        if (response.status === 409)
          window.dispatchEvent(new Event('shinema:libraries-refresh'));
        if (!response.ok) throw new Error('Browse request failed');
        const value = pageParser(path)(await response.json()) as T;
        if (!current || ticket !== generation) return;
        cache.current = rememberPage(cache.current, path, value);
        let storageError = false;
        try {
          localStorage.setItem(cacheKey, JSON.stringify(cache.current));
        } catch {
          storageError = true;
        }
        setState({ path, value, loading: false, offline: false, storageError });
        if ('metadataPending' in value && value.metadataPending)
          poll = setTimeout(() => {
            void load();
          }, 2000);
      } catch {
        if (current && ticket === generation)
          setState({
            path,
            value: cache.current[path] as T | undefined,
            loading: false,
            offline: true,
            storageError: false,
          });
      } finally {
        clearTimeout(deadline);
      }
    };
    void load();
    const online = () => {
      clearTimeout(poll);
      void load();
    };
    window.addEventListener('online', online);
    return () => {
      current = false;
      generation++;
      controller?.abort();
      clearTimeout(poll);
      window.removeEventListener('online', online);
    };
  }, [path, cache]);
  if (state.path !== path)
    return {
      value: (path ? cache.current[path] : undefined) as T | undefined,
      loading: !!path,
      offline: false,
      storageError: false,
    };
  return state;
}
export function LibraryBrowser({
  navigation,
  setNavigation,
  onSelect,
  progress,
}: {
  navigation: BrowseNavigation;
  setNavigation: (value: BrowseNavigation) => void;
  onSelect: (item: Media, index: number) => void;
  progress: Record<string, Progress>;
}) {
  const cache = useRef<PageCache>({});
  const loaded = useRef(false);
  if (!loaded.current) {
    try {
      cache.current = recoverPages(localStorage.getItem(cacheKey));
      localStorage.setItem(cacheKey, JSON.stringify(cache.current));
    } catch {
      cache.current = {};
    }
    loaded.current = true;
  }
  const [search, setSearch] = useState(navigation.search);
  const libraries = useLibraries();
  const [settings, setSettings] = useState(false);
  const [unsupportedItem, setUnsupportedItem] = useState('');
  const restoreFocus = useRef(true);
  useEffect(() => {
    const open = () => {
      restoreFocus.current = false;
      setSettings(true);
    };
    const search = () => {
      restoreFocus.current = false;
      document.getElementById('library-search')?.focus();
    };
    window.addEventListener('shinema:library-settings', open);
    window.addEventListener('shinema:library-search', search);
    return () => {
      window.removeEventListener('shinema:library-settings', open);
      window.removeEventListener('shinema:library-search', search);
    };
  }, []);
  const visible = visibleLibraries(
    libraries.document.libraries,
    libraries.preferences,
  );
  const active =
    libraries.document.libraries.find(
      (item) => item.id === navigation.libraryId && item.visible,
    ) ??
    visible.find((item) => item.id === navigation.collection) ??
    visible[0];
  const support = active
    ? libraryContentSupport(active, libraries.document.registry)
    : { supported: false, reason: '' };
  useEffect(() => {
    if (!active) return;
    const collection = libraryBrowseCollection(active);
    const libraryId = libraries.legacy ? undefined : active.id;
    const revision = libraries.legacy ? undefined : libraries.document.revision;
    if (
      navigation.libraryId !== libraryId ||
      navigation.revision !== revision ||
      navigation.collection !== collection
    )
      setNavigation({
        ...navigation,
        libraryId,
        revision,
        collection,
        series: null,
        season: null,
        offset: 0,
        search: '',
        focusId: null,
        scroll: 0,
      });
  }, [
    active?.id,
    active?.mediaType,
    active?.contentTypeId,
    libraries.document.revision,
    libraries.legacy,
    navigation,
    setNavigation,
  ]);
  const [refresh, setRefresh] = useState(0);
  const path =
    !active ||
    !support.supported ||
    (libraries.document.revision === 0 && !libraries.legacy)
      ? null
      : browsePath({
          ...navigation,
          libraryId: libraries.legacy ? undefined : active.id,
          revision: libraries.legacy ? undefined : libraries.document.revision,
          collection: libraryBrowseCollection(active),
        });
  const page = usePage<Catalog | SeriesPage>(path, cache);
  const summary = usePage<LibrarySummary>('/api/library', cache);
  const seasonCache = usePage<Seasons>(
    support.supported && navigation.series
      ? `/api/series/${navigation.series.id}/seasons`
      : null,
    cache,
  );
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    setSearch(navigation.search);
  }, [navigation.search]);
  useEffect(() => {
    if (refresh) window.dispatchEvent(new Event('online'));
  }, [refresh]);
  const rows = active && support.supported ? (page.value?.items ?? []) : [];
  const shows = navigation.collection === 'tv' && !navigation.series;
  const replace = (value: Partial<BrowseNavigation>) => {
    setUnsupportedItem('');
    setNavigation({ ...navigation, ...value, focusId: null, scroll: 0 });
    setFocus(0);
    window.scrollTo(0, 0);
  };
  // Roving tab state still follows new/shrunken pages without moving DOM focus.
  // Keep these before Back restoration so a saved card wins on remount.
  useLayoutEffect(() => setFocus(0), [path]);
  useLayoutEffect(
    () => setFocus((current) => (current >= rows.length ? 0 : current)),
    [rows.length],
  );
  useLayoutEffect(() => {
    if (!rows.length || !restoreFocus.current) return;
    restoreFocus.current = false;
    const index = rows.findIndex(
      (item) => 'id' in item && item.id === navigation.focusId,
    );
    if (index >= 0) {
      setFocus(index);
      buttons.current[index]?.focus({ preventScroll: true });
      window.scrollTo(0, navigation.scroll);
    } else {
      setFocus(0);
    }
  }, [page.value, navigation.focusId, navigation.scroll]);
  const key = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'ArrowRight')
      next = Math.min(rows.length - 1, index + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rect = buttons.current[index]?.getBoundingClientRect();
      if (!rect) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const center = rect.x + rect.width / 2;
      const options = buttons.current
        .map((button, i) => ({ i, rect: button?.getBoundingClientRect() }))
        .filter((row) => row.rect && (row.rect.y - rect.y) * direction > 10);
      options.sort(
        (a, b) =>
          Math.abs(a.rect!.y - rect.y) - Math.abs(b.rect!.y - rect.y) ||
          Math.abs(a.rect!.x + a.rect!.width / 2 - center) -
            Math.abs(b.rect!.x + b.rect!.width / 2 - center),
      );
      next = options[0]?.i ?? index;
    } else return;
    event.preventDefault();
    setFocus(next);
    buttons.current[next]?.focus();
  };
  return (
    <div className="library-shell">
      <aside className="library-sidebar">
        <p>YOUR LIBRARY</p>
        <nav aria-label="Collections">
          {visible.map((item) => (
            <button
              key={item.id}
              className={
                active?.id === item.id
                  ? 'collection-link active'
                  : 'collection-link'
              }
              onClick={() =>
                replace({
                  libraryId: libraries.legacy ? undefined : item.id,
                  revision: libraries.legacy
                    ? undefined
                    : libraries.document.revision,
                  collection: libraryBrowseCollection(item),
                  series: null,
                  season: null,
                  offset: 0,
                  search: '',
                })
              }
            >
              {item.name}
            </button>
          ))}
        </nav>
        <button
          className="text-button"
          onClick={() => {
            restoreFocus.current = false;
            setSettings((value) => !value);
          }}
        >
          Library settings
        </button>
      </aside>
      <main className="full-library">
        {settings && (
          <LibrarySettings
            document={libraries.document}
            preferences={libraries.preferences}
            onPreferences={libraries.savePreferences}
            onSaved={() => {
              cache.current = {};
              window.dispatchEvent(new Event('shinema:libraries-refresh'));
            }}
            onClose={() => setSettings(false)}
          />
        )}
        {libraries.status && (
          <p className="notice" role="status">
            {libraries.status}
          </p>
        )}
        {!active && (
          <p className="empty-state">
            No libraries are visible. Open Library settings to change this
            browser’s navigation.
          </p>
        )}
        <div className="page-title">
          <h1>
            {navigation.series?.title ?? active?.name ?? 'Your libraries'}
          </h1>
          <p>
            {summary.value
              ? `${summary.value.movies.toLocaleString()} movies · ${summary.value.tv.toLocaleString()} episodes in ${summary.value.series.toLocaleString()} series`
              : 'Your connected library'}
          </p>
        </div>
        {active && !support.supported && (
          <section className="empty-state" aria-label="Unsupported library">
            <h2>This content type is unavailable</h2>
            <p>{support.reason}</p>
            <p>
              This library and its saved progress are retained. A compatible
              server handler and client renderer are required to use it.
            </p>
          </section>
        )}
        {unsupportedItem && (
          <p className="notice" role="status">
            {unsupportedItem}
          </p>
        )}
        <div className="browse-toolbar">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              replace({ search, offset: 0 });
            }}
          >
            <label className="sr-only" htmlFor="library-search">
              Search {shows ? 'series' : 'titles'}
            </label>
            <input
              id="library-search"
              disabled={!support.supported}
              onFocus={() => {
                restoreFocus.current = false;
              }}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={200}
              placeholder={shows ? 'Search series' : 'Search titles'}
            />
            <button
              className="text-button"
              type="submit"
              disabled={!support.supported}
            >
              Search
            </button>
          </form>
          <button
            className="text-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh
          </button>
        </div>
        {navigation.series && (
          <div className="season-toolbar">
            <button
              className="back-button"
              onClick={() =>
                replace({ series: null, season: null, offset: 0, search: '' })
              }
            >
              &larr; All {active?.name ?? 'series'}
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
                    offset: 0,
                  })
                }
              >
                <option value="all">All episodes</option>
                {seasonCache.value?.items
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
        {support.supported && (
          <section className="library-section">
            <div className="section-heading">
              <h2>
                {shows ? 'Series' : navigation.series ? 'Episodes' : 'Titles'}{' '}
                <span className="title-count">{page.value?.total ?? 0}</span>
              </h2>
              <span className="quiet" role="status">
                {page.loading
                  ? 'Loading…'
                  : page.offline
                    ? 'Cached browsing'
                    : 'Connected'}
              </span>
            </div>
            {page.offline && (
              <p className="notice">
                {page.value
                  ? 'The server is unavailable. This saved page is still here.'
                  : 'The server is unavailable and this page has not been saved yet.'}
              </p>
            )}
            {page.storageError && (
              <p className="notice" role="alert">
                Browser storage is unavailable. This page will only stay cached
                for this session.
              </p>
            )}
            {!page.value && page.loading ? (
              <div
                className="poster-grid"
                aria-label="Loading library"
                aria-busy="true"
              >
                {[0, 1, 2, 3].map((i) => (
                  <div className="skeleton" key={i} />
                ))}
              </div>
            ) : (
              <div className="poster-grid">
                {rows.map((row, index) => {
                  const item = row as Media;
                  const series = row as SeriesPage['items'][number];
                  const saved = progress[row.id];
                  const itemSupport = shows
                    ? { supported: true, reason: undefined }
                    : mediaContentSupport(item, libraries.document.registry);
                  return (
                    <button
                      key={row.id}
                      data-browse-id={row.id}
                      ref={(node) => {
                        buttons.current[index] = node;
                      }}
                      className="media-card"
                      tabIndex={index === focus ? 0 : -1}
                      onFocus={() => setFocus(index)}
                      onKeyDown={(event) => key(event, index)}
                      aria-label={`Open ${row.title}`}
                      aria-disabled={!itemSupport.supported}
                      onClick={() => {
                        if (shows) {
                          replace({
                            series,
                            season: null,
                            search: '',
                            offset: 0,
                          });
                        } else {
                          if (!itemSupport.supported) {
                            setUnsupportedItem(
                              itemSupport.reason ??
                                'This format is unavailable.',
                            );
                            return;
                          }
                          setNavigation({
                            ...navigation,
                            focusId: item.id,
                            scroll: window.scrollY,
                          });
                          onSelect(item, index);
                        }
                      }}
                    >
                      <MediaPoster
                        key={`${row.id}:${refresh}`}
                        source={row.posterPath}
                        title={row.title}
                      />
                      <div className="card-copy">
                        <h3>{row.title}</h3>
                        <span>
                          {!itemSupport.supported
                            ? 'Unsupported content or format'
                            : shows
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
              </div>
            )}
            {!page.loading && page.value && !rows.length && (
              <p className="empty-state">No titles match this search.</p>
            )}
            <div className="pagination" aria-label="Library pages">
              <button
                className="control-button"
                disabled={navigation.offset === 0 || page.loading}
                onClick={() =>
                  replace({ offset: Math.max(0, navigation.offset - 60) })
                }
              >
                Previous page
              </button>
              <span>
                {page.value?.total
                  ? `${navigation.offset + 1}–${navigation.offset + rows.length} of ${page.value.total}`
                  : '0 titles'}
              </span>
              <button
                className="control-button"
                disabled={page.value?.nextOffset == null || page.loading}
                onClick={() => replace({ offset: page.value!.nextOffset! })}
              >
                Next page
              </button>
            </div>
          </section>
        )}
        <footer>
          <span>Shinema</span>
          <span>Library</span>
        </footer>
        <MetadataCredits />
      </main>
    </div>
  );
}
