import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import type { Engine, EngineSource, EngineStatus } from './engine-types';

export type { Engine, EngineSource } from './engine-types';

/**
 * A plain video element. Direct files play natively; transcoded HLS uses the
 * browser's own HLS support when it has it (Safari) and hls.js otherwise.
 */
export function useEngine(
  source: EngineSource,
  onTime: (seconds: number) => void,
): Engine {
  const video = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<EngineStatus>('loading');
  const latest = useRef(onTime);
  latest.current = onTime;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let hls: Hls | null = null;
    setStatus('loading');
    if (
      source.hls &&
      !element.canPlayType('application/vnd.apple.mpegurl') &&
      Hls.isSupported()
    ) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        // Recover from brief network or decode hiccups before giving up.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
          hls?.recoverMediaError();
        else setStatus('error');
      });
      hls.loadSource(source.uri);
      hls.attachMedia(element);
    } else {
      element.src = source.uri;
    }
    const ready = () => setStatus('ready');
    const failed = () => {
      if (!hls) setStatus('error');
    };
    const time = () => latest.current(element.currentTime);
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    element.addEventListener('loadedmetadata', ready);
    element.addEventListener('error', failed);
    element.addEventListener('timeupdate', time);
    element.addEventListener('playing', play);
    element.addEventListener('pause', pause);
    element.addEventListener('ended', pause);
    void element.play().catch(() => setPlaying(false));
    return () => {
      element.removeEventListener('loadedmetadata', ready);
      element.removeEventListener('error', failed);
      element.removeEventListener('timeupdate', time);
      element.removeEventListener('playing', play);
      element.removeEventListener('pause', pause);
      element.removeEventListener('ended', pause);
      hls?.destroy();
      element.removeAttribute('src');
      element.load();
    };
  }, [source.uri, source.hls]);

  return {
    playing,
    status,
    currentTime: () => video.current?.currentTime ?? 0,
    play: () => void video.current?.play().catch(() => {}),
    pause: () => video.current?.pause(),
    seek: (seconds) => {
      if (video.current) video.current.currentTime = seconds;
    },
    surface: (
      <video
        ref={video}
        title={source.title}
        playsInline
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          backgroundColor: '#000',
          objectFit: 'contain',
        }}
      />
    ),
  };
}
