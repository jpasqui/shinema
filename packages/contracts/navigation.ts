import { validLibraryId } from './libraries.ts';
import type { LibraryDescriptor } from './libraries.ts';

/** Navigation is data: destination IDs never contain a URL, script or callback. */
export type TopNavigationDestination =
  | { kind: 'browse' }
  | { kind: 'library'; libraryId: string }
  | { kind: 'search' }
  | { kind: 'settings' };
export type TopNavigationEntry = {
  id: string;
  label: string;
  destination: TopNavigationDestination;
  order: number;
  visible: boolean;
};
export type TopNavigationPreferences = {
  version: 1;
  entries: TopNavigationEntry[];
};
export const topNavigationStorageKey = 'shinema.web.top-navigation.v1';
export const maxTopNavigationEntries = 16;

export function defaultTopNavigation(): TopNavigationPreferences {
  return {
    version: 1,
    entries: [
      {
        id: 'primary',
        label: 'Library',
        destination: { kind: 'browse' },
        order: 0,
        visible: true,
      },
    ],
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function parseTopNavigationDestination(
  value: unknown,
): TopNavigationDestination {
  if (!record(value)) throw new Error('Choose a supported destination.');
  if (
    (value.kind === 'browse' ||
      value.kind === 'search' ||
      value.kind === 'settings') &&
    exactKeys(value, ['kind'])
  )
    return { kind: value.kind as 'browse' | 'search' | 'settings' };
  if (
    value.kind === 'library' &&
    exactKeys(value, ['kind', 'libraryId']) &&
    validLibraryId(value.libraryId)
  )
    return { kind: 'library', libraryId: value.libraryId };
  throw new Error('Choose a supported destination.');
}

/** Strict validation prevents a partially corrupt save from silently changing a link. */
export function parseTopNavigation(value: unknown): TopNavigationPreferences {
  if (
    !record(value) ||
    !exactKeys(value, ['version', 'entries']) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > maxTopNavigationEntries
  )
    throw new Error('Unsupported navigation preferences.');
  const ids = new Set<string>();
  const labels = new Set<string>();
  const entries = value.entries.map((item): TopNavigationEntry => {
    if (
      !record(item) ||
      !exactKeys(item, ['id', 'label', 'destination', 'order', 'visible']) ||
      !validLibraryId(item.id) ||
      ids.has(item.id)
    )
      throw new Error('Navigation items need unique, stable IDs.');
    if (
      typeof item.label !== 'string' ||
      !item.label ||
      item.label !== item.label.trim() ||
      Array.from(item.label).length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(item.label)
    )
      throw new Error(
        'Use a label of 1–80 characters without control characters.',
      );
    const labelKey = item.label.normalize('NFKC').toLowerCase();
    if (labels.has(labelKey))
      throw new Error('Give each navigation item a different label.');
    if (
      typeof item.visible !== 'boolean' ||
      !Number.isSafeInteger(item.order) ||
      Number(item.order) < 0 ||
      Number(item.order) > 10000
    )
      throw new Error('Invalid navigation order or visibility.');
    ids.add(item.id);
    labels.add(labelKey);
    return {
      id: item.id,
      label: item.label,
      destination: parseTopNavigationDestination(item.destination),
      order: Number(item.order),
      visible: item.visible,
    };
  });
  return { version: 1, entries };
}

export function recoverTopNavigation(
  raw: string | null,
): TopNavigationPreferences {
  try {
    // Bound parsing work even when browser storage was edited outside the app.
    if (!raw || raw.length > 65536) return defaultTopNavigation();
    return parseTopNavigation(JSON.parse(raw));
  } catch {
    return defaultTopNavigation();
  }
}

export function orderedTopNavigation(
  preferences: TopNavigationPreferences,
): TopNavigationEntry[] {
  return [...preferences.entries].sort(
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Missing/hidden library targets stay saved, ready for an operator to restore. */
export function visibleTopNavigation(
  preferences: TopNavigationPreferences,
  libraries: readonly LibraryDescriptor[],
): TopNavigationEntry[] {
  return orderedTopNavigation(preferences).filter((entry) => {
    const destination = entry.destination;
    return (
      entry.visible &&
      (destination.kind !== 'library' ||
        libraries.some(
          (library) => library.id === destination.libraryId && library.visible,
        ))
    );
  });
}

export function moveTopNavigation(
  preferences: TopNavigationPreferences,
  id: string,
  direction: -1 | 1,
): TopNavigationPreferences {
  const entries = orderedTopNavigation(preferences);
  const index = entries.findIndex((entry) => entry.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= entries.length) return preferences;
  [entries[index], entries[target]] = [entries[target], entries[index]];
  return {
    version: 1,
    entries: entries.map((entry, order) => ({ ...entry, order })),
  };
}
