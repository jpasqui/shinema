/** Library identity is independent of its label, media grouping and navigation. */
export type MediaType = 'movies' | 'tv' | 'mixed';
export type LibraryDescriptor = {
  id: string;
  name: string;
  mediaType: MediaType;
  visible: boolean;
  order: number;
};
export type Libraries = {
  version: 1;
  revision: number;
  libraries: LibraryDescriptor[];
};
export type LibraryConfiguration = LibraryDescriptor & {
  sourceFolders: string[];
};
export type LibraryConfigurationDocument = Omit<Libraries, 'libraries'> & {
  libraries: LibraryConfiguration[];
  availableFolders: string[];
};
export const validLibraryId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
export function parseLibraries(value: unknown): Libraries {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.libraries) ||
    value.libraries.length > 64
  )
    throw new Error('Unsupported library configuration');
  const ids = new Set<string>();
  const names = new Set<string>();
  const libraries = value.libraries.map((item): LibraryDescriptor => {
    if (
      !record(item) ||
      !validLibraryId(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      item.name !== item.name.trim() ||
      !item.name ||
      Array.from(item.name).length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(item.name) ||
      names.has(item.name.toLowerCase()) ||
      !['movies', 'tv', 'mixed'].includes(String(item.mediaType)) ||
      typeof item.visible !== 'boolean' ||
      !Number.isSafeInteger(item.order) ||
      Number(item.order) < 0 ||
      Number(item.order) > 10000
    )
      throw new Error('Invalid library descriptor');
    ids.add(item.id);
    names.add(item.name.toLowerCase());
    return {
      id: item.id,
      name: item.name,
      mediaType: item.mediaType as MediaType,
      visible: item.visible,
      order: Number(item.order),
    };
  });
  return { version: 1, revision: Number(value.revision), libraries };
}
function folder(value: unknown): value is string {
  return (
    value === '.' ||
    (typeof value === 'string' &&
      value.length > 0 &&
      Array.from(value).length <= 512 &&
      !/[\\:\p{Cc}]/u.test(value) &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'))
  );
}
export function parseLibraryConfiguration(
  value: unknown,
): LibraryConfigurationDocument {
  const parsed = parseLibraries(value);
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.availableFolders) ||
    raw.availableFolders.length > 10000 ||
    !raw.availableFolders.every(folder)
  )
    throw new Error('Invalid source choices');
  const libraries = parsed.libraries.map((item, index) => {
    const sourceFolders = (raw.libraries as Record<string, unknown>[])[index]
      .sourceFolders;
    if (
      !Array.isArray(sourceFolders) ||
      sourceFolders.length > 64 ||
      !sourceFolders.every(folder) ||
      new Set(sourceFolders).size !== sourceFolders.length
    )
      throw new Error('Invalid library sources');
    return { ...item, sourceFolders: sourceFolders as string[] };
  });
  return {
    ...parsed,
    libraries,
    availableFolders: raw.availableFolders as string[],
  };
}
export const defaultLibraries = (): Libraries => ({
  version: 1,
  revision: 0,
  libraries: [
    {
      id: 'movies',
      name: 'Movies',
      mediaType: 'movies',
      visible: true,
      order: 0,
    },
    { id: 'tv', name: 'TV shows', mediaType: 'tv', visible: true, order: 1 },
    {
      id: 'other',
      name: 'Other videos',
      mediaType: 'mixed',
      visible: false,
      order: 2,
    },
  ],
});
export type NavigationPreferences = { order: string[]; hidden: string[] };
export const emptyNavigationPreferences = (): NavigationPreferences => ({
  order: [],
  hidden: [],
});
export function parseNavigationPreferences(
  value: unknown,
): NavigationPreferences {
  if (!record(value)) return emptyNavigationPreferences();
  const ids = (raw: unknown): string[] =>
    Array.isArray(raw)
      ? [...new Set(raw.filter(validLibraryId))].slice(0, 64)
      : [];
  return { order: ids(value.order), hidden: ids(value.hidden) };
}
export function visibleLibraries(
  libraries: LibraryDescriptor[],
  preferences: NavigationPreferences,
): LibraryDescriptor[] {
  const rank = (id: string) => {
    const index = preferences.order.indexOf(id);
    return index < 0 ? 10000 : index;
  };
  return libraries
    .filter((item) => item.visible && !preferences.hidden.includes(item.id))
    .sort(
      (a, b) =>
        rank(a.id) - rank(b.id) ||
        a.order - b.order ||
        a.id.localeCompare(b.id),
    );
}
