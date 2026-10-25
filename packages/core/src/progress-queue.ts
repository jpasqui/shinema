import { ApiError, type ShinemaApi } from './api.ts';
import { parseProgress, type Progress } from './progress-types.ts';
import { readJson, writeJson, type KeyValueStore } from './storage.ts';

const VERSION = 1;
const MAX_KNOWN = 2000;
const ID = /^[a-f0-9]{64}$/;

type State = {
  /** Positions recorded on this device and not yet accepted by the server. */
  pending: Record<string, Progress>;
  /** Last progress known per title, for labels while offline. */
  known: Record<string, Progress>;
};

export type FlushResult = {
  saved: number;
  /** The server had newer progress from another device; it was adopted. */
  adopted: number;
  /** The server rejected the write permanently (title removed, invalid). */
  dropped: number;
  /** Kept for a later attempt (offline, server error). */
  kept: number;
};

function parseState(value: unknown): State {
  const state: State = { pending: {}, known: {} };
  if (typeof value !== 'object' || value === null) return state;
  for (const field of ['pending', 'known'] as const) {
    const entries = (value as Record<string, unknown>)[field];
    if (typeof entries !== 'object' || entries === null) continue;
    for (const [id, raw] of Object.entries(entries)) {
      if (!ID.test(id)) continue;
      try {
        const progress = parseProgress(raw);
        if (progress) state[field][id] = progress;
      } catch {
        // Skip one bad record rather than losing the rest.
      }
    }
  }
  return state;
}

const newer = (a: Progress | undefined, b: Progress | undefined) =>
  (a?.updatedAt ?? 0) >= (b?.updatedAt ?? 0) ? a : b;

/**
 * Progress recorded during playback, kept on the device until the server
 * accepts it. One queue per server origin, so switching servers never drops
 * another server's unsynced progress.
 */
export class ProgressQueue {
  private readonly store: KeyValueStore;
  private readonly key: string;
  private state: State = { pending: {}, known: {} };
  private loaded = false;
  private flushing: Promise<FlushResult> | null = null;

  constructor(store: KeyValueStore, origin: string) {
    this.store = store;
    this.key = `shinema.progress.v${VERSION}:${origin}`;
  }

  /**
   * Loads saved progress. Throws if storage cannot be read, so a caller
   * never persists an empty queue over data it failed to read.
   */
  async load(): Promise<void> {
    const stored = await readJson(this.store, this.key, VERSION, parseState);
    this.state =
      stored.status === 'ok' ? stored.value : { pending: {}, known: {} };
    this.loaded = true;
  }

  persist(): Promise<void> {
    if (!this.loaded)
      return Promise.reject(new Error('Progress was never loaded'));
    return writeJson(this.store, this.key, VERSION, this.state);
  }

  /** Records a position observed now. Call `persist` afterwards. */
  record(
    id: string,
    positionSeconds: number,
    durationSeconds: number,
    now: number = Date.now(),
  ): Progress {
    const progress = parseProgress({
      positionSeconds: Math.min(Math.max(0, positionSeconds), durationSeconds),
      durationSeconds,
      updatedAt: Math.floor(now),
    }) as Progress;
    this.state.pending[id] = progress;
    this.remember(id, progress);
    return progress;
  }

  /**
   * Queues progress observed earlier (carried over from the old app),
   * unless this device already has something newer for the title.
   */
  adopt(id: string, progress: Progress): void {
    const local = this.local(id);
    if (local && (local.updatedAt ?? 0) >= (progress.updatedAt ?? 0)) return;
    this.state.pending[id] = progress;
    this.remember(id, progress);
  }

  /** The newest progress this device knows for a title. */
  local(id: string): Progress | null {
    return newer(this.state.pending[id], this.state.known[id]) ?? null;
  }

  /** Merges progress read from the server, keeping whichever is newer. */
  observe(id: string, server: Progress | null): Progress | null {
    if (server) this.remember(id, server);
    return this.local(id);
  }

  pendingCount(): number {
    return Object.keys(this.state.pending).length;
  }

  /** Sends every pending position. Concurrent calls share one flush. */
  flush(api: ShinemaApi): Promise<FlushResult> {
    this.flushing ??= this.flushAll(api).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushAll(api: ShinemaApi): Promise<FlushResult> {
    const result: FlushResult = { saved: 0, adopted: 0, dropped: 0, kept: 0 };
    for (const [id, sent] of Object.entries(this.state.pending)) {
      try {
        const outcome = await api.saveProgress(id, sent);
        if (outcome.status === 'saved') result.saved += 1;
        else {
          result.adopted += 1;
          if (outcome.current) this.remember(id, outcome.current);
        }
        this.settle(id, sent);
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.kind === 'notFound' || error.kind === 'invalid')
        ) {
          result.dropped += 1;
          this.settle(id, sent);
        } else {
          result.kept += 1;
          // Unauthorized or offline: nothing else will succeed right now.
          if (error instanceof ApiError && error.kind !== 'server') break;
        }
      }
    }
    await this.persist();
    return result;
  }

  /** Clears a pending entry only if playback has not recorded a newer one. */
  private settle(id: string, sent: Progress): void {
    if (this.state.pending[id] === sent) delete this.state.pending[id];
  }

  private remember(id: string, progress: Progress): void {
    const current = this.state.known[id];
    if (current && newer(current, progress) === current && current !== progress)
      return;
    delete this.state.known[id];
    this.state.known[id] = progress;
    const ids = Object.keys(this.state.known);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_KNOWN)))
      if (!this.state.pending[old]) delete this.state.known[old];
  }
}
