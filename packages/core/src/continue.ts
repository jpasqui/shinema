import { parseCatalog, type Media } from '../../contracts/index.ts';
import { parseProgress, type Progress } from './progress-types.ts';

/** A title started but not finished, from `GET /api/continue`. */
export type ContinueItem = { media: Media; progress: Progress };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates the continue-watching list with the same rules as catalog items
 * and saved progress, so nothing unchecked reaches a screen.
 */
export function parseContinue(value: unknown): ContinueItem[] {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !value.items.every(object)
  )
    throw new Error('Unsupported continue list');
  const items = value.items as Record<string, unknown>[];
  const media = parseCatalog({
    apiVersion: 1,
    items: items.map((item) => item.media),
  }).items;
  return items.map((item, index) => {
    const progress = parseProgress(item.progress);
    if (!progress) throw new Error('Invalid continue item');
    return { media: media[index]!, progress };
  });
}
