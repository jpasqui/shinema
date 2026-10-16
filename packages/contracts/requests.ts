import { serverOrigin } from './index.ts';

export type RequestKind = 'movie' | 'series';
export type RequestStatus = 'requested' | 'available' | 'uncertain' | 'failed';
export type RequestCandidate = {
  kind: RequestKind;
  externalId: number;
  title: string;
  year?: number;
  overview: string;
  status: RequestStatus | 'not_requested';
  requestId?: string;
};
export type RequestRecord = {
  id: string;
  kind: RequestKind;
  externalId: number;
  title: string;
  year?: number;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  message?: string;
};
export type RequestCapabilities = {
  apiVersion: 1;
  enabled: boolean;
  authentication: 'bearer';
  providers: { kind: RequestKind; enabled: boolean }[];
};
export type SonarrCompatibility = {
  apiVersion: 1;
  enabled: boolean;
  status: 'ready' | 'disabled' | 'unavailable' | 'unsupported';
  version?: string;
  apiVersionPath?: 'v3' | 'v5';
  preview: boolean;
  metadataLanguage?: 'English';
  episodeOrder?: 'Official';
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Array.from(value).length <= max;
const integer = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;
const kind = (value: unknown): value is RequestKind =>
  value === 'movie' || value === 'series';
const status = (value: unknown): value is RequestStatus =>
  typeof value === 'string' &&
  ['requested', 'available', 'uncertain', 'failed'].includes(value);

function identity(value: unknown) {
  if (
    !record(value) ||
    !kind(value.kind) ||
    !integer(value.externalId, 1) ||
    value.externalId > 2147483647 ||
    !text(value.title, 200) ||
    !value.title.trim() ||
    (value.year !== undefined && (!integer(value.year) || value.year > 9999))
  )
    throw new Error('Invalid request identity');
  return {
    kind: value.kind,
    externalId: value.externalId,
    title: value.title,
    ...(value.year === undefined ? {} : { year: value.year as number }),
  };
}

export function parseRequestCandidate(value: unknown): RequestCandidate {
  const base = identity(value);
  if (
    !record(value) ||
    !text(value.overview, 4000) ||
    !(status(value.status) || value.status === 'not_requested') ||
    (value.requestId !== undefined && !text(value.requestId, 128))
  )
    throw new Error('Invalid request candidate');
  return {
    ...base,
    overview: value.overview,
    status: value.status,
    ...(value.requestId === undefined
      ? {}
      : { requestId: value.requestId as string }),
  };
}

export function parseRequestRecord(value: unknown): RequestRecord {
  const base = identity(value);
  if (
    !record(value) ||
    !text(value.id, 128) ||
    !value.id ||
    !status(value.status) ||
    !integer(value.createdAt) ||
    !integer(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    (value.message !== undefined && !text(value.message, 500))
  )
    throw new Error('Invalid request record');
  return {
    ...base,
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.message === undefined
      ? {}
      : { message: value.message as string }),
  };
}

export function parseRequestCapabilities(value: unknown): RequestCapabilities {
  if (
    !record(value) ||
    value.apiVersion !== 1 ||
    typeof value.enabled !== 'boolean' ||
    value.authentication !== 'bearer' ||
    !Array.isArray(value.providers) ||
    value.providers.length > 2 ||
    value.providers.some(
      (provider) =>
        !record(provider) ||
        !kind(provider.kind) ||
        typeof provider.enabled !== 'boolean',
    ) ||
    new Set(value.providers.map((provider) => provider.kind)).size !==
      value.providers.length
  )
    throw new Error('Invalid request capabilities');
  return {
    apiVersion: 1,
    enabled: value.enabled,
    authentication: 'bearer',
    providers: value.providers.map((provider) => ({
      kind: provider.kind,
      enabled: provider.enabled,
    })),
  };
}

export function parseSonarrCompatibility(value: unknown): SonarrCompatibility {
  if (
    !record(value) ||
    value.apiVersion !== 1 ||
    typeof value.enabled !== 'boolean' ||
    typeof value.status !== 'string' ||
    !['ready', 'disabled', 'unavailable', 'unsupported'].includes(
      value.status,
    ) ||
    typeof value.preview !== 'boolean' ||
    (value.version !== undefined &&
      (typeof value.version !== 'string' ||
        value.version.length > 43 ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
          value.version,
        ) ||
        value.version.split('.').some((part) => Number(part) > 2147483647))) ||
    (value.apiVersionPath !== undefined &&
      value.apiVersionPath !== 'v3' &&
      value.apiVersionPath !== 'v5') ||
    (value.metadataLanguage !== undefined &&
      value.metadataLanguage !== 'English') ||
    (value.episodeOrder !== undefined && value.episodeOrder !== 'Official')
  )
    throw new Error('Invalid Sonarr compatibility');
  const ready = value.status === 'ready';
  const modern = value.apiVersionPath === 'v5';
  if (
    (value.status === 'disabled') !== !value.enabled ||
    (ready &&
      (!value.version ||
        !value.apiVersionPath ||
        !value.version.startsWith(modern ? '5.' : '4.') ||
        value.preview !== modern ||
        (modern &&
          (value.metadataLanguage !== 'English' ||
            value.episodeOrder !== 'Official')))) ||
    (!ready &&
      (value.apiVersionPath !== undefined ||
        value.preview ||
        value.metadataLanguage !== undefined ||
        value.episodeOrder !== undefined))
  )
    throw new Error('Inconsistent Sonarr compatibility');
  return {
    apiVersion: 1,
    enabled: value.enabled,
    status: value.status as SonarrCompatibility['status'],
    preview: value.preview,
    ...(value.version === undefined
      ? {}
      : { version: value.version as string }),
    ...(value.apiVersionPath === undefined
      ? {}
      : { apiVersionPath: value.apiVersionPath }),
    ...(value.metadataLanguage === undefined
      ? {}
      : { metadataLanguage: value.metadataLanguage }),
    ...(value.episodeOrder === undefined
      ? {}
      : { episodeOrder: value.episodeOrder }),
  };
}

function items<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (
    !record(value) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > 500
  )
    throw new Error('Invalid request response');
  return value.items.map(parse);
}

const errors: Record<string, string> = {
  disabled:
    'Requests are disabled. Ask the server operator to review setup prerequisites.',
  unauthorized:
    'Request access was not accepted. Enter your request access token again.',
  forbidden_origin: 'This client address is not permitted to access requests.',
  invalid_request: 'Check the search or selected title and try again.',
  provider_disabled: 'This provider is not configured on the server.',
  provider_unavailable:
    'The request provider is unavailable. Refresh status before submitting again.',
  not_found: 'This title could not be verified by the provider. Search again.',
  request_limit:
    'The request limit was reached. Ask the server operator to review it.',
  internal_error:
    'The server could not complete the request. Refresh status before trying again.',
  connection:
    'Could not reach the request server. The outcome may be unknown; refresh status before submitting again.',
  invalid_response:
    'The request server returned an unsupported response. Refresh status before submitting again.',
  canceled: 'Request access changed. Unlock requests again to continue.',
};

export class RequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(errors[code] ?? errors.internal_error);
    this.name = 'RequestError';
    this.code = code in errors ? code : 'internal_error';
  }
}

/** Request-only access is kept in memory. Provider API keys never enter this client. */
export class RequestClient {
  refreshIncomplete = false;
  private token = '';
  private generation = 0;
  private readonly origin: string;
  private readonly transport: typeof fetch;
  constructor(origin = '', transport: typeof fetch = fetch) {
    this.origin = origin ? serverOrigin(origin) : '';
    // Browser fetch requires its normal receiver. Do not call a saved native
    // function as a RequestClient instance method.
    this.transport = (input, init) => transport(input, init);
  }
  lock(): void {
    this.token = '';
    this.refreshIncomplete = false;
    this.generation++;
  }
  async unlock(token: string): Promise<RequestRecord[]> {
    this.lock();
    const clean = token.trim();
    if (!/^[\x21-\x7e]{32,512}$/.test(clean))
      throw new RequestError('unauthorized');
    this.token = clean;
    const generation = this.generation;
    try {
      const result = await this.list();
      if (generation !== this.generation) throw new RequestError('canceled');
      return result;
    } catch (error) {
      if (generation === this.generation) this.lock();
      throw error;
    }
  }
  async capabilities(): Promise<RequestCapabilities> {
    return this.parse(
      await this.send('/capabilities', undefined, true),
      parseRequestCapabilities,
    );
  }
  async sonarr(): Promise<SonarrCompatibility> {
    return this.parse(await this.send('/sonarr'), parseSonarrCompatibility);
  }
  async search(
    requestKind: RequestKind,
    query: string,
  ): Promise<RequestCandidate[]> {
    const clean = query.trim();
    if (
      !kind(requestKind) ||
      Array.from(clean).length < 2 ||
      Array.from(clean).length > 100 ||
      Array.from(clean).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new RequestError('invalid_request');
    return this.parse(
      await this.send(
        `/search?kind=${requestKind}&query=${encodeURIComponent(clean)}`,
      ),
      (value) => items(value, parseRequestCandidate),
    );
  }
  async list(): Promise<RequestRecord[]> {
    return this.parse(await this.send(''), (value) => {
      if (
        !record(value) ||
        (value.refreshIncomplete !== undefined &&
          typeof value.refreshIncomplete !== 'boolean')
      )
        throw new Error('Invalid refresh state');
      const result = items(value, parseRequestRecord);
      this.refreshIncomplete = value.refreshIncomplete === true;
      return result;
    });
  }
  async submit(
    candidate: Pick<RequestCandidate, 'kind' | 'externalId'>,
  ): Promise<{ item: RequestRecord; duplicate: boolean }> {
    if (
      !kind(candidate.kind) ||
      !integer(candidate.externalId, 1) ||
      candidate.externalId > 2147483647
    )
      throw new RequestError('invalid_request');
    return this.parse(
      await this.send('', {
        kind: candidate.kind,
        externalId: candidate.externalId,
      }),
      (value) => {
        if (
          !record(value) ||
          value.apiVersion !== 1 ||
          typeof value.duplicate !== 'boolean'
        )
          throw new Error('Invalid submission');
        return {
          item: parseRequestRecord(value.item),
          duplicate: value.duplicate,
        };
      },
    );
  }
  private parse<T>(value: unknown, parse: (value: unknown) => T): T {
    try {
      return parse(value);
    } catch {
      throw new RequestError('invalid_response');
    }
  }
  private async send(
    path: string,
    body?: unknown,
    publicRequest = false,
  ): Promise<unknown> {
    if (!publicRequest && !this.token) throw new RequestError('unauthorized');
    const generation = this.generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.transport(
        this.origin + '/api/requests' + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(publicRequest ? {} : { Authorization: `Bearer ${this.token}` }),
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          credentials: 'omit',
          // Native fetch has no redirect mode; the same-origin browser client
          // can enforce it. Request endpoints themselves never redirect.
          ...(this.origin ? {} : { redirect: 'error' as const }),
        },
      );
      if (!publicRequest && generation !== this.generation)
        throw new RequestError('canceled');
      const value: unknown = await response.json();
      if (!publicRequest && generation !== this.generation)
        throw new RequestError('canceled');
      if (!response.ok) {
        const code =
          record(value) &&
          record(value.error) &&
          typeof value.error.code === 'string'
            ? value.error.code
            : 'internal_error';
        if (response.status === 401 && generation === this.generation)
          this.lock();
        throw new RequestError(code);
      }
      return value;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError('connection');
    } finally {
      clearTimeout(timer);
    }
  }
}
