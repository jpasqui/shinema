export type Progress = {
  positionSeconds: number;
  durationSeconds: number;
  /** Unix milliseconds when this position was observed on the device. */
  updatedAt?: number;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Validates server or stored progress and keeps only known fields. */
export function parseProgress(value: unknown): Progress | null {
  if (value === null) return null;
  if (
    !object(value) ||
    typeof value.positionSeconds !== 'number' ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.positionSeconds) ||
    !Number.isFinite(value.durationSeconds) ||
    value.positionSeconds < 0 ||
    value.durationSeconds <= 0 ||
    value.durationSeconds > 604800 ||
    value.positionSeconds > value.durationSeconds ||
    (value.updatedAt !== undefined &&
      (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0))
  )
    throw new Error('Invalid progress');
  return {
    positionSeconds: value.positionSeconds,
    durationSeconds: value.durationSeconds,
    ...(value.updatedAt !== undefined
      ? { updatedAt: Number(value.updatedAt) }
      : {}),
  };
}

export type WatchState =
  | { kind: 'unwatched' }
  | { kind: 'inProgress'; resumeAt: number; fraction: number }
  | { kind: 'watched' };

/**
 * Where playback should start and how to label it. Titles count as watched
 * once 95% has played or fewer than 30 seconds remain (end credits), so a
 * finished film shows "Watched" and plays from the start, never "Resume".
 * The first 10 seconds do not count as started.
 */
export function watchState(progress: Progress | null): WatchState {
  if (!progress) return { kind: 'unwatched' };
  const { positionSeconds: position, durationSeconds: duration } = progress;
  const remaining = duration - position;
  if (position / duration >= 0.95 || (remaining <= 30 && duration > 120))
    return { kind: 'watched' };
  if (remaining <= 3) return { kind: 'watched' };
  if (position < 10) return { kind: 'unwatched' };
  return {
    kind: 'inProgress',
    resumeAt: position,
    fraction: position / duration,
  };
}

export function resumePosition(progress: Progress | null): number {
  const state = watchState(progress);
  return state.kind === 'inProgress' ? state.resumeAt : 0;
}
