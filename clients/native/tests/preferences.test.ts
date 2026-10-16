import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveTheme,
  defaultTheme,
  midnightTheme,
} from '../../../packages/design-tokens/theme.ts';
import {
  AppearancePersistence,
  artworkUri,
  defaultPreferences,
  focusScrollOffset,
  MAX_PREFERENCES_LENGTH,
  parsePreferences,
  prefersReducedMotion,
  recoverPreferences,
} from '../src/preferences.ts';
import type { Media } from '../../../packages/contracts/index.ts';
import { nativeSkinLayout } from '../src/skin-layout.ts';
import { fresh, pageFor } from '../src/domain.ts';
import { SessionGuard } from '../src/session.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('appearance schema round trips separately from cache and rejects unsupported data', () => {
  const preferences = {
    version: 1 as const,
    theme: midnightTheme,
    motion: 'reduced' as const,
  };
  assert.deepEqual(recoverPreferences(JSON.stringify(preferences)), {
    preferences,
    warning: '',
  });
  for (const value of [
    null,
    [],
    { ...preferences, version: 2 },
    { ...preferences, motion: 'full' },
    { ...preferences, motion: ['reduced'] },
    { ...preferences, motion: { toString: 'reduced' } },
    { ...preferences, origin: 'https://example.test' },
    { ...preferences, theme: { ...defaultTheme, css: 'body{}' } },
    {
      ...preferences,
      theme: {
        version: 1,
        name: defaultTheme.name,
        colors: defaultTheme.colors,
      },
    },
  ])
    assert.throws(() => parsePreferences(value));
});

test('missing preferences use defaults; corrupt, oversized and invalid theme data warn and recover', () => {
  assert.deepEqual(recoverPreferences(''), {
    preferences: defaultPreferences(),
    warning: '',
  });
  for (const raw of [
    'broken',
    ' '.repeat(MAX_PREFERENCES_LENGTH + 1),
    JSON.stringify({
      ...defaultPreferences(),
      theme: {
        ...defaultTheme,
        colors: {
          ...defaultTheme.colors,
          text: defaultTheme.colors.background,
        },
      },
    }),
  ]) {
    const result = recoverPreferences(raw);
    assert.deepEqual(result.preferences, defaultPreferences());
    assert.match(result.warning, /invalid/);
  }
});

test('an appearance edit or reset supersedes delayed startup load without touching playback state', async () => {
  const persistence = new AppearancePersistence();
  const reading = deferred<string>();
  const restoring = persistence.load(() => reading.promise);
  const writes: string[] = [];
  await persistence.save(defaultPreferences(), async (raw) => {
    writes.push(raw);
  });
  reading.resolve(
    JSON.stringify({ ...defaultPreferences(), theme: midnightTheme }),
  );
  assert.equal(await restoring, null);
  assert.deepEqual(JSON.parse(writes[0]), defaultPreferences());
});

test('appearance reads report storage errors without hiding user choices', async () => {
  const persistence = new AppearancePersistence();
  const result = await persistence.load(async () => {
    throw new Error('Synthetic read failure');
  });
  assert.deepEqual(result?.preferences, defaultPreferences());
  assert.match(result?.warning ?? '', /could not be read/);
});

test('appearance writes serialize rapid choices and recover from a failed write', async () => {
  const persistence = new AppearancePersistence();
  const pending = deferred<void>();
  const started = deferred<void>();
  const writes: string[] = [];
  const first = persistence.save(defaultPreferences(), async (raw) => {
    writes.push(raw);
    started.resolve();
    await pending.promise;
    throw new Error('Synthetic write failure');
  });
  const second = persistence.save(
    { ...defaultPreferences(), theme: midnightTheme },
    async (raw) => {
      writes.push(raw);
    },
  );
  await started.promise;
  assert.equal(writes.length, 1);
  pending.resolve();
  await assert.rejects(first, /Synthetic write failure/);
  await second;
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1]).theme.name, midnightTheme.name);
});

test('system reduced motion remains respected and explicit reduced always wins', () => {
  assert.equal(prefersReducedMotion('system', false), false);
  assert.equal(prefersReducedMotion('system', true), true);
  assert.equal(prefersReducedMotion('reduced', false), true);
  assert.equal(prefersReducedMotion('reduced', true), true);
  assert.equal(prefersReducedMotion('system', false, 'still'), true);
  assert.equal(prefersReducedMotion('system', true, 'subtle'), true);
});

test('authored design metrics change cards, type and density while preserving TV column/page navigation', () => {
  for (const theme of [defaultTheme, archiveTheme]) {
    const tv = nativeSkinLayout(theme, 1280, 720);
    assert.equal(tv.columns, theme.design.skin === 'marquee' ? 7 : 4);
    assert.equal(pageFor(11), 1);
    assert.equal(nativeSkinLayout(theme, 390, 844).columns, 2);
  }
  assert.equal(nativeSkinLayout(archiveTheme, 1280, 720).fontFamily, 'serif');
  assert.equal(
    nativeSkinLayout(defaultTheme, 1280, 720).fontFamily,
    'sans-serif-light',
  );
  const poster = nativeSkinLayout(defaultTheme, 1280, 720);
  const landscape = nativeSkinLayout(
    { ...defaultTheme, design: { ...defaultTheme.design, cards: 'landscape' } },
    1280,
    720,
  );
  assert.ok(poster.cardHeight > landscape.cardHeight);
  const compact = nativeSkinLayout(
    { ...defaultTheme, design: { ...defaultTheme.design, density: 'compact' } },
    1280,
    720,
  );
  assert.ok(compact.inset < poster.inset);
  assert.ok(compact.gap < poster.gap);
});

test('skin preference writes serialize the latest layout without entering catalogue, progress or playback storage', async () => {
  const id = 'a'.repeat(64);
  const state = {
    ...fresh(),
    progress: { [id]: { positionSeconds: 35, durationSeconds: 600 } },
  };
  const before = structuredClone(state);
  const cursor = 11;
  const guard = new SessionGuard();
  const ticket = guard.beginPlayback(state.origin);
  const persistence = new AppearancePersistence();
  const writes: unknown[] = [];
  await persistence.save(
    { ...defaultPreferences(), theme: archiveTheme },
    async (raw) => {
      writes.push(JSON.parse(raw));
    },
  );
  await persistence.save(
    {
      ...defaultPreferences(),
      theme: {
        ...defaultTheme,
        design: { ...defaultTheme.design, cards: 'landscape', motion: 'still' },
      },
    },
    async (raw) => {
      writes.push(JSON.parse(raw));
    },
  );
  const latest = recoverPreferences(JSON.stringify(writes[1])).preferences;
  assert.equal(latest.theme.design.skin, 'marquee');
  assert.equal(latest.theme.design.cards, 'landscape');
  assert.equal(latest.theme.design.motion, 'still');
  assert.deepEqual(state, before);
  assert.equal(pageFor(cursor), 1);
  assert.equal(guard.currentPlayback(ticket, state.origin), true);
  for (const raw of writes) {
    assert.deepEqual(Object.keys(raw as object).sort(), [
      'motion',
      'theme',
      'version',
    ]);
  }
});

test('custom D-pad scrolling reveals offscreen cards and Play while preserving visible focus', () => {
  assert.equal(focusScrollOffset(0, 194, 140, 425), 0);
  assert.equal(focusScrollOffset(0, 346, 140, 425), 73);
  assert.equal(focusScrollOffset(73, 346, 140, 425), 73);
  assert.equal(focusScrollOffset(300, 194, 140, 425), 182);
  assert.equal(focusScrollOffset(0, 800, 60, 425), 447);
  assert.equal(focusScrollOffset(100, 0, 43, 425), 0);
  assert.equal(focusScrollOffset(0, 194, 140, 0), 0);
});

test('native artwork accepts only exact validated paths at the trusted HTTPS origin', () => {
  const id = 'a'.repeat(64);
  const item: Media = {
    id,
    title: 'Synthetic fixture',
    container: 'mp4',
    sizeBytes: 10,
    streamPath: `/api/media/${id}/stream`,
    posterPath: `/api/media/${id}/poster`,
  };
  assert.equal(
    artworkUri('https://media.example.test/', item, 'poster'),
    `https://media.example.test/api/media/${id}/poster`,
  );
  assert.equal(
    artworkUri('https://media.example.test', item, 'backdrop'),
    undefined,
  );
  for (const path of [
    'https://artwork.example.test/poster',
    '//artwork.example.test/poster',
    'file:///private.png',
    `/api/media/${'b'.repeat(64)}/poster`,
  ])
    assert.equal(
      artworkUri(
        'https://media.example.test',
        { ...item, posterPath: path },
        'poster',
      ),
      undefined,
    );
  assert.equal(
    artworkUri('http://media.example.test', item, 'poster'),
    undefined,
  );
});
