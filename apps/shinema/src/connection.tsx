import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import {
  ProgressQueue,
  ShinemaApi,
  parseLegacyState,
  readJson,
  writeJson,
} from '../../../packages/core/src/index.ts';
import { readLegacyState } from './platform/legacy';
import { store } from './platform/storage';

const KEY = 'shinema.connection';
const VERSION = 1;
const LEGACY_KEY = 'shinema.legacy-imported';

/**
 * Once per install: carries unsynced progress from the previous TV app into
 * this app's queue for the same server, and returns that server's address
 * so the connect screen can offer it.
 */
async function importLegacy(): Promise<string | null> {
  if ((await store.read(LEGACY_KEY)) !== null) return null;
  const file = await readLegacyState();
  const legacy = file ? parseLegacyState(file.text, file.modifiedAt) : null;
  if (legacy?.origin && legacy.pending.length > 0) {
    const queue = new ProgressQueue(store, legacy.origin);
    await queue.load();
    for (const [id, progress] of legacy.pending) queue.adopt(id, progress);
    await queue.persist();
  }
  await store.write(LEGACY_KEY, '1');
  return legacy?.origin ?? null;
}

type Saved = {
  origin: string;
  token: string | null;
  deviceName: string | null;
};

export type Connection =
  | { status: 'loading' }
  | { status: 'storageFailed'; message: string }
  | { status: 'disconnected'; suggestedOrigin?: string | null }
  | {
      status: 'connected';
      origin: string;
      deviceName: string | null;
      api: ShinemaApi;
      progress: ProgressQueue;
    };

type ConnectionActions = {
  connect(
    origin: string,
    token: string | null,
    deviceName: string | null,
  ): Promise<void>;
  forget(): Promise<void>;
};

const ConnectionContext = createContext<
  (Connection & ConnectionActions) | null
>(null);

function parseSaved(value: unknown): Saved {
  const saved = value as Partial<Saved> | null;
  if (!saved || typeof saved.origin !== 'string') throw new Error('Invalid');
  return {
    origin: saved.origin,
    token: typeof saved.token === 'string' ? saved.token : null,
    deviceName: typeof saved.deviceName === 'string' ? saved.deviceName : null,
  };
}

async function open(saved: Saved): Promise<Connection> {
  const progress = new ProgressQueue(store, saved.origin);
  await progress.load();
  return {
    status: 'connected',
    origin: saved.origin,
    deviceName: saved.deviceName,
    api: new ShinemaApi({ origin: saved.origin, token: saved.token }),
    progress,
  };
}

/**
 * The server this device uses and its pairing token. Progress is queued per
 * server, so switching servers never discards another server's progress.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>({
    status: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const suggestedOrigin = await importLegacy();
        const saved = await readJson(store, KEY, VERSION, parseSaved);
        const next: Connection =
          saved.status === 'ok'
            ? await open(saved.value)
            : { status: 'disconnected', suggestedOrigin };
        if (!cancelled) setConnection(next);
      } catch {
        if (!cancelled)
          setConnection({
            status: 'storageFailed',
            message:
              'Saved settings could not be read. Restart the app to try again.',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Send queued progress whenever the app comes back to the foreground.
  useEffect(() => {
    if (connection.status !== 'connected') return;
    const { api, progress } = connection;
    void progress.flush(api).catch(() => {});
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void progress.flush(api).catch(() => {});
    });
    return () => subscription.remove();
  }, [connection]);

  const connect = useCallback(
    async (origin: string, token: string | null, deviceName: string | null) => {
      const saved = { origin, token, deviceName };
      await writeJson(store, KEY, VERSION, saved);
      setConnection(await open(saved));
    },
    [],
  );

  const forget = useCallback(async () => {
    await store.remove(KEY);
    setConnection({ status: 'disconnected' });
  }, []);

  const value = useMemo(
    () => ({ ...connection, connect, forget }),
    [connection, connect, forget],
  );
  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('useConnection outside ConnectionProvider');
  return value;
}

/** For screens that only render while connected. */
export function useConnected() {
  const value = useConnection();
  if (value.status !== 'connected') throw new Error('Not connected');
  return value;
}
