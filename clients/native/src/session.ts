import {parseCatalog, parseProgress} from '../../../packages/contracts/index.ts';
import type {Catalog, Media, Progress} from '../../../packages/contracts/index.ts';
import {fresh} from './domain.ts';
import type {Stored} from './domain.ts';
import type {LibraryNavigation} from './libraries.ts';
import {nativeMediaContentSupport} from './libraries.ts';

export type ConnectionStamp = {origin: string; generation: number};
export type PlaybackTicket = ConnectionStamp & {playback: number};

/** Tracks request cancellation separately from the confirmed server identity. */
export class SessionGuard {
  private attempt = 0;
  private generation = 0;
  private playback = 0;
  private switchingCommit = false;

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
  startCommit(attempt: number, switching: boolean): boolean {
    if (!this.currentAttempt(attempt)) return false;
    this.switchingCommit = switching;
    return true;
  }
  finishCommit(): void { this.switchingCommit = false; }
  isSwitchCommitting(): boolean { return this.switchingCommit; }
  beginPlayback(origin: string): PlaybackTicket {
    if (this.switchingCommit) throw new Error('Server switch commit is finishing');
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
  stageDisk: (candidate: Stored) => Promise<void>;
  writeDisk: (next: Stored) => Promise<void>;
};

/** No state changes occur before a candidate catalog has validated. */
export async function connectValidated(
  guard: SessionGuard,
  attempt: number,
  origin: string,
  load: (origin: string) => Promise<unknown>,
  state: ConnectionIO,
  navigation?: LibraryNavigation,
): Promise<{catalog: Catalog; switched: boolean; stamp: ConnectionStamp} | null> {
  const catalog = parseCatalog(await load(origin));
  const scope = navigation ? {libraries:navigation.libraries,selectedLibraryId:navigation.selectedLibraryId} : {};
  return state.queue.run(async () => {
    if (!guard.currentAttempt(attempt)) return null;
    const current = state.read();
    const switched = current.origin !== origin;
    // Another final activation can finish while this response waits for its
    // storage slot. Its newly confirmed revision must remain authoritative.
    if(!switched && navigation && current.libraries && (!navigation.libraries || navigation.libraries.revision<current.libraries.revision))throw new Error('Stale library configuration');
    const scopeChanged = navigation!==undefined && (current.selectedLibraryId!==navigation.selectedLibraryId || current.libraries?.revision!==navigation.libraries?.revision);
    const activating = switched || scopeChanged;
    const candidate = switched ? {...fresh(), origin, catalog,...scope} : {...current, catalog,...scope};
    // This separate file is never read as the confirmed cache, including after
    // restart. Cancellation requires no rollback or cleanup write to protect A.
    await state.stageDisk(candidate);
    if (!guard.startCommit(attempt, activating)) return null;
    try {
      const confirmed = switched ? candidate : {...state.read(), catalog,...scope};
      // The explicit atomic confirmation commit is the point after which a
      // server or library activation cannot be canceled. Navigation may continue, but playback waits
      // for this short phase; an I/O rejection still leaves confirmed A intact.
      await state.writeDisk(confirmed);
      if (!activating && !guard.currentAttempt(attempt)) return null;
      const stamp = switched ? guard.confirm(origin) : guard.capture(origin);
      state.write(switched ? confirmed : {...state.read(), catalog,...scope});
      if (!guard.currentAttempt(attempt)) return null;
      return {catalog, switched, stamp};
    } finally { guard.finishCommit(); }
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
  const initial = state.read();
  // Each App.save creates a fresh immutable value. Its identity owns this
  // request even when a later save returns to the same position and duration.
  if (!guard.current(destination, initial.origin) || initial.pending[id] !== value) return;
  await send(destination.origin, id, value);
  const current = state.read();
  if (!guard.current(destination, current.origin) || current.pending[id] !== value) return;
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
  const initial = saved.pending[id] ?? saved.progress[id] ?? null;
  let progress: Progress | null = initial;
  let local = Boolean(saved.pending[id]);
  if (!local) {
    try { progress = parseProgress(await load(ticket.origin, id)); }
    catch { local = true; }
  }
  const current = read();
  if (!guard.currentPlayback(ticket, current.origin)) return null;
  if (current.pending[id]) return {progress: current.pending[id], local: true};
  // A save can be acknowledged while the GET waits. Pending may already be
  // empty, but a fresh selected-title value still supersedes that old response.
  if (current.progress[id] !== saved.progress[id])
    return {progress: current.progress[id] ?? initial, local: true};
  if (local) progress = current.progress[id] ?? initial;
  return {progress, local};
}

/** Unsupported content never reaches progress loading or the native player. */
export async function resolvePlayableResume(
  guard:SessionGuard,
  ticket:PlaybackTicket,
  media:Media,
  read:()=>Stored,
  load:(origin:string,id:string)=>Promise<unknown>,
):Promise<{supported:false;reason?:string}|{supported:true;progress:Progress|null;local:boolean}|null>{
  const support=nativeMediaContentSupport(media,read());
  if(!support.supported)return {supported:false,reason:support.reason};
  const result=await resolveResume(guard,ticket,media.id,read,load);
  if(!result)return null;
  const currentSupport=nativeMediaContentSupport(media,read());
  return currentSupport.supported?{supported:true,...result}:{supported:false,reason:currentSupport.reason};
}

export function backDestination(route: string, hasCatalog: boolean): 'detail' | 'library' | 'exit' {
  if (route === 'player') return 'detail';
  if (route === 'detail' || (route === 'setup' && hasCatalog)) return 'library';
  return 'exit';
}
