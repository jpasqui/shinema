import test from 'node:test';
import assert from 'node:assert/strict';
import type { LibraryDescriptor } from '../../../packages/contracts/libraries.ts';
import { collectionSlots } from '../src/collectionSlots.ts';

const library = (id: string, name = id): LibraryDescriptor => ({
  id,
  name,
  mediaType: 'movies',
  contentTypeId: 'movies',
  visible: true,
  order: 0,
});
const preferences = { order: [], hidden: [] };

test('healthy revalidation preserves surviving positions and canonical actions', () => {
  const initial = collectionSlots(
    ['custom', 'movies', 'tv'].map((id) => library(id)),
    preferences,
    true,
  );
  const hidden = collectionSlots(
    [library('tv'), library('movies', 'Cinema')],
    preferences,
    true,
    initial.map(({ id }) => id),
  );
  assert.deepEqual(
    hidden.map(({ id }) => id),
    ['custom', 'movies', 'tv'],
  );
  assert.equal(hidden[0].descriptor, undefined);
  assert.equal(hidden[1].descriptor?.name, 'Cinema');
  const added = collectionSlots(
    [library('new'), library('tv'), library('movies')],
    preferences,
    true,
    hidden.map(({ id }) => id),
  );
  assert.deepEqual(
    added.map(({ id }) => id),
    ['new', 'movies', 'tv'],
  );
  assert.equal(
    added.some(({ descriptor }) => descriptor?.id === 'custom'),
    false,
  );
});

test('repeated disjoint discoveries reuse vacant cells within validated bounds', () => {
  const saved = {
    order: Array.from({ length: 64 }, (_, index) => `saved-${index}`),
    hidden: [],
  };
  let slots = collectionSlots([library('movies')], saved, true);
  for (let revision = 0; revision < 300; revision++) {
    const current = [
      library('movies'),
      ...Array.from({ length: 63 }, (_, index) =>
        library(`r${revision}-${index}`),
      ),
    ];
    slots = collectionSlots(
      current,
      saved,
      true,
      slots.map(({ id }) => id),
    );
    assert.equal(
      slots.findIndex(({ id }) => id === 'movies'),
      64,
    );
    assert.ok(slots.length <= 128);
    assert.equal(slots.filter(({ descriptor }) => descriptor).length, 64);
    assert.equal(new Set(slots.map(({ id }) => id)).size, slots.length);
    assert.equal(
      slots.find(({ id }) => id === 'saved-0')?.descriptor,
      undefined,
    );
  }
});

test('explicit navigation reset uses current order and pending cells stay inert', () => {
  const current = [library('tv'), library('movies')];
  const pending = collectionSlots(current, preferences, false);
  assert.ok(pending.every(({ descriptor }) => descriptor === undefined));
  assert.deepEqual(
    collectionSlots(current, preferences, true).map(({ id }) => id),
    ['tv', 'movies'],
  );
  assert.deepEqual(
    collectionSlots(current, { order: ['movies'], hidden: [] }, true).map(
      ({ id }) => id,
    ),
    ['movies', 'tv'],
  );
});
