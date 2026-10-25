import type { FetchLike } from '../src/api.ts';

export type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

type Handler = (
  call: Call,
) =>
  | { status: number; body?: unknown }
  | Promise<{ status: number; body?: unknown }>;

/** A scripted fetch that records every call. */
export function fakeFetch(handler: Handler): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    if (init.signal?.aborted) throw new Error('aborted');
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const response = await handler(call);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
    };
  };
  return { fetch, calls };
}

export const ID_A = 'a'.repeat(64);
export const ID_B = 'b'.repeat(64);
