export type HeaderTarget =
  | { type: 'library'; index: number }
  | { type: 'appearance' | 'requests' | 'server' };

const validCount = (count: number) =>
  Number.isSafeInteger(count) &&
  count >= 0 &&
  count <= Number.MAX_SAFE_INTEGER - 2;

/** Stable action identities do not depend on whether a library has any titles. */
export function headerTarget(
  count: number,
  cursor: number,
  includeServer: boolean,
): HeaderTarget | null {
  if (!validCount(count) || !Number.isSafeInteger(cursor) || cursor < 0)
    return null;
  if (cursor < count) return { type: 'library', index: cursor };
  if (cursor === count) return { type: 'appearance' };
  if (cursor === count + 1) return { type: 'requests' };
  if (includeServer && cursor === count + 2) return { type: 'server' };
  return null;
}

export function moveHeaderCursor(
  count: number,
  current: number,
  direction: -1 | 1,
  includeServer: boolean,
): number {
  if (!validCount(count)) return 0;
  const cursor = Number.isSafeInteger(current) ? current : 0;
  return Math.max(
    0,
    Math.min(count + (includeServer ? 2 : 1), cursor + direction),
  );
}

/** Appearance is above the strip, so Requests and Server follow the library slots. */
export function headerStripIndex(count: number, cursor: number): number {
  if (!validCount(count) || !Number.isSafeInteger(cursor)) return 0;
  return Math.max(0, Math.min(count + 1, cursor > count ? cursor - 1 : cursor));
}
