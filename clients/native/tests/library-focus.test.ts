import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canEnterLibraryGrid,
  createLibraryScrollCallbacks,
  createLibraryScrollMemory,
  libraryEntryTarget,
  libraryFocusOffset,
} from '../src/library-focus.ts';
import { NativeActivity } from '../src/lifecycle.ts';
import { NativeFeed, feedSlotCount } from '../src/feed.ts';
import {
  nativeSkinLayout,
  nativeReservedGeometry,
} from '../src/skin-layout.ts';
import {
  defaultTheme,
  archiveTheme,
} from '../../../packages/design-tokens/theme.ts';

function scrollHarness(known = false, headerFocused = true) {
  const snapshot = {
    library: true,
    known,
    total: known ? 96 : 0,
    columns: 6,
    rowHeight: 283,
  };
  const memory = { current: createLibraryScrollMemory() };
  const sceneOffset = { current: 0 };
  const libraryScroll = { current: 0 };
  const gridTop = { current: 0 };
  const navigationMode: { current: 'remote' | 'touch' } = { current: 'remote' };
  const activity = new NativeActivity();
  const anchors: number[] = [];
  const scrolled: number[] = [];
  let remoteReveals = 0;
  const callbacks = createLibraryScrollCallbacks({
    read: () => snapshot,
    memory,
    sceneOffset,
    libraryScroll,
    gridTop,
    navigationMode,
    onAnchor: (index) => anchors.push(index),
    scrollTo: (offset) => scrolled.push(offset),
    revealRemote: () => {
      remoteReveals++;
      const offset = libraryFocusOffset({
        current: sceneOffset.current,
        gridTop: gridTop.current,
        cursor: 0,
        columns: snapshot.columns,
        cardHeight: snapshot.rowHeight - 12,
        gap: 12,
        viewport: 384,
        headerFocused,
      });
      sceneOffset.current = offset;
      libraryScroll.current = offset;
      scrolled.push(offset);
    },
    touchStarted: () => activity.interact(),
  });
  return {
    callbacks,
    snapshot,
    memory,
    sceneOffset,
    libraryScroll,
    gridTop,
    navigationMode,
    activity,
    anchors,
    scrolled,
    remoteReveals: () => remoteReveals,
  };
}

const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { y } } });

test('App wires the tested production scroll callbacks for touch, scene offsets and grid layout', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  for (const event of ['onScrollBeginDrag', 'onScroll', 'onGridLayout'])
    assert.match(
      app,
      new RegExp(
        `${event}\\s*=\\s*\\{\\s*libraryScrollCallbacks\\.${event}\\s*\\}`,
      ),
    );
  assert.match(
    app,
    /libraryScrollCallbacks\s*=\s*createLibraryScrollCallbacks\(/,
  );
  assert.match(
    app,
    /libraryScrollMemory\.current\s*=\s*createLibraryScrollMemory\(\)/,
    'a confirmed scope change resets touch memory with the existing scroll reset',
  );
  assert.doesNotMatch(
    app,
    /withinLibraryRow/,
    'the old row-only callback cannot remain wired alongside the controller',
  );
});

test('production callbacks retain raw feature offset100 through delayed catalogue layout for known and unknown feeds', async () => {
  for (const known of [false, true])
    for (const headerFocused of [false, true]) {
      const h = scrollHarness(known, headerFocused);
      h.callbacks.onGridLayout({ y: 254, height: 0 });
      h.activity.beginConnection();
      const ticket = h.activity.capture();
      let resolve!: () => void;
      const response = new Promise<void>((done) => {
        resolve = done;
      });
      const delayed = response.then(() => {
        h.snapshot.known = true;
        h.snapshot.total = 10000;
        h.callbacks.onGridLayout({ y: 254, height: 480000 });
        return libraryEntryTarget(false, true, h.activity.current(ticket));
      });
      h.callbacks.onScrollBeginDrag();
      h.callbacks.onScroll(scrollEvent(100));
      const revealsBefore = h.remoteReveals();
      assert.deepEqual(h.memory.current.position, {
        kind: 'offset',
        offset: 100,
      });
      assert.equal(h.anchors.at(-1), 0);
      resolve();
      assert.equal(
        await delayed,
        'preserve',
        'touch invalidates the connection presentation ticket',
      );
      assert.equal(h.sceneOffset.current, 100);
      assert.equal(h.libraryScroll.current, 100);
      assert.equal(h.scrolled.at(-1), 100);
      assert.equal(
        h.remoteReveals(),
        revealsBefore,
        `headerFocused=${headerFocused} cannot replace touch intent`,
      );
      for (const total of [0, 1, 96]) {
        h.snapshot.total = total;
        h.callbacks.onGridLayout({ y: 270, height: 2000 });
        assert.equal(
          h.scrolled.at(-1),
          100,
          'empty, smaller and appended data cannot reinterpret the feature as row zero',
        );
      }
    }
});

test('production touch callbacks preserve raw position before the first grid measurement', () => {
  for (const known of [false, true]) {
    const h = scrollHarness(known);
    h.callbacks.onScrollBeginDrag();
    h.callbacks.onScroll(scrollEvent(100));
    assert.equal(h.memory.current.measured, false);
    assert.deepEqual(h.memory.current.position, {
      kind: 'offset',
      offset: 100,
    });
    h.callbacks.onGridLayout({ y: 254, height: 2000 });
    assert.equal(h.gridTop.current, 254);
    assert.equal(h.scrolled.at(-1), 100);
    assert.equal(h.remoteReveals(), 0);
  }
});

test('production grid callbacks use the latest captured row without waiting for React anchor state', () => {
  const h = scrollHarness(true, false);
  h.callbacks.onGridLayout({ y: 254, height: 4000 });
  h.callbacks.onScrollBeginDrag();
  h.callbacks.onScroll(scrollEvent(254 + 2 * 283 + 37));
  assert.deepEqual(h.memory.current.position, {
    kind: 'grid',
    index: 12,
    withinRow: 37,
  });
  // Reflow before any React render-anchor update: the callback's ref is current.
  h.snapshot.columns = 7;
  h.snapshot.rowHeight = 321;
  h.callbacks.onGridLayout({ y: 300, height: 5000 });
  assert.equal(h.scrolled.at(-1), 300 + 321 + 37);
  assert.equal(h.anchors.at(-1), 12);
  h.callbacks.onScroll(scrollEvent(300 + 4 * 321 + 250));
  h.snapshot.total = 8;
  h.snapshot.rowHeight = 200;
  h.callbacks.onGridLayout({ y: 280, height: 1000 });
  assert.equal(h.scrolled.at(-1), 280 + 200 + 199);
  assert.deepEqual(h.memory.current.position, {
    kind: 'grid',
    index: 7,
    withinRow: 199,
  });
  h.snapshot.total = 96;
  h.callbacks.onGridLayout({ y: 280, height: 6000 });
  assert.equal(
    h.scrolled.at(-1),
    280 + 200 + 199,
    'a later append cannot revive an out-of-range old anchor',
  );
});

test('first measurement promotes a raw in-grid touch position without depending on another native scroll event', () => {
  const h = scrollHarness();
  h.callbacks.onScrollBeginDrag();
  h.callbacks.onScroll(scrollEvent(428));
  assert.deepEqual(h.memory.current.position, { kind: 'offset', offset: 428 });
  h.callbacks.onGridLayout({ y: 254, height: 4000 });
  assert.equal(
    h.scrolled.at(-1),
    428,
    'the first measurement retains the exact pixel offset',
  );
  assert.deepEqual(h.memory.current.position, {
    kind: 'grid',
    index: 0,
    withinRow: 174,
  });
  h.snapshot.known = true;
  h.snapshot.total = 96;
  h.snapshot.columns = 7;
  h.snapshot.rowHeight = 321;
  h.callbacks.onGridLayout({ y: 300, height: 5000 });
  assert.equal(
    h.scrolled.at(-1),
    474,
    'later reflow uses the promoted within-row anchor',
  );
});

test('production callbacks keep exact grid boundary anchored and return feature scrolling to raw mode', () => {
  const h = scrollHarness(true);
  h.callbacks.onGridLayout({ y: 254, height: 4000 });
  h.callbacks.onScrollBeginDrag();
  h.callbacks.onScroll(scrollEvent(254));
  assert.deepEqual(h.memory.current.position, {
    kind: 'grid',
    index: 0,
    withinRow: 0,
  });
  h.callbacks.onGridLayout({ y: 280, height: 4000 });
  assert.equal(h.scrolled.at(-1), 280);
  h.callbacks.onScroll(scrollEvent(80));
  h.callbacks.onGridLayout({ y: 300, height: 4000 });
  assert.equal(h.scrolled.at(-1), 80);
  assert.deepEqual(h.memory.current.position, { kind: 'offset', offset: 80 });
});

test('production remote layout still delegates to existing focus reveal and other routes cannot mutate library memory', () => {
  for (const headerFocused of [false, true]) {
    const h = scrollHarness(true, headerFocused);
    h.callbacks.onGridLayout({ y: 254, height: 4000 });
    assert.equal(h.remoteReveals(), 1);
    assert.equal(h.scrolled.at(-1), headerFocused ? 0 : 204);
    h.callbacks.onScrollBeginDrag();
    h.callbacks.onScroll(scrollEvent(100));
    const remembered = structuredClone(h.memory.current);
    h.snapshot.library = false;
    h.callbacks.onScroll(scrollEvent(44));
    h.callbacks.onGridLayout({ y: 999, height: 4000 });
    assert.equal(h.sceneOffset.current, 44);
    assert.equal(h.libraryScroll.current, 100);
    assert.deepEqual(h.memory.current, remembered);
    assert.equal(h.gridTop.current, 254);
    h.snapshot.library = true;
    h.navigationMode.current = 'remote';
    h.callbacks.onGridLayout({ y: 254, height: 4000 });
    assert.equal(h.remoteReveals(), 2);
    assert.equal(h.scrolled.at(-1), headerFocused ? 0 : 204);
  }
});

test('D-pad can reach an unknown catalogue Retry slot, then respects authoritative empty state', async () => {
  const feed = new NativeFeed({
    origin: 'https://media.example.test',
    libraryId: 'cinema',
    revision: 2,
    collection: 'movies',
  });
  const reachable = () => {
    const { known, total } = feed.snapshot();
    return canEnterLibraryGrid(true, known, total);
  };
  assert.ok(feedSlotCount(feed.snapshot().known, feed.snapshot().total) > 0);
  assert.equal(reachable(), true, 'initial loading slots accept Down');
  await feed.load(
    0,
    async () => {
      throw new Error('Synthetic offline response');
    },
    0,
  );
  assert.ok(feed.errorAt(0));
  assert.equal(feed.snapshot().known, false);
  assert.equal(feed.snapshot().total, 0);
  assert.equal(
    reachable(),
    true,
    'failed first page remains reachable for Retry',
  );
  assert.equal(canEnterLibraryGrid(false, false, 0), false);
  const empty = {
    apiVersion: 1,
    items: [],
    offset: 0,
    limit: 48,
    total: 0,
    nextOffset: null,
  };
  assert.equal(await feed.load(0, async () => empty, 0, true), true);
  assert.equal(feed.snapshot().known, true);
  assert.equal(feedSlotCount(feed.snapshot().known, feed.snapshot().total), 0);
  assert.equal(
    reachable(),
    false,
    'confirmed empty view keeps navigation in the header',
  );
  assert.equal(canEnterLibraryGrid(true, true, 96), true);
});

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

test('delayed first catalogue geometry preserves a newer touch anchor even while header state is retained', async () => {
  const activity = new NativeActivity();
  activity.beginConnection();
  const ticket = activity.capture();
  let finish!: () => void;
  const catalogue = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const layout = nativeSkinLayout(defaultTheme, 960, 540);
  const original = {
    current: 0,
    gridTop: 254,
    cursor: 0,
    columns: layout.columns,
    cardHeight: layout.cardHeight,
    gap: layout.gap,
    viewport: 384,
    headerFocused: true,
  };
  assert.equal(libraryFocusOffset(original), 0);
  activity.interact();
  const dragged = 428;
  const settled = catalogue.then(() => ({
    target: libraryEntryTarget(false, true, activity.current(ticket)),
    offset: libraryFocusOffset({
      ...original,
      current: dragged,
      navigationMode: 'touch',
    }),
  }));
  finish();
  assert.deepEqual(await settled, { target: 'preserve', offset: dragged });
  // A later authoritative grid-height callback still cannot force header scroll.
  assert.equal(
    libraryFocusOffset({
      ...original,
      current: dragged,
      viewport: 380,
      navigationMode: 'touch',
    }),
    dragged,
  );
  // Only a new, explicit D-pad header action returns to the feature.
  assert.equal(
    libraryFocusOffset({
      ...original,
      current: dragged,
      navigationMode: 'remote',
    }),
    0,
  );
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
