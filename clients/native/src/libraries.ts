import {
  parseCatalog,
  parseLibraries,
} from '../../../packages/contracts/index.ts';
import type {
  Catalog,
  Libraries,
  LibraryDescriptor,
} from '../../../packages/contracts/index.ts';

/** Navigation is a device preference; descriptors are an origin-bound server snapshot. */
export type LibraryNavigation = {
  libraries: Libraries | null;
  selectedLibraryId: string | null;
};
export type LibrarySnapshot = LibraryNavigation & { catalog: Catalog };

export class HttpStatusError extends Error {
  status: number;
  constructor(status: number) {
    super('Server request failed');
    this.status = status;
  }
}

export function visibleLibraries(
  libraries: Libraries | null,
): LibraryDescriptor[] {
  return (libraries?.libraries ?? [])
    .filter((library) => library.visible)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function selectedLibrary(
  libraries: Libraries,
  preferred: string | null,
): string | null {
  const visible = visibleLibraries(libraries);
  return (
    visible.find((library) => library.id === preferred)?.id ??
    visible[0]?.id ??
    null
  );
}

/** Reject cached scopes that cannot be attributed to the selected descriptor. */
export function scopedCatalog(value: unknown, id: string): Catalog {
  const catalog = parseCatalog(value);
  if (catalog.items.some((item) => item.libraryId !== id))
    throw new Error('Catalog library mismatch');
  return catalog;
}

/** Only a missing endpoint enables legacy browsing. Failures retain the confirmed cache. */
export async function loadLibrarySnapshot(
  origin: string,
  preferred: string | null,
  previous: Libraries | null,
  request: (origin: string, path: string) => Promise<unknown>,
): Promise<LibrarySnapshot> {
  let libraries: Libraries;
  try {
    libraries = parseLibraries(await request(origin, '/api/libraries'));
  } catch (error) {
    if (!(error instanceof HttpStatusError) || error.status !== 404)
      throw error;
    // A configured server must not silently lose its scope if an endpoint regresses.
    if (previous)
      throw new Error('Library configuration is unavailable', { cause: error });
    return {
      libraries: null,
      selectedLibraryId: null,
      catalog: parseCatalog(await request(origin, '/api/catalog?limit=500')),
    };
  }
  if (previous && libraries.revision < previous.revision)
    throw new Error('Stale library configuration');
  const selectedLibraryId = selectedLibrary(libraries, preferred);
  const catalog =
    selectedLibraryId === null
      ? { apiVersion: 1 as const, items: [] }
      : scopedCatalog(
          await request(
            origin,
            `/api/catalog?library=${encodeURIComponent(selectedLibraryId)}&limit=500&revision=${libraries.revision}`,
          ),
          selectedLibraryId,
        );
  return { libraries, selectedLibraryId, catalog };
}
