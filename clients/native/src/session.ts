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

/** No state changes occur before a candidate catalog has validated. */
export async function connectValidated(
  guard: SessionGuard,
  attempt: number,
  origin: string,
  load: (origin: string) => Promise<unknown>,
  state: StateIO,
): Promise<{catalog: Catalog; switched: boolean; stamp: ConnectionStamp} | null> {
  const catalog = parseCatalog(await load(origin));
  if (!guard.currentAttempt(attempt)) return null;
  const current = state.read();
  const switched = current.origin !== origin;
  const stamp = guard.confirm(origin);
  state.write(switched ? {...fresh(), origin, catalog} : {...current, catalog});
  await state.persist();
  if (!guard.currentAttempt(attempt) || !guard.current(stamp, state.read().origin)) return null;
  return {catalog, switched, stamp};
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
