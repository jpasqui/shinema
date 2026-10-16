import { parseProgress, resumeAt } from '../../../packages/contracts/index.ts';
import type { Progress } from '../../../packages/contracts/index.ts';

export type InitialPlayback = Readonly<{
  source: Readonly<{ uri: string; startPosition: number }>;
  progress: Readonly<Progress> | null;
  positionSeconds: number;
}>;

/** RNVideo's initial source position is milliseconds, unlike imperative seek. */
export function initialPlayback(
  uri: string,
  progress: Progress | null,
): InitialPlayback {
  const saved = progress ? Object.freeze(parseProgress(progress)) : null;
  const startPosition = Math.round(
    (saved ? resumeAt(saved, saved.durationSeconds) : 0) * 1000,
  );
  return Object.freeze({
    source: Object.freeze({ uri, startPosition }),
    progress: saved,
    positionSeconds: startPosition / 1000,
  });
}

/** Initial source positioning has no required onSeek acknowledgement. */
export function loadedPlayback(
  initial: InitialPlayback,
  duration: number,
  currentTime: number,
): Readonly<{ positionSeconds: number; seekTo: number | null }> {
  if (!Number.isFinite(duration) || duration <= 0)
    return { positionSeconds: 0, seekTo: null };
  const target = resumeAt(initial.progress, duration);
  // A changed file duration can change the restart decision. Never mutate the
  // source to correct it: RNVideo treats a new startPosition as a new source.
  if (Math.abs(target - initial.positionSeconds) > 0.001)
    return { positionSeconds: target, seekTo: target };
  const positionSeconds =
    Number.isFinite(currentTime) && currentTime >= 0
      ? Math.min(currentTime, duration)
      : initial.positionSeconds;
  return { positionSeconds, seekTo: null };
}
