/**
 * Durable key/value storage supplied by each platform (MMKV or files on
 * native, localStorage on the web). Reads that fail must throw: a failed read
 * is not evidence that nothing was saved, and treating it as empty would let
 * the next write erase real data.
 */
export interface KeyValueStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type Stored<T> =
  { status: 'missing' } | { status: 'corrupt' } | { status: 'ok'; value: T };

/**
 * Reads a versioned JSON envelope. Throws when the store itself fails;
 * returns `corrupt` when the bytes are unusable, so callers can choose to
 * start fresh deliberately.
 */
export async function readJson<T>(
  store: KeyValueStore,
  key: string,
  version: number,
  parse: (value: unknown) => T,
): Promise<Stored<T>> {
  const text = await store.read(key);
  if (text === null) return { status: 'missing' };
  try {
    const envelope = JSON.parse(text) as { version?: unknown; value?: unknown };
    if (envelope.version !== version) return { status: 'corrupt' };
    return { status: 'ok', value: parse(envelope.value) };
  } catch {
    return { status: 'corrupt' };
  }
}

export function writeJson(
  store: KeyValueStore,
  key: string,
  version: number,
  value: unknown,
): Promise<void> {
  return store.write(key, JSON.stringify({ version, value }));
}

/** In-memory store for tests and for sessions where storage is unavailable. */
export class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  read(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  write(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}
