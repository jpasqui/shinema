import { focusScrollOffset } from './preferences.ts';

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
