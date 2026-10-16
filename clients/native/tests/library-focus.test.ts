import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  libraryEntryTarget,
  libraryFocusOffset,
} from '../src/library-focus.ts';
import { NativeActivity } from '../src/lifecycle.ts';
import {
  nativeSkinLayout,
  nativeReservedGeometry,
} from '../src/skin-layout.ts';
import {
  defaultTheme,
  archiveTheme,
} from '../../../packages/design-tokens/theme.ts';

test('new library entry reveals its feature; same-scope refresh preserves the browsing region', () => {
  assert.equal(libraryEntryTarget(false, true, true), 'header');
  assert.equal(libraryEntryTarget(false, false, true), 'header');
  assert.equal(libraryEntryTarget(true, false, true), 'header');
  assert.equal(libraryEntryTarget(true, true, true), 'preserve');
});

test('Down during a delayed restored connection wins over its eventual header presentation', async () => {
  const activity = new NativeActivity();
  activity.beginConnection();
  const ticket = activity.capture();
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled = response.then(() =>
    libraryEntryTarget(false, true, activity.current(ticket)),
  );
  activity.interact();
  release();
  assert.equal(await settled, 'preserve');
  assert.equal(
    libraryEntryTarget(true, false, activity.current(ticket)),
    'preserve',
  );
});

test('TV entry keeps the entire feature in view until explicit grid navigation', () => {
  for (const theme of [defaultTheme, archiveTheme])
    for (const [width, height] of [
      [960, 540],
      [1280, 720],
      [1920, 1080],
    ]) {
      const layout = nativeSkinLayout(theme, width, height);
      const geometry = nativeReservedGeometry(theme, width, height);
      const viewport = height - layout.inset * 2 - 64 - 36;
      const args = {
        current: 0,
        gridTop: geometry.feature + 60,
        cursor: 0,
        columns: layout.columns,
        cardHeight: layout.cardHeight,
        gap: layout.gap,
        viewport,
        headerFocused: true,
      };
      assert.equal(libraryFocusOffset(args), 0);
      assert.ok(
        geometry.feature <= viewport,
        `${width}x${height} feature fits before grid entry`,
      );
      const offset = libraryFocusOffset({ ...args, headerFocused: false });
      assert.ok(
        offset >= args.gridTop - 50,
        'grid entry never leaves a clipped feature strip',
      );
      const top = args.gridTop - offset;
      assert.ok(
        top >= 12 && top + layout.cardHeight <= viewport - 12,
        `${width}x${height} complete first card is visible after Down`,
      );
      assert.equal(
        libraryFocusOffset({ ...args, current: offset, headerFocused: false }),
        offset,
        'return from details retains the visible card',
      );
      assert.equal(
        libraryFocusOffset({ ...args, current: offset, headerFocused: true }),
        0,
        'Up to header restores the feature',
      );
    }
});

test('rapid row navigation reveals the current global slot without a paging jump', () => {
  const layout = nativeSkinLayout(defaultTheme, 960, 540);
  const viewport = 540 - layout.inset * 2 - 100;
  let offset = 0;
  for (const cursor of [
    0,
    1,
    layout.columns - 1,
    layout.columns,
    47,
    48,
    319,
    73,
    0,
  ]) {
    offset = libraryFocusOffset({
      current: offset,
      gridTop: 240,
      cursor,
      columns: layout.columns,
      cardHeight: layout.cardHeight,
      gap: layout.gap,
      viewport,
      headerFocused: false,
    });
    const top =
      240 +
      Math.floor(cursor / layout.columns) * (layout.cardHeight + layout.gap) -
      offset;
    assert.ok(top >= 12 && top + layout.cardHeight <= viewport - 12);
  }
});

test('invalid or not-yet-measured focus geometry never causes an unbounded scroll', () => {
  const args = {
    current: 0,
    gridTop: 240,
    cursor: 0,
    columns: 6,
    cardHeight: 270,
    gap: 12,
    viewport: 384,
    headerFocused: false,
  };
  for (const changed of [
    { viewport: 0 },
    { gridTop: Number.NaN },
    { cursor: -1 },
    { columns: 0 },
    { cardHeight: -1 },
    { gap: -1 },
  ])
    assert.equal(libraryFocusOffset({ ...args, ...changed }), 0);
});
