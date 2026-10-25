import type { ReactElement } from 'react';

/**
 * The video player adapter. Android (and later Apple) uses expo-video, which
 * drives ExoPlayer and AVPlayer; the web uses a video element with hls.js
 * for transcoded streams where the browser has no native HLS.
 */
export type EngineSource = {
  uri: string;
  /** The server is transcoding to HLS rather than sending the file as-is. */
  hls: boolean;
  title: string;
};

export type EngineStatus = 'loading' | 'ready' | 'error';

export type Engine = {
  playing: boolean;
  status: EngineStatus;
  currentTime(): number;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** The view that shows the picture, filling its parent. */
  surface: ReactElement;
};

export type UseEngine = (
  source: EngineSource,
  onTime: (seconds: number) => void,
) => Engine;
