import { parseProgress, type Progress } from './progress-types.ts';

/**
 * The previous Android TV client (clients/native) kept its state in
 * client-state.json. When the new app is installed over it, unsynced
 * progress from that file is carried over rather than lost.
 */
export type LegacyState = {
  /** The server the old app used, when it can be read. */
  origin: string | null;
  /** Positions the old app had not yet sent, stamped with `observedAt`. */
  pending: [string, Progress][];
};

const ID = /^[a-f0-9]{64}$/;

function origin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads the old file. The old app had no timestamps, so entries use the
 * file's last-modified time: anything watched later on another device wins.
 */
export function parseLegacyState(
  text: string,
  observedAt: number,
): LegacyState {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null)
      return { origin: null, pending: [] };
    value = parsed as Record<string, unknown>;
  } catch {
    return { origin: null, pending: [] };
  }
  const pending: [string, Progress][] = [];
  const raw = value.pending;
  if (typeof raw === 'object' && raw !== null)
    for (const [id, entry] of Object.entries(raw)) {
      if (!ID.test(id)) continue;
      try {
        const progress = parseProgress(entry);
        if (progress)
          pending.push([
            id,
            {
              positionSeconds: progress.positionSeconds,
              durationSeconds: progress.durationSeconds,
              updatedAt: Math.floor(observedAt),
            },
          ]);
      } catch {
        // Skip a damaged entry; keep the rest.
      }
    }
  return {
    // The local-HTTP build stored the plain-HTTP server separately.
    origin: origin(value.localHttpOrigin) ?? origin(value.origin),
    pending,
  };
}
