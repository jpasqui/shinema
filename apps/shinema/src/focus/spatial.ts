/**
 * Picks the element an arrow key should move to, the way a TV remote moves
 * focus. Android TV and tvOS do this natively; the web build uses it so
 * arrow keys behave the same in a browser.
 */
export type Direction = 'up' | 'down' | 'left' | 'right';
export type Rect = { left: number; top: number; width: number; height: number };

const centre = (rect: Rect) => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/**
 * Returns the index of the best candidate, or -1. Candidates must lie in the
 * pressed direction; among them, the nearest wins, with sideways distance
 * weighted more heavily so movement stays in the same row or column.
 */
export function pickNeighbour(
  from: Rect,
  candidates: readonly Rect[],
  direction: Direction,
): number {
  const origin = centre(from);
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((rect, index) => {
    const target = centre(rect);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const horizontal = direction === 'left' || direction === 'right';
    const forward =
      direction === 'right'
        ? rect.left - (from.left + from.width) + rect.width / 2
        : direction === 'left'
          ? from.left - (rect.left + rect.width) + rect.width / 2
          : direction === 'down'
            ? rect.top - (from.top + from.height) + rect.height / 2
            : from.top - (rect.top + rect.height) + rect.height / 2;
    const ahead = horizontal
      ? direction === 'right'
        ? dx > 1
        : dx < -1
      : direction === 'down'
        ? dy > 1
        : dy < -1;
    if (!ahead || forward < 0) return;
    const sideways = Math.abs(horizontal ? dy : dx);
    const score = Math.max(0, forward) + sideways * 2;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}
