import {
  defaultSubtitle,
  parseSubtitles,
  serverOrigin,
} from '../../../packages/contracts/index.ts';
import type { SubtitleTrack } from '../../../packages/contracts/index.ts';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CUES = 20000;
export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
  latestEnd: number;
};
export type SubtitleState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tracks: SubtitleTrack[];
  warnings: string[];
  selected: string;
  automatic: boolean;
  content: 'idle' | 'loading' | 'ready' | 'error';
  cues: SubtitleCue[];
};
export const emptySubtitles = (): SubtitleState => ({
  status: 'idle',
  tracks: [],
  warnings: [],
  selected: '',
  automatic: true,
  content: 'idle',
  cues: [],
});

function boundedText(text: string): void {
  if (text.length > MAX_BYTES) throw new Error('Subtitle is too large');
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_BYTES) throw new Error('Subtitle is too large');
  }
}

function timestamp(value: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) throw new Error('Invalid subtitle timing');
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000;
  if (!Number.isFinite(seconds) || seconds > 604800)
    throw new Error('Invalid subtitle timing');
  return seconds;
}

/** Normalized WebVTT is rendered as text, with no HTML or styling execution. */
export function parseSubtitleCues(value: string): SubtitleCue[] {
  boundedText(value);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
      throw new Error('Invalid subtitle text');
  }
  const blocks = value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[\t ]*\n/);
  if (!/^WEBVTT(?:[\t ][^\n]*)?(?:\n|$)/.test(blocks.shift() ?? ''))
    throw new Error('Invalid subtitle header');
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (!lines[0] || /^NOTE(?:[\t ]|$)/.test(lines[0])) continue;
    if (lines[0] === 'STYLE' || lines[0] === 'REGION')
      throw new Error('Styled subtitles are unsupported');
    const timingIndex = lines[0].includes('-->') ? 0 : 1;
    const timing = /^(\S+)[\t ]+-->[\t ]+(\S+)(?:[\t ]+.*)?$/.exec(
      lines[timingIndex] ?? '',
    );
    if (!timing) throw new Error('Invalid subtitle cue');
    const start = timestamp(timing[1]);
    const end = timestamp(timing[2]);
    if (end <= start) throw new Error('Invalid subtitle timing');
    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      .replace(/<[^>\n]*>/g, '')
      .replace(
        /&(amp|lt|gt|nbsp|lrm|rlm);/g,
        (_, entity: string) =>
          ({
            amp: '&',
            lt: '<',
            gt: '>',
            nbsp: '\u00a0',
            lrm: '\u200e',
            rlm: '\u200f',
          })[entity]!,
      )
      .trim();
    if (!text) continue;
    cues.push({ start, end, text, latestEnd: end });
    if (cues.length > MAX_CUES) throw new Error('Too many subtitle cues');
  }
  cues.sort((left, right) => left.start - right.start);
  let latestEnd = 0;
  for (const cue of cues) {
    latestEnd = Math.max(latestEnd, cue.end);
    cue.latestEnd = latestEnd;
  }
  return cues;
}

/** Half-open cue ranges work equally for forward playback, resume and backward seeks. */
export function subtitleAt(
  cues: readonly SubtitleCue[],
  seconds: number,
): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].start <= seconds) low = middle + 1;
    else high = middle;
  }
  const active: string[] = [];
  let length = 0;
  for (
    let index = low - 1;
    index >= 0 && cues[index].latestEnd > seconds;
    index--
  ) {
    const cue = cues[index];
    if (seconds < cue.end) {
      active.unshift(cue.text.slice(0, 4000 - length));
      length += active[0].length;
      if (length >= 4000 || active.length >= 8) break;
    }
  }
  return active.join('\n');
}

/** A seek hides captions until its acknowledgement, ignoring old progress. */
export class SubtitleClock {
  private seconds = 0;
  private seeking = false;
  current(): number {
    return this.seconds;
  }
  seek(): void {
    this.seeking = true;
    this.seconds = NaN;
  }
  update(seconds: number, acknowledged = false): number {
    if (acknowledged) this.seeking = false;
    if (!this.seeking) this.seconds = seconds;
    return this.seconds;
  }
}

export type SubtitleTransport = {
  manifest: (
    origin: string,
    path: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  content: (
    origin: string,
    path: string,
    signal: AbortSignal,
  ) => Promise<string>;
};

// These optional capabilities belong to the Node/browser fetch fallback;
// React Native's declarations correctly omit them from its buffered polyfill.
type ByteReader = {
  read: () => Promise<{ done: true } | { done: false; value: Uint8Array }>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
};
type StreamingResponse = Response & { body?: { getReader: () => ByteReader } };
type Utf8Decoder = {
  decode: (input?: Uint8Array, options?: { stream?: boolean }) => string;
};
type DecoderConstructor = new (
  encoding: string,
  options: { fatal: boolean },
) => Utf8Decoder;

async function responseFor(
  origin: string,
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  const options: RequestInit & { redirect: 'error' } = {
    signal,
    redirect: 'error',
  };
  const response = await fetch(origin + path, options);
  if (!response.ok || (response.url && new URL(response.url).origin !== origin))
    throw new Error('Subtitle request failed');
  if (Number(response.headers.get('content-length')) > MAX_BYTES)
    throw new Error('Subtitle response is too large');
  return response;
}

async function responseText(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
  )
    throw new Error('Invalid subtitle response size');
  const body = (response as StreamingResponse).body;
  const Decoder = (
    globalThis as typeof globalThis & { TextDecoder?: DecoderConstructor }
  ).TextDecoder;
  if (body?.getReader && Decoder) {
    const reader = body.getReader();
    const decoder = new Decoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES)
          throw new Error('Subtitle response is too large');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  // Non-streaming fetch must declare its bound. React Native uses the
  // progress-cancelable XMLHttpRequest transport below instead.
  if (length === null) throw new Error('Subtitle response size is required');
  const text = await response.text();
  boundedText(text);
  return text;
}

export function xhrSubtitleText(
  origin: string,
  path: string,
  signal: AbortSignal,
  vtt: boolean,
  create: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = create();
    let settled = false;
    const finish = (error?: Error, value = '') => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      xhr.onload = null;
      xhr.onerror = null;
      xhr.onabort = null;
      xhr.onprogress = null;
      xhr.onreadystatechange = null;
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (message: string) => {
      finish(new Error(message));
      xhr.abort();
    };
    const cancel = () => fail('Subtitle request canceled');
    const checkHeaders = () => {
      const length = xhr.getResponseHeader('content-length');
      if (
        length !== null &&
        (!/^\d+$/.test(length) ||
          !Number.isSafeInteger(Number(length)) ||
          Number(length) > MAX_BYTES)
      ) {
        fail('Subtitle response is too large');
        return false;
      }
      if (
        vtt &&
        !/^text\/vtt(?:;|$)/i.test(xhr.getResponseHeader('content-type') ?? '')
      ) {
        fail('Invalid subtitle response');
        return false;
      }
      return true;
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    xhr.onload = () => {
      if (!checkHeaders()) return;
      try {
        if (
          xhr.status < 200 ||
          xhr.status >= 300 ||
          (xhr.responseURL && new URL(xhr.responseURL).origin !== origin)
        )
          throw new Error('Subtitle request failed');
        const text = xhr.responseText;
        boundedText(text);
        finish(undefined, text);
      } catch {
        fail('Invalid subtitle response');
      }
    };
    xhr.onerror = () => fail('Subtitle request failed');
    xhr.onabort = () => finish(new Error('Subtitle request canceled'));
    xhr.onprogress = (event) => {
      if (
        event.loaded > MAX_BYTES ||
        (event.lengthComputable && event.total > MAX_BYTES)
      )
        fail('Subtitle response is too large');
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2) checkHeaders();
    };
    try {
      xhr.open('GET', origin + path);
      xhr.withCredentials = false;
      xhr.responseType = 'text';
      xhr.send();
    } catch {
      fail('Subtitle request failed');
    }
  });
}

async function subtitleText(
  origin: string,
  path: string,
  signal: AbortSignal,
  vtt = false,
): Promise<string> {
  // RN fetch buffers before resolving, while XHR can abort during a chunked
  // response. This also supports embedded tracks without Content-Length.
  if (typeof XMLHttpRequest !== 'undefined')
    return xhrSubtitleText(origin, path, signal, vtt);
  const response = await responseFor(origin, path, signal);
  if (
    vtt &&
    !/^text\/vtt(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  )
    throw new Error('Invalid subtitle response');
  return responseText(response);
}

const transport: SubtitleTransport = {
  manifest: async (origin, path, signal) =>
    JSON.parse(await subtitleText(origin, path, signal)),
  content: (origin, path, signal) => subtitleText(origin, path, signal, true),
};

function interruptible<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Subtitle request canceled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Subtitle I/O has its own lifetime and never changes a video source or progress. */
export class SubtitleController {
  private generation = 0;
  private context: {
    origin: string;
    id: string;
    languages: readonly string[];
  } | null = null;
  private discovery: AbortController | null = null;
  private download: AbortController | null = null;
  private preference: string | null = null; // null: Auto, empty: explicit Off, otherwise session language.
  private state = emptySubtitles();
  private publish: (state: SubtitleState) => void;
  private io: SubtitleTransport;

  constructor(
    publish: (state: SubtitleState) => void,
    io: SubtitleTransport = transport,
  ) {
    this.publish = publish;
    this.io = io;
  }

  snapshot(): SubtitleState {
    return this.state;
  }

  cancel(): void {
    ++this.generation;
    this.context = null;
    this.discovery?.abort();
    this.download?.abort();
    this.discovery = null;
    this.download = null;
  }

  async start(
    origin: string,
    id: string,
    languages: readonly string[],
  ): Promise<void> {
    this.cancel();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid subtitle media');
    this.context = { origin: serverOrigin(origin), id, languages };
    this.set({ ...emptySubtitles(), automatic: this.preference === null });
    await this.discover();
  }

  async retry(): Promise<void> {
    if (!this.context) return;
    if (this.state.status === 'error') await this.discover();
    else if (this.state.content === 'error' && this.state.selected)
      await this.load(this.state.selected);
  }

  async select(id: string): Promise<void> {
    if (!this.context) return;
    if (id) {
      const track = this.state.tracks.find(
        (track) => track.id === id && track.contentPath,
      );
      if (!track) return;
      this.preference = track.language ?? null;
    } else this.preference = '';
    this.set({ ...this.state, automatic: false });
    await this.load(id);
  }

  async automatic(): Promise<void> {
    this.preference = null;
    this.set({ ...this.state, automatic: true });
    await this.load(this.initialTrack());
  }

  private set(state: SubtitleState): void {
    this.state = state;
    this.publish(state);
  }

  private initialTrack(): string {
    if (this.preference === '') return '';
    const tracks =
      this.preference === null
        ? this.state.tracks
        : this.state.tracks.map((track) => ({ ...track, default: false }));
    return defaultSubtitle(
      tracks,
      this.preference === null
        ? (this.context?.languages ?? [])
        : [this.preference],
    );
  }

  private async discover(): Promise<void> {
    const context = this.context;
    if (!context) return;
    const generation = this.generation;
    this.discovery?.abort();
    const request = new AbortController();
    this.discovery = request;
    const timeout = setTimeout(() => request.abort(), 15000);
    this.set({ ...this.state, status: 'loading' });
    try {
      const result = parseSubtitles(
        await interruptible(
          this.io.manifest(
            context.origin,
            `/api/media/${context.id}/subtitles`,
            request.signal,
          ),
          request.signal,
        ),
        context.id,
      );
      if (
        generation !== this.generation ||
        this.discovery !== request ||
        request.signal.aborted
      )
        return;
      this.set({
        ...this.state,
        status: 'ready',
        tracks: result.tracks,
        warnings: result.warnings ?? [],
      });
      await this.load(this.initialTrack());
    } catch {
      if (generation === this.generation && this.discovery === request)
        this.set({ ...this.state, status: 'error' });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async load(id: string): Promise<void> {
    const context = this.context;
    if (!context) return;
    const track = this.state.tracks.find(
      (track) => track.id === id && track.contentPath,
    );
    if (id && !track) return;
    this.download?.abort();
    this.download = null;
    this.set({
      ...this.state,
      selected: id,
      cues: [],
      content: id ? 'loading' : 'idle',
    });
    if (!track?.contentPath) return;
    const generation = this.generation;
    const request = new AbortController();
    this.download = request;
    const timeout = setTimeout(() => request.abort(), 20000);
    try {
      const cues = parseSubtitleCues(
        await interruptible(
          this.io.content(context.origin, track.contentPath, request.signal),
          request.signal,
        ),
      );
      if (
        generation !== this.generation ||
        this.download !== request ||
        request.signal.aborted
      )
        return;
      this.set({ ...this.state, content: 'ready', cues });
    } catch {
      if (generation === this.generation && this.download === request)
        this.set({ ...this.state, content: 'error', cues: [] });
    } finally {
      clearTimeout(timeout);
    }
  }
}
