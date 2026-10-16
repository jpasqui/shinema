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
  const ids = new Set([
    ...preferences.order.filter((id) => !hidden.has(id)),
    ...retainedOrder.filter((id) => !hidden.has(id)),
    ...visible.map((library) => library.id),
  ]);
  return [...ids].map((id) => ({
    id,
    descriptor: ready ? allowed.get(id) : undefined,
  }));
}
