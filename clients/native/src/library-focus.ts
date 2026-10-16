import { focusScrollOffset } from './preferences.ts';
import {
  clampFeedAnchor,
  feedScrollAnchor,
  restoreFeedAnchor,
} from './feed.ts';

type Mutable<T> = { current: T };
type LibraryScrollSnapshot = {
  library: boolean;
  known: boolean;
  total: number;
  columns: number;
  rowHeight: number;
};
export type LibraryScrollMemory = {
  measured: boolean;
  position:
    | { kind: 'offset'; offset: number }
    | { kind: 'grid'; index: number; withinRow: number };
};

export function createLibraryScrollMemory(): LibraryScrollMemory {
  return { measured: false, position: { kind: 'offset', offset: 0 } };
}

/** Actual scene callbacks keep feature scrolling distinct from global grid rows. */
export function createLibraryScrollCallbacks({
  read,
  memory,
  sceneOffset,
  libraryScroll,
  gridTop,
  navigationMode,
  onAnchor,
  scrollTo,
  revealRemote,
  touchStarted,
}: {
  read: () => LibraryScrollSnapshot;
  memory: Mutable<LibraryScrollMemory>;
  sceneOffset: Mutable<number>;
  libraryScroll: Mutable<number>;
  gridTop: Mutable<number>;
  navigationMode: Mutable<'remote' | 'touch'>;
  onAnchor: (index: number) => void;
  scrollTo: (y: number) => void;
  revealRemote: () => void;
  touchStarted: () => void;
}) {
  const capture = (offset: number, snapshot: LibraryScrollSnapshot) => {
    libraryScroll.current = offset;
    const index = feedScrollAnchor(
      offset,
      gridTop.current,
      snapshot.columns,
      snapshot.rowHeight,
      snapshot.known,
      snapshot.total,
    );
    memory.current.position =
      !memory.current.measured || offset < gridTop.current
        ? { kind: 'offset', offset }
        : {
            kind: 'grid',
            index,
            withinRow:
              Math.max(0, offset - gridTop.current) % snapshot.rowHeight,
          };
    onAnchor(index);
  };
  return {
    onScrollBeginDrag() {
      touchStarted();
      navigationMode.current = 'touch';
      const snapshot = read();
      if (snapshot.library) capture(sceneOffset.current, snapshot);
    },
    onScroll(event: { nativeEvent: { contentOffset: { y: number } } }) {
      const offset = event.nativeEvent.contentOffset.y;
      if (!Number.isFinite(offset)) return;
      sceneOffset.current = Math.max(0, offset);
      const snapshot = read();
      if (snapshot.library) capture(sceneOffset.current, snapshot);
    },
    onGridLayout(bounds: { y: number; height: number }) {
      const snapshot = read();
      if (!snapshot.library || !Number.isFinite(bounds.y) || bounds.y < 0)
        return;
      gridTop.current = bounds.y;
      memory.current.measured = true;
      if (navigationMode.current !== 'touch') {
        revealRemote();
        return;
      }
      const position = memory.current.position;
      let offset: number;
      if (position.kind === 'offset') {
        // A drag over the feature is a pixel position, not grid row zero.
        offset = position.offset;
        // A drag made before measurement may already be inside the grid.
        // Preserve its first pixel position, then anchor future reflows even
        // when scrollTo to the same position emits no native scroll event.
        if (offset >= bounds.y) {
          const index = feedScrollAnchor(
            offset,
            bounds.y,
            snapshot.columns,
            snapshot.rowHeight,
            snapshot.known,
            snapshot.total,
          );
          memory.current.position = {
            kind: 'grid',
            index,
            withinRow: (offset - bounds.y) % snapshot.rowHeight,
          };
          onAnchor(index);
        }
      } else {
        const index = clampFeedAnchor(
          position.index,
          snapshot.known,
          snapshot.total,
        );
        const withinRow = Math.max(
          0,
          Math.min(position.withinRow, snapshot.rowHeight - 1),
        );
        offset = restoreFeedAnchor(
          index,
          withinRow,
          bounds.y,
          snapshot.columns,
          snapshot.rowHeight,
        );
        memory.current.position = { kind: 'grid', index, withinRow };
        onAnchor(index);
      }
      sceneOffset.current = offset;
      libraryScroll.current = offset;
      scrollTo(offset);
    },
  };
}

/** Unknown totals still have load/retry slots; a confirmed empty feed has none. */
export function canEnterLibraryGrid(
  supported: boolean,
  known: boolean,
  total: number,
): boolean {
  return supported && (!known || total > 0);
}

/** A new library opens on its feature/header. Background work cannot steal D-pad intent. */
export function libraryEntryTarget(
  fromLibrary: boolean,
  sameScope: boolean,
  interactionCurrent: boolean,
): 'header' | 'preserve' {
  return interactionCurrent && (!fromLibrary || !sameScope)
    ? 'header'
    : 'preserve';
}

/** Reveal a complete logical card only after the user enters the grid. */
export function libraryFocusOffset({
  current,
  gridTop,
  cursor,
  columns,
  cardHeight,
  gap,
  viewport,
  headerFocused,
  navigationMode = 'remote',
}: {
  current: number;
  gridTop: number;
  cursor: number;
  columns: number;
  cardHeight: number;
  gap: number;
  viewport: number;
  headerFocused: boolean;
  navigationMode?: 'remote' | 'touch';
}): number {
  if (navigationMode === 'touch')
    return Number.isFinite(current) ? Math.max(0, current) : 0;
  if (headerFocused) return 0;
  if (
    ![current, gridTop, cursor, columns, cardHeight, gap, viewport].every(
      Number.isFinite,
    ) ||
    gridTop < 0 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    cardHeight <= 0 ||
    gap < 0 ||
    viewport <= 0
  )
    return 0;
  // The authored section is40dp plus its10dp lower gap. Entering the grid
  // reveals that heading, rather than leaving a clipped tail of the feature.
  return Math.max(
    0,
    gridTop - 50,
    focusScrollOffset(
      current,
      gridTop + Math.floor(cursor / columns) * (cardHeight + gap),
      cardHeight,
      viewport,
    ),
  );
}
