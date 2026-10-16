import assert from 'node:assert/strict';
import test from 'node:test';
import {
  headerStripIndex,
  headerTarget,
  moveHeaderCursor,
} from '../src/header-navigation.ts';

test('empty library header retains separate Appearance, Requests and approved Server actions', () => {
  assert.deepEqual(headerTarget(0, 0, true), { type: 'appearance' });
  assert.deepEqual(headerTarget(0, 1, true), { type: 'requests' });
  assert.deepEqual(headerTarget(0, 2, true), { type: 'server' });
  assert.equal(headerTarget(0, 3, true), null);
  assert.equal(headerTarget(0, 2, false), null);
  assert.deepEqual(headerTarget(0, 1, false), { type: 'requests' });
});

test('library IDs keep their slots and action dispatch cannot fall through to Requests', () => {
  assert.deepEqual(
    Array.from({ length: 6 }, (_, cursor) => headerTarget(3, cursor, true)),
    [
      { type: 'library', index: 0 },
      { type: 'library', index: 1 },
      { type: 'library', index: 2 },
      { type: 'appearance' },
      { type: 'requests' },
      { type: 'server' },
    ],
  );
  assert.equal(headerTarget(3, 5, false), null);
  assert.equal(headerTarget(3, 6, true), null);
  for (const count of [-1, 1.5, NaN, Infinity])
    assert.equal(headerTarget(count, 0, true), null);
  for (const cursor of [-1, 1.5, NaN, Infinity])
    assert.equal(headerTarget(3, cursor, true), null);
});

test('D-pad reaches each action once, clamps both ends and removes the Server slot outside the library', () => {
  for (const count of [0, 3]) {
    for (const includeServer of [false, true]) {
      const last = count + (includeServer ? 2 : 1);
      let cursor = 0;
      const targets = [headerTarget(count, cursor, includeServer)];
      for (let index = 0; index < last; index++) {
        cursor = moveHeaderCursor(count, cursor, 1, includeServer);
        targets.push(headerTarget(count, cursor, includeServer));
      }
      assert.equal(cursor, last);
      assert.equal(targets.length, count + (includeServer ? 3 : 2));
      assert.ok(targets.every((target) => target !== null));
      assert.equal(
        new Set(targets.map((target) => JSON.stringify(target))).size,
        targets.length,
      );
      assert.equal(moveHeaderCursor(count, cursor, 1, includeServer), last);
      for (let index = 0; index < last; index++)
        cursor = moveHeaderCursor(count, cursor, -1, includeServer);
      assert.equal(cursor, 0);
      assert.equal(moveHeaderCursor(count, cursor, -1, includeServer), 0);
      assert.equal(moveHeaderCursor(count, 100, -1, includeServer), last);
    }
  }
});

test('strip reveal skips Appearance and scrolls to the complete Server slot with existing metrics', () => {
  for (const count of [0, 3, 12]) {
    for (let cursor = 0; cursor < count; cursor++)
      assert.equal(headerStripIndex(count, cursor), cursor);
    assert.equal(headerStripIndex(count, count), count);
    assert.equal(headerStripIndex(count, count + 1), count);
    assert.equal(headerStripIndex(count, count + 2), count + 1);
    // This is the existing 128px card, 8px gap and 16px reveal inset in NativeHeader.
    const serverLeft = (count + 1) * 136;
    const scroll = Math.max(0, headerStripIndex(count, count + 2) * 136 - 16);
    assert.ok(serverLeft >= scroll);
    assert.ok(serverLeft + 128 <= scroll + 200);
    assert.ok(serverLeft + 128 > Math.max(0, count * 136 - 16) + 200);
  }
});
