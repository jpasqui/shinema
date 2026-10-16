import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinContentRegistry,
  contentTypeForLibrary,
  defaultLibraries,
  libraryContentSupport,
  mediaContentSupport,
  parseCatalog,
  parseContentRegistry,
  parseLibraries,
  validContentId,
  validContentTypeId,
  validFormatExtension,
  validMimeType,
} from '../../../packages/contracts/index.ts';
import type {
  ContentRegistry,
  ContentTypeDescriptor,
} from '../../../packages/contracts/index.ts';
import { recoverPages, rememberPage } from '../src/browse.ts';

const descriptor = (id: string): ContentTypeDescriptor => ({
  id,
  name: id,
  availability: 'available',
  capabilities: { metadata: true, play: true, view: true, launch: true },
});
const library = (patch: Record<string, unknown> = {}) => ({
  id: 'custom',
  name: 'Custom',
  visible: true,
  order: 0,
  mediaType: 'movies',
  ...patch,
});
const libraries = (...entries: Record<string, unknown>[]) => ({
  version: 1,
  revision: 4,
  libraries: entries,
});
const media = (patch: Record<string, unknown> = {}) => ({
  id: 'a'.repeat(64),
  title: 'Generated title',
  container: 'mp4',
  sizeBytes: 10,
  streamPath: `/api/media/${'a'.repeat(64)}/stream`,
  collection: 'movies',
  ...patch,
});
const catalog = (...items: Record<string, unknown>[]) => ({
  apiVersion: 1,
  items,
});

test('the shipped registry describes current handlers and returns isolated snapshots', () => {
  const registry = builtinContentRegistry();
  assert.deepEqual(
    registry.contentTypes.map((item) => item.id),
    ['movies', 'tv'],
  );
  assert.deepEqual(
    registry.formats.flatMap((item) => item.extensions),
    [
      'mp4',
      'm4v',
      'mkv',
      'webm',
      'avi',
      'ts',
      'm2ts',
      'mov',
      'mpg',
      'mpeg',
      'wmv',
      'vob',
    ],
  );
  assert.equal(registry.formats.length, 12);
  registry.contentTypes[0].capabilities.play = false;
  registry.formats[0].extensions.length = 0;
  assert.equal(
    builtinContentRegistry().contentTypes[0].capabilities.play,
    true,
  );
  assert.deepEqual(builtinContentRegistry().formats[0].extensions, ['mp4']);
});

test('legacy libraries migrate without changing IDs, names or source grouping', () => {
  for (const [mediaType, contentTypeId] of [
    ['movies', 'movies'],
    ['tv', 'tv'],
    ['mixed', null],
    ['audiobooks', 'audiobooks'],
  ] as const) {
    const parsed = parseLibraries(libraries(library({ mediaType })));
    assert.equal(parsed.libraries[0].id, 'custom');
    assert.equal(parsed.libraries[0].name, 'Custom');
    assert.equal(parsed.libraries[0].mediaType, mediaType);
    assert.equal(parsed.libraries[0].contentTypeId, contentTypeId);
    assert.deepEqual(parsed.registry, builtinContentRegistry());
    assert.deepEqual(
      parseLibraries(JSON.parse(JSON.stringify(parsed))),
      parsed,
    );
  }
  assert.equal(contentTypeForLibrary({ mediaType: 'mixed' }), null);
  assert.equal(contentTypeForLibrary({ mediaType: 'games' }), 'games');
  assert.equal(
    contentTypeForLibrary({ contentTypeId: 'tv', mediaType: 'tv' }),
    'tv',
  );
  assert.equal(defaultLibraries().libraries[2].contentTypeId, null);
});

test('canonical-only library identities produce compatible aliases while conflicts fail', () => {
  assert.deepEqual(
    parseLibraries(
      libraries({
        id: 'docs',
        name: 'Documents',
        visible: true,
        order: 1,
        contentTypeId: 'documents',
      }),
    ).libraries[0],
    {
      id: 'docs',
      name: 'Documents',
      visible: true,
      order: 1,
      contentTypeId: 'documents',
      mediaType: 'documents',
    },
  );
  assert.equal(
    parseLibraries(
      libraries(library({ mediaType: undefined, contentTypeId: null })),
    ).libraries[0].mediaType,
    'mixed',
  );
  for (const patch of [
    { mediaType: 'tv', contentTypeId: 'movies' },
    { mediaType: 'music', contentTypeId: null },
    { mediaType: 'mixed', contentTypeId: 'tv' },
    { mediaType: undefined, contentTypeId: 'mixed' },
    { mediaType: 'mixed', contentTypeId: 'mixed' },
    { mediaType: undefined, contentTypeId: undefined },
  ])
    assert.throws(() => parseLibraries(libraries(library(patch))));
});

test('library IDs and aliases require actual strings, including cached array/object values', () => {
  let coerced = false;
  const object = {
    toString: () => {
      coerced = true;
      return 'tv';
    },
  };
  for (const value of [
    ['tv'],
    [],
    { value: 'tv' },
    object,
    true,
    12,
    null,
    '',
    'TV',
    '../music',
    'music/audio',
    'x'.repeat(49),
  ]) {
    assert.throws(() =>
      parseLibraries(libraries(library({ mediaType: value }))),
    );
    if (value !== null)
      assert.throws(() =>
        parseLibraries(
          libraries(library({ mediaType: undefined, contentTypeId: value })),
        ),
      );
  }
  assert.equal(coerced, false);
  assert.throws(() =>
    parseLibraries(
      JSON.parse(JSON.stringify(libraries(library({ mediaType: ['tv'] })))),
    ),
  );
  assert.throws(() =>
    parseLibraries({ ...libraries(library()), registry: null }),
  );
});

test('unknown registry identities and capabilities survive a cache round trip without installing handlers', () => {
  const registry = builtinContentRegistry();
  registry.contentTypes.push(descriptor('music'));
  registry.formats.push({
    ...descriptor('docx'),
    extensions: ['docx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  });
  const parsed = parseLibraries({
    ...libraries(library({ mediaType: 'music', contentTypeId: 'music' })),
    registry,
  });
  assert.deepEqual(parseLibraries(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(parsed.registry?.contentTypes.at(-1)?.capabilities.launch, true);
  assert.equal(
    libraryContentSupport(parsed.libraries[0], parsed.registry).supported,
    false,
  );
  assert.equal(
    mediaContentSupport(
      { contentTypeId: null, container: 'docx', formatId: 'docx' },
      parsed.registry,
    ).supported,
    false,
  );
});

test('content support requires server availability/play and an installed client handler', () => {
  assert.equal(libraryContentSupport({ mediaType: 'movies' }).supported, true);
  assert.equal(libraryContentSupport({ mediaType: 'tv' }).supported, true);
  assert.equal(
    libraryContentSupport({ contentTypeId: null, mediaType: 'mixed' })
      .supported,
    true,
  );
  assert.equal(libraryContentSupport({ mediaType: 'music' }).supported, false);
  for (const change of ['missing', 'unavailable', 'view-only'] as const) {
    const registry = builtinContentRegistry();
    if (change === 'missing') registry.contentTypes = [];
    if (change === 'unavailable') {
      registry.contentTypes[0].availability = 'unavailable';
      registry.contentTypes[0].reason = 'Synthetic handler unavailable.';
    }
    if (change === 'view-only')
      registry.contentTypes[0].capabilities = {
        metadata: true,
        play: false,
        view: true,
        launch: true,
      };
    const support = libraryContentSupport(
      { contentTypeId: 'movies' },
      registry,
    );
    assert.equal(support.supported, false);
    assert.ok(support.reason);
    if (change === 'unavailable')
      assert.equal(support.reason, 'Synthetic handler unavailable.');
  }
});

test('formats require both installed and server playback support even for unrestricted video', () => {
  for (const container of builtinContentRegistry().formats.flatMap(
    (item) => item.extensions,
  ))
    assert.equal(
      mediaContentSupport({ contentTypeId: null, container }).supported,
      true,
    );
  for (const change of [
    'missing',
    'unavailable',
    'view-only',
    'changed-extension',
  ] as const) {
    const registry = builtinContentRegistry();
    if (change === 'missing')
      registry.formats = registry.formats.filter((item) => item.id !== 'mp4');
    if (change === 'unavailable')
      registry.formats[0].availability = 'unavailable';
    if (change === 'view-only') registry.formats[0].capabilities.play = false;
    if (change === 'changed-extension')
      registry.formats[0].extensions = ['future'];
    assert.equal(
      mediaContentSupport({ contentTypeId: null, container: 'mp4' }, registry)
        .supported,
      false,
    );
  }
  assert.equal(
    mediaContentSupport({ container: 'mp4', formatId: 'future-format' })
      .supported,
    false,
  );
  assert.equal(mediaContentSupport({ container: 'future' }).supported, false);
  assert.equal(
    mediaContentSupport({ container: 'mp4', formatId: 'mkv' }).supported,
    false,
  );
  const registry = builtinContentRegistry();
  registry.formats.push({
    ...descriptor('future-format'),
    extensions: ['mp4'],
    mimeTypes: ['video/mp4'],
  });
  assert.equal(
    mediaContentSupport(
      { container: 'mp4', formatId: 'future-format' },
      registry,
    ).supported,
    false,
  );
});

test('direct support helpers fail closed on canonical/legacy conflicts', () => {
  for (const value of [
    { contentTypeId: null, mediaType: 'music' },
    { contentTypeId: 'movies', mediaType: 'music' },
    { contentTypeId: 'music', mediaType: 'movies' },
  ])
    assert.equal(libraryContentSupport(value).supported, false);
  for (const value of [
    { contentTypeId: null, collection: 'music', container: 'mp4' },
    { contentTypeId: null, collection: 'movies', container: 'mp4' },
    { contentTypeId: 'movies', collection: 'music', container: 'mp4' },
    { contentTypeId: 'music', collection: 'movies', container: 'mp4' },
  ])
    assert.equal(mediaContentSupport(value).supported, false);
  assert.equal(
    mediaContentSupport({ collection: 'music', container: 'mp4' }).supported,
    false,
  );
});

test('registry parsing bounds descriptor lists and validates identities and exact capability flags', () => {
  const registry = builtinContentRegistry();
  for (const value of [
    [],
    null,
    { ...registry, version: 2 },
    { ...registry, script: 'run()' },
    { ...registry, contentTypes: [descriptor('movies'), descriptor('movies')] },
    { ...registry, formats: [registry.formats[0], registry.formats[0]] },
    {
      ...registry,
      contentTypes: Array.from({ length: 129 }, (_, index) =>
        descriptor(`type-${index}`),
      ),
    },
    {
      ...registry,
      formats: Array.from({ length: 129 }, (_, index) => ({
        ...registry.formats[0],
        id: `format-${index}`,
      })),
    },
    {
      ...registry,
      contentTypes: [
        {
          ...descriptor('music'),
          capabilities: { metadata: true, play: true, view: true },
        },
      ],
    },
    {
      ...registry,
      contentTypes: [
        {
          ...descriptor('music'),
          capabilities: { ...descriptor('music').capabilities, execute: true },
        },
      ],
    },
    {
      ...registry,
      contentTypes: [
        {
          ...descriptor('music'),
          capabilities: { ...descriptor('music').capabilities, play: 'true' },
        },
      ],
    },
    { ...registry, contentTypes: [{ ...descriptor('music'), id: ['music'] }] },
    { ...registry, contentTypes: [descriptor('mixed')] },
    {
      ...registry,
      contentTypes: [{ ...descriptor('music'), name: ' Music ' }],
    },
    {
      ...registry,
      contentTypes: [{ ...descriptor('music'), reason: '\u202eHidden' }],
    },
    {
      ...registry,
      contentTypes: [{ ...descriptor('music'), reason: 'x'.repeat(513) }],
    },
  ])
    assert.throws(() => parseContentRegistry(value));
  assert.equal(
    parseContentRegistry({
      ...registry,
      contentTypes: Array.from({ length: 128 }, (_, index) =>
        descriptor(`type-${index}`),
      ),
    }).contentTypes.length,
    128,
  );
});

test('extension and MIME selectors are bounded tokens rather than paths, scripts or parameters', () => {
  const registry = builtinContentRegistry();
  const invalidExtensions = [
    '',
    '.mp4',
    '../mp4',
    'a/b',
    'c:\\video',
    'video.mp4',
    'MP4',
    'x'.repeat(49),
    ['mp4'],
  ];
  const invalidMimes = [
    '',
    'video/*',
    'Video/mp4',
    'video/mp4; codecs=avc1',
    'video/mp4\n',
    'https://example.test',
    'video',
    ['video/mp4'],
    `video/${'a'.repeat(122)}`,
  ];
  for (const extension of invalidExtensions) {
    assert.equal(validFormatExtension(extension), false);
    assert.throws(() =>
      parseContentRegistry({
        ...registry,
        formats: [{ ...registry.formats[0], extensions: [extension] }],
      }),
    );
  }
  for (const mime of invalidMimes) {
    assert.equal(validMimeType(mime), false);
    assert.throws(() =>
      parseContentRegistry({
        ...registry,
        formats: [{ ...registry.formats[0], mimeTypes: [mime] }],
      }),
    );
  }
  for (const field of ['extensions', 'mimeTypes']) {
    const values =
      field === 'extensions' ? ['mp4', 'mp4'] : ['video/mp4', 'video/mp4'];
    assert.throws(() =>
      parseContentRegistry({
        ...registry,
        formats: [{ ...registry.formats[0], [field]: values }],
      }),
    );
    assert.throws(() =>
      parseContentRegistry({
        ...registry,
        formats: [
          {
            ...registry.formats[0],
            [field]: Array.from({ length: 33 }, (_, index) =>
              field === 'extensions' ? `ext-${index}` : `video/x-${index}`,
            ),
          },
        ],
      }),
    );
  }
  assert.equal(validFormatExtension('3gp'), true);
  assert.equal(validFormatExtension('7z'), true);
  assert.equal(validContentId('3gp'), false);
  assert.equal(validContentId('future-format'), true);
  assert.equal(validContentId('mixed'), true);
  assert.equal(validContentTypeId('mixed'), false);
  assert.equal(validMimeType('application/vnd.custom+json'), true);
});

test('catalog parsing preserves unknown identities and migrates legacy grouping', () => {
  const unknown = media({
    contentTypeId: 'documents',
    collection: 'documents',
    formatId: 'docx',
    container: 'docx',
    mimeType: 'application/msword',
  });
  const parsed = parseCatalog(catalog(unknown));
  assert.deepEqual(parsed.items[0], unknown);
  assert.equal(mediaContentSupport(parsed.items[0]).supported, false);
  assert.equal(parseCatalog(catalog(media())).items[0].contentTypeId, 'movies');
  assert.equal(
    parseCatalog(catalog(media({ collection: undefined }))).items[0]
      .contentTypeId,
    null,
  );
  assert.equal(
    parseCatalog(catalog(media({ collection: 'music' }))).items[0]
      .contentTypeId,
    'music',
  );
  assert.equal(
    parseCatalog(
      catalog(
        media({ collection: undefined, contentTypeId: null, container: '3gp' }),
      ),
    ).items[0].container,
    '3gp',
  );
});

test('unknown inventory survives persisted page parsing alongside existing video identities', () => {
  const known = media();
  const unknownId = 'b'.repeat(64);
  const unknown = media({
    id: unknownId,
    streamPath: `/api/media/${unknownId}/stream`,
    collection: 'games',
    container: '7z',
    formatId: 'archive',
  });
  const path = '/api/catalog?collection=all&limit=60';
  const saved = rememberPage({}, path, {
    ...catalog(known, unknown),
    total: 2,
    offset: 0,
    limit: 60,
    nextOffset: null,
  });
  const recovered = recoverPages(JSON.stringify(saved));
  const parsed = parseCatalog(recovered[path]);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].id, known.id);
  assert.equal(parsed.items[0].streamPath, known.streamPath);
  assert.equal(parsed.items[1].id, unknownId);
  assert.equal(parsed.items[1].contentTypeId, 'games');
  assert.equal(mediaContentSupport(parsed.items[0]).supported, true);
  assert.equal(mediaContentSupport(parsed.items[1]).supported, false);
});

test('catalog aliases, MIME values and canonical identities reject malformed/conflicting values', () => {
  for (const patch of [
    { collection: ['movies'] },
    { collection: { value: 'movies' } },
    { contentTypeId: ['movies'] },
    { contentTypeId: 'tv' },
    { contentTypeId: null },
    { contentTypeId: null, collection: 'music' },
    { contentTypeId: '../music', collection: undefined },
    { contentTypeId: 'mixed', collection: undefined },
    { collection: 'mixed' },
    { container: ['mp4'] },
    { container: '.mp4' },
    { container: 'x'.repeat(49) },
    { formatId: ['mp4'] },
    { formatId: '../mp4' },
    { mimeType: 'video/*' },
    { mimeType: 'video/mp4;codecs=x' },
  ])
    assert.throws(() => parseCatalog(catalog(media(patch))));
  assert.equal(
    parseCatalog(catalog(media({ collection: undefined, contentTypeId: null })))
      .items[0].contentTypeId,
    null,
  );
});

test('registry snapshots retain registered unknown descriptors with unavailable reasons', () => {
  const registry: ContentRegistry = builtinContentRegistry();
  registry.contentTypes.push({
    ...descriptor('audiobooks'),
    availability: 'unavailable',
    reason: 'No audio book handler is installed.',
  });
  const parsed = parseContentRegistry(JSON.parse(JSON.stringify(registry)));
  assert.equal(parsed.contentTypes.at(-1)?.id, 'audiobooks');
  assert.equal(
    libraryContentSupport({ contentTypeId: 'audiobooks' }, parsed).reason,
    'No audio book handler is installed.',
  );
});
