import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLibraries } from '../../../packages/contracts/index.ts';
import type { Catalog, Libraries } from '../../../packages/contracts/index.ts';
import { fresh, recover } from '../src/domain.ts';
import type { Stored } from '../src/domain.ts';
import {
  HttpStatusError,
  loadLibrarySnapshot,
  selectedLibrary,
  visibleLibraries,
} from '../src/libraries.ts';
import {
  connectValidated,
  resolveResume,
  SessionGuard,
  StorageQueue,
} from '../src/session.ts';

const origin = 'https://synthetic.example';
const id = 'a'.repeat(64);
const otherId = 'b'.repeat(64);
const progress = { positionSeconds: 21, durationSeconds: 120 };
const libraries: Libraries = {
  version: 1,
  revision: 2,
  libraries: [
    {
      id: 'cinema',
      name: 'Cinema',
      mediaType: 'movies',
      visible: true,
      order: 1,
    },
    { id: 'anime', name: 'Anime', mediaType: 'tv', visible: true, order: 0 },
    {
      id: 'other',
      name: 'Other videos',
      mediaType: 'mixed',
      visible: false,
      order: 2,
    },
  ],
};
const catalog: Catalog = {
  apiVersion: 1,
  items: [
    {
      id,
      title: 'Generated episode',
      container: 'mp4',
      sizeBytes: 100,
      streamPath: `/api/media/${id}/stream`,
      libraryId: 'anime',
      collection: 'tv',
    },
  ],
};
const movieCatalog: Catalog = {
  apiVersion: 1,
  items: [
    {
      ...catalog.items[0],
      id: otherId,
      title: 'Generated movie',
      libraryId: 'cinema',
      collection: 'movies',
      streamPath: `/api/media/${otherId}/stream`,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let current: Stored = {
    ...fresh(),
    origin,
    catalog,
    libraries,
    selectedLibraryId: 'anime',
    progress: { [id]: progress },
    pending: { [id]: progress },
  };
  const queue = new StorageQueue();
  const persisted: Stored[] = [];
  const io = {
    read: () => current,
    write: (value: Stored) => {
      current = value;
    },
    queue,
    stageDisk: async () => {},
    writeDisk: async (value: Stored) => {
      persisted.push(value);
    },
    persist: () => queue.run(() => io.writeDisk(current)),
  };
  return { io, persisted };
}

test('native navigation uses stable IDs for renames, media type, global ordering and visibility', () => {
  assert.deepEqual(
    visibleLibraries(libraries).map((item) => item.name),
    ['Anime', 'Cinema'],
  );
  const renamed = parseLibraries({
    ...libraries,
    revision: 3,
    libraries: libraries.libraries.map((item) =>
      item.id === 'anime' ? { ...item, name: 'Animation', order: 5 } : item,
    ),
  });
  assert.equal(selectedLibrary(renamed, 'anime'), 'anime');
  assert.equal(
    renamed.libraries.find((item) => item.id === 'anime')?.mediaType,
    'tv',
  );
  assert.deepEqual(
    visibleLibraries(renamed).map((item) => item.id),
    ['cinema', 'anime'],
  );
  const hidden = {
    ...renamed,
    libraries: renamed.libraries.map((item) =>
      item.id === 'anime' ? { ...item, visible: false } : item,
    ),
  };
  assert.equal(selectedLibrary(hidden, 'anime'), 'cinema');
  assert.equal(selectedLibrary({ ...hidden, libraries: [] }, 'anime'), null);
});

test('invalid and duplicate labels are rejected before a catalog request', async () => {
  for (const name of ['', ' Anime ', 'A\u0000B', 'a'.repeat(81), 'cinema']) {
    const requested: string[] = [];
    await assert.rejects(
      loadLibrarySnapshot(origin, 'anime', null, async (_origin, path) => {
        requested.push(path);
        return {
          ...libraries,
          libraries: libraries.libraries.map((item) =>
            item.id === 'anime' ? { ...item, name } : item,
          ),
        };
      }),
    );
    assert.deepEqual(requested, ['/api/libraries']);
  }
});

test('a legacy cache migrates without changing progress or discarding its catalog', () => {
  const restored = recover(
    JSON.stringify({
      origin,
      catalog,
      progress: { [id]: progress },
      pending: { [id]: progress },
    }),
  );
  assert.equal(restored.libraries, null);
  assert.equal(restored.selectedLibraryId, null);
  assert.deepEqual(restored.catalog, catalog);
  assert.deepEqual(restored.pending[id], progress);
});

test('restart preserves the renamed selected ID and pending progress; hidden or corrupt scope is not relabeled', () => {
  const { io } = fixture();
  const renamed = {
    ...libraries,
    libraries: libraries.libraries.map((item) =>
      item.id === 'anime' ? { ...item, name: 'Animation' } : item,
    ),
  };
  const restored = recover(
    JSON.stringify({ ...io.read(), libraries: renamed }),
  );
  assert.equal(restored.selectedLibraryId, 'anime');
  assert.equal(restored.libraries?.libraries[1].name, 'Animation');
  assert.deepEqual(restored.catalog, catalog);
  const hidden = {
    ...libraries,
    libraries: libraries.libraries.map((item) =>
      item.id === 'anime' ? { ...item, visible: false } : item,
    ),
  };
  const moved = recover(JSON.stringify({ ...io.read(), libraries: hidden }));
  assert.equal(moved.selectedLibraryId, 'cinema');
  assert.deepEqual(moved.catalog?.items, []);
  assert.deepEqual(moved.pending[id], progress);
  for (const value of [
    { ...io.read(), catalog: movieCatalog },
    { ...io.read(), libraries: { broken: true } },
  ]) {
    const recovered = recover(JSON.stringify(value));
    assert.equal(recovered.catalog, null);
    assert.deepEqual(recovered.progress[id], progress);
    assert.deepEqual(recovered.pending[id], progress);
  }
});

test('native requests only the selected stable library ID, independent of its label', async () => {
  const paths: string[] = [];
  const snapshot = await loadLibrarySnapshot(
    origin,
    'anime',
    null,
    async (destination, path) => {
      assert.equal(destination, origin);
      paths.push(path);
      return path === '/api/libraries' ? libraries : catalog;
    },
  );
  assert.deepEqual(paths, [
    '/api/libraries',
    '/api/catalog?library=anime&limit=500&revision=2',
  ]);
  assert.equal(snapshot.selectedLibraryId, 'anime');
  assert.deepEqual(snapshot.catalog, catalog);
  await assert.rejects(
    loadLibrarySnapshot(origin, 'anime', null, async (_origin, path) =>
      path === '/api/libraries' ? libraries : movieCatalog,
    ),
    /mismatch/,
  );
});

test('an empty library remains selected; all-hidden configuration does not fetch an unscoped catalog', async () => {
  const snapshot = await loadLibrarySnapshot(
    origin,
    'anime',
    null,
    async (_origin, path) =>
      path === '/api/libraries' ? libraries : { apiVersion: 1, items: [] },
  );
  assert.equal(snapshot.selectedLibraryId, 'anime');
  assert.deepEqual(snapshot.catalog.items, []);
  const paths: string[] = [];
  const hidden = await loadLibrarySnapshot(
    origin,
    'anime',
    null,
    async (_origin, path) => {
      paths.push(path);
      return {
        ...libraries,
        libraries: libraries.libraries.map((item) => ({
          ...item,
          visible: false,
        })),
      };
    },
  );
  assert.deepEqual(paths, ['/api/libraries']);
  assert.equal(hidden.selectedLibraryId, null);
  assert.deepEqual(hidden.catalog.items, []);
});

test('legacy endpoint fallback requires a genuine 404 and cannot silently remove a configured scope', async () => {
  const paths: string[] = [];
  const load = async (_origin: string, path: string) => {
    paths.push(path);
    if (path === '/api/libraries') throw new HttpStatusError(404);
    return catalog;
  };
  const snapshot = await loadLibrarySnapshot(origin, null, null, load);
  assert.equal(snapshot.libraries, null);
  assert.deepEqual(paths, ['/api/libraries', '/api/catalog?limit=500']);
  await assert.rejects(loadLibrarySnapshot(origin, 'anime', libraries, load));
  for (const error of [
    new HttpStatusError(401),
    new HttpStatusError(500),
    new Error('unavailable'),
  ]) {
    let requests = 0;
    await assert.rejects(
      loadLibrarySnapshot(origin, null, null, async () => {
        requests++;
        throw error;
      }),
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    loadLibrarySnapshot(origin, 'anime', libraries, async () => ({
      ...libraries,
      revision: 1,
    })),
    /Stale/,
  );
});

test('library change commits the scope and descriptor snapshot together without resetting progress', async () => {
  const { io, persisted } = fixture();
  const guard = new SessionGuard();
  const snapshot = await loadLibrarySnapshot(
    origin,
    'cinema',
    libraries,
    async (_origin, path) =>
      path === '/api/libraries' ? libraries : movieCatalog,
  );
  assert(
    await connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      async () => snapshot.catalog,
      io,
      snapshot,
    ),
  );
  assert.equal(io.read().selectedLibraryId, 'cinema');
  assert.deepEqual(io.read().catalog, movieCatalog);
  assert.deepEqual(io.read().pending[id], progress);
  assert.equal(persisted.at(-1)?.selectedLibraryId, 'cinema');
  assert.deepEqual(persisted.at(-1)?.catalog, movieCatalog);
});

test('late library/configuration results cannot replace a newer selection or an active playback ticket', async () => {
  for (const action of ['selection', 'playback']) {
    const { io } = fixture();
    const guard = new SessionGuard();
    const reply = deferred<unknown>();
    const attempt = guard.beginConnection();
    const pending = (async () => {
      const snapshot = await loadLibrarySnapshot(
        origin,
        'cinema',
        libraries,
        async (_origin, path) =>
          path === '/api/libraries' ? reply.promise : movieCatalog,
      );
      return connectValidated(
        guard,
        attempt,
        origin,
        async () => snapshot.catalog,
        io,
        snapshot,
      );
    })();
    if (action === 'selection') {
      assert(
        await connectValidated(
          guard,
          guard.beginConnection(),
          origin,
          async () => catalog,
          io,
          { libraries, selectedLibraryId: 'anime' },
        ),
      );
    } else {
      const ticket = guard.beginPlayback(origin);
      assert(
        await resolveResume(guard, ticket, id, io.read, async () => progress),
      );
      assert(guard.currentPlayback(ticket, origin));
    }
    reply.resolve(libraries);
    assert.equal(await pending, null, action);
    assert.equal(io.read().selectedLibraryId, 'anime');
    assert.deepEqual(io.read().catalog, catalog);
    assert.deepEqual(io.read().pending[id], progress);
  }
});

test('selected library preference is bound to the confirmed server and resets on an origin change', async () => {
  const { io } = fixture();
  const guard = new SessionGuard();
  const destination = 'https://other-synthetic.example';
  assert(
    await connectValidated(
      guard,
      guard.beginConnection(),
      destination,
      async () => movieCatalog,
      io,
      { libraries, selectedLibraryId: 'cinema' },
    ),
  );
  assert.equal(io.read().origin, destination);
  assert.equal(io.read().selectedLibraryId, 'cinema');
  assert.deepEqual(io.read().pending, {});
});

test('selecting the confirmed library again supersedes a different pending selection', async () => {
  const { io } = fixture();
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  const pending = connectValidated(
    guard,
    guard.beginConnection(),
    origin,
    () => reply.promise,
    io,
    { libraries, selectedLibraryId: 'cinema' },
  );
  // A choice still owns a new attempt when A is confirmed and B is loading.
  assert(
    await connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      async () => catalog,
      io,
      { libraries, selectedLibraryId: 'anime' },
    ),
  );
  reply.resolve(movieCatalog);
  assert.equal(await pending, null);
  assert.equal(io.read().selectedLibraryId, 'anime');
  assert.deepEqual(io.read().catalog, catalog);
});

test('a library final commit blocks playback and cancellation keeps disk and memory on the same scope', async () => {
  for (const change of ['selection', 'revision']) {
    const { io, persisted } = fixture();
    const guard = new SessionGuard();
    const slow = deferred<void>();
    const began = deferred<void>();
    const write = io.writeDisk;
    io.writeDisk = async (value) => {
      began.resolve();
      await slow.promise;
      await write(value);
    };
    const nextLibraries = { ...libraries, revision: 3 };
    const nextCatalog = change === 'selection' ? movieCatalog : catalog;
    const selectedLibraryId = change === 'selection' ? 'cinema' : 'anime';
    const pending = connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      async () => nextCatalog,
      io,
      { libraries: nextLibraries, selectedLibraryId },
    );
    await began.promise;
    assert(guard.isSwitchCommitting());
    assert.throws(() => guard.beginPlayback(origin));
    guard.cancelConnection();
    slow.resolve();
    assert.equal(await pending, null);
    assert(!guard.isSwitchCommitting());
    const reopened = recover(JSON.stringify(persisted.at(-1)));
    assert.equal(reopened.selectedLibraryId, selectedLibraryId);
    assert.equal(io.read().selectedLibraryId, selectedLibraryId);
    assert.equal(reopened.libraries?.revision, 3);
    assert.equal(io.read().libraries?.revision, 3);
    assert.deepEqual(reopened.pending[id], progress);
    assert.deepEqual(io.read().pending[id], progress);
    assert.deepEqual(io.read().catalog, nextCatalog);
    assert.deepEqual(reopened.catalog, nextCatalog);
  }
});

test('an invalid cache or unrelated progress entry cannot discard valid pending progress', () => {
  const { io } = fixture();
  const recovered = recover(
    JSON.stringify({
      ...io.read(),
      catalog: { apiVersion: 99, items: [] },
      progress: {
        [id]: progress,
        [otherId]: { positionSeconds: -1, durationSeconds: 60 },
      },
      pending: { [id]: progress, [otherId]: { broken: true } },
    }),
  );
  assert.equal(recovered.origin, origin);
  assert.equal(recovered.catalog, null);
  assert.deepEqual(recovered.progress, { [id]: progress });
  assert.deepEqual(recovered.pending, { [id]: progress });
});

test('a newer request accepted during delayed activation cannot roll back the confirmed revision', async () => {
  for (const stale of [libraries, null]) {
    const { io, persisted } = fixture();
    const guard = new SessionGuard();
    const slow = deferred<void>();
    const began = deferred<void>();
    const write = io.writeDisk;
    let first = true;
    io.writeDisk = async (value) => {
      if (first) {
        first = false;
        began.resolve();
        await slow.promise;
      }
      await write(value);
    };
    const next = { ...libraries, revision: 3 };
    const activating = connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      async () => catalog,
      io,
      { libraries: next, selectedLibraryId: 'anime' },
    );
    await began.promise;
    const staleRequest = connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      async () => catalog,
      io,
      { libraries: stale, selectedLibraryId: stale ? 'anime' : null },
    );
    const refused = assert.rejects(staleRequest, /Stale library configuration/);
    slow.resolve();
    assert.equal(await activating, null);
    await refused;
    assert.equal(io.read().libraries?.revision, 3);
    assert.equal(
      recover(JSON.stringify(persisted.at(-1))).libraries?.revision,
      3,
    );
    assert.deepEqual(io.read().pending[id], progress);
  }
});
