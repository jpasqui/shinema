import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinContentRegistry,
  parseCatalog,
  parseLibraries,
} from '../../../packages/contracts/index.ts';
import type { Catalog, Libraries } from '../../../packages/contracts/index.ts';
import { fresh, recover } from '../src/domain.ts';
import type { Stored } from '../src/domain.ts';
import { NativeFeed, feedPath, parseFeedBatch } from '../src/feed.ts';
import {
  nativeFeedScope,
  nativeMediaContentSupport,
  navigationContentSupport,
  loadLibrarySnapshot,
  snapshotCatalogForActivation,
} from '../src/libraries.ts';
import {
  SessionGuard,
  StorageQueue,
  connectValidated,
  resolvePlayableResume,
} from '../src/session.ts';

const origin = 'https://synthetic.example.test';
const progress = { positionSeconds: 21, durationSeconds: 120 };
const capabilities = { metadata: true, play: true, view: true, launch: true };
const item = (index = 0) => ({
  id: index.toString(16).padStart(64, '0'),
  title: `Synthetic title ${index}`,
  container: 'mp4',
  formatId: 'mp4',
  contentTypeId: 'movies',
  collection: 'movies',
  libraryId: 'cinema',
  sizeBytes: 100,
  streamPath: `/api/media/${index.toString(16).padStart(64, '0')}/stream`,
});
const page = (offset = 0): Catalog =>
  parseCatalog({
    apiVersion: 1,
    items: Array.from({ length: 48 }, (_, index) => item(offset + index)),
    offset,
    limit: 48,
    total: 10000,
    nextOffset: offset + 48,
  });
function configuration(
  type: string | null = 'movies',
  revision = 1,
): Libraries {
  const builtin = builtinContentRegistry();
  return parseLibraries({
    version: 1,
    revision,
    libraries: [
      {
        id: 'cinema',
        name: 'Personal collection',
        contentTypeId: type,
        mediaType: type ?? 'mixed',
        visible: true,
        order: 0,
      },
    ],
    registry: {
      ...builtin,
      contentTypes: [
        ...builtin.contentTypes,
        ...(type !== null &&
        !builtin.contentTypes.some((value) => value.id === type)
          ? [
              {
                id: type,
                name: 'Future content',
                availability: 'available',
                capabilities,
              },
            ]
          : []),
      ],
      formats: [
        ...builtin.formats,
        {
          id: 'docx',
          name: 'Document',
          extensions: ['docx'],
          mimeTypes: [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ],
          availability: 'available',
          capabilities,
        },
      ],
    },
  });
}
function fixture(
  libraries: Libraries = configuration(),
  catalog: Catalog = page(),
) {
  let current: Stored = {
    ...fresh(),
    origin,
    libraries,
    selectedLibraryId: 'cinema',
    catalog,
    progress: { [item().id]: progress },
    pending: { [item().id]: progress },
  };
  const writes: Stored[] = [];
  const queue = new StorageQueue();
  const io = {
    read: () => current,
    write: (value: Stored) => {
      current = value;
    },
    persist: () => queue.run(() => io.writeDisk(current)),
    queue,
    stageDisk: async (_value: Stored) => {},
    writeDisk: async (value: Stored) => {
      writes.push(structuredClone(value));
    },
  };
  return { io, writes };
}

test('native feed scope uses canonical support without coercing open unknown identities to generic video', async () => {
  for (const type of [
    'music',
    'audiobooks',
    'games',
    'documents',
    'custom-content',
  ]) {
    const libraries = configuration(type);
    const navigation = { origin, libraries, selectedLibraryId: 'cinema' };
    assert.equal(nativeFeedScope(navigation), null);
    assert.equal(navigationContentSupport(navigation).supported, false);
    const paths: string[] = [];
    const snapshot = await loadLibrarySnapshot(
      origin,
      'cinema',
      null,
      async (_origin, path) => {
        paths.push(path);
        return libraries;
      },
      48,
    );
    assert.deepEqual(paths, ['/api/libraries']);
    assert.equal(snapshot.selectedLibraryId, 'cinema');
  }
  for (const type of ['movies', 'tv', null]) {
    const scope = nativeFeedScope({
      origin,
      libraries: configuration(type),
      selectedLibraryId: 'cinema',
    });
    assert(scope);
    const query = new URL(origin + feedPath(scope, 0));
    assert.equal(query.searchParams.get('library'), 'cinema');
    assert.equal(query.searchParams.get('limit'), '48');
    assert.equal(query.searchParams.get('collection'), type);
    assert.equal(query.searchParams.get('revision'), '1');
  }
  const hidden = configuration();
  hidden.libraries[0].visible = false;
  assert.equal(
    nativeFeedScope({ origin, libraries: hidden, selectedLibraryId: 'cinema' }),
    null,
  );
  assert.equal(
    nativeFeedScope({
      origin,
      libraries: configuration(),
      selectedLibraryId: 'missing',
    }),
    null,
  );
});

test('unsupported same-ID cached records, registry and pending survive revalidation, commit and restart without resume HTTP', async () => {
  const libraries = configuration('music');
  const cached = parseCatalog({
    apiVersion: 1,
    items: [
      {
        ...item(),
        contentTypeId: 'music',
        collection: 'music',
        container: 'mp3',
        formatId: 'mp3',
      },
    ],
  });
  const { io, writes } = fixture(libraries, cached);
  const restored = recover(JSON.stringify(io.read()));
  assert.deepEqual(restored.catalog, cached);
  io.write(restored);
  const renamed = parseLibraries({
    ...libraries,
    revision: 2,
    libraries: libraries.libraries.map((value) => ({
      ...value,
      name: 'Renamed collection',
    })),
  });
  const paths: string[] = [];
  const snapshot = await loadLibrarySnapshot(
    origin,
    'cinema',
    libraries,
    async (_origin, path) => {
      paths.push(path);
      return renamed;
    },
    48,
  );
  const retained = snapshotCatalogForActivation(io.read(), origin, snapshot);
  assert.deepEqual(retained, cached);
  const guard = new SessionGuard();
  assert(
    await connectValidated(
      guard,
      guard.beginConnection(),
      origin,
      async () => retained,
      io,
      snapshot,
    ),
  );
  const reopened = recover(JSON.stringify(writes.at(-1)));
  assert.equal(reopened.selectedLibraryId, 'cinema');
  assert.equal(reopened.libraries?.libraries[0].name, 'Renamed collection');
  assert.deepEqual(reopened.catalog, cached);
  assert.deepEqual(reopened.pending[item().id], progress);
  assert.deepEqual(reopened.progress[item().id], progress);
  let requests = 0;
  const result = await resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    cached.items[0],
    () => reopened,
    async () => {
      requests++;
      return progress;
    },
  );
  assert.equal(result?.supported, false);
  assert.equal(requests, 0);
  assert.deepEqual(paths, ['/api/libraries']);
  assert.equal(nativeFeedScope(reopened), null);
});

test('unsupported cache retention cannot borrow another library or origin and still validates membership', () => {
  const current = fixture().io.read();
  const unsupported = {
    libraries: configuration('music'),
    selectedLibraryId: 'cinema',
    catalog: { apiVersion: 1 as const, items: [] },
  };
  assert.deepEqual(
    snapshotCatalogForActivation(
      current,
      'https://other.example.test',
      unsupported,
    ).items,
    [],
  );
  assert.deepEqual(
    snapshotCatalogForActivation(
      { ...current, selectedLibraryId: 'other' },
      origin,
      unsupported,
    ).items,
    [],
  );
  assert.throws(
    () =>
      snapshotCatalogForActivation(
        {
          ...current,
          catalog: {
            ...page(),
            items: page().items.map((value) => ({
              ...value,
              libraryId: 'other',
            })),
          },
        },
        origin,
        unsupported,
      ),
    /mismatch/,
  );
});

test('known handler unavailability retains its records and supports bounded loading when availability returns', async () => {
  const before = configuration();
  const unavailable = parseLibraries({
    ...before,
    revision: 2,
    registry: {
      ...before.registry!,
      contentTypes: before.registry!.contentTypes.map((value) =>
        value.id === 'movies'
          ? {
              ...value,
              availability: 'unavailable',
              reason: 'Temporarily unavailable.',
            }
          : value,
      ),
    },
  });
  const { io } = fixture(before);
  const snapshot = await loadLibrarySnapshot(
    origin,
    'cinema',
    before,
    async () => unavailable,
    48,
  );
  assert.equal(nativeFeedScope({ origin, ...snapshot }), null);
  assert.deepEqual(
    snapshotCatalogForActivation(io.read(), origin, snapshot),
    io.read().catalog,
  );
  const available = configuration('movies', 3);
  const scope = nativeFeedScope({
    origin,
    libraries: available,
    selectedLibraryId: 'cinema',
  });
  assert(scope);
  const feed = new NativeFeed(scope);
  let reads = 0;
  assert.equal(
    await feed.load(
      0,
      async (_origin, path) => {
        reads++;
        assert.equal(new URL(origin + path).searchParams.get('revision'), '3');
        return page();
      },
      0,
    ),
    true,
  );
  assert.equal(reads, 1);
  assert.equal(feed.snapshot().total, 10000);
});

test('unknown item formats retain their slot, record and progress but never enter resume despite advertised capabilities', async () => {
  const library = configuration();
  const unknown = parseCatalog({
    ...page(),
    items: page().items.map((value, index) =>
      index === 3 ? { ...value, container: 'docx', formatId: 'docx' } : value,
    ),
  });
  const { io } = fixture(library, unknown);
  const scope = nativeFeedScope(io.read());
  assert(scope);
  const feed = new NativeFeed(scope);
  feed.reset(scope, unknown);
  feed.focus(3);
  const selected = feed.itemAt(3)!;
  assert.equal(selected.id, item(3).id);
  assert.equal(selected.formatId, 'docx');
  assert.equal(nativeMediaContentSupport(selected, io.read()).supported, false);
  const before = structuredClone(io.read());
  let requests = 0;
  const guard = new SessionGuard();
  const result = await resolvePlayableResume(
    guard,
    guard.beginPlayback(origin),
    selected,
    io.read,
    async () => {
      requests++;
      return progress;
    },
  );
  assert.equal(result?.supported, false);
  assert.equal(requests, 0);
  assert.deepEqual(io.read(), before);
  assert.equal(feed.itemAt(3), selected);
  assert.throws(
    () =>
      parseFeedBatch(
        {
          ...page(),
          items: page().items.map((value) => {
            const { collection: _collection, ...rest } = value;
            return { ...rest, contentTypeId: 'tv' };
          }),
        },
        scope,
        0,
      ),
    /scope/,
  );
});

test('switching from a supported feed to an unsupported registry scope cancels ignored-abort responses', async () => {
  const scope = nativeFeedScope({
    origin,
    libraries: configuration(),
    selectedLibraryId: 'cinema',
  });
  assert(scope);
  const feed = new NativeFeed(scope);
  feed.reset(scope, page());
  let resolve!: (catalog: Catalog) => void;
  let signal: AbortSignal | undefined;
  const loading = feed.load(
    48,
    (_origin, _path, value) => {
      signal = value;
      return new Promise<Catalog>((done) => {
        resolve = done;
      });
    },
    3,
  );
  await Promise.resolve();
  feed.cancelPending();
  const unavailable = nativeFeedScope({
    origin,
    libraries: configuration('music'),
    selectedLibraryId: 'cinema',
  });
  assert.equal(unavailable, null);
  assert.equal(signal?.aborted, true);
  resolve(page(48));
  assert.equal(await loading, false);
  assert.equal(feed.itemAt(48), undefined);
});
