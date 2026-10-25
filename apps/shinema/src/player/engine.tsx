import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef } from 'react';
import type { Engine, EngineSource, EngineStatus } from './engine-types';

export type { Engine, EngineSource } from './engine-types';

/** expo-video: ExoPlayer on Android TV and phones. */
export function useEngine(
  source: EngineSource,
  onTime: (seconds: number) => void,
): Engine {
  const videoSource = useMemo(
    () => ({
      uri: source.uri,
      contentType: source.hls ? ('hls' as const) : ('auto' as const),
      metadata: { title: source.title },
    }),
    [source.uri, source.hls, source.title],
  );
  const player = useVideoPlayer(videoSource, (instance) => {
    instance.timeUpdateEventInterval = 0.25;
    instance.play();
  });
  const latest = useRef(onTime);
  latest.current = onTime;
  useEffect(() => {
    const subscription = player.addListener('timeUpdate', ({ currentTime }) =>
      latest.current(currentTime),
    );
    return () => subscription.remove();
  }, [player]);
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });
  const mapped: EngineStatus =
    status === 'error'
      ? 'error'
      : status === 'readyToPlay'
        ? 'ready'
        : 'loading';
  return {
    playing: isPlaying,
    status: mapped,
    currentTime: () => player.currentTime,
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (seconds) => {
      player.currentTime = seconds;
    },
    surface: (
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        style={{ position: 'absolute', inset: 0 }}
      />
    ),
  };
}
