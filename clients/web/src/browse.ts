import {
  parseCatalog,
  parseSeasons,
  parseSeriesPage,
  parseSummary,
} from '../../../packages/contracts/index.ts';
import type {
  Catalog,
  LibrarySummary,
  Series,
  SeriesPage,
  Seasons,
} from '../../../packages/contracts/index.ts';
export type BrowseNavigation = {
  collection: 'movies' | 'tv' | 'all';
  libraryId?: string;
  revision?: number;
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
