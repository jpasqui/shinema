import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLibraries,
  parseCatalog,
  builtinContentRegistry,
} from '../../../packages/contracts/index.ts';
import type {
  Catalog,
  Libraries,
  ContentRegistry,
} from '../../../packages/contracts/index.ts';
import { fresh, recover } from '../src/domain.ts';
import type { Stored } from '../src/domain.ts';
import {
  HttpStatusError,
  loadLibrarySnapshot,
  selectedLibrary,
  visibleLibraries,
  nativeLibraryContentSupport,
  navigationContentSupport,
  nativeMediaContentSupport,
} from '../src/libraries.ts';
import {
  connectValidated,
  resolveResume,
  resolvePlayableResume,
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
const legacyCatalog = {
  apiVersion: 1 as const,
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
const catalog: Catalog = parseCatalog(legacyCatalog);
const movieCatalog: Catalog = parseCatalog({
  apiVersion: 1,
  items: [
    {
      ...catalog.items[0],
      id: otherId,
      title: 'Generated movie',
      libraryId: 'cinema',
      collection: 'movies',
      contentTypeId: 'movies',
      streamPath: `/api/media/${otherId}/stream`,
    },
  ],
});

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
      catalog: legacyCatalog,
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

const allCapabilities = {
  metadata: true,
  play: true,
  view: true,
  launch: true,
};
function futureRegistry(): ContentRegistry {
  const registry = builtinContentRegistry();
  return {
    ...registry,
    contentTypes: [
      ...registry.contentTypes,
      {
        id: 'music',
        name: 'Music',
        availability: 'available',
        capabilities: allCapabilities,
      },
    ],
    formats: [
      ...registry.formats,
      {
        id: 'docx',
        name: 'Word document',
        extensions: ['docx'],
        mimeTypes: [
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
        availability: 'available',
        capabilities: allCapabilities,
      },
    ],
  };
}
function futureLibraries(): Libraries {
  return parseLibraries({
    ...libraries,
    revision: 4,
    registry: futureRegistry(),
    libraries: [
      ...libraries.libraries,
      {
        id: 'music-shelf',
        name: 'Music collection',
        contentTypeId: 'music',
        mediaType: 'music',
        visible: true,
        order: 3,
      },
    ],
  });
}

test('unknown types stay discoverable and selected without requesting their catalog', async () => {
  const configured = futureLibraries();
  const paths: string[] = [];
  const snapshot = await loadLibrarySnapshot(
    origin,
    'music-shelf',
    libraries,
    async (_origin, path) => {
      paths.push(path);
      return configured;
    },
  );
  assert.deepEqual(paths, ['/api/libraries']);
  assert.equal(snapshot.selectedLibraryId, 'music-shelf');
  assert.deepEqual(snapshot.catalog.items, []);
  assert(
    visibleLibraries(snapshot.libraries).some(
      (item) => item.id === 'music-shelf',
    ),
  );
  assert.equal(
    snapshot.libraries?.libraries.find((item) => item.id === 'music-shelf')
      ?.contentTypeId,
    'music',
  );
  assert.equal(navigationContentSupport(snapshot).supported, false);
  assert.equal(
    snapshot.libraries?.registry?.contentTypes.find(
      (item) => item.id === 'music',
    )?.availability,
    'available',
  );
});

test('unsupported selection, registry and unrelated progress survive commit and restart', async () => {
  const { io, persisted } = fixture();
  const guard = new SessionGuard();
  const configured = futureLibraries();
  const snapshot = await loadLibrarySnapshot(
    origin,
    'music-shelf',
    libraries,
    async () => configured,
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
  const restored = recover(JSON.stringify(persisted.at(-1)));
  assert.equal(restored.selectedLibraryId, 'music-shelf');
  assert.equal(
    restored.libraries?.libraries.find((item) => item.id === 'music-shelf')
      ?.contentTypeId,
    'music',
  );
  assert.equal(
    restored.libraries?.registry?.formats.find((item) => item.id === 'docx')
      ?.id,
    'docx',
  );
  assert.equal(navigationContentSupport(restored).supported, false);
  assert.deepEqual(restored.pending[id], progress);
  assert.deepEqual(restored.progress[id], progress);
  // Even an old cached title cannot make this unsupported library playable.
  const requests: string[] = [];
  const ticket = guard.beginPlayback(origin);
  const result = await resolvePlayableResume(
    guard,
    ticket,
    catalog.items[0],
    () => ({ ...restored, pending: {} }),
    async (_origin, key) => {
      requests.push(key);
      return progress;
    },
  );
  assert.equal(result?.supported, false);
  assert.deepEqual(requests, []);
});

test('unavailable server handlers remain selected but cannot load a catalog or resume position', async () => {
  const registry = builtinContentRegistry();
  const configured = parseLibraries({
    ...libraries,
    registry: {
      ...registry,
      contentTypes: registry.contentTypes.map((item) =>
        item.id === 'tv'
          ? {
              ...item,
              availability: 'unavailable',
              reason: 'TV handler unavailable.',
            }
          : item,
      ),
    },
  });
  const paths: string[] = [];
  const snapshot = await loadLibrarySnapshot(
    origin,
    'anime',
    libraries,
    async (_origin, path) => {
      paths.push(path);
      return configured;
    },
  );
  assert.deepEqual(paths, ['/api/libraries']);
  assert.equal(snapshot.selectedLibraryId, 'anime');
  assert.equal(navigationContentSupport(snapshot).supported, false);
  assert(navigationContentSupport(snapshot).reason);
  const { io } = fixture();
  io.write({ ...io.read(), ...snapshot, pending: {} });
  const guard = new SessionGuard();
  let requests = 0;
  const result = await resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    catalog.items[0],
    io.read,
    async () => {
      requests++;
      return progress;
    },
  );
  assert.equal(result?.supported, false);
  assert.equal(requests, 0);
  assert.deepEqual(io.read().progress[id], progress);
});

test('unknown formats remain cached and discoverable but server claims cannot enable native playback', async () => {
  const configured = parseLibraries({
    ...libraries,
    registry: futureRegistry(),
  });
  const unknown = parseCatalog({
    ...catalog,
    items: [
      {
        ...catalog.items[0],
        container: 'docx',
        formatId: 'docx',
        contentTypeId: 'tv',
      },
    ],
  });
  const { io } = fixture();
  io.write({
    ...io.read(),
    catalog: unknown,
    libraries: configured,
    pending: {},
  });
  const restored = recover(JSON.stringify(io.read()));
  assert.equal(restored.catalog?.items[0].container, 'docx');
  assert.equal(restored.catalog?.items[0].formatId, 'docx');
  const item = restored.catalog!.items[0];
  assert.equal(nativeMediaContentSupport(item, restored).supported, false);
  const guard = new SessionGuard();
  let requests = 0;
  const result = await resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    item,
    () => restored,
    async () => {
      requests++;
      return progress;
    },
  );
  assert.equal(result?.supported, false);
  assert.equal(requests, 0);
  assert.deepEqual(restored.progress[id], progress);
});

test('a known unavailable format is blocked while installed Movies, TV and inventory types remain supported', async () => {
  for (const library of libraries.libraries)
    assert.equal(nativeLibraryContentSupport(library).supported, true);
  const registry = builtinContentRegistry();
  const configured = parseLibraries({
    ...libraries,
    registry: {
      ...registry,
      formats: registry.formats.map((item) =>
        item.id === 'mp4'
          ? {
              ...item,
              availability: 'unavailable',
              reason: 'MP4 handler unavailable.',
            }
          : item,
      ),
    },
  });
  const navigation = { libraries: configured, selectedLibraryId: 'anime' };
  assert.equal(
    nativeMediaContentSupport(catalog.items[0], navigation).supported,
    false,
  );
  const { io } = fixture();
  io.write({ ...io.read(), ...navigation, pending: {} });
  const guard = new SessionGuard();
  let requests = 0;
  const result = await resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    catalog.items[0],
    io.read,
    async () => {
      requests++;
      return progress;
    },
  );
  assert.equal(result?.supported, false);
  assert.equal(requests, 0);
});

test('availability is rechecked after a delayed resume response without changing stored progress', async () => {
  const { io } = fixture();
  io.write({ ...io.read(), pending: {} });
  const before = structuredClone(io.read().progress);
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  let requests = 0;
  const pending = resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    catalog.items[0],
    io.read,
    async () => {
      requests++;
      return reply.promise;
    },
  );
  const registry = builtinContentRegistry();
  const unavailable = parseLibraries({
    ...libraries,
    registry: {
      ...registry,
      contentTypes: registry.contentTypes.map((item) =>
        item.id === 'tv'
          ? {
              ...item,
              availability: 'unavailable',
              reason: 'Handler is unavailable.',
            }
          : item,
      ),
    },
  });
  io.write({ ...io.read(), libraries: unavailable });
  reply.resolve(progress);
  const result = await pending;
  assert.equal(result?.supported, false);
  assert.equal(requests, 1);
  assert.deepEqual(io.read().progress, before);
  assert.deepEqual(io.read().pending, {});
});

test('a later library selection cancels playable resume instead of opening a stale item', async () => {
  const { io } = fixture();
  io.write({ ...io.read(), pending: {} });
  const guard = new SessionGuard();
  const reply = deferred<unknown>();
  const pending = resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    catalog.items[0],
    io.read,
    () => reply.promise,
  );
  guard.beginConnection();
  io.write({
    ...io.read(),
    libraries: futureLibraries(),
    selectedLibraryId: 'music-shelf',
    catalog: { apiVersion: 1, items: [] },
  });
  reply.resolve(progress);
  assert.equal(await pending, null);
  assert.equal(io.read().selectedLibraryId, 'music-shelf');
  assert.deepEqual(io.read().progress[id], progress);
});

test('unknown item types and explicit unknown format IDs never borrow an installed video renderer', async () => {
  const { io } = fixture();
  io.write({
    ...io.read(),
    libraries: parseLibraries({ ...libraries, registry: futureRegistry() }),
    pending: {},
  });
  for (const item of [
    { ...catalog.items[0], contentTypeId: 'music', collection: 'music' },
    { ...catalog.items[0], formatId: 'docx' },
  ]) {
    const parsed = parseCatalog({ apiVersion: 1, items: [item] }).items[0];
    assert.equal(nativeMediaContentSupport(parsed, io.read()).supported, false);
    const guard = new SessionGuard();
    let requests = 0;
    const result = await resolvePlayableResume(
      guard,
      guard.beginPlayback(origin),
      parsed,
      io.read,
      async () => {
        requests++;
        return progress;
      },
    );
    assert.equal(result?.supported, false);
    assert.equal(requests, 0);
  }
});
