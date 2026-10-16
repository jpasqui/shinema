import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultTopNavigation,
  maxTopNavigationEntries,
  moveTopNavigation,
  orderedTopNavigation,
  parseTopNavigation,
  parseTopNavigationDestination,
  recoverTopNavigation,
  topNavigationStorageKey,
  visibleTopNavigation,
} from '../../../packages/contracts/navigation.ts';
import type {
  TopNavigationEntry,
  TopNavigationPreferences,
} from '../../../packages/contracts/navigation.ts';
import type { LibraryDescriptor } from '../../../packages/contracts/libraries.ts';

const library: LibraryDescriptor = {
  id: 'anime',
  name: 'Anime',
  mediaType: 'tv',
  order: 0,
  visible: true,
};
const entry = (
  patch: Partial<TopNavigationEntry> = {},
): TopNavigationEntry => ({
  id: 'primary',
  label: 'Library',
  destination: { kind: 'browse' },
  order: 0,
  visible: true,
  ...patch,
});
const document = (
  ...entries: TopNavigationEntry[]
): TopNavigationPreferences => ({ version: 1, entries });

test('sensible navigation defaults are independently allocated and versioned', () => {
  assert.deepEqual(defaultTopNavigation(), document(entry()));
  const first = defaultTopNavigation();
  first.entries[0].label = 'Changed';
  assert.equal(defaultTopNavigation().entries[0].label, 'Library');
  assert.equal(topNavigationStorageKey, 'shinema.web.top-navigation.v1');
});

test('renaming and remapping a label preserve stable entry and library identity', () => {
  const preferences = parseTopNavigation(
    document(
      entry({
        label: 'Watch',
        destination: { kind: 'library', libraryId: 'anime' },
      }),
    ),
  );
  const renamedLibrary = {
    ...library,
    name: 'Animation',
    mediaType: 'mixed' as const,
  };
  assert.deepEqual(
    visibleTopNavigation(preferences, [renamedLibrary]),
    preferences.entries,
  );
  assert.equal(preferences.entries[0].id, 'primary');
  assert.deepEqual(preferences.entries[0].destination, {
    kind: 'library',
    libraryId: 'anime',
  });
  for (const kind of ['browse', 'search', 'settings'] as const)
    assert.deepEqual(parseTopNavigationDestination({ kind }), { kind });
});

test('supported destinations reject URLs, scripts, functions and extra fields', () => {
  for (const destination of [
    'https://example.test',
    { kind: 'url', url: 'https://example.test' },
    { kind: 'javascript:alert(1)' },
    { kind: 'browse', url: '/api/admin/libraries' },
    { kind: 'browse', action: () => {} },
    { kind: () => 'browse' },
    { kind: 'library', libraryId: '../private' },
    { kind: 'library', libraryId: 'Anime' },
    { kind: 'library', libraryId: 'anime', script: 'run()' },
    { kind: 'library' },
    [],
    null,
  ])
    assert.throws(() => parseTopNavigationDestination(destination));
  let called = false;
  assert.throws(() =>
    parseTopNavigationDestination({
      kind: {
        toString: () => {
          called = true;
          return 'browse';
        },
      },
    }),
  );
  assert.equal(called, false);
});

test('invalid labels and duplicate display names cannot be saved', () => {
  for (const label of [
    '',
    ' ',
    ' Library',
    'Library ',
    'a'.repeat(81),
    'Line\nbreak',
    'Null\0',
    'Bidi\u202e',
    'Zero\u200b',
  ])
    assert.throws(() => parseTopNavigation(document(entry({ label }))));
  assert.equal(
    parseTopNavigation(document(entry({ label: '🎬'.repeat(80) }))).entries[0]
      .label.length,
    160,
  );
  for (const labels of [
    ['Anime', 'anime'],
    ['Café', 'Cafe\u0301'],
    ['Watch', 'Ｗａｔｃｈ'],
  ])
    assert.throws(() =>
      parseTopNavigation(
        document(
          entry({ label: labels[0] }),
          entry({ id: 'second', label: labels[1] }),
        ),
      ),
    );
  // User labels are plain text; React renders markup-looking labels as text.
  assert.equal(
    parseTopNavigation(document(entry({ label: '<script>text</script>' })))
      .entries[0].label,
    '<script>text</script>',
  );
});

test('shape, identity, bounds, order and visibility are validated', () => {
  for (const value of [
    [],
    null,
    { version: 0, entries: [] },
    { version: 2, entries: [] },
    { version: 1, entries: [], script: 'run()' },
    document(entry(), entry({ label: 'Other' })),
    document(entry({ id: 'Bad ID' })),
    document(entry({ order: -1 })),
    document(entry({ order: 0.5 })),
    document(entry({ order: Infinity })),
    document(entry({ order: NaN })),
    document(entry({ order: 10001 })),
    { version: 1, entries: [{ ...entry(), visible: 'yes' }] },
    { version: 1, entries: [{ ...entry(), unknown: true }] },
    document(
      ...Array.from({ length: maxTopNavigationEntries + 1 }, (_, index) =>
        entry({ id: `item-${index}`, label: `Item ${index}` }),
      ),
    ),
  ])
    assert.throws(() => parseTopNavigation(value));
  assert.equal(
    parseTopNavigation(document(entry({ order: 10000 }))).entries.length,
    1,
  );
});

test('order and visibility are independent and stable after restart', () => {
  let preferences = document(
    entry({ id: 'watch', label: 'Watch', order: 20 }),
    entry({
      id: 'find',
      label: 'Find',
      destination: { kind: 'search' },
      order: 10,
    }),
    entry({
      id: 'manage',
      label: 'Manage',
      destination: { kind: 'settings' },
      order: 30,
      visible: false,
    }),
  );
  preferences = moveTopNavigation(preferences, 'watch', -1);
  assert.deepEqual(
    orderedTopNavigation(preferences).map((item) => item.id),
    ['watch', 'find', 'manage'],
  );
  const restarted = recoverTopNavigation(JSON.stringify(preferences));
  assert.deepEqual(restarted, preferences);
  assert.deepEqual(
    visibleTopNavigation(restarted, []).map((item) => item.id),
    ['watch', 'find'],
  );
  assert.equal(
    restarted.entries.find((item) => item.id === 'manage')?.visible,
    false,
  );
  assert.equal(moveTopNavigation(restarted, 'unknown', 1), restarted);
  assert.equal(moveTopNavigation(restarted, 'watch', -1), restarted);
  assert.deepEqual(
    orderedTopNavigation(
      document(entry({ id: 'z', label: 'Z' }), entry({ id: 'a', label: 'A' })),
    ).map((item) => item.id),
    ['a', 'z'],
  );
});

test('removed or hidden libraries retain targets safely and empty navigation is allowed', () => {
  const preferences = document(
    entry({ destination: { kind: 'library', libraryId: 'anime' } }),
  );
  assert.deepEqual(visibleTopNavigation(preferences, []), []);
  assert.deepEqual(
    visibleTopNavigation(preferences, [{ ...library, visible: false }]),
    [],
  );
  assert.equal(visibleTopNavigation(preferences, [library]).length, 1);
  assert.equal(preferences.entries[0].destination.kind, 'library');
  assert.deepEqual(parseTopNavigation(document()), document());
  assert.deepEqual(
    visibleTopNavigation(document(entry({ visible: false })), [library]),
    [],
  );
  // A fixed Settings button is outside preferences; no invalid destination is inserted.
  assert.deepEqual(
    recoverTopNavigation(JSON.stringify(document())),
    document(),
  );
});

test('legacy, corrupt, oversized and unsupported storage recover coherent defaults', () => {
  for (const raw of [
    null,
    '',
    '{',
    'null',
    '[]',
    'x'.repeat(65537),
    JSON.stringify({ order: ['movies'], hidden: [] }),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify(document(entry({ label: '' }))),
  ])
    assert.deepEqual(recoverTopNavigation(raw), defaultTopNavigation());
});
