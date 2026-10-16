import { idFor, mediaFor } from './fixtures.ts';

/** One fixture factory shared by browser requests and local repro receipts. */
export function startupCatalog(
  options: { artwork?: boolean; titlePrefix?: string } = {},
) {
  return {
    apiVersion: 1,
    fullLibrary: true,
    total: 60,
    offset: 0,
    limit: 60,
    items: Array.from({ length: 60 }, (_, index) => ({
      ...mediaFor(index),
      title: options.titlePrefix
        ? `${options.titlePrefix}${String(index).padStart(2, '0')}`
        : mediaFor(index).title,
      year: 2025,
      genres: ['Adventure'],
      summary: 'A generated story used to verify the first library viewport.',
      ...(options.artwork === false
        ? {}
        : {
            posterPath: `/api/media/${idFor(index)}/poster`,
            backdropPath: `/api/media/${idFor(index)}/backdrop`,
          }),
    })),
    nextOffset: null,
  };
}
