import type { Progress } from '../../../packages/contracts/index.ts';
import { resumeAt } from './model.ts';

export type PlaybackDriver = '' | 'direct' | 'hls-js' | 'native-hls';

export function restoreBrowserResume(
  node: Pick<HTMLVideoElement, 'currentTime' | 'duration'>,
  driver: PlaybackDriver,
  progress: Progress | null,
): void {
  if (
    (driver === 'direct' || driver === 'native-hls') &&
    Number.isFinite(node.duration) &&
    node.duration > 0
  )
    node.currentTime = resumeAt(progress, node.duration);
}
