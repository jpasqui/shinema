import {parseCatalog, parseProgress} from '../../../packages/contracts/index.ts';
import type {Catalog, Progress} from '../../../packages/contracts/index.ts';
import {fresh} from './domain.ts';
import type {Stored} from './domain.ts';

export type ConnectionStamp = {origin: string; generation: number};
export type PlaybackTicket = ConnectionStamp & {playback: number};

/** Tracks request cancellation separately from the confirmed server identity. */
export class SessionGuard {
  private attempt = 0;
  private generation = 0;
  private playback = 0;

  beginConnection(): number {
    this.invalidatePlayback();
    return ++this.attempt;
  }
  cancelConnection(): void {
    ++this.attempt;
    this.invalidatePlayback();
  }
  currentAttempt(attempt: number): boolean { return attempt === this.attempt; }
  capture(origin: string): ConnectionStamp { return {origin, generation: this.generation}; }
  confirm(origin: string): ConnectionStamp {
    ++this.generation;
    this.invalidatePlayback();
    return this.capture(origin);
  }
  current(stamp: ConnectionStamp, origin: string): boolean {
    return stamp.origin === origin && stamp.generation === this.generation;
  }
  invalidatePlayback(): void { ++this.playback; }
  beginPlayback(origin: string): PlaybackTicket {
    // Explicit playback from cache supersedes an unfinished startup refresh.
    // Its late response must not confirm a session or replace the player route.
    this.cancelConnection();
    return {...this.capture(origin), playback: ++this.playback};
  }
  currentPlayback(ticket: PlaybackTicket, origin: string): boolean {
    return this.current(ticket, origin) && ticket.playback === this.playback;
  }
}

type StateIO = {
  read: () => Stored;
  write: (next: Stored) => void;
  persist: () => Promise<void>;
};

/** One queue owns cache writes and their associated connection activation. */
export class StorageQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

type ConnectionIO = StateIO & {
  queue: StorageQueue;
  writeDisk: (next: Stored) => Promise<void>;
};

/** No state changes occur before a candidate catalog has validated. */
export async function connectValidated(
  guard: SessionGuard,
  attempt: number,
  origin: string,
  load: (origin: string) => Promise<unknown>,
  state: ConnectionIO,
): Promise<{catalog: Catalog; switched: boolean; stamp: ConnectionStamp} | null> {
  const catalog = parseCatalog(await load(origin));
  return state.queue.run(async () => {
    if (!guard.currentAttempt(attempt)) return null;
    const current = state.read();
    const switched = current.origin !== origin;
    const candidate = switched ? {...fresh(), origin, catalog} : {...current, catalog};
    // Atomic native writes reject without replacing the live cache. Until this
    // succeeds, memory, the confirmed generation and all queued progress stay A.
    await state.writeDisk(candidate);
    if (!guard.currentAttempt(attempt)) {
      // Navigation can cancel while storage is in flight. Restore the latest
      // working state in this same queue slot, before any newer activation or
      // ordinary cache write can run. A stale candidate never becomes active.
      await state.writeDisk(state.read());
      return null;
    }
    const stamp = guard.confirm(origin);
    // A same-origin refresh must not discard progress added during disk I/O.
    state.write(switched ? candidate : {...state.read(), catalog});
    return {catalog, switched, stamp};
  });
}

/** The captured destination can never be resampled after an asynchronous write. */
export async function persistThenSync(
  guard: SessionGuard,
  destination: ConnectionStamp,
  persist: () => Promise<void>,
  currentOrigin: () => string,
  sync: (destination: ConnectionStamp) => Promise<void>,
): Promise<boolean> {
  await persist();
  if (!guard.current(destination, currentOrigin())) return false;
  await sync(destination);
  return true;
}

export class ProgressQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue(work: () => Promise<void>): Promise<void> {
    this.tail = this.tail.catch(() => {}).then(work);
    return this.tail;
  }
}

export async function syncProgress(
  guard: SessionGuard,
  destination: ConnectionStamp,
  id: string,
  value: Progress,
  state: StateIO,
  send: (origin: string, id: string, value: Progress) => Promise<void>,
): Promise<void> {
  if (!guard.current(destination, state.read().origin)) return;
  await send(destination.origin, id, value);
  if (!guard.current(destination, state.read().origin)) return;
  const current = state.read();
  const pending = current.pending[id];
  if (pending?.positionSeconds !== value.positionSeconds || pending?.durationSeconds !== value.durationSeconds) return;
  const next = {...current.pending};
  delete next[id];
  state.write({...current, pending: next});
  await state.persist();
}

export async function resolveResume(
  guard: SessionGuard,
  ticket: PlaybackTicket,
  id: string,
  read: () => Stored,
  load: (origin: string, id: string) => Promise<unknown>,
): Promise<{progress: Progress | null; local: boolean} | null> {
  const saved = read();
  let progress: Progress | null = saved.progress[id] ?? null;
  let local = Boolean(saved.pending[id]);
  if (!local) {
    try { progress = parseProgress(await load(ticket.origin, id)); }
    catch { local = true; }
  }
  if (!guard.currentPlayback(ticket, read().origin)) return null;
  return {progress, local};
}

export function backDestination(route: string, hasCatalog: boolean): 'detail' | 'library' | 'exit' {
  if (route === 'player') return 'detail';
  if (route === 'detail' || (route === 'setup' && hasCatalog)) return 'library';
  return 'exit';
}
