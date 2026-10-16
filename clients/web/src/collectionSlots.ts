import type {
  LibraryDescriptor,
  NavigationPreferences,
} from '../../../packages/contracts/libraries.ts';

/** Physical positions stay separate from which destinations may be used. */
export function collectionSlots(
  visible: readonly LibraryDescriptor[],
  preferences: NavigationPreferences,
  ready: boolean,
  retainedOrder: readonly string[] = [],
) {
  const hidden = new Set(preferences.hidden);
  const allowed = new Map(visible.map((library) => [library.id, library]));
  const desired = new Set([
    ...preferences.order.filter((id) => !hidden.has(id)),
    ...visible.map((library) => library.id),
  ]);
  const ids = [...retainedOrder];
  for (const id of desired) {
    if (ids.includes(id)) continue;
    // Reuse an inactive cell rather than moving a surviving destination or
    // accumulating historical IDs. Validated server/client lists each allow
    // at most 64 IDs, so the physical list remains bounded to 128 cells.
    const vacant = ids.findIndex((previous) => !desired.has(previous));
    if (vacant === -1) ids.push(id);
    else ids[vacant] = id;
  }
  return ids.map((id) => ({
    id,
    descriptor: ready ? allowed.get(id) : undefined,
  }));
}
