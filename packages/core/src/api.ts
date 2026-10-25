import {
  parseCatalog,
  parseLibraries,
  parsePlayback,
  parseSeasons,
  parseSeriesPage,
  parseSubtitles,
  parseSummary,
  type Catalog,
  type Libraries,
  type Playback,
  type Seasons,
  type SeriesPage,
  type Subtitles,
  type LibrarySummary,
} from '../../contracts/index.ts';
import { parseContinue, type ContinueItem } from './continue.ts';
import { parseProgress, type Progress } from './progress-types.ts';

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type ApiErrorKind =
  | 'network' // no response: offline, wrong address, timeout
  | 'unauthorized' // token missing, wrong or revoked: pair again
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'rateLimited'
  | 'invalid' // the server answered with something this client cannot use
  | 'server';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  constructor(kind: ApiErrorKind, status: number | null, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const kindFor = (status: number): ApiErrorKind =>
  status === 401
    ? 'unauthorized'
    : status === 403
      ? 'forbidden'
      : status === 404
        ? 'notFound'
        : status === 409
          ? 'conflict'
          : status === 429
            ? 'rateLimited'
            : status >= 400 && status < 500
              ? 'invalid'
              : 'server';

export type Health = { apiVersion: 1; authRequired: boolean };
export type Session = {
  authRequired: boolean;
  deviceId: string | null;
  deviceName: string | null;
};
export type PairedDevice = { deviceId: string; name: string; token: string };
export type CatalogQuery = {
  library?: string;
  series?: string;
  season?: number;
  search?: string;
  offset?: number;
  limit?: number;
};
export type ProgressSave =
  { status: 'saved' } | { status: 'newerOnServer'; current: Progress | null };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const ID = /^[a-f0-9]{64}$/;

export type ApiOptions = {
  origin: string;
  token?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
};

/** A thin, validating client for the Shinema server's API version 1. */
export class ShinemaApi {
  readonly origin: string;
  readonly token: string | null;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ApiOptions) {
    this.origin = options.origin.replace(/\/$/, '');
    this.token = options.token ?? null;
    // Browsers reject fetch called as a method of another object
    // ("Illegal invocation"), so the default calls it through globalThis.
    this.fetcher =
      options.fetch ??
      ((input, init) => (globalThis.fetch as FetchLike)(input, init));
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  withToken(token: string | null): ShinemaApi {
    return new ShinemaApi({
      origin: this.origin,
      token,
      fetch: this.fetcher,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * A URL for elements that cannot send headers (video, image, subtitle
   * track). The token travels as `access_token`, which the server accepts
   * only on these read-only media routes.
   */
  mediaUrl(path: string, options: { width?: number } = {}): string {
    if (!/^\/api\/media\/[a-f0-9]{64}\/[a-z0-9./-]+$/.test(path))
      throw new ApiError('invalid', null, 'Unexpected media path');
    const url = new URL(this.origin + path);
    if (options.width !== undefined)
      url.searchParams.set('w', String(Math.round(options.width)));
    if (this.token) url.searchParams.set('access_token', this.token);
    return url.toString();
  }

  /** Headers for native players that can send them (ExoPlayer, AVPlayer). */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; value: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...this.authHeaders(),
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try {
        response = await this.fetcher(this.origin + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        if (signal?.aborted) throw new ApiError('network', null, 'Canceled');
        throw new ApiError(
          'network',
          null,
          'Could not reach the server. Check the address and that the server is running.',
        );
      }
      const value =
        response.status === 204
          ? null
          : await response.json().catch(() => undefined);
      return { status: response.status, value };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async get<T>(
    path: string,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const { status, value } = await this.request(
      'GET',
      path,
      undefined,
      signal,
    );
    if (status < 200 || status >= 300)
      throw new ApiError(kindFor(status), status, `Request failed (${status})`);
    try {
      return parse(value);
    } catch (error) {
      throw new ApiError(
        'invalid',
        status,
        error instanceof Error ? error.message : 'Invalid response',
      );
    }
  }

  health(signal?: AbortSignal): Promise<Health> {
    return this.get(
      '/health',
      (value) => {
        if (!object(value) || value.apiVersion !== 1)
          throw new Error('This is not a compatible Shinema server.');
        return { apiVersion: 1, authRequired: value.authRequired === true };
      },
      signal,
    );
  }

  session(signal?: AbortSignal): Promise<Session> {
    return this.get(
      '/api/session',
      (value) => {
        if (!object(value) || typeof value.authRequired !== 'boolean')
          throw new Error('Invalid session');
        const text = (field: unknown) =>
          typeof field === 'string' ? field : null;
        return {
          authRequired: value.authRequired,
          deviceId: text(value.deviceId),
          deviceName: text(value.deviceName),
        };
      },
      signal,
    );
  }

  async claimPairing(code: string, deviceName: string): Promise<PairedDevice> {
    const { status, value } = await this.request('POST', '/api/pairing/claim', {
      code,
      deviceName,
    });
    if (status === 403)
      throw new ApiError(
        'forbidden',
        status,
        'That code did not work. Codes last 10 minutes and work once.',
      );
    if (status === 429)
      throw new ApiError(
        'rateLimited',
        status,
        'Too many attempts. Wait a minute and try again.',
      );
    if (status !== 201 || !object(value))
      throw new ApiError(kindFor(status), status, `Pairing failed (${status})`);
    if (
      typeof value.deviceId !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.token)
    )
      throw new ApiError('invalid', status, 'Invalid pairing response');
    return { deviceId: value.deviceId, name: value.name, token: value.token };
  }

  libraries(signal?: AbortSignal): Promise<Libraries> {
    return this.get('/api/libraries', parseLibraries, signal);
  }

  summary(signal?: AbortSignal): Promise<LibrarySummary> {
    return this.get('/api/library', parseSummary, signal);
  }

  catalog(query: CatalogQuery, signal?: AbortSignal): Promise<Catalog> {
    return this.get(`/api/catalog${queryString(query)}`, parseCatalog, signal);
  }

  series(query: CatalogQuery, signal?: AbortSignal): Promise<SeriesPage> {
    return this.get(
      `/api/series${queryString(query)}`,
      parseSeriesPage,
      signal,
    );
  }

  seasons(seriesId: string, signal?: AbortSignal): Promise<Seasons> {
    if (!ID.test(seriesId))
      throw new ApiError('invalid', null, 'Invalid series');
    return this.get(`/api/series/${seriesId}/seasons`, parseSeasons, signal);
  }

  playback(id: string, signal?: AbortSignal): Promise<Playback> {
    if (!ID.test(id)) throw new ApiError('invalid', null, 'Invalid media');
    return this.get(
      `/api/media/${id}/playback`,
      (value) => parsePlayback(value, id),
      signal,
    );
  }

  subtitles(id: string, signal?: AbortSignal): Promise<Subtitles> {
    if (!ID.test(id)) throw new ApiError('invalid', null, 'Invalid media');
    return this.get(
      `/api/media/${id}/subtitles`,
      (value) => parseSubtitles(value, id),
      signal,
    );
  }

  /** Titles started but not finished, most recently watched first. */
  continueWatching(limit = 20, signal?: AbortSignal): Promise<ContinueItem[]> {
    return this.get(`/api/continue?limit=${limit}`, parseContinue, signal);
  }

  progress(id: string, signal?: AbortSignal): Promise<Progress | null> {
    if (!ID.test(id)) throw new ApiError('invalid', null, 'Invalid media');
    return this.get(`/api/media/${id}/progress`, parseProgress, signal);
  }

  async saveProgress(id: string, progress: Progress): Promise<ProgressSave> {
    if (!ID.test(id)) throw new ApiError('invalid', null, 'Invalid media');
    const { status, value } = await this.request(
      'PUT',
      `/api/media/${id}/progress`,
      progress,
    );
    if (status === 204) return { status: 'saved' };
    if (status === 409) {
      try {
        return { status: 'newerOnServer', current: parseProgress(value) };
      } catch {
        return { status: 'newerOnServer', current: null };
      }
    }
    throw new ApiError(
      kindFor(status),
      status,
      `Saving progress failed (${status})`,
    );
  }
}

function queryString(query: CatalogQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}
