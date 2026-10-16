import {
  parseCatalog,
  parseSeasons,
  parseSeriesPage,
  parseSummary,
  visibleLibraries,
} from '../../../packages/contracts/index.ts';
import type {
  Catalog,
  LibrarySummary,
  Series,
  SeriesPage,
  Seasons,
  Libraries,
  NavigationPreferences,
} from '../../../packages/contracts/index.ts';
export type BrowseNavigation = {
  libraryId?: string;
  revision?: number;
  collection: 'movies' | 'tv' | 'all';
  series: Series | null;
  season: number | null;
  offset: number;
  search: string;
  focusId: string | null;
  scroll: number;
};
export const initialBrowse = (): BrowseNavigation => ({
  collection: 'movies',
  series: null,
  season: null,
  offset: 0,
  search: '',
  focusId: null,
  scroll: 0,
});
export type PageValue = (Catalog | SeriesPage | LibrarySummary | Seasons) & {
  metadataPending?: boolean;
};
export type PageCache = Record<string, PageValue>;
export function pageParser(path: string): (value: unknown) => PageValue {
  if (path === '/api/library') return parseSummary;
  if (/^\/api\/series\/[a-f0-9]{64}\/seasons$/.test(path)) return parseSeasons;
  if (path.startsWith('/api/series?') || path.startsWith('/api/catalog?'))
    return (value) => {
      const parsed = path.startsWith('/api/series?')
        ? parseSeriesPage(value)
        : parseCatalog(value);
      const library = new URL(path, 'http://localhost').searchParams.get(
        'library',
      );
      if (library && parsed.items.some((item) => item.libraryId !== library))
        throw new Error('Unexpected library membership');
      return parsed;
    };
  throw new Error('Unsupported browse path');
}
export function recoverPages(raw: string | null): PageCache {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    const entries = Object.entries(parsed).slice(-12);
    const valid: PageCache = {};
    for (const [path, value] of entries) {
      try {
        valid[path] = pageParser(path)(value);
      } catch {
        /* Each corrupt page is isolated. */
      }
    }
    return valid;
  } catch {
    return {};
  }
}
export function rememberPage(
  cache: PageCache,
  path: string,
  value: unknown,
): PageCache {
  const parsed = pageParser(path)(value);
  const next = { ...cache };
  delete next[path];
  next[path] = parsed;
  return Object.fromEntries(Object.entries(next).slice(-12));
}
export function browsePath(nav: BrowseNavigation): string {
  const query = new URLSearchParams({
    offset: String(nav.offset),
    limit: '60',
    search: nav.search,
  });
  if (nav.libraryId) query.set('library', nav.libraryId);
  if (nav.revision !== undefined) query.set('revision', String(nav.revision));
  if (nav.collection === 'tv' && !nav.series) return '/api/series?' + query;
  query.set('collection', nav.collection);
  if (nav.series) query.set('series', nav.series.id);
  if (nav.season !== null) query.set('season', String(nav.season));
  return '/api/catalog?' + query;
}

/** Focus/scroll/internal offsets do not change which library a feed represents. */
export function browseIdentity(nav: BrowseNavigation): string {
  return JSON.stringify([
    nav.libraryId ?? null,
    nav.revision ?? null,
    nav.collection,
    nav.series?.id ?? null,
    nav.season,
    nav.search,
  ]);
}

/** Resolve canonical IDs/scope without deriving either from a display name. */
export function resolveBrowse(
  requested: BrowseNavigation,
  document: Libraries,
  preferences: NavigationPreferences,
  legacy: boolean,
  ready: boolean,
) {
  const visible = visibleLibraries(document.libraries, preferences);
  const library =
    document.libraries.find(
      (item) => item.id === requested.libraryId && item.visible,
    ) ??
    visible.find((item) => item.id === requested.collection) ??
    visible[0];
  const libraryId = legacy ? undefined : library?.id;
  const revision = legacy ? undefined : document.revision;
  const collection = library
    ? library.mediaType === 'mixed'
      ? 'all'
      : library.mediaType
    : requested.collection;
  const changed =
    requested.libraryId !== libraryId ||
    requested.revision !== revision ||
    requested.collection !== collection;
  const navigation: BrowseNavigation = {
    ...requested,
    libraryId,
    revision,
    collection,
    ...(changed
      ? {
          series: null,
          season: null,
          offset: 0,
          search: '',
          focusId: null,
          scroll: 0,
        }
      : {}),
  };
  return { navigation, library, visible, changed, enabled: ready && !!library };
}
