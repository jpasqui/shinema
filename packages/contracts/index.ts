export * from './libraries.ts';
export * from './navigation.ts';
export * from './content.ts';
import { validLibraryId } from './libraries.ts';
import {
  validContentId,
  validContentTypeId,
  validFormatExtension,
  validMimeType,
} from './content.ts';
export type Media = {
  id: string;
  title: string;
  container: string;
  sizeBytes: number;
  streamPath: string;
  /** @deprecated Legacy alias for contentTypeId. */
  collection?: string;
  contentTypeId?: string | null;
  formatId?: string;
  mimeType?: string;
  libraryId?: string;
  seriesId?: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
  posterPath?: string;
  backdropPath?: string;
  summary?: string;
  year?: number;
  genres?: string[];
  fileTitle?: string;
  fileYear?: number;
  metadataSource?: 'tmdb' | 'tvmaze';
  metadataUrl?: string;
  metadataExpiresAt?: number;
};
export type PageInfo = {
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
};
export type Catalog = {
  apiVersion: 1;
  items: Media[];
  fullLibrary?: boolean;
  metadataPending?: boolean;
} & Partial<PageInfo>;
export type Series = {
  id: string;
  title: string;
  libraryId?: string;
  episodes: number;
  seasons: number;
  posterPath?: string;
  fileTitle?: string;
  metadataExpiresAt?: number;
  metadataSource?: 'tmdb' | 'tvmaze';
  metadataUrl?: string;
};
export type SeriesPage = { items: Series[] } & PageInfo;
export type LibrarySummary = {
  total: number;
  tv: number;
  movies: number;
  series: number;
};
export type Seasons = { items: { season: number | null; episodes: number }[] };
export type Progress = { positionSeconds: number; durationSeconds: number };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
export function parseCatalog(value: unknown): Catalog {
  if (
    !object(value) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > 500
  )
    throw new Error('Unsupported catalog');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.title !== 'string' ||
      Array.from(item.title).length > 200 ||
      !validFormatExtension(item.container) ||
      !Number.isSafeInteger(item.sizeBytes) ||
      Number(item.sizeBytes) < 0 ||
      item.streamPath !== `/api/media/${item.id}/stream`
    )
      throw new Error('Invalid catalog item');
    if (item.collection !== undefined && !validContentTypeId(item.collection))
      throw new Error('Invalid collection');
    if (
      item.contentTypeId !== undefined &&
      ((item.contentTypeId !== null &&
        !validContentTypeId(item.contentTypeId)) ||
        (item.collection !== undefined &&
          item.collection !== item.contentTypeId))
    )
      throw new Error('Invalid or conflicting content type identity');
    if (item.formatId !== undefined && !validContentId(item.formatId))
      throw new Error('Invalid format identity');
    if (item.mimeType !== undefined && !validMimeType(item.mimeType))
      throw new Error('Invalid format MIME type');
    if (item.libraryId !== undefined && !validLibraryId(item.libraryId))
      throw new Error('Invalid library identity');
    if (
      item.seriesId !== undefined &&
      (typeof item.seriesId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.seriesId))
    )
      throw new Error('Invalid series');
    if (
      item.seriesTitle !== undefined &&
      (typeof item.seriesTitle !== 'string' ||
        Array.from(item.seriesTitle).length > 200)
    )
      throw new Error('Invalid series title');
    for (const key of ['season', 'episode'])
      if (
        item[key] !== undefined &&
        (!Number.isSafeInteger(item[key]) ||
          Number(item[key]) < 0 ||
          Number(item[key]) > 10000)
      )
        throw new Error('Invalid episode grouping');
    for (const kind of ['poster', 'backdrop']) {
      const path = item[kind + 'Path'];
      if (path !== undefined && path !== `/api/media/${item.id}/${kind}`)
        throw new Error('Invalid artwork path');
    }
    if (
      item.summary !== undefined &&
      (typeof item.summary !== 'string' ||
        Array.from(item.summary).length > 4000)
    )
      throw new Error('Invalid summary');
    if (
      item.year !== undefined &&
      (!Number.isSafeInteger(item.year) ||
        Number(item.year) < 0 ||
        Number(item.year) > 9999)
    )
      throw new Error('Invalid year');
    if (
      item.genres !== undefined &&
      (!Array.isArray(item.genres) ||
        item.genres.length > 12 ||
        item.genres.some(
          (genre) => typeof genre !== 'string' || Array.from(genre).length > 80,
        ))
    )
      throw new Error('Invalid genres');
    validateProvenance(item);
    ids.add(item.id);
  }
  if (
    ['total', 'offset', 'limit', 'nextOffset'].some(
      (key) => value[key] !== undefined,
    )
  )
    validatePage(value, value.items.length);
  for (const key of ['fullLibrary', 'metadataPending'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new Error('Invalid catalog state');
  const items = (value.items as Media[]).map((raw) => {
    const item: Media = {
      ...raw,
      contentTypeId:
        raw.contentTypeId !== undefined
          ? raw.contentTypeId
          : (raw.collection ?? null),
    };
    if (
      item.metadataExpiresAt === undefined ||
      item.metadataExpiresAt > Date.now() / 1000
    )
      return item;
    const {
      fileTitle,
      fileYear,
      metadataExpiresAt: _metadataExpiresAt,
      metadataSource: _metadataSource,
      metadataUrl: _metadataUrl,
      posterPath: _posterPath,
      backdropPath: _backdropPath,
      summary: _summary,
      year: _year,
      genres: _genres,
      ...local
    } = item;
    return {
      ...local,
      title: fileTitle ?? 'Saved title',
      ...(fileYear !== undefined ? { year: fileYear } : {}),
    };
  });
  return { ...value, items } as Catalog;
}
function validateProvenance(item: Record<string, unknown>): void {
  if (
    item.fileTitle !== undefined &&
    (typeof item.fileTitle !== 'string' ||
      Array.from(item.fileTitle).length > 200)
  )
    throw new Error('Invalid file title');
  if (
    item.fileYear !== undefined &&
    (!Number.isSafeInteger(item.fileYear) ||
      Number(item.fileYear) < 0 ||
      Number(item.fileYear) > 9999)
  )
    throw new Error('Invalid file year');
  if (
    item.metadataExpiresAt !== undefined &&
    (!Number.isSafeInteger(item.metadataExpiresAt) ||
      Number(item.metadataExpiresAt) < 0)
  )
    throw new Error('Invalid metadata expiry');
  if (
    item.metadataSource !== undefined &&
    (!['tmdb', 'tvmaze'].includes(String(item.metadataSource)) ||
      item.metadataExpiresAt === undefined ||
      item.fileTitle === undefined)
  )
    throw new Error('Invalid metadata provenance');
  if (item.metadataUrl !== undefined) {
    if (
      typeof item.metadataUrl !== 'string' ||
      !(
        (item.metadataSource === 'tmdb' &&
          /^https:\/\/www\.themoviedb\.org\/(movie|tv)\/\d+$/.test(
            item.metadataUrl,
          )) ||
        (item.metadataSource === 'tvmaze' &&
          /^https:\/\/www\.tvmaze\.com\/shows\/\d+$/.test(item.metadataUrl))
      )
    )
      throw new Error('Invalid metadata source link');
  }
}
function validatePage(value: Record<string, unknown>, count: number): void {
  for (const key of ['total', 'offset', 'limit'])
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
      throw new Error('Invalid page');
  if (
    Number(value.limit) < 1 ||
    Number(value.limit) > 500 ||
    count > Number(value.limit) ||
    count > Number(value.total) ||
    Number(value.offset) > 10000000
  )
    throw new Error('Invalid page bounds');
  if (
    value.nextOffset === null &&
    Number(value.offset) + count < Number(value.total)
  )
    throw new Error('Missing next page');
  if (
    value.nextOffset !== null &&
    (!Number.isSafeInteger(value.nextOffset) ||
      value.nextOffset !== Number(value.offset) + count ||
      count === 0 ||
      Number(value.nextOffset) >= Number(value.total))
  )
    throw new Error('Invalid next page');
}
export function parseSeriesPage(value: unknown): SeriesPage {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 500)
    throw new Error('Invalid series page');
  validatePage(value, value.items.length);
  const ids = new Set<string>();
  for (const item of value.items) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.title !== 'string' ||
      Array.from(item.title).length > 200 ||
      !Number.isSafeInteger(item.episodes) ||
      Number(item.episodes) < 1 ||
      !Number.isSafeInteger(item.seasons) ||
      Number(item.seasons) < 0
    )
      throw new Error('Invalid series');
    if (
      item.posterPath !== undefined &&
      (typeof item.posterPath !== 'string' ||
        !/^\/api\/media\/[a-f0-9]{64}\/poster$/.test(item.posterPath))
    )
      throw new Error('Invalid series poster');
    if (item.libraryId !== undefined && !validLibraryId(item.libraryId))
      throw new Error('Invalid series library identity');
    validateProvenance(item);
    ids.add(item.id);
  }
  const items = (value.items as Series[]).map((item) => {
    if (
      item.metadataExpiresAt === undefined ||
      item.metadataExpiresAt > Date.now() / 1000
    )
      return item;
    return {
      id: item.id,
      title: item.fileTitle ?? 'Saved series',
      ...(item.libraryId !== undefined ? { libraryId: item.libraryId } : {}),
      episodes: item.episodes,
      seasons: item.seasons,
    };
  });
  return { ...value, items } as SeriesPage;
}
export function parseSummary(value: unknown): LibrarySummary {
  if (
    !object(value) ||
    ['total', 'tv', 'movies', 'series'].some(
      (key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0,
    ) ||
    Number(value.tv) + Number(value.movies) > Number(value.total)
  )
    throw new Error('Invalid summary');
  return value as LibrarySummary;
}
export function parseSeasons(value: unknown): Seasons {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 10001
  )
    throw new Error('Invalid seasons');
  const seen = new Set<number | null>();
  for (const item of value.items) {
    if (
      !object(item) ||
      (item.season !== null &&
        (!Number.isSafeInteger(item.season) ||
          Number(item.season) < 0 ||
          Number(item.season) > 10000)) ||
      !Number.isSafeInteger(item.episodes) ||
      Number(item.episodes) < 1 ||
      seen.has(item.season as number | null)
    )
      throw new Error('Invalid season');
    seen.add(item.season as number | null);
  }
  return value as Seasons;
}
export function parseProgress(value: unknown): Progress | null {
  if (value === null) return null;
  if (
    !object(value) ||
    typeof value.positionSeconds !== 'number' ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.positionSeconds) ||
    !Number.isFinite(value.durationSeconds) ||
    value.positionSeconds < 0 ||
    value.durationSeconds <= 0 ||
    value.durationSeconds > 604800 ||
    value.positionSeconds > value.durationSeconds
  )
    throw new Error('Invalid progress');
  return {
    positionSeconds: value.positionSeconds,
    durationSeconds: value.durationSeconds,
  };
}
export function serverOrigin(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('Use an HTTPS server origin without credentials or a path');
  return url.origin;
}
export function resumeAt(progress: Progress | null, duration: number): number {
  return progress && progress.positionSeconds < duration - 3
    ? Math.min(progress.positionSeconds, duration)
    : 0;
}

export type Playback = {
  durationSeconds: number;
  mode: 'direct' | 'transcode';
  streamPath: string;
};
export function parsePlayback(value: unknown, id: string): Playback {
  if (
    !/^[a-f0-9]{64}$/.test(id) ||
    !object(value) ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    value.durationSeconds > 604800 ||
    !['direct', 'transcode'].includes(String(value.mode)) ||
    value.streamPath !==
      (value.mode === 'direct'
        ? `/api/media/${id}/stream`
        : `/api/media/${id}/hls/index.m3u8`)
  )
    throw new Error('Invalid playback descriptor');
  return value as Playback;
}
