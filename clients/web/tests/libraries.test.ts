import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultLibraries,
  parseLibraries,
  parseLibraryConfiguration,
  parseNavigationPreferences,
  visibleLibraries,
  parseCatalog,
} from '../../../packages/contracts/index.ts';
import {
  browsePath,
  initialBrowse,
  rememberPage,
  recoverPages,
} from '../src/browse.ts';
test('stable IDs survive display names, ordering and visibility with separate client preferences', () => {
  const document = defaultLibraries();
  const anime = {
    id: 'anime',
    name: 'Anime',
    mediaType: 'tv',
    visible: true,
    order: 0,
  };
  const parsed = parseLibraries({
    ...document,
    revision: 2,
    libraries: [
      { ...document.libraries[0], name: 'Cinema', order: 5 },
      anime,
      { ...document.libraries[1], visible: false },
    ],
  });
  assert.deepEqual(
    visibleLibraries(parsed.libraries, {
      order: ['movies', 'anime'],
      hidden: [],
    }).map((item) => item.id),
    ['movies', 'anime'],
  );
  assert.deepEqual(
    visibleLibraries(parsed.libraries, { order: [], hidden: ['movies'] }).map(
      (item) => item.name,
    ),
    ['Anime'],
  );
  assert.deepEqual(
    parsed.libraries.map((item) => item.id),
    ['movies', 'anime', 'tv'],
  );
  assert.equal(
    parseLibraries(JSON.parse(JSON.stringify(parsed))).libraries[1].mediaType,
    'tv',
  );
});
test('invalid/duplicate names, IDs, grouping, order and unsupported documents fail closed', () => {
  const document = defaultLibraries();
  for (const patch of [
    { name: '' },
    { name: ' Anime ' },
    { name: '\u202eAnime' },
    { name: 'x'.repeat(81) },
    { id: '../../root' },
    { id: 'Movies' },
    { mediaType: 'javascript' },
    { order: -1 },
    { visible: 'yes' },
  ])
    assert.throws(() =>
      parseLibraries({
        ...document,
        libraries: [{ ...document.libraries[0], ...patch }],
      }),
    );
  assert.throws(() =>
    parseLibraries({
      ...document,
      libraries: [
        document.libraries[0],
        { ...document.libraries[1], name: 'movies' },
      ],
    }),
  );
  assert.throws(() =>
    parseLibraries({
      ...document,
      libraries: [document.libraries[0], document.libraries[0]],
    }),
  );
  assert.throws(() => parseLibraries({ ...document, version: 2 }));
  assert.throws(() => parseLibraries({ ...document, revision: 0.5 }));
  assert.deepEqual(
    parseLibraries({ ...document, libraries: [] }).libraries,
    [],
  );
});
test('admin source descriptors remain approved-root-relative and never carry token/extra properties', () => {
  const document = {
    ...defaultLibraries(),
    libraries: defaultLibraries().libraries.map((item) => ({
      ...item,
      sourceFolders: [],
    })),
    availableFolders: ['.', 'tv/Anime'],
  };
  assert.deepEqual(parseLibraryConfiguration(document).availableFolders, [
    '.',
    'tv/Anime',
  ]);
  for (const source of [
    '/etc',
    'C:/private',
    '../outside',
    'tv/../outside',
    'tv\\Anime',
    'https://outside',
    'tv//Anime',
  ]) {
    assert.throws(() =>
      parseLibraryConfiguration({ ...document, availableFolders: [source] }),
    );
    assert.throws(() =>
      parseLibraryConfiguration({
        ...document,
        libraries: [{ ...document.libraries[0], sourceFolders: [source] }],
      }),
    );
  }
  const parsed = parseLibraries({
    ...document,
    token: 'synthetic-secret',
    libraries: document.libraries,
  });
  assert.equal('token' in parsed, false);
  assert.equal('sourceFolders' in parsed.libraries[0], false);
});
test('client preference recovery isolates corrupt values and removed IDs do not hide new libraries', () => {
  const preferences = parseNavigationPreferences({
    order: ['tv', 'tv', '../bad', null],
    hidden: ['removed', 'movies'],
  });
  assert.deepEqual(preferences, {
    order: ['tv'],
    hidden: ['removed', 'movies'],
  });
  assert.deepEqual(
    visibleLibraries(defaultLibraries().libraries, preferences).map(
      (item) => item.id,
    ),
    ['tv'],
  );
  assert.deepEqual(parseNavigationPreferences('bad'), {
    order: [],
    hidden: [],
  });
});
test('library and revision scope isolate search and persisted browse cache', () => {
  const anime = browsePath({
    ...initialBrowse(),
    libraryId: 'anime',
    revision: 2,
    collection: 'tv',
    search: 'Orbit',
  });
  const other = browsePath({
    ...initialBrowse(),
    libraryId: 'tv',
    revision: 2,
    collection: 'tv',
    search: 'Orbit',
  });
  const changed = browsePath({
    ...initialBrowse(),
    libraryId: 'anime',
    revision: 3,
    collection: 'tv',
    search: 'Orbit',
  });
  assert.notEqual(anime, other);
  assert.notEqual(anime, changed);
  const page = { items: [], total: 0, offset: 0, limit: 60, nextOffset: null };
  const cache = recoverPages(JSON.stringify(rememberPage({}, anime, page)));
  assert.ok(cache[anime]);
  assert.equal(cache[other], undefined);
  assert.equal(cache[changed], undefined);
  assert.equal(
    new URL(anime, 'http://localhost').searchParams.get('library'),
    'anime',
  );
});
test('additive membership does not change playback or media identity', () => {
  const id = 'a'.repeat(64);
  const media = {
    id,
    title: 'Generated episode',
    container: 'mp4',
    sizeBytes: 10,
    streamPath: `/api/media/${id}/stream`,
    libraryId: 'anime',
    collection: 'tv',
  };
  const item = parseCatalog({ apiVersion: 1, items: [media] }).items[0];
  assert.equal(item.id, id);
  assert.equal(item.streamPath, media.streamPath);
  assert.equal(item.libraryId, 'anime');
  assert.throws(() =>
    parseCatalog({
      apiVersion: 1,
      items: [{ ...media, libraryId: '/private' }],
    }),
  );
});
